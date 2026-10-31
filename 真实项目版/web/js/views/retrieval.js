import { get, post } from '../api.js';
import { esc, toast, showModal, closeModal } from '../ui.js';
import { store, isProd, refresh } from '../store.js';

const ELIGIBLE = ['已验收', '检索通过', '评测完成', '待发布', '已发布'];
let lastRun = null;

export async function render() {
  const view = document.getElementById('retrieval');
  const head = view && view.querySelector('.page-head');
  if (!view || !head) return;
  Array.from(view.children).forEach(c => { if (c !== head) c.remove(); });
  const actions = head.querySelector('.actions');
  if (isProd()) {
    if (actions) actions.innerHTML = '';
    view.insertAdjacentHTML('beforeend', '<div class="panel"><div class="empty-kb"><div class="empty-icon">⌕</div><h4>生产环境不提供检索调试</h4><p>检索调试只在测试环境对未发布版本执行；生产问答由线上应用直接使用已发布知识。</p><button class="btn primary" onclick="setEnv(\'test\')">切换到测试环境</button></div></div>');
    return;
  }
  const { jobs } = await get('/api/jobs');
  const list = jobs.filter(j => ELIGIBLE.includes(j.status) && j.environment === '测试');
  if (!list.length) {
    if (actions) actions.innerHTML = '';
    view.insertAdjacentHTML('beforeend', '<div class="panel"><div class="empty-kb"><div class="empty-icon">⌕</div><h4>暂无可检索的数据</h4><p>只有完成RAG处理并人工验收通过的文档，才会进入检索调试。</p><button class="btn primary" onclick="showView(\'processing\')">去处理结果验收</button></div></div>');
    return;
  }
  const job = list.find(j => j.id === store.retrievalJobId) || list[0];
  store.retrievalJobId = job.id;
  if (actions) actions.innerHTML = '<select class="select" onchange="switchRetrievalJob(this.value)">' + list.map(j => '<option value="' + esc(j.id) + '"' + (j.id === job.id ? ' selected' : '') + '>' + esc(j.docTitle + ' ' + j.docVersion + ' · ' + j.status) + '</option>').join('') + '</select><span class="status ' + (job.status === '已验收' ? 'processing' : 'live') + '">' + esc(job.status) + '</span>';
  view.insertAdjacentHTML('beforeend',
    '<div class="alert good"><strong>当前检索范围</strong>' + esc(job.docTitle) + ' ' + esc(job.docVersion) + ' · dataset ' + esc(job.dataset_id || '本地引擎') + ' · ' + (job.dify_document_id ? 'Dify 检索' : '本地 BM25 检索') + '</div>' +
    '<div class="grid-2" style="grid-template-columns:minmax(0,1.55fr) minmax(270px,.65fr)">' +
    '<div class="panel"><div class="panel-head"><div><h2>输入真实用户问题</h2><p>验证能否从已验收的 ' + job.chunk_count + ' 个切片中召回正确答案依据。</p></div><span class="status ' + (job.status === '已验收' ? 'pending' : 'live') + '">' + (job.status === '已验收' ? '待检索验证' : '检索已通过') + '</span></div><div class="panel-body">' +
    '<div class="query-box"><input class="input" id="retrievalQuery" value="充电宝鼓包了怎么办？"><button class="btn primary" onclick="runRetrieval()">运行检索</button></div>' +
    '<div class="actions" style="margin-top:10px">' + ['充电宝鼓包了怎么办？|鼓包怎么办', '充电宝拆封后还能退吗？|拆封能退吗', '怎么判断充电宝是不是正品？|怎么验真'].map(x => { const [q, l] = x.split('|'); return '<button class="btn small" onclick="setRetrievalQuery(\'' + q + '\')">' + l + '</button>'; }).join('') + '</div>' +
    '<div class="toolbar" style="margin-top:12px"><span style="font-size:11px;color:var(--muted)">最低相关度</span><input class="input" id="retrievalThreshold" style="min-width:80px;width:80px" value="0.2"></div>' +
    '<div class="alert" style="margin-top:12px;margin-bottom:0"><strong>4类常见失败诊断</strong>' + ['missing|知识缺失或过期', 'chunk|切片不合理', 'filter|过滤条件不正确', 'config|检索配置不合适'].map(x => { const [k, l] = x.split('|'); return '<button class="btn small" style="margin:4px 6px 0 0" onclick="runDiagnosisDemo(\'' + k + '\')">' + l + '</button>'; }).join('') + '</div>' +
    '</div></div>' +
    '<div class="panel"><div class="panel-head"><h2>当前检索资源</h2></div><div class="panel-body"><table><tr><td>知识库</td><td>' + esc(job.kbName || '—') + '</td></tr><tr><td>测试dataset</td><td>' + esc(job.dataset_id || '本地引擎') + '</td></tr><tr><td>RAG 文档ID</td><td>' + esc(job.dify_document_id || '—') + '</td></tr><tr><td>可检索切片</td><td>' + job.chunk_count + ' 条</td></tr><tr><td>文档状态</td><td><span class="status processing">' + esc(job.docStatus) + '</span></td></tr></table><div class="actions" style="margin-top:10px"><button class="btn small" onclick="saveCase(\'test\')">保存为测试用例</button><button class="btn small" onclick="saveCase(\'regression\')">保存为回归用例</button></div></div></div>' +
    '</div><div id="retrievalResult"></div>');
}

