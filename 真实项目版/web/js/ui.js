export const esc = (value) => String(value == null ? '' : value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function toast(message) {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = message;
  t.classList.add('show');
  clearTimeout(window.__toastTimer);
  window.__toastTimer = setTimeout(() => t.classList.remove('show'), 2400);
}

export function showModal(title, body, foot) {
  document.getElementById('modalTitle').textContent = title;
  document.getElementById('modalBody').innerHTML = body;
  document.getElementById('modalFoot').innerHTML = foot || '<button class="btn" onclick="closeModal()">关闭</button>';
  document.getElementById('modal').classList.add('show');
}
export function closeModal() { document.getElementById('modal').classList.remove('show'); }

export function fmt(iso) {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleString('zh-CN', { hour12: false });
  } catch (e) { return iso; }
}

export const statusClass = (status) => status === '已发布' ? 'live' : status === '草稿' ? 'gray' : status === '待线下审批' ? 'pending' : status === '待问题修复' ? 'failed' : 'processing';
export const ragEnv = (status) => status === '已发布' ? '测试 ✓ / 生产 ✓' : status === '待线下审批' ? '测试 ✓ / 生产 —' : (status === '草稿' || status === '待审核') ? '尚未同步' : '测试环境处理中';

export function setHtml(id, html) { const el = document.getElementById(id); if (el) el.innerHTML = html; }
export function setText(id, text) { const el = document.getElementById(id); if (el) el.textContent = text; }

export function emptyBlock(title, text, button) {
  return '<div class="empty-kb"><div class="empty-icon">○</div><h4>' + esc(title) + '</h4><p>' + esc(text) + '</p>' + (button || '') + '</div>';
}

export function confirmModal(title, text, onConfirm) {
  window.__confirmAction = onConfirm;
  showModal(title, '<div class="alert warn"><strong>' + esc(title) + '</strong>' + esc(text) + '</div>',
    '<button class="btn" onclick="closeModal()">取消</button><button class="btn primary" onclick="runConfirmAction()">确认</button>');
}
export function runConfirmAction() {
  const fn = window.__confirmAction;
  window.__confirmAction = null;
  closeModal();
  if (typeof fn === 'function') fn();
}
