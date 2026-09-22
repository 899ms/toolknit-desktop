const MEBIBYTE = 1024 * 1024;
const PDF_POINTS_PER_INCH = 72;

export const PDF_TO_IMAGE_LIMITS = Object.freeze({
  maxFiles: 1,
  maxInputBytes: 150 * MEBIBYTE,
  maxPages: 200,
  maxLongPages: 20,
  maxPagesPerLongImage: 5,
  minGridPages: 4,
  maxGridPages: 9,
  gridGap: 24,
  maxRenderSide: 16_384,
  maxRenderPixels: 40_000_000,
  maxLongImageSide: 32_767,
  maxLongImagePixels: 60_000_000,
  maxEstimatedWorkingBytes: 384 * MEBIBYTE
});

export const PDF_TO_IMAGE_CLARITY_PRESETS = Object.freeze({
  standard: Object.freeze({ dpi: 144, jpegQuality: 0.9, webpQuality: 1 }),
  high: Object.freeze({ dpi: 200, jpegQuality: 0.94, webpQuality: 1 }),
  print: Object.freeze({ dpi: 300, jpegQuality: 0.97, webpQuality: 1 })
});

export const PDF_TO_IMAGE_FORMATS = Object.freeze({
  png: Object.freeze({ extension: 'png', mimeType: 'image/png' }),
  jpg: Object.freeze({ extension: 'jpg', mimeType: 'image/jpeg' }),
  webp: Object.freeze({ extension: 'webp', mimeType: 'image/webp' })
});

export class PdfToImageError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PdfToImageError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new PdfToImageError(code, message);
}

function resolvedLimits(limits) {
  return limits === PDF_TO_IMAGE_LIMITS
    ? limits
    : { ...PDF_TO_IMAGE_LIMITS, ...(limits || {}) };
}

function positiveSafeInteger(value, code, message) {
  if (!Number.isSafeInteger(value) || value < 1) fail(code, message);
  return value;
}

export function normalizePdfToImageFormat(value) {
  const normalized = String(value ?? 'png').trim().toLowerCase();
  const format = normalized === 'jpeg' ? 'jpg' : normalized;
  if (!Object.hasOwn(PDF_TO_IMAGE_FORMATS, format)) {
    fail('invalid_format', 'Output format must be PNG, JPG, or WebP.');
  }
  return format;
}

export function getPdfToImageClarityPreset(value) {
  const clarity = String(value ?? 'high').trim().toLowerCase();
  const preset = PDF_TO_IMAGE_CLARITY_PRESETS[clarity];
  if (!preset) fail('invalid_clarity', 'Clarity must be standard, high, or print.');
  return { clarity, ...preset, scale: preset.dpi / PDF_POINTS_PER_INCH };
}

export function getPdfToImageFormatConfig(formatValue, clarityValue = 'high') {
  const format = normalizePdfToImageFormat(formatValue);
  const preset = getPdfToImageClarityPreset(clarityValue);
  const formatInfo = PDF_TO_IMAGE_FORMATS[format];
  const quality = format === 'jpg'
    ? preset.jpegQuality
    : format === 'webp'
      ? preset.webpQuality
      : null;
  return { format, ...formatInfo, quality, dpi: preset.dpi, scale: preset.scale };
}

export function assertPdfToImageInput(files, totalBytes, limits = PDF_TO_IMAGE_LIMITS) {
  const safeLimits = resolvedLimits(limits);
  if (!Array.isArray(files) || files.length !== safeLimits.maxFiles) {
    fail('single_file_required', 'Exactly one PDF file is required.');
  }
  const fileName = String(files[0]?.name || '').trim();
  if (!/\.pdf$/i.test(fileName)) fail('invalid_pdf', 'A PDF file is required.');
  if (!Number.isSafeInteger(totalBytes) || totalBytes < 1) {
    fail('invalid_pdf', 'PDF file size is invalid.');
  }
  if (totalBytes > safeLimits.maxInputBytes) {
    fail('input_too_large', `PDF input exceeds the ${Math.floor(safeLimits.maxInputBytes / MEBIBYTE)} MB limit.`);
  }
  return files[0];
}

export const validatePdfToImageInput = assertPdfToImageInput;

