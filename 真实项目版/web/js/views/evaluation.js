import { get, post } from '../api.js';
import { esc, toast, showModal, closeModal, fmt } from '../ui.js';
import { store, isProd, refresh } from '../store.js';

const MODES = {
  quick: { name: '快速冒烟评测', count: 5, threshold: 1 },
  formal: { name: '正式上线评测', count: 40, threshold: 0.975 },
  regression: { name: '全量回归评测', count: 200, threshold: 0.96 }
};
let pollTimer = null;
let activeMode = 'quick';

export async function render() {
  const view = document.getElementById('evaluation');
  const head = view && view.querySelector('.page-head');
  if (!view || !head) return;
  Array.from(view.children).forEach(c => { if (c !== head) c.remove(); });
  const actions = head.querySelector('.actions');
  if (isProd()) {
    if (actions) actions.innerHTML = '';
    view.insertAdjacentHTML('beforeend', '<div class="panel"><div class="empty-kb"><div class="empty-icon">◎</div><h4>生产环境不提供批量评测</h4><p>冒烟、正式评测、全量回归与客服对话验收都在测试环境完成。</p><button class="btn primary" onclick="setEnv(\'test\')">切换到测试环境</button></div></div>');
    return;
  }
  const data = await get('/api/evaluations');
  if (!data.job) {
    if (actions) actions.innerHTML = '';
    view.insertAdjacentHTML('beforeend', '<div class="panel"><div class="empty-kb"><div class="empty-icon">◎</div><h4>暂无问答评测任务</h4><p>请先在“检索调试”中运行检索并确认检索通过。</p><button class="btn primary" onclick="showView(\'retrieval\')">去检索调试</button></div></div>');
    return;
  }
  const job = data.job;
  const runs = data.runs || [];
  const runOf = m => runs.filter(r => r.mode === m && r.status === '完成').sort((a, b) => String(b.finished_at).localeCompare(String(a.finished_at)))[0];
  const progress = data.progress || {};
  if (actions) actions.innerHTML = '<span class="status processing">' + esc(job.docTitle + ' ' + job.docVersion) + '</span><button class="btn" onclick="showView(\'cases\')">问题案例</button>';

  const stageCard = (mode) => {
    const cfg = MODES[mode];
    const run = runOf(mode);
    const rate = run ? (run.pass_rate * 100).toFixed(1) + '%' : '—';
    const passed = run ? run.passed_count + '/' + run.count : '—';
    const gateReasons = { quick: '', formal: '需先通过冒烟并处理其问题案例', regression: '需先通过正式评测并处理其问题案例' };
    const canRun = !run || mode === 'quick' || (mode === 'formal' ? data.gates.formal.allowed : data.gates.regression.allowed);
    return '<div class="panel" style="margin-bottom:12px"><div class="panel-head"><div><h2>' + cfg.name + '</h2><p>' + (mode === 'quick' ? '检查基础链路 • 5条' : mode === 'formal' ? '单文档上线门槛 • 40条 • 通过率 ≥97.5%' : '知识库级回归 • 200条 • 通过率 ≥96%') + '</p></div><span class="status ' + (run ? 'live' : 'pending') + '">' + (run ? '已完成' : '待运行') + '</span></div><div class="panel-body">' +
      '<div class="metric-row"><div class="metric ' + (run ? 'good' : '') + '"><label>通过率</label><strong>' + rate + '</strong></div><div class="metric"><label>通过用例</label><strong>' + passed + '</strong></div><div class="metric ' + (run && run.p0_failures ? 'bad' : run ? 'good' : '') + '"><label>P0失败</label><strong>' + (run ? run.p0_failures : '—') + '</strong></div><div class="metric"><label>评测时间</label><strong style="font-size:12px">' + (run ? fmt(run.finished_at) : '—') + '</strong></div></div>' +
      '<div class="actions" style="margin-top:12px"><button class="btn primary" onclick="runEvaluation(\'' + mode + '\')" ' + (canRun ? '' : 'disabled') + '>' + (run ? '重新运行' : '运行') + cfg.name + '</button>' + (run ? '<button class="btn" onclick="showRunResults(\'' + run.run_id + '\',\'' + mode + '\')">查看明细</button>' : '') + (canRun ? '' : '<span style="font-size:11px;color:var(--muted)">' + gateReasons[mode] + '</span>') + '</div></div></div>';
  };

  view.insertAdjacentHTML('beforeend',
    '<div class="alert good"><strong>任务绑定</strong>' + esc(job.docTitle) + ' ' + esc(job.docVersion) + ' · dataset ' + esc(job.dataset_id || '本地引擎') + ' · ' + (job.dify_document_id ? 'Dify' : '本地引擎') + '</div>' +
    '<div class="alert"><label style="font-size:12px"><input type="checkbox" id="evalUseLlm" checked> 使用 Dify 生成回答（真实 LLM，较慢）</label><span style="font-size:11px;color:var(--muted)">　关闭后使用抽取式回答，200 条全量回归可快速跑完。</span></div>' +
    '<div class="stepper"><div class="node ' + (progress.quick ? 'done' : 'active') + '"><b>' + (progress.quick ? '✓' : '1') + '</b><span>冒烟评测5条</span></div><div class="node ' + (progress.formal ? 'done' : progress.quick ? 'active' : '') + '"><b>' + (progress.formal ? '✓' : '2') + '</b><span>正式评测40条</span></div><div class="node ' + (progress.regression ? 'done' : progress.formal ? 'active' : '') + '"><b>' + (progress.regression ? '✓' : '3') + '</b><span>全量回归200条</span></div><div class="node ' + (progress.dialogue ? 'done' : progress.regression ? 'active' : '') + '"><b>' + (progress.dialogue ? '✓' : '4') + '</b><span>客服对话验收</span></div></div>' +
    stageCard('quick') + stageCard('formal') + stageCard('regression') +
    '<div class="grid-2">' +
    '<div class="panel"><div class="panel-head"><div><h2>客服对话验收</h2><p>在真实客服测试聊天窗完成5个场景后登记</p></div><span class="status ' + (progress.dialogue ? 'live' : 'pending') + '">' + (progress.dialogue ? '已通过' : '待验收') + '</span></div><div class="panel-body">' + (progress.dialogue ? '<div class="alert good"><strong>5/5通过</strong>验收人：' + esc(data.dialogue.tester) + ' · ' + fmt(data.dialogue.finishedAt) + '</div>' : '<div class="alert warn"><strong>需要真实对话测试</strong>完成单轮回答、连续追问、安全话术、引用展示和转人工后登记结果。</div>') + '<button class="btn primary" onclick="openDialogue()" ' + (progress.regression ? '' : 'disabled') + '>' + (progress.dialogue ? '修改验收记录' : '登记对话验收结果') + '</button></div></div>' +
    '<div class="panel"><div class="panel-head"><h2>发布确认</h2><span class="status ' + (job.status === '待发布' ? 'live' : data.releaseReady ? 'processing' : 'pending') + '">' + (job.status === '待发布' ? '待线下审批' : data.releaseReady ? '可以提交' : '门槛未完成') + '</span></div><div class="panel-body">' + (job.status === '待发布' ? '<div class="alert good"><strong>已提交线下审批</strong>请在“文档与版本”对文档点“审批”登记结论。</div><button class="btn primary" onclick="showView(\'documents\')">去文档列表审批</button>' : data.releaseReady ? '<div class="alert good"><strong>全部质量门槛已满足</strong>冒烟、正式、回归和客服对话验收均已完成。</div><button class="btn primary" onclick="submitRelease()">提交线下发布审批</button>' : '<div class="alert warn"><strong>尚未满足发布门槛</strong>请完成未通过的评测阶段，并处理全部问题案例。</div>') + '</div></div></div>');

  if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
  const running = runs.find(r => r.status === '运行中');
  if (running) pollTimer = setTimeout(() => { if (store.view === 'evaluation') render(); }, 2000);
}

