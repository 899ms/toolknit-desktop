import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [html, main, globalStyles, lazySpecs, polish, polishStyles, translate, translateStyles, sharedStyles] = await Promise.all([
  readFile(new URL('../index.html', import.meta.url), 'utf8'),
  readFile(new URL('../src/main.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/styles.css', import.meta.url), 'utf8'),
  readFile(new URL('../src/features/lazy-tools.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/features/ai-polish/tool.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/features/ai-polish/ai-polish.css', import.meta.url), 'utf8'),
  readFile(new URL('../src/features/ai-translate/tool.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/features/ai-translate/ai-translate.css', import.meta.url), 'utf8'),
  readFile(new URL('../src/features/ai-text/ai-text-shared.css', import.meta.url), 'utf8')
]);

for (const id of [
  'aiPolishOverlay', 'aiPolishBack', 'aiPolishInput', 'aiPolishStartBtn', 'aiPolishDirectionList',
  'aiTranslateOverlay', 'aiTranslateBack', 'aiTranslateInput', 'aiTranslateStartBtn', 'aiTranslateLangList'
]) {
  assert.match(html, new RegExp(`id=["']${id}["']`), `missing AI text tool DOM contract: ${id}`);
}

assert.match(lazySpecs, /'ai-polish':[\s\S]*import\('\.\/ai-polish\/tool\.js'\)/);
assert.match(lazySpecs, /'ai-translate':[\s\S]*import\('\.\/ai-translate\/tool\.js'\)/);
assert.doesNotMatch(main, /aiPolishOverlay|openAiPolishOverlay|aiTranslateOverlay|openAiTranslateOverlay/);
assert.doesNotMatch(main, /AI_POLISH_LIMITS|AiPolishError|AI_TRANSLATE_LIMITS|AiTranslateError|TEXT_STATS_LIMITS/);
assert.match(main, /toolId === 'ai-polish' \|\| toolId === 'ai-translate'[\s\S]*await aiApiKeyReady[\s\S]*showAiKeyRequiredOverlay\(\)/);
assert.match(main, /requestAi:\s*callDeepSeek/);
assert.match(main, /extractJson,/);
assert.doesNotMatch(globalStyles, /\.ai-polish|\.ai-translate|#aiPolish|#aiTranslate/);
assert.match(globalStyles, /\.ai-doc-chat-msg\s*\{[\s\S]*?animation:\s*fadeInUp/);
assert.match(globalStyles, /@keyframes\s+fadeInUp\s*\{/,
  'AI Document must not depend on lazy AI text styles for its message animation');

for (const [name, source] of [['polish', polish], ['translate', translate]]) {
  assert.match(source, /createLifecycleScope/);
  assert.match(source, /bindTextDocumentDrop\(\{[\s\S]*lifecycle:\s*session/);
  assert.match(source, /session\?\.dispose\(\)/);
  assert.match(source, /lifecycle\.invalidate\(\)/);
  assert.match(source, /lifecycle\.isCurrent\(token\)/);
  assert.match(source, /requestController\?\.abort\(\)/);
  assert.match(source, /onLangChange\(\(\) =>/);
  assert.doesNotMatch(source, /onDragDropEvent/, `${name} must use the shared drop lifecycle`);
  assert.doesNotMatch(source, /\.innerHTML\s*=/, `${name} must build model content without HTML injection`);
}

assert.match(polish, /const REQUEST_TIMEOUT_MS = 90_000/);
assert.match(polish, /保持原文核心意思不变/);
assert.match(polish, /import '\.\/ai-polish\.css'/);
assert.match(translate, /const REQUEST_TIMEOUT_MS = 90_000/);
assert.match(translate, /逐句翻译，保持句子对应关系/);
assert.match(translate, /import '\.\/ai-translate\.css'/);
assert.doesNotMatch(translate, /aiTranslatePairsData/);
assert.match(sharedStyles, /\.ai-polish-overlay/);
assert.match(polishStyles, /\.ai-polish-v2/);
assert.match(translateStyles, /\.ai-translate-v2/);
assert.match(translateStyles, /\.ai-translate-sentence/);

console.log('AI text tools lazy-loading, gate, injection and lifecycle contracts passed');
