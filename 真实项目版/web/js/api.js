const JSON_HEADERS = { 'Content-Type': 'application/json' };

export async function api(path, options = {}) {
  const res = await fetch(path, options);
  if (res.status === 401) {
    if (!location.pathname.endsWith('login.html')) location.href = '/login.html';
    throw new Error('请先登录');
  }
  let json = null;
  try { json = await res.json(); } catch (e) { /* ignore */ }
  if (!res.ok || (json && json.ok === false)) {
    throw new Error((json && json.message) || ('请求失败：HTTP ' + res.status));
  }
  return json ? json.data : null;
}

export const get = (path) => api(path);
export const post = (path, body) => api(path, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body || {}) });
export const put = (path, body) => api(path, { method: 'PUT', headers: JSON_HEADERS, body: JSON.stringify(body || {}) });
export const patch = (path, body) => api(path, { method: 'PATCH', headers: JSON_HEADERS, body: JSON.stringify(body || {}) });
export const upload = (path, file) => api(path, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file });

export function qs(params) {
  const search = new URLSearchParams();
  Object.entries(params || {}).forEach(([k, v]) => { if (v !== undefined && v !== null && v !== '') search.set(k, v); });
  const s = search.toString();
  return s ? '?' + s : '';
}
