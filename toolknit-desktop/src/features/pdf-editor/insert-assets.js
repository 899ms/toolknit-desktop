import { IMAGE_BATCH_LIMITS } from '../../image-batch-core.js';

/**
 * Reads dimensions from supported PNG/JPEG headers before decoding an image.
 * This lets callers reject oversized pixel payloads without allocating a
 * browser bitmap first.
 */
export function readEncodedImageDimensions(bytes, mimeType) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 10) return null;
  const type = String(mimeType || '').toLowerCase();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (type === 'image/png') {
    if (bytes.length < 24
      || view.getUint32(0) !== 0x89504e47
      || view.getUint32(4) !== 0x0d0a1a0a
      || view.getUint32(12) !== 0x49484452) return null;
    return { width: view.getUint32(16), height: view.getUint32(20) };
  }
  if (type !== 'image/jpeg' && type !== 'image/jpg') return null;
  if (view.getUint16(0) !== 0xffd8) return null;
  const frameMarkers = new Set([
    0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7,
    0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf
  ]);
  let offset = 2;
  while (offset + 3 < view.byteLength) {
    while (offset < view.byteLength && view.getUint8(offset) !== 0xff) offset += 1;
    while (offset < view.byteLength && view.getUint8(offset) === 0xff) offset += 1;
    if (offset >= view.byteLength) break;
    const marker = view.getUint8(offset++);
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) continue;
    if (offset + 1 >= view.byteLength) break;
    const segmentLength = view.getUint16(offset);
    if (segmentLength < 2 || offset + segmentLength > view.byteLength) break;
    if (frameMarkers.has(marker)) {
      if (segmentLength < 7 || offset + 6 >= view.byteLength) return null;
      return {
        height: view.getUint16(offset + 3),
        width: view.getUint16(offset + 5)
      };
    }
    offset += segmentLength;
  }
  return null;
}

export function assertImagePixelLimit(dimensions, limits = IMAGE_BATCH_LIMITS) {
  const width = Number(dimensions?.width);
  const height = Number(dimensions?.height);
  const pixelCount = width * height;
  if (!Number.isSafeInteger(width)
    || !Number.isSafeInteger(height)
    || width < 1
    || height < 1
    || !Number.isSafeInteger(pixelCount)
    || pixelCount > limits.maxPixelsPerFile) {
    throw new Error(`图像分辨率超过 ${limits.maxPixelsPerFile.toLocaleString()} 像素限制`);
  }
  return { width, height };
}

export async function readImageDimensions(bytes, mimeType, {
  urlRef = globalThis.URL,
  blobConstructor = globalThis.Blob,
  imageConstructor = globalThis.Image
} = {}) {
  if (!urlRef?.createObjectURL || !blobConstructor || !imageConstructor) {
    throw new Error('image decode APIs are unavailable');
  }
  const url = urlRef.createObjectURL(new blobConstructor([bytes], { type: mimeType || 'image/png' }));
  try {
    const dimensions = await new Promise((resolve, reject) => {
      const image = new imageConstructor();
      image.onload = () => resolve({ width: image.naturalWidth || image.width, height: image.naturalHeight || image.height });
      image.onerror = () => reject(new Error('image decode failed'));
      image.src = url;
    });
    return dimensions;
  } finally {
    urlRef.revokeObjectURL?.(url);
  }
}
