import dictionary from './opencc/t2s.json' with { type: 'json' };

// OpenCC t2s: longest phrase first, then the default character replacement.
// Phrase/output aliases preserve legitimate characters on repeated passes.
// A second pass handles the Taiwan auxiliary variant and its word exceptions.
let stages;
function conversionGroups(entries) {
  const groups = new Map();
  for (const [source, target] of entries) {
    const first = source.codePointAt(0);
    if (!groups.has(first)) groups.set(first, []);
    groups.get(first).push([source, target]);
  }
  for (const group of groups.values()) group.sort((a, b) => b[0].length - a[0].length);
  return groups;
}

function convert(text, map) {
  const result = [];
  for (let offset = 0; offset < text.length;) {
    const point = text.codePointAt(offset);
    const match = map.get(point)?.find(([source]) => text.startsWith(source, offset));
    if (match) {
      result.push(match[1]);
      offset += match[0].length;
    } else {
      const character = String.fromCodePoint(point);
      result.push(character);
      offset += character.length;
    }
  }
  return result.join('');
}

export function simplifyChineseText(value) {
  stages ||= [conversionGroups(dictionary.entries), conversionGroups(dictionary.variantEntries)];
  return stages.reduce(convert, String(value || ''));
}

// Normalize transcript text fields only: never rewrite JSON keys, file paths,
// token timings, language codes or other engine metadata.
export function simplifyTranscriptionJson(value) {
  if (Array.isArray(value)) return value.map(simplifyTranscriptionJson);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
    key === 'text' && typeof item === 'string' ? simplifyChineseText(item) : simplifyTranscriptionJson(item)
  ]));
}
