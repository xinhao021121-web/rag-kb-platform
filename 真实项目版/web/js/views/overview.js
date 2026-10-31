import { get } from '../api.js';
import { esc, setText, fmt } from '../ui.js';
import { store, isProd } from '../store.js';

export async function render() {
  const [analytics, kbs, jobs, cases, reviews, docs] = await Promise.all([
    get('/api/analytics'), get('/api/kb'), get('/api/jobs'), get('/api/cases'), get('/api/reviews'), get('/api/documents')
  ]);
  const t = analytics.totals;
  const pendingJobs = jobs.jobs.filter(j => ['待推送', '处理中', '待验收'].includes(j.status));
  setText('publishedStat', t.published);
  setText('publishedStatSub', '累计 ' + t.docs + ' 份文档 · ' + t.kbs + ' 个知识库');
  if (isProd()) {
    const prodJobs = jobs.jobs.filter(j => j.environment === '生产');
    setText('pendingStat', prodJobs.length);
    setText('pendingStatSub', '生产入库任务 ' + prodJobs.length + ' 条 · 治理待办请切测试环境');
  } else {
    const pending = reviews.pending.length + pendingJobs.length + t.pendingCases;
    setText('pendingStat', pending);
    setText('pendingStatSub', '审核' + reviews.pending.length + ' · 入库' + pendingJobs.length + ' · 问题案例' + t.pendingCases);
  }
  setText('evalRateStat', t.lastFormal ? (t.lastFormal.pass_rate * 100).toFixed(1) + '%' : '—');
  setText('evalRateStatSub', t.lastFormal ? '最近正式评测 ' + t.lastFormal.passed_count + '/' + t.lastFormal.count : '尚未运行正式评测');
  setText('p0Stat', t.p0Cases);
  setText('p0StatSub', t.p0Cases ? '存在P0安全类待处理问题' : '无P0风险问题');

  // 待办
  const todo = [];
  cases.cases.filter(c => c.status !== '已处理' && String(c.risk).includes('P0')).forEach(c => todo.push({ title: '处理 P0 问题案例：' + c.question, owner: '产品经理', due: '今天', tag: 'P0', cls: 'failed', view: 'cases', btn: '处理' }));
  reviews.pending.forEach(d => todo.push({ title: '审核《' + d.title + '》' + d.version, owner: '业务审核人', due: '今天', tag: '待审核', cls: 'pending', view: 'review', btn: '审核' }));
  pendingJobs.filter(j => j.status === '待推送').forEach(j => todo.push({ title: '推送API：' + j.docTitle + ' ' + j.docVersion, owner: '知识运营', due: '今天', tag: '待推送', cls: 'pending', view: 'ingestion', btn: '推送' }));
  pendingJobs.filter(j => j.status === '待验收').forEach(j => todo.push({ title: '验收处理结果：' + j.docTitle, owner: '知识运营', due: '今天', tag: '待验收', cls: 'processing', view: 'processing', btn: '验收' }));
  cases.cases.filter(c => c.status !== '已处理' && !String(c.risk).includes('P0')).forEach(c => todo.push({ title: '复测问题案例：' + c.question, owner: c.owner || '待分配', due: '明天', tag: '待处理', cls: 'processing', view: 'cases', btn: '查看' }));
  const todoBody = document.getElementById('todoTable');
  if (todoBody) {
    todoBody.innerHTML = isProd()
      ? '<tr><td colspan="5"><div class="empty"><strong>生产环境只读</strong><br><small>待办处理与知识治理请切换到测试环境。</small></div></td></tr>'
      : (todo.length ? todo.slice(0, 5).map(x => '<tr><td><strong>' + esc(x.title) + '</strong><br><small>' + esc(x.tag) + '</small></td><td>' + esc(x.owner) + '</td><td>' + esc(x.due) + '</td><td><span class="status ' + x.cls + '">' + esc(x.tag) + '</span></td><td><button class="btn small" onclick="showView(\'' + x.view + '\')">' + x.btn + '</button></td></tr>').join('')
        : '<tr><td colspan="5"><div class="empty"><strong>暂无待处理事项</strong><br><small>上传文档并提交审核后，待办会出现在这里。</small></div></td></tr>');
  }

  // 环境隔离
  const envTable = document.getElementById('envIsolation');
  const latestRelease = docs.documents.filter(d => d.release_id).sort((a, b) => String(b.published_at).localeCompare(String(a.published_at)))[0];
  if (envTable) {
    envTable.innerHTML = '<tr><td><strong>测试dataset</strong><br><small>' + kbs.kbs.filter(k => k.test_dataset_id).length + ' 个知识库已绑定</small></td><td><span class="status processing">内部可见</span></td></tr>' +
      '<tr><td><strong>生产dataset</strong><br><small>' + t.published + ' 份已发布文档</small></td><td><span class="status live">正式服务</span></td></tr>' +
      '<tr><td><strong>当前生产版本</strong></td><td>' + esc(latestRelease ? latestRelease.release_id : '—') + '</td></tr>';
  }
  const valid = docs.documents.filter(d => d.validity && d.validity !== '待补充').length;
  const pct = docs.documents.length ? Math.round(valid / docs.documents.length * 100) : 0;
  const bar = document.getElementById('freshnessBar');
  if (bar) bar.style.width = pct + '%';
  setText('freshnessText', pct + '%知识已登记有效期 · ' + (docs.documents.length - valid) + '份文档有效期待补充');
}
