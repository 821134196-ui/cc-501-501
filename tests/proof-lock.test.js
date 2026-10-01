'use strict';
// 校样锁定：确认后补传文件不得覆盖已确认校样
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { makeService, CLEAN_A1 } = require('./helpers');

test('校样确认后锁定，补传文件不覆盖已确认校样', () => {
  const { service } = makeService();
  const o = service.createOrder({ customer: '甲', paper_size: 'A1', color: 'bw', sides: 'single', binding: 'none', copies: 1 });
  service.uploadVersion(o.id, { filename: 'v1.json', content: JSON.stringify(CLEAN_A1) });
  const proof = service.generateProof(o.id);
  service.addAnnotation(proof.id, { x: 100, y: 100, text: '此处加图签', author: '门店' });
  service.confirmProof(proof.id);

  const confirmed = service.getProof(proof.id);
  assert.equal(confirmed.status, 'confirmed');
  assert.equal(confirmed.locked, 1);

  // 已锁定的校样不能再批注、不能重复确认
  assert.throws(() => service.addAnnotation(proof.id, { x: 1, y: 1, text: 'x' }), /已确认锁定/);
  assert.throws(() => service.confirmProof(proof.id), /不能重复确认/);

  // 补传文件：产生新版本，已确认校样原样保留
  const v2drawing = { ...CLEAN_A1, name: '测试图-修改' };
  service.uploadVersion(o.id, { filename: 'v2.json', content: JSON.stringify(v2drawing) });
  const detail = service.orderDetail(o.id);
  assert.equal(detail.versions.length, 2);
  const kept = detail.proofs.find((p) => p.id === proof.id);
  assert.equal(kept.status, 'confirmed');
  assert.equal(kept.locked, 1);
  assert.equal(kept.version_id, detail.versions[0].id); // 仍指向 v1
  assert.deepEqual(kept.annotations.map((a) => a.text), ['此处加图签']); // 批注未被覆盖

  // 新版本走新校样；确认新校样后，旧校样转为「被替代」但记录仍保留
  const proof2 = service.generateProof(o.id);
  service.confirmProof(proof2.id);
  const after = service.orderDetail(o.id);
  const old = after.proofs.find((p) => p.id === proof.id);
  assert.equal(old.status, 'superseded');
  assert.equal(old.locked, 1);
  assert.deepEqual(old.annotations.map((a) => a.text), ['此处加图签']);
  assert.equal(after.proofs.filter((p) => p.status === 'confirmed').length, 1);
});
