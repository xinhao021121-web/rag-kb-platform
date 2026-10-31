'use strict';
const { getDb, makeId, now } = require('./db');

function addAudit(user, action, result) {
  const d = getDb();
  d.prepare('INSERT INTO audit_logs (id,time,user_id,operator,action,result) VALUES (?,?,?,?,?,?)').run(
    makeId('LOG'),
    now(),
    user ? user.id : null,
    user ? user.name : '系统',
    action,
    result || '成功'
  );
}

module.exports = { addAudit };
