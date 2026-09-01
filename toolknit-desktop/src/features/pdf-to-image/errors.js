import { PdfToImageError } from '../../pdf-to-image-core.js';

export class PdfToImageCancelledError extends Error {
  constructor() {
    super('PDF to image operation cancelled');
    this.name = 'PdfToImageCancelledError';
  }
}

export function asUint8Array(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (Array.isArray(value)) return Uint8Array.from(value);
  if (value && typeof value.length === 'number') return Uint8Array.from(value);
  throw new Error('Invalid binary response');
}

export function errorCode(error) {
  if (error instanceof PdfToImageError) return error.code;
  const text = String(error?.message || error || '');
  const match = text.match(/pdf-to-image:([a-z0-9-]+)/i);
  return match ? match[1].replaceAll('-', '_') : '';
}

export function isPasswordError(error) {
  return error?.name === 'PasswordException'
    || /password|encrypted/i.test(String(error?.message || error || ''));
}
