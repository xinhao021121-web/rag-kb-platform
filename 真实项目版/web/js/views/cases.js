import { get, post } from '../api.js';
import { esc, toast, showModal, closeModal, fmt } from '../ui.js';
import { isProd, refresh } from '../store.js';

let filter = 'all';

export async function render() {
  const view = document.getElementById('cases');
  const head = view && view.querySelector('.page-head');
  if (!view || !head) return;
  Array.from(view.children).forEach(c => { if (c !== head) c.remove(); });
  const { cases } = await get('/api/cases');
  const actions = head.querySelector('.actions');
  const pending = cases.filter(c => c.status !== '已处理').length;
  if (actions) actions.innerHTML = '<span class="status ' + (pending ? 'pending' : 'live') + '">' + (pending ? '待处理 ' + pending : '全部处理完成') + '</span>';
  const list = cases.filter(c => filter === 'all' || (filter === 'evaluation' ? ['quick', 'formal', 'regression'].includes(c.source_mode) : c.source_mode === filter));
  if (!cases.length) {
    view.insertAdjacentHTML('beforeend', '<div class="panel"><div class="empty-kb"><div class="empty-icon">✓</div><h4>暂无问题案例</h4><p>检索调试人工标记、批量评测失败和客服对话验收失败会进入这里。</p></div></div>');
    return;
  }
  const count = m => cases.filter(c => m === 'retrieval' ? c.source_mode === 'retrieval' : m === 'evaluation' ? ['quick', 'formal', 'regression'].includes(c.source_mode) : c.source_mode === 'dialogue').length;
  const tabs = '<div class="tabs">' +
    [['all', '全部 ' + cases.length], ['retrieval', '检索调试 ' + count('retrieval')], ['evaluation', '批量评测 ' + count('evaluation')], ['dialogue', '客服对话 ' + count('dialogue')]].map(([k, l]) => '<button class="tab ' + (filter === k ? 'active' : '') + '" onclick="renderProblemCases(\'' + k + '\')">' + l + '</button>').join('') + '</div>';
  const cards = list.length ? list.map(c => '<div class="case-card ' + (String(c.risk).includes('P0') ? 'p0' : '') + '"><div><h4>' + esc(c.id) + ' · ' + esc(c.question) + '</h4><p>' + esc(String(c.source)) + ' · ' + fmt(c.created_at) + '</p></div><div><small>风险</small><br><strong>' + esc(c.risk) + '</strong></div><div><small>状态</small><br><span class="status ' + (c.status === '已处理' ? 'live' : 'pending') + '">' + esc(c.status) + '</span></div><button class="btn small primary" onclick="openCase(\'' + c.id + '\')">查看证据</button></div>').join('') : '<div class="empty"><strong>当前来源下没有问题案例</strong></div>';
  view.insertAdjacentHTML('beforeend', '<div class="alert"><strong>平台只汇总问题并保留证据</strong>请在线下完成知识、切片、检索参数或话术修复，完成后回来标记“已处理”。</div>' +
    '<div class="metric-row" style="grid-template-columns:repeat(3,1fr)"><div class="metric"><label>问题总数</label><strong>' + cases.length + '</strong></div><div class="metric bad"><label>待处理</label><strong>' + pending + '</strong></div><div class="metric good"><label>已处理</label><strong>' + (cases.length - pending) + '</strong></div></div>' +
    '<div class="panel" style="margin-top:14px">' + tabs + '<div class="panel-body">' + cards + '</div></div>');
}

export function setFilter(next) { filter = next; render(); }

export async function openCase(id) {
  const { case: c, evidence } = await get('/api/cases/' + id);
  const ev = evidence || {};
  const retrieved = (ev.retrieved || []).map(r => 'Top ' + (r.rank || '') + '：' + (r.id || '') + ' ' + String(r.content || '').slice(0, 80)).join('<br>');
  showModal('问题证据 · ' + (c.evaluation_case_id || c.id),
    '<div class="alert warn"><strong>仅用于还原问题现场</strong>以下为只读证据，请在线下完成修复。</div>' +
    '<table><tr><td>来源类型</td><td>' + esc(c.source) + '</td></tr><tr><td>原始问题</td><td>' + esc(c.question) + '</td></tr><tr><td>实际结果</td><td>' + esc(c.ai_answer || '—') + '</td></tr><tr><td>预期结果</td><td>' + esc(c.expected || '—') + '</td></tr><tr><td>问题说明</td><td>' + esc(c.reason || '—') + '</td></tr>' + (retrieved ? '<tr><td>检索证据</td><td>' + retrieved + '</td></tr>' : '') + (ev.runId ? '<tr><td>运行ID</td><td>' + esc(ev.runId) + '</td></tr>' : '') + '<tr><td>发现时间</td><td>' + fmt(c.created_at) + '</td></tr>' + (c.processed_at ? '<tr><td>处理时间</td><td>' + fmt(c.processed_at) + '</td></tr>' : '') + '</table>',
    '<button class="btn" onclick="closeModal()">关闭</button>' + (c.status === '已处理' || isProd() ? '' : '<button class="btn primary" onclick="processCase(\'' + c.id + '\')">线下修复完成，标记已处理</button>'));
}

export async function processCase(id) {
  try {
    await post('/api/cases/' + id + '/process', {});
    closeModal(); toast('已标记为已处理'); await refresh();
  } catch (e) { toast(e.message); }
}

Object.assign(window, { renderProblemCases: (f) => { if (f) filter = f; render(); }, openCase, processCase });
