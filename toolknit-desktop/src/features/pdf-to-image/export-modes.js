export const PDF_TO_IMAGE_WORKSPACE_LIMITS = Object.freeze({
  minLongPages: 2,
  maxLongPages: 5,
  gridPageCounts: Object.freeze([4, 9])
});

export function isPdfToImageGridCount(value) {
  return PDF_TO_IMAGE_WORKSPACE_LIMITS.gridPageCounts.includes(Number(value));
}

export function syncPdfToImageExportModes({
  longButton,
  horizontalButton,
  gridButton,
  longExportAllowed,
  selectedCount,
  busy
} = {}) {
  const horizontalAvailable = Boolean(longExportAllowed)
    && selectedCount >= PDF_TO_IMAGE_WORKSPACE_LIMITS.minLongPages
    && selectedCount <= PDF_TO_IMAGE_WORKSPACE_LIMITS.maxLongPages;
  const longAvailable = horizontalAvailable;
  const gridAvailable = Boolean(longExportAllowed)
    && isPdfToImageGridCount(selectedCount);
  const sync = (button, available, visible = true) => {
    if (!button) return;
    const disabled = Boolean(busy) || !available;
    button.classList.toggle('is-available', available);
    button.setAttribute('aria-hidden', String(!visible));
    button.setAttribute('aria-disabled', String(disabled));
    button.disabled = disabled;
  };
  sync(longButton, longAvailable, Boolean(longExportAllowed));
  sync(horizontalButton, horizontalAvailable);
  sync(gridButton, gridAvailable);
  return { longAvailable, horizontalAvailable, gridAvailable };
}

export function validatePdfToImageExportMode(mode, selectedCount, longExportAllowed) {
  if (['long', 'long-horizontal', 'grid'].includes(mode) && !longExportAllowed) return 'unavailable';
  if (['long', 'long-horizontal'].includes(mode)) {
    if (selectedCount < PDF_TO_IMAGE_WORKSPACE_LIMITS.minLongPages) return 'too-few-long-pages';
    if (selectedCount > PDF_TO_IMAGE_WORKSPACE_LIMITS.maxLongPages) return 'too-many-long-pages';
  }
  if (mode === 'grid' && !isPdfToImageGridCount(selectedCount)) return 'invalid-grid-count';
  return '';
}
