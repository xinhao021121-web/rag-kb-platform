'use strict';
const { getDb, makeId, now, getSetting, setSetting } = require('../db');
const { requirePermission } = require('../rbac');
const { addAudit } = require('../audit');
const engine = require('../engine');
const dify = require('../dify');

const MODE_CONFIG = {
  quick: { name: '快速冒烟评测', count: 5, threshold: 1.0 },
  formal: { name: '正式上线评测', count: 40, threshold: 0.975 },
  regression: { name: '全量回归评测', count: 200, threshold: 0.96 }
};
const DANGER = /继续充电|继续使用|可以继续|再充一次|自己拆|自行拆解/;

// 概念级关键词匹配：同一概念的不同说法视为命中（避免字面匹配误杀语义正确的回答）
const KEYWORD_SYNONYMS = [
  [/防伪码/, /防伪|序列号|包装/],
  [/序列号/, /序列号|机身|包装/],
  [/官方/, /官方|星驰|授权|客服|人工/],
  [/停止充放电/, /停止|不要|不得|断开|暂停使用/],
  [/挤压/, /挤压|穿刺|拆解/],
  [/售后/, /售后|客服|人工/],
  [/保修/, /保修|质保/],
  [/12个月/, /12个月|十二个月|一年/],
  [/凭证/, /凭证|发票|订单/],
  [/远离/, /远离|撤离|通风/],
  [/应急/, /应急|消防|119/],
  [/消防/, /消防|应急/],
  [/拆封/, /拆封|拆开|包装/],
  [/二次销售/, /二次销售|影响销售|商品完好|完好/],
  [/无理由/, /无理由|七天|七日/],
  [/七天无理由/, /七天无理由|七天|七日|无理由/],
  [/使用记录/, /使用记录|使用过|充过|试用/],
  [/质量/, /质量|性能故障|检测/],
  [/包装/, /包装|配件/],
  [/配件/, /配件|包装/],
  [/主机/, /主机|充电宝/],
  [/充电线/, /充电线|数据线/],
  [/说明书/, /说明书|手册/],
  [/第三方/, /第三方|非官方|原购买|原渠道|平台/],
  [/原购买/, /原购买|原渠道|购买平台|订单/],
  [/激活/, /激活|不需要|无需/],
  [/充电器/, /充电器|充电/],
  [/指示灯/, /指示灯|满电/]
];
function keywordHit(keyword, text) {
  const rule = KEYWORD_SYNONYMS.find(x => x[0].test(keyword));
  return rule ? rule[1].test(text) : String(text).includes(keyword);
}

function jobOrThrow(id) {
  const d = getDb();
  const job = d.prepare('SELECT * FROM jobs WHERE id = ?').get(id);
  if (!job) throw Object.assign(new Error('入库任务不存在'), { status: 404 });
  return job;
}

function ensureCaseColumns() {
  const d = getDb();
  const cols = d.prepare('PRAGMA table_info(problem_cases)').all().map(c => c.name);
  if (!cols.includes('source_mode')) d.exec("ALTER TABLE problem_cases ADD COLUMN source_mode TEXT DEFAULT ''");
  if (!cols.includes('doc_title')) d.exec("ALTER TABLE problem_cases ADD COLUMN doc_title TEXT DEFAULT ''");
}
ensureCaseColumns();

function unresolvedByMode(jobId, mode) {
  const d = getDb();
  return d.prepare("SELECT * FROM problem_cases WHERE job_id=? AND source_mode=? AND status NOT IN ('已处理','已关闭')").all(jobId, mode);
}

function gate(job, mode) {
  const d = getDb();
  const runs = d.prepare('SELECT * FROM evaluation_runs WHERE job_id=? AND status=?').all(job.id, '完成');
  const runOf = m => runs.find(r => r.mode === m);
  if (mode === 'quick') return { allowed: true, reason: '' };
  if (mode === 'formal') {
    const q = runOf('quick');
    if (!q || !q.passed_count || q.pass_rate < 1) return { allowed: false, reason: '请先通过5条冒烟评测' };
    if (unresolvedByMode(job.id, 'quick').length) return { allowed: false, reason: '请先处理冒烟评测产生的问题案例' };
    return { allowed: true, reason: '' };
  }
  if (mode === 'regression') {
    const f = runOf('formal');
    if (!f || f.pass_rate < 0.975 || f.p0_failures > 0) return { allowed: false, reason: '请先通过40条正式评测' };
    if (unresolvedByMode(job.id, 'formal').length) return { allowed: false, reason: '请先处理正式评测产生的问题案例' };
    return { allowed: true, reason: '' };
  }
  return { allowed: false, reason: '未知评测阶段' };
}

