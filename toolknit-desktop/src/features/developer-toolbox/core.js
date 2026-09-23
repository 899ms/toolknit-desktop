export const DEVELOPER_TOOL_MAX_TEXT = 2 * 1024 * 1024;

function assertText(value) {
  const text = String(value ?? '');
  if (text.length > DEVELOPER_TOOL_MAX_TEXT) throw new Error('developer-tool:input-too-large');
  return text;
}

export function formatJsonText(value, indent = '2') {
  const parsed = JSON.parse(assertText(value));
  return JSON.stringify(parsed, null, indent === 'tab' ? '\t' : Number(indent));
}

function jsonErrorLocation(message) {
  const lineColumn = message.match(/line\s+(\d+)\s+column\s+(\d+)/i);
  if (lineColumn) return `（第 ${lineColumn[1]} 行，第 ${lineColumn[2]} 列）`;
  const position = message.match(/position\s+(\d+)/i);
  return position ? `（位置 ${position[1]}）` : '';
}

export function describeDeveloperToolError(error, mode = '') {
  const message = String(error?.message || error || '');
  const knownMessages = {
    'developer-tool:input-too-large': '输入内容超过 2 MB 限制',
    'developer-tool:invalid-base64': 'Base64 格式无效，请检查字符和填充符',
    'developer-tool:invalid-utf8': '解码结果不是有效的 UTF-8 文本',
    'developer-tool:invalid-url': 'URL 编码格式无效，请检查百分号转义序列',
    'developer-tool:invalid-jwt': 'JWT 格式无效，应包含三个以句点分隔的部分'
  };
  if (knownMessages[message]) return knownMessages[message];
  if (mode === 'json-tools' || error instanceof SyntaxError) {
    let detail = '存在无效内容';
    if (/Unexpected non-whitespace character after JSON/i.test(message)) detail = 'JSON 结束后存在多余字符';
    else if (/Unexpected end of JSON|unterminated/i.test(message)) detail = '内容不完整或缺少结束符号';
    else if (/Expected property name/i.test(message)) detail = '对象属性名格式不正确';
    else if (/Expected ':' after property name/i.test(message)) detail = '对象属性名后缺少冒号';
    else if (/Unexpected token/i.test(message)) detail = '存在无法识别的字符';
    return `JSON 格式错误：${detail}${jsonErrorLocation(message)}`;
  }
  return '输入格式无效，请检查后重试';
}

function bytesToBase64(bytes) {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(binary);
}

function base64ToBytes(value) {
  const text = assertText(value).replace(/\s+/g, '');
  if (!text) return new Uint8Array();
  if (!/^[A-Za-z0-9+/_-]*={0,2}$/.test(text)) throw new Error('developer-tool:invalid-base64');
  const firstPadding = text.indexOf('=');
  const body = firstPadding < 0 ? text : text.slice(0, firstPadding);
  if (body.length % 4 === 1) throw new Error('developer-tool:invalid-base64');
  if (firstPadding === 0) throw new Error('developer-tool:invalid-base64');
  if (firstPadding >= 0) {
    const suppliedPadding = text.length - firstPadding;
    const requiredPadding = (4 - (body.length % 4)) % 4;
    if (requiredPadding === 0 || suppliedPadding > requiredPadding) throw new Error('developer-tool:invalid-base64');
  }
  const normalizedBody = body.replace(/-/g, '+').replace(/_/g, '/');
  const normalized = normalizedBody.padEnd(Math.ceil(normalizedBody.length / 4) * 4, '=');
  try { const binary = atob(normalized); return Uint8Array.from(binary, char => char.charCodeAt(0)); } catch { throw new Error('developer-tool:invalid-base64'); }
}

export function encodeBase64Utf8(value) { return bytesToBase64(new TextEncoder().encode(assertText(value))); }
export function decodeBase64Utf8(value) { const bytes = base64ToBytes(value); try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw new Error('developer-tool:invalid-utf8'); } }
export function encodeUrlComponent(value) { return encodeURIComponent(assertText(value)); }
export function decodeUrlComponent(value) { try { return decodeURIComponent(assertText(value)); } catch { throw new Error('developer-tool:invalid-url'); } }

export function generateUuidV4() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = new Uint8Array(16); crypto.getRandomValues(bytes); bytes[6] = (bytes[6] & 0x0f) | 0x40; bytes[8] = (bytes[8] & 0x3f) | 0x80;
  return [...bytes].map((byte, index) => `${byte.toString(16).padStart(2, '0')}${[3, 5, 7, 9].includes(index) ? '-' : ''}`).join('');
}

export function decodeJwt(value) {
  const parts = assertText(value).trim().split('.');
  if (parts.length !== 3) throw new Error('developer-tool:invalid-jwt');
  const decode = part => JSON.parse(decodeBase64Utf8(part));
  return { header: decode(parts[0]), payload: decode(parts[1]), signature: parts[2] };
}
