import { get, post } from './api.js';
import { esc, toast, closeModal, runConfirmAction, confirmModal } from './ui.js';
import { store, setRenderer, refresh, refreshBadges, loadEngineStatus, ROLES, roleName, isProd } from './store.js';

import { render as overviewView } from './views/overview.js';
import { render as analyticsView } from './views/analytics.js';
import { render as knowledgeView } from './views/knowledge.js';
import { render as documentsView } from './views/documents.js';
import { render as sourcesView } from './views/sources.js';
import { render as reviewView } from './views/review.js';
import { render as ingestionView } from './views/ingestion.js';
import { render as processingView } from './views/processing.js';
import { render as retrievalView } from './views/retrieval.js';
import { render as evaluationView } from './views/evaluation.js';
import { render as casesView } from './views/cases.js';
import { render as permissionsView } from './views/permissions.js';
import { render as integrationView } from './views/integration.js';

const TITLES = {
  overview: '运营总览', analytics: '运营统计', knowledge: '知识库管理', documents: '文档与版本',
  sources: '数据源同步', review: '业务审核', ingestion: '入库任务', processing: '处理结果验收',
  retrieval: '检索调试', evaluation: '批量评测与发布', cases: '问题案例',
  permissions: '权限与审计', integration: 'RAG引擎配置'
};
const VIEWS = {
  overview: overviewView, analytics: analyticsView, knowledge: knowledgeView, documents: documentsView,
  sources: sourcesView, review: reviewView, ingestion: ingestionView, processing: processingView,
  retrieval: retrievalView, evaluation: evaluationView, cases: casesView,
  permissions: permissionsView, integration: integrationView
};

function renderEnvBanner() {
  const el = document.getElementById('envBanner');
  if (!el) return;
  if (isProd()) {
    el.className = 'alert warn';
    el.innerHTML = '<strong>生产环境 · 只读视图</strong>只展示已发布知识、生产入库任务和线上版本。上传、审核、入库推送、检索调试、批量评测等治理操作请在测试环境完成；发布审批在“文档与版本”的待审批文档上进行。';
  } else {
    el.className = 'alert good';
    el.innerHTML = '<strong>测试环境 · 知识治理工作区</strong>测试dataset与生产dataset相互隔离。上传、业务审核、RAG入库、处理验收、检索调试、批量评测与客服对话验收都在这里完成，通过线下发布审批后才会进入生产环境。';
  }
}

function renderSidebarUser() {
  const el = document.getElementById('sidebarUser');
  if (!el || !store.me) return;
  el.innerHTML =
    '<div style="display:flex;justify-content:space-between;align-items:center;gap:8px">' +
      '<div><strong>' + esc(store.me.name) + '</strong><br><span style="font-size:10px">' + esc(roleName()) + ' · ' + esc(store.me.username) + '</span></div>' +
      '<button class="btn small ghost" style="color:#9db6cf" onclick="logout()">退出</button>' +
    '</div>' +
    (store.me.role === 'admin' ? '<button class="btn small ghost" style="color:#9db6cf;margin-top:6px;padding:2px 0" onclick="resetDemo()">↺ 重置演示数据</button>' : '');
  const avatar = document.getElementById('avatarName');
  if (avatar) avatar.textContent = ROLES[store.me.role] ? ROLES[store.me.role].short : '用户';
}

async function renderView(id) {
  const view = VIEWS[id];
  if (!view) return;
  renderEnvBanner();
  try {
    await view();
  } catch (e) {
    console.error('[view]', id, e);
    toast(e.message || '页面加载失败');
  }
}

export function showView(id) {
  if (!VIEWS[id]) return;
  store.view = id;
  document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === id));
  document.querySelectorAll('.nav-btn[data-view]').forEach(b => b.classList.toggle('active', b.dataset.view === id));
  const crumb = document.getElementById('crumbTitle');
  if (crumb) crumb.textContent = TITLES[id] || id;
  const ws = document.querySelector('.workspace');
  if (ws) ws.scrollTop = 0;
  renderView(id);
}

async function logout() {
  try { await post('/api/auth/logout', {}); } catch (e) { /* ignore */ }
  location.href = '/login.html';
}

function resetDemo() {
  confirmModal('重置演示数据', '将清空本机数据库中的全部演示数据并恢复种子数据，当前会话会退出。此操作不可撤销。', async () => {
    try {
      await post('/api/admin/reset', {});
      location.href = '/login.html';
    } catch (e) { toast(e.message); }
  });
}

async function boot() {
  let me = null;
  try { me = await get('/api/me'); } catch (e) { location.href = '/login.html'; return; }
  store.me = me.user;
  renderSidebarUser();
  document.querySelectorAll('.env-switch button').forEach(b => b.classList.toggle('active', b.dataset.env === store.env));
  document.querySelectorAll('.nav-btn[data-view]').forEach(b => b.addEventListener('click', () => showView(b.dataset.view)));
  setRenderer(() => renderView(store.view));
  await refreshBadges();
  await loadEngineStatus();
  await renderView('overview');
  setInterval(() => { refreshBadges(); }, 15000);
}

/* 全局处理器（供内联 onclick 使用） */
Object.assign(window, {
  showView,
  setEnv: (env) => { import('./store.js').then(m => m.setEnv(env)); },
  toast,
  closeModal,
  runConfirmAction,
  logout,
  resetDemo
});

boot();
