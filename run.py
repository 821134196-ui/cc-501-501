#!/usr/bin/env python3
"""一条命令启动图文打印店管理系统:

    python3 run.py [--port 8000] [--reset]

启动时会:初始化 SQLite、种子设备、生成图纸样例(含比例错误样例)、
创建两个演示订单(一个 A1 图错选 A3 纸待确认校样,一个已排队待开机)。
"""
import argparse
import os
import shutil
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from app import db, services          # noqa: E402
from app.samples import generate_samples  # noqa: E402
from app.server import App, serve     # noqa: E402

DATA_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")
DB_PATH = os.path.join(DATA_DIR, "app.db")
UPLOAD_DIR = os.path.join(DATA_DIR, "uploads")
SAMPLE_DIR = os.path.join(DATA_DIR, "samples")


def seed_devices(conn):
    if db.one(conn, "SELECT COUNT(*) c FROM devices")["c"]:
        return
    with db.tx(conn):
        conn.execute("INSERT INTO devices(name, max_paper, color, sec_per_page)"
                     " VALUES('蓝图1号', 'A1', 0, 2.0)")
        conn.execute("INSERT INTO devices(name, max_paper, color, sec_per_page)"
                     " VALUES('彩印2号', 'A0', 1, 3.0)")
    print("已种子设备: 蓝图1号(A1·黑白), 彩印2号(A0·彩色)")


def seed_demo_orders(conn):
    if db.one(conn, "SELECT COUNT(*) c FROM orders")["c"]:
        return
    # 演示单 1:A1 总平面图错选 A3 纸 -> 预检比例错误,校样待确认
    o1 = services.create_order(conn, {
        "customer": "张伟(演示)", "paper_size": "A3", "color_mode": "bw",
        "duplex": False, "binding": "none", "copies": 2, "urgent": False})
    with open(os.path.join(SAMPLE_DIR, "a1-site-plan.svg"), encoding="utf-8") as f:
        services.attach_file(conn, o1["id"], "a1-site-plan.svg", f.read(), UPLOAD_DIR)

    # 演示单 2:A1 平面图,已确认校样并排队,可直接在操作台开机
    o2 = services.create_order(conn, {
        "customer": "李娜(演示)", "paper_size": "A1", "color_mode": "bw",
        "duplex": False, "binding": "staple", "copies": 1, "urgent": False})
    with open(os.path.join(SAMPLE_DIR, "a1-floor-plan.svg"), encoding="utf-8") as f:
        services.attach_file(conn, o2["id"], "a1-floor-plan.svg", f.read(), UPLOAD_DIR)
    detail = services.order_detail(conn, o2["id"])
    services.confirm_proof(conn, detail["proofs"][0]["id"])
    print(f"已创建演示订单: {o1['code']}(比例错误样例,待确认校样), {o2['code']}(已排队)")


def main():
    ap = argparse.ArgumentParser(description="图文打印店管理系统")
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--reset", action="store_true", help="清空数据目录后重新初始化")
    args = ap.parse_args()

    if args.reset and os.path.isdir(DATA_DIR):
        shutil.rmtree(DATA_DIR)
    os.makedirs(UPLOAD_DIR, exist_ok=True)

    db.init_db(DB_PATH)
    names = generate_samples(SAMPLE_DIR)
    print(f"已生成 {len(names)} 个图纸样例(含 A1 图幅样例,可用于比例错误演示): "
          + ", ".join(names))

    conn = db.connect(DB_PATH)
    seed_devices(conn)
    seed_demo_orders(conn)
    conn.close()

    serve(App(DB_PATH, UPLOAD_DIR, SAMPLE_DIR), host=args.host, port=args.port)


if __name__ == "__main__":
    main()