export function assertPdfToImagePageCount(pageCount, limits = PDF_TO_IMAGE_LIMITS) {
  const safeLimits = resolvedLimits(limits);
  positiveSafeInteger(pageCount, 'empty_pdf', 'PDF has no pages to convert.');
  if (pageCount > safeLimits.maxPages) {
    fail('too_many_pages', `PDF exceeds the ${safeLimits.maxPages}-page limit.`);
  }
  return pageCount;
}

function readPageNumber(value) {
  if (Number.isInteger(value)) return value;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return NaN;
  return value.pageNumber ?? value.page_number ?? value.pageIndex;
}

export function normalizePdfToImagePageSelection(
  values,
  pageCount,
  mode = 'images',
  limits = PDF_TO_IMAGE_LIMITS
) {
  const safeLimits = resolvedLimits(limits);
  assertPdfToImagePageCount(pageCount, safeLimits);
  if (!['images', 'long', 'long-horizontal', 'grid'].includes(mode)) fail('invalid_mode', 'Export mode is invalid.');
  if (!Array.isArray(values) || values.length < 1) {
    fail('invalid_selection', 'Select at least one PDF page.');
  }
  if (['long', 'long-horizontal'].includes(mode) && values.length > safeLimits.maxLongPages) {
    fail('too_many_long_pages', `Long-image export accepts at most ${safeLimits.maxLongPages} pages.`);
  }
  if (mode === 'grid' && values.length !== safeLimits.minGridPages && values.length !== safeLimits.maxGridPages) {
    fail('invalid_grid_count', `Grid export accepts ${safeLimits.minGridPages}-${safeLimits.maxGridPages} pages.`);
  }

  const seen = new Set();
  const selected = values.map((value) => {
    const pageNumber = Number(readPageNumber(value));
    if (!Number.isSafeInteger(pageNumber) || pageNumber < 1 || pageNumber > pageCount) {
      fail('invalid_selection', 'Selected PDF page is outside the document.');
    }
    if (seen.has(pageNumber)) fail('invalid_selection', `PDF page ${pageNumber} is selected more than once.`);
    seen.add(pageNumber);
    return pageNumber;
  });
  return selected.sort((left, right) => left - right);
}

function normalizePageMetric(value) {
  const pageNumber = Number(readPageNumber(value));
  const width = Number(value?.width);
  const height = Number(value?.height);
  if (!Number.isSafeInteger(pageNumber) || pageNumber < 1
    || !Number.isFinite(width) || width <= 0
    || !Number.isFinite(height) || height <= 0) {
    fail('invalid_page_metrics', 'PDF page dimensions are invalid.');
  }
  return { pageNumber, width, height };
}

export function calculatePdfToImageRenderSize(pageMetric, clarityValue = 'high', limits = PDF_TO_IMAGE_LIMITS) {
  const safeLimits = resolvedLimits(limits);
  const page = normalizePageMetric(pageMetric);
  const preset = getPdfToImageClarityPreset(clarityValue);
  const requestedWidth = Math.max(1, Math.round(page.width * preset.scale));
  const requestedHeight = Math.max(1, Math.round(page.height * preset.scale));
  const requestedPixels = requestedWidth * requestedHeight;
  if (!Number.isSafeInteger(requestedPixels)) fail('page_too_large', 'PDF page dimensions are too large.');

  const limitRatio = Math.min(
    1,
    safeLimits.maxRenderSide / requestedWidth,
    safeLimits.maxRenderSide / requestedHeight,
    Math.sqrt(safeLimits.maxRenderPixels / requestedPixels)
  );
  if (!Number.isFinite(limitRatio) || limitRatio <= 0) {
    fail('page_too_large', 'PDF page cannot fit within the safe render limits.');
  }

  let width = limitRatio < 1 ? Math.max(1, Math.floor(requestedWidth * limitRatio)) : requestedWidth;
  let height = limitRatio < 1 ? Math.max(1, Math.floor(requestedHeight * limitRatio)) : requestedHeight;
  while (width > safeLimits.maxRenderSide
    || height > safeLimits.maxRenderSide
    || width * height > safeLimits.maxRenderPixels) {
    if (width >= height && width > 1) width -= 1;
    else if (height > 1) height -= 1;
    else fail('page_too_large', 'PDF page cannot fit within the safe render limits.');
  }

  const pixels = width * height;
  const actualRatio = Math.min(width / requestedWidth, height / requestedHeight);
  return {
    ...page,
    width,
    height,
    pixels,
    requestedWidth,
    requestedHeight,
    requestedPixels,
    limitRatio: actualRatio,
    wasLimited: actualRatio < 0.999999,
    requestedDpi: preset.dpi,
    effectiveDpi: preset.dpi * actualRatio,
    renderScale: preset.scale * actualRatio,
    estimatedWorkingBytes: pixels * 6
  };
}

