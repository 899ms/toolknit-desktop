import { simplifyChineseText } from '../../core/chinese-text.js';

export function extractBalancedJson(value, start = 0) {
  const source = String(value || '');
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') { quoted = true; continue; }
    if (char === '{') depth += 1;
    else if (char === '}' && --depth === 0) return source.slice(start, index + 1);
  }
  return null;
}

export function parseTranscriptionSrt(value) {
  return String(value || '').replace(/^\uFEFF/, '').trim().split(/\r?\n\s*\r?\n/).map(block => {
    const lines = block.split(/\r?\n/).map(line => line.trimEnd()).filter(line => line.trim());
    if (!lines.length) return null;
    let id = Number(lines[0]);
    let timingIndex = 1;
    if (!Number.isInteger(id)) {
      id = 0;
      timingIndex = 0;
    }
    const timing = lines[timingIndex] || '';
    const match = /^(.+?)\s+-->\s+(.+?)(?:\s+.*)?$/.exec(timing.trim());
    const textLines = lines.slice(timingIndex + 1);
    if (!match || textLines.length === 0) return null;
    return { id, start: match[1], end: match[2], text: simplifyChineseText(textLines.join('\n').trim()) };
  }).filter(Boolean);
}

export function parseRefinedTranscriptionResponse(value, expectedIds) {
  const ids = expectedIds instanceof Set ? expectedIds : new Set(expectedIds || []);
  const source = String(value || '').replace(/```(?:json)?/gi, '').replace(/```/g, '').trim();
  const start = source.indexOf('{');
  const json = start >= 0 ? extractBalancedJson(source, start) : null;
  const parsed = JSON.parse(json || source);
  if (!Array.isArray(parsed?.segments) || parsed.segments.length !== ids.size) {
    throw new Error('Invalid refinement response');
  }
  const updated = new Map();
  for (const segment of parsed.segments) {
    const id = Number(segment?.id);
    const text = typeof segment?.text === 'string' ? segment.text.trim() : '';
    if (!ids.has(id) || updated.has(id) || !text || text.length > 1200) {
      throw new Error('Invalid refinement response');
    }
    updated.set(id, simplifyChineseText(text));
  }
  if (updated.size !== ids.size) throw new Error('Invalid refinement response');
  return updated;
}