export async function runEvaluation(mode) {
  try {
    const data = await get('/api/evaluations');
    const useLlmEl = document.getElementById('evalUseLlm');
    const useLlm = useLlmEl ? !!useLlmEl.checked : true;
    await post('/api/evaluations/run', { jobId: data.job.id, mode, local: !useLlm });
    activeMode = mode;
    toast(MODES[mode].name + '已开始执行' + (useLlm ? '（LLM 生成，耗时较长）' : '（本地抽取式，快速）'));
    setTimeout(() => { if (store.view === 'evaluation') render(); }, 800);
  } catch (e) { toast(e.message); }
}

export async function showRunResults(runId, mode) {
  const data = await get('/api/evaluations/run/' + runId);
  const rows = data.results.map(r => '<tr><td>' + esc(r.question) + '</td><td><span class="status ' + (r.recall_ok ? 'live' : 'failed') + '">' + (r.recall_ok ? '命中' : '未命中') + '</span></td><td><span class="status ' + (r.answer_ok ? 'live' : 'failed') + '">' + (r.answer_ok ? '通过' : '不通过') + '</span></td><td><span class="status ' + (r.p0_ok ? 'live' : 'failed') + '">' + (r.p0_ok ? '安全' : 'P0失败') + '</span></td><td>' + esc(r.failure_reason || '—') + '</td></tr>').join('');
  showModal(MODES[mode].name + ' · 明细（' + data.run.passed_count + '/' + data.run.count + '）', '<div style="max-height:56vh;overflow:auto"><table><thead><tr><th>问题</th><th>召回</th><th>回答</th><th>安全</th><th>失败原因</th></tr></thead><tbody>' + rows + '</tbody></table></div>', '<button class="btn" onclick="closeModal()">关闭</button>');
}

