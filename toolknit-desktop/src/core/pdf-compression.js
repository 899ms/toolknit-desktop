const MIB = 1024 * 1024;

export const PDF_COMPRESSION_POLICY = Object.freeze({
  minTargetBytes: 50 * 1024,
  maxTargetBytes: 50 * MIB,
  maxPagePixels: 4_000_000,
  maxPageEdge: 8192,
  maxCacheBytes: 1024 * MIB,
  maxMemoryCacheBytes: 128 * MIB,
  maxCandidateBytes: 200 * MIB,
  maxAttempts: 6,
  timeoutMs: 15 * 60 * 1000,
  sourceQuality: 0.98,
  maxScale: 2,
  maxQuality: 0.94,
  goodFitRatio: 0.94
});

const PRESETS = Object.freeze({
  low: Object.freeze({ scale: 2, quality: 0.86, flateLevel: 6 }),
  medium: Object.freeze({ scale: 1.5, quality: 0.66, flateLevel: 8 }),
  high: Object.freeze({ scale: 1, quality: 0.45, flateLevel: 9 })
});
const CLARITY = Object.freeze({
  readable: Object.freeze({ minScale: 1, minQuality: 0.4 }),
  compact: Object.freeze({ minScale: 0.35, minQuality: 0.25 })
});

export function pdfCompressionError(code) {
  return new Error(`pdf-compress:${code}`);
}

export function normalizePdfCompressionOptions({ mode = 'structure', level = 'medium', clarity = 'readable', targetBytes = null } = {}) {
  if (!['structure', 'raster'].includes(mode)) throw pdfCompressionError('invalid-mode');
  if (!Object.hasOwn(PRESETS, level)) throw pdfCompressionError('invalid-level');
  if (!Object.hasOwn(CLARITY, clarity)) throw pdfCompressionError('invalid-clarity');
  if (targetBytes != null && (!Number.isSafeInteger(targetBytes)
    || targetBytes < PDF_COMPRESSION_POLICY.minTargetBytes || targetBytes > PDF_COMPRESSION_POLICY.maxTargetBytes)) {
    throw pdfCompressionError('invalid-target-size');
  }
  return { mode, level, clarity, targetBytes, ...PRESETS[level], ...CLARITY[clarity] };
}

export function createPdfCompressionPagePlan(width, height, options) {
  if (![width, height].every(value => Number.isFinite(value) && value > 0)) throw pdfCompressionError('invalid-pdf');
  const scale = Math.min(PDF_COMPRESSION_POLICY.maxScale,
    Math.sqrt(PDF_COMPRESSION_POLICY.maxPagePixels / (width * height)),
    PDF_COMPRESSION_POLICY.maxPageEdge / Math.max(width, height));
  if (scale < options.minScale) throw pdfCompressionError('page-too-large');
  // Flooring the dimensions keeps the pixel/edge budgets true after rounding.
  return { width, height, sourceScale: scale,
    pixelWidth: Math.max(1, Math.floor(width * scale)), pixelHeight: Math.max(1, Math.floor(height * scale)) };
}

export function pdfCompressionStatus({ originalSize, compressedSize, targetBytes = null, outputPath = '' }) {
  if (targetBytes != null && originalSize <= targetBytes) return 'already-within-target';
  if (targetBytes != null && compressedSize > targetBytes) return 'target-not-reached';
  return outputPath || compressedSize < originalSize ? 'compressed' : 'no-reduction';
}

export function structureCompressionArguments(level) {
  const options = normalizePdfCompressionOptions({ level });
  return ['--warning-exit-0', '--object-streams=generate', '--compress-streams=y', '--recompress-flate', `--compression-level=${options.flateLevel}`];
}

const round = value => Number(value.toFixed(4));
const settingsKey = settings => `${settings.scale}:${settings.quality}`;

