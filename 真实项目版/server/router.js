'use strict';
/** 极简路由：支持 :param 与精确方法匹配 */
class Router {
  constructor() { this.routes = []; }
  add(method, pattern, handler) {
    this.routes.push({ method: method.toUpperCase(), parts: pattern.split('/').filter(Boolean), handler, pattern });
    return this;
  }
  get(p, h) { return this.add('GET', p, h); }
  post(p, h) { return this.add('POST', p, h); }
  put(p, h) { return this.add('PUT', p, h); }
  patch(p, h) { return this.add('PATCH', p, h); }
  match(method, pathname) {
    const parts = pathname.split('/').filter(Boolean);
    for (const r of this.routes) {
      if (r.method !== method || r.parts.length !== parts.length) continue;
      const params = {};
      let ok = true;
      for (let i = 0; i < parts.length; i++) {
        const p = r.parts[i];
        if (p.startsWith(':')) params[p.slice(1)] = decodeURIComponent(parts[i]);
        else if (p !== decodeURIComponent(parts[i])) { ok = false; break; }
      }
      if (ok) return { handler: r.handler, params };
    }
    return null;
  }
}
module.exports = Router;