export function openDialogue() {
  showModal('登记客服对话验收结果', '<div class="alert warn"><strong>只登记外部测试结果</strong>以下场景应在 FastGPT / 企业客服测试聊天窗中实际验证。未勾选项会生成 Bad Case 并阻断发布。</div>' +
    '<div class="field"><label>验收人</label><input class="input" id="dialogueTester" style="width:100%" value="' + esc(store.me ? store.me.name : '') + '"></div>' +
    ['单轮回答正确', '连续追问正常', '安全话术正确', '引用展示正常', '转人工符合预期'].map(s => '<label class="review-check"><input type="checkbox" class="dialogue-check"><span><strong>' + s + '</strong></span></label>').join('') +
    '<div class="field" style="margin-top:12px"><label>验收备注</label><textarea class="textarea" id="dialogueNotes" rows="2">已在客服测试环境完成5个场景验证。</textarea></div>',
    '<button class="btn" onclick="closeModal()">取消</button><button class="btn primary" onclick="submitDialogue()">提交验收结果</button>');
}

export async function submitDialogue() {
  const tester = (document.getElementById('dialogueTester') || {}).value || '';
  const checks = Array.from(document.querySelectorAll('.dialogue-check')).map(c => c.checked);
  if (!tester.trim()) return toast('请填写验收人');
  try {
    const data = await get('/api/evaluations');
    const res = await post('/api/evaluations/dialogue', { jobId: data.job.id, tester, checks, notes: (document.getElementById('dialogueNotes') || {}).value || '' });
    closeModal();
    if (res.passed) toast('客服对话验收已登记：5/5通过'); else toast('已生成 ' + res.failed.length + ' 条 Bad Case 并阻断发布');
    await refresh();
  } catch (e) { toast(e.message); }
}

export async function submitRelease() {
  try {
    const data = await get('/api/evaluations');
    await post('/api/evaluations/submit', { jobId: data.job.id });
    toast('已提交线下发布审批'); await refresh();
  } catch (e) { toast(e.message); }
}

Object.assign(window, { renderEvaluationWorkbench: render, runEvaluation, showRunResults, openDialogue, submitDialogue, submitRelease });
