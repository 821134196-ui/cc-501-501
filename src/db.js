'use strict';
// SQLite 存储：订单、文件版本、校样、设备、打印任务、重印、费用、取件
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');

const SCHEMA = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS orders (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  order_no      TEXT NOT NULL UNIQUE,
  customer      TEXT NOT NULL,
  paper_size    TEXT NOT NULL,          -- A0/A1/A2/A3/A4
  color         TEXT NOT NULL,          -- bw | color
  sides         TEXT NOT NULL,          -- single | double
  binding       TEXT NOT NULL,          -- none | staple | ring | glue
  copies        INTEGER NOT NULL,
  rush          INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL,          -- received/prechecked/proof_ready/confirmed/queued/printing/printed/delivered
  pickup_code   TEXT NOT NULL,
  estimated_ready_at TEXT,
  created_at    TEXT NOT NULL,
  delivered_at  TEXT
);

CREATE TABLE IF NOT EXISTS file_versions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id    INTEGER NOT NULL REFERENCES orders(id),
  version_no  INTEGER NOT NULL,
  filename    TEXT NOT NULL,
  path        TEXT NOT NULL,
  page_count  INTEGER NOT NULL,
  sheet_w     REAL NOT NULL,            -- mm
  sheet_h     REAL NOT NULL,            -- mm
  sheet_size  TEXT NOT NULL,            -- 匹配到的图幅，如 A1；非标准则为 "非标准"
  issues      TEXT NOT NULL,            -- JSON：预检报告
  created_at  TEXT NOT NULL,
  UNIQUE(order_id, version_no)
);

CREATE TABLE IF NOT EXISTS proofs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id    INTEGER NOT NULL REFERENCES orders(id),
  version_id  INTEGER NOT NULL REFERENCES file_versions(id),
  status      TEXT NOT NULL,            -- pending/confirmed/rejected/superseded
  annotations TEXT NOT NULL DEFAULT '[]',
  locked      INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  confirmed_at TEXT
);

CREATE TABLE IF NOT EXISTS devices (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  name   TEXT NOT NULL UNIQUE,
  kind   TEXT NOT NULL,                 -- plotter(大图) | laser(小图)
  status TEXT NOT NULL DEFAULT 'idle'   -- idle | printing | jammed
);

CREATE TABLE IF NOT EXISTS print_tasks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id    INTEGER NOT NULL REFERENCES orders(id),
  device_id   INTEGER NOT NULL REFERENCES devices(id),
  operator    TEXT,
  kind        TEXT NOT NULL DEFAULT 'normal',  -- normal | reprint
  status      TEXT NOT NULL DEFAULT 'standby', -- standby | printing | done
  position    INTEGER NOT NULL,
  est_minutes INTEGER NOT NULL,
  created_at  TEXT NOT NULL,
  started_at  TEXT,
  finished_at TEXT
);

CREATE TABLE IF NOT EXISTS reprints (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id   INTEGER NOT NULL REFERENCES orders(id),
  reason     TEXT NOT NULL,             -- font_missing/layer_unprinted/scale_mismatch/paper_jam
  pages      INTEGER NOT NULL,
  copies     INTEGER NOT NULL,
  handling   TEXT NOT NULL,             -- 费用处理说明
  amount     REAL NOT NULL,             -- 实际收取（0=店方承担）
  note       TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS charges (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id   INTEGER NOT NULL REFERENCES orders(id),
  kind       TEXT NOT NULL,             -- base | reprint | refund | adjustment
  label      TEXT NOT NULL,
  amount     REAL NOT NULL,             -- 退款为负数
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS pickups (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id  INTEGER NOT NULL REFERENCES orders(id),
  code      TEXT NOT NULL,
  picked_at TEXT NOT NULL
);
`;

function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  return db;
}

module.exports = { openDb };
