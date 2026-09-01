import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createAiDocumentRequestSession } from '../src/features/ai-document/request-session.js';

const [html, main, specs, tool, editor, preview, exporter, prompts] = await Promise.all([
  readFile(new URL('../index.html', import.meta.url), 'utf8'),
  readFile(new URL('../src/main.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/features/lazy-tools.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/features/ai-document/tool.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/features/ai-document/editor.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/features/ai-document/preview.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/features/ai-document/exporter.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/features/ai-document/prompts.js', import.meta.url), 'utf8')
]);

for (const id of [
  'aiDocOverlay', 'aiDocBack', 'aiDocChatMessages', 'aiDocChatInput', 'aiDocChatSend',
  'aiDocThumbScroll', 'aiDocOpenEditorBtn', 'aiDocExportBtn', 'aiDocEditOverlay',
  'aiDocEditScroll', 'aiDocUndoBtn', 'aiDocRedoBtn', 'aiDocSuccessOverlay'
]) {
  assert.match(html, new RegExp(`id=["']${id}["']`), `missing AI Document DOM contract: ${id}`);
}

assert.match(specs, /'ai-doc':\s*Object\.freeze\(\{[\s\S]*?import\('\.\/ai-document\/tool\.js'\)/);
assert.match(main, /toolId === 'ai-polish' \|\| toolId === 'ai-translate' \|\| toolId === 'ai-doc'/);
assert.match(main, /isAiDocEditorDemoEntry[\s\S]*lazyFeatureRegistry\.open\('ai-doc'\)/);
assert.doesNotMatch(main, /AI Document Tool|aiDocOverlay|openAiDocOverlay|AI_DOC_LIMITS|buildAiDocPdf/);

assert.match(tool, /createAiDocumentEditor/);
assert.match(tool, /createAiDocumentPreview/);
assert.match(tool, /createAiDocumentExporter/);
assert.match(tool, /AI_DOC_SYSTEM_PROMPT/);
assert.match(tool, /createLifecycleScope/);
assert.match(tool, /createAiDocumentRequestSession/);
assert.match(tool, /requests\.cancel\(\)/);
assert.match(tool, /session\?\.dispose\(\)/);
assert.match(tool, /isCurrent\(owner, id\)/);
assert.match(tool, /messageScope\.event\(bubble, 'click'/);
assert.doesNotMatch(tool, /\.innerHTML\s*=/);

assert.match(editor, /renderScope\.event\(document, 'mousemove'/);
assert.match(editor, /renderScope\.event\(document, 'mouseup'/);
assert.match(editor, /session\.event\(document, 'keydown'/);
assert.match(editor, /renderScope\?\.dispose\(\)/);
assert.match(editor, /reader\.abort\(\)/);
assert.match(editor, /isOpenSession\(owner\)/);
assert.doesNotMatch(editor, /document\.addEventListener/);
assert.doesNotMatch(editor, /\.innerHTML\s*=/);
assert.ok(editor.split(/\r?\n/).length <= 1200, 'AI Document editor must remain below the oversized-module limit');

assert.match(exporter, /cloneAiDocLayout/);
assert.match(exporter, /buildAiDocPdf/);
assert.match(exporter, /URL\.revokeObjectURL/);
assert.match(exporter, /current\(owner, id\)/);
assert.doesNotMatch(preview, /\.innerHTML\s*=/);
assert.match(prompts, /AI_DOC_EDITOR_DEMO_LAYOUT/);
assert.match(prompts, /坐标系：x 范围 0-794, y 范围 0-1123/);

const timers = new Map();
let timerSeed = 0;
const requests = createAiDocumentRequestSession({
  timeoutMs: 100,
  setTimer(callback) {
    const id = ++timerSeed;
    timers.set(id, callback);
    return id;
  },
  clearTimer(id) { timers.delete(id); }
});
const first = requests.begin();
assert.ok(first);
assert.equal(requests.busy, true);
assert.equal(requests.begin(), null, 'a second request must not start while one is active');
assert.equal(requests.isCurrent(first.id), true);
assert.equal(requests.cancel(), true);
assert.equal(first.signal.aborted, true);
assert.equal(requests.isCurrent(first.id), false, 'cancelled work must become stale before it settles');
assert.equal(requests.finish(first.id), false, 'a cancelled request must not finish as current');
const second = requests.begin();
timers.get([...timers.keys()][0])();
assert.equal(second.signal.aborted, true);
assert.equal(second.timedOut(), true);
assert.equal(requests.finish(second.id), true);
assert.equal(requests.busy, false);

console.log('AI Document lazy-loading, module ownership, lifecycle and injection contracts passed');
