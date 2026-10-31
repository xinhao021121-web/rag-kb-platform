import { get, post, put } from '../api.js';
import { esc, toast, setText } from '../ui.js';
import { store, refresh } from '../store.js';

export async function render() {
  const [cfg, kbs] = await Promise.all([get('/api/engine-config'), get('/api/kb')]);
  store.engine = cfg;
  const base = document.getElementById('difyBaseUrl');
  if (base) base.value = cfg.baseUrl || '';
  const dk = document.getElementById('difyDatasetKey');
  if (dk) dk.placeholder = cfg.datasetKeyMasked ? ('已保存：' + cfg.datasetKeyMasked + '（留空表示不修改）') : 'dataset-xxxx';
  const ck = document.getElementById('difyCompletionKey');
  if (ck) ck.placeholder = cfg.completionKeyMasked ? ('已保存：' + cfg.completionKeyMasked + '（留空表示不修改）') : 'app-xxxx（可选）';
  const au = document.getElementById('difyAppUser');
  if (au) au.value = cfg.appUser || 'rag-platform-local';
  const status = document.getElementById('connectionStatus');
  if (status) {
    status.className = 'status ' + (cfg.configured ? 'live' : cfg.completionConfigured ? 'processing' : 'pending');
    status.textContent = cfg.configured ? ('Dify 已配置' + (cfg.completionConfigured ? ' · 生成可用' : ' · 仅检索')) : cfg.completionConfigured ? '本地检索 + Dify 生成' : '本地引擎';
  }
  const health = document.getElementById('engineHealth');
  if (health) health.textContent = cfg.configured ? ('Dify 已连接' + (cfg.completionConfigured ? ' · 生成可用' : ' · 仅检索')) : cfg.completionConfigured ? '本地检索 + Dify 生成' : '本地引擎（未配置 Dify）';
  const body = document.getElementById('envMappingTable');
  if (body) body.innerHTML = kbs.kbs.map(k => '<tr><td>' + esc(k.name) + '</td><td>' + esc(k.test_dataset_id || '尚未创建') + '</td><td>' + esc(k.prod_dataset_id || '尚未创建') + '</td></tr>').join('') || '<tr><td colspan="3">暂无知识库</td></tr>';
  const iso = document.getElementById('isolationCheck');
  if (iso) iso.innerHTML = '<strong>隔离检查</strong>测试 dataset ' + kbs.kbs.filter(k => k.test_dataset_id).length + ' 个 · 生产 dataset ' + kbs.kbs.filter(k => k.prod_dataset_id).length + ' 个；生产 dataset 只写入审批通过的版本。';
}

export async function saveIntegration() {
  const payload = {
    baseUrl: (document.getElementById('difyBaseUrl') || {}).value || '',
    appUser: (document.getElementById('difyAppUser') || {}).value || ''
  };
  const dk = (document.getElementById('difyDatasetKey') || {}).value;
  const ck = (document.getElementById('difyCompletionKey') || {}).value;
  if (dk) payload.datasetKey = dk;
  if (ck) payload.completionKey = ck;
  try {
    await put('/api/engine-config', payload);
    document.getElementById('difyDatasetKey').value = '';
    document.getElementById('difyCompletionKey').value = '';
    toast('配置已保存（密钥不会返回浏览器）'); await refresh();
  } catch (e) { toast(e.message); }
}

export async function testConnection() {
  const status = document.getElementById('connectionStatus');
  if (status) { status.className = 'status processing'; status.textContent = '测试中…'; }
  try {
    const res = await post('/api/engine-config/test', {});
    if (status) { status.className = 'status live'; status.textContent = '连接成功'; }
    toast('Dify 连接成功（数据集 ' + (res.total != null ? res.total : '?') + ' 个）');
  } catch (e) {
    if (status) { status.className = 'status failed'; status.textContent = '连接失败'; }
    toast(e.message);
  }
}

export function providerChanged() { /* 当前仅实现 Dify 适配 */ }

Object.assign(window, { testConnection, saveIntegration, providerChanged });