function assertPlannedPage(value, limits) {
  const page = normalizePageMetric(value);
  const width = positiveSafeInteger(Number(value?.width), 'invalid_page_metrics', 'PDF page width is invalid.');
  const height = positiveSafeInteger(Number(value?.height), 'invalid_page_metrics', 'PDF page height is invalid.');
  const pixels = width * height;
  if (!Number.isSafeInteger(pixels)
    || width > limits.maxRenderSide
    || height > limits.maxRenderSide
    || pixels > limits.maxRenderPixels) {
    fail('page_too_large', `PDF page ${page.pageNumber} exceeds the safe render limit.`);
  }
  return { ...value, pageNumber: page.pageNumber, width, height, pixels };
}

function describeLongGroup(items, limits, orientation = 'vertical') {
  const width = orientation === 'horizontal'
    ? items.reduce((sum, item) => sum + item.width, 0)
    : Math.max(...items.map(item => item.width));
  const height = orientation === 'horizontal'
    ? Math.max(...items.map(item => item.height))
    : items.reduce((sum, item) => sum + item.height, 0);
  const pixels = width * height;
  const maxPagePixels = Math.max(...items.map(item => item.pixels));
  const estimatedWorkingBytes = pixels * 6 + maxPagePixels * 4;
  const safe = Number.isSafeInteger(height)
    && Number.isSafeInteger(pixels)
    && width <= limits.maxLongImageSide
    && height <= limits.maxLongImageSide
    && pixels <= limits.maxLongImagePixels
    && estimatedWorkingBytes <= limits.maxEstimatedWorkingBytes;
  let cursor = 0;
  const positionedItems = items.map(item => {
    const positioned = {
      ...item,
      x: orientation === 'horizontal' ? cursor : Math.floor((width - item.width) / 2),
      y: orientation === 'horizontal' ? Math.floor((height - item.height) / 2) : cursor
    };
    cursor += orientation === 'horizontal' ? item.width : item.height;
    return positioned;
  });
  return {
    safe,
    width,
    height,
    pixels,
    estimatedWorkingBytes,
    pageNumbers: items.map(item => item.pageNumber),
    items: positionedItems
  };
}

export function planPdfToImageLongGroups(pagePlans, limits = PDF_TO_IMAGE_LIMITS, orientation = 'vertical') {
  const safeLimits = resolvedLimits(limits);
  if (!Array.isArray(pagePlans) || pagePlans.length < 1) {
    fail('invalid_selection', 'Select at least one PDF page.');
  }
  if (pagePlans.length > safeLimits.maxLongPages) {
    fail('too_many_long_pages', `Long-image export accepts at most ${safeLimits.maxLongPages} pages.`);
  }
  const normalized = pagePlans.map(page => assertPlannedPage(page, safeLimits));
  const groups = [];
  let pending = [];

  const publishPending = () => {
    const group = describeLongGroup(pending, safeLimits, orientation);
    if (!group.safe) fail('output_too_large', 'A PDF page cannot fit in a safe long-image output.');
    groups.push({ ...group, groupIndex: groups.length + 1 });
    pending = [];
  };

  for (const page of normalized) {
    const candidate = [...pending, page];
    const candidateGroup = describeLongGroup(candidate, safeLimits, orientation);
    if (candidate.length <= safeLimits.maxPagesPerLongImage && candidateGroup.safe) {
      pending = candidate;
      continue;
    }
    if (pending.length) publishPending();
    pending = [page];
    if (!describeLongGroup(pending, safeLimits, orientation).safe) {
      fail('output_too_large', `PDF page ${page.pageNumber} cannot fit in a safe long-image output.`);
    }
  }
  if (pending.length) publishPending();
  return groups;
}

