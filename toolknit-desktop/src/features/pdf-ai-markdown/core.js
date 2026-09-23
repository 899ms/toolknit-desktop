export const PDF_AI_MARKDOWN_LIMITS = Object.freeze({
  maxDocumentBytes: 150 * 1024 * 1024,
  maxPages: 120,
  maxImageBytes: 7 * 1024 * 1024,
  maxTextPerPage: 50_000,
  maxSummaryChars: 28000
});

export function sourceName(file) {
  return String(file?.name || file?.fileName || file?.path?.split(/[\\/]/).pop() || 'document.pdf');
}

export function isPdfFile(file) {
  return /\.pdf$/i.test(sourceName(file)) || String(file?.type || '').toLowerCase() === 'application/pdf';
}

export function normalizeBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (Array.isArray(value)) return Uint8Array.from(value);
  return new Uint8Array();
}

export function parseJsonResponse(value) {
  let text = String(value ?? '').trim();
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  try { return JSON.parse(text); } catch { return null; }
}

function text(value, fallback = '') {
  return typeof value === 'string' || typeof value === 'number' ? String(value).trim() : fallback;
}

export function conversionError(code) {
  return Object.assign(new Error(`pdf-ai-markdown:${code}`), { code });
}

export function assertActive(signal) {
  if (signal?.aborted) throw conversionError('aborted');
}

function normalizeBlock(block) {
  if (!block || typeof block !== 'object') return null;
  const type = text(block.type, 'paragraph').toLowerCase();
  if (type === 'heading') {
    const value = text(block.text);
    return value ? { type, level: Math.max(1, Math.min(6, Math.floor(Number(block.level) || 2))), text: value } : null;
  }
  if (type === 'list') {
    const items = Array.isArray(block.items) ? block.items.map(item => text(item)).filter(Boolean) : [];
    return items.length ? { type, ordered: Boolean(block.ordered), items } : null;
  }
  if (type === 'table') {
    const columns = Array.isArray(block.columns) ? block.columns.map(value => text(value)) : [];
    const rows = Array.isArray(block.rows) ? block.rows.map(row => Array.isArray(row)
      ? row.map(value => text(value)) : []).filter(row => row.length) : [];
    return columns.length || rows.length ? { type, caption: text(block.caption), columns, rows } : null;
  }
  if (type === 'image' || type === 'formula') {
    const value = text(block.description || block.text || block.latex);
    return value ? { type, description: value, latex: type === 'formula' ? text(block.latex || block.text) : '' } : null;
  }
  const value = text(block.text || block.content);
  return value ? { type: 'paragraph', text: value } : null;
}

export function normalizePageAnalysis(value, pageNumber) {
  if (!value || !Array.isArray(value.blocks)) throw conversionError('invalid-response');
  if (JSON.stringify(value).length > PDF_AI_MARKDOWN_LIMITS.maxTextPerPage) throw conversionError('page-too-large');
  const source = value;
  const blocks = source.blocks.map(normalizeBlock);
  if (blocks.some(block => !block) || (!blocks.length && source.pageType !== 'blank')) throw conversionError('invalid-response');
  const warnings = Array.isArray(source.warnings) ? source.warnings.map(value => text(value)).filter(Boolean) : [];
  return {
    pageNumber,
    pageType: text(source.pageType, 'document'),
    blocks,
    warnings,
    confidence: Number.isFinite(Number(source.confidence)) ? Math.max(0, Math.min(1, Number(source.confidence))) : null
  };
}

export function normalizeSummary(value) {
  if (!value || typeof value.summary !== 'string' || !value.summary.trim()) throw conversionError('invalid-response');
  const source = value;
  const summary = text(source.summary || source.abstract);
  const title = text(source.title);
  const outline = Array.isArray(source.outline) ? source.outline.map(item => text(item)).filter(Boolean).slice(0, 100) : [];
  return { title, summary, outline };
}

export function isVisionModelConfigured(config = {}) {
  return Boolean(String(config.url || '').trim() && String(config.model || '').trim());
}

// Split the full source, including long individual pages, without dropping a tail.
export function splitSummarySources(sources, limit = PDF_AI_MARKDOWN_LIMITS.maxSummaryChars) {
  const batches = [];
  let current = [];
  for (const source of sources) {
    for (let start = 0; start < source.text.length; start += 4000) {
      const fragment = { pageNumber: source.pageNumber, text: source.text.slice(start, start + 4000) };
      if (JSON.stringify([...current, fragment]).length > limit && current.length) {
        batches.push(current);
        current = [];
      }
      current.push(fragment);
    }
  }
  if (current.length) batches.push(current);
  return batches;
}
