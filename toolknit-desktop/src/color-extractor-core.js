export const COLOR_EXTRACTOR_LIMITS = Object.freeze({
  maxBytes: 100 * 1024 * 1024,
  maxPixels: 160_000_000
});

const SUPPORTED_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);

export function isSupportedColorExtractorFile(file) {
  if (!file) return false;
  const type = typeof file.type === 'string' ? file.type.toLowerCase() : '';
  if (SUPPORTED_TYPES.has(type)) return true;
  const name = typeof file.name === 'string' ? file.name.toLowerCase() : '';
  return /\.(png|jpe?g|webp)$/.test(name);
}

export function assertColorExtractorFile(file, size = file?.size) {
  if (!isSupportedColorExtractorFile(file)) throw new TypeError('Only PNG, JPEG, and WebP images are supported.');
  if (size === undefined || size === null) return;
  if (!Number.isSafeInteger(Number(size)) || Number(size) < 0 || Number(size) > COLOR_EXTRACTOR_LIMITS.maxBytes) {
    throw new RangeError('Image file exceeds the supported size limit.');
  }
}

export function assertColorExtractorDimensions(width, height) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) {
    throw new RangeError('Image dimensions are invalid.');
  }
  if (width * height > COLOR_EXTRACTOR_LIMITS.maxPixels) {
    throw new RangeError('Image dimensions exceed the supported pixel limit.');
  }
}

function readUint24LE(bytes, offset) {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
}

function readJpegDimensions(bytes) {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;

  let offset = 2;
  while (offset + 3 < bytes.length) {
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length) break;
    const marker = bytes[offset++];
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker >= 0xd0 && marker <= 0xd7) continue;
    if (offset + 1 >= bytes.length) break;
    const segmentLength = (bytes[offset] << 8) | bytes[offset + 1];
    if (segmentLength < 2 || offset + segmentLength > bytes.length) break;
    const isSof = (marker >= 0xc0 && marker <= 0xc3)
      || (marker >= 0xc5 && marker <= 0xc7)
      || (marker >= 0xc9 && marker <= 0xcb)
      || (marker >= 0xcd && marker <= 0xcf);
    if (isSof && segmentLength >= 7) {
      return {
        width: (bytes[offset + 5] << 8) | bytes[offset + 6],
        height: (bytes[offset + 3] << 8) | bytes[offset + 4]
      };
    }
    offset += segmentLength;
  }
  return null;
}

function readWebpDimensions(bytes) {
  if (bytes.length < 30
    || String.fromCharCode(...bytes.subarray(0, 4)) !== 'RIFF'
    || String.fromCharCode(...bytes.subarray(8, 12)) !== 'WEBP') return null;

  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const chunkType = String.fromCharCode(...bytes.subarray(offset, offset + 4));
    const chunkLength = bytes[offset + 4]
      | (bytes[offset + 5] << 8)
      | (bytes[offset + 6] << 16)
      | (bytes[offset + 7] << 24);
    const dataOffset = offset + 8;
    if (chunkLength < 0 || dataOffset + chunkLength > bytes.length) return null;

    if (chunkType === 'VP8X' && chunkLength >= 10) {
      return {
        width: readUint24LE(bytes, dataOffset + 4) + 1,
        height: readUint24LE(bytes, dataOffset + 7) + 1
      };
    }
    if (chunkType === 'VP8 ' && chunkLength >= 10
      && bytes[dataOffset + 3] === 0x9d
      && bytes[dataOffset + 4] === 0x01
      && bytes[dataOffset + 5] === 0x2a) {
      return {
        width: ((bytes[dataOffset + 7] & 0x3f) << 8) | bytes[dataOffset + 6],
        height: ((bytes[dataOffset + 9] & 0x3f) << 8) | bytes[dataOffset + 8]
      };
    }
    if (chunkType === 'VP8L' && chunkLength >= 5 && bytes[dataOffset] === 0x2f) {
      return {
        width: 1 + (((bytes[dataOffset + 2] & 0x3f) << 8) | bytes[dataOffset + 1]),
        height: 1 + (((bytes[dataOffset + 4] & 0x0f) << 10)
          | (bytes[dataOffset + 3] << 2)
          | ((bytes[dataOffset + 2] & 0xc0) >> 6))
      };
    }
    offset = dataOffset + chunkLength + (chunkLength % 2);
  }
  return null;
}

export function readColorExtractorImageDimensions(data) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (bytes.length >= 24
    && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
    && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
    && String.fromCharCode(...bytes.subarray(12, 16)) === 'IHDR') {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return { width: view.getUint32(16), height: view.getUint32(20) };
  }
  return readJpegDimensions(bytes) || readWebpDimensions(bytes);
}

export function assertColorExtractorImageBytes(data) {
  const dimensions = readColorExtractorImageDimensions(data);
  if (!dimensions) throw new TypeError('Image data is unsupported or malformed.');
  assertColorExtractorDimensions(dimensions.width, dimensions.height);
  return dimensions;
}

