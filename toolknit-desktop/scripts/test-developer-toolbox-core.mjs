import assert from 'node:assert/strict';
import { decodeBase64Utf8, decodeJwt, decodeUrlComponent, describeDeveloperToolError, encodeBase64Utf8, encodeUrlComponent, formatJsonText, generateUuidV4 } from '../src/features/developer-toolbox/core.js';

assert.equal(formatJsonText('{"b":2,"a":[true]}', '2'), '{\n  "b": 2,\n  "a": [\n    true\n  ]\n}');
assert.equal(formatJsonText('{"b":2,"a":[true]}', '0'), '{"b":2,"a":[true]}');
assert.equal(decodeBase64Utf8(encodeBase64Utf8('ToolKnit 中文')), 'ToolKnit 中文');
assert.equal(decodeBase64Utf8(''), '');
assert.equal(decodeBase64Utf8('YQ'), 'a');
assert.equal(decodeBase64Utf8('YQ='), 'a');
assert.equal(decodeUrlComponent(encodeUrlComponent('a & b/中文')), 'a & b/中文');
assert.match(generateUuidV4(), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
const jwt = decodeJwt('eyJhbGciOiJub25lIn0.eyJzdWIiOiJ0b29sa25pdCJ9.signature');
assert.deepEqual(jwt.header, { alg: 'none' });
assert.deepEqual(jwt.payload, { sub: 'toolknit' });
assert.throws(() => decodeJwt('invalid'), /invalid-jwt/);
assert.throws(() => decodeBase64Utf8('@@@'), /invalid-base64/);
assert.throws(() => decodeBase64Utf8('A'), /invalid-base64/);
assert.throws(() => decodeBase64Utf8('YQ==='), /invalid-base64/);
assert.throws(() => decodeBase64Utf8('='), /invalid-base64/);
assert.throws(() => decodeBase64Utf8('YWI=='), /invalid-base64/);
assert.throws(() => decodeBase64Utf8('YWJj='), /invalid-base64/);
assert.equal(describeDeveloperToolError(new Error('developer-tool:invalid-base64'), 'base64'), 'Base64 格式无效，请检查字符和填充符');
assert.equal(
  describeDeveloperToolError(new SyntaxError('Unexpected non-whitespace character after JSON at position 5 (line 1 column 6)'), 'json-tools'),
  'JSON 格式错误：JSON 结束后存在多余字符（第 1 行，第 6 列）'
);
console.log('developer toolbox core tests passed');
