'use strict';
/**
 * Dify 适配层（Dataset API + 文本生成应用）
 * 文档：https://docs.dify.ai/  (Cloud base: https://api.dify.ai/v1)
 * 所有密钥只在服务端使用，不返回给前端。
 */
const fs = require('node:fs');
const path = require('node:path');
const { getSetting } = require('./db');

const DEFAULTS = {
  baseUrl: process.env.DIFY_BASE_URL || '',
  datasetKey: process.env.DIFY_DATASET_KEY || '',
  completionKey: process.env.DIFY_COMPLETION_KEY || '',
  appUser: process.env.DIFY_APP_USER || 'rag-platform-local'
};

function config() {
  return {
    baseUrl: (getSetting('dify.baseUrl', '') || DEFAULTS.baseUrl || '').replace(/\/+$/, ''),
    datasetKey: getSetting('dify.datasetKey', '') || DEFAULTS.datasetKey || '',
    completionKey: getSetting('dify.completionKey', '') || DEFAULTS.completionKey || '',
    appUser: getSetting('dify.appUser', '') || DEFAULTS.appUser
  };
}

function isConfigured() {
  const c = config();
  return !!(c.baseUrl && c.datasetKey);
}
function hasCompletion() {
  const c = config();
  return !!(c.baseUrl && c.completionKey);
}
function masked(v) {
  if (!v) return '';
  return v.length <= 8 ? '••••' : v.slice(0, 4) + '••••••••' + v.slice(-4);
}

class RateLimitError extends Error {
  constructor(message) { super(message); this.name = 'RateLimitError'; this.code = 'DIFY_RATE_LIMIT'; }
}
const RATE_RE = /rate limit|too many requests|请求频率|限流/i;
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function request(apiPath, options = {}) {
  const c = config();
  if (!c.baseUrl) throw new Error('尚未配置 Dify 实例地址');
  const key = options.auth === 'completion' ? c.completionKey : c.datasetKey;
  if (!key) throw new Error(options.auth === 'completion' ? '尚未配置 Dify 文本生成应用 Key' : '尚未配置 Dify 数据集 Key');
  const url = c.baseUrl + apiPath;
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const headers = Object.assign({ Authorization: 'Bearer ' + key }, options.headers || {});
    let body = options.body;
    if (body && !(body instanceof Buffer) && !(body instanceof Uint8Array) && typeof body !== 'string') {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(body);
    }
    const res = await fetch(url, { method: options.method || 'GET', headers, body });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch (e) { /* non-json */ }
    if (!res.ok) {
      const msg = (json && (json.message || json.error)) || text.slice(0, 300) || ('HTTP ' + res.status);
      const rateLimited = (res.status === 429 || res.status === 403) && RATE_RE.test(msg);
      if (rateLimited) {
        if (attempt < maxAttempts) {
          await sleep(1500 * Math.pow(2, attempt - 1));
          continue;
        }
        throw new RateLimitError(`Dify 知识库请求达到订阅限流：${msg}`);
      }
      throw new Error(`Dify 接口失败（${res.status}）：${msg}`);
    }
    return json;
  }
  throw new Error('Dify 请求失败');
}

async function testConnection() {
  const data = await request('/datasets?page=1&limit=1');
  return { ok: true, total: data && data.total != null ? data.total : (data && data.data ? data.data.length : 0) };
}

async function listDatasets() {
  return request('/datasets?page=1&limit=100');
}

async function createDataset(name) {
  const data = await request('/datasets', { method: 'POST', body: { name, indexing_technique: 'high_quality', permission: 'only_me' } });
  return data && data.id;
}

async function createDocumentByText(datasetId, name, text) {
  const data = await request(`/datasets/${datasetId}/document/create-by-text`, {
    method: 'POST',
    body: {
      name,
      text,
      indexing_technique: 'high_quality',
      process_rule: { mode: 'automatic' }
    }
  });
  return data;
}