export function rgbToHex(r, g, b) {
  const toHex = (value) => Math.max(0, Math.min(255, Math.round(value)))
    .toString(16)
    .padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`.toUpperCase();
}

export function rgbToHsl(r, g, b) {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const lightness = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l: Math.round(lightness * 100) };
  const delta = max - min;
  const saturation = lightness > 0.5 ? delta / (2 - max - min) : delta / (max + min);
  let hue;
  if (max === rn) hue = ((gn - bn) / delta + (gn < bn ? 6 : 0)) / 6;
  else if (max === gn) hue = ((bn - rn) / delta + 2) / 6;
  else hue = ((rn - gn) / delta + 4) / 6;
  return {
    h: Math.round(hue * 360),
    s: Math.round(saturation * 100),
    l: Math.round(lightness * 100)
  };
}

export function colorFromRgb(r, g, b) {
  const rgb = { r: Math.round(r), g: Math.round(g), b: Math.round(b) };
  const hsl = rgbToHsl(rgb.r, rgb.g, rgb.b);
  return { hex: rgbToHex(rgb.r, rgb.g, rgb.b), rgb, hsl };
}

function colorDistance(left, right) {
  const dr = left[0] - right[0];
  const dg = left[1] - right[1];
  const db = left[2] - right[2];
  const rMean = (left[0] + right[0]) / 2;
  return Math.sqrt(
    ((2 + rMean / 256) * dr * dr)
    + (4 * dg * dg)
    + ((2 + (255 - rMean) / 256) * db * db)
  );
}

function clusterPixels(pixels, colorCount) {
  const centroids = [];
  const step = Math.max(1, Math.floor(pixels.length / colorCount));
  for (let index = 0; index < colorCount; index++) {
    const pixel = pixels[Math.min(index * step, pixels.length - 1)];
    if (pixel) centroids.push([...pixel]);
  }
  while (centroids.length < colorCount) centroids.push([...pixels[0]]);

  for (let iteration = 0; iteration < 12; iteration++) {
    const sums = centroids.map(() => [0, 0, 0, 0]);
    for (const pixel of pixels) {
      let best = 0;
      let bestDistance = Infinity;
      for (let index = 0; index < centroids.length; index++) {
        const centroid = centroids[index];
        const distance = (pixel[0] - centroid[0]) ** 2
          + (pixel[1] - centroid[1]) ** 2
          + (pixel[2] - centroid[2]) ** 2;
        if (distance < bestDistance) {
          bestDistance = distance;
          best = index;
        }
      }
      sums[best][0] += pixel[0];
      sums[best][1] += pixel[1];
      sums[best][2] += pixel[2];
      sums[best][3] += 1;
    }

    let changed = false;
    for (let index = 0; index < centroids.length; index++) {
      if (!sums[index][3]) continue;
      const next = sums[index].slice(0, 3).map(value => value / sums[index][3]);
      if (next.some((value, channel) => Math.abs(value - centroids[index][channel]) > 1)) {
        changed = true;
      }
      centroids[index] = next;
    }
    if (!changed) break;
  }

  const counts = centroids.map(() => 0);
  for (const pixel of pixels) {
    let best = 0;
    let bestDistance = Infinity;
    for (let index = 0; index < centroids.length; index++) {
      const centroid = centroids[index];
      const distance = (pixel[0] - centroid[0]) ** 2
        + (pixel[1] - centroid[1]) ** 2
        + (pixel[2] - centroid[2]) ** 2;
      if (distance < bestDistance) {
        bestDistance = distance;
        best = index;
      }
    }
    counts[best] += 1;
  }

  return { centroids, counts };
}

export function paletteFromRgba(data, count = 5) {
  const pixels = [];
  for (let offset = 0; offset + 3 < data.length; offset += 4) {
    if (data[offset + 3] >= 128) {
      pixels.push([data[offset], data[offset + 1], data[offset + 2]]);
    }
  }
  if (!pixels.length) return [];

  const requested = Math.max(2, Math.min(9, Math.round(Number(count) || 5)));
  const clusterCount = Math.min(12, requested + 2);
  const { centroids, counts } = clusterPixels(pixels, clusterCount);

  const clusters = centroids.map((centroid, index) => {
    const rgb = centroid.map(value => Math.max(0, Math.min(255, Math.round(value))));
    const max = Math.max(rgb[0], rgb[1], rgb[2]);
    const min = Math.min(rgb[0], rgb[1], rgb[2]);
    const saturation = max === 0 ? 0 : (max - min) / max;
    return { rgb, count: counts[index], saturation };
  });

  const merged = [];
  for (const cluster of clusters) {
    const existing = merged.find(item => colorDistance(item.rgb, cluster.rgb) < 24);
    if (existing) {
      existing.count += cluster.count;
      existing.saturation = Math.max(existing.saturation, cluster.saturation);
      continue;
    }
    merged.push({ ...cluster });
  }

  const total = pixels.length;
  const dominant = merged.reduce((a, b) => (b.count > a.count ? b : a), merged[0]);
  const hasVividAlternative = merged.some(item => item !== dominant && item.saturation >= 0.28);
  const suppressBackground = dominant
    && (dominant.count / total) >= 0.34
    && dominant.saturation < 0.18
    && hasVividAlternative;

  const scored = merged.map(item => {
    let score = item.count * (0.55 + item.saturation * 0.9);
    if (suppressBackground && item === dominant) score *= 0.12;
    return { ...item, score };
  });
  scored.sort((a, b) => b.score - a.score);

  return scored.slice(0, requested).map(item => {
    const color = colorFromRgb(item.rgb[0], item.rgb[1], item.rgb[2]);
    return {
      ...color,
      pixels: item.count,
      percentage: Number((item.count / total * 100).toFixed(2))
    };
  });
}
