'use strict';
// 测试辅助：内存数据库 + 临时目录 + 模拟打印机
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { openDb } = require('../src/db');
const { createService } = require('../src/service');
const { MockPrinter } = require('../src/printer');

const CLEAN_A1 = {
  name: '测试图',
  pages: [{
    width_mm: 841, height_mm: 594, declared_scale: '1:100',
    content_mm: { w: 84100, h: 59400 },
    fonts: ['SimSun'], layers: [{ name: '墙体', print: true }],
  }],
};

function makeService() {
  const db = openDb(':memory:');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'printshop-'));
  const printer = new MockPrinter();
  const service = createService({ db, printer, dataDir });
  service.addDevice('绘图仪-1', 'plotter');
  service.addDevice('激光机-1', 'laser');
  return { db, service, printer };
}

// 走完整流程到「待取件」
function makePrintedOrder(service, overrides = {}) {
  const o = service.createOrder({
    customer: '测试客户', paper_size: 'A1', color: 'bw', sides: 'single',
    binding: 'none', copies: 2, ...overrides,
  });
  service.uploadVersion(o.id, { filename: 't.json', content: JSON.stringify(CLEAN_A1) });
  const proof = service.generateProof(o.id);
  service.confirmProof(proof.id);
  const task = service.listState().devices.flatMap((d) => d.tasks).find((t) => t.order_id === o.id);
  service.claimTask(task.id, '张伟');
  service.finishTask(task.id, '张伟');
  return service.getOrder(o.id);
}

module.exports = { makeService, makePrintedOrder, CLEAN_A1 };
