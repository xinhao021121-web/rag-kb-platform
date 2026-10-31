import { get, post } from '../api.js';
import { esc, toast, showModal, closeModal, fmt } from '../ui.js';
import { store, isProd, refresh } from '../store.js';

let pollTimer = null;

export async function render() {
  if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
  const { jobs } = await get('/api/jobs');
  const list = isProd() ? jobs.filter(j => j.environment === '生产') : jobs;
  const body = document.getElementById('ingestionJobTable');
  if (!body) return;
  if (!list.length) {
    body.innerHTML = '<tr><td colspan="7"><div class="empty"><strong>' + (isProd() ? '生产环境暂无入库任务' : '暂无入库任务') + '</strong><br><small>' + (isProd() ? '生产dataset只包含已发布版本。' : '文档通过业务审核后，系统会自动创建测试入库任务。') + '</small></div></td></tr>';
    return;
  }
  body.innerHTML = list.map(job => {
    let actions;
    if (isProd() || job.environment === '生产' || job.status === '已发布') {
      actions = '<button class="btn small" onclick="openUserJob(\'' + job.id + '\')">查看任务</button>';
    } else if (job.status === '待推送') {
      actions = '<button class="btn small primary" onclick="pushJobAPI(\'' + job.id + '\')">推送API</button> <button class="btn small" onclick="openUserJob(\'' + job.id + '\')">详情</button>';
    } else if (job.status === '处理中') {
      actions = '<button class="btn small" disabled>等待RAG回调</button> <button class="btn small" onclick="openUserJob(\'' + job.id + '\')">详情</button>';
    } else if (job.status === '待验收') {
      actions = '<button class="btn small primary" onclick="showView(\'processing\')">验收结果</button> <button class="btn small" onclick="openUserJob(\'' + job.id + '\')">详情</button>';
    } else if (job.status === '失败') {
      actions = '<button class="btn small danger" onclick="retryJob(\'' + job.id + '\')">重试</button> <button class="btn small" onclick="openUserJob(\'' + job.id + '\')">详情</button>';
    } else {
      actions = '<button class="btn small" onclick="openUserJob(\'' + job.id + '\')">查看任务</button>' + (['检索通过', '评测完成'].includes(job.status) ? ' <button class="btn small primary" onclick="showView(\'evaluation\')">去评测</button>' : '');
    }
    return '<tr class="job-row" data-env="' + esc(job.environment) + '" data-status="' + esc(job.status) + '" data-name="' + esc((job.id + ' ' + job.docTitle).toLowerCase()) + '">' +
      '<td><strong>' + esc(job.id) + '</strong><br><small>' + (job.dify_document_id ? 'dify: ' + esc(job.dify_document_id) : '本地引擎') + '</small></td>' +
      '<td><span class="status ' + (job.environment === '生产' ? 'live' : 'processing') + '">' + esc(job.environment) + '</span></td>' +
      '<td>' + esc(job.docTitle) + ' ' + esc(job.docVersion) + '</td>' +
      '<td>' + esc(job.step) + (job.error ? '<br><small style="color:var(--red)">' + esc(job.error) + '</small>' : '') + '</td>' +
      '<td style="min-width:150px"><div class="progress"><i style="width:' + Number(job.progress || 0) + '%"></i></div><small>' + job.progress + '% · ' + fmt(job.created_at) + '</small></td>' +
      '<td><span class="status ' + (job.status === '待验收' ? 'live' : job.status === '待推送' ? 'pending' : job.status === '失败' ? 'failed' : 'processing') + '">' + esc(job.status) + '</span></td>' +
      '<td style="white-space:nowrap">' + actions + '</td></tr>';
  }).join('');
  filterJobs();

  // 有处理中的任务时自动轮询刷新
  if (!isProd() && list.some(j => j.status === '处理中')) {
    pollTimer = setTimeout(() => { if (store.view === 'ingestion') render(); }, 2500);
  }
}

export function filterJobs() {
  const env = document.getElementById('jobEnv').value;
  const st = document.getElementById('jobStatus').value;
  const q = (document.getElementById('jobSearch').value || '').toLowerCase();
  document.querySelectorAll('.job-row').forEach(r => {
    const show = (!env || r.dataset.env === env) && (!st || r.dataset.status === st) && (!q || r.dataset.name.includes(q));
    r.style.display = show ? '' : 'none';
  });
}

export async function pushJobAPI(id) {
  try {
    const res = await post('/api/jobs/' + id + '/push', {});
    toast('已推送到 ' + (res.result.engine === 'dify' ? 'Dify，等待索引' : '本地引擎，处理完成'));
    await refresh();
  } catch (e) { toast(e.message); }
}

export async function retryJob(id) {
  try {
    await post('/api/jobs/' + id + '/retry', {});
    toast('已重新推送'); await refresh();
  } catch (e) { toast(e.message); }
}

export async function openUserJob(id) {
  const { job } = await get('/api/jobs/' + id + '/processing');
  showModal(job.status === '待验收' ? '处理结果待验收' : '入库任务详情',
    '<div class="alert ' + (job.status === '待验收' ? 'good' : 'warn') + '"><strong>' + esc(job.status) + '</strong>' + esc(job.step) + '</div>' +
    '<table><tr><td>jobId</td><td>' + esc(job.id) + '</td></tr><tr><td>文档版本</td><td>' + esc(job.docTitle) + ' ' + esc(job.docVersion) + '</td></tr><tr><td>环境 / datasetId</td><td>' + esc(job.environment) + ' / ' + esc(job.dataset_id || '尚未创建') + '</td></tr><tr><td>RAG 文档ID</td><td>' + esc(job.dify_document_id || '本地引擎') + '</td></tr><tr><td>切片 / 向量 / 索引</td><td>' + job.chunk_count + ' / ' + job.vector_count + ' / ' + job.index_count + '</td></tr>' + (job.error ? '<tr><td>错误</td><td style="color:var(--red)">' + esc(job.error) + '</td></tr>' : '') + '</table>',
    '<button class="btn" onclick="closeModal()">关闭</button>' + (job.status === '待验收' ? '<button class="btn primary" onclick="closeModal();showView(\'processing\')">进入结果验收</button>' : ''));
}

Object.assign(window, { renderIngestionJobs: render, filterJobs, pushJobAPI, retryJob, openUserJob });
