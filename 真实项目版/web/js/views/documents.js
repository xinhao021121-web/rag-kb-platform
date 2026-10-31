import { get, post, upload as uploadFile } from '../api.js';
import { esc, toast, showModal, closeModal, fmt, statusClass, ragEnv } from '../ui.js';
import { store, isProd, refresh } from '../store.js';

function rowActions(doc) {
  const d = '<button class="btn small" onclick="event.stopPropagation();openUserDocument(\'' + doc.id + '\')">详情</button> ';
  if (isProd()) return d;
  const sp = 'event.stopPropagation();';
  if (doc.status === '草稿') return d + '<button class="btn small primary" onclick="' + sp + 'submitNewDoc(\'' + doc.id + '\')">提交审核</button>';
  if (doc.status === '待审核') return d + '<button class="btn small" disabled>审核处理中</button>';
  if (doc.status === '测试入库中') return d + '<button class="btn small" onclick="' + sp + 'showView(\'ingestion\')">查看任务</button>';
  if (doc.status === '待验收') return d + '<button class="btn small primary" onclick="' + sp + 'showView(\'processing\')">验收结果</button>';
  if (doc.status === '待检索验证') return d + '<button class="btn small primary" onclick="' + sp + 'showView(\'retrieval\')">检索测试</button>';
  if (doc.status === '待问答评测' || doc.status === '待全量回归') return d + '<button class="btn small primary" onclick="' + sp + 'showView(\'evaluation\')">去评测</button>';
  if (doc.status === '待线下审批') return d + '<button class="btn small primary" onclick="' + sp + 'openReleaseApproval(\'' + doc.id + '\')">审批</button>';
  if (doc.status === '待问题修复') return d + '<button class="btn small" onclick="' + sp + 'showView(\'evaluation\')">返回评测</button>';
  if (doc.status === '已发布') return d + '<button class="btn small" onclick="' + sp + 'newVersion(\'' + doc.id + '\')">新版本</button>';
  return d;
}

export async function render() {
  const [{ documents }, { kbs }] = await Promise.all([get('/api/documents'), get('/api/kb')]);
  const kbSel = document.getElementById('docKB');
  if (kbSel) {
    const cur = kbSel.value;
    kbSel.innerHTML = '<option value="">全部知识库</option>' + kbs.map(k => '<option value="' + esc(k.name) + '"' + (k.name === cur ? ' selected' : '') + '>' + esc(k.name) + '</option>').join('');
  }
  const list = isProd() ? documents.filter(d => d.status === '已发布') : documents;
  const body = document.getElementById('docTable');
  if (!body) return;
  if (!list.length) {
    body.innerHTML = '<tr><td colspan="7"><div class="empty"><strong>' + (isProd() ? '生产环境暂无已发布文档' : '暂无文档') + '</strong><br><small>' + (isProd() ? '生产dataset只包含已发布版本。' : '请先创建知识库，然后上传第一份知识文档。') + '</small></div></td></tr>';
    return;
  }
  body.innerHTML = list.map(doc => '<tr class="doc-row" data-name="' + esc(doc.title) + '" data-status="' + esc(doc.status) + '" data-kb="' + esc(doc.kb_name) + '"><td><strong>' + esc(doc.title) + '</strong><br><small>' + esc(doc.id) + ' · ' + esc(doc.version) + ' · ' + esc(doc.extension) + '</small></td><td>' + esc(doc.type) + '</td><td>' + esc(doc.channel) + '<br><small>' + esc(doc.validity) + '</small></td><td>' + esc(doc.owner) + '</td><td><span class="status ' + statusClass(doc.status) + '">' + esc(doc.status) + '</span></td><td>' + ragEnv(doc.status) + '</td><td style="white-space:nowrap">' + rowActions(doc) + '</td></tr>').join('');
  filterDocs();
}

export function filterDocs() {
  const q = (document.getElementById('docSearch').value || '').toLowerCase();
  const s = document.getElementById('docStatus').value;
  const kb = document.getElementById('docKB').value;
  document.querySelectorAll('.doc-row').forEach(r => {
    const show = (!q || r.dataset.name.toLowerCase().includes(q)) && (!s || r.dataset.status === s) && (!kb || r.dataset.kb === kb);
    r.style.display = show ? '' : 'none';
  });
}

