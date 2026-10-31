'use strict';
const { getDb, now } = require('../db');
const { requirePermission } = require('../rbac');
const { addAudit } = require('../audit');
const engine = require('../engine');

function jobView(job) {
  const d = getDb();
  const doc = d.prepare('SELECT id,title,version,kb_name,status FROM documents WHERE id = ?').get(job.document_id);
  return { ...job, docTitle: doc ? doc.title : '—', docVersion: doc ? doc.version : '', docStatus: doc ? doc.status : '', kbName: doc ? doc.kb_name : '' };
}

function register(router) {
  router.get('/api/jobs', async (ctx) => {
    const d = getDb();
    const env = ctx.query.get('env') || '';
    const status = ctx.query.get('status') || '';
    const q = (ctx.query.get('q') || '').toLowerCase();
    // 懒刷新：处理中且有 Dify 文档 ID 的任务，最多刷新 5 个
    const processing = d.prepare("SELECT * FROM jobs WHERE status='处理中' AND dify_document_id IS NOT NULL LIMIT 5").all();
    for (const job of processing) { try { await engine.refreshJob(job.id); } catch (e) { /* ignore */ } }
    let rows = d.prepare('SELECT * FROM jobs ORDER BY created_at DESC').all().map(jobView);
    if (env) rows = rows.filter(r => r.environment === env);
    if (status) rows = rows.filter(r => r.status === status);
    if (q) rows = rows.filter(r => (r.id + ' ' + r.docTitle).toLowerCase().includes(q));
    return { jobs: rows };
  });

  router.post('/api/jobs/:id/refresh', async (ctx) => {
    const job = getDb().prepare('SELECT * FROM jobs WHERE id = ?').get(ctx.params.id);
    if (!job) throw Object.assign(new Error('任务不存在'), { status: 404 });
    await engine.refreshJob(job.id);
    return { job: jobView(getDb().prepare('SELECT * FROM jobs WHERE id = ?').get(job.id)) };
  });

  router.post('/api/jobs/:id/push', async (ctx) => {
    requirePermission(ctx.user, 'job.write');
    const result = await engine.pushJob(ctx.params.id);
    addAudit(ctx.user, '推送RAG API ' + ctx.params.id);
    return { result, job: jobView(getDb().prepare('SELECT * FROM jobs WHERE id = ?').get(ctx.params.id)) };
  });

  router.post('/api/jobs/:id/retry', async (ctx) => {
    requirePermission(ctx.user, 'job.write');
    const d = getDb();
    const job = d.prepare('SELECT * FROM jobs WHERE id = ?').get(ctx.params.id);
    if (!job) throw Object.assign(new Error('任务不存在'), { status: 404 });
    if (!['失败', '待推送'].includes(job.status)) throw Object.assign(new Error('只有失败或待推送任务可以重试'), { status: 400 });
    d.prepare("UPDATE jobs SET status='待推送', step='等待重新推送', progress=0, error=NULL, dify_document_id=NULL WHERE id=?").run(job.id);
    const result = await engine.pushJob(job.id);
    addAudit(ctx.user, '重试入库任务 ' + job.id);
    return { result, job: jobView(d.prepare('SELECT * FROM jobs WHERE id = ?').get(job.id)) };
  });

  router.get('/api/jobs/:id/processing', (ctx) => {
    const d = getDb();
    const job = d.prepare('SELECT * FROM jobs WHERE id = ?').get(ctx.params.id);
    if (!job) throw Object.assign(new Error('任务不存在'), { status: 404 });
    const segments = engine.getSegments(job.id);
    return { job: jobView(job), segments, engine: (job.dify_document_id ? 'dify' : 'local') };
  });

  router.post('/api/jobs/:id/accept', (ctx) => {
    requirePermission(ctx.user, 'processing.accept');
    const d = getDb();
    const job = d.prepare('SELECT * FROM jobs WHERE id = ?').get(ctx.params.id);
    if (!job) throw Object.assign(new Error('任务不存在'), { status: 404 });
    if (job.status !== '待验收') throw Object.assign(new Error('当前任务不在待验收状态'), { status: 400 });
    const checks = (ctx.body && ctx.body.checks) || [];
    if (!Array.isArray(checks) || checks.length !== 5 || checks.some(v => !v)) {
      throw Object.assign(new Error('请先完成5项验收检查'), { status: 400 });
    }
    d.prepare("UPDATE jobs SET status='已验收', step='验收通过', accepted_at=? WHERE id=?").run(now(), job.id);
    d.prepare("UPDATE documents SET status='待检索验证', updated_at=? WHERE id=?").run(now(), job.document_id);
    addAudit(ctx.user, '验收RAG处理结果 ' + job.id);
    return { job: jobView(d.prepare('SELECT * FROM jobs WHERE id = ?').get(job.id)) };
  });

  router.post('/api/jobs/:id/reject', (ctx) => {
    requirePermission(ctx.user, 'processing.accept');
    const d = getDb();
    const job = d.prepare('SELECT * FROM jobs WHERE id = ?').get(ctx.params.id);
    if (!job) throw Object.assign(new Error('任务不存在'), { status: 404 });
    if (!['待验收', '已验收'].includes(job.status)) throw Object.assign(new Error('当前任务不能退回'), { status: 400 });
    d.prepare("UPDATE jobs SET status='待推送', step='等待重新推送', progress=0, returned_at=NULL, dify_document_id=NULL WHERE id=?").run(job.id);
    d.prepare("UPDATE documents SET status='测试入库中', updated_at=? WHERE id=?").run(now(), job.document_id);
    addAudit(ctx.user, '退回RAG处理结果 ' + job.id);
    return { job: jobView(d.prepare('SELECT * FROM jobs WHERE id = ?').get(job.id)) };
  });
}

module.exports = { register, jobView };
