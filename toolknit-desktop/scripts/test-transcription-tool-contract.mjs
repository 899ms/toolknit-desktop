import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseRefinedTranscriptionResponse, parseTranscriptionSrt } from '../src/features/transcription/core.js';

const [controller, tool, featureStyles, lazy, main, index] = await Promise.all([
  readFile(new URL('../src/features/transcription/controller.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/features/transcription/tool.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/features/transcription/transcription.css', import.meta.url), 'utf8'),
  readFile(new URL('../src/features/lazy-tools.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/main.js', import.meta.url), 'utf8'),
  readFile(new URL('../index.html', import.meta.url), 'utf8')
]);

const parsed = parseTranscriptionSrt('1\n00:00:00,000 --> 00:00:01,000\n你好\n\n2\n00:00:01,000 --> 00:00:02,000\n世界');
assert.deepEqual(parsed.map(segment => segment.text), ['你好', '世界']);
assert.throws(() => parseRefinedTranscriptionResponse('{"segments":[{"id":1,"text":""}]}', new Set([1])), /Invalid refinement/);
assert.deepEqual([...parseRefinedTranscriptionResponse('```json\n{"segments":[{"id":1,"text":"你好。"}]}\n```', new Set([1])).values()], ['你好。']);

assert.match(tool, /from ['"]\.\/controller\.js['"]/, 'transcription entry must delegate behavior to its controller');
assert.match(tool, /import ['"]\.\/transcription\.css['"]/, 'transcription entry must own its lazy stylesheet');
assert.match(controller, /createLifecycleScope\(\)/, 'transcription controller must own lifecycle cleanup');
assert.match(controller, /lifecycle\.event\(transcriptionProcessBtn/, 'transcription process listener must be scoped');
assert.match(controller, /nativeDragUnlisten = await webview\.onDragDropEvent/, 'native drag listener must be retained');
assert.match(controller, /lifecycle\.use\(\(\) => \{ try \{ nativeDragUnlisten/, 'native drag listener must be released');
assert.match(controller, /const operationToken = lifecycle\.invalidate\(\)/, 'transcription processing must invalidate stale work');
assert.match(controller, /!lifecycle\.isCurrent\(operationToken\)/, 'transcription results must be guarded by the active lifecycle token');
assert.match(controller, /setTranscriptionSuccessVisible\(true\)/, 'transcription completion dialog must become visible');
assert.match(controller, /return \{ open: openTranscriptionTool, close: closeTranscriptionTool, dispose \}/, 'transcription must implement the lifecycle contract');
assert.doesNotMatch(controller, /from ['"]@tauri-apps\//, 'transcription must use the platform boundary');
assert.match(lazy, /transcription:[\s\S]*?\.\/transcription\/tool\.js/, 'transcription must be lazy-registered');
assert.match(main, /toolId === 'transcription'[\s\S]*check_transcription_engine/, 'transcription dependency gate must run before open');
assert.match(featureStyles, /transcription-v2-preview/, 'transcription styles must load with the feature');
assert.match(index, /id="transcriptionOverlay"/, 'transcription overlay DOM contract must remain present');

console.log('transcription tool contract passed');
