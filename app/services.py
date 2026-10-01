"""业务规则:上传预检、校样批注与锁定、设备队列与估时、重印计费、减量退款、取件核验。"""
import json
import re
from datetime import datetime, timedelta

from . import db
from .printer import get_adapter


class BizError(Exception):
    def __init__(self, msg, status=409):
        super().__init__(msg)
        self.status = status


# ---------------------------------------------------------------- 常量

PAPER_SIZES = {  # 幅面(宽, 高) mm,横式
    "A0": (1189, 841), "A1": (841, 594), "A2": (594, 420),
    "A3": (420, 297), "A4": (297, 210),
}
PAPER_RANK = {"A0": 0, "A1": 1, "A2": 2, "A3": 3, "A4": 4}  # 越小幅面越大

PAGE_PRICE = {  # 每页单价(元)
    "A0": {"bw": 12.0, "color": 36.0},
    "A1": {"bw": 6.0, "color": 18.0},
    "A2": {"bw": 3.0, "color": 9.0},
    "A3": {"bw": 1.5, "color": 4.5},
    "A4": {"bw": 0.8, "color": 2.4},
}
DUPLEX_FACTOR = 1.8          # 双面按单面 1.8 倍计
BINDING_PRICE = {"none": 0.0, "staple": 2.0, "glue": 8.0, "hardcover": 25.0}
BINDING_LABEL = {"none": "不装订", "staple": "骑马钉", "glue": "胶装", "hardcover": "精装"}
RUSH_FACTOR = 0.3            # 急单加收打印费的 30%

SHOP_FONTS = {"SimSun", "SimHei", "Arial", "Times New Roman", "HZTXT", "GBCBIG"}

# 重印原因 -> (费用承担方式, 客户承担比例, 说明)
REPRINT_RULES = {
    "font_missing":    ("shop_absorb", 0.0, "字体缺失:门店预检未检出,店方承担,免费重印"),
    "layer_unprinted": ("shop_absorb", 0.0, "图层未打印:店方输出设置问题,店方承担,免费重印"),
    "paper_jam":       ("shop_absorb", 0.0, "机器卡纸:设备原因,店方承担,免费重印"),
    "scale_mismatch":  ("customer_partial", 0.5,
                        "尺寸比例不符:校样已标注比例警告并经客户确认,客户承担 50% 重印费"),
}
REPRINT_REASON_LABEL = {
    "font_missing": "字体缺失",
    "layer_unprinted": "图层未打印",
    "paper_jam": "机器卡纸",
    "scale_mismatch": "尺寸比例不符",
}

ORDER_STATUS_LABEL = {
    "pending_file": "待传文件", "proof_ready": "待确认校样", "queued": "排队中",
    "printing": "打印中", "ready": "待取件", "delivered": "已交付",
}


def now_iso(now=None):
    return (now or datetime.now()).isoformat(timespec="seconds")


def money(x):
    return round(float(x) + 1e-9, 2)


# ---------------------------------------------------------------- 订单

def create_order(conn, data, now=None):
    now = now or datetime.now()
    paper = data["paper_size"]
    if paper not in PAPER_SIZES:
        raise BizError(f"未知纸张规格 {paper}", 400)
    if data["color_mode"] not in ("bw", "color"):
        raise BizError("色彩模式须为 bw 或 color", 400)
    if data["binding"] not in BINDING_PRICE:
        raise BizError("未知装订方式", 400)
    copies = int(data["copies"])
    if copies < 1:
        raise BizError("份数至少为 1", 400)
    with db.tx(conn):
        cur = conn.execute(
            "INSERT INTO orders(code, customer, paper_size, color_mode, duplex, binding,"
            " copies, urgent, status, created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
            ("-", data["customer"].strip() or "未留名客户", paper, data["color_mode"],
             1 if data.get("duplex") else 0, data["binding"], copies,
             1 if data.get("urgent") else 0, "pending_file", now_iso(now)))
        oid = cur.lastrowid
        code = f"P{now:%Y%m%d}-{oid:03d}"
        conn.execute("UPDATE orders SET code=? WHERE id=?", (code, oid))
    return get_order(conn, oid)


def get_order(conn, oid):
    o = db.one(conn, "SELECT * FROM orders WHERE id=?", (oid,))
    if not o:
        raise BizError("订单不存在", 404)
    return o