export async function openUpload(selectedKB) {
  if (isProd()) return toast('生产环境为只读，请切换到测试环境上传');
  const { kbs } = await get('/api/kb');
  const active = kbs.filter(k => k.status !== '已归档');
  if (!active.length) {
    showModal('请先创建知识库', '<div class="empty-kb"><div class="empty-icon">＋</div><h4>当前还没有知识库</h4><p>文档必须归属于一个知识库。请先创建知识库，再上传文档。</p></div>', '<button class="btn" onclick="closeModal()">取消</button><button class="btn primary" onclick="closeModal();showView(\'knowledge\');openCreateKB()">新建知识库</button>');
    return;
  }
  const selected = selectedKB || (active[0] && active[0].name) || '';
  showModal('上传知识文档 · 保存草稿',
    '<input type="file" id="docFile" accept=".pdf,.docx,.txt,.md,.csv,.html" hidden onchange="pickFile(this)">' +
    '<label class="drop" id="fileDrop" for="docFile">点击选择知识文档<br><strong>支持PDF、DOCX、TXT、MD、CSV、HTML</strong><br><small>文件会保存到本机 data/uploads，并由 RAG 引擎解析</small></label>' +
    '<div class="field" style="margin-top:13px"><label>文档标题</label><input class="input" id="uploadTitle" style="width:100%" placeholder="选择文件后自动带入，可修改"></div>' +
    '<div class="field-row"><div class="field"><label>所属知识库</label><select class="select" id="uploadKB" style="width:100%">' + active.map(k => '<option ' + (k.name === selected ? 'selected' : '') + '>' + esc(k.name) + '</option>').join('') + '</select></div>' +
    '<div class="field"><label>知识类型</label><select class="select" id="uploadType" style="width:100%"><option>政策/SOP</option><option>产品手册</option><option>FAQ</option><option>客服话术</option></select></div>' +
    '<div class="field"><label>适用渠道</label><select class="select" id="uploadChannel" style="width:100%"><option>全渠道</option><option>天猫</option><option>京东</option><option>自营商城</option></select></div>' +
    '<div class="field"><label>负责人</label><input class="input" id="uploadOwner" value="' + esc(store.me ? store.me.name : '知识运营') + '"></div>' +
    '<div class="field"><label>版本</label><input class="input" id="uploadVersion" value="v1.0"></div>' +
    '<div class="field"><label>生效 / 失效</label><input class="input" id="uploadValidity" placeholder="例如：2026-08-01 ～ 2027-07-31"></div></div>' +
    '<div class="alert"><strong>保存边界</strong>保存后文档状态为“草稿”；提交业务审核并通过后才会创建测试入库任务。</div>',
    '<button class="btn" onclick="closeModal()">取消</button><button class="btn primary" onclick="saveDraftFromUpload()">保存草稿</button>');
}

export function pickFile(input) {
  const file = input.files && input.files[0];
  if (!file) return;
  const drop = document.getElementById('fileDrop');
  const title = document.getElementById('uploadTitle');
  drop.classList.add('file-picked');
  drop.innerHTML = '✓ 已选择：<strong>' + esc(file.name) + '</strong><br><small>' + Math.max(1, Math.round(file.size / 1024)) + 'KB · 等待保存</small>';
  if (!title.value) title.value = file.name.replace(/\.[^.]+$/, '');
}

export async function saveDraftFromUpload() {
  const input = document.getElementById('docFile');
  const file = input.files && input.files[0];
  const title = document.getElementById('uploadTitle').value.trim();
  if (!file) return toast('请先选择一份文档');
  if (!title) return toast('请填写文档标题');
  const kbName = document.getElementById('uploadKB').value;
  const { kbs } = await get('/api/kb');
  const kb = kbs.find(k => k.name === kbName);
  if (!kb) return toast('请选择知识库');
  const params = new URLSearchParams({
    filename: file.name, kbId: kb.id, title,
    type: document.getElementById('uploadType').value,
    channel: document.getElementById('uploadChannel').value,
    owner: document.getElementById('uploadOwner').value.trim() || '知识运营',
    version: document.getElementById('uploadVersion').value.trim() || 'v1.0',
    validity: document.getElementById('uploadValidity').value.trim() || '待补充'
  });
  try {
    const { document: doc } = await uploadFile('/api/documents/upload?' + params.toString(), file);
    closeModal(); toast('文档草稿已保存'); await refresh();
    setTimeout(() => openUserDocument(doc.id), 200);
  } catch (e) { toast(e.message); }
}

