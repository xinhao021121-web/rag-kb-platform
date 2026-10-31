import { get, post } from '../api.js';
import { esc, toast, showModal, closeModal } from '../ui.js';
import { isProd, refresh } from '../store.js';

const CATEGORIES = ['A 文档类权威知识', 'B 结构化FAQ', 'C 样本与反馈', 'D 实时业务数据'];

export async function render() {
  const { sources } = await get('/api/sources');
  const body = document.getElementById('sourceTable');
  if (!body) return;
  body.innerHTML = sources.map(src => {
    let actions = isProd() ? '<span class="status gray">只读</span>' : '';
    if (!isProd()) {
      actions = '<button class="btn small" onclick="syncSource(\'' + src.id + '\')">立即同步</button> <button class="btn small" onclick="openSourceConfig(\'' + src.id + '\')">配置</button>';
      if (src.status === '部分失败') actions += ' <button class="btn small danger" onclick="retrySource(\'' + src.id + '\')">重试失败批次</button>';
      if (src.status === '已暂停') actions = '<button class="btn small" onclick="resumeSource(\'' + src.id + '\')">恢复</button> <button class="btn small" onclick="openSourceConfig(\'' + src.id + '\')">配置</button>';
    }
    const cls = src.status === '正常' ? 'live' : src.status === '部分失败' ? 'failed' : 'gray';
    return '<tr><td><strong>' + esc(src.name) + '</strong><br><small>' + esc(src.id) + ' · ' + esc(src.owner) + '</small></td><td><small>' + esc(src.category) + '</small></td><td>' + esc(src.method) + '</td><td>' + esc(src.frequency) + '</td><td>' + esc(src.last_result) + '</td><td><span class="status ' + cls + '">' + esc(src.status) + '</span></td><td style="white-space:nowrap">' + actions + '</td></tr>';
  }).join('') || '<tr><td colspan="7"><div class="empty">暂无数据源</div></td></tr>';
}

export function openSource() {
  showModal('新建数据源', '<div class="field-row"><div class="field"><label>数据源类型</label><select class="select" id="newSourceMethod"><option>REST API</option><option>在线文档</option><option>数据库只读副本</option><option>网页链接</option></select></div><div class="field"><label>名称</label><input class="input" id="newSourceName" value="新品说明书CMS"></div><div class="field"><label>数据类别</label><select class="select" id="newSourceCategory">' + CATEGORIES.map(c => '<option>' + c + '</option>').join('') + '</select></div><div class="field"><label>同步频率</label><select class="select" id="newSourceFrequency"><option>每小时</option><option>每天</option><option>每周</option><option>实时</option></select></div><div class="field"><label>负责人</label><input class="input" id="newSourceOwner" value="知识运营"></div></div><div class="field"><label>服务地址</label><input class="input" id="newSourceEndpoint" style="width:100%" value="https://cms.internal/api/knowledge"></div><div class="alert"><strong>同步规则</strong>A/B类生成草稿文档；C类只生成待确认草稿；D类不写入索引。</div>',
    '<button class="btn" onclick="closeModal()">取消</button><button class="btn primary" onclick="saveSource()">保存数据源</button>');
}

export async function saveSource() {
  const name = document.getElementById('newSourceName').value.trim();
  if (!name) return toast('请填写数据源名称');
  try {
    await post('/api/sources', { name, category: document.getElementById('newSourceCategory').value, method: document.getElementById('newSourceMethod').value, frequency: document.getElementById('newSourceFrequency').value, endpoint: document.getElementById('newSourceEndpoint').value, owner: document.getElementById('newSourceOwner').value });
    closeModal(); toast('数据源已创建'); await refresh();
  } catch (e) { toast(e.message); }
}

export async function openSourceConfig(id) {
  const { sources } = await get('/api/sources');
  const src = sources.find(s => s.id === id);
  if (!src) return;
  showModal('配置数据源 · ' + src.name, '<div class="field-row"><div class="field"><label>名称</label><input class="input" id="cfgSourceName" value="' + esc(src.name) + '"></div><div class="field"><label>数据类别</label><select class="select" id="cfgSourceCategory">' + CATEGORIES.map(c => '<option ' + (c === src.category ? 'selected' : '') + '>' + c + '</option>').join('') + '</select></div><div class="field"><label>接入方式</label><input class="input" id="cfgSourceMethod" value="' + esc(src.method) + '"></div><div class="field"><label>频率</label><select class="select" id="cfgSourceFrequency">' + ['每小时', '每天', '每周', '实时'].map(f => '<option ' + (f === src.frequency ? 'selected' : '') + '>' + f + '</option>').join('') + '</select></div></div><div class="field"><label>服务地址</label><input class="input" id="cfgSourceEndpoint" style="width:100%" value="' + esc(src.endpoint) + '"></div>',
    '<button class="btn" onclick="closeModal()">取消</button><button class="btn primary" onclick="saveSourceConfig(\'' + src.id + '\')">保存</button>');
}

export async function saveSourceConfig(id) {
  try {
    await post('/api/sources/' + id + '/config', { name: document.getElementById('cfgSourceName').value, category: document.getElementById('cfgSourceCategory').value, method: document.getElementById('cfgSourceMethod').value, frequency: document.getElementById('cfgSourceFrequency').value, endpoint: document.getElementById('cfgSourceEndpoint').value });
    closeModal(); toast('数据源配置已保存'); await refresh();
  } catch (e) { toast(e.message); }
}

export async function syncSource(id) {
  try {
    const res = await post('/api/sources/' + id + '/sync', {});
    toast(res.resultText);
    await refresh();
  } catch (e) { toast(e.message); }
}
export async function retrySource(id) {
  try { await post('/api/sources/' + id + '/retry', {}); toast('失败批次已幂等重试'); await refresh(); } catch (e) { toast(e.message); }
}
export async function resumeSource(id) {
  try { await post('/api/sources/' + id + '/resume', {}); toast('数据源已恢复'); await refresh(); } catch (e) { toast(e.message); }
}

Object.assign(window, { openSource, saveSource, openSourceConfig, saveSourceConfig, syncSource, retrySource, resumeSource, syncAll: async () => { const { sources } = await get('/api/sources'); for (const s of sources.filter(x => x.status !== '已暂停')) await syncSource(s.id); } });