# ---------------------------------------------------------------- 上传预检

def _parse_len(s):
    m = re.match(r"^\s*([\d.]+)\s*(mm|cm|in|px)?\s*$", s or "")
    if not m:
        return None
    v = float(m.group(1))
    unit = m.group(2) or "mm"
    return v * {"mm": 1, "cm": 10, "in": 25.4, "px": 25.4 / 96}[unit]


def _nearest_paper(w, h):
    """能容纳图幅的最小标准幅面(PAPER_SIZES 按从大到小排列,取最后一个命中的)。"""
    best = "超出A0"
    for size, (pw, ph) in PAPER_SIZES.items():
        if (w <= pw + 0.5 and h <= ph + 0.5) or (w <= ph + 0.5 and h <= pw + 0.5):
            best = size
    return best


def precheck_svg(svg_text, paper_size):
    """解析图纸 SVG,返回预检结果(图幅、页数、字体、图层、比例)。"""
    import xml.etree.ElementTree as ET
    try:
        root = ET.fromstring(svg_text)
    except ET.ParseError as e:
        raise BizError(f"文件解析失败:{e}", 400)

    w = _parse_len(root.get("width"))
    h = _parse_len(root.get("height"))
    if not w or not h:
        vb = root.get("viewBox")
        if vb:
            parts = [float(x) for x in re.split(r"[,\s]+", vb.strip())]
            w, h = parts[2], parts[3]
    if not w or not h:
        raise BizError("无法读取图幅尺寸(width/height 或 viewBox)", 400)

    meta = {}
    for el in root.iter():
        if el.tag.endswith("metadata") and el.get("id") == "drawing-meta":
            try:
                meta = json.loads(el.text or "{}")
            except json.JSONDecodeError:
                meta = {}
    pages = int(meta.get("pages", 1))
    fonts = meta.get("fonts", [])
    layers = meta.get("layers", [])

    pw, ph = PAPER_SIZES[paper_size]
    fit_normal = min(pw / w, ph / h)
    fit_rotated = min(pw / h, ph / w)
    rotated = fit_rotated > fit_normal
    fit = max(fit_normal, fit_rotated)

    issues = []
    if fit < 0.999:
        msg = (f"图幅 {w:.0f}×{h:.0f}mm 超出所选 {paper_size}({pw}×{ph}mm),"
               f"需缩放至 {fit*100:.1f}% 才能打印")
        if rotated:
            msg += "(已按旋转后最佳方向计算)"
        issues.append({"level": "error", "code": "scale_mismatch", "message": msg})
    elif fit > 1.001:
        issues.append({
            "level": "info", "code": "smaller_than_paper",
            "message": f"图幅 {w:.0f}×{h:.0f}mm 小于 {paper_size},将按实际尺寸居中打印",
        })

    missing_fonts = [f for f in fonts if f not in SHOP_FONTS]
    if missing_fonts:
        issues.append({
            "level": "warning", "code": "font_missing",
            "message": "缺失字体:" + "、".join(missing_fonts) + ",打印可能替换字形",
        })
    unprinted = [l["name"] for l in layers if not l.get("print", True)]
    if unprinted:
        issues.append({
            "level": "warning", "code": "layer_unprinted",
            "message": "以下图层设为不打印:" + "、".join(unprinted),
        })

    status = ("error" if any(i["level"] == "error" for i in issues)
              else "warning" if any(i["level"] == "warning" for i in issues) else "ok")
    return {
        "drawing": {"width_mm": w, "height_mm": h, "nearest": _nearest_paper(w, h)},
        "paper": {"size": paper_size, "width_mm": pw, "height_mm": ph},
        "page_count": pages,
        "fit_ratio": round(fit, 4),
        "scale_percent": round(fit * 100, 1),
        "rotated": rotated,
        "fonts": fonts, "layers": layers,
        "issues": issues,
        "status": status,
    }


