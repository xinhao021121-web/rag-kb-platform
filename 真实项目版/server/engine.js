'use strict';
/**
 * 引擎编排层：优先使用 Dify；未配置或调用失败时降级到本地引擎。
 */
const { getDb, makeId, now } = require('./db');
const dify = require('./dify');
const local = require('./engine-local');

function requireDoc(docId) {
  const d = getDb();
  const doc = d.prepare('SELECT * FROM documents WHERE id = ?').get(docId);
  if (!doc) throw new Error('文档不存在');
  return doc;
}

async function ensureDataset(kb, env) {
  if (!dify.isConfigured()) return null;
  const d = getDb();
  const field = env === '生产' ? 'prod_dataset_id' : 'test_dataset_id';
  const statusField = env === '生产' ? 'prod_rag_status' : 'test_rag_status';
  if (kb[field]) return kb[field];
  const name = `${kb.name} · ${env === '生产' ? '生产' : '测试'} · ${new Date().toISOString().slice(0, 10)}`;
  let id = null;
  try {
    id = await dify.createDataset(name);
  } catch (e) {
    d.prepare(`UPDATE knowledge_bases SET ${statusField} = ? WHERE id = ?`).run('创建失败：' + e.message.slice(0, 60), kb.id);
    throw e;
  }
  d.prepare(`UPDATE knowledge_bases SET ${field} = ?, ${statusField} = ? WHERE id = ?`).run(id, '正常', kb.id);
  return id;
}

async function fileText(doc) {
  if (doc.content_text && doc.content_text.trim()) return doc.content_text;
  if (doc.file_path && require('node:fs').existsSync(doc.file_path)) {
    return local.extractText(doc.file_path, doc.file_name || doc.title);
  }
  return '';
}

/**
 * 推送任务：Dify 上传并等待索引；本地引擎直接切片入库。
 */
