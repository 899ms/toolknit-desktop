import { pdfCropRectsEqual } from './core.js';

const POINTS_PER_MM = 72 / 25.4;

export function releasePdfCropCanvas(canvas) {
  if (!canvas) return;
  canvas.width = 0;
  canvas.height = 0;
}

export function formatPdfCropBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(value >= 10 * 1024 * 1024 ? 0 : 1)} MB`;
  if (value >= 1024) return `${Math.round(value / 1024)} KB`;
  return `${value} B`;
}

export function pdfCropUnitFactor(unit) {
  return unit === 'pt' ? 1 : POINTS_PER_MM;
}

export function formatPdfCropUnitValue(points, unit) {
  const converted = Number(points || 0) / pdfCropUnitFactor(unit);
  return Math.abs(converted) >= 100 ? converted.toFixed(0) : converted.toFixed(1).replace(/\.0$/, '');
}

export function formatPdfCropDimensions(rect, page, unit, roundPoints = false) {
  const width = (Number(rect?.width) || 0) * (Number(page?.displayWidth) || 0);
  const height = (Number(rect?.height) || 0) * (Number(page?.displayHeight) || 0);
  if (unit === 'pt') {
    return roundPoints
      ? `${Math.round(width)} × ${Math.round(height)} pt`
      : `${width.toFixed(1)} × ${height.toFixed(1)} pt`;
  }
  return `${(width / POINTS_PER_MM).toFixed(1)} × ${(height / POINTS_PER_MM).toFixed(1)} mm`;
}

export function snapshotPdfCropPages(pages) {
  return pages.map(page => ({ rect: { ...page.rect }, explicit: Boolean(page.explicit) }));
}

export function pdfCropSnapshotsEqual(left, right) {
  return Array.isArray(left) && Array.isArray(right) && left.length === right.length
    && left.every((entry, index) => Boolean(entry.explicit) === Boolean(right[index]?.explicit)
      && pdfCropRectsEqual(entry.rect, right[index]?.rect));
}
