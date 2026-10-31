'use strict';
const crypto = require('node:crypto');
const { getDb, now } = require('./db');

const SESSION_DAYS = 7;

function parseCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  header.split(';').forEach(pair => {
    const idx = pair.indexOf('=');
    if (idx < 0) return;
    out[pair.slice(0, idx).trim()] = decodeURIComponent(pair.slice(idx + 1).trim());
  });
  return out;
}

function createSession(userId) {
  const d = getDb();
  const token = crypto.randomBytes(24).toString('hex');
  const expires = new Date(Date.now() + SESSION_DAYS * 86400000).toISOString();
  d.prepare('INSERT INTO sessions (token,user_id,expires_at) VALUES (?,?,?)').run(token, userId, expires);
  d.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now());
  return token;
}

function getSessionUser(req) {
  const token = parseCookies(req).sid;
  if (!token) return null;
  const d = getDb();
  const session = d.prepare('SELECT * FROM sessions WHERE token = ?').get(token);
  if (!session) return null;
  if (session.expires_at < now()) {
    d.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    return null;
  }
  const user = d.prepare('SELECT id,name,username,role,domain,status FROM users WHERE id = ?').get(session.user_id);
  if (!user || user.status !== '启用') return null;
  return { ...user, token };
}

function destroySession(token) {
  if (!token) return;
  getDb().prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

function login(username, password) {
  const d = getDb();
  const user = d.prepare('SELECT * FROM users WHERE username = ?').get(String(username || '').trim());
  if (!user) return { error: '用户不存在' };
  if (user.status !== '启用') return { error: '账号已停用' };
  const { verifyPassword } = require('./db');
  if (!verifyPassword(String(password || ''), user.password_hash)) return { error: '密码不正确' };
  const token = createSession(user.id);
  return { token, user: { id: user.id, name: user.name, username: user.username, role: user.role, domain: user.domain } };
}

function sessionCookie(token) {
  const maxAge = SESSION_DAYS * 86400;
  return `sid=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;
}
function clearCookie() {
  return 'sid=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0';
}

module.exports = { parseCookies, createSession, getSessionUser, destroySession, login, sessionCookie, clearCookie };
