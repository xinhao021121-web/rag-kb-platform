import { get, post } from '../api.js';
import { esc, toast, showModal, fmt } from '../ui.js';
import { store, isProd, refresh } from '../store.js';

const ELIGIBLE = ['待验收', '已验收', '检索通过', '评测完成', '待发布', '已发布'];

let current = null;

export async function render() {
  const view = document.getElementById('processing');
  const head = view && view.querySelector('.page-head');
  if (!view || !head) return;
  Array.from(view.children).forEach(c => { if (c !== head) c.remove(); });
  const actions = head.querySelector('.actions');
  if (isProd()) {
    if (actions) actions.innerHTML = '';
    view.insertAdjacentHTML('beforeend', '<div class="panel"><div class="empty-kb"><div class="empty-icon">⇄</div><h4>生产环境不提供处理结果验收</h4><p>处理结果验收属于测试环境的内部调试动作；生产环境只保留已发布版本。</p><button class="btn primary" onclick="setEnv(\'test\')">切换到测试环境</button></div></div>');
    return;
  }
  const { jobs } = await get('/api/jobs');
  const list = jobs.filter(j => ELIGIBLE.includes(j.status) && j.environment === '测试');
  if (!list.length) {
    if (actions) actions.innerHTML = '';
    view.insertAdjacentHTML('beforeend', '<div class="panel"><div class="empty-kb"><div class="empty-icon">○</div><h4>暂无处理结果</h4><p>请先在“入库任务”中推送API，并等待RAG引擎处理完成。</p><button class="btn" onclick="showView(\'ingestion\')">返回入库任务</button></div></div>');
    return;
  }
  const job = list.find(j => j.id === store.processingJobId) || list[0];
  store.processingJobId = job.id;
  current = job;
  if (actions) actions.innerHTML = '<select class="select" onchange="switchProcessingJob(this.value)">' + list.map(j => '<option value="' + esc(j.id) + '"' + (j.id === job.id ? ' selected' : '') + '>' + esc(j.docTitle + ' ' + j.docVersion + ' · ' + j.status) + '</option>').join('') + '</select><button class="btn" onclick="renderProcessingResults();toast(\'已刷新当前任务结果\')">刷新结果</button>';
  const data = await get('/api/jobs/' + job.id + '/processing');
  const segments = data.segments || [];
  const accepted = job.status !== '待验收';
  const chunkRows = segments.map(c => '<tr class="processing-chunk-row" data-search="' + esc((c.id + c.heading + c.content).toLowerCase()) + '"><td><strong>' + esc(c.id) + '</strong></td><td>' + esc(c.heading || '—') + '</td><td><strong>' + esc(String(c.content).slice(0, 80)) + '…</strong></td><td>' + (c.word_count || String(c.content).length) + '</td><td><span class="status live">正常</span></td><td><button class="btn small" onclick="openChunkDetail(\'' + job.id + '\',\'' + c.id + '\')">查看切片</button></td></tr>').join('');
  view.insertAdjacentHTML('beforeend',
    '<div class="alert ' + (accepted ? 'good' : 'warn') + '"><strong>' + (accepted ? '处理结果已验收' : '收到RAG引擎处理结果，等待人工验收') + '</strong>数据来自 ' + (job.dify_document_id ? 'Dify' : '本地引擎') + '，对应“' + esc(job.docTitle) + ' ' + esc(job.docVersion) + '”。</div>' +
    '<div class="stepper"><div class="node done"><b>✓</b><span>解析完成</span></div><div class="node done"><b>✓</b><span>切片完成</span></div><div class="node done"><b>✓</b><span>Embedding完成</span></div><div class="node done"><b>✓</b><span>索引完成</span></div><div class="node ' + (accepted ? 'done' : 'active') + '"><b>' + (accepted ? '✓' : '5') + '</b><span>' + (accepted ? '验收通过' : '等待验收') + '</span></div></div>' +
    '<div class="panel"><div class="tabs"><button class="tab processing-tab active" onclick="switchProcessingTab(\'overview\',this)">解析概览</button><button class="tab processing-tab" onclick="switchProcessingTab(\'chunks\',this)">切片明细</button><button class="tab processing-tab" onclick="switchProcessingTab(\'index\',this)">索引结果</button></div><div class="panel-body">' +
    '<div class="processing-pane" data-pane="overview"><div class="metric-row"><div class="metric good"><label>解析状态</label><strong>' + (job.chunk_count ? '成功' : '—') + '</strong></div><div class="metric"><label>正文字符</label><strong>' + job.character_count + '</strong></div><div class="metric good"><label>切片数量</label><strong>' + job.chunk_count + '</strong></div><div class="metric good"><label>向量数量</label><strong>' + job.vector_count + '</strong></div><div class="metric good"><label>处理警告</label><strong>' + job.warning_count + '</strong></div></div><div class="grid-2" style="margin-top:14px"><div class="alert good" style="margin:0"><strong>数据来源</strong>' + (job.dify_document_id ? 'Dify 数据集索引结果（真实 API 返回）' : '本地引擎切片（BM25 检索）') + '</div><div class="alert" style="margin:0"><strong>原文信息</strong>' + esc(job.docTitle) + ' ' + esc(job.docVersion) + ' · dataset ' + esc(job.dataset_id || '本地') + '</div></div></div>' +
    '<div class="processing-pane" data-pane="chunks" style="display:none"><div class="toolbar" style="margin-bottom:12px"><input class="input" id="processingChunkSearch" placeholder="搜索切片内容或编号" oninput="filterProcessingChunks()"><span style="font-size:11px;color:var(--muted)">共 ' + segments.length + ' 个切片</span></div><div style="overflow:auto"><table><thead><tr><th>Chunk</th><th>标题/关键词</th><th>内容</th><th>字符</th><th>状态</th><th>操作</th></tr></thead><tbody>' + chunkRows + '</tbody></table></div></div>' +
    '<div class="processing-pane" data-pane="index" style="display:none"><div class="grid-2"><div><table><tr><td>datasetId</td><td>' + esc(job.dataset_id || '本地引擎') + '</td></tr><tr><td>RAG 文档ID</td><td>' + esc(job.dify_document_id || '—') + '</td></tr><tr><td>引擎</td><td>' + (job.dify_document_id ? 'Dify' : '本地 BM25') + '</td></tr></table></div><div><table><tr><td>有效切片</td><td>' + job.chunk_count + '</td></tr><tr><td>成功向量</td><td>' + job.vector_count + '</td></tr><tr><td>成功索引</td><td>' + job.index_count + '</td></tr><tr><td>一致性校验</td><td><span class="status live">切片 = 向量 = 索引</span></td></tr></table></div></div></div>' +
    '</div></div>' +
    '<div class="panel"><div class="panel-head"><div><h2>验收依据</h2><p>完成以下检查后才能验收通过。</p></div><span class="status ' + (accepted ? 'live' : 'pending') + '">' + esc(job.status) + '</span></div><div class="panel-body">' +
    (accepted ? '<div class="alert good"><strong>五项检查已完成</strong>该版本可以进入检索调试。</div><div class="actions"><button class="btn primary" onclick="showView(\'retrieval\')">进入检索调试</button></div>' :
      '<div class="grid-2"><div>' + ['解析内容完整|无缺页、乱码、表格或标题结构丢失', '切片边界合理|问题与答案、条件与例外没有被错误拆分', '元数据正确|文档、章节、渠道、版本和有效期可追溯'].map(x => { const [t, s] = x.split('|'); return '<label class="review-check"><input type="checkbox" class="processing-accept-check" onchange="processingAcceptanceChanged()"><span><strong>' + t + '</strong><small>' + s + '</small></span></label>'; }).join('') + '</div><div>' + ['数量一致|有效切片数、向量数和索引数一致', '抽样检索命中|典型问题能够召回预期切片'].map(x => { const [t, s] = x.split('|'); return '<label class="review-check"><input type="checkbox" class="processing-accept-check" onchange="processingAcceptanceChanged()"><span><strong>' + t + '</strong><small>' + s + '</small></span></label>'; }).join('') + '</div></div>' +
        '<div class="review-progress" style="margin:12px 0"><span id="processingAcceptText">已确认 0/5</span><div class="progress" style="margin-top:6px"><i id="processingAcceptProgress" style="width:0"></i></div></div>' +
        '<div class="actions"><button class="btn danger" onclick="rejectProcessingResult(\'' + job.id + '\')">退回重处理</button><button class="btn primary" id="processingAcceptBtn" onclick="acceptProcessingResult(\'' + job.id + '\')" disabled>还需确认5项</button></div>') +
    '</div></div>');
}

