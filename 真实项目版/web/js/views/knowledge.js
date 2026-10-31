import { get, post, patch } from '../api.js';
import { esc, toast, showModal, closeModal } from '../ui.js';
import { store, isProd, refresh } from '../store.js';

function cardHtml(kb) {
  const archived = kb.status === '已归档';
  const docCount = isProd() ? kb.publishedCount : kb.docCount;
  return '<article class="kb-card" data-name="' + esc(kb.name) + '" data-domain="' + esc(kb.domain) + '" data-status="' + esc(kb.status) + '" onclick="openKB(\'' + kb.id + '\')" style="' + (archived ? 'opacity:.6' : '') + '">' +
    '<div class="kb-card-head"><div class="kb-icon">' + esc(String(kb.name).slice(0, 1)) + '</div><span class="status ' + (archived ? 'gray' : kb.status === '运行中' ? 'live' : 'pending') + '">' + esc(kb.status) + '</span></div>' +
    '<h3>' + esc(kb.name) + '</h3><p>' + esc(kb.description || '知识库') + '</p>' +
    '<div class="kb-meta"><span>文档<strong>' + docCount + '</strong></span><span>已发布<strong>' + kb.publishedCount + '</strong></span><span>负责人<strong>' + esc(kb.owner) + '</strong></span></div>' +
    '<div style="display:flex;gap:6px;margin-top:10px;flex-wrap:wrap"><span class="status ' + (kb.test_rag_status === '正常' ? 'processing' : 'gray') + '">测试RAG ' + esc(kb.test_rag_status || '未接入') + '</span><span class="status ' + (kb.prod_rag_status === '正常' ? 'live' : 'gray') + '">生产RAG ' + esc(kb.prod_rag_status || '未接入') + '</span></div></article>';
}

export async function render() {
  const { kbs } = await get('/api/kb');
  const wrap = document.getElementById('kbCards');
  if (!wrap) return;
  wrap.innerHTML = kbs.length ? kbs.map(cardHtml).join('')
    : '<div class="empty-kb" style="grid-column:1/-1"><div class="empty-icon">＋</div><h4>还没有知识库</h4><p>创建第一个知识库后，再上传文档、提交审核并进入RAG处理。</p><button class="btn primary" onclick="openCreateKB()">新建知识库</button></div>';
  filterKB();
}

export function filterKB() {
  const q = (document.getElementById('kbSearch').value || '').toLowerCase();
  const d = document.getElementById('kbDomain').value;
  const s = document.getElementById('kbStatus').value;
  document.querySelectorAll('#kbCards .kb-card').forEach(c => {
    const show = (!q || c.dataset.name.toLowerCase().includes(q)) && (!d || c.dataset.domain === d) && (!s || c.dataset.status === s);
    c.style.display = show ? '' : 'none';
  });
}

export async function openKB(id) {
  const { kbs } = await get('/api/kb');
  const kb = kbs.find(k => k.id === id);
  if (!kb) return toast('知识库不存在');
  const { documents } = await get('/api/documents' + (isProd() ? '?status=已发布' : ''));
  const docs = documents.filter(d => d.kb_id === id);
  let body = '<div class="metric-row" style="grid-template-columns:repeat(3,1fr)"><div class="metric"><label>知识文档</label><strong>' + docs.length + '</strong></div><div class="metric good"><label>已发布</label><strong>' + docs.filter(d => d.status === '已发布').length + '</strong></div><div class="metric"><label>进行中</label><strong>' + docs.filter(d => d.status !== '已发布').length + '</strong></div></div>' +
    '<table style="margin-top:14px"><tr><td>业务域 / 负责人</td><td>' + esc(kb.domain) + ' / ' + esc(kb.owner) + '</td></tr><tr><td>可见范围</td><td>' + esc(kb.scope) + '</td></tr>' +
    '<tr><td>测试 RAG 资源</td><td>' + esc(kb.test_dataset_id || '尚未创建') + ' · <span class="status ' + (kb.test_rag_status === '正常' ? 'processing' : 'gray') + '">' + esc(kb.test_rag_status) + '</span></td></tr>' +
    '<tr><td>生产 RAG 资源</td><td>' + esc(kb.prod_dataset_id || '尚未创建') + ' · <span class="status ' + (kb.prod_rag_status === '正常' ? 'live' : 'gray') + '">' + esc(kb.prod_rag_status) + '</span></td></tr></table>';
  if (docs.length) {
    body += '<div class="panel" style="margin:14px 0 0;box-shadow:none"><div class="panel-head"><h2>文档（' + docs.length + '）</h2>' + (isProd() ? '' : '<button class="btn small primary" onclick="closeModal();openUpload(\'' + esc(kb.name) + '\')">继续上传</button>') + '</div><div class="panel-body" style="padding:0"><table><thead><tr><th>文档</th><th>版本</th><th>状态</th><th></th></tr></thead><tbody>' +
      docs.map(d => '<tr><td>' + esc(d.title) + '</td><td>' + esc(d.version) + '</td><td><span class="status ' + (d.status === '已发布' ? 'live' : d.status === '草稿' ? 'gray' : 'processing') + '">' + esc(d.status) + '</span></td><td><button class="btn small" onclick="closeModal();openUserDocument(\'' + d.id + '\')">详情</button></td></tr>').join('') +
      '</tbody></table></div></div>';
  } else {
    body += '<div class="empty-kb" style="margin-top:14px"><div class="empty-icon">＋</div><h4>知识库已经创建，但还没有文档</h4><p>下一步上传产品手册、售后政策、FAQ或客服SOP。</p></div>';
  }
  const foot = '<button class="btn" onclick="closeModal()">关闭</button>' +
    (isProd() ? '' : '<button class="btn" onclick="closeModal();openEditKB(\'' + kb.id + '\')">编辑</button>' +
      (kb.status === '已归档' ? '<button class="btn" onclick="closeModal();setKBArchived(\'' + kb.id + '\',false)">恢复</button>' : '<button class="btn danger" onclick="closeModal();setKBArchived(\'' + kb.id + '\',true)">归档</button>'));
  showModal(kb.name, body, foot);
}

