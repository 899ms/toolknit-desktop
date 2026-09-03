import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [
  html,
  main,
  globalStyles,
  lazySpecs,
  statsTool,
  statsStyles,
  formatTool,
  formatStyles,
  reader,
  drop
] = await Promise.all([
  readFile(new URL('../index.html', import.meta.url), 'utf8'),
  readFile(new URL('../src/main.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/styles/legacy.css', import.meta.url), 'utf8'),
  readFile(new URL('../src/features/lazy-tools.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/features/text-stats/tool.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/features/text-stats/text-stats.css', import.meta.url), 'utf8'),
  readFile(new URL('../src/features/text-format/tool.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/features/text-format/text-format.css', import.meta.url), 'utf8'),
  readFile(new URL('../src/shared/text-document-reader.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/shared/text-document-drop.js', import.meta.url), 'utf8')
]);

for (const id of [
  'textStatsOverlay', 'textStatsBack', 'textStatsInput', 'textStatsCopyBtn', 'textStatsExportMdBtn',
  'textFormatOverlay', 'textFormatBack', 'textFormatInput', 'textFormatOutput', 'textFormatActions'
]) {
  assert.match(html, new RegExp(`id=["']${id}["']`), `missing text tool DOM contract: ${id}`);
}

assert.match(lazySpecs, /'text-stats':[\s\S]*import\('\.\/text-stats\/tool\.js'\)/);
assert.match(lazySpecs, /'text-format':[\s\S]*import\('\.\/text-format\/tool\.js'\)/);
assert.doesNotMatch(main, /textStatsOverlay|textFormatOverlay|openTextStatsOverlay|openTextFormatOverlay/);
assert.doesNotMatch(main, /calculateTextStats|executeTextFormat|TextFormatError|TEXT_FORMAT_LIMITS/);
assert.doesNotMatch(globalStyles, /\.text-stats|\.text-format|#textStatsOverlay|#textFormatOverlay/);

assert.match(statsTool, /createLifecycleScope/);
assert.match(statsTool, /lifecycle\.invalidate\(\)/);
assert.match(statsTool, /import '\.\/text-stats\.css'/);
assert.match(statsTool, /onLangChange\(\(\) => \{[\s\S]*clearTimeout\(copyTimer\)[\s\S]*copyButtonLabel = ''/);
assert.match(statsStyles, /\.text-stats-v2/);
assert.match(formatTool, /createLifecycleScope/);
assert.match(formatTool, /lifecycle\.invalidate\(\)/);
assert.match(formatTool, /import '\.\/text-format\.css'/);
assert.match(formatTool, /onLangChange\(\(\) => \{[\s\S]*clearTimeout\(copyTimer\)[\s\S]*copyButtonLabel = ''/);
assert.match(formatStyles, /\.text-format-v2/);

assert.match(reader, /read_file_bytes_limited/);
assert.match(reader, /maxBytes:\s*TEXT_STATS_LIMITS\.maxDocumentBytes/);
assert.match(reader, /import\('pdfjs-dist\/legacy\/build\/pdf\.mjs'\)/);
assert.match(drop, /onDragDropEvent/);
assert.match(drop, /lifecycle\.use\(\(\) => unlisten\?\.\(\)\)/);

console.log('Text tools lazy-loading, document-reader and lifecycle contracts passed');