export function switchRetrievalJob(id) { store.retrievalJobId = id; lastRun = null; render(); }
export function setRetrievalQuery(q) { const el = document.getElementById('retrievalQuery'); if (el) { el.value = q; runRetrieval(); } }

export async function runRetrieval() {
  const q = (document.getElementById('retrievalQuery') || {}).value || '';
  const threshold = Number((document.getElementById('retrievalThreshold') || {}).value || 0.2);
  if (!q.trim()) return toast('请输入问题');
  try {
    const res = await post('/api/retrieval/run', { jobId: store.retrievalJobId, query: q, threshold });
    lastRun = res;
    const records = res.records || [];
    const diag = res.diagnosis;
    const diagHtml = diag === 'ok'
      ? '<div class="alert good"><strong>结论：召回正确</strong>Top 1 命中，相关度 ' + (records[0] ? records[0].score : '—') + '；结果来自' + (res.engine === 'dify' ? ' Dify 检索' : '本地引擎') + '。</div>'
      : diag === 'threshold' ? '<div class="alert danger"><strong>诊断：检索配置不合适（阈值过高）</strong>当前阈值 ' + threshold + ' 高于最高得分。请降低阈值后重试。</div>'
        : diag === 'no-result' ? '<div class="alert danger"><strong>诊断：没有召回结果</strong>知识库可能缺失该知识，或切片/索引异常。</div>'
          : '<div class="alert danger"><strong>检索失败</strong>' + esc(res.error || '未知错误') + '</div>';
    const results = records.length ? records.map((r, i) => '<div class="result"><div class="result-head"><h4>Top ' + (i + 1) + ' · ' + esc(r.id) + '</h4><div><span class="status ' + (i === 0 ? 'live' : 'pending') + '" style="margin-right:6px">' + (i === 0 ? '最相关' : '候选') + '</span><span class="score">相关度 ' + Number(r.score).toFixed(3) + '</span></div></div><p style="white-space:pre-wrap">' + esc(String(r.content).slice(0, 300)) + '</p><small>来源：' + esc(r.source || '—') + '</small></div>').join('')
      : '<div class="empty"><strong>没有召回结果</strong></div>';
    document.getElementById('retrievalResult').innerHTML =
      '<div class="grid-2" style="grid-template-columns:minmax(0,1.45fr) minmax(300px,.75fr)"><div class="panel"><div class="panel-head"><div><h2>召回结果 Top ' + records.length + '</h2><p>检索ID：' + esc(res.runId) + ' · 耗时 ' + res.costMs + 'ms</p></div></div><div class="panel-body">' + results + '</div></div>' +
      '<div class="panel"><div class="panel-head"><h2>检索诊断</h2></div><div class="panel-body">' + diagHtml +
      '<div class="actions"><button class="btn danger" onclick="openProblemModal()">标记为问题</button><button class="btn primary" onclick="confirmRetrieval()" ' + (diag !== 'ok' ? 'disabled' : '') + '>确认检索通过</button></div></div></div></div>';
    toast('检索完成：返回 ' + records.length + ' 条结果');
  } catch (e) { toast(e.message); }
}

