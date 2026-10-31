'use strict';
const { getDb, makeId, now, hashPassword, resetDemoData, getSetting, setSetting } = require('../db');
const { requirePermission, ROLE_NAMES } = require('../rbac');
const { addAudit } = require('../audit');
const dify = require('../dify');

const SOURCE_CATEGORIES = ['A 文档类权威知识', 'B 结构化FAQ', 'C 样本与反馈', 'D 实时业务数据'];

function register(router) {
  /* ---------------- 数据源 ---------------- */
  router.get('/api/sources', () => {
    const d = getDb();
    return { sources: d.prepare('SELECT * FROM data_sources ORDER BY created_at ASC').all() };
  });

  router.post('/api/sources', (ctx) => {
    requirePermission(ctx.user, 'source.sync');
    const b = ctx.body || {};
    if (!String(b.name || '').trim()) throw Object.assign(new Error('请填写数据源名称'), { status: 400 });
    const d = getDb();
    const id = makeId('SRC');
    d.prepare('INSERT INTO data_sources (id,name,category,method,frequency,endpoint,status,owner,last_result,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(id, String(b.name).trim(), SOURCE_CATEGORIES.includes(b.category) ? b.category : SOURCE_CATEGORIES[0], b.method || 'REST API', b.frequency || '每天', b.endpoint || '', '正常', b.owner || ctx.user.name, '尚未同步', now());
    addAudit(ctx.user, '新建数据源：' + b.name);
    return { id };
  });

  router.post('/api/sources/:id/config', (ctx) => {
    requirePermission(ctx.user, 'source.sync');
    const d = getDb();
    const src = d.prepare('SELECT * FROM data_sources WHERE id = ?').get(ctx.params.id);
    if (!src) throw Object.assign(new Error('数据源不存在'), { status: 404 });
    const b = ctx.body || {};
    d.prepare('UPDATE data_sources SET name=?, category=?, method=?, frequency=?, endpoint=? WHERE id=?')
      .run(b.name || src.name, b.category || src.category, b.method || src.method, b.frequency || src.frequency, b.endpoint || src.endpoint, src.id);
    addAudit(ctx.user, '更新数据源配置：' + (b.name || src.name));
    return { ok: true };
  });

  router.post('/api/sources/:id/sync', (ctx) => {
    requirePermission(ctx.user, 'source.sync');
    const d = getDb();
    const src = d.prepare('SELECT * FROM data_sources WHERE id = ?').get(ctx.params.id);
    if (!src) throw Object.assign(new Error('数据源不存在'), { status: 404 });
    const cat = String(src.category || '').charAt(0);
    const kbs = d.prepare("SELECT * FROM knowledge_bases WHERE status != '已归档'").all();
    const kb = kbs[0];
    let created = 0, resultText = '';
    const makeDraft = (title, content, prefix) => {
      if (!kb) return;
      created++;
      const id = makeId('DOC');
      d.prepare(`INSERT INTO documents (id,kb_id,kb_name,title,file_name,file_path,extension,type,channel,owner,version,validity,status,content_text,source_id,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(id, kb.id, kb.name, (prefix || '') + title, src.name + '-增量.docx', null, 'DOCX', cat === 'B' ? 'FAQ' : '政策/SOP', '全渠道', ctx.user.name, 'v0.1', '待补充', '草稿', content || '数据源同步生成的草稿，需人工确认后提交业务审核。', src.id, now(), now());
      d.prepare('INSERT INTO document_versions (id,document_id,version,note,status,author,created_at) VALUES (?,?,?,?,?,?,?)')
        .run(makeId('VER'), id, 'v0.1', '数据源同步生成', '草稿', ctx.user.name, now());
    };
    if (cat === 'A' || cat === 'B') {
      makeDraft(src.name + '增量草稿 A', '由数据源同步的政策条目，需人工核对适用范围与有效期。');
      makeDraft(src.name + '增量草稿 B', '由数据源同步的常见问题条目，需人工核对标准答案。');
      resultText = '新增2 · 更新0 · 已生成2份草稿';
    } else if (cat === 'C') {
      makeDraft(src.name + '样本草稿', '历史工单样本，需先脱敏并由人工确认后才能转为FAQ。', '[待确认] ');
      resultText = '980成功 · 20条脱敏失败 · 已生成待确认草稿';
    } else {
      resultText = '仅运行时调用 · 不写入向量索引';
    }
    const status = cat === 'C' ? '部分失败' : '正常';
    d.prepare('UPDATE data_sources SET status=?, last_result=? WHERE id=?').run(status, resultText, src.id);
    addAudit(ctx.user, '同步数据源 ' + src.name);
    return { created, resultText, category: src.category };
  });

  router.post('/api/sources/:id/retry', (ctx) => {
    requirePermission(ctx.user, 'source.sync');
    const d = getDb();
    const src = d.prepare('SELECT * FROM data_sources WHERE id = ?').get(ctx.params.id);
    if (!src) throw Object.assign(new Error('数据源不存在'), { status: 404 });
    d.prepare("UPDATE data_sources SET status='正常', last_result=? WHERE id=?").run('1000成功 · 0失败', src.id);
    addAudit(ctx.user, '重试数据源失败批次 ' + src.name);
    return { ok: true };
  });

  router.post('/api/sources/:id/resume', (ctx) => {
    requirePermission(ctx.user, 'source.sync');
    const d = getDb();
    const src = d.prepare('SELECT * FROM data_sources WHERE id = ?').get(ctx.params.id);
    if (!src) throw Object.assign(new Error('数据源不存在'), { status: 404 });
    d.prepare("UPDATE data_sources SET status='正常', last_result=? WHERE id=?").run('已恢复，将从最近成功游标继续', src.id);
    addAudit(ctx.user, '恢复数据源 ' + src.name);
    return { ok: true };
  });

  /* ---------------- 成员与密钥 ---------------- */
  router.get('/api/members', (ctx) => {
    const d = getDb();
    return { members: d.prepare('SELECT id,name,username,role,domain,status,created_at FROM users ORDER BY created_at ASC').all() };
  });

  router.post('/api/members', (ctx) => {
    requirePermission(ctx.user, 'member.manage');
    const b = ctx.body || {};
    const name = String(b.name || '').trim();
    if (!name) throw Object.assign(new Error('请填写成员名称'), { status: 400 });
    const roleMap = { '知识运营': 'operator', '业务审核人': 'reviewer', '产品经理': 'tester', 'AI产品经理': 'tester', '发布审批人': 'approver', '系统管理员': 'admin' };
    const role = roleMap[b.role] || b.role || 'operator';
    if (!ROLE_NAMES[role]) throw Object.assign(new Error('未知角色'), { status: 400 });
    const username = String(b.username || name).trim().toLowerCase().replace(/\s+/g, '.');
    const d = getDb();
    if (d.prepare('SELECT id FROM users WHERE username = ?').get(username)) throw Object.assign(new Error('用户名已存在'), { status: 400 });
    d.prepare('INSERT INTO users (id,name,username,password_hash,role,domain,status,created_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(makeId('U'), name, username, hashPassword('demo1234'), role, b.domain || '售后', '启用', now());
    addAudit(ctx.user, '添加成员：' + name);
    return { username, password: 'demo1234' };
  });

  router.get('/api/keys', () => {
    const d = getDb();
    return { keys: d.prepare('SELECT id,env,name,mask,scope,created_at FROM api_keys ORDER BY env ASC').all() };
  });

  router.post('/api/keys/:env/regenerate', (ctx) => {
    requirePermission(ctx.user, 'key.manage');
    const d = getDb();
    const env = ctx.params.env === 'prod' || ctx.params.env === '生产' ? '生产' : '测试';
    const prefix = env === '生产' ? 'rag-prod-' : 'rag-test-';
    const mask = prefix + '••••••••' + Math.random().toString(36).slice(2, 6);
    const row = d.prepare('SELECT * FROM api_keys WHERE env = ?').get(env);
    if (row) d.prepare('UPDATE api_keys SET mask=?, created_at=? WHERE id=?').run(mask, now(), row.id);
    else d.prepare('INSERT INTO api_keys (id,env,name,mask,scope,created_at) VALUES (?,?,?,?,?,?)').run(makeId('KEY'), env, env + '环境密钥', mask, 'dataset 读写', now());
    addAudit(ctx.user, '重新生成' + env + '环境API密钥');
    return { mask };
  });

  router.get('/api/audit', (ctx) => {
    const d = getDb();
    const rows = d.prepare('SELECT * FROM audit_logs ORDER BY time DESC LIMIT 100').all();
    return { logs: rows };
  });

  /* ---------------- 问题案例 ---------------- */
  router.get('/api/cases', (ctx) => {
    const d = getDb();
    const jobId = ctx.query.get('jobId') || '';
    const source = ctx.query.get('source') || '';
    let rows = d.prepare('SELECT * FROM problem_cases ORDER BY created_at DESC').all();
    if (jobId) rows = rows.filter(x => x.job_id === jobId);
    if (source) rows = rows.filter(x => x.source_mode === source || x.source === source);
    return { cases: rows };
  });

  router.get('/api/cases/:id', (ctx) => {
    const d = getDb();
    const row = d.prepare('SELECT * FROM problem_cases WHERE id = ?').get(ctx.params.id);
    if (!row) throw Object.assign(new Error('问题案例不存在'), { status: 404 });
    let evidence = null;
    try { evidence = JSON.parse(row.evidence_json || 'null'); } catch (e) { evidence = null; }
    return { case: row, evidence };
  });

  router.post('/api/cases/:id/process', (ctx) => {
    requirePermission(ctx.user, 'case.process');
    const d = getDb();
    const row = d.prepare('SELECT * FROM problem_cases WHERE id = ?').get(ctx.params.id);
    if (!row) throw Object.assign(new Error('问题案例不存在'), { status: 404 });
    if (row.status === '已处理') return { ok: true };
    d.prepare("UPDATE problem_cases SET status='已处理', blocking=0, processed_at=? WHERE id=?").run(now(), row.id);
    addAudit(ctx.user, '问题案例已处理 ' + row.id);
    return { ok: true };
  });

  /* ---------------- 运营统计 ---------------- */
  router.get('/api/analytics', () => {
    const d = getDb();
    const docs = d.prepare('SELECT * FROM documents').all();
    const jobs = d.prepare('SELECT * FROM jobs').all();
    const cases = d.prepare('SELECT * FROM problem_cases').all();
    const runs = d.prepare("SELECT * FROM evaluation_runs WHERE status='完成'").all();
    const formalRuns = runs.filter(r => r.mode === 'formal');
    const lastFormal = formalRuns.sort((a, b) => String(b.finished_at).localeCompare(String(a.finished_at)))[0] || null;
    const rootCause = {};
    cases.forEach(c => { const k = c.root_cause || '待归因'; rootCause[k] = (rootCause[k] || 0) + 1; });
    return {
      totals: {
        kbs: d.prepare('SELECT COUNT(*) AS n FROM knowledge_bases').get().n,
        docs: docs.length,
        published: docs.filter(x => x.status === '已发布').length,
        cases: cases.length,
        pendingCases: cases.filter(x => !['已处理', '已关闭'].includes(x.status)).length,
        p0Cases: cases.filter(x => !['已处理', '已关闭'].includes(x.status) && String(x.risk).includes('P0')).length,
        jobs: jobs.length,
        lastFormal
      },
      statusCounts: docs.reduce((acc, x) => { acc[x.status] = (acc[x.status] || 0) + 1; return acc; }, {}),
      rootCause,
      recentRuns: runs.sort((a, b) => String(b.finished_at).localeCompare(String(a.finished_at))).slice(0, 10)
    };
  });

  /* ---------------- 引擎配置 ---------------- */
  router.get('/api/engine-config', () => {
    const c = dify.config();
    return {
      provider: 'Dify',
      baseUrl: c.baseUrl,
      datasetKeyMasked: dify.masked(c.datasetKey),
      completionKeyMasked: dify.masked(c.completionKey),
      configured: dify.isConfigured(),
      completionConfigured: dify.hasCompletion(),
      appUser: c.appUser
    };
  });

  router.put('/api/engine-config', (ctx) => {
    requirePermission(ctx.user, 'config.write');
    const b = ctx.body || {};
    if (b.baseUrl != null) setSetting('dify.baseUrl', String(b.baseUrl).trim());
    if (b.datasetKey) setSetting('dify.datasetKey', String(b.datasetKey).trim());
    if (b.completionKey) setSetting('dify.completionKey', String(b.completionKey).trim());
    if (b.appUser) setSetting('dify.appUser', String(b.appUser).trim());
    addAudit(ctx.user, '更新RAG引擎配置');
    return { ok: true };
  });

  router.post('/api/engine-config/test', async (ctx) => {
    requirePermission(ctx.user, 'config.write');
    try {
      const r = await dify.testConnection();
      addAudit(ctx.user, '测试RAG引擎连接');
      return { ok: true, total: r.total };
    } catch (e) {
      addAudit(ctx.user, '测试RAG引擎连接失败：' + e.message, '失败');
      throw Object.assign(new Error('连接失败：' + e.message), { status: 502 });
    }
  });

  /* ---------------- 演示数据重置 ---------------- */
  router.post('/api/admin/reset', (ctx) => {
    requirePermission(ctx.user, 'member.manage');
    resetDemoData();
    ctx.res.setHeader('Set-Cookie', 'sid=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
    return { ok: true };
  });
}

module.exports = { register, SOURCE_CATEGORIES };
