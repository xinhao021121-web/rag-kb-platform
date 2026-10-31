'use strict';
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = path.join(__dirname, '..', 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

let db = null;

function makeId(prefix) {
  return prefix + '-' + Date.now().toString(36).toUpperCase() + '-' + crypto.randomBytes(2).toString('hex').toUpperCase();
}
function now() { return new Date().toISOString(); }
function hashPassword(password, salt) {
  const s = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, s, 64).toString('hex');
  return s + ':' + hash;
}
function verifyPassword(password, stored) {
  const [salt, hash] = String(stored || '').split(':');
  if (!salt || !hash) return false;
  const calc = crypto.scryptSync(password, salt, 64);
  const target = Buffer.from(hash, 'hex');
  return calc.length === target.length && crypto.timingSafeEqual(calc, target);
}

function getDb() {
  if (db) return db;
  db = new DatabaseSync(path.join(DATA_DIR, 'app.db'));
  db.exec(`PRAGMA journal_mode = WAL;`);
  createSchema(db);
  seedIfEmpty(db);
  return db;
}

function createSchema(d) {
  d.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL, role TEXT NOT NULL, domain TEXT, status TEXT DEFAULT '启用', created_at TEXT
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS knowledge_bases (
    id TEXT PRIMARY KEY, name TEXT UNIQUE NOT NULL, domain TEXT, owner TEXT, scope TEXT,
    status TEXT DEFAULT '建设中', description TEXT,
    test_dataset_id TEXT, prod_dataset_id TEXT, test_rag_status TEXT DEFAULT '未接入', prod_rag_status TEXT DEFAULT '未接入',
    created_at TEXT, archived_at TEXT
  );
  CREATE TABLE IF NOT EXISTS documents (
    id TEXT PRIMARY KEY, kb_id TEXT NOT NULL, kb_name TEXT, title TEXT NOT NULL,
    file_name TEXT, file_path TEXT, extension TEXT, type TEXT, channel TEXT, owner TEXT,
    version TEXT, validity TEXT, status TEXT DEFAULT '草稿', content_text TEXT,
    source_id TEXT, reject_reason TEXT, release_id TEXT,
    created_at TEXT, submitted_at TEXT, reviewed_at TEXT, published_at TEXT, updated_at TEXT
  );
  CREATE TABLE IF NOT EXISTS document_versions (
    id TEXT PRIMARY KEY, document_id TEXT NOT NULL, version TEXT, note TEXT,
    status TEXT, author TEXT, created_at TEXT
  );
  CREATE TABLE IF NOT EXISTS reviews (
    id TEXT PRIMARY KEY, document_id TEXT NOT NULL, submitter TEXT, reviewer TEXT,
    confirm_fact INTEGER DEFAULT 0, confirm_scope INTEGER DEFAULT 0, confirm_validity INTEGER DEFAULT 0,
    note TEXT, verdict TEXT, reject_reason TEXT, created_at TEXT, decided_at TEXT
  );
  CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY, document_id TEXT NOT NULL, environment TEXT DEFAULT '测试',
    dataset_id TEXT, dify_document_id TEXT, external_task_id TEXT,
    step TEXT, progress INTEGER DEFAULT 0, status TEXT DEFAULT '待推送', error TEXT,
    character_count INTEGER DEFAULT 0, chunk_count INTEGER DEFAULT 0, vector_count INTEGER DEFAULT 0,
    index_count INTEGER DEFAULT 0, warning_count INTEGER DEFAULT 0,
    created_at TEXT, pushed_at TEXT, returned_at TEXT, accepted_at TEXT
  );
  CREATE TABLE IF NOT EXISTS processing_results (
    id TEXT PRIMARY KEY, job_id TEXT NOT NULL, segments_json TEXT,
    parse_status TEXT, char_count INTEGER, chunk_count INTEGER, vector_count INTEGER,
    index_count INTEGER, warnings INTEGER, created_at TEXT
  );
  CREATE TABLE IF NOT EXISTS retrieval_tests (
    id TEXT PRIMARY KEY, job_id TEXT NOT NULL, query TEXT, mode TEXT, threshold REAL,
    results_json TEXT, diagnosis TEXT, verdict TEXT, run_id TEXT, created_at TEXT
  );
  CREATE TABLE IF NOT EXISTS eval_sets (
    id TEXT PRIMARY KEY, name TEXT, count INTEGER, status TEXT, created_at TEXT
  );
  CREATE TABLE IF NOT EXISTS eval_cases (
    id TEXT PRIMARY KEY, set_id TEXT, question TEXT, expected_keywords TEXT,
    expected_answer TEXT, risk TEXT, p0 INTEGER DEFAULT 0, ord INTEGER
  );
  CREATE TABLE IF NOT EXISTS evaluation_runs (
    id TEXT PRIMARY KEY, job_id TEXT NOT NULL, mode TEXT, count INTEGER,
    passed_count INTEGER, pass_rate REAL, p0_failures INTEGER DEFAULT 0,
    status TEXT, run_id TEXT, started_at TEXT, finished_at TEXT
  );
  CREATE TABLE IF NOT EXISTS evaluation_results (
    id TEXT PRIMARY KEY, run_id TEXT, case_id TEXT, question TEXT,
    retrieved_json TEXT, answer TEXT, recall_ok INTEGER, answer_ok INTEGER,
    p0_ok INTEGER, failure_reason TEXT
  );
  CREATE TABLE IF NOT EXISTS problem_cases (
    id TEXT PRIMARY KEY, source TEXT, source_key TEXT UNIQUE, job_id TEXT, document_id TEXT,
    question TEXT, ai_answer TEXT, expected TEXT, chunk_id TEXT, evidence_json TEXT,
    risk TEXT, blocking INTEGER DEFAULT 0, reason TEXT, root_cause TEXT, owner TEXT,
    status TEXT DEFAULT '待处理', created_at TEXT, processed_at TEXT
  );
  CREATE TABLE IF NOT EXISTS releases (
    id TEXT PRIMARY KEY, document_id TEXT NOT NULL, job_id TEXT, approver TEXT,
    decision TEXT, evidence_json TEXT, created_at TEXT
  );
  CREATE TABLE IF NOT EXISTS data_sources (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, category TEXT, method TEXT, frequency TEXT,
    endpoint TEXT, status TEXT DEFAULT '正常', owner TEXT, last_result TEXT, created_at TEXT
  );
  CREATE TABLE IF NOT EXISTS api_keys (
    id TEXT PRIMARY KEY, env TEXT, name TEXT, mask TEXT, scope TEXT, created_at TEXT
  );
  CREATE TABLE IF NOT EXISTS audit_logs (
    id TEXT PRIMARY KEY, time TEXT, user_id TEXT, operator TEXT, action TEXT, result TEXT
  );
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY, value TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_documents_kb ON documents(kb_id);
  CREATE INDEX IF NOT EXISTS idx_jobs_doc ON jobs(document_id);
  CREATE INDEX IF NOT EXISTS idx_cases_source ON problem_cases(source_key);
  CREATE INDEX IF NOT EXISTS idx_results_run ON evaluation_results(run_id);
  `);
}

/* ---------------- 种子数据 ---------------- */

const FAQ_SECTIONS = [
  { key: 'FAQ-001', title: '如何确认购买的充电宝是正品？', answer: '请优先核对包装防伪码、机身序列号与订单购买渠道。通过官方商城、官方旗舰店或授权经销商购买的产品，可在“官方服务”页面输入序列号查询。若系统提示序列号不存在、已被多次查询，或机身信息与包装不一致，请暂停使用并联系人工客服核验。', keywords: ['防伪码', '序列号', '官方'] },
  { key: 'FAQ-003', title: '充电宝首次使用前需要激活吗？', answer: '普通充电宝不需要联网或账号激活。首次使用前建议使用符合产品说明书要求的充电器，将电量充至指示灯显示满电后再正常使用。如果首次充电超过六小时仍无指示灯变化，请停止充电并联系售后检测。', keywords: ['激活', '充电器', '指示灯'] },
  { key: 'FAQ-004', title: '包装内通常包含哪些物品？', answer: '标准包装通常包含充电宝主机、充电线、使用说明书和电子保修提示卡。不同型号或活动套装可能存在差异，应以商品详情页和订单清单为准。收到商品后如发现配件缺失，请在签收后48小时内拍摄完整开箱照片并联系客服。', keywords: ['主机', '充电线', '说明书'] },
  { key: 'FAQ-006', title: '充电宝支持七天无理由退货吗？', answer: '通过官方直营渠道购买的普通充电宝，在签收次日起七个自然日内，商品、包装和配件完整且不影响二次销售的，可以申请七天无理由退货。定制刻字商品、企业定制商品及页面明确标注不支持无理由退货的商品除外。第三方渠道订单应以原购买平台规则为准。', keywords: ['七天无理由', '包装', '配件'] },
  { key: 'FAQ-007', title: '充电宝拆封后还能无理由退货吗？', answer: '仅拆开外包装但未造成商品损伤、明显使用痕迹或配件缺失，一般仍可提交无理由退货申请，由仓库验收后确认。若保护膜已撕除、接口存在插拔痕迹、机身有划痕，或电池循环记录显示明显使用，可能被认定为影响二次销售。', keywords: ['拆封', '无理由', '二次销售'] },
  { key: 'FAQ-008', title: '已经给手机充过一次电，还能七天无理由退货吗？', answer: '实际为手机充电通常会产生使用记录，原则上不再符合无理由退货条件。如果产品存在性能故障，可改为申请质量问题检测；经检测确认属于产品质量问题的，按照质量售后流程办理退货、换货或维修。', keywords: ['使用记录', '无理由', '质量'] },
  { key: 'FAQ-020', title: '充电宝的保修期是多久？', answer: '该品牌普通充电宝自有效购买凭证所示购买日起享受12个月有限保修。换新机、活动赠品和企业定制产品可能适用不同期限，应以商品页面、合同或售后凭证为准。保修仅覆盖正常使用条件下产生的非人为性能故障。', keywords: ['12个月', '保修', '凭证'] },
  { key: 'FAQ-032', title: '发现充电宝鼓包怎么办？', answer: '鼓包属于高风险异常。请立即停止充放电，不要挤压、穿刺、拆解、摔落或投入生活垃圾，也不要通过普通快递自行寄送。应将产品暂时放置在远离火源和可燃物的安全区域，并联系当地官方售后获取检测或合规回收指引。', keywords: ['停止充放电', '挤压', '售后'] },
  { key: 'FAQ-033', title: '充电宝有异味或冒烟怎么办？', answer: '请优先确保人身安全，立即远离产品并切断周边电源；在确保安全的前提下，将人员撤离至通风区域并联系消防等当地应急机构。不要徒手触碰、泼水、覆盖或继续观察测试。险情解除后再联系官方售后记录产品信息。', keywords: ['远离', '应急', '消防'] },
  { key: 'FAQ-040', title: '在第三方店铺购买的充电宝可以找官方售后吗？', answer: '可以先提供产品序列号、原购买平台订单和故障信息，由官方核验产品来源及保修状态。退货、退款和价格争议通常由原销售渠道处理；属于官方保修范围的性能故障，可根据核验结果安排检测或维修。无法确认来源的产品可能需要进一步鉴定。', keywords: ['序列号', '第三方', '原购买'] }
];

function buildFaqText() {
  const lines = ['某 3C 电商企业 · 充电宝售后服务 FAQ 问答集', '适用范围：全渠道 · 充电宝产品', ''];
  FAQ_SECTIONS.forEach((s, i) => {
    lines.push(`[${s.key}] ${s.title}`);
    lines.push('标准答复：' + s.answer);
    lines.push('');
  });
  return lines.join('\n');
}

const QUESTION_BANK = [
  { topic: 0, q: '怎么确认买到的充电宝是不是正品？' },
  { topic: 0, q: '充电宝序列号在哪里验真？' },
  { topic: 0, q: '防伪码显示查询多次怎么办？' },
  { topic: 0, q: '包装和机身序列号不一致怎么办？' },
  { topic: 0, q: '第三方购买的产品怎样核验真假？' },
  { topic: 3, q: '充电宝支持七天无理由退货吗？' },
  { topic: 3, q: '七天无理由从哪一天开始计算？' },
  { topic: 3, q: '退货时包装和配件必须完整吗？' },
  { topic: 3, q: '企业定制充电宝可以无理由退货吗？' },
  { topic: 3, q: '第三方渠道也适用官方七天退货规则吗？' },
  { topic: 4, q: '充电宝拆封后还能七天无理由退货吗？' },
  { topic: 4, q: '只拆了外包装可以退吗？' },
  { topic: 4, q: '保护膜撕掉了还能无理由退货吗？' },
  { topic: 4, q: '包装拆开但没使用能申请退货吗？' },
  { topic: 4, q: '接口有插拔痕迹还能退吗？' },
  { topic: 5, q: '给手机充过一次电还能退吗？' },
  { topic: 5, q: '只试用了一次是否影响七天无理由？' },
  { topic: 5, q: '已经通电测试过可以直接退款吗？' },
  { topic: 5, q: '使用后发现充不进电应该申请什么售后？' },
  { topic: 5, q: '有使用记录但存在故障能退换吗？' },
  { topic: 7, q: '充电宝鼓包了还能继续使用吗？' },
  { topic: 7, q: '电池有点膨胀，需要马上停用吗？' },
  { topic: 7, q: '鼓包但还能充电，可以再测试一次吗？' },
  { topic: 7, q: '鼓包的充电宝能快递寄回吗？' },
  { topic: 7, q: '充电宝鼓起来了可以自己拆开吗？' },
  { topic: 8, q: '充电宝突然冒烟了怎么办？' },
  { topic: 8, q: '充电宝闻起来有刺鼻异味还能用吗？' },
  { topic: 8, q: '设备异常高温并冒烟应该怎么处理？' },
  { topic: 8, q: '冒烟后可以直接泼水吗？' },
  { topic: 8, q: '充电宝异味消失后还能继续测试吗？' },
  { topic: 6, q: '这款充电宝保修多久？' },
  { topic: 6, q: '保修期从下单还是签收开始算？' },
  { topic: 6, q: '活动赠品也有12个月保修吗？' },
  { topic: 6, q: '企业定制产品的保修期一样吗？' },
  { topic: 6, q: '申请保修需要提供什么购买凭证？' },
  { topic: 9, q: '第三方店铺购买的充电宝可以找官方售后吗？' },
  { topic: 9, q: '非官方渠道购买出现故障找谁？' },
  { topic: 9, q: '第三方订单可以在官方申请退款吗？' },
  { topic: 9, q: '无法确认来源的产品还能维修吗？' },
  { topic: 9, q: '平台店铺购买如何申请官方检测？' }
];

function buildEvalCases(setId) {
  return QUESTION_BANK.map((item, index) => {
    const sec = FAQ_SECTIONS[item.topic];
    const risk = sec.key === 'FAQ-032' || sec.key === 'FAQ-033' ? 'P0安全' : ['FAQ-006', 'FAQ-007', 'FAQ-008', 'FAQ-020'].includes(sec.key) ? '关键政策' : '普通';
    return {
      id: 'EV-' + String(index + 1).padStart(3, '0'),
      set_id: setId,
      question: item.q,
      expected_keywords: sec.keywords.join('|'),
      expected_answer: sec.answer,
      risk,
      p0: risk === 'P0安全' ? 1 : 0,
      ord: index + 1
    };
  });
}

function seedIfEmpty(d) {
  const row = d.prepare('SELECT COUNT(*) AS n FROM users').get();
  if (row && row.n > 0) return;

  const ts = now();
  const users = [
    ['U-001', '王敏', 'operator', 'operator', '售后/客服'],
    ['U-002', '周琳', 'reviewer', 'reviewer', '售后'],
    ['U-003', '陈浩', 'tester', 'tester', '商品'],
    ['U-004', '刘晨', 'approver', 'approver', '售后'],
    ['U-005', '李雪', 'admin', 'admin', '客服']
  ];
  const insUser = d.prepare('INSERT INTO users (id,name,username,password_hash,role,domain,status,created_at) VALUES (?,?,?,?,?,?,?,?)');
  users.forEach(([id, name, username, role, domain]) => {
    insUser.run(id, name, username, hashPassword('demo1234'), role, domain, '启用', ts);
  });

  const kbs = [
    ['KB-AFTERSALES', '售后服务知识库', '售后', '王敏', '售后与客服团队', '运行中', '退换货、退款、保修、维修、安全处置和渠道售后规则。'],
    ['KB-PRODUCT', '商品知识库', '商品', '陈浩', '商品与客服团队', '运行中', '充电宝、充电器和数据线的参数、说明书及使用指导。'],
    ['KB-SOP', '客服SOP与话术', '客服', '李雪', '售后与客服团队', '运行中', '咨询处理步骤、风险升级、转人工标准与统一表达口径。'],
    ['KB-CHANNEL', '渠道平台规则', '渠道', '赵宁', '全公司', '建设中', '天猫、京东、抖音和自营商城的活动、履约及售后差异。']
  ];
  const insKb = d.prepare('INSERT INTO knowledge_bases (id,name,domain,owner,scope,status,description,created_at) VALUES (?,?,?,?,?,?,?,?)');
  kbs.forEach(k => insKb.run(k[0], k[1], k[2], k[3], k[4], k[5], k[6], ts));

  const faqText = buildFaqText();
  const insDoc = d.prepare(`INSERT INTO documents
    (id,kb_id,kb_name,title,file_name,file_path,extension,type,channel,owner,version,validity,status,content_text,release_id,created_at,published_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  insDoc.run('DOC-FAQ-001', 'KB-AFTERSALES', '售后服务知识库', '充电宝售后客服FAQ', '充电宝售后客服FAQ.docx', null, 'DOCX', 'FAQ', '全渠道', '知识运营·王敏', 'v1.0', '2026-07-01 ～ 2026-12-31', '已发布', faqText, 'REL-SEED-001', ts, ts, ts);
  insDoc.run('DOC-RETURN-013', 'KB-AFTERSALES', '售后服务知识库', '七天无理由退货规则', '七天无理由退货规则.docx', null, 'DOCX', '售后政策', '天猫/自营', '售后运营·周琳', 'v3.2', '2026-07-20 ～ 2026-10-31', '草稿', '第三章 七天无理由退货。3.1 商品保持完好且不影响二次销售的，可按购买渠道规则申请七天无理由退货。3.2 充电宝完成通电测试不当然等于影响二次销售，但出现明显使用痕迹、包装配件缺失、机身划痕或序列号不一致时，不适用无理由退货。3.3 天猫、京东及自营商城的申请入口和举证要求存在差异，应按渠道标签检索对应规则。', null, ts, null, ts);
  insDoc.run('DOC-SAFE-008', 'KB-PRODUCT', '商品知识库', '充电宝安全使用与异常处置', '充电宝安全使用与异常处置.pdf', null, 'PDF', '安全SOP', '全渠道', '产品运营·陈浩', 'v2.1', '2026-07-26 ～ 2027-07-25', '草稿', '如充电宝出现鼓包、冒烟、刺鼻气味、异常高温或液体渗漏，应立即停止使用并断开电源。不得自行拆解、刺穿、挤压或投入普通生活垃圾；如现场存在冒烟或起火风险，应远离可燃物并联系专业人员处理。客服不得指导用户继续充放电测试。', null, ts, null, ts);

  const insVer = d.prepare('INSERT INTO document_versions (id,document_id,version,note,status,author,created_at) VALUES (?,?,?,?,?,?,?)');
  insVer.run('VER-001', 'DOC-FAQ-001', 'v1.0', '首次发布', '已发布', '王敏', ts);
  insVer.run('VER-013', 'DOC-RETURN-013', 'v3.2', '按渠道拆分举证要求', '草稿', '周琳', ts);
  insVer.run('VER-008', 'DOC-SAFE-008', 'v2.1', '新增鼓包与冒烟处置', '草稿', '陈浩', ts);

  const setId = 'SET-GOLDEN-001';
  d.prepare('INSERT INTO eval_sets (id,name,count,status,created_at) VALUES (?,?,?,?,?)').run(setId, '售后服务黄金评测集', 40, '已审核', ts);
  const insCase = d.prepare('INSERT INTO eval_cases (id,set_id,question,expected_keywords,expected_answer,risk,p0,ord) VALUES (?,?,?,?,?,?,?,?)');
  buildEvalCases(setId).forEach(c => insCase.run(c.id, c.set_id, c.question, c.expected_keywords, c.expected_answer, c.risk, c.p0, c.ord));

  const sources = [
    ['SRC-CMS-001', '商品CMS', 'A 文档类权威知识', 'REST API / 增量游标', '每小时', 'https://cms.internal/api/knowledge', '正常', '商品运营', '新增10 · 更新4 · 0失败'],
    ['SRC-DOC-003', '售后政策在线文档', 'A 文档类权威知识', 'Webhook', '实时', 'https://docs.internal/hooks/policy', '正常', '售后运营', '更新2 · 已生成草稿'],
    ['SRC-TICKET-005', '历史客服工单', 'C 样本与反馈', '数据库脱敏副本', '每天', 'db-readonly.internal/tickets', '部分失败', '客服主管', '980成功 · 20条脱敏失败'],
    ['SRC-WEB-008', '渠道规则采集', 'A 文档类权威知识', '网页链接 / 人工确认', '每周', 'https://rule.internal/crawl', '已暂停', '渠道运营', '无变更'],
    ['SRC-API-009', '订单物流实时API', 'D 实时业务数据', 'REST API（运行时调用）', '实时', 'https://api.internal/orders', '正常', '系统管理员', '仅运行时调用，不写入索引']
  ];
  const insSrc = d.prepare('INSERT INTO data_sources (id,name,category,method,frequency,endpoint,status,owner,last_result,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)');
  sources.forEach(s => insSrc.run(s[0], s[1], s[2], s[3], s[4], s[5], s[6], s[7], s[8], ts));

  const insKey = d.prepare('INSERT INTO api_keys (id,env,name,mask,scope,created_at) VALUES (?,?,?,?,?,?)');
  insKey.run('KEY-TEST', '测试', '测试环境密钥', 'rag-test-••••••••3f7a', 'test dataset 读写', ts);
  insKey.run('KEY-PROD', '生产', '生产环境密钥', 'rag-prod-••••••••9c2e', 'prod dataset 读写（需审批）', ts);

  const logs = [
    ['王敏', '运行测试dataset检索', '成功'],
    ['周琳', '审核通过 DOC-SAFE-008 v2.0', '成功'],
    ['系统', '重试JOB-TEST-017', '失败']
  ];
  const insLog = d.prepare('INSERT INTO audit_logs (id,time,user_id,operator,action,result) VALUES (?,?,?,?,?,?)');
  logs.forEach(l => insLog.run(makeId('LOG'), ts, null, l[0], l[1], l[2]));
}

function resetDemoData() {
  const d = getDb();
  const tables = ['sessions', 'users', 'knowledge_bases', 'documents', 'document_versions', 'reviews', 'jobs', 'processing_results', 'retrieval_tests', 'eval_sets', 'eval_cases', 'evaluation_runs', 'evaluation_results', 'problem_cases', 'releases', 'data_sources', 'api_keys', 'audit_logs'];
  d.exec('PRAGMA foreign_keys = OFF;');
  for (const t of tables) d.exec('DELETE FROM ' + t + ';');
  seedIfEmpty(d);
  return true;
}

function getSetting(key, fallback) {
  const d = getDb();
  const row = d.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}
function setSetting(key, value) {
  const d = getDb();
  d.prepare('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value));
}

module.exports = {
  DATA_DIR, UPLOAD_DIR, getDb, makeId, now, hashPassword, verifyPassword,
  resetDemoData, getSetting, setSetting, FAQ_SECTIONS, QUESTION_BANK
};
