import assert from 'node:assert/strict';
import { simplifyChineseText, simplifyTranscriptionJson } from '../src/core/chinese-text.js';
import dictionary from '../src/core/opencc/t2s.json' with { type: 'json' };

assert.equal(dictionary.version, 'ver.1.1.9');
assert.equal(dictionary.sourceEntryCount, 4391);
const pairs = [
  ['生活處處藏著溫柔與美好，平凡的日常裡，總有細碎的溫暖治癒人心', '生活处处藏着温柔与美好，平凡的日常里，总有细碎的温暖治愈人心'],
  ['(無法接受) (視頻) 終於釋懼了溫暖', '(无法接受) (视频) 终于释惧了温暖'],
  ['乾坤 乾燥 乾隆 頭髮 發現 著作', '乾坤 干燥 乾隆 头发 发现 著作'],
  ['藏著 顯著 显著 著作 著名', '藏着 显著 显著 著作 著名'],
  ['什么 怎么 幺 乾图 毕昇 於潜', '什么 怎么 幺 乾图 毕昇 於潜'],
  ['English ASR 123\n00:00:01,000 --> 00:00:02,000', 'English ASR 123\n00:00:01,000 --> 00:00:02,000'],
  ['ToolKnit 語音視訊與 English 𠀀', 'ToolKnit 语音视讯与 English 𠀀']
];
for (const [input, expected] of pairs) {
  assert.equal(simplifyChineseText(input), expected);
  assert.equal(simplifyChineseText(expected), expected, 'conversion must be idempotent');
}
for (const [source] of [...dictionary.entries, ...dictionary.variantEntries]) {
  const once = simplifyChineseText(source);
  assert.equal(simplifyChineseText(once), once, `dictionary output must survive native + UI normalization: ${source}`);
}
const original = { file: '聲音.wav', language: 'zh', transcription: [{ text: '\u7d42\u65bc\u6eab\u6696', offsets: { from: 123 }, tokens: [{ text: '視頻', id: 42 }] }] };
const converted = simplifyTranscriptionJson(original);
assert.equal(converted.transcription[0].text, '终于温暖');
assert.equal(converted.transcription[0].tokens[0].text, '视频');
assert.equal(converted.transcription[0].offsets.from, 123);
assert.equal(converted.transcription[0].tokens[0].id, 42);
assert.equal(converted.file, '聲音.wav', 'engine metadata and filenames must not be rewritten');
assert.equal(original.transcription[0].text, '終於溫暖', 'input objects remain unchanged');
console.log('Shared Chinese text: phrase exceptions, reported variants, English, Unicode and structured JSON passed');