def attach_file(conn, order_id, filename, svg_text, store_dir, now=None):
    """上传/补传文件:生成新版本 + 预检 + 新校样。已确认校样保留不覆盖。"""
    now = now or datetime.now()
    order = get_order(conn, order_id)
    if order["status"] not in ("pending_file", "proof_ready", "queued"):
        raise BizError(f"订单当前状态({ORDER_STATUS_LABEL[order['status']]})不能再补传文件")
    pre = precheck_svg(svg_text, order["paper_size"])
    with db.tx(conn):
        ver_no = (db.one(conn, "SELECT MAX(version) v FROM file_versions WHERE order_id=?",
                         (order_id,))["v"] or 0) + 1
        import os
        os.makedirs(store_dir, exist_ok=True)
        path = os.path.join(store_dir, f"order{order_id}-v{ver_no}.svg")
        with open(path, "w", encoding="utf-8") as f:
            f.write(svg_text)
        cur = conn.execute(
            "INSERT INTO file_versions(order_id, version, filename, path, page_count,"
            " width_mm, height_mm, precheck_status, precheck_json, created_at)"
            " VALUES(?,?,?,?,?,?,?,?,?,?)",
            (order_id, ver_no, filename, path, pre["page_count"],
             pre["drawing"]["width_mm"], pre["drawing"]["height_mm"],
             pre["status"], json.dumps(pre, ensure_ascii=False), now_iso(now)))
        vid = cur.lastrowid
        conn.execute(
            "INSERT INTO proofs(order_id, version_id, status, locked, created_at)"
            " VALUES(?,?, 'open', 0, ?)", (order_id, vid, now_iso(now)))
        conn.execute("UPDATE orders SET status='proof_ready' WHERE id=?", (order_id,))
    return db.one(conn, "SELECT * FROM file_versions WHERE id=?", (vid,))


# ---------------------------------------------------------------- 校样

def add_annotation(conn, proof_id, author, x_mm, y_mm, text, now=None):
    now = now or datetime.now()
    proof = db.one(conn, "SELECT * FROM proofs WHERE id=?", (proof_id,))
    if not proof:
        raise BizError("校样不存在", 404)
    if proof["locked"]:
        raise BizError("校样已确认锁定,不能再添加批注")
    with db.tx(conn):
        cur = conn.execute(
            "INSERT INTO annotations(proof_id, author, x_mm, y_mm, text, created_at)"
            " VALUES(?,?,?,?,?,?)",
            (proof_id, author, float(x_mm), float(y_mm), text.strip(), now_iso(now)))
    return db.one(conn, "SELECT * FROM annotations WHERE id=?", (cur.lastrowid,))


def _print_base(conn, order, version):
    unit = PAGE_PRICE[order["paper_size"]][order["color_mode"]]
    pages = version["page_count"]
    factor = DUPLEX_FACTOR if order["duplex"] else 1.0
    return money(pages * order["copies"] * unit * factor), unit, pages, factor


def _insert_charge(conn, order_id, type_, label, qty, unit, amount, now):
    """费用入口:已交付订单不能再次收费。"""
    st = db.one(conn, "SELECT status FROM orders WHERE id=?", (order_id,))["status"]
    if st == "delivered":
        raise BizError("订单已交付,不能再次收费")
    cur = conn.execute(
        "INSERT INTO charges(order_id, type, label, qty, unit_price, amount, created_at)"
        " VALUES(?,?,?,?,?,?,?)",
        (order_id, type_, label, qty, unit, money(amount), now_iso(now)))
    return cur.lastrowid


