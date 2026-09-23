export const ICON_GEN_LIMITS = Object.freeze({
  maxInputBytes: 20 * 1024 * 1024,
  maxInputPixels: 20_000_000,
  maxOutputBytes: 32 * 1024 * 1024
});

const SUPPORTED_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp']);

export class IconGenerationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'IconGenerationError';
    this.code = code;
  }
}

export function isSupportedIconSource(fileName) {
  if (typeof fileName !== 'string') return false;
  const match = /\.([^.\\/]+)$/.exec(fileName.trim());
  return Boolean(match && SUPPORTED_EXTENSIONS.has(match[1].toLowerCase()));
}

export function assertIconSource(file, size = file?.size) {
  if (!file || !isSupportedIconSource(file.name)) {
    throw new IconGenerationError('unsupported_input', 'Only PNG, JPEG, and WebP images can be used for icon generation.');
  }
  const byteSize = Number(size);
  if (!Number.isSafeInteger(byteSize) || byteSize <= 0) {
    throw new IconGenerationError('invalid_input_size', 'The image file is empty or has an invalid size.');
  }
  if (byteSize > ICON_GEN_LIMITS.maxInputBytes) {
    throw new IconGenerationError('input_too_large', 'The image exceeds the supported file size limit.');
  }
}

export function assertIconSourceDimensions(width, height) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) {
    throw new IconGenerationError('invalid_dimensions', 'Image dimensions are invalid.');
  }
  if (width * height > ICON_GEN_LIMITS.maxInputPixels) {
    throw new IconGenerationError('too_many_pixels', 'Image dimensions exceed the supported pixel limit.');
  }
}

export function assertIconArchiveSize(size) {
  const byteSize = Number(size);
  if (!Number.isSafeInteger(byteSize) || byteSize <= 0 || byteSize > ICON_GEN_LIMITS.maxOutputBytes) {
    throw new IconGenerationError('archive_too_large', 'Generated icon archive exceeds the supported size limit.');
  }
}

export function encodeIco(pngs) {
  if (!Array.isArray(pngs) || pngs.length === 0) {
    throw new IconGenerationError('invalid_icon_set', 'At least one PNG icon is required.');
  }
  const normalized = pngs.map(icon => {
    const size = Number(icon?.size);
    const data = icon?.data instanceof Uint8Array ? icon.data : new Uint8Array(icon?.data || []);
    if (!Number.isSafeInteger(size) || size <= 0 || size > 256 || data.byteLength === 0) {
      throw new IconGenerationError('invalid_icon_set', 'ICO entries must contain valid PNG bytes and dimensions.');
    }
    return { size, data };
  });
  const headerSize = 6;
  const entrySize = 16;
  const dataStart = headerSize + entrySize * normalized.length;
  const totalSize = dataStart + normalized.reduce((sum, icon) => sum + icon.data.byteLength, 0);
  const buffer = new ArrayBuffer(totalSize);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  view.setUint16(0, 0, true);
  view.setUint16(2, 1, true);
  view.setUint16(4, normalized.length, true);
  let dataOffset = dataStart;
  normalized.forEach((icon, index) => {
    const entryOffset = headerSize + index * entrySize;
    const encodedSize = icon.size === 256 ? 0 : icon.size;
    view.setUint8(entryOffset, encodedSize);
    view.setUint8(entryOffset + 1, encodedSize);
    view.setUint8(entryOffset + 2, 0);
    view.setUint8(entryOffset + 3, 0);
    view.setUint16(entryOffset + 4, 1, true);
    view.setUint16(entryOffset + 6, 32, true);
    view.setUint32(entryOffset + 8, icon.data.byteLength, true);
    view.setUint32(entryOffset + 12, dataOffset, true);
    bytes.set(icon.data, dataOffset);
    dataOffset += icon.data.byteLength;
  });
  return bytes;
}

export function createEmbeddedIconSvg(base64Png) {
  const value = String(base64Png || '');
  if (!value || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw new IconGenerationError('invalid_svg_source', 'Embedded SVG image data is invalid.');
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024"><image href="data:image/png;base64,${value}" width="1024" height="1024"/></svg>`;
}
