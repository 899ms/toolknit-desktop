import pdfWorkerUrl from 'pdfjs-dist/legacy/build/pdf.worker.mjs?url';
import { pdfjsDocumentOptions } from './pdfjs-options.js';
import JSZip from 'jszip';
import { TEXT_STATS_LIMITS } from '../text-stats-core.js';
import { tauriCorePromise } from '../platform/tauri-runtime.js';

export const TEXT_DOCUMENT_EXTENSIONS = Object.freeze([
  'txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'html', 'htm', 'docx', 'pdf'
]);

function normalizeBytes(rawBytes) {
  if (rawBytes instanceof Uint8Array) return rawBytes;
  if (rawBytes instanceof ArrayBuffer) return new Uint8Array(rawBytes);
  if (ArrayBuffer.isView(rawBytes)) {
    return new Uint8Array(rawBytes.buffer, rawBytes.byteOffset, rawBytes.byteLength);
  }
  if (Array.isArray(rawBytes)) return Uint8Array.from(rawBytes);
  if (rawBytes && typeof rawBytes.length === 'number') return Uint8Array.from(rawBytes);
  return new Uint8Array();
}

export function isSupportedTextDocument(name) {
  return /\.(txt|md|markdown|csv|tsv|json|html|htm|docx|pdf)$/i.test(String(name || ''));
}

export function getTextDocumentKind(name) {
  const extension = String(name || '').split('.').pop()?.toLowerCase() || '';
  if (extension === 'docx') return 'DOCX';
  if (extension === 'pdf') return 'PDF';
  if (['md', 'markdown'].includes(extension)) return 'Markdown';
  if (['html', 'htm'].includes(extension)) return 'HTML';
  if (['csv', 'tsv'].includes(extension)) return extension.toUpperCase();
  if (extension === 'json') return 'JSON';
  return 'TEXT';
}

export function decodeTextDocumentBytes(rawBytes) {
  const bytes = normalizeBytes(rawBytes);
  if (bytes.byteLength > TEXT_STATS_LIMITS.maxDocumentBytes) {
    throw new Error('text-document:file-too-large');
  }
  const decoders = [
    () => new TextDecoder('utf-8', { fatal: true }).decode(bytes),
    () => new TextDecoder('gb18030').decode(bytes),
    () => new TextDecoder('utf-8').decode(bytes)
  ];
  for (const decode of decoders) {
    try { return decode().replace(/^\uFEFF/, ''); } catch { /* try fallback */ }
  }
  throw new Error('text-document:decode-failed');
}

export function stripTextDocumentHtml(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|section|article|li|h[1-6]|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function extractTextDocumentDocxXml(xml) {
  return String(xml || '')
    .replace(/<w:tab\/>/g, '\t')
    .replace(/<w:br\/>/g, '\n')
    .replace(/<\/w:p>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function readDocx(bytes) {
  const zip = await JSZip.loadAsync(bytes);
  const documentXml = await zip.file('word/document.xml')?.async('string');
  if (!documentXml) throw new Error('text-document:invalid-docx');
  return extractTextDocumentDocxXml(documentXml);
}

async function readPdf(bytes) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
  const loadingTask = pdfjs.getDocument(pdfjsDocumentOptions({ data: normalizeBytes(bytes).slice() }));
  try {
    const pdf = await loadingTask.promise;
    if (pdf.numPages > TEXT_STATS_LIMITS.maxPdfPages) {
      throw new Error('text-document:too-many-pages');
    }
    const pages = [];
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent();
      pages.push(content.items.map(item => item.str || '').join(' ').trim());
      page.cleanup?.();
    }
    return pages.join('\n\n').trim();
  } finally {
    await loadingTask.destroy?.();
  }
}

async function readFileBytes(file, isTauri) {
  const name = String(file?.name || file?.path || '').trim();
  if (!isSupportedTextDocument(name)) throw new Error('text-document:unsupported-file');
  if (isTauri && file?.path) {
    const { invoke } = await tauriCorePromise;
    return normalizeBytes(await invoke('read_file_bytes_limited', {
      path: file.path,
      maxBytes: TEXT_STATS_LIMITS.maxDocumentBytes
    }));
  }
  if (typeof file?.arrayBuffer !== 'function') throw new Error('text-document:read-failed');
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.byteLength > TEXT_STATS_LIMITS.maxDocumentBytes) {
    throw new Error('text-document:file-too-large');
  }
  return bytes;
}

export async function readTextDocument(file, {
  isTauri = false,
  fallbackName = 'Document',
  onTrim
} = {}) {
  const name = String(file?.name || file?.path || '').split(/[/\\]/).pop() || fallbackName;
  const bytes = await readFileBytes(file, isTauri);
  let text;
  if (/\.docx$/i.test(name)) text = await readDocx(bytes);
  else if (/\.pdf$/i.test(name)) text = await readPdf(bytes);
  else {
    text = decodeTextDocumentBytes(bytes);
    if (/\.(html|htm)$/i.test(name)) text = stripTextDocumentHtml(text);
  }
  if (!text.trim()) throw new Error('text-document:empty-document');
  let truncated = false;
  if (text.length > TEXT_STATS_LIMITS.maxInputChars) {
    text = text.slice(0, TEXT_STATS_LIMITS.maxInputChars);
    truncated = true;
    onTrim?.(TEXT_STATS_LIMITS.maxInputChars);
  }
  return { name, bytes: bytes.byteLength, text, kind: getTextDocumentKind(name), truncated };
}

export function textDocumentErrorKey(error) {
  const message = String(error?.message || error || '').toLowerCase();
  if (message.includes('unsupported-file')) return 'unsupportedFile';
  if (message.includes('file-too-large')) return 'fileTooLarge';
  if (message.includes('too-many-pages')) return 'tooManyPdfPages';
  if (message.includes('empty-document')) return 'emptyDocument';
  if (message.includes('invalid-docx')) return 'invalidDocx';
  if (message.includes('decode-failed')) return 'decodeFailed';
  return 'readFailed';
}