def confirm_proof(conn, proof_id, now=None):
    """客户确认校样:锁定、旧版本转 superseded(记录保留)、计费、进入打印队列。"""
    now = now or datetime.now()
    with db.tx(conn):
        proof = db.one(conn, "SELECT * FROM proofs WHERE id=?", (proof_id,))
        if not proof:
            raise BizError("校样不存在", 404)
        if proof["locked"]:
            raise BizError("校样已确认锁定,不能重复确认")
        order = get_order(conn, proof["order_id"])
        busy = db.one(conn, "SELECT COUNT(*) c FROM print_tasks WHERE order_id=? AND status='printing'",
                      (order["id"],))["c"]
        if busy:
            raise BizError("已有任务开机打印,不能切换版本")
        version = db.one(conn, "SELECT * FROM file_versions WHERE id=?", (proof["version_id"],))

        conn.execute("UPDATE proofs SET status='confirmed', locked=1, confirmed_at=? WHERE id=?",
                     (now_iso(now), proof_id))
        conn.execute("UPDATE proofs SET status='superseded' WHERE order_id=? AND status='confirmed' AND id<>?",
                     (order["id"], proof_id))
        conn.execute("UPDATE orders SET confirmed_version_id=?, status='queued' WHERE id=?",
                     (version["id"], order["id"]))
        conn.execute("UPDATE print_tasks SET status='cancelled' WHERE order_id=? AND status='queued'",
                     (order["id"],))

        # ---- 计费:首次确认建账;换版确认只调打印费差额
        amount, unit, pages, factor = _print_base(conn, order, version)
        desc = f"{order['paper_size']} {'彩色' if order['color_mode']=='color' else '黑白'}" \
               f"{'双面' if order['duplex'] else '单面'} {pages}页×{order['copies']}份"
        has_print_charge = db.one(
            conn, "SELECT COUNT(*) c FROM charges WHERE order_id=? AND type IN ('print','adjustment')",
            (order["id"],))["c"] > 0
        if not has_print_charge:
            _insert_charge(conn, order["id"], "print", f"打印费 {desc}", pages * order["copies"], unit, amount, now)
            bind_unit = BINDING_PRICE[order["binding"]]
            if bind_unit > 0:
                _insert_charge(conn, order["id"], "binding",
                               f"装订费 {BINDING_LABEL[order['binding']]}×{order['copies']}份",
                               order["copies"], bind_unit, bind_unit * order["copies"], now)
            if order["urgent"]:
                _insert_charge(conn, order["id"], "rush", "急单加收(打印费30%)",
                               None, None, amount * RUSH_FACTOR, now)
        else:
            prev = db.one(conn, "SELECT COALESCE(SUM(amount),0) s FROM charges"
                          " WHERE order_id=? AND type IN ('print','adjustment')", (order["id"],))["s"]
            delta = money(amount - prev)
            if delta != 0:
                _insert_charge(conn, order["id"], "adjustment", f"换版差价 {desc}",
                               None, None, delta, now)
                if order["urgent"]:
                    _insert_charge(conn, order["id"], "adjustment", "急单加收差额",
                                   None, None, delta * RUSH_FACTOR, now)

        task_id = _enqueue_task(conn, order, version, now)
    return db.one(conn, "SELECT * FROM print_tasks WHERE id=?", (task_id,))


# ---------------------------------------------------------------- 设备队列

def _task_duration(conn, task):
    o = db.one(conn, "SELECT * FROM orders WHERE id=?", (task["order_id"],))
    v = db.one(conn, "SELECT * FROM file_versions WHERE id=?", (task["version_id"],))
    d = db.one(conn, "SELECT * FROM devices WHERE id=?", (task["device_id"],))
    return v["page_count"] * o["copies"] * d["sec_per_page"]


def _queue_load(conn, device_id):
    load = 0.0
    for t in db.all_(conn, "SELECT * FROM print_tasks WHERE device_id=? AND status IN ('queued','printing')",
                     (device_id,)):
        load += _task_duration(conn, t)
    return load


def _pick_device(conn, order):
    devices = db.all_(conn, "SELECT * FROM devices ORDER BY id")
    ok = [d for d in devices
          if PAPER_RANK[d["max_paper"]] <= PAPER_RANK[order["paper_size"]]
          and (order["color_mode"] == "bw" or d["color"])]
    if not ok:
        raise BizError("没有可用设备满足该订单的幅面/色彩要求")
    return min(ok, key=lambda d: (_queue_load(conn, d["id"]), d["id"]))


def _enqueue_task(conn, order, version, now, kind="print"):
    device = _pick_device(conn, order)
    if order["urgent"]:
        conn.execute("UPDATE print_tasks SET position=position+1 WHERE device_id=? AND status='queued'",
                     (device["id"],))
        pos = 1
    else:
        pos = (db.one(conn, "SELECT MAX(position) p FROM print_tasks WHERE device_id=? AND status='queued'",
                      (device["id"],))["p"] or 0) + 1
    cur = conn.execute(
        "INSERT INTO print_tasks(order_id, device_id, version_id, kind, status, position, created_at)"
        " VALUES(?,?,?,?, 'queued', ?, ?)",
        (order["id"], device["id"], version["id"], kind, pos, now_iso(now)))
    recompute_estimates(conn, device["id"], now)
    return cur.lastrowid


