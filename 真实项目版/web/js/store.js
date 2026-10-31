import { get, post } from './api.js';

export const ROLES = {
  operator: { name: '知识运营', short: '运营' },
  reviewer: { name: '业务审核人', short: '审核' },
  tester: { name: 'AI产品经理', short: '评测' },
  approver: { name: '发布审批人', short: '审批' },
  admin: { name: '系统管理员', short: '管理' }
};

export const store = {
  me: null,
  env: localStorage.getItem('rag-env') === 'prod' ? 'prod' : 'test',
  view: 'overview',
  engine: { configured: false, completionConfigured: false, baseUrl: '' }
};

let renderer = null;
export function setRenderer(fn) { renderer = fn; }
export async function refresh() {
  await refreshBadges();
  if (renderer) return renderer();
}
export function roleName() { return store.me ? (ROLES[store.me.role] ? ROLES[store.me.role].name : store.me.role) : '未登录'; }
export function isProd() { return store.env === 'prod'; }
export function setEnv(env) {
  store.env = env;
  localStorage.setItem('rag-env', env);
  refresh();
}

export async function refreshBadges() {
  try {
    const [reviews, jobs, cases] = await Promise.all([get('/api/reviews'), get('/api/jobs'), get('/api/cases')]);
    const pendingReview = reviews.pending.length;
    const pendingJobs = jobs.jobs.filter(j => ['待推送', '处理中', '待验收'].includes(j.status)).length;
    const pendingCases = cases.cases.filter(c => c.status !== '已处理').length;
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = String(v); };
    set('reviewCount', pendingReview);
    set('ingestionCount', pendingJobs);
    set('caseCount', pendingCases);
  } catch (e) { /* 未登录时忽略 */ }
}

export async function loadEngineStatus() {
  try {
    store.engine = await get('/api/engine-config');
    const health = document.getElementById('engineHealth');
    if (health) {
      health.textContent = store.engine.configured
        ? ('Dify 已连接' + (store.engine.completionConfigured ? ' · 生成可用' : ' · 仅检索'))
        : store.engine.completionConfigured ? '本地检索 + Dify 生成' : '本地引擎（未配置 Dify）';
    }
  } catch (e) { /* ignore */ }
}
