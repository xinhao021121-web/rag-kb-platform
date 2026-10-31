'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');
const Router = require('./router');
const auth = require('./auth');
const { getDb } = require('./db');
const { HttpError } = require('./rbac');

const PORT = Number(process.env.PORT || 8787);
const WEB_DIR = path.join(__dirname, '..', 'web');
const MAX_JSON = 2 * 1024 * 1024;
const MAX_UPLOAD = 60 * 1024 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2'
};

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > limit) { reject(new HttpError(413, '请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function parseBody(req) {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return null;
  const type = String(req.headers['content-type'] || '');
  if (type.includes('application/json')) {
    const raw = await readBody(req, MAX_JSON);
    if (!raw.length) return {};
    try { return JSON.parse(raw.toString('utf8')); } catch (e) { throw new HttpError(400, 'JSON 格式错误'); }
  }
  return null;
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const safe = path.normalize(rel).replace(/^(\.\.[/\\])+/, '');
  const file = path.join(WEB_DIR, safe);
  if (!file.startsWith(WEB_DIR)) { res.writeHead(403); res.end('Forbidden'); return; }
  fs.stat(file, (err, stat) => {
    if (err || !stat.isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Not found'); return; }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': ext === '.html' ? 'no-store' : 'public, max-age=300' });
    fs.createReadStream(file).pipe(res);
  });
}

const router = new Router();
require('./routes/auth').register(router);
require('./routes/kb').register(router);
require('./routes/docs').register(router);
require('./routes/jobs').register(router);
require('./routes/eval').register(router);
require('./routes/misc').register(router);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname;
  try {
    if (!pathname.startsWith('/api/')) { serveStatic(req, res, pathname); return; }

    const isPublic = pathname === '/api/auth/login' || pathname === '/api/health';
    const user = auth.getSessionUser(req);
    if (!isPublic && !user) { sendJson(res, 401, { ok: false, code: 'UNAUTHORIZED', message: '请先登录' }); return; }

    const matched = router.match(req.method, pathname);
    if (!matched) { sendJson(res, 404, { ok: false, message: '接口不存在' }); return; }

    const body = await parseBody(req);
    const raw = (body == null && ['POST', 'PUT', 'PATCH'].includes(req.method)) ? await readBody(req, MAX_UPLOAD) : null;
    const ctx = { req, res, user, params: matched.params, query: url.searchParams, body, raw };
    const result = await matched.handler(ctx);
    if (res.writableEnded) return;
    if (result && result.__file) {
      const { filePath, fileName, mime } = result.__file;
      if (!fs.existsSync(filePath)) { sendJson(res, 404, { ok: false, message: '文件不存在' }); return; }
      res.writeHead(200, {
        'Content-Type': mime || 'application/octet-stream',
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`
      });
      fs.createReadStream(filePath).pipe(res);
      return;
    }
    sendJson(res, 200, { ok: true, data: result === undefined ? null : result });
  } catch (e) {
    const status = e instanceof HttpError ? e.status : (Number.isInteger(e.status) ? e.status : 500);
    if (status >= 500) console.error('[server]', e);
    sendJson(res, status, { ok: false, code: e.code || 'ERROR', message: e.message || '服务器错误' });
  }
});

getDb();
server.listen(PORT, '127.0.0.1', () => {
  console.log(`RAG 知识库平台已启动：http://127.0.0.1:${PORT}`);
  console.log('默认账号：operator / reviewer / tester / approver / admin，密码 demo1234');
});
