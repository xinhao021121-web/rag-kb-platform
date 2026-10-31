import { get, post } from '../api.js';
import { esc, toast, showModal, closeModal, fmt } from '../ui.js';
import { isProd, refresh } from '../store.js';

export async function render() {
  const box = document.getElementById('reviewUserQueue');
  const detail = document.getElementById('reviewDetail');
  if (!box) return;
  if (detail) detail.innerHTML = '';
  if (isProd()) {
    box.innerHTML = '<div class="panel"><div class="empty-kb"><div class="empty-icon">✓</div><h4>生产环境不提供业务审核</h4><p>业务审核在测试环境完成；发布审批在“文档与版本”的待线下审批文档上登记。</p></div></div>';
    return;
  }
  const filterEl = document.getElementById('reviewFilter');
  const filter = filterEl ? filterEl.value : 'pending';
  const data = await get('/api/reviews' + (filter === 'p0' ? '?filter=p0' : ''));
  const docs = data.pending;
  const draftHint = data.drafts ? '<div class="alert warn"><strong>还有 ' + data.drafts + ' 份文档处于草稿状态</strong>草稿不会自动进入业务审核，请到“文档与版本”提交审核。<button class="btn small" onclick="showView(\'documents\')">去提交审核</button></div>' : '';
  if (!docs.length) {
    box.innerHTML = draftHint || '<div class="panel"><div class="empty-kb"><div class="empty-icon">✓</div><h4>暂无待审核文档</h4><p>请先创建知识库、上传文档并提交审核。</p><button class="btn primary" onclick="showView(\'knowledge\')">从新建知识库开始</button></div></div>';
    return;
  }
  box.innerHTML = '<div class="alert good"><strong>审核对象</strong>对比当前线上版与待审核版，完成三项确认后通过；通过后系统自动创建测试入库任务。</div>' +
    '<div class="panel" style="border-color:#9fc1f0"><div class="panel-head"><div><h2>待审核文档（' + docs.length + '）</h2><p>审核通过后才会创建测试入库任务，目前尚未进入RAG引擎。</p></div><span class="status processing">等待业务审核</span></div>' +
    '<div class="panel-body" style="padding:0"><table><thead><tr><th>文档</th><th>所属知识库</th><th>版本</th><th>提交人</th><th>提交时间</th><th>操作</th></tr></thead><tbody>' +
    docs.map(d => '<tr><td><strong>' + esc(d.title) + '</strong><br><small>' + esc(d.file_name || '—') + '</small>' + (d.type === '安全SOP' ? ' <span class="status failed">P0</span>' : '') + '</td><td>' + esc(d.kb_name) + '</td><td>' + esc(d.version) + '</td><td>' + esc(d.owner) + '</td><td>' + fmt(d.submitted_at || d.created_at) + '</td><td><button class="btn small primary" onclick="openPendingReview(\'' + d.id + '\')">审核这份文档</button></td></tr>').join('') +
    '</tbody></table></div></div>' + draftHint;
}

