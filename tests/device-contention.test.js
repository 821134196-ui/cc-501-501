'use strict';
// 设备竞争：两名操作员抢同一任务，只有一人能开机；急单插队重算预计完成时间
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { makeService, CLEAN_A1 } = require('./helpers');

function queuedOrder(service, customer, paper = 'A1') {
  const o = service.createOrder({ customer, paper_size: paper, color: 'bw', sides: 'single', binding: 'none', copies: 1 });
  service.uploadVersion(o.id, { filename: 't.json', content: JSON.stringify(CLEAN_A1) });
  service.confirmProof(service.generateProof(o.id).id);
  return service.getOrder(o.id);
}

test('两名操作员抢同一设备任务，只能一人开机', async () => {
  const { service } = makeService();
  const o = queuedOrder(service, '丙');
  const task = service.listState().devices.flatMap((d) => d.tasks).find((t) => t.order_id === o.id);

  // 并发发起两次认领
  const results = await Promise.allSettled([
    Promise.resolve().then(() => service.claimTask(task.id, '张伟')),
    Promise.resolve().then(() => service.claimTask(task.id, '李娜')),
  ]);
  const ok = results.filter((r) => r.status === 'fulfilled');
  const rejected = results.filter((r) => r.status === 'rejected');
  assert.equal(ok.length, 1);
  assert.equal(rejected.length, 1);
  assert.match(String(rejected[0].reason.message), /已被其他操作员开机/);

  const after = service.getTask(task.id);
  assert.equal(after.status, 'printing');
  assert.ok(['张伟', '李娜'].includes(after.operator));

  // 打印中的任务不能再被认领
  assert.throws(() => service.claimTask(task.id, '李娜'), /已被其他操作员开机/);
});

test('急单插队后排在队首，预计完成时间相应提前', () => {
  const { service } = makeService();
  const o1 = queuedOrder(service, '丁-普通');
  const o2 = queuedOrder(service, '丁-急单');
  // 两单都应在同一台 plotter 上（只有一台绘图仪）
  const device = service.listState().devices.find((d) => d.kind === 'plotter');
  assert.equal(device.tasks.length, 2);

  const before = service.getOrder(o2.id).estimated_ready_at;
  service.setRush(o2.id);
  const after = service.getOrder(o2.id);

  assert.equal(after.rush, 1);
  const queue = service.listState().devices.find((d) => d.id === device.id).tasks
    .filter((t) => t.status === 'standby');
  assert.equal(queue[0].order_id, o2.id); // 急单在队首
  assert.ok(Date.parse(after.estimated_ready_at) < Date.parse(before), '急单预计完成时间提前');
  // 普通单的预计完成时间被顺延
  assert.ok(Date.parse(service.getOrder(o1.id).estimated_ready_at) > Date.parse(after.estimated_ready_at));
});