export async function openUserDocument(id) {
  const data = await get('/api/documents/' + id);
  const d = data.document;
  const job = data.job;
  const tabs = ['基本信息', '原文预览', '版本记录', '审核记录', 'RAG映射'];
  let body = '<div class="tabs" id="docDetailTabs">' + tabs.map((t, i) => '<button class="tab' + (i === 0 ? ' active' : '') + '" onclick="switchDocDetailTab(' + i + ',this)">' + t + '</button>').join('') + '</div>';
  body += '<div class="doc-detail-pane" data-pane="0" style="padding-top:10px"><table><tr><td>所属知识库</td><td>' + esc(d.kb_name) + '</td></tr><tr><td>docId</td><td>' + esc(d.id) + '</td></tr><tr><td>原文件</td><td>' + esc(d.file_name || '—') + '</td></tr><tr><td>类型 / 渠道</td><td>' + esc(d.type) + ' / ' + esc(d.channel) + '</td></tr><tr><td>负责人 / 有效期</td><td>' + esc(d.owner) + ' / ' + esc(d.validity) + '</td></tr><tr><td>当前状态</td><td><span class="status ' + statusClass(d.status) + '">' + esc(d.status) + '</span></td></tr>' + (d.reject_reason ? '<tr><td>驳回原因</td><td>' + esc(d.reject_reason) + '</td></tr>' : '') + '</table></div>';
  body += '<div class="doc-detail-pane" data-pane="1" style="display:none;padding-top:10px"><div class="doc-preview" style="min-height:220px;white-space:pre-wrap">' + esc(d.content_text || '（未能提取正文；可配置 Dify 解析或上传文本类文件）') + '</div></div>';
  body += '<div class="doc-detail-pane" data-pane="2" style="display:none;padding-top:10px"><table><thead><tr><th>版本</th><th>说明</th><th>创建时间</th><th>状态</th><th>操作人</th></tr></thead><tbody>' + (data.versions.length ? data.versions.map(v => '<tr><td>' + esc(v.version) + '</td><td>' + esc(v.note) + '</td><td>' + fmt(v.created_at) + '</td><td>' + esc(v.status) + '</td><td>' + esc(v.author) + '</td></tr>').join('') : '<tr><td colspan="5">暂无版本记录</td></tr>') + '</tbody></table></div>';
  body += '<div class="doc-detail-pane" data-pane="3" style="display:none;padding-top:10px"><table><thead><tr><th>提交人</th><th>审核人</th><th>结论</th><th>驳回原因</th><th>时间</th></tr></thead><tbody>' + (data.reviews.length ? data.reviews.map(r => '<tr><td>' + esc(r.submitter || '—') + '</td><td>' + esc(r.reviewer || '—') + '</td><td>' + esc(r.verdict || '待审核') + '</td><td>' + esc(r.reject_reason || '—') + '</td><td>' + fmt(r.decided_at || r.created_at) + '</td></tr>').join('') : '<tr><td colspan="5">暂无审核记录</td></tr>') + '</tbody></table></div>';
  body += '<div class="doc-detail-pane" data-pane="4" style="display:none;padding-top:10px">' + (job ? '<table><tr><td>环境 / datasetId</td><td>' + esc(job.environment) + ' / ' + esc(job.dataset_id || '尚未创建') + '</td></tr><tr><td>RAG 文档ID</td><td>' + esc(job.dify_document_id || '本地引擎切片') + '</td></tr><tr><td>切片 / 向量 / 索引</td><td>' + job.chunk_count + ' / ' + job.vector_count + ' / ' + job.index_count + '</td></tr><tr><td>任务状态</td><td>' + esc(job.status) + '</td></tr>' + (job.error ? '<tr><td>错误</td><td style="color:var(--red)">' + esc(job.error) + '</td></tr>' : '') + '</table>' : '<div class="alert">该文档尚未创建RAG入库任务。</div>') + '</div>';
  const foot = '<button class="btn" onclick="closeModal()">关闭</button>' +
    (isProd() ? '' : d.status === '草稿' ? '<button class="btn primary" onclick="closeModal();submitNewDoc(\'' + d.id + '\')">提交审核</button>' :
      d.status === '待线下审批' ? '<button class="btn primary" onclick="closeModal();openReleaseApproval(\'' + d.id + '\')">进入发布审批</button>' :
        d.status === '已发布' ? '<button class="btn primary" onclick="closeModal();newVersion(\'' + d.id + '\')">创建新版本</button>' : '');
  showModal(d.title, body, foot);
}

export function switchDocDetailTab(index, button) {
  document.querySelectorAll('#docDetailTabs .tab').forEach((b, i) => b.classList.toggle('active', i === index));
  document.querySelectorAll('.doc-detail-pane').forEach(p => p.style.display = p.dataset.pane === String(index) ? 'block' : 'none');
}

export async function submitNewDoc(id) {
  try {
    await post('/api/documents/' + id + '/submit', {});
    closeModal(); toast('文档已提交业务审核'); await refresh();
    setTimeout(() => showView('review'), 300);
  } catch (e) { toast(e.message); }
}

