import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { LAZY_TOOL_SPECS } from '../src/features/lazy-tools.js';

const read = relativePath => readFile(new URL(relativePath, import.meta.url), 'utf8');
const [
  tool,
  controller,
  template,
  previewSecurity,
  compatibilityUi,
  compatibilityCore,
  featureStyles,
  appStyles,
  finalToolStyles
] = await Promise.all([
  read('../src/features/markdown-editor/tool.js'),
  read('../src/features/markdown-editor/controller.js'),
  read('../src/features/markdown-editor/template.js'),
  read('../src/features/markdown-editor/preview-security.js'),
  read('../src/markdown-editor-ui.js'),
  read('../src/markdown-editor-core.js'),
  read('../src/features/markdown-editor/markdown-editor.css'),
  read('../src/styles.css'),
  read('../src/tool-page-v2-final.css')
]);

assert.match(tool, /from ['"]\.\/template\.js['"]/);
assert.match(tool, /from ['"]\.\/controller\.js['"]/);
assert.match(tool, /import ['"]\.\/markdown-editor\.css['"]/);
assert.match(controller, /createLifecycleScope\(\)/);
assert.match(controller, /lifecycle\.event\(overlay, ['"]click['"]/);
assert.match(controller, /lifecycle\.use\(bindToolPageChrome\(shell, close\)\)/);
assert.match(controller, /owner\.use\(mountToolPageBackground\(shell\)\)/);
assert.match(controller, /isOpenSession\(owner\)/);
assert.match(controller, /htmlLabels: false/, 'Mermaid labels must stay in sanitizable native SVG text');
assert.match(controller, /return \{ open, close, dispose \}/);
assert.match(controller, /from ['"]\.\.\/\.\.\/platform\/tauri-runtime\.js['"]/);
assert.doesNotMatch(controller, /from ['"]@tauri-apps\//);
assert.doesNotMatch(controller, /\.addEventListener\(/);
assert.match(template, /data-lucide="save"/);
assert.doesNotMatch(template, /data-lucide="cloud-check"/);
assert.match(previewSecurity, /template\.content\.querySelectorAll\(['"]img['"]\)/);
assert.match(previewSecurity, /template\.content\.querySelectorAll\(['"]a['"]\)/);
assert.match(previewSecurity, /link\.removeAttribute\(['"]target['"]\)/);
assert.match(previewSecurity, /link\.setAttribute\(['"]rel['"], ['"]noopener noreferrer['"]\)/);
assert.match(previewSecurity, /!\['http:', 'https:'\]\.includes\(parsed\.protocol\)/);
assert.match(compatibilityUi, /from ['"]\.\/features\/markdown-editor\/tool\.js['"]/);
assert.match(compatibilityCore, /from ['"]\.\/features\/markdown-editor\/core\.js['"]/);
assert.match(featureStyles, /\.md-workbench\s*\{/);
assert.match(
  featureStyles,
  /\.md-editor-view\[data-view="preview"\] \.md-input-pane,[\s\S]*\.md-editor-view\[data-view="editor"\] \.md-preview-pane[\s\S]*display: none !important/,
  'single-pane view modes must outrank the shared pane display rule'
);
assert.match(featureStyles, /\.markdown-body \.mermaid svg[\s\S]*width: 100% !important/, 'Mermaid diagrams must outrank the global overlay icon size');
assert.match(featureStyles, /@media \(max-width: 760px\)[\s\S]*data-view="split"[\s\S]*\.md-preview-pane[\s\S]*display: none !important/, 'narrow split mode must not leave an unreachable second pane');
assert.doesNotMatch(
  appStyles + finalToolStyles,
  /\.md-|\.markdown-body|\.markdown-editor-overlay/,
  'shared stylesheets must not retain Markdown editor selectors'
);
assert.equal(LAZY_TOOL_SPECS['markdown-editor']?.overlayId, 'markdownEditorOverlay');
assert.match(
  LAZY_TOOL_SPECS['markdown-editor'].load.toString(),
  /\.\/markdown-editor\/tool\.js/,
  'Markdown must load the feature entry directly'
);

console.log('markdown editor feature contract checks passed');
