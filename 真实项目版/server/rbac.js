'use strict';

const ROLE_NAMES = {
  operator: '知识运营',
  reviewer: '业务审核人',
  tester: 'AI产品经理',
  approver: '发布审批人',
  admin: '系统管理员'
};

const PERMISSIONS = {
  'kb.write': ['operator', 'admin'],
  'doc.write': ['operator', 'admin'],
  'doc.submit': ['operator', 'admin'],
  'review.decide': ['reviewer', 'admin'],
  'job.write': ['operator', 'admin'],
  'processing.accept': ['operator', 'admin'],
  'retrieval.run': ['operator', 'tester', 'admin'],
  'eval.run': ['tester', 'admin'],
  'dialogue.record': ['tester', 'admin'],
  'release.decide': ['approver', 'admin'],
  'source.sync': ['operator', 'admin'],
  'case.process': ['operator', 'tester', 'admin'],
  'member.manage': ['admin'],
  'key.manage': ['admin'],
  'config.write': ['admin'],
  'stats.read': ['operator', 'reviewer', 'tester', 'approver', 'admin']
};

function can(user, permission) {
  if (!user) return false;
  const allowed = PERMISSIONS[permission];
  return Array.isArray(allowed) && allowed.includes(user.role);
}

class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code || 'ERROR';
  }
}

function requirePermission(user, permission) {
  if (!can(user, permission)) {
    const role = user ? (ROLE_NAMES[user.role] || user.role) : '未登录';
    throw new HttpError(403, `当前角色为「${role}」，该操作需要「${(PERMISSIONS[permission] || []).map(r => ROLE_NAMES[r]).join(' / ')}」权限`, 'FORBIDDEN');
  }
}

module.exports = { ROLE_NAMES, PERMISSIONS, can, requirePermission, HttpError };
