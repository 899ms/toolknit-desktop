import assert from 'node:assert/strict';
import { escapeAttr, escapeHtml } from '../src/shared/html.js';

assert.equal(escapeHtml('<script>alert("x")</script>'), '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;');
assert.equal(escapeHtml("a & b 'c'"), 'a &amp; b &#39;c&#39;');
assert.equal(escapeHtml(null), '');
assert.equal(escapeAttr('a"b<c'), 'a&quot;b&lt;c');

console.log('shared HTML escaping contract passed');
