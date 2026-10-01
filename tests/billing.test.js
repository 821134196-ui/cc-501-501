'use strict';
// 计费调整：各类重印原因与临时减量的费用处理；已交付订单不能再次收费
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { makeService, makePrintedOrder, CLEAN_A1 } = require('./helpers');

// A1 黑白单面 6 元/页；1 页 × 2 份，不装订 → 基础费 12 元
function confirmedOrder(service, copies = 2) {
  const o = service.createOrder({ customer: '乙', paper_size: 'A1', color: 'bw', sides: 'single', binding: 'none', copies });
  service.uploadVersion(o.id, { filename: 't.json', content: JSON.stringify(CLEAN_A1) });
  const proof = service.generateProof(o.id);
  service.confirmProof(proof.id);
  return service.getOrder(o.id);
}

test('基础打印费按页数×份数×规格计价', () => {
  const { service } = makeService();
  const o = confirmedOrder(service, 2);
  const charges = service.orderDetail(o.id).charges;
  assert.equal(charges.length, 1);
  assert.equal(charges[0].kind, 'base');
  assert.equal(charges[0].amount, 12);
});

test('字体缺失/图层未打印/卡纸：店方承担免费重印；比例不符：半价', () => {
  const { service } = makeService();
  const o = confirmedOrder(service, 2);

  for (const reason of ['font_missing', 'layer_unprinted', 'paper_jam']) {
    const r = service.recordReprint(o.id, { reason, pages: 1, copies: 2 });
    assert.equal(r.amount, 0, reason);
    assert.match(r.handling, /店方承担/);
  }
  const half = service.recordReprint(o.id, { reason: 'scale_mismatch', pages: 1, copies: 2 });
  assert.equal(half.amount, 6); // 1页×2份×6元 × 50%
  assert.match(half.handling, /半价/);

  const total = service.orderDetail(o.id).charges.reduce((s, c) => s + c.amount, 0);
  assert.equal(total, 12 + 6); // 基础费 + 半价重印，免费重印不影响总额
});

test('客户临时减量：退 90%，份数同步减少', () => {
  const { service } = makeService();
  const o = confirmedOrder(service, 4); // 基础费 1页×4份×6 = 24
  const after = service.reduceCopies(o.id, { copies: 3 });
  assert.equal(after.copies, 3);
  const refund = service.orderDetail(o.id).charges.find((c) => c.kind === 'refund');
  assert.equal(refund.amount, -5.4); // 每份 6 元 × 1 份 × 90%
  assert.throws(() => service.reduceCopies(o.id, { copies: 3 }), /减量后的份数/);
});

test('已交付订单不能再次收费', () => {
  const { service } = makeService();
  const o = makePrintedOrder(service);
  service.pickup(o.id, { code: o.pickup_code });
  assert.equal(service.getOrder(o.id).status, 'delivered');

  assert.throws(() => service.addCharge(o.id, { kind: 'adjustment', label: '补差', amount: 1 }), /已交付，不能再次收费/);
  assert.throws(() => service.recordReprint(o.id, { reason: 'paper_jam' }), /已交付/);
  assert.throws(() => service.reduceCopies(o.id, { copies: 1 }), /当前状态不能减量/);
});