async function pushJob(jobId) {
  const d = getDb();
  const job = d.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
  if (!job) throw new Error('入库任务不存在');
  if (job.status !== '待推送') throw new Error('当前任务不能重复推送');
  const doc = requireDoc(job.document_id);
  const kb = d.prepare('SELECT * FROM knowledge_bases WHERE id = ?').get(doc.kb_id);
  if (!kb) throw new Error('文档所属知识库不存在');

  d.prepare('UPDATE jobs SET status = ?, step = ?, progress = ?, pushed_at = ?, error = NULL WHERE id = ?')
    .run('处理中', '已提交RAG引擎，等待处理', 20, now(), jobId);
  d.prepare('UPDATE documents SET status = ?, updated_at = ? WHERE id = ?').run('测试入库中', now(), doc.id);

  try {
    if (dify.isConfigured()) {
      const datasetId = await ensureDataset(kb, job.environment);
      d.prepare('UPDATE jobs SET dataset_id = ? WHERE id = ?').run(datasetId, jobId);
      let result;
      if (doc.file_path && require('node:fs').existsSync(doc.file_path)) {
        result = await dify.createDocumentByFile(datasetId, doc.file_path, doc.file_name || doc.title);
      } else {
        const text = await fileText(doc);
        if (!text) throw new Error('文档没有可解析的正文');
        result = await dify.createDocumentByText(datasetId, doc.title, text);
      }
      const difyDocId = result && (result.document && result.document.id || result.document_id);
      if (!difyDocId) throw new Error('Dify 未返回文档ID');
      d.prepare('UPDATE jobs SET dify_document_id = ?, external_task_id = ?, step = ?, progress = ? WHERE id = ?')
        .run(difyDocId, (result.batch || '').toString() || ('RAG-' + Date.now().toString(36)), 'Dify 索引中', 35, jobId);
      return { engine: 'dify', status: '处理中' };
    }
    // 本地引擎
    const text = await fileText(doc);
    if (!text) throw new Error('文档没有可解析的正文');
    const segments = local.chunkText(text);
    d.prepare('INSERT INTO processing_results (id,job_id,segments_json,parse_status,char_count,chunk_count,vector_count,index_count,warnings,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(makeId('PR'), jobId, JSON.stringify(segments), '成功', text.length, segments.length, segments.length, segments.length, 0, now());
    d.prepare('UPDATE jobs SET status = ?, step = ?, progress = ?, character_count = ?, chunk_count = ?, vector_count = ?, index_count = ?, returned_at = ?, error = NULL WHERE id = ?')
      .run('待验收', '本地引擎处理完成，等待验收', 100, text.length, segments.length, segments.length, segments.length, now(), jobId);
    d.prepare('UPDATE documents SET status = ?, updated_at = ? WHERE id = ?').run('待验收', now(), doc.id);
    return { engine: 'local', status: '待验收', chunks: segments.length };
  } catch (e) {
    d.prepare('UPDATE jobs SET status = ?, step = ?, error = ? WHERE id = ?').run('失败', '处理失败', String(e.message).slice(0, 400), jobId);
    d.prepare('UPDATE documents SET status = ?, updated_at = ? WHERE id = ?').run('测试入库中', now(), doc.id);
    throw e;
  }
}

async function refreshJob(jobId) {
  const d = getDb();
  const job = d.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
  if (!job || job.status !== '处理中' || !job.dify_document_id || !job.dataset_id) return job;
  if (!dify.isConfigured()) return job;
  try {
    const detail = await dify.getDocument(job.dataset_id, job.dify_document_id);
    const state = detail.indexing_status || (detail.display_status === 'available' ? 'completed' : 'indexing');
    if (state === 'completed' || detail.display_status === 'available') {
      const segments = await dify.listSegments(job.dataset_id, job.dify_document_id);
      const chars = segments.reduce((s, x) => s + (x.word_count || 0), 0) || Number(detail.word_count || 0);
      d.prepare('INSERT INTO processing_results (id,job_id,segments_json,parse_status,char_count,chunk_count,vector_count,index_count,warnings,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
        .run(makeId('PR'), jobId, JSON.stringify(segments), '成功', chars, segments.length, segments.length, segments.length, 0, now());
      d.prepare('UPDATE jobs SET status = ?, step = ?, progress = 100, character_count = ?, chunk_count = ?, vector_count = ?, index_count = ?, returned_at = ? WHERE id = ?')
        .run('待验收', 'Dify 索引完成，等待验收', chars, segments.length, segments.length, segments.length, now(), jobId);
      d.prepare('UPDATE documents SET status = ?, updated_at = ? WHERE id = ?').run('待验收', now(), job.document_id);
    } else if (state === 'error') {
      d.prepare('UPDATE jobs SET status = ?, step = ?, error = ? WHERE id = ?')
        .run('失败', 'Dify 索引失败', String(detail.error || '未知错误').slice(0, 300), jobId);
    } else {
      d.prepare('UPDATE jobs SET progress = ?, step = ?, error = NULL WHERE id = ?').run(60, 'Dify 索引中', jobId);
    }
  } catch (e) {
    const msg = String(e.message || '');
    if (/不存在|无权|not_found|404/i.test(msg)) {
      d.prepare('UPDATE jobs SET status = ?, step = ?, error = ? WHERE id = ?').run('失败', 'Dify 文档不可访问', msg.slice(0, 300), jobId);
    } else {
      d.prepare('UPDATE jobs SET error = ? WHERE id = ?').run(msg.slice(0, 300), jobId);
    }
  }
  return d.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
}

function getSegments(jobId) {
  const d = getDb();
  const row = d.prepare('SELECT * FROM processing_results WHERE job_id = ? ORDER BY created_at DESC LIMIT 1').get(jobId);
  if (!row) return [];
  try { return JSON.parse(row.segments_json || '[]'); } catch (e) { return []; }
}

async function retrieve(job, query, opts) {
  const d = getDb();
  const option = opts || {};
  const topK = option.topK || 5;
  const threshold = option.threshold != null ? option.threshold : 0.2;
  const stage = job.status === '已验收' || job.status === '检索通过' || job.status === '评测完成' || job.status === '待发布' || job.status === '已发布' ? 'accepted' : 'preview';
  if (dify.isConfigured() && job.dataset_id && job.dify_document_id) {
    try {
      const records = await dify.retrieve(job.dataset_id, query, topK, threshold);
      return records.map(r => ({ id: r.segment.id, content: r.segment.content, score: r.score, heading: r.segment.heading, source: r.segment.document_name }));
    } catch (e) {
      if (!/限流|rate limit|DIFY_RATE_LIMIT/i.test(e.message)) throw e;
      // 订阅限流时降级到本地检索，保证流程可用
    }
  }
  // 本地
  const segments = getSegments(job.id);
  const records = local.bm25Search(segments, query, topK);
  const max = records.length ? records[0].score : 1;
  return records.map((r, i) => ({
    id: r.segment.id,
    content: r.segment.content,
    heading: r.segment.heading,
    score: Number((0.5 + 0.45 * (r.score / (max || 1)) * (i === 0 ? 1 : 0.9 - i * 0.06)).toFixed(2)),
    source: '本地切片'
  }));
}

async function answer(query, records, opts) {
  const useLlm = !(opts && opts.useLlm === false);
  if (useLlm && dify.hasCompletion() && records.length) {
    try {
      const text = await dify.generateAnswer(query, records.map(r => ({ segment: r })));
      if (text) return text;
    } catch (e) { /* 降级 */ }
  }
  return local.extractiveAnswer(query, records.map(r => ({ segment: r })));
}

/**
 * 知识库级检索（评测使用）：Dify 用 KB 的测试 dataset；本地引擎合并该知识库下所有文档的切片。
 */
async function retrieveKB(kbId, query, opts) {
  const d = getDb();
  const option = opts || {};
  const topK = option.topK || 5;
  const threshold = option.threshold != null ? option.threshold : 0;
  const kb = d.prepare('SELECT * FROM knowledge_bases WHERE id = ?').get(kbId);
  if (!kb) throw new Error('知识库不存在');
  if (dify.isConfigured() && kb.test_dataset_id) {
    try {
      const records = await dify.retrieve(kb.test_dataset_id, query, topK, threshold);
      return records.map(r => ({ id: r.segment.id, content: r.segment.content, score: r.score, heading: r.segment.heading, source: r.segment.document_name }));
    } catch (e) {
      if (!/限流|rate limit|DIFY_RATE_LIMIT/i.test(e.message)) throw e;
      // 限流时回退本地知识库检索
    }
  }
  const docs = d.prepare('SELECT * FROM documents WHERE kb_id = ?').all(kbId);
  const segments = [];
  for (const doc of docs) {
    const job = d.prepare('SELECT * FROM jobs WHERE document_id = ? ORDER BY created_at DESC LIMIT 1').get(doc.id);
    let segs = job ? getSegments(job.id) : [];
    if (!segs.length && doc.content_text) {
      segs = local.chunkText(doc.content_text).map(s => ({ ...s, id: 'CH-' + String(s.position).padStart(3, '0') }));
    }
    segs.forEach(s => segments.push({
      ...s,
      id: doc.id.slice(-6) + '-' + s.id,
      docTitle: doc.title,
      source: doc.title
    }));
  }
  const records = local.bm25Search(segments, query, topK);
  const max = records.length ? records[0].score : 1;
  return records.map((r, i) => ({
    id: r.segment.id,
    content: r.segment.content,
    heading: r.segment.heading,
    score: Number((0.5 + 0.45 * (r.score / (max || 1)) * (i === 0 ? 1 : 0.9 - i * 0.06)).toFixed(2)),
    source: r.segment.source || r.segment.docTitle || '本地切片'
  }));
}

/**
 * 将知识库中已发布但尚未同步到 Dify 测试 dataset 的文档补传并等待索引。
 * 用于评测前的知识库级同步（回归需要历史已发布文档也在 dataset 中）。
 */
let syncCache = { kbId: null, at: 0 };
async function syncPublishedDocs(kbId) {
  if (!dify.isConfigured()) return { synced: 0, reason: 'dify-not-configured' };
  if (syncCache.kbId === kbId && Date.now() - syncCache.at < 10 * 60 * 1000) return { synced: 0, reason: 'recently-synced' };
  const d = getDb();
  const fs = require('node:fs');
  const kb = d.prepare('SELECT * FROM knowledge_bases WHERE id = ?').get(kbId);
  if (!kb || !kb.test_dataset_id) return { synced: 0, reason: 'no-dataset' };
  const existing = await dify.listDocuments(kb.test_dataset_id);
  const names = new Set(existing.map(x => x.name));
  const docs = d.prepare("SELECT * FROM documents WHERE kb_id = ? AND status = '已发布'").all(kbId);
  let synced = 0;
  for (const doc of docs) {
    if (names.has(doc.title)) continue;
    try {
      let res = null;
      if (doc.file_path && fs.existsSync(doc.file_path)) {
        res = await dify.createDocumentByFile(kb.test_dataset_id, doc.file_path, doc.file_name || doc.title);
      } else if (doc.content_text) {
        res = await dify.createDocumentByText(kb.test_dataset_id, doc.title, doc.content_text);
      }
      const id = res && (res.document && res.document.id || res.document_id);
      if (id) {
        await dify.waitForDocument(kb.test_dataset_id, id, 60000);
        synced++;
      }
    } catch (e) { /* 单个文档失败不阻断评测 */ }
  }
  syncCache = { kbId, at: Date.now() };
  return { synced };
}

module.exports = { ensureDataset, pushJob, refreshJob, getSegments, retrieve, retrieveKB, syncPublishedDocs, answer, fileText };
