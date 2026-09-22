import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { LAZY_TOOL_SPECS } from '../src/features/lazy-tools.js';
import { normalizePageAnalysis, parseJsonResponse, splitSummarySources } from '../src/features/pdf-ai-markdown/core.js';
import { serializeAiMarkdown } from '../src/features/pdf-ai-markdown/markdown-serializer.js';
import { analyzePdfPages } from '../src/features/pdf-ai-markdown/pipeline.js';
import { buildSummaryMessages } from '../src/features/pdf-ai-markdown/ai-messages.js';

const page = { blocks: [
  { type: 'heading', level: 2.7, text: 'Report' },
  { type: 'paragraph', text: '中文 / English <script>data</script> ![remote](https://example.test/a)' },
  { type: 'table', caption: 'Totals', columns: ['A|B'], rows: [[0, 12], ['Second\nline', 'C']] },
  { type: 'list', ordered: true, items: ['One', 'Two'] },
  { type: 'image', description: 'Chart: 12 units' },
  { type: 'formula', latex: 'E=mc^2' }
], warnings: [] };
const normalized = normalizePageAnalysis(parseJsonResponse('```json\n' + JSON.stringify(page) + '\n```'), 2);
assert.equal(normalized.blocks[0].level, 2);
assert.equal(normalized.blocks[2].rows[0][0], '0');
for (const invalid of [null, {}, { blocks: [] }, { blocks: [{ type: 'paragraph', text: '' }] }]) {
  assert.throws(() => normalizePageAnalysis(invalid, 1));
}
assert.equal(normalizePageAnalysis({ pageType: 'blank', blocks: [] }, 1).blocks.length, 0);
const markdown = serializeAiMarkdown({ pages: [normalized] });
for (const expected of ['source-page: 2', 'Totals', '0 | 12', 'Second line', 'E=mc^2', '中文 / English', '&lt;script&gt;']) assert.ok(markdown.includes(expected), expected);
assert.ok(!markdown.includes('![remote]('), 'model content must not create a remote image');

const source = 'Long original 中文 ' + 'x'.repeat(110000) + 'TAIL';
const batches = splitSummarySources([{ pageNumber: 120, text: source }]);
assert.ok(batches.length > 1);
assert.equal(batches.flat().map(part => part.text).join(''), source);
for (const batch of batches) {
  assert.ok(buildSummaryMessages({ sources: batch })[1].content.length < 50000);
}

let phase = 'partial';
const calls = [];
const requestAi = async messages => {
  if (!Array.isArray(messages[1].content)) return JSON.stringify({ title: 'Report', summary: 'Full guide', outline: ['Page 1'] });
  const instruction = messages[1].content[0].text;
  const number = Number(instruction.match(/page (\d+)/)[1]);
  calls.push(number);
  if (number === 2 && phase === 'partial') return 'invalid JSON';
  return JSON.stringify(page);
};
const options = { totalPages: 3, renderPage: async () => 'data:image/jpeg;base64,YWJj', requestAi, signal: new AbortController().signal };
const partial = await analyzePdfPages(options);
assert.equal(partial.pages[1].failed, true);
assert.ok(partial.pages[0].blocks.length);
phase = 'success'; calls.length = 0;
const complete = await analyzePdfPages({ ...options, previousPages: partial.pages });
assert.deepEqual(calls, [2], 'retry must request only the failed page');
assert.equal(complete.pages.some(page => page.failed), false);
let requests = 0;
await assert.rejects(analyzePdfPages({ ...options, requestAi: async () => { requests++; throw Object.assign(new Error('bad key'), { code: 'http_error', status: 401 }); } }));
assert.equal(requests, 1, 'authentication failures must stop the queue');
await assert.rejects(analyzePdfPages({ ...options, requestAi: async () => '{}' }), /invalid-response/);
const summaryFailure = await analyzePdfPages({ ...options, requestAi: async messages => Array.isArray(messages[1].content) ? JSON.stringify(page) : '{}' });
assert.equal(summaryFailure.summaryFailed, true);
assert.equal(summaryFailure.pages.length, 3);
const aborter = new AbortController();
let renders = 0;
await assert.rejects(analyzePdfPages({ ...options, signal: aborter.signal, renderPage: async () => { renders++; aborter.abort(); return ''; } }), /aborted/);
assert.equal(renders, 1);

const read = path => readFile(new URL('../' + path, import.meta.url), 'utf8');
const template = await read('src/features/pdf-ai-markdown/template.html');
const controller = await read('src/features/pdf-ai-markdown/controller.js');
const tool = await read('src/features/pdf-ai-markdown/tool.js');
const css = await read('src/features/pdf-ai-markdown/pdf-ai-markdown.css');
const html = await read('index.html');
assert.equal(LAZY_TOOL_SPECS['pdf-ai-markdown'].overlayId, 'pdfAiMarkdownOverlay');
assert.match(html, /data-tool="pdf-ai-markdown"/);
assert.match(tool, /styles\/components\/pdf-markdown-workspace\.css/);
assert.doesNotMatch(css, /#[\da-f]{3,8}\b|rgba?\(/i, 'new feature must reuse existing theme colors');
assert.doesNotMatch(controller, /innerHTML\s*=|@tauri-apps|ppt-workflows/);
assert.match(controller, /openLazyTool\?\.\('markdown-editor'\)/);
for (const [, id] of controller.matchAll(/query\('([^']+)'\)/g)) assert.ok(template.includes(`id="pdfAiMarkdown${id}"`), id);
const localeKeys = [...template.matchAll(/data-i18n(?:-title|-aria-label)?="([^"]+)"/g)].map(match => match[1]);
for (const lang of ['zh', 'en']) {
  const dictionary = JSON.parse(await read(`src/locales/${lang}.json`));
  for (const key of localeKeys) assert.equal(typeof key.split('.').reduce((value, part) => value?.[part], dictionary), 'string', `${lang}: ${key}`);
  for (const state of ['empty', 'loading', 'selected', 'processing', 'success', 'partial', 'error']) {
    for (const suffix of ['Title', 'Badge', 'Desc']) assert.equal(typeof dictionary.home.pdfAiMarkdown[state + suffix], 'string');
  }
  for (const [, key] of controller.matchAll(/(?:localize|showToast)\('([^']+)'/g)) assert.equal(typeof dictionary.home.pdfAiMarkdown[key], 'string', `${lang}: ${key}`);
}
console.log('AI PDF schema, complete serialization, bounded full-document summaries, retry, cancellation and UI contracts passed');
