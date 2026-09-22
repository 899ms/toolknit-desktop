import { createLifecycleScope } from '../../app/tool-lifecycle.js';
import { applyTranslations } from '../../i18n.js';
import { enhanceToolSelect } from '../../tool-custom-select.js';
import { tauriCorePromise } from '../../platform/tauri-runtime.js';
import {
  PPT_COMPRESS_LIMITS,
  compressPptxBytes,
  createPptCompressManifest,
  sanitizePptCompressBaseName
} from '../../ppt-compress-core.js';
import { bindPptChrome, choosePptxFile, createOperationGuard, dragHasExternalFiles, isPptxFile, readPptxFile, registerNativePptxDrop, retainBrowserObjectUrl, setInteractiveLayer, uniqueOutputDirectory, writeUniqueFile } from './shared.js';

function createElement(documentRef, tag, className, text) {
  const element = documentRef.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function formatSize(bytes) {
  const value = Math.max(0, Number(bytes) || 0);
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`;
  return `${(value / 1024 ** 3).toFixed(2)} GB`;
}

export function createPptCompressController({
  overlay,
  isTauri = false,
  t = key => key,
  onLangChange = () => () => {},
  notify = () => {},
  getOutputDir,
  displayFilesystemPath = value => String(value || ''),
  openOutputFolder = async () => false,
  initStandardToolPlasma = () => null,
  disposeStandardToolPlasma = value => value,
  refreshIcons = () => {},
  openSettings = () => {},
  openSupport = () => {},
  openExternalUrl = () => {},
  handleWindowAction = () => {}
} = {}) {
  if (!overlay) throw new Error('ppt-compress:missing-overlay');
  if (typeof getOutputDir !== 'function') throw new Error('ppt-compress:missing-output-directory');
  const documentRef = overlay.ownerDocument || document;
  const byId = id => documentRef.getElementById(id);
  const dropZone = byId('pptCompressDropZone');
  const input = byId('pptCompressFileInput');
  const cta = byId('pptCompressCta');
  const fileName = byId('pptCompressFileName');
  const empty = byId('pptCompressEmpty');
  const results = byId('pptCompressResults');
  const summary = byId('pptCompressSummary');
  const level = byId('pptCompressLevel');
  const exportButton = byId('pptCompressExportBtn');
  const stats = byId('pptCompressStats');
  const workspace = byId('pptCompressScrollArea');
  const scrollTop = byId('pptCompressScrollTop');
  const processMask = byId('pptCompressProcessMask');
  const progressFill = byId('pptCompressProcessBarFill');
  const processText = byId('pptCompressProcessText');
  const successOverlay = byId('pptCompressSuccessOverlay');
  const successMeta = byId('pptCompressSuccessMeta');
  const successOriginal = byId('pptCompressSuccessOriginal');
  const successCompressed = byId('pptCompressSuccessCompressed');
  const successSaved = byId('pptCompressSuccessSaved');
  const successPath = byId('pptCompressSuccessPath');
  const successOpenFolder = byId('pptCompressSuccessOpenFolder');
  const successOk = byId('pptCompressSuccessOk');
  const lifecycle = createLifecycleScope({ onError: error => console.error('[PPT Compress] dispose error:', error) });
  const levelSelect = enhanceToolSelect(level);
  lifecycle.use(() => levelSelect?.dispose());
  refreshIcons();
  let session = null;
  const guard = createOperationGuard(() => session);
  let plasma = null;
  let busy = false;
  let file = null;
  let inputBytes = null;
  let analysis = null;
  let lastOutputPath = '';

  const text = (key, params) => t(`home.pptCompressPage.${key}`, params);
  const isOpen = owner => owner && owner === session && !owner.disposed && overlay.classList.contains('visible');
  const currentLevel = () => level?.value || 'medium';
  const usesImageCompression = () => ['medium', 'high'].includes(currentLevel());
  const levelLabel = () => level?.selectedOptions?.[0]?.textContent?.trim() || currentLevel();
  const savingText = value => !value || value.saved_bytes <= 0 ? text('statOptimized') : `${formatSize(value.saved_bytes)} · ${Math.round((value.saving_ratio || 0) * 1000) / 10}%`;
  const setProgress = (percent, message, visible = true) => {
    if (progressFill) progressFill.style.width = `${Math.max(0, Math.min(100, percent))}%`;
    if (processText) processText.textContent = message || text('processing');
    setInteractiveLayer(processMask, visible);
  };
  const hideProgressSoon = owner => {
    if (isOpen(owner) && !busy) setProgress(0, text('processing'), false);
  };

  function renderStats() {
    if (!analysis || !stats) return;
    stats.replaceChildren();
    const ops = analysis.operations || {};
    const entries = [
      [text('statOriginal'), formatSize(analysis.original_bytes), text('statLevel', { level: levelLabel() })],
      [text('statCompressed'), formatSize(analysis.compressed_bytes), analysis.used_original_bytes ? text('statOptimized') : formatSize(analysis.attempted_compressed_bytes)],
      [text('statSaved'), savingText(analysis), analysis.already_optimized ? text('statOptimized') : ''],
      [text('statCleaned'), String(analysis.removed_count || 0), text('cleanedDetail', { thumbnails: ops.removed_thumbnails || 0, unused: ops.removed_unused_media || 0, duplicates: ops.deduplicated_media || 0, printer: ops.removed_printer_settings || 0 })],
      [text('statImages'), String(ops.compressed_images || 0), text('imageDetail', { before: formatSize(ops.image_input_bytes || 0), after: formatSize(ops.image_output_bytes || 0), skipped: ops.skipped_images || 0 })]
    ];
    entries.forEach(([label, value, hint]) => {
      const stat = createElement(documentRef, 'div', 'ppt-compress-stat');
      stat.append(createElement(documentRef, 'span', '', label), createElement(documentRef, 'strong', '', value), createElement(documentRef, 'em', '', hint || ''));
      stats.append(stat);
    });
    if (summary) {
      summary.replaceChildren(createElement(documentRef, 'span', '', text('summary', { slides: analysis.slide_count, media: analysis.media_count, original: formatSize(analysis.original_bytes) })), createElement(documentRef, 'strong', '', `${text('statSaved')}：${savingText(analysis)}`));
    }
  }

  function updateControls() {
    if (level) level.disabled = busy;
    levelSelect?.refresh();
    if (exportButton) {
      const canExport = Boolean(analysis && !busy);
      exportButton.disabled = !canExport;
      exportButton.hidden = !canExport;
    }
  }

  function resetState() {
    guard.cancel();
    file = null; inputBytes = null; analysis = null; lastOutputPath = ''; busy = false;
    if (input) input.value = '';
    if (fileName) { fileName.textContent = ''; fileName.classList.remove('visible'); }
    const label = cta?.querySelector('span'); if (label) label.textContent = text('cta');
    if (cta) cta.disabled = false;
    if (empty) empty.hidden = false;
    if (results) results.hidden = true;
    summary?.replaceChildren(); stats?.replaceChildren();
    if (level) level.value = 'medium';
    dropZone?.classList.remove('visible');
    if (exportButton) { exportButton.disabled = true; exportButton.hidden = true; }
    scrollTop?.classList.remove('visible'); if (workspace) workspace.scrollTop = 0;
    setInteractiveLayer(successOverlay, false);
    setProgress(0, text('processing'), false);
    updateControls();
  }

  function open() {
    session?.dispose();
    session = createLifecycleScope({ onError: error => console.error('[PPT Compress] session cleanup:', error) });
    resetState();
    overlay.classList.add('visible'); overlay.setAttribute('aria-hidden', 'false');
    if (workspace) workspace.scrollTop = 0;
    plasma = initStandardToolPlasma(byId('pptCompressPlasmaBg'));
    if (isTauri) void registerNativePptxDrop({ owner: session, isCurrent: () => isOpen(session), onVisibility: visible => { if (!busy) dropZone?.classList.toggle('visible', visible); }, onUnsupported: () => notify(text('unsupportedFormat')), onDrop: handleFile }).catch(error => console.error('[PPT Compress] drag registration failed:', error));
  }

  function close() {
    levelSelect?.close();
    guard.cancel(); session?.dispose(); session = null; busy = false;
    setInteractiveLayer(successOverlay, false); setInteractiveLayer(processMask, false);
    overlay.classList.remove('visible'); overlay.setAttribute('aria-hidden', 'true');
    plasma = disposeStandardToolPlasma(plasma); resetState();
  }

  async function analyze(operation, silent = false) {
    if (!inputBytes || !file) return;
    if (!silent) setProgress(36, usesImageCompression() ? text('compressingImages') : text('analyzing'));
    try {
      const result = await compressPptxBytes(inputBytes, { sourceName: file.name || file.path || 'presentation.pptx', level: currentLevel(), signal: operation.signal, imageCompressor: task => compressPptImageForBrowser(task, operation.signal) });
      guard.assertCurrent(operation);
      analysis = result;
      if (fileName) { fileName.textContent = `${file.name || file.path || 'presentation.pptx'} · ${text('summary', { slides: result.slide_count, media: result.media_count, original: formatSize(result.original_bytes) })}`; fileName.classList.add('visible'); }
      if (empty) empty.hidden = true; if (results) results.hidden = false;
      renderStats();
      if (!silent) { setProgress(100, text('analyzing')); notify(text('scanDone', { saved: savingText(result) })); }
      return result;
    } catch (error) {
      if (!guard.isCurrent(operation)) return null;
      console.error('[PPT Compress] analysis failed:', error); setProgress(0, text('processing'), false);
      const message = String(error?.userMessage || error?.message || error); notify(message.includes('invalid_extension') ? text('unsupportedFormat') : message, { kind: 'error' }); return null;
    }
  }

  async function handleFile(nextFile) {
    if (!nextFile || busy || !isOpen(session)) return;
    if (!isPptxFile(nextFile)) { notify(text('unsupportedFormat')); return; }
    const owner = session;
    const operation = guard.begin(); if (!operation) return;
    operation.scope = createLifecycleScope(); operation.signal = operation.scope.abortController().signal;
    busy = true; updateControls(); setProgress(12, text('reading'));
    try {
      const bytes = await readPptxFile(nextFile, { isTauri, maxBytes: PPT_COMPRESS_LIMITS.maxInputBytes, errorPrefix: 'ppt-compress' });
      guard.assertCurrent(operation); file = nextFile; inputBytes = bytes; const label = cta?.querySelector('span'); if (label) label.textContent = text('replace');
      await analyze(operation);
    } catch (error) {
      if (guard.isCurrent(operation)) {
        const message = String(error?.userMessage || error?.message || error);
        notify(message.includes('invalid_extension') ? text('unsupportedFormat') : message, { kind: 'error' });
      }
    } finally {
      if (!guard.isCurrent(operation)) return;
      busy = false; guard.finish(operation); updateControls(); hideProgressSoon(owner);
    }
  }

  async function exportResult() {
    if (!file || !inputBytes || busy) return;
    const operation = guard.begin(); if (!operation) return;
    operation.scope = createLifecycleScope(); operation.signal = operation.scope.abortController().signal;
    const owner = operation.session;
    busy = true; updateControls(); setProgress(18, usesImageCompression() ? text('compressingImages') : text('compressing'));
    try {
      const result = analysis?.level === currentLevel() ? analysis : await compressPptxBytes(inputBytes, { sourceName: file.name || file.path || 'presentation.pptx', level: currentLevel(), signal: operation.signal, imageCompressor: task => compressPptImageForBrowser(task, operation.signal) });
      guard.assertCurrent(operation);
      analysis = result; renderStats();
      const baseName = sanitizePptCompressBaseName(file.name || file.path || 'presentation.pptx');
      const outputDir = await uniqueOutputDirectory({ getOutputDir, isTauri, category: 'PPT_Compress', baseName: `${baseName}_ppt_compress` });
      const outputFile = `${baseName}_compressed.pptx`;
      const publicResult = { ...createPptCompressManifest(result), input: { name: file.name || result.source_name, path: file.path || null }, output_file: outputFile, output_dir: outputDir };
      setProgress(76, text('writing'));
      if (isTauri) {
        const { invoke } = await tauriCorePromise;
        const outputPath = await writeUniqueFile(invoke, outputDir, outputFile, result.bytes);
        publicResult.output_path = outputPath; publicResult.manifest_path = joinOutput(outputDir, 'manifest.json');
        await writeUniqueFile(invoke, outputDir, 'manifest.json', new TextEncoder().encode(JSON.stringify(publicResult, null, 2)));
      } else {
        const JSZip = (await import('jszip')).default; const zip = new JSZip(); const downloadName = `${baseName}_ppt_compress.zip`; zip.file(outputFile, result.bytes); zip.file('manifest.json', JSON.stringify(publicResult, null, 2));
        const blob = await zip.generateAsync({ type: 'blob' }); guard.assertCurrent(operation); const url = URL.createObjectURL(blob); const anchor = createElement(documentRef, 'a'); anchor.href = url; anchor.download = downloadName; anchor.hidden = true; documentRef.body.append(anchor); anchor.click(); anchor.remove(); retainBrowserObjectUrl(owner, url);
      }
      guard.assertCurrent(operation); lastOutputPath = outputDir;
      if (successMeta) successMeta.textContent = result.already_optimized ? text('successOptimizedMeta') : text('successMeta');
      if (successOriginal) successOriginal.textContent = formatSize(result.original_bytes); if (successCompressed) successCompressed.textContent = formatSize(result.compressed_bytes); if (successSaved) successSaved.textContent = savingText(result); if (successPath) successPath.textContent = displayFilesystemPath(outputDir);
      setInteractiveLayer(successOverlay, true); setProgress(100, text('writing')); notify(text('exportDone', { saved: savingText(result) }));
    } catch (error) { if (guard.isCurrent(operation)) { console.error('[PPT Compress] export failed:', error); notify(String(error?.userMessage || error?.message || error), { kind: 'error' }); } }
    finally { if (!guard.isCurrent(operation)) return; busy = false; guard.finish(operation); setProgress(0, text('processing'), false); updateControls(); }
  }

  async function compressPptImageForBrowser(task, signal) {
    if (signal?.aborted) throw new Error('ppt-compress:cancelled');
    const extension = String(task?.extension || '').toLowerCase(); const mime = extension === 'png' ? 'image/png' : ['jpg', 'jpeg'].includes(extension) ? 'image/jpeg' : '';
    if (!mime) return null;
    const blob = new Blob([task.bytes], { type: mime }); let decoded; let objectUrl = ''; let canvas = null;
    try {
      if ('createImageBitmap' in window) { try { decoded = await createImageBitmap(blob); } catch { decoded = null; } }
      if (!decoded) {
        objectUrl = URL.createObjectURL(blob); const image = new Image(); decoded = await new Promise((resolve, reject) => { const abort = () => { image.src = ''; reject(new Error('ppt-compress:cancelled')); }; signal?.addEventListener('abort', abort, { once: true }); image.onload = () => { signal?.removeEventListener('abort', abort); resolve(image); }; image.onerror = () => { signal?.removeEventListener('abort', abort); reject(new Error('Cannot decode PPT image.')); }; image.src = objectUrl; });
      }
      if (signal?.aborted) throw new Error('ppt-compress:cancelled');
      const sourceWidth = Math.max(1, decoded.width || decoded.naturalWidth || 1); const sourceHeight = Math.max(1, decoded.height || decoded.naturalHeight || 1); const scale = Math.min(1, Math.max(600, Number(task.maxDimension) || 2200) / Math.max(sourceWidth, sourceHeight)); const width = Math.max(1, Math.round(sourceWidth * scale)); const height = Math.max(1, Math.round(sourceHeight * scale));
      canvas = documentRef.createElement('canvas'); canvas.width = width; canvas.height = height; const context = canvas.getContext('2d', { alpha: true, willReadFrequently: extension === 'png' }); if (!context) return null; context.drawImage(decoded, 0, 0, width, height);
      let outputExtension = extension === 'jpeg' ? 'jpg' : extension; let outputMime = mime;
      if (extension === 'png' && task.allowPngToJpeg) { const sample = documentRef.createElement('canvas'); sample.width = Math.min(160, width); sample.height = Math.min(160, height); const sampleContext = sample.getContext('2d', { willReadFrequently: true }); let alpha = true; if (sampleContext) { sampleContext.drawImage(canvas, 0, 0, sample.width, sample.height); const pixels = sampleContext.getImageData(0, 0, sample.width, sample.height).data; alpha = Array.from({ length: Math.floor(pixels.length / 4) }, (_, index) => pixels[index * 4 + 3]).some(value => value < 250); } sample.width = 0; sample.height = 0; if (!alpha) { outputExtension = 'jpg'; outputMime = 'image/jpeg'; } }
      if (outputMime === 'image/jpeg') { context.globalCompositeOperation = 'destination-over'; context.fillStyle = '#ffffff'; context.fillRect(0, 0, width, height); context.globalCompositeOperation = 'source-over'; }
      const output = await new Promise(resolve => canvas.toBlob(resolve, outputMime, Math.max(0.45, Math.min(0.95, Number(task.quality) || 0.82)))); if (!output || signal?.aborted) throw new Error('ppt-compress:cancelled'); return { bytes: new Uint8Array(await output.arrayBuffer()), extension: outputExtension, width, height };
    } finally { decoded?.close?.(); if (objectUrl) URL.revokeObjectURL(objectUrl); if (canvas) { canvas.width = 0; canvas.height = 0; } }
  }

  function joinOutput(directory, name) { const root = String(directory || '').replace(/[\\/]+$/, ''); return `${root}${root.includes('\\') ? '\\' : '/'}${name}`; }

  lifecycle.event(overlay, 'dragover', event => { if (dragHasExternalFiles(event)) { event.preventDefault(); if (!busy) dropZone?.classList.add('visible'); } });
  lifecycle.event(overlay, 'dragleave', event => { if (event.target === overlay) dropZone?.classList.remove('visible'); });
  lifecycle.event(overlay, 'drop', event => { if (!dragHasExternalFiles(event)) return; event.preventDefault(); dropZone?.classList.remove('visible'); const dropped = Array.from(event.dataTransfer?.files || []).find(isPptxFile); if (dropped) void handleFile(dropped); else notify(text('unsupportedFormat')); });
  bindPptChrome(lifecycle, overlay, { onClose: close, openSettings, openSupport, openExternalUrl, handleWindowAction });
  lifecycle.event(cta, 'click', () => { if (!busy) void choosePptxFile({ isTauri, input, onSelected: handleFile, onError: error => notify(String(error?.message || error)) }); });
  lifecycle.event(input, 'change', event => { const selected = event.target.files?.[0]; if (selected) void handleFile(selected); });
  lifecycle.event(level, 'change', () => { if (!inputBytes || busy) return; const owner = session; const operation = guard.begin(); if (!operation) return; operation.scope = createLifecycleScope(); operation.signal = operation.scope.abortController().signal; busy = true; updateControls(); setProgress(16, usesImageCompression() ? text('compressingImages') : text('analyzing')); void analyze(operation).finally(() => { if (!guard.isCurrent(operation)) return; busy = false; guard.finish(operation); updateControls(); hideProgressSoon(owner); }); });
  lifecycle.event(documentRef, 'keydown', event => {
    if (event.defaultPrevented || event.key !== 'Escape' || !isOpen(session)) return;
    if (!overlay.querySelector('.tool-custom-select.is-open')) return;
    event.preventDefault();
    levelSelect?.close({ restoreFocus: true });
  });
  lifecycle.event(exportButton, 'click', () => { void exportResult(); });
  lifecycle.event(workspace, 'scroll', () => scrollTop?.classList.toggle('visible', workspace.scrollTop > 160), { passive: true });
  lifecycle.event(scrollTop, 'click', () => workspace?.scrollTo({ top: 0, behavior: 'smooth' }));
  lifecycle.event(successOk, 'click', () => setInteractiveLayer(successOverlay, false));
  lifecycle.event(successOpenFolder, 'click', async () => { if (isTauri && lastOutputPath) await openOutputFolder(lastOutputPath); });
  lifecycle.use(onLangChange(() => { if (!isOpen(session)) return; applyTranslations(); levelSelect?.refresh(); if (analysis && fileName && file) fileName.textContent = `${file.name || file.path || 'presentation.pptx'} · ${text('summary', { slides: analysis.slide_count, media: analysis.media_count, original: formatSize(analysis.original_bytes) })}`; renderStats(); }));

  return { open, close, dispose() { close(); lifecycle.dispose(); }, get busy() { return busy; } };
}