def recompute_estimates(conn, device_id, now=None):
    """按队列顺序重算预计开始/完成时间;急单插队后队列整体顺延。"""
    now = now or datetime.now()
    base = now
    printing = db.one(conn, "SELECT * FROM print_tasks WHERE device_id=? AND status='printing'",
                      (device_id,))
    if printing and printing["est_finish"]:
        base = datetime.fromisoformat(printing["est_finish"])
    for t in db.all_(conn, "SELECT * FROM print_tasks WHERE device_id=? AND status='queued'"
                     " ORDER BY position", (device_id,)):
        dur = timedelta(seconds=_task_duration(conn, t))
        est_start, est_finish = base, base + dur
        conn.execute("UPDATE print_tasks SET est_start=?, est_finish=? WHERE id=?",
                     (est_start.isoformat(timespec="seconds"),
                      est_finish.isoformat(timespec="seconds"), t["id"]))
        base = est_finish


def claim_task(conn, task_id, operator, now=None):
    """操作员开机:同一任务/同一设备只能一人成功(原子抢占)。"""
    now = now or datetime.now()
    operator = (operator or "").strip() or "未署名"
    with db.tx(conn):
        task = db.one(conn, "SELECT * FROM print_tasks WHERE id=?", (task_id,))
        if not task:
            raise BizError("任务不存在", 404)
        if task["status"] != "queued":
            raise BizError("任务已被其他操作员处理")
        cur = conn.execute("UPDATE devices SET status='printing' WHERE id=? AND status='idle'",
                           (task["device_id"],))
        if cur.rowcount == 0:
            raise BizError("设备正忙,同一设备一次只能开机一个任务")
        cur = conn.execute(
            "UPDATE print_tasks SET status='printing', operator=?, started_at=?"
            " WHERE id=? AND status='queued'", (operator, now_iso(now), task_id))
        if cur.rowcount == 0:
            raise BizError("任务已被其他操作员开机")
        order = get_order(conn, task["order_id"])
        version = db.one(conn, "SELECT * FROM file_versions WHERE id=?", (task["version_id"],))
        device = db.one(conn, "SELECT * FROM devices WHERE id=?", (task["device_id"],))
        job = get_adapter(device).start_job(task, order, version)
        conn.execute("UPDATE orders SET status='printing' WHERE id=?", (order["id"],))
        recompute_estimates(conn, task["device_id"], now)
    return db.one(conn, "SELECT * FROM print_tasks WHERE id=?", (task_id,)), job


def complete_task(conn, task_id, now=None):
    now = now or datetime.now()
    with db.tx(conn):
        task = db.one(conn, "SELECT * FROM print_tasks WHERE id=?", (task_id,))
        if not task:
            raise BizError("任务不存在", 404)
        if task["status"] != "printing":
            raise BizError("任务不在打印中")
        device = db.one(conn, "SELECT * FROM devices WHERE id=?", (task["device_id"],))
        get_adapter(device).finish_job(task)
        conn.execute("UPDATE print_tasks SET status='done', finished_at=? WHERE id=?",
                     (now_iso(now), task_id))
        conn.execute("UPDATE devices SET status='idle' WHERE id=?", (task["device_id"],))
        left = db.one(conn, "SELECT COUNT(*) c FROM print_tasks WHERE order_id=?"
                      " AND status IN ('queued','printing')", (task["order_id"],))["c"]
        if left == 0:
            conn.execute("UPDATE orders SET status='ready' WHERE id=?", (task["order_id"],))
        recompute_estimates(conn, task["device_id"], now)
    return db.one(conn, "SELECT * FROM print_tasks WHERE id=?", (task_id,))


def jam_task(conn, task_id, now=None):
    now = now or datetime.now()
    with db.tx(conn):
        task = db.one(conn, "SELECT * FROM print_tasks WHERE id=?", (task_id,))
        if not task:
            raise BizError("任务不存在", 404)
        if task["status"] != "printing":
            raise BizError("任务不在打印中")
        device = db.one(conn, "SELECT * FROM devices WHERE id=?", (task["device_id"],))
        info = get_adapter(device).jam_job(task)
        conn.execute("UPDATE print_tasks SET status='jammed', finished_at=? WHERE id=?",
                     (now_iso(now), task_id))
        conn.execute("UPDATE devices SET status='idle' WHERE id=?", (task["device_id"],))
        recompute_estimates(conn, task["device_id"], now)
    return db.one(conn, "SELECT * FROM print_tasks WHERE id=?", (task_id,)), info


# ---------------------------------------------------------------- 重印与费用调整