/** Plans a single bounded grid without resizing page content. */
export function planPdfToImageGrid(pagePlans, limits = PDF_TO_IMAGE_LIMITS) {
  const safeLimits = resolvedLimits(limits);
  if (!Array.isArray(pagePlans) || (pagePlans.length !== safeLimits.minGridPages && pagePlans.length !== safeLimits.maxGridPages)) {
    fail('invalid_grid_count', `Grid export accepts ${safeLimits.minGridPages}-${safeLimits.maxGridPages} pages.`);
  }
  const normalized = pagePlans.map(page => assertPlannedPage(page, safeLimits));
  const columns = normalized.length === 4 ? 2 : 3;
  const rows = Math.ceil(normalized.length / columns);
  const columnWidths = Array.from({ length: columns }, (_, column) => Math.max(...normalized.filter((_, index) => index % columns === column).map(page => page.width)));
  const rowHeights = Array.from({ length: rows }, (_, row) => Math.max(...normalized.slice(row * columns, (row + 1) * columns).map(page => page.height)));
  const gap = safeLimits.gridGap;
  const width = columnWidths.reduce((sum, value) => sum + value, 0) + gap * (columns - 1);
  const height = rowHeights.reduce((sum, value) => sum + value, 0) + gap * (rows - 1);
  const pixels = width * height;
  if (!Number.isSafeInteger(pixels) || width > safeLimits.maxLongImageSide || height > safeLimits.maxLongImageSide || pixels > safeLimits.maxLongImagePixels) fail('output_too_large', 'Grid image exceeds the safe output limit.');
  const offset = (values, index) => values.slice(0, index).reduce((sum, value) => sum + value, 0) + gap * index;
  const items = normalized.map((page, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    return { ...page, x: offset(columnWidths, column) + Math.floor((columnWidths[column] - page.width) / 2), y: offset(rowHeights, row) + Math.floor((rowHeights[row] - page.height) / 2) };
  });
  return { safe: true, width, height, pixels, estimatedWorkingBytes: pixels * 6, pageNumbers: normalized.map(page => page.pageNumber), items, columns, rows };
}

export function sanitizePdfToImageBaseName(sourceName) {
  let baseName = String(sourceName || 'document.pdf')
    .split(/[\\/]/)
    .pop()
    .replace(/\.pdf$/i, '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[ .]+$/g, '')
    .slice(0, 64)
    .replace(/[ .]+$/g, '');
  const reserved = baseName.split('.')[0].trimEnd().toUpperCase();
  if (!baseName || baseName === '.' || baseName === '..'
    || ['CON', 'PRN', 'AUX', 'NUL'].includes(reserved)
    || /^(?:COM|LPT)[1-9]$/.test(reserved)) {
    baseName = 'document';
  }
  return baseName;
}

function pageNumberLabel(pageNumber, pageCount) {
  positiveSafeInteger(pageNumber, 'invalid_selection', 'PDF page number is invalid.');
  positiveSafeInteger(pageCount, 'invalid_selection', 'PDF page count is invalid.');
  if (pageNumber > pageCount) fail('invalid_selection', 'PDF page number is outside the document.');
  return String(pageNumber).padStart(Math.max(2, String(pageCount).length), '0');
}

export function createPdfToImagePageFileName(sourceName, pageNumber, pageCount, formatValue) {
  const format = normalizePdfToImageFormat(formatValue);
  return `${sanitizePdfToImageBaseName(sourceName)}_page_${pageNumberLabel(pageNumber, pageCount)}.${format}`;
}

export function createPdfToImageLongFileName(sourceName, groupIndex, pageNumbers, pageCount, formatValue) {
  positiveSafeInteger(groupIndex, 'invalid_request', 'Long-image group index is invalid.');
  if (!Array.isArray(pageNumbers) || pageNumbers.length < 1 || pageNumbers.length > PDF_TO_IMAGE_LIMITS.maxPagesPerLongImage) {
    fail('invalid_selection', 'Long-image group page selection is invalid.');
  }
  const format = normalizePdfToImageFormat(formatValue);
  const pages = pageNumbers.map(pageNumber => pageNumberLabel(pageNumber, pageCount)).join('_');
  return `${sanitizePdfToImageBaseName(sourceName)}_long_${String(groupIndex).padStart(2, '0')}_pages_${pages}.${format}`;
}

export function createPdfToImageHorizontalFileName(sourceName, groupIndex, pageNumbers, pageCount, formatValue) {
  positiveSafeInteger(groupIndex, 'invalid_request', 'Long-image group index is invalid.');
  const format = normalizePdfToImageFormat(formatValue);
  const pages = pageNumbers.map(pageNumber => pageNumberLabel(pageNumber, pageCount)).join('_');
  return `${sanitizePdfToImageBaseName(sourceName)}_horizontal_${String(groupIndex).padStart(2, '0')}_pages_${pages}.${format}`;
}

export function createPdfToImageGridFileName(sourceName, pageNumbers, pageCount, formatValue) {
  const format = normalizePdfToImageFormat(formatValue);
  const pages = pageNumbers.map(pageNumber => pageNumberLabel(pageNumber, pageCount)).join('_');
  return `${sanitizePdfToImageBaseName(sourceName)}_grid_pages_${pages}.${format}`;
}

export function normalizePdfToImageRequest(value, limits = PDF_TO_IMAGE_LIMITS) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('invalid_request', 'PDF-to-image settings are required.');
  }
  const mode = String(value.mode ?? 'images').trim().toLowerCase();
  if (!['images', 'long', 'long-horizontal', 'grid'].includes(mode)) fail('invalid_mode', 'Export mode is invalid.');
  const pageCount = assertPdfToImagePageCount(Number(value.pageCount ?? value.page_count), limits);
  const format = normalizePdfToImageFormat(value.format);
  const { clarity } = getPdfToImageClarityPreset(value.clarity);
  const pages = normalizePdfToImagePageSelection(value.pages, pageCount, mode, limits);
  return { mode, format, clarity, pageCount, pages };
}