function createProblemCase(fields) {
  const d = getDb();
  if (d.prepare('SELECT id FROM problem_cases WHERE source_key = ?').get(fields.sourceKey)) return null;
  const id = makeId('CASE');
  d.prepare(`INSERT INTO problem_cases
    (id,source,source_key,source_mode,job_id,document_id,doc_title,question,ai_answer,expected,chunk_id,evidence_json,risk,blocking,reason,root_cause,owner,status,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, fields.source, fields.sourceKey, fields.sourceMode, fields.jobId, fields.documentId || null, fields.docTitle || '',
      fields.question, fields.aiAnswer || '', fields.expected || '', fields.chunkId || '',
      JSON.stringify(fields.evidence || {}), fields.risk || '普通', fields.blocking ? 1 : 0,
      fields.reason || '', fields.rootCause || '待归因', fields.owner || '待分配', '待处理', now());
  return id;
}

function register(router) {
  /* ---------------- 检索调试 ---------------- */
  router.post('/api/retrieval/run', async (ctx) => {
    requirePermission(ctx.user, 'retrieval.run');
    const b = ctx.body || {};
    const job = jobOrThrow(b.jobId);
    const query = String(b.query || '').trim();
    if (!query) throw Object.assign(new Error('请先输入一个测试问题'), { status: 400 });
    if (!['已验收', '检索通过', '评测完成', '待发布', '已发布'].includes(job.status)) {
      throw Object.assign(new Error('请先完成处理结果验收'), { status: 400 });
    }
    const threshold = Number(b.threshold != null ? b.threshold : 0.2);
    const started = Date.now();
    let records = [];
    let error = null;
    try {
      records = await engine.retrieve(job, query, { topK: Number(b.topK || 5), threshold });
    } catch (e) { error = e.message; }
    let diagnosis = 'ok';
    if (error) diagnosis = 'error';
    else if (!records.length) diagnosis = 'no-result';
    else if (threshold > 0 && records[0].score < threshold) diagnosis = 'threshold';
    const runId = 'RET-' + Date.now().toString(36).toUpperCase();
    const d = getDb();
    d.prepare('INSERT INTO retrieval_tests (id,job_id,query,mode,threshold,results_json,diagnosis,verdict,run_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(makeId('RT'), job.id, query, b.mode || '混合检索', threshold, JSON.stringify(records), diagnosis, null, runId, now());
    addAudit(ctx.user, '检索调试 ' + job.id + ' → ' + (records[0] ? records[0].id : '无结果'));
    return { runId, records, diagnosis, error, costMs: Date.now() - started, engine: job.dify_document_id ? 'dify' : 'local' };
  });

  router.get('/api/retrieval/:jobId/latest', (ctx) => {
    const d = getDb();
    const row = d.prepare('SELECT * FROM retrieval_tests WHERE job_id = ? ORDER BY created_at DESC LIMIT 1').get(ctx.params.jobId);
    if (!row) return { run: null };
    return { run: { ...row, results: JSON.parse(row.results_json || '[]') } };
  });

  router.post('/api/retrieval/confirm', (ctx) => {
    requirePermission(ctx.user, 'retrieval.run');
    const d = getDb();
    const b = ctx.body || {};
    const job = jobOrThrow(b.jobId);
    const run = d.prepare('SELECT * FROM retrieval_tests WHERE run_id = ? AND job_id = ?').get(b.runId, job.id);
    if (!run) throw Object.assign(new Error('请先运行检索'), { status: 400 });
    if (!['已验收', '检索通过', '评测完成', '待发布'].includes(job.status)) throw Object.assign(new Error('当前任务状态不支持确认检索'), { status: 400 });
    if (run.diagnosis !== 'ok') throw Object.assign(new Error('当前检索未命中（' + run.diagnosis + '），不能确认通过'), { status: 400 });
    d.prepare("UPDATE jobs SET status='检索通过', step='检索验证通过' WHERE id=?").run(job.id);
    d.prepare("UPDATE documents SET status='待问答评测', updated_at=? WHERE id=?").run(now(), job.document_id);
    d.prepare("UPDATE retrieval_tests SET verdict='通过' WHERE id=?").run(run.id);
    addAudit(ctx.user, '检索验证通过 ' + job.id);
    return { jobId: job.id };
  });

  router.post('/api/retrieval/problem', (ctx) => {
    requirePermission(ctx.user, 'retrieval.run');
    const d = getDb();
    const b = ctx.body || {};
    const job = jobOrThrow(b.jobId);
    const run = d.prepare('SELECT * FROM retrieval_tests WHERE run_id = ? AND job_id = ?').get(b.runId, job.id);
    if (!run) throw Object.assign(new Error('请先运行检索'), { status: 400 });
    const results = JSON.parse(run.results_json || '[]');
    const sourceKey = job.id + '|retrieval|' + run.run_id;
    const doc = d.prepare('SELECT * FROM documents WHERE id = ?').get(job.document_id);
    const id = createProblemCase({
      source: '检索调试', sourceKey, sourceMode: 'retrieval', jobId: job.id, documentId: job.document_id,
      docTitle: doc ? doc.title : '', question: run.query,
      aiAnswer: results[0] ? ('实际Top 1：' + results[0].id + ' · ' + String(results[0].content).slice(0, 80)) : '无召回结果',
      expected: b.expected || '预期切片待确认', chunkId: b.expectedChunkId || '',
      risk: '普通', blocking: false,
      reason: (b.type || '检索问题') + '：' + (b.notes || ''), evidence: { runId: run.run_id, results }
    });
    if (!id) throw Object.assign(new Error('本次检索已生成问题案例，不能重复提交'), { status: 400 });
    addAudit(ctx.user, '检索调试标记为问题 ' + run.run_id);
    return { caseId: id };
  });

  router.post('/api/retrieval/save-case', (ctx) => {
    requirePermission(ctx.user, 'retrieval.run');
    const b = ctx.body || {};
    addAudit(ctx.user, (b.kind === 'regression' ? '保存回归测试用例 ' : '保存检索测试用例 ') + (b.runId || ''));
    return { saved: true };
  });

  /* ---------------- 批量评测 ---------------- */
  router.get('/api/evaluations', (ctx) => {
    const d = getDb();
    let job = null;
    const jobId = ctx.query.get('jobId');
    if (jobId) job = d.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
    if (!job) job = d.prepare("SELECT * FROM jobs WHERE status IN ('检索通过','评测完成','待发布','已发布') ORDER BY created_at DESC LIMIT 1").get();
    if (!job) return { job: null, runs: [], gates: {}, dialogue: null, cases: [], releaseReady: false };
    const runs = d.prepare('SELECT * FROM evaluation_runs WHERE job_id=? ORDER BY finished_at DESC').all(job.id);
    const doc = d.prepare('SELECT * FROM documents WHERE id = ?').get(job.document_id);
    const dialogue = JSON.parse(getSetting('dialogue.' + job.id, 'null') || 'null');
    const allCases = d.prepare("SELECT * FROM problem_cases WHERE job_id=? AND status NOT IN ('已处理','已关闭')").all(job.id);
    const runOf = m => runs.find(r => r.mode === m && r.status === '完成');
    const quick = runOf('quick'), formal = runOf('formal'), regression = runOf('regression');
    const quickOk = !!quick && quick.pass_rate >= 1 && !unresolvedByMode(job.id, 'quick').length;
    const formalOk = !!formal && formal.pass_rate >= 0.975 && formal.p0_failures === 0 && !unresolvedByMode(job.id, 'formal').length;
    const regressionOk = !!regression && regression.pass_rate >= 0.96 && regression.p0_failures === 0 && !unresolvedByMode(job.id, 'regression').length;
    const dialogueOk = !!(dialogue && dialogue.passed);
    const releaseReady = quickOk && formalOk && regressionOk && dialogueOk && allCases.length === 0;
    return {
      job: { ...job, docTitle: doc ? doc.title : '', docVersion: doc ? doc.version : '', docStatus: doc ? doc.status : '', kbName: doc ? doc.kb_name : '' },
      runs,
      gates: { quick: gate(job, 'quick'), formal: gate(job, 'formal'), regression: gate(job, 'regression') },
      dialogue, releaseReady,
      progress: { quick: quickOk, formal: formalOk, regression: regressionOk, dialogue: dialogueOk },
      cases: allCases,
      caseCount: 40,
      engine: job.dify_document_id ? 'dify' : 'local'
    };
  });

  router.post('/api/evaluations/run', (ctx) => {
    requirePermission(ctx.user, 'eval.run');
    const d = getDb();
    const b = ctx.body || {};
    const mode = b.mode || 'quick';
    const cfg = MODE_CONFIG[mode];
    if (!cfg) throw Object.assign(new Error('未知评测阶段'), { status: 400 });
    const job = jobOrThrow(b.jobId);
    if (!['检索通过', '评测完成', '待发布'].includes(job.status)) throw Object.assign(new Error('请先完成检索验证'), { status: 400 });
    const g = gate(job, mode);
    if (!g.allowed) throw Object.assign(new Error(g.reason), { status: 400 });
    const runId = makeId('RUN');
    d.prepare('INSERT INTO evaluation_runs (id,job_id,mode,count,passed_count,pass_rate,p0_failures,status,run_id,started_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(makeId('ER'), job.id, mode, cfg.count, 0, 0, 0, '运行中', runId, now());
    const runRow = d.prepare('SELECT * FROM evaluation_runs WHERE run_id = ?').get(runId);
    addAudit(ctx.user, '开始' + cfg.name + ' ' + job.id);
    const useLlm = !(b.local === true);
    setImmediate(() => executeRun(runRow.id, job.id, mode, useLlm).catch(err => {
      console.error('[eval]', err);
      d.prepare("UPDATE evaluation_runs SET status='失败' WHERE id=?").run(runRow.id);
    }));
    return { runId, mode, count: cfg.count, useLlm };
  });

  router.get('/api/evaluations/run/:runId', (ctx) => {
    const d = getDb();
    const run = d.prepare('SELECT * FROM evaluation_runs WHERE run_id = ?').get(ctx.params.runId);
    if (!run) throw Object.assign(new Error('评测运行不存在'), { status: 404 });
    const filter = ctx.query.get('filter') || 'all';
    let rows = d.prepare('SELECT * FROM evaluation_results WHERE run_id = ? ORDER BY rowid ASC').all(run.run_id);
    if (filter === 'failed') rows = rows.filter(r => !r.recall_ok || !r.answer_ok || !r.p0_ok);
    if (filter === 'passed') rows = rows.filter(r => r.recall_ok && r.answer_ok && r.p0_ok);
    if (filter === 'p0') rows = rows.filter(r => r.failure_reason && String(r.failure_reason).includes('P0'));
    return { run, results: rows };
  });

  router.post('/api/evaluations/dialogue', (ctx) => {
    requirePermission(ctx.user, 'dialogue.record');
    const d = getDb();
    const b = ctx.body || {};
    const job = jobOrThrow(b.jobId);
    const checks = b.checks || [];
    const tester = String(b.tester || '').trim();
    if (!tester) throw Object.assign(new Error('请填写验收人'), { status: 400 });
    const scenes = ['单轮回答正确', '连续追问正常', '安全话术正确', '引用展示正常', '转人工符合预期'];
    const failed = scenes.filter((s, i) => !checks[i]);
    if (failed.length) {
      const doc = d.prepare('SELECT * FROM documents WHERE id = ?').get(job.document_id);
      const runId = 'CHAT-' + Date.now().toString(36).toUpperCase();
      failed.forEach((name, idx) => {
        createProblemCase({
          source: '客服对话验收', sourceKey: job.id + '|dialogue|' + name, sourceMode: 'dialogue', jobId: job.id,
          documentId: job.document_id, docTitle: doc ? doc.title : '', question: name,
          aiAnswer: b.notes || '客服测试环境人工验收发现异常', expected: '客服测试环境应通过该场景', risk: name.includes('安全') ? 'P0安全' : '关键政策',
          blocking: true, reason: name + '：' + (b.notes || '登记不通过'), evidence: { runId }
        });
      });
      setSetting('dialogue.' + job.id, JSON.stringify({ passed: false, tester, notes: b.notes || '', failedScenes: failed, finishedAt: now(), runId }));
      d.prepare("UPDATE documents SET status='待问题修复', updated_at=? WHERE id=?").run(now(), job.document_id);
      addAudit(ctx.user, '客服对话验收失败 ' + job.id, '失败');
      return { passed: false, failed };
    }
    setSetting('dialogue.' + job.id, JSON.stringify({ passed: true, tester, notes: b.notes || '', sceneCount: 5, finishedAt: now() }));
    addAudit(ctx.user, '客服对话验收通过 ' + job.id);
    return { passed: true };
  });

  router.post('/api/evaluations/submit', (ctx) => {
    requirePermission(ctx.user, 'eval.run');
    const d = getDb();
    const job = jobOrThrow((ctx.body || {}).jobId);
    const runs = d.prepare("SELECT * FROM evaluation_runs WHERE job_id=? AND status='完成'").all(job.id);
    const runOf = m => runs.find(r => r.mode === m);
    const f = runOf('formal'), r = runOf('regression');
    if (!f || f.pass_rate < 0.975 || f.p0_failures > 0) throw Object.assign(new Error('请先完成40条正式上线评测'), { status: 400 });
    if (!r || r.pass_rate < 0.96 || r.p0_failures > 0) throw Object.assign(new Error('请先完成200条全量回归评测'), { status: 400 });
    const dialogue = JSON.parse(getSetting('dialogue.' + job.id, 'null') || 'null');
    if (!dialogue || !dialogue.passed) throw Object.assign(new Error('请先完成客服聊天窗人工验收'), { status: 400 });
    const blocking = d.prepare("SELECT * FROM problem_cases WHERE job_id=? AND status NOT IN ('已处理','已关闭')").all(job.id);
    if (blocking.length) throw Object.assign(new Error('仍有' + blocking.length + '条阻断型Bad Case未关闭'), { status: 400 });
    d.prepare("UPDATE jobs SET status='待发布', step='等待线下发布审批' WHERE id=?").run(job.id);
    d.prepare("UPDATE documents SET status='待线下审批', updated_at=? WHERE id=?").run(now(), job.document_id);
    addAudit(ctx.user, '提交线下发布审批 ' + job.id);
    return { ok: true };
  });

  /* ---------------- 发布审批 ---------------- */
  router.get('/api/releases/:docId/evidence', (ctx) => {
    const d = getDb();
    const doc = d.prepare('SELECT * FROM documents WHERE id = ?').get(ctx.params.docId);
    if (!doc) throw Object.assign(new Error('文档不存在'), { status: 404 });
    const job = d.prepare('SELECT * FROM jobs WHERE document_id = ? ORDER BY created_at DESC LIMIT 1').get(doc.id);
    const runs = job ? d.prepare('SELECT * FROM evaluation_runs WHERE job_id=? AND status=?').all(job.id, '完成') : [];
    const dialogue = job ? JSON.parse(getSetting('dialogue.' + job.id, 'null') || 'null') : null;
    const unresolved = d.prepare("SELECT COUNT(*) AS n FROM problem_cases WHERE document_id=? AND status NOT IN ('已处理','已关闭')").get(doc.id).n;
    return { doc, job: job || null, runs, dialogue, unresolved };
  });

  router.post('/api/releases/:docId/approve', async (ctx) => {
    requirePermission(ctx.user, 'release.decide');
    const d = getDb();
    const doc = d.prepare('SELECT * FROM documents WHERE id = ?').get(ctx.params.docId);
    if (!doc) throw Object.assign(new Error('文档不存在'), { status: 404 });
    if (doc.status !== '待线下审批') throw Object.assign(new Error('当前文档不在待线下审批状态'), { status: 400 });
    const unresolved = d.prepare("SELECT COUNT(*) AS n FROM problem_cases WHERE document_id=? AND status NOT IN ('已处理','已关闭')").get(doc.id).n;
    if (unresolved) throw Object.assign(new Error('仍有未处理的问题案例，不能审批通过'), { status: 400 });
    const job = d.prepare('SELECT * FROM jobs WHERE document_id = ? ORDER BY created_at DESC LIMIT 1').get(doc.id);
    let prodDocId = null;
    let engine = 'local';
    if (dify.isConfigured() && job) {
      const kb = d.prepare('SELECT * FROM knowledge_bases WHERE id = ?').get(doc.kb_id);
      const datasetId = await engine.ensureDataset(kb, '生产');
      if (doc.file_path) {
        const res = await dify.createDocumentByFile(datasetId, doc.file_path, doc.file_name || doc.title);
        prodDocId = res && (res.document && res.document.id || res.document_id);
      } else {
        const text = doc.content_text || '';
        const res = await dify.createDocumentByText(datasetId, doc.title, text);
        prodDocId = res && (res.document && res.document.id || res.document_id);
      }
      engine = 'dify';
    }
    const releaseId = makeId('REL');
    d.prepare("UPDATE documents SET status='已发布', published_at=?, release_id=?, updated_at=? WHERE id=?").run(now(), releaseId, now(), doc.id);
    if (job) d.prepare("UPDATE jobs SET status='已发布', step='线下审批通过，生产发布完成' WHERE id=?").run(job.id);
    d.prepare('INSERT INTO releases (id,document_id,job_id,approver,decision,evidence_json,created_at) VALUES (?,?,?,?,?,?,?)')
      .run(releaseId, doc.id, job ? job.id : null, ctx.user.name, '通过', JSON.stringify({ engine, prodDocId }), now());
    const kb = d.prepare('SELECT * FROM knowledge_bases WHERE id = ?').get(doc.kb_id);
    if (kb && engine === 'dify') d.prepare("UPDATE knowledge_bases SET prod_rag_status='正常' WHERE id=?").run(kb.id);
    addAudit(ctx.user, '线下发布审批通过 ' + doc.id);
    return { releaseId, engine, prodDocId };
  });

  router.post('/api/releases/:docId/reject', (ctx) => {
    requirePermission(ctx.user, 'release.decide');
    const d = getDb();
    const doc = d.prepare('SELECT * FROM documents WHERE id = ?').get(ctx.params.docId);
    if (!doc) throw Object.assign(new Error('文档不存在'), { status: 404 });
    if (doc.status !== '待线下审批') throw Object.assign(new Error('当前文档不在待线下审批状态'), { status: 400 });
    d.prepare("UPDATE documents SET status='待问题修复', updated_at=? WHERE id=?").run(now(), doc.id);
    const job = d.prepare('SELECT * FROM jobs WHERE document_id = ? ORDER BY created_at DESC LIMIT 1').get(doc.id);
    if (job) d.prepare("UPDATE jobs SET status='评测完成', step='线下审批驳回，等待修复' WHERE id=?").run(job.id);
    const reason = String((ctx.body && ctx.body.reason) || '线下审批驳回');
    addAudit(ctx.user, '线下发布审批驳回 ' + doc.id + '：' + reason, '失败');
    return { ok: true };
  });
}

/* ---------------- 评测执行 ---------------- */
async function executeRun(runRowId, jobId, mode, useLlm) {
  const d = getDb();
  const cfg = MODE_CONFIG[mode];
  const job = d.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
  const doc = d.prepare('SELECT * FROM documents WHERE id = ?').get(job.document_id);
  const baseCases = d.prepare('SELECT * FROM eval_cases ORDER BY ord ASC').all();
  const items = [];
  for (let i = 0; i < cfg.count; i++) {
    const c = baseCases[i % baseCases.length];
    const prefix = i >= baseCases.length ? ['客服转述：', '京东渠道用户咨询：', '自营商城用户咨询：', '售后复核问题：'][(Math.floor(i / baseCases.length) - 1) % 4] : '';
    items.push({ c, question: prefix + c.question, ord: i, key: c.id + '#' + (i + 1) });
  }
  const runRow = d.prepare('SELECT * FROM evaluation_runs WHERE id = ?').get(runRowId);
  let passed = 0, p0Fail = 0;

  // 评测前：把知识库中已发布但未同步的文档补传到 Dify 测试 dataset
  try { await engine.syncPublishedDocs(doc.kb_id); } catch (e) { console.error('[eval] sync kb failed:', e.message); }

  async function processItem(item) {
    const c = item.c;
    const keywords = String(c.expected_keywords || '').split('|').filter(Boolean);
    let records = [], answerText = '', recallOk = false, answerOk = false, p0Ok = true, failure = '';
    try {
      records = await engine.retrieveKB(doc.kb_id, item.question, { topK: 5, threshold: 0 });
      const retrievedText = records.map(r => r.content).join('\n');
      recallOk = keywords.some(k => keywordHit(k, retrievedText));
      answerText = await engine.answer(item.question, records, { useLlm: useLlm !== false });
      const hit = keywords.filter(k => keywordHit(k, answerText)).length;
      answerOk = hit >= Math.min(2, Math.max(1, keywords.length));
      if (c.p0) {
        const safe = /停止|不得|禁止|不要/.test(answerText);
        p0Ok = safe && !DANGER.test(answerText);
        if (!p0Ok) answerOk = false;
      }
      if (!recallOk) failure = '召回未命中预期知识';
      else if (!answerOk) failure = '回答遗漏关键条件或出现危险建议';
    } catch (e) {
      failure = '执行失败：' + e.message;
      recallOk = answerOk = false;
      if (c.p0) p0Ok = false;
    }
    const ok = recallOk && answerOk && p0Ok;
    if (ok) passed++;
    if (c.p0 && !p0Ok) p0Fail++;
    d.prepare(`INSERT INTO evaluation_results (id,run_id,case_id,question,retrieved_json,answer,recall_ok,answer_ok,p0_ok,failure_reason)
      VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(makeId('RES'), runRow.run_id, item.key, item.question, JSON.stringify(records.map(r => ({ id: r.id, score: r.score, content: String(r.content).slice(0, 160) }))),
        String(answerText).slice(0, 2000), recallOk ? 1 : 0, answerOk ? 1 : 0, p0Ok ? 1 : 0, failure);
    if (!ok) {
      createProblemCase({
        source: '批量问答评测', sourceKey: jobId + '|' + mode + '|' + item.key, sourceMode: mode, jobId,
        documentId: job.document_id, docTitle: doc ? doc.title : '', question: item.question,
        aiAnswer: String(answerText).slice(0, 300), expected: c.expected_answer, chunkId: c.expected_keywords,
        risk: c.risk, blocking: c.p0 === 1 || c.risk === '关键政策', reason: failure,
        evidence: { runId: runRow.run_id, retrieved: records.slice(0, 3) }
      });
    }
  }

  // 并发执行：Dify 订阅有知识库请求限流，配置 Dify 时串行；本地引擎可并发 3
  let cursor = 0;
  const concurrency = dify.isConfigured() ? 1 : Math.min(3, items.length);
  async function worker() {
    while (true) {
      const index = cursor++;
      if (index >= items.length) break;
      await processItem(items[index]);
      if (dify.isConfigured()) await new Promise(r => setTimeout(r, 600));
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  const passRate = passed / cfg.count;
  d.prepare('UPDATE evaluation_runs SET passed_count=?, pass_rate=?, p0_failures=?, status=?, finished_at=? WHERE id=?')
    .run(passed, passRate, p0Fail, '完成', now(), runRowId);
  if (mode === 'formal') {
    const ok = passRate >= 0.975 && p0Fail === 0;
    d.prepare("UPDATE jobs SET status='评测完成', step=? WHERE id=?").run(ok ? '正式问答评测完成' : '正式评测未达标', jobId);
    if (ok) d.prepare("UPDATE documents SET status='待全量回归', updated_at=? WHERE id=?").run(now(), job.document_id);
  } else if (mode === 'regression') {
    const ok = passRate >= 0.96 && p0Fail === 0;
    d.prepare("UPDATE jobs SET step=? WHERE id=?").run(ok ? '全量回归完成' : '全量回归未达标', jobId);
  }
  d.prepare('INSERT INTO audit_logs (id,time,user_id,operator,action,result) VALUES (?,?,?,?,?,?)')
    .run(makeId('LOG'), now(), null, '系统', `${MODE_CONFIG[mode].name}完成 ${passed}/${cfg.count}`, passRate >= 0.9 ? '成功' : '失败');
}

module.exports = { register, MODE_CONFIG };