export function newVersion(id) {
  showModal('创建新版本', '<div class="alert"><strong>不会覆盖当前线上版本</strong>新版本完成审核、测试入库和评测之前，当前版本继续服务。</div><div class="field"><label>新版本号</label><input class="input" id="newVersionNo" style="width:100%" value="v1.1"></div><div class="field"><label>变更说明</label><textarea class="textarea" id="newVersionNote" rows="3">补充相关FAQ与适用条件。</textarea></div>',
    '<button class="btn" onclick="closeModal()">取消</button><button class="btn primary" onclick="confirmNewVersion(\'' + id + '\')">创建草稿版本</button>');
}

export async function confirmNewVersion(id) {
  try {
    await post('/api/documents/' + id + '/new-version', { version: document.getElementById('newVersionNo').value.trim() || 'v1.1', note: document.getElementById('newVersionNote').value.trim() });
    closeModal(); toast('新版本草稿已创建'); await refresh();
  } catch (e) { toast(e.message); }
}

export async function openReleaseApproval(docId) {
  const ev = await get('/api/releases/' + docId + '/evidence');
  const runs = ev.runs || [];
  const runOf = m => runs.find(r => r.mode === m);
  const q = runOf('quick'), f = runOf('formal'), r = runOf('regression');
  showModal('发布审批 · ' + ev.doc.title,
    '<div class="alert warn"><strong>线下审批结果登记</strong>这里只查看发布证据并登记最终结论。审批通过后文档状态变为“已发布”。</div>' +
    '<table><tr><td>文档版本</td><td>' + esc(ev.doc.title) + ' ' + esc(ev.doc.version) + '</td></tr><tr><td>所属知识库</td><td>' + esc(ev.doc.kb_name) + '</td></tr>' +
    '<tr><td>冒烟评测</td><td>' + (q ? '<span class="status live">' + q.passed_count + '/' + q.count + '</span>' : '<span class="status gray">未运行</span>') + '</td></tr>' +
    '<tr><td>正式评测</td><td>' + (f ? '<span class="status live">' + f.passed_count + '/' + f.count + ' · ' + (f.pass_rate * 100).toFixed(1) + '%</span>' : '<span class="status gray">未运行</span>') + '</td></tr>' +
    '<tr><td>全量回归</td><td>' + (r ? '<span class="status live">' + r.passed_count + '/' + r.count + ' · ' + (r.pass_rate * 100).toFixed(1) + '%</span>' : '<span class="status gray">未运行</span>') + '</td></tr>' +
    '<tr><td>客服对话验收</td><td>' + (ev.dialogue && ev.dialogue.passed ? '<span class="status live">5/5通过</span>' : '<span class="status gray">未通过/未登记</span>') + '</td></tr>' +
    '<tr><td>未处理问题</td><td><span class="status ' + (ev.unresolved ? 'failed' : 'live') + '">' + ev.unresolved + ' 条</span></td></tr></table>' +
    '<div class="field" style="margin-top:12px"><label>审批意见（驳回时必填）</label><textarea class="textarea" id="releaseNote" rows="2"></textarea></div>',
    '<button class="btn danger" onclick="rejectReleaseApproval(\'' + docId + '\')">审批驳回</button><button class="btn primary" onclick="approveReleaseApproval(\'' + docId + '\')">审批通过并发布</button>');
}

export async function approveReleaseApproval(docId) {
  try {
    const res = await post('/api/releases/' + docId + '/approve', {});
    closeModal(); toast('审批通过，已发布（引擎：' + res.engine + '）'); await refresh();
    setTimeout(() => showView('documents'), 200);
  } catch (e) { toast(e.message); }
}

export async function rejectReleaseApproval(docId) {
  const note = (document.getElementById('releaseNote') || {}).value || '';
  if (!note.trim()) return toast('请填写驳回原因');
  try {
    await post('/api/releases/' + docId + '/reject', { reason: note.trim() });
    closeModal(); toast('审批已驳回'); await refresh();
  } catch (e) { toast(e.message); }
}

export function downloadFaqTemplate() {
  const csv = '问题,标准答案,关键词,适用渠道,生效日期,失效日期,负责人\n如何确认购买的充电宝是正品？,请核对包装防伪码与机身序列号。,正品;防伪;序列号,全渠道,2026-08-01,2027-07-31,王敏\n';
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'FAQ导入模板.csv';
  a.click();
}

Object.assign(window, { filterDocs, openUpload, pickFile, saveDraftFromUpload, openUserDocument, switchDocDetailTab, submitNewDoc, newVersion, confirmNewVersion, openReleaseApproval, approveReleaseApproval, rejectReleaseApproval, downloadFaqTemplate });
