import JSZip from 'jszip';

export const PPT_COMPRESS_LIMITS = Object.freeze({
  maxInputBytes: 200 * 1024 * 1024,
  maxSlides: 500,
  maxMediaFiles: 3000
});

export const PPT_COMPRESS_LEVELS = Object.freeze(['low', 'medium', 'high']);

const XML_TEXT_DECODER = new TextDecoder('utf-8', { fatal: false });
const THUMBNAIL_RELATIONSHIP = /(?:\/metadata)?\/thumbnail$/i;
const PRINTER_SETTINGS_RELATIONSHIP = /\/relationships\/printerSettings$/i;

export class PptCompressError extends Error {
  constructor(code, message) {
    super(`ppt-compress:${code}:${message}`);
    this.name = 'PptCompressError';
    this.code = code;
    this.userMessage = message;
  }
}

function fail(code, message) {
  throw new PptCompressError(code, message);
}

function toUint8Array(bytes) {
  if (bytes instanceof Uint8Array) return bytes;
  if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes);
  if (ArrayBuffer.isView(bytes)) return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  fail('invalid_request', 'PPTX bytes must be a Uint8Array or ArrayBuffer.');
}

function xmlDecode(value) {
  return String(value || '')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');
}

function xmlEncode(value) {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function extractXmlAttributes(source) {
  const attributes = {};
  for (const match of String(source || '').matchAll(/([A-Za-z_][\w:.-]*)\s*=\s*(["'])(.*?)\2/gs)) {
    attributes[match[1]] = xmlDecode(match[3]);
  }
  return attributes;
}

function normalizeZipPath(value) {
  const normalized = String(value || '').replaceAll('\\', '/').replace(/^\/+/, '');
  const clean = normalized.split('/').filter(Boolean).join('/');
  if (!clean || clean.includes('\0')) return null;
  const posix = clean.replaceAll(/\/+/g, '/');
  if (posix.split('/').includes('..')) return null;
  return posix;
}

function pathPosixNormalize(value) {
  const parts = [];
  for (const part of String(value || '').split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return parts.join('/');
}

function directoryName(partPath) {
  const index = partPath.lastIndexOf('/');
  return index === -1 ? '' : partPath.slice(0, index);
}

function resolveRelationshipTarget(baseDirectory, target) {
  if (!target || /^[a-z][a-z0-9+.-]*:/i.test(target)) return null;
  const normalizedTarget = String(target).replaceAll('\\', '/');
  const joined = normalizedTarget.startsWith('/')
    ? normalizedTarget.slice(1)
    : pathPosixNormalize(`${baseDirectory}/${normalizedTarget}`);
  return normalizeZipPath(joined);
}

function relativeTarget(fromDirectory, toPath) {
  const fromParts = String(fromDirectory || '').split('/').filter(Boolean);
  const toParts = String(toPath || '').split('/').filter(Boolean);
  let common = 0;
  while (common < fromParts.length && common < toParts.length && fromParts[common] === toParts[common]) common += 1;
  const up = new Array(fromParts.length - common).fill('..');
  return [...up, ...toParts.slice(common)].join('/') || toParts.at(-1) || '';
}

function isPptContentTypeValid(contentTypesXml) {
  return /presentationml\.presentation\.main\+xml/i.test(contentTypesXml)
    || /PartName=(["'])\/ppt\/presentation\.xml\1/i.test(contentTypesXml);
}

function normalizePptCompressLevel(value = 'medium') {
  const normalized = String(value || 'medium').trim().toLowerCase();
  if (normalized === 'safe' || normalized === 'light' || normalized === 'lossless') return 'low';
  if (normalized === 'balanced' || normalized === 'standard' || normalized === 'normal' || normalized === 'recommended') return 'medium';
  if (normalized === 'strong' || normalized === 'aggressive' || normalized === 'maximum') return 'high';
  if (!PPT_COMPRESS_LEVELS.includes(normalized)) {
    fail('invalid_level', 'level must be low, medium, or high.');
  }
  return normalized;
}

export function sanitizePptCompressBaseName(value) {
  const pathBaseName = String(value || 'presentation').split(/[\\/]/).pop() || 'presentation';
  const base = pathBaseName
    .replace(/\.[A-Za-z0-9]+$/, '')
    .replace(/[\\/:*?"<>|\u0000-\u001F]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^[._]+|[._]+$/g, '')
    .slice(0, 80);
  if (!base || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(base)) return 'presentation';
  return base;
}

export function assertPptxCompressBytes(bytes, sourceName = 'presentation.pptx') {
  const data = toUint8Array(bytes);
  if (!String(sourceName || '').toLowerCase().endsWith('.pptx')) {
    fail('invalid_extension', 'Only .pptx files are supported in the first PPT compression stage.');
  }
  if (data.byteLength < 4 || data[0] !== 0x50 || data[1] !== 0x4B) {
    fail('invalid_pptx', 'PPTX must be a valid ZIP-based PowerPoint file.');
  }
  if (data.byteLength > PPT_COMPRESS_LIMITS.maxInputBytes) {
    fail('input_too_large', `PPTX files for compression must be ${PPT_COMPRESS_LIMITS.maxInputBytes / 1024 / 1024}MB or smaller.`);
  }
  return data;
}

async function readRequiredZipText(zip, partPath) {
  const file = zip.file(partPath);
  if (!file) fail('invalid_pptx', `PPTX is missing ${partPath}.`);
  return file.async('string');
}

function findSlideCount(zip) {
  return Object.keys(zip.files)
    .map(normalizeZipPath)
    .filter(Boolean)
    .filter(partPath => /^ppt\/slides\/slide\d+\.xml$/i.test(partPath))
    .length;
}

function mediaParts(zip) {
  return Object.keys(zip.files)
    .map(normalizeZipPath)
    .filter(Boolean)
    .filter(partPath => /^ppt\/media\/[^/]+$/i.test(partPath));
}

function parseRelationships(xml, baseDirectory) {
  const relationships = [];
  for (const match of String(xml || '').matchAll(/<Relationship\b([^>]*?)\/?>/gi)) {
    const attributes = extractXmlAttributes(match[1]);
    if (!attributes.Id || !attributes.Target) continue;
    if (String(attributes.TargetMode || '').toLowerCase() === 'external') continue;
    const targetPath = resolveRelationshipTarget(baseDirectory, attributes.Target);
    if (!targetPath) continue;
    relationships.push({
      id: attributes.Id,
      type: attributes.Type || '',
      target: attributes.Target,
      targetPath,
      raw: match[0]
    });
  }
  return relationships;
}

function allRelationshipParts(zip) {
  return Object.keys(zip.files)
    .map(normalizeZipPath)
    .filter(Boolean)
    .filter(partPath => /(^|\/)_rels\/(?:\.rels|[^/]+\.rels)$/i.test(partPath));
}

function relationshipBaseDirectory(relsPath) {
  const normalized = normalizeZipPath(relsPath);
  if (!normalized) return '';
  const relsIndex = normalized.lastIndexOf('/_rels/');
  if (relsIndex === -1) return '';
  return normalized.slice(0, relsIndex);
}

async function collectRelationshipTargets(zip) {
  const references = new Map();
  for (const relsPath of allRelationshipParts(zip)) {
    const file = zip.file(relsPath);
    if (!file) continue;
    const xml = await file.async('string');
    const baseDirectory = relationshipBaseDirectory(relsPath);
    for (const relation of parseRelationships(xml, baseDirectory)) {
      if (!references.has(relation.targetPath)) references.set(relation.targetPath, []);
      references.get(relation.targetPath).push({ relsPath, relation });
    }
  }
  return references;
}

function removeRelationshipNodes(xml, predicate) {
  let removed = 0;
  const next = String(xml || '').replace(/<Relationship\b([^>]*?)\/?>/gi, (raw, attrs) => {
    const attributes = extractXmlAttributes(attrs);
    if (predicate(attributes)) {
      removed += 1;
      return '';
    }
    return raw;
  });
  return { xml: next, removed };
}

function resolveTargetReplacement(targetPath, replacementMap) {
  if (!targetPath || !replacementMap?.size) return null;
  let current = targetPath;
  const visited = new Set();
  for (let index = 0; index < 16; index += 1) {
    const next = replacementMap.get(current);
    if (!next || next === current || visited.has(next)) break;
    visited.add(current);
    current = next;
  }
  return current !== targetPath ? current : null;
}

function rewriteRelationshipTargets(xml, relsPath, targetReplacementMap) {
  const baseDirectory = relationshipBaseDirectory(relsPath);
  let rewrites = 0;
  const next = String(xml || '').replace(/<Relationship\b([^>]*?)\/?>/gi, (raw, attrs) => {
    const attributes = extractXmlAttributes(attrs);
    if (!attributes.Target || String(attributes.TargetMode || '').toLowerCase() === 'external') return raw;
    const targetPath = resolveRelationshipTarget(baseDirectory, attributes.Target);
    const canonicalPath = targetPath ? resolveTargetReplacement(targetPath, targetReplacementMap) : null;
    if (!canonicalPath || canonicalPath === targetPath) return raw;
    const newTarget = relativeTarget(baseDirectory, canonicalPath);
    rewrites += 1;
    return raw.replace(/\bTarget\s*=\s*(["'])(.*?)\1/i, `Target="${
      xmlEncode(newTarget)
    }"`);
  });
  return { xml: next, rewrites };
}

function removeContentTypeOverrides(xml, removedPaths) {
  if (!removedPaths.size) return { xml, removed: 0 };
  let removed = 0;
  const next = String(xml || '').replace(/<Override\b([^>]*?)\/?>/gi, (raw, attrs) => {
    const attributes = extractXmlAttributes(attrs);
    const partName = normalizeZipPath(attributes.PartName || '');
    if (partName && removedPaths.has(partName)) {
      removed += 1;
      return '';
    }
    return raw;
  });
  return { xml: next, removed };
}

function shouldRemoveThumbnailPath(partPath) {
  return /^docProps\/thumbnail\.[A-Za-z0-9]+$/i.test(partPath);
}

function shouldRemovePrinterSettingsPath(partPath) {
  return /^ppt\/printerSettings\/[^/]+$/i.test(partPath);
}

function relationshipTargetCandidates(relsPath, target) {
  const baseDirectory = relationshipBaseDirectory(relsPath);
  return [
    resolveRelationshipTarget(baseDirectory, target || ''),
    normalizeZipPath(target || '')
  ].filter(Boolean);
}

function relationshipTargetsRemoved(relsPath, target, removedPaths, targetReplacementMap) {
  return relationshipTargetCandidates(relsPath, target).some(partPath => (
    removedPaths.has(partPath) && !targetReplacementMap.has(partPath)
  ));
}

function relationshipTargetsThumbnail(relsPath, target) {
  return relationshipTargetCandidates(relsPath, target).some(shouldRemoveThumbnailPath);
}

function relationshipTargetsPrinterSettings(relsPath, target) {
  return relationshipTargetCandidates(relsPath, target).some(shouldRemovePrinterSettingsPath);
}

async function sha256Hex(bytes) {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', toUint8Array(bytes));
  return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
}

function extensionFromPath(partPath) {
  const match = /\.([A-Za-z0-9]+)$/.exec(partPath);
  return match ? match[1].toLowerCase() : '';
}

function normalizeMediaExtension(value) {
  const extension = String(value || '').trim().replace(/^\./, '').toLowerCase();
  if (extension === 'jpeg') return 'jpg';
  return extension;
}

function mediaContentType(extension) {
  const normalized = normalizeMediaExtension(extension);
  if (normalized === 'jpg') return 'image/jpeg';
  if (normalized === 'png') return 'image/png';
  return '';
}

function isCompressibleMediaExtension(extension) {
  return ['jpg', 'jpeg', 'png'].includes(String(extension || '').toLowerCase());
}

function replacePathExtension(partPath, extension) {
  const normalizedExtension = normalizeMediaExtension(extension);
  if (!normalizedExtension) return partPath;
  if (/\.[A-Za-z0-9]+$/.test(partPath)) return partPath.replace(/\.[A-Za-z0-9]+$/, `.${normalizedExtension}`);
  return `${partPath}.${normalizedExtension}`;
}

function uniqueMediaPath(partPath, extension, occupiedPaths) {
  const normalizedExtension = normalizeMediaExtension(extension);
  const preferred = replacePathExtension(partPath, normalizedExtension);
  if (!occupiedPaths.has(preferred) || preferred === partPath) {
    occupiedPaths.add(preferred);
    return preferred;
  }
  const withoutExtension = partPath.replace(/\.[A-Za-z0-9]+$/, '');
  for (let index = 1; index < 10_000; index += 1) {
    const candidate = `${withoutExtension}_toolknit_${index}.${normalizedExtension}`;
    if (!occupiedPaths.has(candidate)) {
      occupiedPaths.add(candidate);
      return candidate;
    }
  }
  return null;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function ensureContentTypeDefault(xml, extension, contentType) {
  const normalizedExtension = normalizeMediaExtension(extension);
  if (!normalizedExtension || !contentType) return xml;
  const pattern = new RegExp(`<Default\\b[^>]*\\bExtension=(["'])${escapeRegExp(normalizedExtension)}\\1[^>]*>`, 'i');
  if (pattern.test(xml)) return xml;
  const entry = `  <Default Extension="${xmlEncode(normalizedExtension)}" ContentType="${xmlEncode(contentType)}"/>\n`;
  if (/<\/Types>\s*$/i.test(xml)) return xml.replace(/<\/Types>\s*$/i, `${entry}</Types>`);
  return `${xml}\n${entry}`;
}

function normalizeImageCompressionOutput(output, originalExtension) {
  if (!output || typeof output !== 'object') return null;
  const bytes = output.bytes === undefined ? null : toUint8Array(output.bytes);
  if (!bytes?.byteLength) return null;
  const extension = normalizeMediaExtension(output.extension || originalExtension);
  if (!['jpg', 'png'].includes(extension)) return null;
  return {
    bytes,
    extension,
    width: Number.isFinite(output.width) ? Math.max(1, Math.round(output.width)) : null,
    height: Number.isFinite(output.height) ? Math.max(1, Math.round(output.height)) : null
  };
}

async function buildImageCompressionPlan(zip, media, config, options, removedPaths) {
  const compressor = typeof options.imageCompressor === 'function' ? options.imageCompressor : null;
  const imageConfig = config.imageCompression;
  const plan = {
    replacements: new Map(),
    additions: new Map(),
    targetReplacementMap: new Map(),
    addedExtensions: new Set(),
    operations: {
      compressed_images: 0,
      skipped_images: 0,
      failed_images: 0,
      image_input_bytes: 0,
      image_output_bytes: 0
    }
  };

  if (!imageConfig || !compressor) return plan;

  const occupiedPaths = new Set(Object.keys(zip.files).map(normalizeZipPath).filter(Boolean));
  for (const partPath of media.sort()) {
    if (options.signal?.aborted) fail('cancelled', 'PPT compression was cancelled.');
    if (removedPaths.has(partPath)) continue;
    const extension = extensionFromPath(partPath);
    if (!isCompressibleMediaExtension(extension)) {
      plan.operations.skipped_images += 1;
      continue;
    }
    const sourceFile = zip.file(partPath);
    if (!sourceFile) continue;
    const sourceBytes = await sourceFile.async('uint8array');
    if (sourceBytes.byteLength < imageConfig.minInputBytes) {
      plan.operations.skipped_images += 1;
      continue;
    }
    let output;
    try {
      output = normalizeImageCompressionOutput(await compressor({
        partPath,
        extension,
        bytes: sourceBytes,
        level: config.level,
        quality: imageConfig.quality,
        maxDimension: imageConfig.maxDimension,
        allowPngToJpeg: imageConfig.allowPngToJpeg,
        signal: options.signal
      }), extension);
    } catch {
      plan.operations.failed_images += 1;
      continue;
    }
    if (!output) {
      plan.operations.skipped_images += 1;
      continue;
    }
    const savingBytes = sourceBytes.byteLength - output.bytes.byteLength;
    const savingRatio = sourceBytes.byteLength > 0 ? savingBytes / sourceBytes.byteLength : 0;
    if (
      savingBytes < imageConfig.minSavingBytes
      || savingRatio < imageConfig.minSavingRatio
      || output.bytes.byteLength >= sourceBytes.byteLength
    ) {
      plan.operations.skipped_images += 1;
      continue;
    }

    const outputExtension = normalizeMediaExtension(output.extension || extension);
    const sourceExtension = normalizeMediaExtension(extension);
    if (outputExtension === sourceExtension) {
      plan.replacements.set(partPath, output.bytes);
    } else {
      const newPath = uniqueMediaPath(partPath, outputExtension, occupiedPaths);
      if (!newPath) {
        plan.operations.failed_images += 1;
        continue;
      }
      removedPaths.add(partPath);
      plan.additions.set(newPath, output.bytes);
      plan.targetReplacementMap.set(partPath, newPath);
      const contentType = mediaContentType(outputExtension);
      if (contentType) plan.addedExtensions.add(outputExtension);
    }
    plan.operations.compressed_images += 1;
    plan.operations.image_input_bytes += sourceBytes.byteLength;
    plan.operations.image_output_bytes += output.bytes.byteLength;
  }
  return plan;
}

async function duplicateMediaPlan(zip, paths) {
  const seen = new Map();
  const duplicates = new Map();
  for (const partPath of paths.sort()) {
    const file = zip.file(partPath);
    if (!file) continue;
    const bytes = await file.async('uint8array');
    const key = `${extensionFromPath(partPath)}:${bytes.byteLength}:${await sha256Hex(bytes)}`;
    const canonical = seen.get(key);
    if (canonical) duplicates.set(partPath, canonical);
    else seen.set(key, partPath);
  }
  return duplicates;
}

function zipFileDate(file) {
  return file?.date instanceof Date ? file.date : new Date(0);
}

async function cloneZipWithChanges(sourceZip, { replacements, removedPaths, additions }) {
  const outputZip = new JSZip();
  const replacementMap = replacements || new Map();
  const removedSet = removedPaths || new Set();
  const additionsMap = additions || new Map();
  const orderedPaths = Object.keys(sourceZip.files).sort((left, right) => left.localeCompare(right));
  for (const rawPath of orderedPaths) {
    const partPath = normalizeZipPath(rawPath);
    if (!partPath || removedSet.has(partPath)) continue;
    const sourceFile = sourceZip.file(rawPath);
    if (!sourceFile) {
      outputZip.folder(partPath);
      continue;
    }
    const replacement = replacementMap.get(partPath);
    const content = replacement !== undefined ? replacement : await sourceFile.async('uint8array');
    outputZip.file(partPath, content, {
      date: zipFileDate(sourceFile),
      comment: sourceFile.comment || undefined,
      unixPermissions: sourceFile.unixPermissions,
      dosPermissions: sourceFile.dosPermissions
    });
  }
  for (const [partPath, content] of [...additionsMap.entries()].sort((left, right) => left[0].localeCompare(right[0]))) {
    if (!normalizeZipPath(partPath)) continue;
    outputZip.file(partPath, content, { date: new Date(0) });
  }
  return outputZip;
}

function levelConfig(level) {
  const normalized = normalizePptCompressLevel(level);
  if (normalized === 'low') {
    return {
      level: normalized,
      compressionLevel: 6,
      removeThumbnails: true,
      removeUnusedMedia: false,
      dedupeMedia: false,
      removePrinterSettings: false,
      imageCompression: null
    };
  }
  if (normalized === 'high') {
    return {
      level: normalized,
      compressionLevel: 9,
      removeThumbnails: true,
      removeUnusedMedia: true,
      dedupeMedia: true,
      removePrinterSettings: true,
      imageCompression: {
        quality: 0.68,
        maxDimension: 1600,
        minInputBytes: 40 * 1024,
        minSavingBytes: 2 * 1024,
        minSavingRatio: 0.03,
        allowPngToJpeg: true
      }
    };
  }
  return {
    level: normalized,
    compressionLevel: 9,
    removeThumbnails: true,
    removeUnusedMedia: true,
    dedupeMedia: true,
    removePrinterSettings: false,
    imageCompression: {
      quality: 0.82,
      maxDimension: 2200,
      minInputBytes: 80 * 1024,
      minSavingBytes: 4 * 1024,
      minSavingRatio: 0.04,
      allowPngToJpeg: true
    }
  };
}

export async function compressPptxBytes(bytes, options = {}) {
  if (options.signal?.aborted) fail('cancelled', 'PPT compression was cancelled.');
  const data = assertPptxCompressBytes(bytes, options.sourceName || 'presentation.pptx');
  const config = levelConfig(options.level || 'medium');
  let zip;
  try {
    zip = await JSZip.loadAsync(data);
  } catch {
    fail('invalid_pptx', 'PPTX could not be opened as a ZIP package.');
  }

  const contentTypes = await readRequiredZipText(zip, '[Content_Types].xml');
  await readRequiredZipText(zip, 'ppt/presentation.xml');
  if (!isPptContentTypeValid(contentTypes)) {
    fail('invalid_pptx', 'PPTX does not look like a PowerPoint presentation package.');
  }

  const slideCount = findSlideCount(zip);
  if (slideCount < 1) fail('invalid_pptx', 'PPTX does not contain any slides.');
  if (slideCount > PPT_COMPRESS_LIMITS.maxSlides) {
    fail('too_many_slides', `PPTX contains more than ${PPT_COMPRESS_LIMITS.maxSlides} slides.`);
  }

  const media = mediaParts(zip);
  if (media.length > PPT_COMPRESS_LIMITS.maxMediaFiles) {
    fail('too_many_media', `PPTX contains more than ${PPT_COMPRESS_LIMITS.maxMediaFiles} media files.`);
  }

  const relationshipTargets = await collectRelationshipTargets(zip);
  const removedPaths = new Set();
  const replacements = new Map();
  const operations = {
    removed_thumbnails: 0,
    removed_unused_media: 0,
    deduplicated_media: 0,
    compressed_images: 0,
    skipped_images: 0,
    failed_images: 0,
    image_input_bytes: 0,
    image_output_bytes: 0,
    removed_printer_settings: 0,
    rewritten_relationships: 0,
    removed_relationships: 0,
    removed_content_type_overrides: 0
  };

  if (config.removeThumbnails) {
    for (const partPath of Object.keys(zip.files).map(normalizeZipPath).filter(Boolean)) {
      if (shouldRemoveThumbnailPath(partPath)) {
        removedPaths.add(partPath);
        operations.removed_thumbnails += 1;
      }
    }
  }

  if (config.removePrinterSettings) {
    for (const partPath of Object.keys(zip.files).map(normalizeZipPath).filter(Boolean)) {
      if (shouldRemovePrinterSettingsPath(partPath)) {
        removedPaths.add(partPath);
        operations.removed_printer_settings += 1;
      }
    }
  }

  if (config.removeUnusedMedia) {
    for (const partPath of media) {
      if (!relationshipTargets.has(partPath)) {
        removedPaths.add(partPath);
        operations.removed_unused_media += 1;
      }
    }
  }

  const duplicateTargetMap = config.dedupeMedia
    ? await duplicateMediaPlan(zip, media.filter(partPath => !removedPaths.has(partPath)))
    : new Map();
  for (const duplicatePath of duplicateTargetMap.keys()) {
    removedPaths.add(duplicatePath);
    operations.deduplicated_media += 1;
  }

  const imagePlan = await buildImageCompressionPlan(
    zip,
    media.filter(partPath => !duplicateTargetMap.has(partPath)),
    config,
    options,
    removedPaths
  );
  if (options.signal?.aborted) fail('cancelled', 'PPT compression was cancelled.');
  for (const [key, value] of Object.entries(imagePlan.operations)) {
    operations[key] = (operations[key] || 0) + value;
  }
  for (const [partPath, content] of imagePlan.replacements) replacements.set(partPath, content);

  const targetReplacementMap = new Map(duplicateTargetMap);
  for (const [oldPath, newPath] of imagePlan.targetReplacementMap) {
    targetReplacementMap.set(oldPath, newPath);
  }

  for (const relsPath of allRelationshipParts(zip)) {
    const file = zip.file(relsPath);
    if (!file) continue;
    let xml = await file.async('string');
    const removeResult = removeRelationshipNodes(xml, attributes => {
      const type = attributes.Type || '';
      return (config.removeThumbnails && (THUMBNAIL_RELATIONSHIP.test(type) || relationshipTargetsThumbnail(relsPath, attributes.Target)))
        || (config.removePrinterSettings && (PRINTER_SETTINGS_RELATIONSHIP.test(type) || relationshipTargetsPrinterSettings(relsPath, attributes.Target)))
        || relationshipTargetsRemoved(relsPath, attributes.Target, removedPaths, targetReplacementMap);
    });
    xml = removeResult.xml;
    operations.removed_relationships += removeResult.removed;

    const rewriteResult = rewriteRelationshipTargets(xml, relsPath, targetReplacementMap);
    xml = rewriteResult.xml;
    operations.rewritten_relationships += rewriteResult.rewrites;

    if (removeResult.removed || rewriteResult.rewrites) replacements.set(relsPath, xml);
  }

  if (removedPaths.size) {
    let contentTypesXml = contentTypes;
    const contentTypeResult = removeContentTypeOverrides(contentTypesXml, removedPaths);
    if (contentTypeResult.removed) {
      contentTypesXml = contentTypeResult.xml;
      operations.removed_content_type_overrides = contentTypeResult.removed;
    }
    for (const extension of imagePlan.addedExtensions) {
      contentTypesXml = ensureContentTypeDefault(contentTypesXml, extension, mediaContentType(extension));
    }
    if (contentTypesXml !== contentTypes) replacements.set('[Content_Types].xml', contentTypesXml);
  } else if (imagePlan.addedExtensions.size) {
    let contentTypesXml = contentTypes;
    for (const extension of imagePlan.addedExtensions) {
      contentTypesXml = ensureContentTypeDefault(contentTypesXml, extension, mediaContentType(extension));
    }
    if (contentTypesXml !== contentTypes) replacements.set('[Content_Types].xml', contentTypesXml);
  }

  const outputZip = await cloneZipWithChanges(zip, {
    replacements,
    removedPaths,
    additions: imagePlan.additions
  });
  if (options.signal?.aborted) fail('cancelled', 'PPT compression was cancelled.');
  const compressed = await outputZip.generateAsync({
    type: 'uint8array',
    compression: 'DEFLATE',
    compressionOptions: { level: config.compressionLevel },
    platform: 'DOS'
  });
  const outputBytes = compressed.byteLength <= data.byteLength ? compressed : data;
  const originalBytes = data.byteLength;
  const compressedBytes = outputBytes.byteLength;
  const savedBytes = Math.max(0, originalBytes - compressedBytes);
  const savingRatio = originalBytes > 0 ? savedBytes / originalBytes : 0;

  return {
    tool: 'ppt.compress',
    source_name: options.sourceName || 'presentation.pptx',
    level: config.level,
    slide_count: slideCount,
    media_count: media.length,
    original_bytes: originalBytes,
    compressed_bytes: compressedBytes,
    attempted_compressed_bytes: compressed.byteLength,
    saved_bytes: savedBytes,
    saving_ratio: savingRatio,
    already_optimized: savedBytes === 0,
    used_original_bytes: compressed.byteLength > data.byteLength,
    image_compression_enabled: Boolean(config.imageCompression),
    image_compression_available: typeof options.imageCompressor === 'function',
    removed_count: removedPaths.size,
    operations,
    bytes: outputBytes
  };
}

export function createPptCompressManifest(result) {
  const publicResult = { ...result };
  delete publicResult.bytes;
  return publicResult;
}
