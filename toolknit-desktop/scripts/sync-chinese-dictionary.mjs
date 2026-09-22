import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

// Maintainer-only, pinned data import. Never invoked by the application.
const version = 'ver.1.1.9';
const base = `https://raw.githubusercontent.com/BYVoid/OpenCC/${version}/`;
const directory = new URL('../src/core/opencc/', import.meta.url);
const entries = new Map();
const variants = new Map();
const sources = [];
async function readSource(name, remotePath) {
  if (process.env.TOOLKNIT_OPENCC_SOURCE) return readFile(path.join(process.env.TOOLKNIT_OPENCC_SOURCE, name), 'utf8');
  const response = await fetch(`${base}${remotePath}`, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Cannot fetch ${name}: ${response.status}`);
  return response.text();
}
for (const name of ['TSPhrases.txt', 'TSCharacters.txt', 'TWVariantsRevPhrases.txt', 'TWVariants.txt']) {
  const text = await readSource(name, `data/dictionary/${name}`);
  sources.push({ name, sha256: createHash('sha256').update(text).digest('hex') });
  for (const line of text.split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue;
    const [source, candidates] = line.split('\t');
    if (!source || !candidates) throw new Error(`Invalid dictionary entry in ${name}`);
    const target = candidates.split(' ')[0];
    if (name === 'TWVariants.txt') {
      if (target === '著' && !variants.has(target)) variants.set(target, source);
    } else if (name === 'TWVariantsRevPhrases.txt') {
      if (source.includes('著')) variants.set(source, target);
    }
    else if (!entries.has(source)) entries.set(source, target);
  }
}
if (entries.size < 4000) throw new Error('Incomplete OpenCC dictionary');
const sourceEntryCount = entries.size;
// Resolve chained single-character replacements; preserve phrase exceptions
// on later passes by admitting their already-simplified form as an identity.
for (const [source, original] of entries) {
  if ([...source].length !== 1) continue;
  let target = original;
  const visited = new Set([source]);
  while (!visited.has(target) && entries.has(target)) {
    visited.add(target);
    target = entries.get(target);
  }
  entries.set(source, target);
}
for (const target of [...entries.values()]) {
  if ([...target].length > 1 && !entries.has(target)) entries.set(target, target);
}
const ordered = [...entries].sort((a, b) => b[0].length - a[0].length);
function canonical(text) {
  let output = '';
  for (let offset = 0; offset < text.length;) {
    const match = ordered.find(([source]) => text.startsWith(source, offset));
    const source = match?.[0] || String.fromCodePoint(text.codePointAt(offset));
    output += match?.[1] || source;
    offset += source.length;
  }
  return output;
}
// Canonicalize variant phrase keys as well, so mixed/simplified text such as
// Xian-Zhu keeps the same exception as the traditional form. This makes the
// second pass idempotent when both native and UI normalize an ASR result.
const variantEntries = new Map([...variants].map(([source, target]) => [canonical(source), canonical(target)]));
const license = await readSource('LICENSE', 'LICENSE');
await mkdir(directory, { recursive: true });
await writeFile(new URL('t2s.json', directory), `${JSON.stringify({ version, sources, sourceEntryCount, entries: [...entries], variantEntries: [...variantEntries] })}\n`);
await writeFile(new URL('LICENSE.txt', directory), `${license.trimEnd()}\n`);
await writeFile(new URL('NOTICE.txt', directory), [
  'OpenCC Traditional Chinese to Simplified Chinese dictionaries.',
  'Copyright OpenCC authors and contributors. Licensed under Apache-2.0.',
  `Source: https://github.com/BYVoid/OpenCC/tree/${version}/data/dictionary`,
  'TSPhrases.txt and TSCharacters.txt; first replacement, chained character resolution and identity aliases for phrase outputs.',
  'TWVariantsRevPhrases.txt and reversed TWVariants.txt: only the U+8457 auxiliary and its phrase exceptions; keys/values canonicalized for mixed input.',
  'Generated t2s.json retains version and source SHA-256 values. See LICENSE.txt.', ''
].join('\n'));
console.log(`Imported pinned OpenCC dictionary: ${entries.size} entries`);
