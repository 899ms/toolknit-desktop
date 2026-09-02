import JSZip from 'jszip';
import { AI_PROVIDER_LIMITS } from './ai-provider-core.js';

export const PPT_TEXT_EXTRACT_LIMITS = Object.freeze({
  maxInputBytes: 200 * 1024 * 1024,
  maxSlides: 500,
  maxSlideTextChars: 50000,
  maxTotalTextChars: 800000,
  maxAiInputChars: 50000
});

export const PPT_TEXT_EXPORT_FORMATS = Object.freeze(['markdown', 'txt', 'json', 'all']);
export const PPT_TEXT_AI_MODES = Object.freeze(['none', 'outline', 'speaker-notes', 'meeting-notes', 'study-notes']);

const XML_TEXT_DECODER = new TextDecoder('utf-8', { fatal: false });
const PLACEHOLDER_SKIP_TYPES = new Set(['dt', 'ftr', 'hdr', 'sldnum', 'sldNum', 'sldImg']);
const TITLE_PLACEHOLDERS = new Set(['title', 'ctrTitle']);
const SECONDARY_TITLE_PLACEHOLDERS = new Set(['subTitle']);

export class PptTextExtractError extends Error {
  constructor(code, message) {
    super(`ppt-text-extract:${code}:${message}`);
    this.name = 'PptTextExtractError';
    this.code = code;
    this.userMessage = message;
  }
}

function fail(code, message) {
  throw new PptTextExtractError(code, message);
}

function toUint8Array(bytes) {
  if (bytes instanceof Uint8Array) return bytes;
  if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes);
  if (ArrayBuffer.isView(bytes)) return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  fail('invalid_request', 'PPTX bytes must be a Uint8Array or ArrayBuffer.');
}

function xmlDecode(value) {
  return String(value || '')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');
}

