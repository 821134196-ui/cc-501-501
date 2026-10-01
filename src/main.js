'use strict';
// 入口：一条命令启动并生成比例错误样例
//   npm start          —— 生成演示数据（含比例错误样例）并启动服务
//   node src/main.js --seed-only   —— 只生成数据不启动
const path = require('node:path');
const { openDb } = require('./db');
const { createService } = require('./service');
const { MockPrinter } = require('./printer');
const { seed } = require('./seed');
const { startServer } = require('./server');

const args = process.argv.slice(2);
const demo = args.includes('--demo');
const seedOnly = args.includes('--seed-only');
const port = Number(process.env.PORT || 3000);

const dataDir = path.join(__dirname, '..', 'data');
const db = openDb(path.join(dataDir, 'printshop.db'));
const service = createService({ db, printer: new MockPrinter(), dataDir });

if (demo || seedOnly) {
  const hasOrders = db.prepare('SELECT COUNT(*) AS n FROM orders').get().n > 0;
  if (hasOrders) {
    console.log('数据库已有订单，跳过演示数据生成（删除 data/ 可重置）');
  } else {
    const r = seed({ db, service });
    console.log(`已生成演示数据：${r.orders} 个订单，比例错误样例 → ${r.scaleErrorFile}`);
  }
}

if (!seedOnly) startServer({ service, port });
