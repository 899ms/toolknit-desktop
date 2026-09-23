import JSZip from 'jszip';
import { assertIconArchiveSize, createEmbeddedIconSvg, encodeIco } from './core.js';

export const ICON_SIZES = Object.freeze([16, 24, 32, 48, 64, 96, 128, 144, 152, 167, 180, 192, 256, 384, 512, 1024]);
export const ICO_SIZES = Object.freeze([16, 24, 32, 48, 64, 128, 256]);
export const FAVICON_SIZES = Object.freeze([16, 32, 48]);

function defaultCanvasFactory() {
  return document.createElement('canvas');
}

function imageDimensions(image) {
  return {
    width: Number(image?.naturalWidth || image?.width),
    height: Number(image?.naturalHeight || image?.height)
  };
}

export function releaseCanvas(canvas) {
  if (!canvas) return;
  canvas.width = 0;
  canvas.height = 0;
}

export function drawSquareCanvas(image, size, createCanvas = defaultCanvasFactory) {
  const canvas = createCanvas();
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d');
  if (!context) {
    releaseCanvas(canvas);
    throw new Error('Canvas 2D context unavailable');
  }
  const { width, height } = imageDimensions(image);
  const sourceSize = Math.max(1, Math.min(width, height));
  context.drawImage(
    image,
    (width - sourceSize) / 2,
    (height - sourceSize) / 2,
    sourceSize,
    sourceSize,
    0,
    0,
    size,
    size
  );
  return canvas;
}

function canvasToPngBlob(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(blob => {
      if (blob) resolve(blob);
      else reject(new Error('Canvas PNG encoding returned no data'));
    }, 'image/png');
  });
}

async function renderPng(image, size, { assertActive, createCanvas }) {
  const canvas = drawSquareCanvas(image, size, createCanvas);
  try {
    const blob = await canvasToPngBlob(canvas);
    assertActive();
    return blob;
  } finally {
    releaseCanvas(canvas);
  }
}

async function renderIco(image, sizes, options) {
  const pngs = [];
  for (const size of sizes) {
    options.assertActive();
    const blob = await renderPng(image, size, options);
    const data = new Uint8Array(await blob.arrayBuffer());
    options.assertActive();
    pngs.push({ size, data });
  }
  return new Blob([encodeIco(pngs)], { type: 'image/x-icon' });
}

function renderSvg(image, { assertActive, createCanvas }) {
  const canvas = drawSquareCanvas(image, 1024, createCanvas);
  try {
    const dataUrl = canvas.toDataURL('image/png');
    assertActive();
    const separator = dataUrl.indexOf(',');
    if (separator < 0) throw new Error('Canvas PNG encoding returned invalid data');
    return createEmbeddedIconSvg(dataUrl.slice(separator + 1));
  } finally {
    releaseCanvas(canvas);
  }
}

export async function generateIconArchive({
  image,
  assertActive = () => {},
  createCanvas = defaultCanvasFactory,
  createZip = () => new JSZip(),
  onProgress = () => {}
} = {}) {
  if (!image) throw new TypeError('Icon generation requires a decoded source image');
  const options = { assertActive, createCanvas };
  const zip = createZip();
  const folder = zip.folder('icons');
  if (!folder) throw new Error('Cannot create icon archive folder');
  const totalSteps = ICON_SIZES.length + 3;
  let step = 0;

  for (const size of ICON_SIZES) {
    assertActive();
    folder.file(`icon-${size}x${size}.png`, await renderPng(image, size, options));
    step += 1;
    onProgress({ phase: 'png', percent: Math.round((step / totalSteps) * 80) });
  }

  onProgress({ phase: 'ico', percent: Math.round((step / totalSteps) * 80) });
  folder.file('icon.ico', await renderIco(image, ICO_SIZES, options));
  step += 1;
  onProgress({ phase: 'ico', percent: Math.round((step / totalSteps) * 80) });

  onProgress({ phase: 'svg', percent: Math.round((step / totalSteps) * 80) });
  folder.file('icon.svg', renderSvg(image, options));
  step += 1;
  onProgress({ phase: 'svg', percent: Math.round((step / totalSteps) * 80) });

  onProgress({ phase: 'favicon', percent: Math.round((step / totalSteps) * 80) });
  folder.file('favicon.ico', await renderIco(image, FAVICON_SIZES, options));
  step += 1;
  onProgress({ phase: 'favicon', percent: Math.round((step / totalSteps) * 80) });

  assertActive();
  onProgress({ phase: 'archive', percent: 90 });
  const blob = await zip.generateAsync(
    { type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 }, streamFiles: true },
    metadata => {
      assertActive();
      onProgress({ phase: 'archive', percent: Math.min(99, 90 + Math.round(Number(metadata?.percent || 0) * 0.09)) });
    }
  );
  assertActive();
  assertIconArchiveSize(blob.size);
  onProgress({ phase: 'archive', percent: 100 });
  return { blob, count: totalSteps };
}
