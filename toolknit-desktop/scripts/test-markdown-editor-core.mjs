import assert from 'node:assert/strict';
import * as compatibleCore from '../src/markdown-editor-core.js';
import {
  applyMarkdownAction,
  buildStandaloneMarkdownHtml,
  createMarkdownRenderer,
  extractMarkdownHeadings,
  rewriteMarkdownImages,
  sanitizeExportBaseName
} from '../src/features/markdown-editor/core.js';
import { markdownPreviewAssetUrl } from '../src/features/markdown-editor/preview-security.js';

assert.equal(compatibleCore.applyMarkdownAction, applyMarkdownAction);
assert.equal(compatibleCore.createMarkdownRenderer, createMarkdownRenderer);
assert.equal(markdownPreviewAssetUrl('a/b'), 'https://toolknit.local/markdown-asset/a%2Fb');

assert.deepEqual(extractMarkdownHeadings('# A\n```md\n## hidden\n```\n### [Visible](x)'), [
  { level: 1, text: 'A', line: 1, id: 'md-heading-1' },
  { level: 3, text: 'Visible', line: 5, id: 'md-heading-2' }
]);
assert.deepEqual(extractMarkdownHeadings('Setext title\n===\n\n> # Quoted\n\n## Final'), [
  { level: 1, text: 'Setext title', line: 1, id: 'md-heading-1' },
  { level: 1, text: 'Quoted', line: 4, id: 'md-heading-2' },
  { level: 2, text: 'Final', line: 6, id: 'md-heading-3' }
]);
const renderedMath = createMarkdownRenderer().render('first $a+b$ and second $c+d$\n\n$$x+y$$');
assert.match(renderedMath, /a\+b/);
assert.match(renderedMath, /c\+d/);
assert.match(renderedMath, /x\+y/);
assert.deepEqual(applyMarkdownAction('hello', 0, 5, 'bold'), { text: '**hello**', start: 2, end: 7 });
assert.equal(rewriteMarkdownImages('![](blob:a)', [{ source: 'blob:a', fileName: 'image.png' }]), '![](assets/image.png)');
assert.equal(sanitizeExportBaseName(' a<>b. '), 'a--b');
const html = buildStandaloneMarkdownHtml({ title: '<Title>', renderedHtml: '<h1>ok</h1>' });
assert.match(html, /&lt;Title&gt;/);
assert.match(html, /<main><h1>ok<\/h1><\/main>/);
assert.match(html, /Content-Security-Policy/);
assert.match(html, /default-src 'none'/);
assert.match(html, /img-src data:/);
assert.match(html, /name="referrer" content="no-referrer"/);
console.log('markdown editor core tests passed');
