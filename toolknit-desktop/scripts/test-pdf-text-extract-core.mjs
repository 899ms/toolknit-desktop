import assert from 'node:assert/strict';
import {
  convertPdfPagesToMarkdown,
  normalizePdfTextError,
  reconstructPdfPage
} from '../src/features/pdf-text-extract/core.js';

function item(str, x, y, { width = Math.max(8, str.length * 7), size = 10, fontName = 'g_regular', hasEOL = false } = {}) {
  return { str, width, height: size, transform: [size, 0, 0, size, x, y], fontName, hasEOL };
}

const page = reconstructPdfPage([
  item('项目', 40, 760, { size: 18, fontName: 'g_bold' }),
  item('这是第一段中文内容。', 40, 720, { width: 120 }),
  item('用于验证 PDF 文本重排。', 40, 704, { width: 130 }),
  item('- 第一项', 40, 670),
  item('- 第二项', 40, 654),
  item('名称', 40, 610, { width: 32 }),
  item('数量', 180, 610, { width: 32 }),
  item('文件', 40, 594, { width: 32 }),
  item('3', 180, 594, { width: 10 })
], { pageNumber: 1, pageWidth: 600, pageHeight: 800 });

assert.equal(page.hasText, true);
assert.match(page.text, /项目/);
assert.match(page.text, /第一项/);
assert.ok(page.lines.length >= 5);

const markdown = convertPdfPagesToMarkdown([page], { sourceName: 'sample.pdf' });
assert.match(markdown.markdown, /^# sample/m);
assert.match(markdown.markdown, /<!-- source-page: 1 -->/);
assert.match(markdown.markdown, /##? 项目/);
assert.match(markdown.markdown, /- 第一项/);
assert.match(markdown.markdown, /\| 名称 \| 数量 \|/);
assert.equal(markdown.pagesWithText, 1);
assert.equal(markdown.status, 'success');

const empty = reconstructPdfPage([], { pageNumber: 2 });
const scanned = convertPdfPagesToMarkdown([empty], { sourceName: 'scan.pdf' });
assert.equal(scanned.status, 'no-text');
assert.equal(scanned.isScanned, true);
assert.deepEqual(scanned.emptyPages, [2]);
assert.match(scanned.markdown, /Page 2 has no selectable text/);

const partial = convertPdfPagesToMarkdown([page, { pageNumber: 2, error: { code: 'page-read-failed' } }], { sourceName: 'partial.pdf' });
assert.equal(partial.status, 'partial');
assert.deepEqual(partial.failedPages, [2]);
assert.match(partial.markdown, /<!-- source-page: 2 -->/);

const columns = reconstructPdfPage([
  item('左栏一', 40, 700, { width: 45 }),
  item('右栏一', 340, 700, { width: 45 }),
  item('左栏二', 40, 680, { width: 45 }),
  item('右栏二', 340, 680, { width: 45 }),
  item('左栏三', 40, 660, { width: 45 }),
  item('右栏三', 340, 660, { width: 45 }),
  item('左栏四', 40, 640, { width: 45 }),
  item('右栏四', 340, 640, { width: 45 })
], { pageNumber: 3, pageWidth: 600 });
assert.equal(columns.columns, 2);
assert.ok(columns.text.indexOf('左栏四') < columns.text.indexOf('右栏一'));

assert.equal(normalizePdfTextError({ name: 'PasswordException', message: 'Password required' }).code, 'password-protected');
assert.equal(normalizePdfTextError({ name: 'InvalidPDFException' }).code, 'invalid-pdf');
assert.equal(normalizePdfTextError({ name: 'AbortException' }).code, 'cancelled');

console.log('PDF text extraction core tests passed.');