export async function confirmRetrieval() {
  if (!lastRun) return toast('请先运行检索');
  try {
    await post('/api/retrieval/confirm', { jobId: store.retrievalJobId, runId: lastRun.runId });
    toast('检索验证通过，下一步进入问答评测'); await refresh();
  } catch (e) { toast(e.message); }
}

export function openProblemModal() {
  if (!lastRun) return toast('请先运行检索');
  showModal('将本次检索标记为问题', '<div class="alert warn"><strong>会同步到“问题案例”</strong>系统保存问题、检索ID与实际结果，方便线下处理。</div>' +
    '<div class="field"><label>问题类型</label><select class="select" id="problemType" style="width:100%"><option>Top 1召回错误</option><option>相关度过低</option><option>没有召回正确切片</option><option>过滤或权限异常</option></select></div>' +
    '<div class="field"><label>问题说明</label><textarea class="textarea" id="problemNotes" rows="3" placeholder="例如：问题询问退货，Top 1却召回了安全政策。"></textarea></div>',
    '<button class="btn" onclick="closeModal()">取消</button><button class="btn danger" onclick="createProblemCase()">生成问题案例</button>');
}

export async function createProblemCase() {
  try {
    await post('/api/retrieval/problem', { jobId: store.retrievalJobId, runId: lastRun.runId, type: document.getElementById('problemType').value, notes: document.getElementById('problemNotes').value });
    closeModal(); toast('已生成问题案例'); await refresh();
    setTimeout(() => showView('cases'), 300);
  } catch (e) { toast(e.message); }
}

export async function saveCase(kind) {
  if (!lastRun) return toast('请先运行检索');
  try {
    await post('/api/retrieval/save-case', { jobId: store.retrievalJobId, runId: lastRun.runId, kind });
    toast(kind === 'regression' ? '已保存为回归用例' : '已保存为测试用例');
  } catch (e) { toast(e.message); }
}

export function runDiagnosisDemo(type) {
  const map = {
    missing: ['知识缺失或过期', '问题涉及的知识没有进入知识库，或对应版本已过期被排除。', '补充权威知识或更新版本后重新走审核、入库与评测。'],
    chunk: ['切片不合理', '问题、答案、条件与例外被拆到不同切片，Top 1 只命中半条规则。', '检查切片边界，必要时重新处理文档。'],
    filter: ['过滤条件不正确', '渠道、业务范围或权限过滤把正确知识排除在候选之外。', '检查渠道标签、业务域与权限配置。'],
    config: ['检索配置不合适', '最低相关度阈值过高或检索方式与问题类型不匹配。', '结合真实问题调整阈值与检索策略。']
  }[type];
  showModal('诊断演示 · ' + map[0], '<div class="alert warn"><strong>' + map[0] + '</strong>' + map[1] + '</div><div class="alert good"><strong>处理方向</strong>' + map[2] + '</div>');
}

Object.assign(window, { renderRetrievalWorkbench: render, switchRetrievalJob, setRetrievalQuery, runRetrieval, confirmRetrieval, openProblemModal, createProblemCase, saveCase, runDiagnosisDemo });
