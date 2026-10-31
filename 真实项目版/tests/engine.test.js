'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { chunkText, bm25Search, extractiveAnswer, expandQuery } = require('../server/engine-local');
const rbac = require('../server/rbac');

test('切片：按 FAQ 标记切分且保留标题', () => {
  const text = '[FAQ-001] 如何确认正品？\n标准答复：核对防伪码和序列号。\n\n[FAQ-032] 鼓包怎么办？\n标准答复：立即停止充放电，不要挤压或拆解。';
  const chunks = chunkText(text);
  assert.ok(chunks.length >= 2, '应至少切出两个片段');
  assert.ok(chunks[0].content.includes('防伪码'));
  assert.ok(chunks[1].content.includes('停止充放电'));
});

test('检索：同义问法（膨胀→鼓包）能命中正确片段', () => {
  const text = '[FAQ-001] 正品验真\n核对防伪码、序列号与购买渠道。\n[FAQ-032] 鼓包处理\n鼓包属于高风险异常，请立即停止充放电，不要挤压、穿刺、拆解或普通快递寄送。';
  const chunks = chunkText(text);
  const records = bm25Search(chunks, '电池有点膨胀，需要马上停用吗？', 3);
  assert.ok(records.length > 0, '应有检索结果');
  assert.ok(records[0].segment.content.includes('鼓包'), 'Top1 应为鼓包处理片段');
  const answer = extractiveAnswer('电池膨胀', records);
  assert.ok(/停止|不得|不要/.test(answer), '回答应包含停止使用要求');
});

test('查询扩展：常见说法能补充关键词', () => {
  assert.ok(expandQuery('充不进电').includes('性能故障'));
  assert.ok(expandQuery('山寨充电宝').includes('防伪码'));
});

test('RBAC：角色权限与服务端拒绝', () => {
  assert.equal(rbac.can({ role: 'operator' }, 'doc.write'), true);
  assert.equal(rbac.can({ role: 'operator' }, 'review.decide'), false);
  assert.equal(rbac.can({ role: 'reviewer' }, 'review.decide'), true);
  assert.equal(rbac.can({ role: 'tester' }, 'release.decide'), false);
  assert.equal(rbac.can({ role: 'approver' }, 'release.decide'), true);
  assert.throws(() => rbac.requirePermission({ role: 'operator' }, 'release.decide'), /权限/);
});
