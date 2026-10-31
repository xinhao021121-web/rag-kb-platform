'use strict';
const { getDb, makeId, now } = require('../db');
const { requirePermission } = require('../rbac');
const { addAudit } = require('../audit');

function kbRow(kb, docs) {
  const list = docs.filter(d => d.kb_id === kb.id);
  return {
    ...kb,
    docCount: list.length,
    publishedCount: list.filter(d => d.status === '已发布').length
  };
}

function register(router) {
  router.get('/api/kb', (ctx) => {
    const d = getDb();
    const kbs = d.prepare('SELECT * FROM knowledge_bases ORDER BY created_at DESC').all();
    const docs = d.prepare('SELECT kb_id,status FROM documents').all();
    return { kbs: kbs.map(kb => kbRow(kb, docs)) };
  });

  router.post('/api/kb', (ctx) => {
    requirePermission(ctx.user, 'kb.write');
    const { name, domain, owner, scope, description } = ctx.body || {};
    if (!name || !String(name).trim()) throw Object.assign(new Error('请填写知识库名称'), { status: 400 });
    const d = getDb();
    if (d.prepare('SELECT id FROM knowledge_bases WHERE name = ?').get(String(name).trim())) {
      throw Object.assign(new Error('知识库名称已存在'), { status: 400 });
    }
    const kb = {
      id: makeId('KB'), name: String(name).trim(), domain: domain || '售后',
      owner: owner || '待分配', scope: scope || '全公司', status: '建设中',
      description: description || '新建知识库，等待上传第一份知识文档。'
    };
    d.prepare('INSERT INTO knowledge_bases (id,name,domain,owner,scope,status,description,created_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(kb.id, kb.name, kb.domain, kb.owner, kb.scope, kb.status, kb.description, now());
    addAudit(ctx.user, '新建知识库：' + kb.name);
    return { kb: d.prepare('SELECT * FROM knowledge_bases WHERE id = ?').get(kb.id) };
  });

  router.patch('/api/kb/:id', (ctx) => {
    requirePermission(ctx.user, 'kb.write');
    const d = getDb();
    const kb = d.prepare('SELECT * FROM knowledge_bases WHERE id = ?').get(ctx.params.id);
    if (!kb) throw Object.assign(new Error('知识库不存在'), { status: 404 });
    const b = ctx.body || {};
    const name = b.name != null ? String(b.name).trim() : kb.name;
    if (!name) throw Object.assign(new Error('请填写知识库名称'), { status: 400 });
    d.prepare('UPDATE knowledge_bases SET name=?, domain=?, owner=?, scope=?, status=?, description=? WHERE id=?')
      .run(name, b.domain || kb.domain, b.owner || kb.owner, b.scope || kb.scope, b.status || kb.status, b.description || kb.description, kb.id);
    if (name !== kb.name) d.prepare('UPDATE documents SET kb_name=? WHERE kb_id=?').run(name, kb.id);
    addAudit(ctx.user, '编辑知识库：' + name);
    return { kb: d.prepare('SELECT * FROM knowledge_bases WHERE id = ?').get(kb.id) };
  });

  router.post('/api/kb/:id/archive', (ctx) => {
    requirePermission(ctx.user, 'kb.write');
    const d = getDb();
    const kb = d.prepare('SELECT * FROM knowledge_bases WHERE id = ?').get(ctx.params.id);
    if (!kb) throw Object.assign(new Error('知识库不存在'), { status: 404 });
    const archived = !!(ctx.body && ctx.body.archived);
    d.prepare('UPDATE knowledge_bases SET status=?, archived_at=? WHERE id=?')
      .run(archived ? '已归档' : '建设中', archived ? now() : null, kb.id);
    addAudit(ctx.user, (archived ? '归档' : '恢复') + '知识库：' + kb.name);
    return { kb: d.prepare('SELECT * FROM knowledge_bases WHERE id = ?').get(kb.id) };
  });
}

module.exports = { register };