export function planPdfToImageExport(value, limits = PDF_TO_IMAGE_LIMITS) {
  const safeLimits = resolvedLimits(limits);
  const request = normalizePdfToImageRequest(value, safeLimits);
  if (!Array.isArray(value.pageMetrics)) fail('invalid_page_metrics', 'PDF page dimensions are required.');
  const metrics = new Map();
  for (const metricValue of value.pageMetrics) {
    const metric = normalizePageMetric(metricValue);
    if (metrics.has(metric.pageNumber)) fail('invalid_page_metrics', `PDF page ${metric.pageNumber} has duplicate dimensions.`);
    metrics.set(metric.pageNumber, metric);
  }
  const pagePlans = request.pages.map(pageNumber => {
    const metric = metrics.get(pageNumber);
    if (!metric) fail('invalid_page_metrics', `PDF page ${pageNumber} dimensions are missing.`);
    return calculatePdfToImageRenderSize(metric, request.clarity, safeLimits);
  });

  let outputs;
  if (request.mode === 'images') {
    outputs = pagePlans.map((page, index) => ({
      kind: 'page',
      outputIndex: index + 1,
      pageNumbers: [page.pageNumber],
      width: page.width,
      height: page.height,
      pixels: page.pixels,
      estimatedWorkingBytes: page.estimatedWorkingBytes,
      items: [{ ...page, x: 0, y: 0 }],
      fileName: createPdfToImagePageFileName(value.sourceName, page.pageNumber, request.pageCount, request.format)
    }));
  } else if (request.mode === 'grid') {
    const group = planPdfToImageGrid(pagePlans, safeLimits);
    outputs = [{ ...group, kind: 'grid', outputIndex: 1, fileName: createPdfToImageGridFileName(value.sourceName, group.pageNumbers, request.pageCount, request.format) }];
  } else {
    const horizontal = request.mode === 'long-horizontal';
    outputs = planPdfToImageLongGroups(pagePlans, safeLimits, horizontal ? 'horizontal' : 'vertical').map(group => ({
      ...group,
      kind: 'long',
      outputIndex: group.groupIndex,
      fileName: horizontal
        ? createPdfToImageHorizontalFileName(value.sourceName, group.groupIndex, group.pageNumbers, request.pageCount, request.format)
        : createPdfToImageLongFileName(value.sourceName, group.groupIndex, group.pageNumbers, request.pageCount, request.format)
    }));
  }

  return {
    ...request,
    sourceName: sanitizePdfToImageBaseName(value.sourceName),
    formatConfig: getPdfToImageFormatConfig(request.format, request.clarity),
    pagePlans,
    outputs,
    outputCount: outputs.length,
    totalPixels: outputs.reduce((sum, output) => sum + output.pixels, 0)
  };
}
