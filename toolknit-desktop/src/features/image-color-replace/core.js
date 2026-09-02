export const COLOR_REPLACE_LIMITS = Object.freeze({
  maxBytes: 20 * 1024 * 1024,
  maxPixels: 40_000_000,
  previewMaxEdge: 960
});

const LINEAR_RGB = Float32Array.from({ length: 256 }, (_, value) => {
  const normalized = value / 255;
  return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
});

export function hexToRgb(value) {
  const match = /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(String(value || '').trim());
  if (!match) throw new Error('color-replace:invalid-color');
  return match.slice(1).map(part => Number.parseInt(part, 16));
}

export function rgbToHex(rgb) {
  return `#${rgb.slice(0, 3).map(value => Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, '0')).join('')}`.toUpperCase();
}

function srgbToLinear(value) {
  const index = Math.max(0, Math.min(255, Math.round(Number(value) || 0)));
  return LINEAR_RGB[index];
}

export function rgbToLab(rgb) {
  const [r, g, b] = rgb.map(srgbToLinear);
  const x = (r * 0.4124564 + g * 0.3575761 + b * 0.1804375) / 0.95047;
  const y = (r * 0.2126729 + g * 0.7151522 + b * 0.0721750);
  const z = (r * 0.0193339 + g * 0.1191920 + b * 0.9503041) / 1.08883;
  const f = value => value > 0.008856 ? Math.cbrt(value) : (7.787 * value) + (16 / 116);
  const fx = f(x); const fy = f(y); const fz = f(z);
  return [(116 * fy) - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

// Hot path for previews: avoid allocating an RGB array and several temporary
// Lab arrays for every source pixel.
function deltaE76FromRgb(r, g, b, sourceLab) {
  const linearR = LINEAR_RGB[r];
  const linearG = LINEAR_RGB[g];
  const linearB = LINEAR_RGB[b];
  const x = (linearR * 0.4124564 + linearG * 0.3575761 + linearB * 0.1804375) / 0.95047;
  const y = (linearR * 0.2126729 + linearG * 0.7151522 + linearB * 0.0721750);
  const z = (linearR * 0.0193339 + linearG * 0.1191920 + linearB * 0.9503041) / 1.08883;
  const f = value => value > 0.008856 ? Math.cbrt(value) : (7.787 * value) + (16 / 116);
  const fx = f(x); const fy = f(y); const fz = f(z);
  const lightness = (116 * fy) - 16 - sourceLab[0];
  const redGreen = (500 * (fx - fy)) - sourceLab[1];
  const yellowBlue = (200 * (fy - fz)) - sourceLab[2];
  return Math.hypot(lightness, redGreen, yellowBlue);
}

export function deltaE76(first, second) {
  const a = Array.isArray(first) && first.length === 3 ? first : rgbToLab(first);
  const b = Array.isArray(second) && second.length === 3 ? second : rgbToLab(second);
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

export function normalizeColorReplaceOptions(options, width, height) {
  const finiteOr = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback;
  const normalizeRgb = (value, fallback) => Array.isArray(value) && value.length >= 3
    ? value.slice(0, 3).map(channel => Math.max(0, Math.min(255, Math.round(finiteOr(channel, 0)))))
    : fallback;
  const threshold = Math.max(0.5, Math.min(100, finiteOr(options?.threshold, 20)));
  const softness = Math.max(0, Math.min(100, finiteOr(options?.softness, 24)));
  const source = normalizeRgb(options?.source, [255, 255, 255]);
  const target = normalizeRgb(options?.target, [45, 122, 210]);
  const seedX = Math.max(0, Math.min(Math.max(0, width - 1), Math.round(Number(options?.seedX) || 0)));
  const seedY = Math.max(0, Math.min(Math.max(0, height - 1), Math.round(Number(options?.seedY) || 0)));
  return { threshold, softness, source, target, seedX, seedY, smart: options?.smart !== false, preserveLuminance: options?.preserveLuminance !== false };
}

function colorWeight(distance, threshold, softness) {
  if (distance > threshold) return 0;
  if (softness <= 0) return 1;
  const feather = Math.max(0.25, threshold * (softness / 100));
  const edgeStart = Math.max(0, threshold - feather);
  if (distance <= edgeStart) return 1;
  const t = (threshold - distance) / Math.max(0.0001, feather);
  return t * t * (3 - (2 * t));
}

export function replaceImageColors(rgba, width, height, rawOptions = {}) {
  if (!(rgba instanceof Uint8ClampedArray) || rgba.length !== width * height * 4) throw new Error('color-replace:invalid-buffer');
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) throw new Error('color-replace:invalid-dimensions');
  const options = normalizeColorReplaceOptions(rawOptions, width, height);
  const sourceLab = rgbToLab(options.source);
  const sourceLuminance = (options.source[0] * 0.2126) + (options.source[1] * 0.7152) + (options.source[2] * 0.0722);
  const targetRed = options.target[0];
  const targetGreen = options.target[1];
  const targetBlue = options.target[2];
  const pixelCount = width * height;
  const candidates = new Uint8Array(pixelCount);
  const weights = new Float32Array(pixelCount);
  for (let index = 0; index < pixelCount; index += 1) {
    const offset = index * 4;
    if (rgba[offset + 3] === 0) continue;
    const distance = deltaE76FromRgb(rgba[offset], rgba[offset + 1], rgba[offset + 2], sourceLab);
    const weight = colorWeight(distance, options.threshold, options.softness);
    if (weight > 0) { candidates[index] = 1; weights[index] = weight; }
  }

  let selected = candidates;
  if (options.smart) {
    selected = new Uint8Array(pixelCount);
    const seed = options.seedY * width + options.seedX;
    if (candidates[seed]) {
      const queue = new Uint32Array(pixelCount);
      let head = 0; let tail = 0;
      queue[tail++] = seed; selected[seed] = 1;
      while (head < tail) {
        const current = queue[head++];
        const x = current % width; const y = Math.floor(current / width);
        for (let dy = -1; dy <= 1; dy += 1) for (let dx = -1; dx <= 1; dx += 1) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx; const ny = y + dy;
          if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
          const next = ny * width + nx;
          if (!selected[next] && candidates[next]) { selected[next] = 1; queue[tail++] = next; }
        }
      }
    }
  }

  const output = new Uint8ClampedArray(rgba);
  let changedPixels = 0;
  for (let index = 0; index < selected.length; index += 1) {
    if (!selected[index]) continue;
    const offset = index * 4;
    const red = rgba[offset];
    const green = rgba[offset + 1];
    const blue = rgba[offset + 2];
    const delta = options.preserveLuminance
      ? ((red * 0.2126) + (green * 0.7152) + (blue * 0.0722)) - sourceLuminance
      : 0;
    const targetRedForPixel = Math.max(0, Math.min(255, targetRed + delta));
    const targetGreenForPixel = Math.max(0, Math.min(255, targetGreen + delta));
    const targetBlueForPixel = Math.max(0, Math.min(255, targetBlue + delta));
    const weight = weights[index];
    output[offset] = Math.round(red + ((targetRedForPixel - red) * weight));
    output[offset + 1] = Math.round(green + ((targetGreenForPixel - green) * weight));
    output[offset + 2] = Math.round(blue + ((targetBlueForPixel - blue) * weight));
    changedPixels += 1;
  }
  return { data: output, changedPixels, options };
}

export function sampleRgbaPixel(rgba, width, height, x, y) {
  const px = Math.max(0, Math.min(width - 1, Math.floor(x)));
  const py = Math.max(0, Math.min(height - 1, Math.floor(y)));
  const offset = (py * width + px) * 4;
  return [rgba[offset], rgba[offset + 1], rgba[offset + 2], rgba[offset + 3]];
}