export async function openPendingReview(docId) {
  const data = await get('/api/documents/' + docId);
  const d = data.document;
  const detail = document.getElementById('reviewDetail');
  if (!detail) return;
  const preview = d.content_text || '（未能提取正文；可配置 Dify 解析）';
  detail.innerHTML = '<div class="review-taskbar"><div><strong>审核 · ' + esc(d.title) + ' ' + esc(d.version) + '</strong><span>　提交人：' + esc(d.owner) + '</span></div><span>操作顺序：查看原文 → 勾选3项确认 → 通过或驳回</span></div>' +
    '<div class="panel"><div class="panel-head"><div><h2>' + esc(d.title) + ' ' + esc(d.version) + '</h2><p>所属知识库：' + esc(d.kb_name) + ' · 类型：' + esc(d.type) + '</p></div><span class="status pending">' + esc(d.type) + '</span></div><div class="panel-body">' +
    '<div class="review-workspace"><div><div class="review-version-head"><strong>待审核版 ' + esc(d.version) + '</strong><span class="status pending">首次发布 · 无线上旧版本</span></div>' +
    '<div class="review-preview pending-version" style="height:auto;min-height:220px;white-space:pre-wrap">' + esc(preview) + '</div>' +
    '<div class="review-meta"><div><label>知识来源</label><strong>' + esc(d.file_name || '—') + '</strong></div><div><label>适用范围</label><strong>' + esc(d.channel) + '</strong></div><div><label>生效 / 失效</label><strong>' + esc(d.validity) + '</strong></div></div></div>' +
    '<aside class="review-side"><div class="review-side-head"><strong>确认审核结果</strong><small>先完成下面3项确认</small></div><div class="review-checklist">' +
    '<label class="review-check"><input type="checkbox" class="review-check-input" onchange="reviewChecklistChanged()"><span><strong>内容准确、没有遗漏</strong><small>事实、操作步骤、条件和例外均符合业务规范</small></span></label>' +
    '<label class="review-check"><input type="checkbox" class="review-check-input" onchange="reviewChecklistChanged()"><span><strong>适用范围和有效期正确</strong><small>适用渠道、产品范围及生效时间均正确</small></span></label>' +
    '<label class="review-check"><input type="checkbox" class="review-check-input" onchange="reviewChecklistChanged()"><span><strong>可以作为正式回答</strong><small>不含敏感信息，也不会作出超范围承诺</small></span></label></div>' +
    '<div class="review-progress"><div style="display:flex;justify-content:space-between;margin-bottom:6px"><span id="reviewCheckText">已确认 0/3</span><span>全部为必选</span></div><div class="progress"><i id="reviewCheckProgress" style="width:0"></i></div></div>' +
    '<div class="review-decision"><div class="field"><label>审核备注（通过时必填）</label><textarea class="textarea" id="reviewNote" placeholder="通过时填写审核依据；驳回时说明需要修改什么">已核对内容、适用范围与有效期，可作为正式口径。</textarea></div>' +
    '<div class="actions"><button class="btn danger" onclick="reviewDecision(\'reject\',\'' + d.id + '\')">驳回修改</button><button class="btn primary" id="reviewApproveBtn" onclick="reviewDecision(\'approve\',\'' + d.id + '\')" disabled>确认通过</button></div></div></aside></div></div></div>';
  detail.scrollIntoView({ block: 'start' });
}

export function reviewChecklistChanged() {
  const checks = Array.from(document.querySelectorAll('.review-check-input'));
  const done = checks.filter(c => c.checked).length;
  const btn = document.getElementById('reviewApproveBtn');
  const text = document.getElementById('reviewCheckText');
  const bar = document.getElementById('reviewCheckProgress');
  if (text) text.textContent = '已确认 ' + done + '/' + checks.length;
  if (bar) bar.style.width = (done / checks.length * 100) + '%';
  if (btn) { btn.disabled = done !== checks.length; btn.textContent = done === checks.length ? '确认通过' : '还需确认 ' + (checks.length - done) + ' 项'; }
}

export async function reviewDecision(type, docId) {
  if (type === 'reject') {
    showModal('驳回知识版本', '<div class="alert warn"><strong>驳回后会发生什么？</strong>文档退回知识运营修改，不会创建测试入库任务。</div><div class="field"><label>具体修改要求</label><textarea class="textarea" id="rejectReason" rows="4" placeholder="必须告诉提交人具体修改什么"></textarea></div>',
      '<button class="btn" onclick="closeModal()">取消</button><button class="btn danger" onclick="confirmReviewReject(\'' + docId + '\')">确认驳回</button>');
    return;
  }
  const checks = Array.from(document.querySelectorAll('.review-check-input'));
  if (checks.some(c => !c.checked)) return toast('请先完成右侧3项确认');
  const note = (document.getElementById('reviewNote') || {}).value || '';
  if (!note.trim()) return toast('请填写审核备注');
  try {
    await post('/api/reviews/' + docId + '/approve', { confirmFact: true, confirmScope: true, confirmValidity: true, note: note.trim() });
    toast('审核通过，测试入库任务已创建'); await refresh();
    document.getElementById('reviewDetail').innerHTML = '';
    setTimeout(() => showView('ingestion'), 300);
  } catch (e) { toast(e.message); }
}

export async function confirmReviewReject(docId) {
  const reason = (document.getElementById('rejectReason') || {}).value || '';
  if (!reason.trim()) return toast('请填写具体修改要求');
  try {
    await post('/api/reviews/' + docId + '/reject', { reason: reason.trim() });
    closeModal(); toast('已驳回并退回修改'); await refresh();
    document.getElementById('reviewDetail').innerHTML = '';
  } catch (e) { toast(e.message); }
}

Object.assign(window, { renderReviewQueue: render, openPendingReview, reviewChecklistChanged, reviewDecision, confirmReviewReject });