export function openCreateKB() {
  showModal('新建知识库', '<div class="field-row"><div class="field"><label>知识库名称</label><input class="input" id="newKBName" value="充电器产品知识库"></div><div class="field"><label>业务域</label><select class="select" id="newKBDomain"><option>商品</option><option>售后</option><option>客服</option><option>渠道</option></select></div></div><div class="field-row"><div class="field"><label>负责人</label><input class="input" id="newKBOwner" value="陈浩"></div><div class="field"><label>可见范围</label><select class="select" id="newKBScope"><option>商品与客服团队</option><option>全公司</option><option>仅项目组</option></select></div></div><div class="alert"><strong>创建后会发生什么？</strong>系统会在首次推送文档时自动创建测试与生产 dataset；知识库先处于“建设中”。</div>',
    '<button class="btn" onclick="closeModal()">取消</button><button class="btn primary" onclick="createKB()">创建知识库</button>');
}

export async function createKB() {
  const name = document.getElementById('newKBName').value.trim();
  if (!name) return toast('请填写知识库名称');
  try {
    await post('/api/kb', { name, domain: document.getElementById('newKBDomain').value, owner: document.getElementById('newKBOwner').value.trim() || '待分配', scope: document.getElementById('newKBScope').value });
    closeModal(); toast('知识库已创建'); await refresh();
  } catch (e) { toast(e.message); }
}

export async function openEditKB(id) {
  const { kbs } = await get('/api/kb');
  const kb = kbs.find(k => k.id === id);
  if (!kb) return;
  showModal('编辑知识库', '<div class="field-row"><div class="field"><label>名称</label><input class="input" id="editKBName" value="' + esc(kb.name) + '"></div><div class="field"><label>业务域</label><select class="select" id="editKBDomain">' + ['商品', '售后', '客服', '渠道'].map(x => '<option ' + (x === kb.domain ? 'selected' : '') + '>' + x + '</option>').join('') + '</select></div></div><div class="field-row"><div class="field"><label>负责人</label><input class="input" id="editKBOwner" value="' + esc(kb.owner) + '"></div><div class="field"><label>状态</label><select class="select" id="editKBStatus">' + ['运行中', '建设中', '已归档'].map(x => '<option ' + (x === kb.status ? 'selected' : '') + '>' + x + '</option>').join('') + '</select></div></div><div class="field"><label>可见范围</label><input class="input" id="editKBScope" style="width:100%" value="' + esc(kb.scope) + '"></div>',
    '<button class="btn" onclick="closeModal()">取消</button><button class="btn primary" onclick="saveKBEdit(\'' + kb.id + '\')">保存</button>');
}

export async function saveKBEdit(id) {
  try {
    await patch('/api/kb/' + id, { name: document.getElementById('editKBName').value.trim(), domain: document.getElementById('editKBDomain').value, owner: document.getElementById('editKBOwner').value.trim(), status: document.getElementById('editKBStatus').value, scope: document.getElementById('editKBScope').value.trim() });
    closeModal(); toast('知识库已更新'); await refresh();
  } catch (e) { toast(e.message); }
}

export async function setKBArchived(id, archived) {
  try {
    await post('/api/kb/' + id + '/archive', { archived });
    closeModal(); toast(archived ? '知识库已归档' : '知识库已恢复'); await refresh();
  } catch (e) { toast(e.message); }
}

Object.assign(window, { filterKB, openKB, openCreateKB, createKB, openEditKB, saveKBEdit, setKBArchived });
