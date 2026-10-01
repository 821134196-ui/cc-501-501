"""业务规则测试:校样锁定、计费调整、设备竞争、重复取件、急单估时。

运行: python3 -m unittest tests.test_rules -v
"""
import os
import sys
import tempfile
import threading
import unittest
from datetime import datetime, timedelta

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app import db, services          # noqa: E402
from app.printer import reset_adapters  # noqa: E402
from app.samples import make_drawing   # noqa: E402
from app.services import BizError      # noqa: E402

NOW = datetime(2026, 10, 1, 9, 0, 0)


def svg(w=841, h=594, pages=1, fonts=None, layers=None):
    return make_drawing(
        width_mm=w, height_mm=h, title="测试图", drawing_no="T-1", scale_label="1:100",
        pages=pages, fonts=fonts if fonts is not None else ["HZTXT"],
        layers=layers if layers is not None else [{"name": "墙体", "print": True}],
        body_kind="plan")


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = self.tmp.name
        self.db_path = os.path.join(self.store, "t.db")
        db.init_db(self.db_path)
        self.conn = db.connect(self.db_path)
        reset_adapters()
        with db.tx(self.conn):
            self.conn.execute("INSERT INTO devices(name,max_paper,color,sec_per_page)"
                              " VALUES('D1','A1',0,10)")
            self.conn.execute("INSERT INTO devices(name,max_paper,color,sec_per_page)"
                              " VALUES('D2','A0',1,10)")

    def tearDown(self):
        self.conn.close()
        self.tmp.cleanup()

    def make_order(self, **kw):
        d = {"customer": "测试客户", "paper_size": "A1", "color_mode": "bw",
             "duplex": False, "binding": "none", "copies": 2, "urgent": False}
        d.update(kw)
        return services.create_order(self.conn, d, NOW)

    def upload(self, oid, text=None):
        return services.attach_file(self.conn, oid, "t.svg", text or svg(),
                                    self.store, NOW)

    def confirm_open_proof(self, oid):
        det = services.order_detail(self.conn, oid)
        p = [p for p in det["proofs"] if p["status"] == "open"][0]
        return services.confirm_proof(self.conn, p["id"], NOW)

    def cycle_tasks(self, oid):
        """把该订单所有排队任务开机并完成,订单回到 ready。"""
        while True:
            det = services.order_detail(self.conn, oid)
            queued = [t for t in det["tasks"] if t["status"] == "queued"]
            if not queued:
                return
            for t in queued:
                services.claim_task(self.conn, t["id"], "测试员", NOW)
                services.complete_task(self.conn, t["id"], NOW)

    def to_ready(self, oid):
        self.upload(oid)
        self.confirm_open_proof(oid)
        self.cycle_tasks(oid)
        self.assertEqual(services.get_order(self.conn, oid)["status"], "ready")


# ---------------------------------------------------------------- 上传预检

class PrecheckTest(Base):
    def test_scale_mismatch_numbers(self):
        o = self.make_order(paper_size="A3")  # A1 图错选 A3 纸
        v = self.upload(o["id"], svg(841, 594))
        pre = __import__("json").loads(v["precheck_json"])
        self.assertEqual(pre["status"], "error")
        self.assertEqual(pre["scale_percent"], 49.9)  # 420/841,真实比例而非约数
        issue = pre["issues"][0]
        self.assertEqual(issue["code"], "scale_mismatch")
        self.assertIn("841×594mm", issue["message"])
        self.assertIn("49.9%", issue["message"])

    def test_font_and_layer_warnings(self):
        o = self.make_order()
        v = self.upload(o["id"], svg(fonts=["HZTXT", "ArchFont-X"],
                                  layers=[{"name": "轮廓", "print": True},
                                          {"name": "工艺备注", "print": False}]))
        pre = __import__("json").loads(v["precheck_json"])
        self.assertEqual(pre["status"], "warning")
        codes = {i["code"] for i in pre["issues"]}
        self.assertEqual(codes, {"font_missing", "layer_unprinted"})


# ---------------------------------------------------------------- 校样锁定

