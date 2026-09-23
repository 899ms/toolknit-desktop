import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseFontMetadata } from '../src/font-metadata.js';

const fontBytes = await readFile(new URL('../public/assets/fonts/Montserrat-Regular.otf', import.meta.url));

const parsed = await parseFontMetadata(fontBytes);
assert.equal(parsed.familyName, 'Montserrat');
assert.equal(parsed.fullName, 'Montserrat Regular');
assert.equal(parsed.displayName, 'Montserrat Regular');

const boldBytes = await readFile(new URL('../public/assets/fonts/Montserrat-Bold.otf', import.meta.url));
const parsedBold = await parseFontMetadata(boldBytes);
assert.equal(parsedBold.familyName, 'Montserrat');
assert.equal(parsedBold.fullName, 'Montserrat Bold');
assert.equal(parsedBold.displayName, 'Montserrat Bold');

// A view with a non-zero offset must only expose the font bytes, not its
// surrounding sentinel bytes.
const padded = new Uint8Array(fontBytes.length + 10);
padded.fill(0xa5, 0, 5);
padded.set(fontBytes, 5);
padded.fill(0x5a, fontBytes.length + 5);
const offsetParsed = await parseFontMetadata(padded.subarray(5, fontBytes.length + 5));
assert.deepEqual(offsetParsed, parsed);

for (const invalid of [null, undefined, new Uint8Array(), new Uint8Array([0, 1, 2, 3]), 'font']) {
  const fallback = await parseFontMetadata(invalid);
  assert.deepEqual(fallback, { familyName: '', fullName: '', displayName: '' });
}

console.log('Font metadata parsing checks passed');