def reprint(conn, order_id, reason, note, operator, now=None):
    """按原因生成重印记录与费用处理,并把重印任务排入队列。"""
    now = now or datetime.now()
    if reason not in REPRINT_RULES:
        raise BizError("未知重印原因", 400)
    with db.tx(conn):
        order = get_order(conn, order_id)
        if order["status"] not in ("printing", "ready"):
            raise BizError(f"订单当前状态({ORDER_STATUS_LABEL[order['status']]})不能发起重印")
        version = db.one(conn, "SELECT * FROM file_versions WHERE id=?",
                         (order["confirmed_version_id"],))
        handling, ratio, rule_text = REPRINT_RULES[reason]
        base, unit, pages, _f = _print_base(conn, order, version)
        amount = money(base * ratio)
        cur = conn.execute(
            "INSERT INTO reprints(order_id, reason, fee_handling, amount, note, operator, created_at)"
            " VALUES(?,?,?,?,?,?,?)",
            (order_id, reason, handling, amount, (note or "").strip(),
             (operator or "").strip() or "未署名", now_iso(now)))
        rid = cur.lastrowid
        label = f"重印({REPRINT_REASON_LABEL[reason]}):{rule_text}"
        if amount > 0:
            _insert_charge(conn, order_id, "reprint", label, None, None, amount, now)
        else:
            _insert_charge(conn, order_id, "reprint_free", label + ",应收 0 元", None, None, 0, now)
        _enqueue_task(conn, order, version, now, kind="reprint")
        conn.execute("UPDATE orders SET status='queued' WHERE id=?", (order_id,))
    return db.one(conn, "SELECT * FROM reprints WHERE id=?", (rid,))


def reduce_copies(conn, order_id, new_copies, now=None):
    """客户临时减量:未开机前可减,按差额退款(打印/装订/急单同比例)。"""
    now = now or datetime.now()
    new_copies = int(new_copies)
    with db.tx(conn):
        order = get_order(conn, order_id)
        if order["status"] == "delivered":
            raise BizError("订单已交付,不能再调整份数")
        if new_copies < 1 or new_copies >= order["copies"]:
            raise BizError(f"新份数须为 1~{order['copies']-1}")
        started = db.one(conn, "SELECT COUNT(*) c FROM print_tasks WHERE order_id=?"
                         " AND status IN ('printing','done')", (order_id,))["c"]
        if started:
            raise BizError("已开机打印,无法减量")
        version = db.one(conn, "SELECT * FROM file_versions WHERE id=?",
                         (order["confirmed_version_id"],))
        if not version:
            raise BizError("订单尚未确认校样")
        old = order["copies"]
        unit = PAGE_PRICE[order["paper_size"]][order["color_mode"]]
        factor = DUPLEX_FACTOR if order["duplex"] else 1.0
        pages = version["page_count"]
        print_refund = money(pages * (old - new_copies) * unit * factor)
        _insert_charge(conn, order_id, "reduction",
                       f"客户临时减量 {old}→{new_copies} 份,退打印费", None, None, -print_refund, now)
        bind_unit = BINDING_PRICE[order["binding"]]
        if bind_unit > 0:
            _insert_charge(conn, order_id, "reduction", "减量退装订费",
                           None, None, -money(bind_unit * (old - new_copies)), now)
        if order["urgent"]:
            _insert_charge(conn, order_id, "reduction", "减量退急单加收",
                           None, None, -money(print_refund * RUSH_FACTOR), now)
        conn.execute("UPDATE orders SET copies=? WHERE id=?", (new_copies, order_id))
        for t in db.all_(conn, "SELECT DISTINCT device_id FROM print_tasks WHERE order_id=? AND status='queued'",
                         (order_id,)):
            recompute_estimates(conn, t["device_id"], now)
    return get_order(conn, order_id)


# ---------------------------------------------------------------- 取件核验

