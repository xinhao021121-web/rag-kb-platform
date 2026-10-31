'use strict';
const auth = require('../auth');

function register(router) {
  router.get('/api/health', () => ({ ok: true }));

  router.post('/api/auth/login', (ctx) => {
    const { username, password } = ctx.body || {};
    const result = auth.login(username, password);
    if (result.error) return Promise.reject(Object.assign(new Error(result.error), { status: 401 }));
    ctx.res.setHeader('Set-Cookie', auth.sessionCookie(result.token));
    return { user: result.user };
  });

  router.post('/api/auth/logout', (ctx) => {
    auth.destroySession(ctx.user && ctx.user.token);
    ctx.res.setHeader('Set-Cookie', auth.clearCookie());
    return { ok: true };
  });

  router.get('/api/me', (ctx) => ({ user: ctx.user }));
}

module.exports = { register };
