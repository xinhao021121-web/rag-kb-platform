'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { getDb, makeId, now, UPLOAD_DIR } = require('../db');
const { requirePermission, ROLE_NAMES } = require('../rbac');
const { addAudit } = require('../audit');
const local = require('../engine-local');
const dify = require('../dify');

const ALLOWED_EXT = ['pdf', 'docx', 'txt', 'md', 'csv', 'html', 'htm'];

function docRow(doc) {
  const d = getDb();
  const job = d.prepare('SELECT * FROM jobs WHERE document_id = ? ORDER BY created_at DESC LIMIT 1').get(doc.id);
  const review = d.prepare('SELECT * FROM reviews WHERE document_id = ? ORDER BY created_at DESC LIMIT 1').get(doc.id);
  return { ...doc, job: job || null, review: review || null };
}

function register(router) {
  router.get('/api/documents', (ctx) => {
    const d = getDb();
    const kb = ctx.query.get('kb') || '';
    const status = ctx.query.get('status') || '';
    const q = (ctx.query.get('q') || '').toLowerCase();
    let rows = d.prepare('SELECT * FROM documents ORDER BY created_at DESC').all();
    if (kb) rows = rows.filter(r => r.kb_name === kb);
    if (status) rows = rows.filter(r => r.status === status);
    if (q) rows = rows.filter(r => (r.title + ' ' + r.id + ' ' + (r.file_name || '')).toLowerCase().includes(q));
    return { documents: rows };
  });

  router.post('/api/documents/upload', async (ctx) => {
    requirePermission(ctx.user, 'doc.write');
    const q = ctx.query;
    const fileName = q.get('filename') || '未命名.txt';
    const ext = (path.extname(fileName) || '').replace('.', '').toLowerCase();
    if (!ALLOWED_EXT.includes(ext)) throw Object.assign(new Error('不支持的文件类型：.' + ext), { status: 400 });
    const buf = ctx.raw || Buffer.alloc(0);
    if (!buf.length) throw Object.assign(new Error('上传内容为空'), { status: 400 });
    const kbId = q.get('kbId') || '';
    const d = getDb();
    const kb = d.prepare('SELECT * FROM knowledge_bases WHERE id = ?').get(kbId);
    if (!kb) throw Object.assign(new Error('请选择所属知识库'), { status: 400 });
    const id = makeId('DOC');
    const versionId = makeId('VER');
    const filePath = path.join(UPLOAD_DIR, id + '.' + ext);
    fs.writeFileSync(filePath, buf);
    let text = '';
    try { text = await local.extractText(filePath, fileName); } catch (e) { text = ''; }
    const version = q.get('version') || 'v1.0';
    const title = (q.get('title') || fileName.replace(/\.[^.]+$/, '')).trim();
    const fields = {
      type: q.get('type') || '政策/SOP',
      channel: q.get('channel') || '全渠道',
      owner: q.get('owner') || (ROLE_NAMES[ctx.user.role] + '·' + ctx.user.name),
      validity: q.get('validity') || '待补充'
    };
    d.prepare(`INSERT INTO documents
      (id,kb_id,kb_name,title,file_name,file_path,extension,type,channel,owner,version,validity,status,content_text,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, kb.id, kb.name, title, fileName, filePath, ext.toUpperCase(), fields.type, fields.channel, fields.owner, version, fields.validity, '草稿', text, now(), now());
    d.prepare('INSERT INTO document_versions (id,document_id,version,note,status,author,created_at) VALUES (?,?,?,?,?,?,?)')
      .run(versionId, id, version, '上传保存草稿', '草稿', ctx.user.name, now());
    addAudit(ctx.user, '保存文档草稿 ' + id);
    return { document: docRow(d.prepare('SELECT * FROM documents WHERE id = ?').get(id)), versionId };
  });

  router.get('/api/documents/:id', (ctx) => {
    const d = getDb();
    const doc = d.prepare('SELECT * FROM documents WHERE id = ?').get(ctx.params.id);
    if (!doc) throw Object.assign(new Error('文档不存在'), { status: 404 });
    const versions = d.prepare('SELECT * FROM document_versions WHERE document_id = ? ORDER BY created_at DESC').all(doc.id);
    const reviews = d.prepare('SELECT * FROM reviews WHERE document_id = ? ORDER BY created_at DESC').all(doc.id);
    const job = d.prepare('SELECT * FROM jobs WHERE document_id = ? ORDER BY created_at DESC LIMIT 1').get(doc.id);
    return { document: doc, versions, reviews, job: job || null };
  });

  router.get('/api/documents/:id/file', (ctx) => {
    const d = getDb();
    const doc = d.prepare('SELECT * FROM documents WHERE id = ?').get(ctx.params.id);
    if (!doc || !doc.file_path) throw Object.assign(new Error('文件不存在'), { status: 404 });
    return { __file: { filePath: doc.file_path, fileName: doc.file_name || doc.title, mime: 'application/octet-stream' } };
  });

  router.post('/api/documents/:id/submit', (ctx) => {
    requirePermission(ctx.user, 'doc.submit');
    const d = getDb();
    const doc = d.prepare('SELECT * FROM documents WHERE id = ?').get(ctx.params.id);
    if (!doc) throw Object.assign(new Error('文档不存在'), { status: 404 });
    if (doc.status !== '草稿') throw Object.assign(new Error('只有草稿可以提交审核'), { status: 400 });
    d.prepare('UPDATE documents SET status=?, submitted_at=?, updated_at=? WHERE id=?').run('待审核', now(), now(), doc.id);
    d.prepare('INSERT INTO reviews (id,document_id,submitter,created_at) VALUES (?,?,?,?)').run(makeId('RV'), doc.id, ctx.user.name, now());
    addAudit(ctx.user, '提交业务审核 ' + doc.id);
    return { document: d.prepare('SELECT * FROM documents WHERE id = ?').get(doc.id) };
  });

  router.post('/api/documents/:id/new-version', (ctx) => {
    requirePermission(ctx.user, 'doc.write');
    const d = getDb();
    const doc = d.prepare('SELECT * FROM documents WHERE id = ?').get(ctx.params.id);
    if (!doc) throw Object.assign(new Error('文档不存在'), { status: 404 });
    const b = ctx.body || {};
    const version = (b.version || 'v1.1').trim();
    const id = makeId('DOC');
    d.prepare(`INSERT INTO documents
      (id,kb_id,kb_name,title,file_name,file_path,extension,type,channel,owner,version,validity,status,content_text,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, doc.kb_id, doc.kb_name, doc.title, doc.file_name, doc.file_path, doc.extension, doc.type, doc.channel, doc.owner, version, doc.validity, '草稿', doc.content_text, now(), now());
    d.prepare('INSERT INTO document_versions (id,document_id,version,note,status,author,created_at) VALUES (?,?,?,?,?,?,?)')
      .run(makeId('VER'), id, version, b.note || '新版本草稿', '草稿', ctx.user.name, now());
    addAudit(ctx.user, '创建新版本 ' + id + ' ' + version);
    return { document: d.prepare('SELECT * FROM documents WHERE id = ?').get(id) };
  });

  /* ---------- 业务审核 ---------- */
  router.get('/api/reviews', (ctx) => {
    const d = getDb();
    const filter = ctx.query.get('filter') || 'pending';
    let docs = d.prepare("SELECT * FROM documents WHERE status = '待审核' ORDER BY submitted_at ASC").all();
    if (filter === 'p0') docs = docs.filter(x => x.type === '安全SOP' || /安全|鼓包|冒烟/.test(x.title));
    const all = d.prepare('SELECT * FROM documents WHERE status NOT IN (?,?)').all('草稿', '待审核');
    return { pending: docs, processedCount: all.length, drafts: d.prepare("SELECT * FROM documents WHERE status='草稿'").all().length };
  });

  router.post('/api/reviews/:docId/approve', (ctx) => {
    requirePermission(ctx.user, 'review.decide');
    const d = getDb();
    const doc = d.prepare('SELECT * FROM documents WHERE id = ?').get(ctx.params.docId);
    if (!doc) throw Object.assign(new Error('文档不存在'), { status: 404 });
    if (doc.status !== '待审核') throw Object.assign(new Error('当前文档不在待审核状态'), { status: 400 });
    const b = ctx.body || {};
    if (!b.confirmFact || !b.confirmScope || !b.confirmValidity) throw Object.assign(new Error('请完成三项确认后再通过'), { status: 400 });
    if (!String(b.note || '').trim()) throw Object.assign(new Error('请填写审核备注'), { status: 400 });
    const review = d.prepare('SELECT * FROM reviews WHERE document_id = ? ORDER BY created_at DESC LIMIT 1').get(doc.id);
    if (review && review.submitter === ctx.user.name) throw Object.assign(new Error('提交人与审核人不能为同一人'), { status: 403 });
    d.prepare('UPDATE documents SET status=?, reviewed_at=?, updated_at=? WHERE id=?').run('测试入库中', now(), now(), doc.id);
    if (review) {
      d.prepare('UPDATE reviews SET reviewer=?, confirm_fact=1, confirm_scope=1, confirm_validity=1, note=?, verdict=?, decided_at=? WHERE id=?')
        .run(ctx.user.name, String(b.note), '通过', now(), review.id);
    }
    let job = d.prepare('SELECT * FROM jobs WHERE document_id = ? AND environment = ?').get(doc.id, '测试');
    if (!job) {
      const jobId = makeId('JOB-TEST');
      const kb = d.prepare('SELECT * FROM knowledge_bases WHERE id = ?').get(doc.kb_id);
      d.prepare('INSERT INTO jobs (id,document_id,environment,dataset_id,step,progress,status,created_at) VALUES (?,?,?,?,?,?,?,?)')
        .run(jobId, doc.id, '测试', kb && kb.test_dataset_id || null, '等待推送', 0, '待推送', now());
      job = d.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
    }
    addAudit(ctx.user, '审核通过并自动创建测试入库任务 ' + doc.id);
    return { document: d.prepare('SELECT * FROM documents WHERE id = ?').get(doc.id), job };
  });

  router.post('/api/reviews/:docId/reject', (ctx) => {
    requirePermission(ctx.user, 'review.decide');
    const d = getDb();
    const doc = d.prepare('SELECT * FROM documents WHERE id = ?').get(ctx.params.docId);
    if (!doc) throw Object.assign(new Error('文档不存在'), { status: 404 });
    if (doc.status !== '待审核') throw Object.assign(new Error('当前文档不在待审核状态'), { status: 400 });
    const reason = String((ctx.body && ctx.body.reason) || '').trim();
    if (!reason) throw Object.assign(new Error('请填写具体修改要求'), { status: 400 });
    d.prepare('UPDATE documents SET status=?, reject_reason=?, reviewed_at=?, updated_at=? WHERE id=?').run('草稿', reason, now(), now(), doc.id);
    const review = d.prepare('SELECT * FROM reviews WHERE document_id = ? ORDER BY created_at DESC LIMIT 1').get(doc.id);
    if (review) d.prepare('UPDATE reviews SET reviewer=?, verdict=?, reject_reason=?, decided_at=? WHERE id=?').run(ctx.user.name, '驳回', reason, now(), review.id);
    addAudit(ctx.user, '驳回 ' + doc.id + '：' + reason);
    return { document: d.prepare('SELECT * FROM documents WHERE id = ?').get(doc.id) };
  });
}

module.exports = { register, docRow };
