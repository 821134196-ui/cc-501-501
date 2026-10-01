'use strict';
// 领域服务：订单、上传预检、校样（锁定/批注）、设备队列（急单插队）、重印、计费、取件核验
const fs = require('node:fs');
const path = require('node:path');
const { inspectDrawing } = require('./precheck');
const pricing = require('./pricing');

const OPERATORS = ['张伟', '李娜'];
const PRINT_SEC_PER_PAGE = { plotter: 20, laser: 4 };
// 大图设备可打 A0-A2，小图设备打 A2-A4
const DEVICE_KIND_FOR = { A0: 'plotter', A1: 'plotter', A2: 'any', A3: 'laser', A4: 'laser' };

function fail(msg, status = 400) {
  const e = new Error(msg);
  e.status = status;
  throw e;
}
const nowIso = () => new Date().toISOString();

function createService({ db, printer, dataDir }) {
  const uploadsDir = path.join(dataDir, 'uploads');
  fs.mkdirSync(uploadsDir, { recursive: true });

  // ---------- 基础读取 ----------
  const getOrder = (id) => db.prepare('SELECT * FROM orders WHERE id=?').get(id) || fail('订单不存在', 404);
  const getProof = (id) => db.prepare('SELECT * FROM proofs WHERE id=?').get(id) || fail('校样不存在', 404);
  const getTask = (id) => db.prepare('SELECT * FROM print_tasks WHERE id=?').get(id) || fail('任务不存在', 404);
  const getDevice = (id) => db.prepare('SELECT * FROM devices WHERE id=?').get(id) || fail('设备不存在', 404);
  const getVersion = (id) => db.prepare('SELECT * FROM file_versions WHERE id=?').get(id) || fail('文件版本不存在', 404);
  const latestVersion = (orderId) =>
    db.prepare('SELECT * FROM file_versions WHERE order_id=? ORDER BY version_no DESC LIMIT 1').get(orderId);

  // ---------- 设备 ----------
  function addDevice(name, kind) {
    db.prepare('INSERT OR IGNORE INTO devices(name, kind, status) VALUES (?,?,?)').run(name, kind, 'idle');
    return db.prepare('SELECT * FROM devices WHERE name=?').get(name);
  }

  // ---------- 下单 ----------
  function createOrder({ customer, paper_size, color, sides, binding, copies }) {
    if (!customer) fail('缺少客户名称');
    if (!pricing.PAGE_RATE[paper_size]) fail(`不支持的纸张规格: ${paper_size}`);
    if (!pricing.COLOR_MULT[color]) fail('色彩须为 bw 或 color');
    if (!pricing.SIDE_MULT[sides]) fail('单双面须为 single 或 double');
    if (!(binding in pricing.BINDING_FEE)) fail('装订方式无效');
    copies = Number(copies);
    if (!Number.isInteger(copies) || copies < 1) fail('份数须为正整数');

    const seq = db.prepare('SELECT COUNT(*) AS n FROM orders').get().n + 1;
    const d = new Date();
    const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
    const orderNo = `D${ymd}-${String(seq).padStart(4, '0')}`;
    const r = db.prepare(
      `INSERT INTO orders(order_no, customer, paper_size, color, sides, binding, copies, rush, status, pickup_code, created_at)
       VALUES (?,?,?,?,?,?,?,0,'received',?,?)`
    ).run(orderNo, customer, paper_size, color, sides, binding, copies, '', nowIso());
    const id = Number(r.lastInsertRowid);
    // 取件核验码：由订单号确定，打印在取件单上
    db.prepare('UPDATE orders SET pickup_code=? WHERE id=?').run(String(100000 + (id * 7919) % 900000), id);
    return getOrder(id);
  }

  // ---------- 上传预检（补传不覆盖已确认校样） ----------
  function uploadVersion(orderId, { filename, content }) {
    const o = getOrder(orderId);
    if (o.status === 'delivered') fail('订单已交付，不能补传文件', 409);
    let drawing;
    try {
      drawing = typeof content === 'string' ? JSON.parse(content) : content;
    } catch {
      fail('图纸文件不是有效 JSON', 422);
    }
    const report = inspectDrawing(drawing, o.paper_size); // 预检：图幅/页数/字体/图层/比例

    const nextNo = (db.prepare('SELECT COALESCE(MAX(version_no),0) AS m FROM file_versions WHERE order_id=?').get(orderId).m) + 1;
    const dir = path.join(uploadsDir, `order_${orderId}`);
    fs.mkdirSync(dir, { recursive: true });
    const safeName = path.basename(filename || `drawing-v${nextNo}.json`);
    const filePath = path.join(dir, `v${nextNo}_${safeName}`);
    fs.writeFileSync(filePath, JSON.stringify(drawing, null, 2));

    const r = db.prepare(
      `INSERT INTO file_versions(order_id, version_no, filename, path, page_count, sheet_w, sheet_h, sheet_size, issues, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`
    ).run(orderId, nextNo, safeName, filePath, report.page_count, report.sheet_w, report.sheet_h,
      report.sheet_size, JSON.stringify(report), nowIso());
    // 注意：不触碰 proofs 表——已确认校样保持锁定，新版本需重新出校样
    if (o.status === 'received') db.prepare("UPDATE orders SET status='prechecked' WHERE id=?").run(orderId);
    return { version: getVersion(Number(r.lastInsertRowid)), report };
  }

  // ---------- 校样 ----------
  function generateProof(orderId) {
    const o = getOrder(orderId);
    const v = latestVersion(orderId);
    if (!v) fail('请先上传图纸文件');
    db.prepare("UPDATE proofs SET status='superseded' WHERE order_id=? AND status='pending'").run(orderId);
    const r = db.prepare(
      "INSERT INTO proofs(order_id, version_id, status, annotations, locked, created_at) VALUES (?,?, 'pending', '[]', 0, ?)"
    ).run(orderId, v.id, nowIso());
    db.prepare("UPDATE orders SET status='proof_ready' WHERE id=?").run(orderId);
    return getProof(Number(r.lastInsertRowid));
  }

  function addAnnotation(proofId, { x, y, text, author }) {
    const p = getProof(proofId);
    if (p.locked) fail('校样已确认锁定，不能再批注', 409);
    if (!text) fail('批注内容为空');
    const anns = JSON.parse(p.annotations);
    anns.push({ x: Number(x) || 0, y: Number(y) || 0, text: String(text), author: author || '客户', at: nowIso() });
    db.prepare('UPDATE proofs SET annotations=? WHERE id=?').run(JSON.stringify(anns), proofId);
    return getProof(proofId);
  }

  function confirmProof(proofId) {
    const p = getProof(proofId);
    if (p.status !== 'pending') fail('校样已锁定，不能重复确认', 409);
    const o = getOrder(p.order_id);
    // 旧的已确认版本转为“被替代”，但记录保留、绝不覆盖
    db.prepare("UPDATE proofs SET status='superseded' WHERE order_id=? AND status='confirmed'").run(o.id);
    db.prepare("UPDATE proofs SET status='confirmed', locked=1, confirmed_at=? WHERE id=?").run(nowIso(), proofId);
    db.prepare("UPDATE orders SET status='confirmed' WHERE id=?").run(o.id);

    const v = getVersion(p.version_id);
    const amount = pricing.baseAmount(o, v.page_count);
    const label = `打印费 ${v.page_count}页×${o.copies}份 ${o.paper_size}/${o.color === 'bw' ? '黑白' : '彩色'}/${o.sides === 'single' ? '单面' : '双面'}`;
    const existing = db.prepare("SELECT * FROM charges WHERE order_id=? AND kind='base'").get(o.id);
    if (!existing) {
      addCharge(o.id, { kind: 'base', label, amount });
    } else if (Math.abs(existing.amount - amount) > 0.005) {
      addCharge(o.id, { kind: 'adjustment', label: '版本变更差价调整', amount: pricing.round2(amount - existing.amount) });
    }
    enqueueTask(o, v, 'normal');
    return getProof(proofId);
  }

  function rejectProof(proofId, note) {
    const p = getProof(proofId);
    if (p.status !== 'pending') fail('只能驳回待确认的校样', 409);
    db.prepare("UPDATE proofs SET status='rejected' WHERE id=?").run(proofId);
    if (note) addAnnotation(proofId, { x: 0, y: 0, text: `驳回：${note}`, author: '客户' });
    db.prepare("UPDATE proofs SET locked=1 WHERE id=?").run(proofId); // 驳回记录同样留档
    db.prepare("UPDATE orders SET status='prechecked' WHERE id=?").run(p.order_id);
    return getProof(proofId);
  }

  // ---------- 设备队列 ----------
  function deviceLoadMinutes(deviceId) {
    const row = db.prepare(
      "SELECT COALESCE(SUM(est_minutes),0) AS m FROM print_tasks WHERE device_id=? AND status IN ('standby','printing')"
    ).get(deviceId);
    return row.m;
  }

  function pickDevice(order) {
    const want = DEVICE_KIND_FOR[order.paper_size];
    const devices = db.prepare('SELECT * FROM devices').all()
      .filter((d) => want === 'any' || d.kind === want);
    if (devices.length === 0) fail(`没有可打印 ${order.paper_size} 的设备`, 409);
    devices.sort((a, b) => deviceLoadMinutes(a.id) - deviceLoadMinutes(b.id));
    return devices[0];
  }

  function enqueueTask(order, version, kind) {
    const open = db.prepare(
      "SELECT COUNT(*) AS n FROM print_tasks WHERE order_id=? AND status IN ('standby','printing')"
    ).get(order.id).n;
    if (open > 0) return null; // 已有在队任务，不重复排队
    const device = pickDevice(order);
    const copies = order.copies;
    const est = Math.max(1, Math.ceil(version.page_count * copies * PRINT_SEC_PER_PAGE[device.kind] / 60));
    const pos = (db.prepare('SELECT COALESCE(MAX(position),0) AS m FROM print_tasks WHERE device_id=?').get(device.id).m) + 1;
    db.prepare(
      `INSERT INTO print_tasks(order_id, device_id, kind, status, position, est_minutes, created_at)
       VALUES (?,?,?,'standby',?,?,?)`
    ).run(order.id, device.id, kind, pos, est, nowIso());
    db.prepare("UPDATE orders SET status='queued' WHERE id=? AND status IN ('confirmed','queued')").run(order.id);
    recomputeQueue(device.id);
    return db.prepare('SELECT * FROM print_tasks WHERE order_id=? ORDER BY id DESC LIMIT 1').get(order.id);
  }

  // 重算设备队列的预计完成时间（急单插队、开机、完工后都会触发）
  function recomputeQueue(deviceId) {
    let t = Date.now();
    const printing = db.prepare("SELECT * FROM print_tasks WHERE device_id=? AND status='printing'").get(deviceId);
    if (printing) {
      const elapsed = (t - Date.parse(printing.started_at)) / 60000;
      t += Math.max(0, printing.est_minutes - elapsed) * 60000;
      db.prepare('UPDATE orders SET estimated_ready_at=? WHERE id=?').run(new Date(t).toISOString(), printing.order_id);
    }
    const standby = db.prepare(
      "SELECT * FROM print_tasks WHERE device_id=? AND status='standby' ORDER BY position, id"
    ).all(deviceId);
    for (const task of standby) {
      t += task.est_minutes * 60000;
      db.prepare('UPDATE orders SET estimated_ready_at=? WHERE id=?').run(new Date(t).toISOString(), task.order_id);
    }
  }

  // 急单插队：排到队首，并重算整队预计完成时间
  function setRush(orderId) {
    const o = getOrder(orderId);
    if (['printing', 'printed', 'delivered'].includes(o.status)) fail('订单已在打印或已交付，不能插队', 409);
    db.prepare('UPDATE orders SET rush=1 WHERE id=?').run(orderId);
    const task = db.prepare("SELECT * FROM print_tasks WHERE order_id=? AND status='standby'").get(orderId);
    if (task) {
      const minPos = db.prepare(
        "SELECT COALESCE(MIN(position),1) AS m FROM print_tasks WHERE device_id=? AND status='standby'"
      ).get(task.device_id).m;
      db.prepare('UPDATE print_tasks SET position=? WHERE id=?').run(minPos - 1, task.id);
      recomputeQueue(task.device_id);
    }
    return getOrder(orderId);
  }

  // 设备竞争：原子认领——同一任务两名操作员只有一人能开机
  function claimTask(taskId, operator) {
    if (!OPERATORS.includes(operator)) fail(`未知操作员: ${operator}`);
    const task = getTask(taskId);
    const device = getDevice(task.device_id);
    if (device.status === 'jammed') fail('设备卡纸未排除，不能开机', 409);
    const r = db.prepare(
      "UPDATE print_tasks SET status='printing', operator=?, started_at=? WHERE id=? AND status='standby'"
    ).run(operator, nowIso(), taskId);
    if (r.changes === 0) fail('任务已被其他操作员开机', 409);
    db.prepare("UPDATE devices SET status='printing' WHERE id=?").run(task.device_id);
    db.prepare("UPDATE orders SET status='printing' WHERE id=?").run(task.order_id);
    printer.start({ taskId, deviceId: task.device_id, operator });
    recomputeQueue(task.device_id);
    return getTask(taskId);
  }

  function finishTask(taskId, operator) {
    const task = getTask(taskId);
    if (task.status !== 'printing') fail('任务不在打印中', 409);
    if (operator && task.operator !== operator) fail('只有开机操作员能结束该任务', 409);
    db.prepare("UPDATE print_tasks SET status='done', finished_at=? WHERE id=?").run(nowIso(), taskId);
    db.prepare("UPDATE devices SET status='idle' WHERE id=?").run(task.device_id);
    printer.finish({ taskId, deviceId: task.device_id, operator: task.operator });
    const open = db.prepare(
      "SELECT COUNT(*) AS n FROM print_tasks WHERE order_id=? AND status IN ('standby','printing')"
    ).get(task.order_id).n;
    if (open === 0) db.prepare("UPDATE orders SET status='printed' WHERE id=?").run(task.order_id);
    recomputeQueue(task.device_id);
    return getTask(taskId);
  }

  // 卡纸：当前任务回队（记为重印），设备停用待排除
  function jamDevice(deviceId) {
    const device = getDevice(deviceId);
    if (device.status !== 'printing') fail('设备不在打印中', 409);
    printer.jam(deviceId);
    const task = db.prepare("SELECT * FROM print_tasks WHERE device_id=? AND status='printing'").get(deviceId);
    db.prepare("UPDATE devices SET status='jammed' WHERE id=?").run(deviceId);
    if (task) {
      db.prepare(
        "UPDATE print_tasks SET status='standby', kind='reprint', operator=NULL, started_at=NULL WHERE id=?"
      ).run(task.id);
      db.prepare("UPDATE orders SET status='queued' WHERE id=?").run(task.order_id);
      recordReprint(task.order_id, { reason: 'paper_jam', note: `设备「${device.name}」卡纸` });
    }
    return getDevice(deviceId);
  }

  function clearDevice(deviceId) {
    const device = getDevice(deviceId);
    if (device.status !== 'jammed') fail('设备未处于卡纸状态', 409);
    db.prepare("UPDATE devices SET status='idle' WHERE id=?").run(deviceId);
    recomputeQueue(deviceId);
    return getDevice(deviceId);
  }

  // ---------- 计费 ----------
  // 已交付订单不能再次收费
  function addCharge(orderId, { kind, label, amount }) {
    const o = getOrder(orderId);
    if (o.status === 'delivered') fail('订单已交付，不能再次收费', 409);
    const r = db.prepare('INSERT INTO charges(order_id, kind, label, amount, created_at) VALUES (?,?,?,?,?)')
      .run(orderId, kind, label, pricing.round2(amount), nowIso());
    return db.prepare('SELECT * FROM charges WHERE id=?').get(Number(r.lastInsertRowid));
  }

  // 重印登记：字体缺失 / 图层未打印 / 比例不符 / 卡纸，各自费用处理
  function recordReprint(orderId, { reason, pages, copies, note }) {
    const o = getOrder(orderId);
    if (o.status === 'delivered') fail('订单已交付，不能登记重印', 409);
    const v = latestVersion(orderId);
    if (!v) fail('订单没有文件版本', 409);
    pages = Number(pages) || v.page_count;
    copies = Number(copies) || o.copies;
    const amount = pricing.reprintAmount(reason, o, pages, copies);
    const handling = pricing.REPRINT_HANDLING[reason];
    const r = db.prepare(
      'INSERT INTO reprints(order_id, reason, pages, copies, handling, amount, note, created_at) VALUES (?,?,?,?,?,?,?,?)'
    ).run(orderId, reason, pages, copies, handling, amount, note || null, nowIso());
    addCharge(orderId, {
      kind: 'reprint',
      label: `重印 ${pages}页×${copies}份（${handling}）`,
      amount,
    });
    if (reason !== 'paper_jam') enqueueTask(o, v, 'reprint'); // 卡纸任务已在队列里
    return db.prepare('SELECT * FROM reprints WHERE id=?').get(Number(r.lastInsertRowid));
  }

  // 客户临时减量：退 90%，订单份数同步减少
  function reduceCopies(orderId, { copies }) {
    const o = getOrder(orderId);
    if (!['confirmed', 'queued', 'printing'].includes(o.status)) fail('当前状态不能减量', 409);
    const target = Number(copies);
    if (!Number.isInteger(target) || target < 1 || target >= o.copies) fail('减量后的份数须小于当前份数且为正整数');
    const reduced = o.copies - target;
    const v = latestVersion(orderId);
    const refund = pricing.reductionRefund(o, v.page_count, reduced);
    addCharge(orderId, { kind: 'refund', label: `客户临时减量 ${reduced} 份，退 90%`, amount: refund });
    db.prepare('UPDATE orders SET copies=? WHERE id=?').run(target, orderId);
    return getOrder(orderId);
  }

  // ---------- 取件核验 ----------
  function pickup(orderId, { code }) {
    const o = getOrder(orderId);
    if (o.status === 'delivered') fail('该订单已取件，不能重复取件', 409);
    if (o.status !== 'printed') fail('订单未完工，不能取件', 409);
    if (String(code || '') !== o.pickup_code) fail('取件码错误', 403);
    const existing = db.prepare('SELECT * FROM pickups WHERE order_id=?').get(orderId);
    if (existing) fail('该订单已取件，不能重复取件', 409);
    db.prepare('INSERT INTO pickups(order_id, code, picked_at) VALUES (?,?,?)').run(orderId, o.pickup_code, nowIso());
    db.prepare("UPDATE orders SET status='delivered', delivered_at=? WHERE id=?").run(nowIso(), orderId);
    return getOrder(orderId);
  }

  // ---------- 查询 ----------
  function listState() {
    const orders = db.prepare('SELECT * FROM orders ORDER BY id DESC').all().map((o) => ({
      ...o,
      charge_total: pricing.round2(
        db.prepare('SELECT COALESCE(SUM(amount),0) AS s FROM charges WHERE order_id=?').get(o.id).s),
      version_count: db.prepare('SELECT COUNT(*) AS n FROM file_versions WHERE order_id=?').get(o.id).n,
    }));
    const devices = db.prepare('SELECT * FROM devices ORDER BY id').all().map((d) => ({
      ...d,
      tasks: db.prepare(
        `SELECT t.*, o.order_no, o.customer, o.paper_size, o.copies, o.rush
         FROM print_tasks t JOIN orders o ON o.id=t.order_id
         WHERE t.device_id=? AND t.status IN ('standby','printing')
         ORDER BY t.status='printing' DESC, t.position, t.id`
      ).all(d.id),
    }));
    return { orders, devices, operators: OPERATORS };
  }

  function orderDetail(orderId) {
    const o = getOrder(orderId);
    return {
      order: o,
      versions: db.prepare('SELECT * FROM file_versions WHERE order_id=? ORDER BY version_no').all(orderId)
        .map((v) => ({ ...v, issues: JSON.parse(v.issues) })),
      proofs: db.prepare('SELECT * FROM proofs WHERE order_id=? ORDER BY id').all(orderId)
        .map((p) => ({ ...p, annotations: JSON.parse(p.annotations) })),
      charges: db.prepare('SELECT * FROM charges WHERE order_id=? ORDER BY id').all(orderId),
      reprints: db.prepare('SELECT * FROM reprints WHERE order_id=? ORDER BY id').all(orderId),
      tasks: db.prepare('SELECT * FROM print_tasks WHERE order_id=? ORDER BY id').all(orderId),
      pickups: db.prepare('SELECT * FROM pickups WHERE order_id=?').all(orderId),
    };
  }

  return {
    OPERATORS,
    addDevice, createOrder, uploadVersion, generateProof, addAnnotation, confirmProof, rejectProof,
    setRush, claimTask, finishTask, jamDevice, clearDevice,
    addCharge, recordReprint, reduceCopies, pickup,
    listState, orderDetail, getOrder, getProof, getTask, getDevice,
  };
}

module.exports = { createService, OPERATORS };
