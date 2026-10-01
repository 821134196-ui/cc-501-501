"""SQLite 存储层:订单、文件版本、校样、设备队列、重印、费用明细、取件。"""
import os
import sqlite3
from contextlib import contextmanager

SCHEMA = """
CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT UNIQUE NOT NULL,
    customer TEXT NOT NULL,
    paper_size TEXT NOT NULL,          -- A0..A4
    color_mode TEXT NOT NULL,          -- bw | color
    duplex INTEGER NOT NULL DEFAULT 0, -- 0 单面 1 双面
    binding TEXT NOT NULL DEFAULT 'none', -- none | staple | glue | hardcover
    copies INTEGER NOT NULL,
    urgent INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'pending_file',
    -- pending_file 待传文件 | proof_ready 待确认校样 | queued 排队中
    -- printing 打印中 | ready 待取件 | delivered 已交付
    confirmed_version_id INTEGER,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS file_versions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL REFERENCES orders(id),
    version INTEGER NOT NULL,
    filename TEXT NOT NULL,
    path TEXT NOT NULL,
    page_count INTEGER NOT NULL DEFAULT 1,
    width_mm REAL NOT NULL,
    height_mm REAL NOT NULL,
    precheck_status TEXT NOT NULL,     -- ok | warning | error
    precheck_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(order_id, version)
);

CREATE TABLE IF NOT EXISTS proofs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL REFERENCES orders(id),
    version_id INTEGER NOT NULL REFERENCES file_versions(id),
    status TEXT NOT NULL DEFAULT 'open', -- open | confirmed | superseded
    locked INTEGER NOT NULL DEFAULT 0,
    confirmed_at TEXT,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS annotations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    proof_id INTEGER NOT NULL REFERENCES proofs(id),
    author TEXT NOT NULL,              -- shop | customer
    x_mm REAL NOT NULL,
    y_mm REAL NOT NULL,
    text TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS devices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    max_paper TEXT NOT NULL,           -- 设备可打最大幅面
    color INTEGER NOT NULL DEFAULT 0,  -- 是否支持彩色
    sec_per_page REAL NOT NULL DEFAULT 2.0, -- 每页印张耗时(秒),用于估时
    status TEXT NOT NULL DEFAULT 'idle' -- idle | printing
);

CREATE TABLE IF NOT EXISTS print_tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL REFERENCES orders(id),
    device_id INTEGER NOT NULL REFERENCES devices(id),
    version_id INTEGER NOT NULL REFERENCES file_versions(id),
    kind TEXT NOT NULL DEFAULT 'print',  -- print | reprint
    status TEXT NOT NULL DEFAULT 'queued', -- queued | printing | done | jammed | cancelled
    operator TEXT,
    position INTEGER NOT NULL,
    est_start TEXT,
    est_finish TEXT,
    started_at TEXT,
    finished_at TEXT,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS reprints (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL REFERENCES orders(id),
    task_id INTEGER REFERENCES print_tasks(id),
    reason TEXT NOT NULL,        -- font_missing | layer_unprinted | scale_mismatch | paper_jam
    fee_handling TEXT NOT NULL,  -- shop_absorb | customer_partial
    amount REAL NOT NULL,        -- 向客户收取的金额(店方承担为 0)
    note TEXT,
    operator TEXT,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS charges (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL REFERENCES orders(id),
    type TEXT NOT NULL,   -- print | binding | rush | reprint | reprint_free | reduction
    label TEXT NOT NULL,
    qty REAL,
    unit_price REAL,
    amount REAL NOT NULL, -- 负数表示退款
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS pickups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL UNIQUE REFERENCES orders(id), -- 一单只能取件一次
    operator TEXT NOT NULL,
    customer TEXT NOT NULL,
    created_at TEXT NOT NULL
);
"""


def connect(db_path):
    conn = sqlite3.connect(db_path, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.isolation_level = None  # 手动事务
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


@contextmanager
def tx(conn):
    """写事务:BEGIN IMMEDIATE 保证并发下只有一个写者。"""
    conn.execute("BEGIN IMMEDIATE")
    try:
        yield conn
        conn.execute("COMMIT")
    except Exception:
        conn.execute("ROLLBACK")
        raise


def init_db(db_path):
    d = os.path.dirname(db_path)
    if d:
        os.makedirs(d, exist_ok=True)
    conn = connect(db_path)
    conn.executescript(SCHEMA)
    conn.close()


def one(conn, sql, args=()):
    return conn.execute(sql, args).fetchone()


def all_(conn, sql, args=()):
    return conn.execute(sql, args).fetchall()