function extractXmlAttributes(source) {
  const attributes = {};
  for (const match of String(source || '').matchAll(/([A-Za-z_][\w:.-]*)\s*=\s*(["'])(.*?)\2/gs)) {
    attributes[match[1]] = xmlDecode(match[3]);
  }
  return attributes;
}

function normalizeZipPath(value) {
  const normalized = String(value || '').replaceAll('\\', '/').replace(/^\/+/, '');
  const clean = normalized.split('/').filter(Boolean).join('/');
  if (!clean || clean.includes('\0')) return null;
  const posix = clean.replaceAll(/\/+/g, '/');
  if (posix.split('/').includes('..')) return null;
  return posix;
}

function pathPosixNormalize(value) {
  const parts = [];
  for (const part of String(value || '').split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return parts.join('/');
}

function directoryName(partPath) {
  const index = partPath.lastIndexOf('/');
  return index === -1 ? '' : partPath.slice(0, index);
}

function relsPathForPart(partPath) {
  const directory = directoryName(partPath);
  const fileName = partPath.slice(directory.length ? directory.length + 1 : 0);
  return `${directory}/_rels/${fileName}.rels`;
}

function resolveRelationshipTarget(baseDirectory, target) {
  if (!target || /^[a-z][a-z0-9+.-]*:/i.test(target)) return null;
  const normalizedTarget = String(target).replaceAll('\\', '/');
  const joined = normalizedTarget.startsWith('/')
    ? normalizedTarget.slice(1)
    : pathPosixNormalize(`${baseDirectory}/${normalizedTarget}`);
  return normalizeZipPath(joined);
}

function parseRelationships(xml, baseDirectory) {
  const relationships = new Map();
  for (const match of String(xml || '').matchAll(/<Relationship\b([^>]*)\/?>/gi)) {
    const attributes = extractXmlAttributes(match[1]);
    if (!attributes.Id || !attributes.Target) continue;
    if (String(attributes.TargetMode || '').toLowerCase() === 'external') continue;
    const targetPath = resolveRelationshipTarget(baseDirectory, attributes.Target);
    if (!targetPath) continue;
    relationships.set(attributes.Id, {
      id: attributes.Id,
      type: attributes.Type || '',
      target: attributes.Target,
      targetPath
    });
  }
  return relationships;
}

async function readZipText(zip, partPath) {
  const file = zip.file(partPath);
  if (!file) return '';
  return file.async('string');
}

async function readRequiredZipText(zip, partPath) {
  const text = await readZipText(zip, partPath);
  if (!text) fail('invalid_pptx', `PPTX is missing ${partPath}.`);
  return text;
}

function findSlideParts(zip) {
  return Object.keys(zip.files)
    .map(normalizeZipPath)
    .filter(Boolean)
    .filter(partPath => /^ppt\/slides\/slide\d+\.xml$/i.test(partPath))
    .sort((left, right) => {
      const leftNumber = Number(/slide(\d+)\.xml$/i.exec(left)?.[1] || 0);
      const rightNumber = Number(/slide(\d+)\.xml$/i.exec(right)?.[1] || 0);
      return leftNumber - rightNumber;
    });
}

async function orderedSlides(zip) {
  const slideParts = findSlideParts(zip);
  if (slideParts.length < 1) fail('invalid_pptx', 'PPTX does not contain any slides.');
  if (slideParts.length > PPT_TEXT_EXTRACT_LIMITS.maxSlides) {
    fail('too_many_slides', `PPTX contains more than ${PPT_TEXT_EXTRACT_LIMITS.maxSlides} slides.`);
  }

  const presentationXml = await readZipText(zip, 'ppt/presentation.xml');
  const relsXml = await readZipText(zip, 'ppt/_rels/presentation.xml.rels');
  const presentationRels = parseRelationships(relsXml, 'ppt');
  const ordered = [];
  for (const match of String(presentationXml || '').matchAll(/<p:sldId\b([^>]*)\/?>/gi)) {
    const attributes = extractXmlAttributes(match[1]);
    const relationId = attributes['r:id'] || attributes.id;
    const relation = relationId ? presentationRels.get(relationId) : null;
    if (relation?.targetPath && slideParts.includes(relation.targetPath) && !ordered.includes(relation.targetPath)) {
      ordered.push(relation.targetPath);
    }
  }
  const finalOrder = ordered.length ? ordered : slideParts;
  return finalOrder.map((partPath, index) => ({
    partPath,
    slide_number: index + 1,
    source_slide_number: Number(/slide(\d+)\.xml$/i.exec(partPath)?.[1] || index + 1)
  }));
}

function isPptContentTypeValid(contentTypesXml) {
  return /presentationml\.presentation\.main\+xml/i.test(contentTypesXml)
    || /PartName=(["'])\/ppt\/presentation\.xml\1/i.test(contentTypesXml);
}

export function assertPptxTextBytes(bytes, sourceName = 'presentation.pptx') {
  const data = toUint8Array(bytes);
  if (!String(sourceName || '').toLowerCase().endsWith('.pptx')) {
    fail('invalid_extension', 'Only .pptx files are supported in the first PPT text extraction stage.');
  }
  if (data.byteLength < 4 || data[0] !== 0x50 || data[1] !== 0x4B) {
    fail('invalid_pptx', 'PPTX must be a valid ZIP-based PowerPoint file.');
  }
  if (data.byteLength > PPT_TEXT_EXTRACT_LIMITS.maxInputBytes) {
    fail('input_too_large', `PPTX files for text extraction must be ${PPT_TEXT_EXTRACT_LIMITS.maxInputBytes / 1024 / 1024}MB or smaller.`);
  }
  return data;
}

function normalizeText(value) {
  return String(value || '')
    .replace(/\u00A0/g, ' ')
    .replace(/[\t ]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
}

function clampListLevel(value) {
  const level = Number(value);
  if (!Number.isFinite(level)) return 0;
  return Math.max(0, Math.min(8, Math.floor(level)));
}

function toAlphaLower(index) {
  let value = Math.max(1, index + 1);
  let result = '';
  while (value > 0) {
    value -= 1;
    result = String.fromCharCode(97 + (value % 26)) + result;
    value = Math.floor(value / 26);
  }
  return result;
}

function toAlphaUpper(index) {
  return toAlphaLower(index).toUpperCase();
}

function toRoman(index) {
  const value = Math.max(1, index + 1);
  const table = [
    [1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'],
    [100, 'C'], [90, 'XC'], [50, 'L'], [40, 'XL'],
    [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']
  ];
  let remaining = value;
  let result = '';
  for (const [number, numeral] of table) {
    while (remaining >= number) {
      result += numeral;
      remaining -= number;
    }
  }
  return result;
}

function autoNumberLabel(type, index) {
  const number = index + 1;
  switch (String(type || 'arabicPeriod')) {
    case 'arabicParenR': return `${number})`;
    case 'arabicParenL': return `(${number})`;
    case 'arabicPlain': return `${number}`;
    case 'latinLowerPeriod': return `${toAlphaLower(index)}.`;
    case 'latinLowerParenR': return `${toAlphaLower(index)})`;
    case 'latinUpperPeriod': return `${toAlphaUpper(index)}.`;
    case 'latinUpperParenR': return `${toAlphaUpper(index)})`;
    case 'romanLowerPeriod': return `${toRoman(index).toLowerCase()}.`;
    case 'romanLowerParenR': return `${toRoman(index).toLowerCase()})`;
    case 'romanUpperPeriod': return `${toRoman(index)}.`;
    case 'romanUpperParenR': return `${toRoman(index)})`;
    case 'arabicPeriod':
    default: return `${number}.`;
  }
}

function detectParagraphBullet(xml) {
  if (/<a:buNone\b/i.test(xml)) return { kind: 'none' };
  const autoMatch = /<a:buAutoNum\b([^>]*)\/?>/i.exec(xml);
  if (autoMatch) {
    const attributes = extractXmlAttributes(autoMatch[1] || '');
    return { kind: 'auto', type: attributes.type || 'arabicPeriod' };
  }
  const charMatch = /<a:buChar\b[^>]*\bchar\s*=\s*(["'])(.*?)\1/i.exec(xml);
  if (charMatch) return { kind: 'char', char: xmlDecode(charMatch[2]) };
  return { kind: 'none' };
}

function buildParagraphMarker(bullet, level, counters) {
  if (bullet.kind === 'char') return `${bullet.char} `;
  if (bullet.kind === 'auto') {
    const key = `${level}:${bullet.type}`;
    const index = counters.get(key) || 0;
    counters.set(key, index + 1);
    return `${autoNumberLabel(bullet.type, index)} `;
  }
  return '';
}

function extractParagraphsFromXml(fragment) {
  const paragraphs = [];
  const paragraphMatches = [...String(fragment || '').matchAll(/<a:p\b[\s\S]*?<\/a:p>/gi)];
  const sources = paragraphMatches.length ? paragraphMatches.map(match => match[0]) : [fragment];
  const autoCounters = new Map();
  for (const paragraphXml of sources) {
    const pPrMatch = /<a:pPr\b([^>]*)\/?>/i.exec(paragraphXml);
    const pPrAttributes = extractXmlAttributes(pPrMatch?.[1] || '');
    const level = clampListLevel(pPrAttributes.lvl);
    const parts = [];
    for (const match of String(paragraphXml || '').matchAll(/<a:t\b[^>]*>([\s\S]*?)<\/a:t>|<a:br\b[^>]*\/?>|<a:tab\b[^>]*\/?>/gi)) {
      if (/^<a:br/i.test(match[0])) parts.push('\n');
      else if (/^<a:tab/i.test(match[0])) parts.push('\t');
      else parts.push(xmlDecode(match[1] || ''));
    }
    const bodyText = normalizeText(parts.join(''));
    if (!bodyText) continue;
    const marker = buildParagraphMarker(detectParagraphBullet(paragraphXml), level, autoCounters);
    paragraphs.push(`${'  '.repeat(level)}${marker}${bodyText}`);
  }
  return paragraphs;
}

function extractShapeBlocks(xml, { notes = false } = {}) {
  const blocks = [];
  const shapeMatches = [...String(xml || '').matchAll(/<p:sp\b[\s\S]*?<\/p:sp>/gi)];
  const sources = shapeMatches.length ? shapeMatches.map(match => match[0]) : [];
  if (!sources.length) sources.push(xml);
  for (const [index, shapeXml] of sources.entries()) {
    const paragraphs = extractParagraphsFromXml(shapeXml);
    if (!paragraphs.length) continue;
    const placeholderMatch = /<p:ph\b([^>]*)\/?>/i.exec(shapeXml);
    const placeholderAttributes = extractXmlAttributes(placeholderMatch?.[1] || '');
    const placeholderType = placeholderAttributes.type || '';
    if (placeholderType && PLACEHOLDER_SKIP_TYPES.has(placeholderType)) continue;
    const nameMatch = /<p:cNvPr\b([^>]*)\/?>/i.exec(shapeXml);
    const name = extractXmlAttributes(nameMatch?.[1] || '').name || '';
    const text = normalizeText(paragraphs.join('\n'));
    if (!text) continue;
    blocks.push({
      index: index + 1,
      placeholder_type: placeholderType || null,
      placeholder_idx: placeholderAttributes.idx || null,
      name: name || null,
      paragraphs,
      text,
      kind: notes ? 'notes' : 'slide'
    });
  }
  return blocks;
}

function extractTableBlocks(xml, { notes = false } = {}) {
  const blocks = [];
  const frameMatches = [...String(xml || '').matchAll(/<p:graphicFrame\b[\s\S]*?<\/p:graphicFrame>/gi)];
  let tableNumber = 0;
  for (const frameXml of frameMatches.map(match => match[0])) {
    const tableMatch = /<a:tbl\b[\s\S]*?<\/a:tbl>/i.exec(frameXml);
    if (!tableMatch) continue;
    const rows = [];
    for (const trXml of [...String(tableMatch[0]).matchAll(/<a:tr\b[\s\S]*?<\/a:tr>/gi)].map(match => match[0])) {
      const cells = [];
      for (const tcXml of [...String(trXml).matchAll(/<a:tc\b[\s\S]*?<\/a:tc>/gi)].map(match => match[0])) {
        const cellText = normalizeText(extractParagraphsFromXml(tcXml).join(' '));
        if (cellText) cells.push(cellText);
      }
      const rowText = cells.join(' | ');
      if (rowText) rows.push(rowText);
    }
    if (!rows.length) continue;
    tableNumber += 1;
    blocks.push({
      index: -tableNumber,
      placeholder_type: null,
      placeholder_idx: null,
      name: null,
      paragraphs: rows,
      text: rows.join('\n'),
      kind: notes ? 'notes' : 'slide',
      is_table: true
    });
  }
  return blocks;
}

function selectTitleBlock(blocks) {
  const exact = blocks.find(block => TITLE_PLACEHOLDERS.has(block.placeholder_type));
  if (exact) return { block: exact, confidence: 0.97, source: 'placeholder' };
  const secondary = blocks.find(block => SECONDARY_TITLE_PLACEHOLDERS.has(block.placeholder_type));
  if (secondary) return { block: secondary, confidence: 0.78, source: 'subtitle_placeholder' };
  const named = blocks.find(block => /title|标题/i.test(block.name || ''));
  if (named) return { block: named, confidence: 0.72, source: 'shape_name' };
  const first = blocks.find(block => block.text);
  if (first) return { block: first, confidence: 0.55, source: 'first_text_block' };
  return { block: null, confidence: 0, source: 'none' };
}

function textCharCount(values) {
  return values.reduce((sum, value) => sum + normalizeText(value).length, 0);
}

async function analyzeSlideText(zip, slide) {
  const slideXml = await readZipText(zip, slide.partPath);
  const rels = parseRelationships(await readZipText(zip, relsPathForPart(slide.partPath)), directoryName(slide.partPath));
  const slideBlocks = extractShapeBlocks(slideXml);
  const titleChoice = selectTitleBlock(slideBlocks);
  const titleBlock = titleChoice.block;
  const bodyParagraphs = [];
  for (const block of slideBlocks) {
    if (titleBlock && block.index === titleBlock.index) continue;
    bodyParagraphs.push(...block.paragraphs);
  }
  for (const block of extractTableBlocks(slideXml)) {
    bodyParagraphs.push(...block.paragraphs);
  }
  const title = normalizeText(titleBlock?.text || '');
  let notesPartPath = null;
  for (const relation of rels.values()) {
    if (/\/notesSlide$/i.test(relation.type) || /^ppt\/notesSlides\/notesSlide\d+\.xml$/i.test(relation.targetPath)) {
      notesPartPath = relation.targetPath;
      break;
    }
  }
  const notesXml = notesPartPath ? await readZipText(zip, notesPartPath) : '';
  const notesBlocks = notesXml ? extractShapeBlocks(notesXml, { notes: true }) : [];
  const notesTableBlocks = notesXml ? extractTableBlocks(notesXml, { notes: true }) : [];
  const notes = [
    ...notesBlocks.flatMap(block => block.paragraphs),
    ...notesTableBlocks.flatMap(block => block.paragraphs)
  ];
  const allTextParts = [title, ...bodyParagraphs, ...notes].filter(Boolean);
  const charCount = textCharCount(allTextParts);
  if (charCount > PPT_TEXT_EXTRACT_LIMITS.maxSlideTextChars) {
    fail('slide_text_too_large', `Slide ${slide.slide_number} contains more than ${PPT_TEXT_EXTRACT_LIMITS.maxSlideTextChars} extracted characters.`);
  }
  return {
    page: slide.slide_number,
    source_slide_number: slide.source_slide_number,
    part_path: slide.partPath,
    notes_part_path: notesPartPath,
    title,
    title_confidence: titleChoice.confidence,
    title_source: titleChoice.source,
    body: bodyParagraphs,
    notes,
    blocks: slideBlocks,
    text_characters: charCount,
    has_notes: notes.length > 0,
    is_empty: allTextParts.length === 0
  };
}

export async function analyzePptxText(bytes, options = {}) {
  const data = assertPptxTextBytes(bytes, options.sourceName || 'presentation.pptx');
  let zip;
  try {
    zip = await JSZip.loadAsync(data);
  } catch {
    fail('invalid_pptx', 'PPTX could not be opened as a ZIP package.');
  }
  const contentTypes = await readRequiredZipText(zip, '[Content_Types].xml');
  await readRequiredZipText(zip, 'ppt/presentation.xml');
  if (!isPptContentTypeValid(contentTypes)) {
    fail('invalid_pptx', 'PPTX does not look like a PowerPoint presentation package.');
  }
  const slides = await orderedSlides(zip);
  const analyzedSlides = [];
  let totalTextCharacters = 0;
  for (const slide of slides) {
    if (options.signal?.aborted) fail('cancelled', 'PPT text extraction was cancelled.');
    const analyzed = await analyzeSlideText(zip, slide);
    if (options.signal?.aborted) fail('cancelled', 'PPT text extraction was cancelled.');
    analyzedSlides.push(analyzed);
    totalTextCharacters += analyzed.text_characters;
    if (totalTextCharacters > PPT_TEXT_EXTRACT_LIMITS.maxTotalTextChars) {
      fail('text_too_large', `PPTX contains more than ${PPT_TEXT_EXTRACT_LIMITS.maxTotalTextChars} extracted characters.`);
    }
  }
  const bodyParagraphCount = analyzedSlides.reduce((sum, slide) => sum + slide.body.length, 0);
  const notesParagraphCount = analyzedSlides.reduce((sum, slide) => sum + slide.notes.length, 0);
  return {
    source_name: options.sourceName || 'presentation.pptx',
    slide_count: analyzedSlides.length,
    text_characters: totalTextCharacters,
    body_paragraph_count: bodyParagraphCount,
    notes_paragraph_count: notesParagraphCount,
    notes_slide_count: analyzedSlides.filter(slide => slide.has_notes).length,
    empty_slide_count: analyzedSlides.filter(slide => slide.is_empty).length,
    slides: analyzedSlides
  };
}

function normalizePositiveIntegerSelection(value, maxValue, label) {
  if (value === undefined || value === null || value === '') return null;
  const values = [];
  const push = item => {
    if (!Number.isSafeInteger(item) || item < 1 || item > maxValue) {
      fail('invalid_selection', `${label} contains an out-of-range number: ${item}.`);
    }
    values.push(item);
  };
  if (typeof value === 'string') {
    for (const part of value.split(',')) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      const range = /^(\d+)\s*-\s*(\d+)$/.exec(trimmed);
      if (range) {
        const start = Number(range[1]);
        const end = Number(range[2]);
        if (end < start) fail('invalid_selection', `${label} ranges must be ascending.`);
        for (let item = start; item <= end; item++) push(item);
      } else if (/^\d+$/.test(trimmed)) {
        push(Number(trimmed));
      } else {
        fail('invalid_selection', `${label} must use numbers and ranges such as 1,3-5.`);
      }
    }
  } else if (Array.isArray(value)) {
    for (const item of value) push(Number(item));
  } else {
    fail('invalid_selection', `${label} must be an array or a range string.`);
  }
  const unique = [...new Set(values)].sort((left, right) => left - right);
  if (unique.length !== values.length || unique.length < 1) fail('invalid_selection', `${label} must contain unique numbers.`);
  return unique;
}

export function normalizePptTextPageSelection(value, slideCount) {
  return normalizePositiveIntegerSelection(value, slideCount, 'pages');
}

export function normalizePptTextFormat(value = 'markdown') {
  const normalized = String(value || 'markdown').trim().toLowerCase();
  if (normalized === 'md') return 'markdown';
  if (normalized === 'text') return 'txt';
  if (!PPT_TEXT_EXPORT_FORMATS.includes(normalized)) {
    fail('invalid_format', 'format must be markdown, txt, json, or all.');
  }
  return normalized;
}

export function normalizePptTextAiMode(value = 'none') {
  const normalized = String(value || 'none').trim().toLowerCase().replaceAll('_', '-');
  if (normalized === 'off' || normalized === 'false' || normalized === 'no') return 'none';
  if (normalized === 'notes' || normalized === 'script') return 'speaker-notes';
  if (normalized === 'meeting') return 'meeting-notes';
  if (normalized === 'study') return 'study-notes';
  if (!PPT_TEXT_AI_MODES.includes(normalized)) {
    fail('invalid_ai_mode', 'ai_mode must be none, outline, speaker-notes, meeting-notes, or study-notes.');
  }
  return normalized;
}

export function planPptTextExport(manifest, options = {}) {
  if (!manifest || typeof manifest !== 'object' || !Array.isArray(manifest.slides)) {
    fail('invalid_request', 'PPT text manifest is required.');
  }
  const pageSelection = normalizePptTextPageSelection(options.pages, manifest.slide_count);
  const pageSet = pageSelection ? new Set(pageSelection) : null;
  const selected = manifest.slides.filter(slide => !pageSet || pageSet.has(slide.page));
  if (selected.length < 1) {
    fail('invalid_selection', 'No PPT slides matched the requested selection.');
  }
  const format = normalizePptTextFormat(options.format || 'markdown');
  const aiMode = normalizePptTextAiMode(options.ai_mode || 'none');
  return {
    selected_slides: selected,
    selected_count: selected.length,
    selected_text_characters: selected.reduce((sum, slide) => sum + slide.text_characters, 0),
    pages: pageSelection,
    format,
    ai_mode: aiMode
  };
}

function selectedSlidesOf(result) {
  return Array.isArray(result.selected_slides) ? result.selected_slides : (result.slides || []);
}

function markdownEscape(value) {
  return String(value || '').replace(/\|/g, '\\|');
}

function pptBodyListItem(paragraph) {
  const value = String(paragraph || '');
  const leading = /^ */.exec(value)?.[0]?.length || 0;
  const content = value.replace(/^ +/, '');
  const indent = '  '.repeat(Math.floor(leading / 2));
  const hasMarker = /^(?:\d+[.)]|[A-Za-z][.)]|[•·▪◦‣○●‒–—-])\s/.test(content);
  return hasMarker ? `${indent}${content}` : `${indent}- ${content}`;
}

export function createPptTextMarkdown(result) {
  const slides = selectedSlidesOf(result);
  const lines = [
    '# PPT 文本提取',
    '',
    `- 源文件：${result.input?.path || result.input?.name || result.source_name || 'presentation.pptx'}`,
    `- 总页数：${result.slide_count}`,
    `- 导出页数：${slides.length}`,
    `- 备注页数：${slides.filter(slide => slide.has_notes).length}`,
    `- 文本字符数：${slides.reduce((sum, slide) => sum + slide.text_characters, 0)}`,
    ''
  ];
  lines.push('## 页面目录', '');
  lines.push('| 页码 | 标题 | 正文段落 | 备注段落 | 标题置信度 |');
  lines.push('| ---: | --- | ---: | ---: | ---: |');
  for (const slide of slides) {
    lines.push(`| ${slide.page} | ${markdownEscape(slide.title || '未识别标题')} | ${slide.body.length} | ${slide.notes.length} | ${Math.round((slide.title_confidence || 0) * 100)}% |`);
  }
  lines.push('');
  for (const slide of slides) {
    lines.push(`## 第 ${slide.page} 页：${slide.title || '未识别标题'}`, '');
    if (slide.body.length) {
      lines.push('### 正文', '');
      for (const paragraph of slide.body) lines.push(pptBodyListItem(paragraph));
      lines.push('');
    } else {
      lines.push('### 正文', '', '> 未提取到正文。', '');
    }
    if (slide.notes.length) {
      lines.push('### 备注', '');
      for (const note of slide.notes) lines.push(pptBodyListItem(note));
      lines.push('');
    }
  }
  if (result.ai_result?.content) {
    lines.push('## AI 整理结果', '', result.ai_result.content.trim(), '');
  }
  return `${lines.join('\n')}\n`;
}

export function createPptTextTxt(result) {
  const slides = selectedSlidesOf(result);
  const lines = [
    'PPT 文本提取',
    `源文件：${result.input?.path || result.input?.name || result.source_name || 'presentation.pptx'}`,
    `总页数：${result.slide_count}`,
    `导出页数：${slides.length}`,
    ''
  ];
  for (const slide of slides) {
    lines.push(`第 ${slide.page} 页：${slide.title || '未识别标题'}`);
    if (slide.body.length) {
      lines.push('正文：');
      for (const paragraph of slide.body) lines.push(pptBodyListItem(paragraph));
    } else {
      lines.push('正文：未提取到正文。');
    }
    if (slide.notes.length) {
      lines.push('备注：');
      for (const note of slide.notes) lines.push(pptBodyListItem(note));
    }
    lines.push('');
  }
  if (result.ai_result?.content) {
    lines.push('AI 整理结果：', result.ai_result.content.trim(), '');
  }
  return `${lines.join('\n')}\n`;
}

export function createPptTextJson(result) {
  const slides = selectedSlidesOf(result).map(slide => ({
    page: slide.page,
    source_slide_number: slide.source_slide_number,
    title: slide.title,
    title_confidence: slide.title_confidence,
    title_source: slide.title_source,
    body: slide.body,
    notes: slide.notes,
    text_characters: slide.text_characters,
    has_notes: slide.has_notes,
    is_empty: slide.is_empty
  }));
  const payload = {
    source: result.input?.path || result.input?.name || result.source_name || 'presentation.pptx',
    slide_count: result.slide_count,
    selected_count: result.selected_count ?? slides.length,
    text_characters: result.text_characters,
    body_paragraph_count: result.body_paragraph_count,
    notes_paragraph_count: result.notes_paragraph_count,
    notes_slide_count: result.notes_slide_count,
    empty_slide_count: result.empty_slide_count,
    ai_mode: result.ai_mode,
    ai_result: result.ai_result?.content ? result.ai_result.content : undefined,
    slides
  };
  return `${JSON.stringify(payload, null, 2)}\n`;
}

export function createPptTextAiSource(result, options = {}) {
  const maxChars = options.maxChars || PPT_TEXT_EXTRACT_LIMITS.maxAiInputChars;
  const slides = selectedSlidesOf(result);
  const chunks = [];
  let used = 0;
  let truncated = false;
  for (const slide of slides) {
    const piece = [
      `第 ${slide.page} 页`,
      `标题：${slide.title || '未识别标题'}`,
      slide.body.length ? `正文：\n${slide.body.map(item => `- ${item}`).join('\n')}` : '正文：未提取到正文',
      slide.notes.length ? `备注：\n${slide.notes.map(item => `- ${item}`).join('\n')}` : ''
    ].filter(Boolean).join('\n');
    const separatorLength = chunks.length ? 2 : 0;
    if (used + separatorLength + piece.length > maxChars) {
      truncated = true;
      break;
    }
    chunks.push(piece);
    used += separatorLength + piece.length;
  }
  return { text: chunks.join('\n\n'), truncated, used_characters: used, included_slides: chunks.length, total_slides: slides.length };
}

export function buildPptTextAiMessages(result, options = {}) {
  const mode = normalizePptTextAiMode(options.ai_mode || 'outline');
  const locale = options.locale === 'en' ? 'en' : 'zh-CN';
  const outputLanguage = locale === 'en' ? 'English' : 'Simplified Chinese';
  const modeInstruction = {
    outline: '整理成结构化 PPT 大纲：保留页码引用、提炼每页主旨、合并重复信息、列出核心结论和待确认事项。',
    'speaker-notes': '整理成演讲稿/讲解稿：按页输出自然口播稿，每页保留页码标题，不编造未提供的数据。',
    'meeting-notes': '整理成会议纪要：提炼背景、讨论点、决策、行动项、风险和待确认问题，保留页码引用。',
    'study-notes': '整理成课程/学习笔记：按概念、知识点、例子、复习问题组织，保留页码引用。'
  }[mode] || '';
  const framingPrefix = `${modeInstruction}\n\nPPT 提取文本如下：\n\n`;
  const truncatedNote = '\n\n注意：由于文本过长，上面只包含前半部分页面。请明确说明只整理了已提供部分。';
  const source = createPptTextAiSource(result, {
    ...options,
    maxChars: Math.max(1, AI_PROVIDER_LIMITS.maxMessageChars - framingPrefix.length - truncatedNote.length - 8)
  });
  return {
    source,
    messages: [
      {
        role: 'system',
        content: `You are ToolKnit's PPT text organizer. Work only with extracted local PPT text supplied by the user.
Return clean ${outputLanguage} Markdown only.
Do not invent facts, dates, numbers, sources, decisions, or conclusions.
Keep page references such as "第 3 页" / "Slide 3" when summarizing.
If information is missing, write "待确认" or "Not provided" instead of guessing.`
      },
      {
        role: 'user',
        content: `${framingPrefix}${source.text}${source.truncated ? truncatedNote : ''}`
      }
    ]
  };
}

export function sanitizePptTextBaseName(value) {
  const pathBaseName = String(value || 'presentation').split(/[\\/]/).pop() || 'presentation';
  const base = pathBaseName
    .replace(/\.[A-Za-z0-9]+$/, '')
    .replace(/[\\/:*?"<>|\u0000-\u001F]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^[._]+|[._]+$/g, '')
    .slice(0, 80);
  if (!base || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(base)) return 'presentation';
  return base;
}
