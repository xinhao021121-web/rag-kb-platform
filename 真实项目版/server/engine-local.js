'use strict';
/**
 * 本地降级引擎：不依赖任何外部服务。
 * - 文本提取：TXT/MD/HTML/CSV 原生；PDF/DOCX 使用可选依赖（pdf-parse / mammoth）
 * - 切片：按 FAQ 标记、标题与段落切分
 * - 检索：BM25 + 中文二元组
 * - 回答：抽取式（Top 切片原文）
 */
const path = require('node:path');
const fs = require('node:fs');

async function extractText(filePath, originalName) {
  const ext = (path.extname(originalName || filePath) || '').toLowerCase().replace('.', '');
  const buf = fs.readFileSync(filePath);
  if (['txt', 'md', 'markdown', 'csv', 'html', 'htm', 'json'].includes(ext)) {
    let text = buf.toString('utf8');
    if (ext === 'html' || ext === 'htm') {
      text = text.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ');
    }
    return text.replace(/\r\n/g, '\n').trim();
  }
  if (ext === 'pdf') {
    try {
      const pdfParse = require('pdf-parse');
      const data = await pdfParse(buf);
      return String(data.text || '').trim();
    } catch (e) {
      throw new Error('本地引擎无法解析 PDF（可安装 pdf-parse 或配置 Dify 解析）：' + e.message);
    }
  }
  if (ext === 'docx') {
    try {
      const mammoth = require('mammoth');
      const result = await mammoth.extractRawText({ buffer: buf });
      return String(result.value || '').trim();
    } catch (e) {
      throw new Error('本地引擎无法解析 DOCX（可安装 mammoth 或配置 Dify 解析）：' + e.message);
    }
  }
  throw new Error(`本地引擎暂不支持 .${ext} 文件，请上传 TXT/MD/HTML/CSV/PDF/DOCX 或配置 Dify`);
}

function chunkText(text) {
  const source = String(text || '').replace(/\r\n/g, '\n').trim();
  if (!source) return [];
  const segments = [];
  const lines = source.split('\n');
  let current = { heading: '', content: [] };
  const flush = () => {
    const content = current.content.join('\n').trim();
    if (content) segments.push({ heading: current.heading, content });
    current = { heading: '', content: [] };
  };
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      if (current.content.join('').length > 260) flush();
      continue;
    }
    const isHeading = /^(\[FAQ-|第[一二三四五六七八九十]+[章节]|[0-9]+[、.．]|#{1,4}\s|一、|二、|三、|四、|五、|六、)/.test(line);
    if (isHeading && current.content.join('').length > 0) flush();
    if (isHeading) current.heading = line.slice(0, 80);
    current.content.push(line);
    if (current.content.join('').length > 460) flush();
  }
  flush();
  // 过短的片段与前一个合并（但不合并以 FAQ/章节/编号开头的新片段）
  const merged = [];
  for (const seg of segments) {
    const last = merged[merged.length - 1];
    const firstLine = String(seg.content).trim().split('\n')[0] || '';
    const startsHeading = /^(\[FAQ-|第[一二三四五六七八九十]+[章节]|[0-9]+[、.．]|#{1,4}\s|一、|二、|三、|四、|五、|六、)/.test(firstLine);
    if (last && seg.content.length < 80 && !startsHeading) {
      last.content += '\n' + seg.content;
    } else {
      merged.push(seg);
    }
  }
  return merged.map((seg, i) => ({
    id: 'CH-' + String(i + 1).padStart(3, '0'),
    position: i + 1,
    heading: seg.heading || '',
    content: seg.content,
    word_count: seg.content.length
  }));
}

const STOP = new Set(['的', '了', '吗', '呢', '啊', '是', '在', '和', '与', '有', '我', '你', '他', '她', '它', '这', '那', '怎么', '如何', '什么', '可以', '是否', '一下', '请问', '多少']);

// 轻量查询扩展：覆盖用户换说法的常见情况（BM25 无法理解同义词语义）
const SYNONYMS = [
  [/鼓包|膨胀|鼓起|胀包/, ' 鼓包 停止充放电 安全 售后'],
  [/充不进|充不上|无法充电|不充电|充不了/, ' 性能故障 质量问题 检测 退换'],
  [/正品|真假|山寨|假货/, ' 防伪码 序列号 官方 验真'],
  [/退(货|款)|无理由/, ' 退货 无理由 包装 配件 二次销售'],
  [/保修|报修|维修|坏了/, ' 保修 12个月 凭证 售后'],
  [/冒烟|异味|刺鼻|起火/, ' 冒烟 异味 应急 消防 远离'],
  [/第三方|非官方|别的店/, ' 第三方 原购买 渠道 序列号'],
  [/激活|第一次|首次/, ' 激活 首次使用 充电器 指示灯'],
  [/快递|寄回|寄送/, ' 寄送 快递 回收 检测'],
  [/充电多久|充多久|电量/, ' 充电 指示灯 六小时']
];
function expandQuery(q) {
  let out = String(q || '');
  for (const [re, extra] of SYNONYMS) if (re.test(out)) out += extra;
  return out;
}

function tokens(text) {
  const s = String(text || '').toLowerCase();
  const out = [];
  const latin = s.match(/[a-z0-9]+/g) || [];
  latin.forEach(w => { if (w.length > 1 && !STOP.has(w)) out.push(w); });
  const cjkSeq = s.match(/[一-龥]+/g) || [];
  for (const seq of cjkSeq) {
    for (let i = 0; i < seq.length - 1; i++) {
      const gram = seq.slice(i, i + 2);
      if (!STOP.has(gram)) out.push(gram);
    }
    if (seq.length === 1 && !STOP.has(seq)) out.push(seq);
  }
  return out;
}

function bm25Search(segments, query, topK = 5) {
  const qTerms = Array.from(new Set(tokens(expandQuery(query))));
  if (!qTerms.length) return [];
  const docs = segments.map(seg => {
    const text = (seg.heading + ' ' + seg.content).toLowerCase();
    const tf = {};
    tokens(text).forEach(t => { tf[t] = (tf[t] || 0) + 1; });
    return { seg, tf, len: tokens(text).length || 1 };
  });
  const N = docs.length;
  const avgLen = docs.reduce((s, d) => s + d.len, 0) / Math.max(1, N);
  const df = {};
  qTerms.forEach(t => { df[t] = docs.filter(d => d.tf[t]).length; });
  const k1 = 1.4, b = 0.72;
  return docs.map(d => {
    let score = 0;
    qTerms.forEach(t => {
      const f = d.tf[t] || 0;
      if (!f) return;
      const idf = Math.log(1 + (N - df[t] + 0.5) / (df[t] + 0.5));
      score += idf * (f * (k1 + 1)) / (f + k1 * (1 - b + b * d.len / avgLen));
    });
    // 标题/问答短语命中加成
    qTerms.forEach(t => { if ((d.seg.heading || '').toLowerCase().includes(t)) score += 0.6; });
    return { segment: d.seg, score };
  }).sort((a, b2) => b2.score - a.score).filter(r => r.score > 0).slice(0, topK);
}

function extractiveAnswer(query, records) {
  if (!records.length) return '知识库中没有找到可引用的内容，建议转人工处理。';
  const top = records[0];
  const others = records.slice(1, 3).map(r => r.segment.content.slice(0, 80)).join('；');
  return `${top.segment.content}${others ? '\n\n参考补充：' + others : ''}`;
}

module.exports = { extractText, chunkText, bm25Search, extractiveAnswer, tokens, expandQuery };