class ProofLockTest(Base):
    def test_confirm_locks_proof(self):
        o = self.make_order()
        self.upload(o["id"])
        det = services.order_detail(self.conn, o["id"])
        pid = det["proofs"][0]["id"]
        services.add_annotation(self.conn, pid, "shop", 100, 100, "此处标高核对", NOW)
        services.confirm_proof(self.conn, pid, NOW)
        proof = db.one(self.conn, "SELECT * FROM proofs WHERE id=?", (pid,))
        self.assertEqual(proof["locked"], 1)
        self.assertEqual(proof["status"], "confirmed")
        with self.assertRaises(BizError):
            services.add_annotation(self.conn, pid, "shop", 1, 1, "锁定后批注", NOW)
        with self.assertRaises(BizError):
            services.confirm_proof(self.conn, pid, NOW)

    def test_reupload_does_not_overwrite_confirmed_proof(self):
        o = self.make_order()
        v1 = self.upload(o["id"])
        det = services.order_detail(self.conn, o["id"])
        p1 = det["proofs"][0]
        services.add_annotation(self.conn, p1["id"], "customer", 50, 60, "客户已核对", NOW)
        services.confirm_proof(self.conn, p1["id"], NOW)

        # 补传 v2:已确认校样必须原样保留
        v2 = self.upload(o["id"], svg(841, 594, pages=3))
        det = services.order_detail(self.conn, o["id"])
        self.assertEqual(services.get_order(self.conn, o["id"])["status"], "proof_ready")
        old = [p for p in det["proofs"] if p["id"] == p1["id"]][0]
        self.assertEqual(old["locked"], 1)
        self.assertEqual(old["status"], "confirmed")
        self.assertEqual(old["version_id"], v1["id"])
        self.assertIsNotNone(old["confirmed_at"])
        self.assertEqual(len(old["annotations"]), 1)
        self.assertEqual(old["annotations"][0]["text"], "客户已核对")
        self.assertEqual(services.get_order(self.conn, o["id"])["confirmed_version_id"], v1["id"])

        # 确认 v2 后:v1 转为 superseded 但记录仍在且仍锁定,队列里只有 v2 的任务
        self.confirm_open_proof(o["id"])
        det = services.order_detail(self.conn, o["id"])
        old = [p for p in det["proofs"] if p["id"] == p1["id"]][0]
        self.assertEqual(old["status"], "superseded")
        self.assertEqual(old["locked"], 1)
        self.assertEqual(services.get_order(self.conn, o["id"])["confirmed_version_id"], v2["id"])
        active = [t for t in det["tasks"] if t["status"] == "queued"]
        self.assertEqual(len(active), 1)
        self.assertEqual(active[0]["version_id"], v2["id"])
        cancelled = [t for t in det["tasks"] if t["status"] == "cancelled"]
        self.assertEqual(len(cancelled), 1)


# ---------------------------------------------------------------- 计费调整

class BillingTest(Base):
    def test_reprint_fee_rules(self):
        # 基准:A1 黑白 单面 1页×2份 = 12 元
        cases = [("font_missing", 0.0), ("layer_unprinted", 0.0),
                 ("paper_jam", 0.0), ("scale_mismatch", 6.0)]
        for reason, expect in cases:
            o = self.make_order()
            self.to_ready(o["id"])
            r = services.reprint(self.conn, o["id"], reason, "测试", "王工", NOW)
            self.assertEqual(r["amount"], expect, reason)
            det = services.order_detail(self.conn, o["id"])
            charge = det["charges"][-1]
            self.assertEqual(charge["amount"], expect)
            self.assertEqual(charge["type"], "reprint" if expect > 0 else "reprint_free")
            self.cycle_tasks(o["id"])  # 重印任务打完,便于用例间互不影响

    def test_reduce_copies_refund(self):
        o = self.make_order(binding="staple")  # 打印 12 + 装订 2×2 = 16
        self.upload(o["id"])
        self.confirm_open_proof(o["id"])
        self.assertEqual(services.order_total(self.conn, o["id"]), 16.0)
        services.reduce_copies(self.conn, o["id"], 1, NOW)
        o2 = services.get_order(self.conn, o["id"])
        self.assertEqual(o2["copies"], 1)
        det = services.order_detail(self.conn, o["id"])
        refunds = [c for c in det["charges"] if c["type"] == "reduction"]
        self.assertEqual(sorted(c["amount"] for c in refunds), [-6.0, -2.0])
        self.assertEqual(services.order_total(self.conn, o["id"]), 8.0)

    def test_reduce_after_printing_rejected(self):
        o = self.make_order()
        self.upload(o["id"])
        task = self.confirm_open_proof(o["id"])
        services.claim_task(self.conn, task["id"], "王工", NOW)
        with self.assertRaises(BizError):
            services.reduce_copies(self.conn, o["id"], 1, NOW)

    def test_no_charge_after_delivery(self):
        o = self.make_order()
        self.to_ready(o["id"])
        services.pickup(self.conn, o["id"], "王工", "测试客户", NOW)
        with self.assertRaises(BizError):  # 已交付不能重印收费
            services.reprint(self.conn, o["id"], "paper_jam", "", "王工", NOW)
        with self.assertRaises(BizError):  # 已交付不能减量退款
            services.reduce_copies(self.conn, o["id"], 1, NOW)


# ---------------------------------------------------------------- 设备竞争