def pickup(conn, order_id, operator, customer, now=None):
    """取件核验:一单只能交付一次;交付后订单锁定,不能再次收费。"""
    now = now or datetime.now()
    with db.tx(conn):
        order = get_order(conn, order_id)
        if order["status"] == "delivered":
            raise BizError("该订单已取件交付,不能重复取件")
        if order["status"] != "ready":
            raise BizError(f"订单当前状态({ORDER_STATUS_LABEL[order['status']]}),不能取件")
        try:
            conn.execute("INSERT INTO pickups(order_id, operator, customer, created_at)"
                         " VALUES(?,?,?,?)",
                         (order_id, (operator or "").strip() or "未署名",
                          (customer or "").strip() or order["customer"], now_iso(now)))
        except Exception as e:
            if "UNIQUE" in str(e):
                raise BizError("该订单已取件交付,不能重复取件")
            raise
        cur = conn.execute("UPDATE orders SET status='delivered' WHERE id=? AND status='ready'",
                           (order_id,))
        if cur.rowcount == 0:
            raise BizError("该订单已取件交付,不能重复取件")
    return db.one(conn, "SELECT * FROM pickups WHERE order_id=?", (order_id,))


# ---------------------------------------------------------------- 查询

def order_total(conn, order_id):
    return money(db.one(conn, "SELECT COALESCE(SUM(amount),0) s FROM charges WHERE order_id=?",
                        (order_id,))["s"])


def list_orders(conn):
    rows = db.all_(conn, "SELECT * FROM orders ORDER BY id DESC")
    out = []
    for o in rows:
        d = dict(o)
        d["total"] = order_total(conn, o["id"])
        d["status_label"] = ORDER_STATUS_LABEL[o["status"]]
        out.append(d)
    return out


def order_detail(conn, order_id):
    o = dict(get_order(conn, order_id))
    o["status_label"] = ORDER_STATUS_LABEL[o["status"]]
    o["total"] = order_total(conn, order_id)
    versions = []
    for v in db.all_(conn, "SELECT * FROM file_versions WHERE order_id=? ORDER BY version", (order_id,)):
        d = dict(v)
        d["precheck"] = json.loads(v["precheck_json"])
        d.pop("precheck_json", None)
        versions.append(d)
    o["versions"] = versions
    proofs = []
    for p in db.all_(conn, "SELECT p.*, v.version FROM proofs p"
                     " JOIN file_versions v ON v.id=p.version_id"
                     " WHERE p.order_id=? ORDER BY p.id", (order_id,)):
        d = dict(p)
        d["annotations"] = [dict(a) for a in db.all_(
            conn, "SELECT * FROM annotations WHERE proof_id=? ORDER BY id", (p["id"],))]
        proofs.append(d)
    o["proofs"] = proofs
    o["charges"] = [dict(c) for c in db.all_(
        conn, "SELECT * FROM charges WHERE order_id=? ORDER BY id", (order_id,))]
    o["reprints"] = [dict(r) for r in db.all_(
        conn, "SELECT * FROM reprints WHERE order_id=? ORDER BY id", (order_id,))]
    o["tasks"] = [dict(t) for t in db.all_(
        conn, "SELECT t.*, d.name device_name FROM print_tasks t JOIN devices d ON d.id=t.device_id"
        " WHERE t.order_id=? ORDER BY t.id", (order_id,))]
    pk = db.one(conn, "SELECT * FROM pickups WHERE order_id=?", (order_id,))
    o["pickup"] = dict(pk) if pk else None
    return o


def devices_view(conn, now=None):
    now = now or datetime.now()
    out = []
    for d in db.all_(conn, "SELECT * FROM devices ORDER BY id"):
        item = dict(d)
        cur = db.one(conn, "SELECT t.*, o.code, o.customer, o.copies, o.urgent, v.page_count"
                     " FROM print_tasks t JOIN orders o ON o.id=t.order_id"
                     " JOIN file_versions v ON v.id=t.version_id"
                     " WHERE t.device_id=? AND t.status='printing'", (d["id"],))
        item["current"] = dict(cur) if cur else None
        item["queue"] = [dict(r) for r in db.all_(
            conn, "SELECT t.*, o.code, o.customer, o.copies, o.urgent, v.page_count"
            " FROM print_tasks t JOIN orders o ON o.id=t.order_id"
            " JOIN file_versions v ON v.id=t.version_id"
            " WHERE t.device_id=? AND t.status='queued' ORDER BY t.position", (d["id"],))]
        item["recent"] = [dict(r) for r in db.all_(
            conn, "SELECT t.*, o.code, o.customer FROM print_tasks t JOIN orders o ON o.id=t.order_id"
            " WHERE t.device_id=? AND t.status IN ('done','jammed') ORDER BY t.id DESC LIMIT 5",
            (d["id"],))]
        out.append(item)
    return out
