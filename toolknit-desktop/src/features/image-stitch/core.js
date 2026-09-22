import { calculateImageStitchLayout, normalizeImageStitchRequest, IMAGE_STITCH_LIMITS, ImageStitchError } from '../../image-stitch-core.js';

export const IMAGE_STITCH_GRIDS = Object.freeze({ __proto__: null, 'grid-2': 2, 'grid-3': 3, 'grid-4': 4, 'grid-5': 5 });

export function normalizeStitchSettings(value = {}) {
  const grid = IMAGE_STITCH_GRIDS[value.mode];
  const settings = normalizeImageStitchRequest({ ...value, mode: grid ? 'vertical' : value.mode });
  return grid ? { ...settings, mode: value.mode } : settings;
}

export function calculateStitchLayout(images, value = {}) {
  const settings = normalizeStitchSettings(value);
  const columns = IMAGE_STITCH_GRIDS[settings.mode];
  if (!columns) return calculateImageStitchLayout(images, settings);
  if (!Array.isArray(images) || images.length !== columns * columns) {
    throw new ImageStitchError('invalid_grid_count', 'image-stitch:invalid-grid-count');
  }
  for (const image of images) {
    if (![image.width, image.height].every(n => Number.isSafeInteger(n) && n > 0)) {
      throw new ImageStitchError('invalid_images', 'image-stitch:invalid-input');
    }
  }
  const widths = images.map(image => image.width);
  const referenceWidth = settings.reference === 'first' ? widths[0]
    : settings.reference === 'smallest' ? Math.min(...widths) : Math.max(...widths);
  const cellWidth = Math.max(1, Math.round(referenceWidth * settings.scale_percent / 100));
  const items = images.map(image => ({ ...image, target_width: cellWidth,
    target_height: Math.max(1, Math.round(image.height * cellWidth / image.width)) }));
  const cellHeight = Math.max(...items.map(item => item.target_height));
  const gap = settings.spacing_px;
  const width = columns * cellWidth + (columns - 1) * gap;
  const height = columns * cellHeight + (columns - 1) * gap;
  if (![width, height].every(n => Number.isSafeInteger(n) && n <= IMAGE_STITCH_LIMITS.maxSide)
    || width * height > IMAGE_STITCH_LIMITS.maxPixels) {
    throw new ImageStitchError('output_too_large', 'image-stitch:output-too-large');
  }
  // Equal cells preserve every image's aspect ratio without cropping.
  return { ...settings, width, height, pixels: width * height, columns,
    items: items.map((item, index) => ({ ...item,
      x: (index % columns) * (cellWidth + gap),
      y: Math.floor(index / columns) * (cellHeight + gap) + Math.floor((cellHeight - item.target_height) / 2)
    })) };
}