class DeviceContentionTest(Base):
    def setUp(self):
        super().setUp()
        with db.tx(self.conn):  # 只留一台设备,两个任务必抢同一台
            self.conn.execute("DELETE FROM devices WHERE name='D2'")

    def _two_tasks(self):
        o1 = self.make_order(customer="甲")
        self.upload(o1["id"])
        t1 = self.confirm_open_proof(o1["id"])
        o2 = self.make_order(customer="乙")
        self.upload(o2["id"])
        t2 = self.confirm_open_proof(o2["id"])
        return t1, t2

    def test_two_operators_race_one_task(self):
        t1, _ = self._two_tasks()
        results, errors = [], []

        def claim(name):
            conn = db.connect(self.db_path)
            try:
                services.claim_task(conn, t1["id"], name, NOW)
                results.append(name)
            except BizError as e:
                errors.append(str(e))
            finally:
                conn.close()

        barrier = threading.Barrier(2)

        def worker(name):
            barrier.wait()
            claim(name)

        th1 = threading.Thread(target=worker, args=("王工",))
        th2 = threading.Thread(target=worker, args=("李工",))
        th1.start(); th2.start(); th1.join(); th2.join()

        self.assertEqual(len(results), 1)          # 只能一人开机
        self.assertEqual(len(errors), 1)
        task = db.one(self.conn, "SELECT * FROM print_tasks WHERE id=?", (t1["id"],))
        self.assertEqual(task["status"], "printing")
        self.assertIn(task["operator"], ("王工", "李工"))

    def test_device_busy_blocks_second_task(self):
        t1, t2 = self._two_tasks()
        services.claim_task(self.conn, t1["id"], "王工", NOW)
        with self.assertRaises(BizError):  # 设备已被占,第二人开不了机
            services.claim_task(self.conn, t2["id"], "李工", NOW)
        services.complete_task(self.conn, t1["id"], NOW)
        services.claim_task(self.conn, t2["id"], "李工", NOW)  # 完成后可以开


# ---------------------------------------------------------------- 重复取件

class PickupTest(Base):
    def test_duplicate_pickup_rejected(self):
        o = self.make_order()
        self.to_ready(o["id"])
        pk = services.pickup(self.conn, o["id"], "王工", "测试客户", NOW)
        self.assertEqual(pk["order_id"], o["id"])
        self.assertEqual(services.get_order(self.conn, o["id"])["status"], "delivered")
        with self.assertRaises(BizError):
            services.pickup(self.conn, o["id"], "李工", "测试客户", NOW)
        cnt = db.one(self.conn, "SELECT COUNT(*) c FROM pickups WHERE order_id=?",
                     (o["id"],))["c"]
        self.assertEqual(cnt, 1)

    def test_pickup_before_ready_rejected(self):
        o = self.make_order()
        self.upload(o["id"])
        self.confirm_open_proof(o["id"])  # 还在排队
        with self.assertRaises(BizError):
            services.pickup(self.conn, o["id"], "王工", "测试客户", NOW)


# ---------------------------------------------------------------- 急单插队与估时

class QueueEstimateTest(Base):
    def setUp(self):
        super().setUp()
        with db.tx(self.conn):
            self.conn.execute("DELETE FROM devices WHERE name='D2'")

    def _queued_task(self, urgent=False, copies=1):
        o = self.make_order(urgent=urgent, copies=copies)
        self.upload(o["id"])
        self.confirm_open_proof(o["id"])
        det = services.order_detail(self.conn, o["id"])
        return [t for t in det["tasks"] if t["status"] == "queued"][0]

    def test_urgent_jumps_queue_and_shifts_estimates(self):
        # 设备 10 秒/页,每单 1页×1份 = 10 秒
        t1 = self._queued_task()
        t2 = self._queued_task()
        self.assertEqual(t1["est_finish"], (NOW + timedelta(seconds=10)).isoformat(timespec="seconds"))
        self.assertEqual(t2["est_finish"], (NOW + timedelta(seconds=20)).isoformat(timespec="seconds"))

        tu = self._queued_task(urgent=True)  # 急单插队到队首
        self.assertEqual(tu["position"], 1)
        det_tasks = {t["id"]: t for t in services.devices_view(self.conn, NOW)[0]["queue"]}
        self.assertEqual(det_tasks[tu["id"]]["est_finish"],
                         (NOW + timedelta(seconds=10)).isoformat(timespec="seconds"))
        # 原队列整体顺延 10 秒
        self.assertEqual(det_tasks[t1["id"]]["est_finish"],
                         (NOW + timedelta(seconds=20)).isoformat(timespec="seconds"))
        self.assertEqual(det_tasks[t2["id"]]["est_finish"],
                         (NOW + timedelta(seconds=30)).isoformat(timespec="seconds"))


if __name__ == "__main__":
    unittest.main()