function shrinkSettings(settings, size, targetBytes, options) {
  const ratio = Math.max(0.005, Math.min(0.99, targetBytes / size));
  return {
    scale: round(Math.max(options.minScale, Math.min(settings.scale * 0.985, settings.scale * ratio ** 0.32 * 0.985))),
    quality: round(Math.max(options.minQuality, Math.min(settings.quality - 0.02, settings.quality * ratio ** 0.16 * 0.992)))
  };
}

function refineSettings(above, below, targetBytes) {
  if (!above || !below || above.size <= below.size) return null;
  const span = Math.log(above.size) - Math.log(below.size);
  const weight = Math.max(0.12, Math.min(0.88, (Math.log(targetBytes) - Math.log(below.size)) / span));
  const settings = {};
  for (const key of ['scale', 'quality']) {
    settings[key] = round(Math.exp(Math.log(below.settings[key])
      + (Math.log(above.settings[key]) - Math.log(below.settings[key])) * weight));
  }
  return settingsKey(settings) === settingsKey(above.settings) || settingsKey(settings) === settingsKey(below.settings)
    ? null : settings;
}

/** All sizes must come from complete serialized PDFs, never image-size estimates.
 * The builder owns platform rendering; release() disposes superseded payloads. */
export async function findPdfCompressionTarget({ targetBytes, buildCandidate, release = async () => {}, check = () => {}, onAttempt = () => {}, clarity = 'readable' }) {
  const options = normalizePdfCompressionOptions({ mode: 'raster', targetBytes, clarity });
  if (targetBytes == null || typeof buildCandidate !== 'function') throw pdfCompressionError('invalid-target-size');
  const minimum = { scale: options.minScale, quality: options.minQuality };
  let settings = { scale: PDF_COMPRESSION_POLICY.maxScale, quality: PDF_COMPRESSION_POLICY.maxQuality };
  let best = null;
  let above = null;
  let pending = null;
  let smallestSize = Infinity;
  const attempts = [];
  const tested = new Set();
  try {
    for (let attempt = 1; attempt <= PDF_COMPRESSION_POLICY.maxAttempts; attempt++) {
      check();
      if (attempt === PDF_COMPRESSION_POLICY.maxAttempts && !best) settings = minimum;
      if (tested.has(settingsKey(settings))) {
        if (best || tested.has(settingsKey(minimum))) break;
        settings = minimum;
      }
      tested.add(settingsKey(settings));
      const started = Date.now();
      let candidate = await buildCandidate(settings, { attempt, totalAttempts: PDF_COMPRESSION_POLICY.maxAttempts });
      pending = candidate;
      check();
      const size = candidate?.size;
      if (!Number.isSafeInteger(size) || size < 1 || size > PDF_COMPRESSION_POLICY.maxCandidateBytes) {
        throw pdfCompressionError('output-invalid');
      }
      smallestSize = Math.min(smallestSize, size);
      const metadata = { size, settings: { ...settings } };
      const trace = { attempt, ...settings, bytes: size, elapsedMs: Math.max(0, Date.now() - started) };
      attempts.push(trace);
      onAttempt(trace);
      if (size <= targetBytes) {
        if (!best || size > best.size) {
          if (best) await release(best);
          best = { ...candidate, ...metadata };
        } else await release(candidate);
        candidate = null;
        pending = null;
        if (!above || best.size / targetBytes >= PDF_COMPRESSION_POLICY.goodFitRatio) break;
        settings = refineSettings(above, best, targetBytes);
        if (!settings) break;
      } else {
        if (!above || size < above.size) above = metadata;
        await release(candidate);
        candidate = null;
        pending = null;
        if (settingsKey(settings) === settingsKey(minimum)) break;
        settings = best ? refineSettings(above, best, targetBytes) : shrinkSettings(settings, size, targetBytes, options);
        if (!settings) settings = minimum;
      }
    }
    check();
    return { candidate: best, targetReached: Boolean(best), smallestSize, attempts };
  } catch (error) {
    if (pending) await release(pending);
    if (best) await release(best);
    throw error;
  }
}
