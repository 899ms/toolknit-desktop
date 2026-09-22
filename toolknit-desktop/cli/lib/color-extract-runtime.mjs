import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import {
  COLOR_EXTRACTOR_LIMITS,
  assertColorExtractorImageBytes,
  paletteFromRgba,
  readColorExtractorImageDimensions
} from './core/color-extractor-core.js';
import { ToolKnitError } from './errors.mjs';

const EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp']);

function report(options, value, message) { try { options.reportProgress?.(value, message); } catch {} }
export async function extractColorPalette(args, options = {}) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new ToolKnitError('INVALID_ARGUMENT', 'arguments must be an object.');
  if (Object.keys(args).some(key => !['input_path', 'count'].includes(key))) throw new ToolKnitError('INVALID_ARGUMENT', 'Unknown argument.');
  if (typeof args.input_path !== 'string' || !args.input_path.trim() || args.input_path.includes('\0')) throw new ToolKnitError('INVALID_ARGUMENT', 'input_path must be a non-empty path string.');
  const requested = path.resolve(args.input_path.trim());
  report(options, 0, 'Validating image input.');
  let meta; try { meta = await lstat(requested); } catch { throw new ToolKnitError('INPUT_NOT_FOUND', `Image input does not exist: ${requested}`); }
  if (meta.isSymbolicLink() || !meta.isFile() || meta.size < 1 || !EXTENSIONS.has(path.extname(requested).toLowerCase())) throw new ToolKnitError('INPUT_INVALID', `Image input must be a supported regular PNG, JPEG, or WebP file: ${requested}`);
  if (meta.size > COLOR_EXTRACTOR_LIMITS.maxBytes) throw new ToolKnitError('INPUT_TOO_LARGE', `Images for palette extraction must be ${Math.floor(COLOR_EXTRACTOR_LIMITS.maxBytes / 1024 / 1024)}MB or smaller.`);
  const count = args.count === undefined ? 5 : Number(args.count);
  if (!Number.isInteger(count) || count < 2 || count > 9) throw new ToolKnitError('INVALID_ARGUMENT', 'count must be an integer from 2 to 9.');
  const bytes = await readFile(requested); let dimensions;
  try { dimensions = assertColorExtractorImageBytes(bytes); } catch (error) { throw new ToolKnitError(error instanceof RangeError ? 'INPUT_TOO_LARGE' : 'INPUT_INVALID', error.message); }
  report(options, 20, 'Decoding image pixels.');
  let image; try { image = await loadImage(bytes); } catch { throw new ToolKnitError('INPUT_INVALID', 'Image data could not be decoded.'); }
  const scale = Math.min(200 / dimensions.width, 200 / dimensions.height, 1); const width = Math.max(1, Math.round(dimensions.width * scale)); const height = Math.max(1, Math.round(dimensions.height * scale));
  const canvas = createCanvas(width, height); const context = canvas.getContext('2d'); context.drawImage(image, 0, 0, width, height);
  report(options, 55, 'Clustering dominant colors.');
  const palette = paletteFromRgba(context.getImageData(0, 0, width, height).data, count);
  if (!palette.length) throw new ToolKnitError('PROCESSING_FAILED', 'The image does not contain visible pixels.');
  report(options, 100, 'Color palette extraction completed.');
  return { tool: 'color.extract', input: { path: await realpath(requested), bytes: bytes.length, width: dimensions.width, height: dimensions.height }, sampled: { width, height, visible_pixels: palette.reduce((sum, color) => sum + color.pixels, 0) }, palette };
}