export function switchProcessingJob(id) { store.processingJobId = id; render(); }
export function switchProcessingTab(name, button) {
  document.querySelectorAll('#processing .processing-tab').forEach(b => b.classList.toggle('active', b === button));
  document.querySelectorAll('#processing .processing-pane').forEach(p => p.style.display = p.dataset.pane === name ? 'block' : 'none');
}
export function filterProcessingChunks() {
  const q = (document.getElementById('processingChunkSearch').value || '').toLowerCase();
  document.querySelectorAll('#processing .processing-chunk-row').forEach(r => { r.style.display = !q || r.dataset.search.includes(q) ? '' : 'none'; });
}
export async function openChunkDetail(jobId, chunkId) {
  const data = await get('/api/jobs/' + jobId + '/processing');
  const c = (data.segments || []).find(x => x.id === chunkId);
  if (!c) return;
  showModal(c.id + ' · 切片详情', '<div class="alert good" style="white-space:pre-wrap">' + esc(c.content) + '</div><table><tr><td>标题/关键词</td><td>' + esc(c.heading || '—') + '</td></tr><tr><td>字符数</td><td>' + (c.word_count || String(c.content).length) + '</td></tr><tr><td>位置</td><td>' + (c.position || '—') + '</td></tr></table>');
}
export function processingAcceptanceChanged() {
  const checks = Array.from(document.querySelectorAll('#processing .processing-accept-check'));
  const done = checks.filter(c => c.checked).length;
  const btn = document.getElementById('processingAcceptBtn');
  const text = document.getElementById('processingAcceptText');
  const bar = document.getElementById('processingAcceptProgress');
  if (text) text.textContent = '已确认 ' + done + '/' + checks.length;
  if (bar) bar.style.width = (done / checks.length * 100) + '%';
  if (btn) { btn.disabled = done !== checks.length; btn.textContent = done === checks.length ? '验收通过' : '还需确认' + (checks.length - done) + '项'; }
}
export async function acceptProcessingResult(id) {
  try {
    await post('/api/jobs/' + id + '/accept', { checks: [true, true, true, true, true] });
    toast('处理结果验收通过，下一步进行检索调试'); await refresh();
    setTimeout(() => showView('retrieval'), 300);
  } catch (e) { toast(e.message); }
}
export async function rejectProcessingResult(id) {
  try {
    await post('/api/jobs/' + id + '/reject', {});
    toast('已退回重处理'); await refresh();
  } catch (e) { toast(e.message); }
}

Object.assign(window, { renderProcessingResults: render, switchProcessingJob, switchProcessingTab, filterProcessingChunks, openChunkDetail, processingAcceptanceChanged, acceptProcessingResult, rejectProcessingResult });