function buildMultipart(fields, filePath, fileName, mime) {
  const boundary = '----RAGPlatform' + Date.now().toString(16);
  const parts = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  }
  const fileBuf = fs.readFileSync(filePath);
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: ${mime || 'application/octet-stream'}\r\n\r\n`));
  parts.push(fileBuf);
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

async function createDocumentByFile(datasetId, filePath, fileName) {
  const dataJson = JSON.stringify({ indexing_technique: 'high_quality', process_rule: { mode: 'automatic' } });
  const { body, contentType } = buildMultipart({ data: dataJson }, filePath, fileName, guessMime(fileName));
  return request(`/datasets/${datasetId}/document/create-by-file`, {
    method: 'POST',
    headers: { 'Content-Type': contentType },
    body
  });
}

function guessMime(name) {
  const ext = path.extname(name).toLowerCase();
  return {
    '.pdf': 'application/pdf',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.txt': 'text/plain',
    '.md': 'text/markdown',
    '.csv': 'text/csv',
    '.html': 'text/html'
  }[ext] || 'application/octet-stream';
}

async function indexingStatus(datasetId, documentId) {
  return request(`/datasets/${datasetId}/documents/${documentId}/indexing-status`);
}

/**
 * 文档详情：部分 Dify 版本不提供 indexing-status 接口（404），
 * 统一用文档详情判断索引状态，失败时回退到文档列表匹配。
 */
async function getDocument(datasetId, documentId) {
  try {
    const detail = await request(`/datasets/${datasetId}/documents/${documentId}`);
    if (detail && detail.id) return detail;
  } catch (e) { /* fallback */ }
  const list = await request(`/datasets/${datasetId}/documents?page=1&limit=100`);
  const item = ((list && list.data) || []).find(d => d.id === documentId);
  if (item) return item;
  throw new Error('Dify 文档不存在或无权访问');
}

async function listDocuments(datasetId) {
  const all = [];
  let page = 1;
  while (page <= 10) {
    const data = await request(`/datasets/${datasetId}/documents?page=${page}&limit=100`);
    const rows = (data && data.data) || [];
    rows.forEach(d => all.push({ id: d.id, name: d.name, indexing_status: d.indexing_status, word_count: d.word_count }));
    if (rows.length < 100) break;
    page++;
  }
  return all;
}

async function waitForDocument(datasetId, documentId, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 90000);
  while (Date.now() < deadline) {
    const d = await getDocument(datasetId, documentId);
    const state = d.indexing_status || (d.display_status === 'available' ? 'completed' : 'indexing');
    if (state === 'completed' || state === 'error') return state;
    await new Promise(r => setTimeout(r, 4000));
  }
  return 'timeout';
}

async function listSegments(datasetId, documentId) {  const all = [];
  let page = 1;
  while (page <= 20) {
    const data = await request(`/datasets/${datasetId}/documents/${documentId}/segments?page=${page}&limit=100`);
    const rows = (data && data.data) || [];
    rows.forEach(s => all.push({
      id: s.id,
      position: s.position,
      content: s.content,
      word_count: s.word_count || (s.content || '').length,
      heading: (s.keywords && s.keywords.join('、')) || ''
    }));
    if (rows.length < 100) break;
    page += 1;
  }
  return all;
}

async function retrieve(datasetId, query, topK, scoreThreshold) {
  const data = await request(`/datasets/${datasetId}/retrieve`, {
    method: 'POST',
    body: {
      query,
      retrieval_model: {
        search_method: 'hybrid_search',
        reranking_enable: true,
        top_k: topK || 5,
        score_threshold_enabled: scoreThreshold != null && scoreThreshold > 0,
        score_threshold: scoreThreshold || 0
      }
    }
  });
  return ((data && data.records) || []).map(r => ({
    segment: {
      id: r.segment && r.segment.id,
      content: r.segment && r.segment.content,
      word_count: r.segment && r.segment.word_count,
      heading: (r.segment && r.segment.keywords && r.segment.keywords.join('、')) || '',
      document_name: (r.segment && r.segment.document && r.segment.document.name) || ''
    },
    score: r.score != null ? r.score : 0
  }));
}

function cleanAnswer(text) {
  return String(text || '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<!--\s*dify-deepseek-reasoning\s*-->/gi, '')
    .replace(/^\s*<think\b[\s\S]*$/i, '')
    .trim();
}

async function generateAnswer(query, records) {
  const c = config();
  const context = records.map((r, i) => `[${i + 1}] ${r.segment.content}`).join('\n\n');
  // 优先：文本生成应用（completion-messages，变量 query/context）
  try {
    const data = await request('/completion-messages', {
      method: 'POST',
      auth: 'completion',
      body: { inputs: { query, context }, response_mode: 'blocking', user: c.appUser }
    });
    const answer = cleanAnswer(data && data.answer);
    if (answer) return answer;
  } catch (e) { /* 回退到聊天应用 */ }
  // 回退：聊天/高级聊天应用（chat-messages），把检索资料放进提示词，要求仅依据资料回答
  const prompt = [
    '请仅依据下面提供的知识资料回答用户问题；资料不足时明确说明“知识库中没有找到相关依据”，不要编造。',
    '【知识资料】',
    context,
    '【用户问题】',
    query
  ].join('\n');
  const data = await request('/chat-messages', {
    method: 'POST',
    auth: 'completion',
    body: { inputs: {}, query: prompt, response_mode: 'blocking', user: c.appUser }
  });
  return cleanAnswer(data && data.answer);
}

module.exports = {
  config, masked, isConfigured, hasCompletion,
  testConnection, listDatasets, createDataset,
  createDocumentByText, createDocumentByFile, indexingStatus, getDocument, listDocuments, waitForDocument, listSegments,
  retrieve, generateAnswer
};
