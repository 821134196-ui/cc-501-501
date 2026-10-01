'use strict';
// 取件核验：取件码校验 + 不能重复取件
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { makeService, makePrintedOrder } = require('./helpers');

test('取件需核验取件码，已交付订单不能重复取件', () => {
  const { service } = makeService();
  const o = makePrintedOrder(service);
  assert.equal(o.status, 'printed');

  // 取件码错误
  assert.throws(() => service.pickup(o.id, { code: '000000' }), /取件码错误/);
  assert.equal(service.getOrder(o.id).status, 'printed');

  // 核验通过 → 交付
  const delivered = service.pickup(o.id, { code: o.pickup_code });
  assert.equal(delivered.status, 'delivered');
  assert.ok(delivered.delivered_at);
  assert.equal(service.orderDetail(o.id).pickups.length, 1);

  // 重复取件被拒
  assert.throws(() => service.pickup(o.id, { code: o.pickup_code }), /不能重复取件/);
  assert.equal(service.orderDetail(o.id).pickups.length, 1);
});

test('未完工订单不能取件', () => {
  const { service } = makeService();
  const o = service.createOrder({ customer: '戊', paper_size: 'A3', color: 'bw', sides: 'single', binding: 'none', copies: 1 });
  assert.throws(() => service.pickup(o.id, { code: '123456' }), /未完工/);
});
