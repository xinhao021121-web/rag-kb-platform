import { get, post } from '../api.js';
import { esc, toast, showModal, closeModal, fmt } from '../ui.js';
import { store, refresh } from '../store.js';

const ROLE_HINTS = {
  operator: ['知识运营', '可以维护知识和运行测试、验收处理结果，但不能审核自己提交的知识，也不能直接放行生产版本。'],
  reviewer: ['业务审核人', '可以核对本人业务域的知识事实并审核，不能修改RAG参数或直接管理成员。'],
  tester: ['AI产品经理', '可以组织批量评测与客服对话验收，判断回答质量；生产发布由发布审批人决定。'],
  approver: ['发布审批人', '可以登记线下审批结论并放行生产版本，但不能跳过评测门槛直接发布。'],
  admin: ['系统管理员', '可以管理成员、密钥和审计，但不能绕过业务审核及评测门槛。']
};

export async function render() {
  const [members, keys, audit] = await Promise.all([get('/api/members'), get('/api/keys'), get('/api/audit')]);
  const role = store.me ? store.me.role : 'operator';
  const hint = ROLE_HINTS[role] || ['用户', ''];
  const hintEl = document.getElementById('roleHint');
  if (hintEl) hintEl.innerHTML = '<strong>' + hint[0] + '（当前登录账号）</strong>' + hint[1] + ' 角色由服务端会话确定；切换角色请退出后使用对应演示账号登录。';
  const roleSel = document.getElementById('roleDemo');
  if (roleSel) {
    roleSel.value = role;
    roleSel.onchange = () => {
      roleSel.value = role;
      showModal('切换角色需要重新登录', '<div class="alert warn"><strong>角色由服务端会话决定</strong>演示账号：operator 知识运营 · reviewer 业务审核人 · tester AI产品经理 · approver 发布审批人 · admin 系统管理员（密码均为 demo1234）。</div>', '<button class="btn" onclick="closeModal()">知道了</button><button class="btn primary" onclick="closeModal();logout()">退出并切换账号</button>');
    };
  }
  const memberBody = document.getElementById('memberTable');
  if (memberBody) memberBody.innerHTML = members.members.map(m => '<tr><td>' + esc(m.name) + '<br><small>' + esc(m.username) + '</small></td><td>' + esc(m.role) + '</td><td>' + esc(m.domain) + '</td><td><span class="status ' + (m.status === '启用' ? 'live' : 'gray') + '">' + esc(m.status) + '</span></td></tr>').join('');
  const auditBody = document.querySelector('#auditTable tbody');
  if (auditBody) auditBody.innerHTML = audit.logs.slice(0, 20).map(a => '<tr><td>' + fmt(a.time) + '</td><td>' + esc(a.operator) + '</td><td>' + esc(a.action) + '</td><td><span class="status ' + (a.result === '成功' ? 'live' : 'failed') + '">' + esc(a.result) + '</span></td></tr>').join('') || '<tr><td colspan="4"><div class="empty">暂无审计记录</div></td></tr>';
  const keyPanel = document.getElementById('apiKeyPanel');
  if (keyPanel) keyPanel.innerHTML = '<table><thead><tr><th>密钥</th><th>掩码</th><th>权限范围</th><th>创建时间</th><th>操作</th></tr></thead><tbody>' + keys.keys.map(k => '<tr><td>' + esc(k.name) + '</td><td>' + esc(k.mask) + '</td><td>' + esc(k.scope) + '</td><td>' + fmt(k.created_at) + '</td><td><button class="btn small" onclick="regenerateKey(\'' + esc(k.env) + '\')">重新生成</button></td></tr>').join('') + '</tbody></table><div class="alert" style="margin-top:12px;margin-bottom:0"><strong>密钥规范</strong>测试与生产密钥分开；密钥只以掩码展示；平台侧密钥仅存本机。</div>';
}

export function openMember() {
  showModal('添加成员', '<div class="field-row"><div class="field"><label>成员</label><input class="input" id="newMemberName" value="new.member"></div><div class="field"><label>角色</label><select class="select" id="newMemberRole"><option>知识运营</option><option>业务审核人</option><option>产品经理</option><option>发布审批人</option><option>系统管理员</option></select></div><div class="field"><label>业务域</label><select class="select" id="newMemberDomain"><option>售后</option><option>商品</option><option>客服</option><option>渠道</option></select></div><div class="field"><label>租户</label><input class="input" value="XC-DIGITAL" disabled></div></div><div class="alert warn"><strong>高风险约束</strong>提交人与业务审核人不得为同一人；管理员不能绕过业务审核和评测直接发布。</div>',
    '<button class="btn" onclick="closeModal()">取消</button><button class="btn primary" onclick="saveMember()">添加</button>');
}

export async function saveMember() {
  const name = document.getElementById('newMemberName').value.trim();
  if (!name) return toast('请填写成员名称');
  try {
    const res = await post('/api/members', { name, role: document.getElementById('newMemberRole').value, domain: document.getElementById('newMemberDomain').value });
    closeModal(); toast('成员已添加，初始密码 ' + res.password); await refresh();
  } catch (e) { toast(e.message); }
}

export async function regenerateKey(env) {
  try {
    await post('/api/keys/' + encodeURIComponent(env) + '/regenerate', {});
    toast(env + '环境密钥已重新生成'); await refresh();
  } catch (e) { toast(e.message); }
}

export function exportAudit() {
  get('/api/audit').then(data => {
    const lines = ['时间,操作者,动作,结果'].concat(data.logs.map(a => [a.time, a.operator, a.action, a.result].map(x => '"' + String(x).replace(/"/g, '""') + '"').join(',')));
    const blob = new Blob(['﻿' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = '审计日志.csv'; a.click();
  });
}

Object.assign(window, { openMember, saveMember, regenerateKey, exportAudit, applyRole: () => {} });
