import { createLifecycleScope } from '../../app/tool-lifecycle.js';
import { applyTranslations, getLang } from '../../i18n.js';
import { tauriCorePromise } from '../../platform/tauri-runtime.js';
import {
  PPT_TEXT_EXTRACT_LIMITS,
  analyzePptxText,
  buildPptTextAiMessages,
  createPptTextJson,
  createPptTextMarkdown,
  createPptTextTxt,
  normalizePptTextAiMode,
  normalizePptTextFormat,
  normalizePptTextPageSelection,
  planPptTextExport,
  sanitizePptTextBaseName
} from '../../ppt-text-extract-core.js';
import { createOperationGuard, bindPptChrome, choosePptxFile, dragHasExternalFiles, isPptxFile, joinPath, readPptxFile, registerNativePptxDrop, retainBrowserObjectUrl, setInteractiveLayer, uniqueOutputDirectory, waitForScope, writeUniqueFile } from './shared.js';

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
}

function createElement(documentRef, tag, className, text) {
  const element = documentRef.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

export function createPptTextController({
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
  requestAi = async () => { throw new Error('AI request unavailable'); },
  refreshIcons = () => {},
  openSettings = () => {},
  openSupport = () => {},
  openExternalUrl = () => {},
  handleWindowAction = () => {},
  isDemo = false
} = {}) {
  if (!overlay) throw new Error('ppt-text:missing-overlay');
  if (typeof getOutputDir !== 'function') throw new Error('ppt-text:missing-output-directory');
  const documentRef = overlay.ownerDocument || document;
  const byId = id => documentRef.getElementById(id);
  const back = byId('pptTextBack');
  const background = byId('pptTextPlasmaBg');
  const dropZone = byId('pptTextDropZone');
  const input = byId('pptTextFileInput');
  const cta = byId('pptTextCta');
  const fileName = byId('pptTextFileName');
  const empty = byId('pptTextEmpty');
  const results = byId('pptTextResults');
  const summary = byId('pptTextSummary');
  const pageFilter = byId('pptTextPageFilter');
  const format = byId('pptTextFormat');
  const aiMode = byId('pptTextAiMode');
  const exportButton = byId('pptTextExportBtn');
  const list = byId('pptTextList');
  const workspace = byId('pptTextScrollArea');
  const scrollTop = byId('pptTextScrollTop');
  const processMask = byId('pptTextProcessMask');
  const progressFill = byId('pptTextProcessBarFill');
  const processText = byId('pptTextProcessText');
  const successOverlay = byId('pptTextSuccessOverlay');
  const successMeta = byId('pptTextSuccessMeta');
  const successCount = byId('pptTextSuccessCount');
  const successPath = byId('pptTextSuccessPath');
  const successOpenFolder = byId('pptTextSuccessOpenFolder');
  const successOk = byId('pptTextSuccessOk');
  const lifecycle = createLifecycleScope({ onError: error => console.error('[PPT Text] dispose error:', error) });
  const guard = createOperationGuard(() => session);
  let session = null;
  let plasma = null;
  let busy = false;
  let manifest = null;
  let file = null;
  let lastOutputPath = '';
  let lastPresetPrompt = '';

  const text = (key, params) => t(`home.pptTextPage.${key}`, params);
  const isOpen = owner => owner && owner === session && !owner.disposed && overlay.classList.contains('visible');
  const setProgress = (percent, message, visible = true) => {
    if (progressFill) progressFill.style.width = `${Math.max(0, Math.min(100, percent))}%`;
    if (processText) processText.textContent = message || text('processing');
    setInteractiveLayer(processMask, visible);
  };
  const hideProgressSoon = owner => {
    if (isOpen(owner) && !busy) setProgress(0, text('processing'), false);
  };
  const setCtaLabel = key => { const label = cta?.querySelector('span'); if (label) label.textContent = text(key); };
  const summaryText = () => manifest ? text('summary', { slides: manifest.slide_count, chars: manifest.text_characters, notes: manifest.notes_slide_count, empty: manifest.empty_slide_count }) : '';
  const selectedSet = () => {
    if (!manifest || !pageFilter?.value.trim()) return null;
    try { return new Set(normalizePptTextPageSelection(pageFilter.value.trim(), manifest.slide_count)); } catch { return null; }
  };
  const exportPlan = () => manifest && planPptTextExport(manifest, { pages: pageFilter?.value.trim() || null, format: format?.value || 'markdown', ai_mode: aiMode?.value || 'none' });
  const pageFilterValid = () => {
    if (!manifest || !pageFilter?.value.trim()) return true;
    try { normalizePptTextPageSelection(pageFilter.value.trim(), manifest.slide_count); return true; } catch { return false; }
  };

  function renderSummary() {
    if (!summary || !manifest) return;
    summary.replaceChildren();
    summary.append(createElement(documentRef, 'span', '', summaryText()));
    const plan = pageFilterValid() ? exportPlan() : null;
    summary.append(createElement(documentRef, 'strong', '', text('selectedSummary', { selected: plan?.selected_count || 0, total: manifest.slide_count })));
  }

  function slidePreview(slide) {
    const parts = [];
    if (slide.body?.length) parts.push(slide.body.slice(0, 2).map(item => String(item).replace(/^ +/, '')).join(' / '));
    if (slide.notes?.length) parts.push(`${text('notesLabel')} ${String(slide.notes[0]).replace(/^ +/, '')}`);
    return parts.join(' · ') || text('noBody');
  }

  function renderDetail(slide) {
    const detail = createElement(documentRef, 'div', 'ppt-text-detail');
    const addBlock = (label, values, detailClass = 'ppt-text-detail-lines') => {
      const block = createElement(documentRef, 'div', 'ppt-text-detail-block');
      block.append(createElement(documentRef, 'h4', '', label));
      if (detailClass === 'ppt-text-detail-text') block.append(createElement(documentRef, 'p', detailClass, values));
      else {
        const lines = createElement(documentRef, 'div', detailClass);
        values.forEach(value => lines.append(createElement(documentRef, 'div', 'ppt-text-detail-line', value)));
        block.append(lines);
      }
      detail.append(block);
    };
    addBlock(text('titleLabel'), slide.title || text('untitled'), 'ppt-text-detail-text');
    if (slide.body?.length) addBlock(text('bodyLabel'), slide.body);
    if (slide.notes?.length) addBlock(text('notesLabel'), slide.notes);
    detail.hidden = true;
    return detail;
  }

  function renderList() {
    if (!list || !manifest) return;
    list.replaceChildren();
    const renderScope = createLifecycleScope();
    session?.use(() => renderScope.dispose());
    const selected = selectedSet();
    manifest.slides.forEach(slide => {
      const item = createElement(documentRef, 'article', 'ppt-text-item');
      item.dataset.page = String(slide.page);
      if (selected && !selected.has(slide.page)) item.classList.add('is-filtered-out');
      const toggle = createElement(documentRef, 'button', 'ppt-text-item-toggle');
      toggle.type = 'button';
      toggle.setAttribute('aria-expanded', 'false');
      const page = createElement(documentRef, 'span', 'ppt-text-page', String(slide.page));
      const content = createElement(documentRef, 'span', 'ppt-text-content');
      content.append(createElement(documentRef, 'strong', '', slide.title || text('untitled')), createElement(documentRef, 'span', 'ppt-text-preview', slidePreview(slide)));
      const meta = createElement(documentRef, 'span', 'ppt-text-meta');
      meta.append(createElement(documentRef, 'span', '', slide.has_notes ? text('hasNotes') : text('noNotes')), createElement(documentRef, 'em', '', text('charCount', { count: slide.text_characters })));
      const chevron = createElement(documentRef, 'i', 'ppt-text-chevron');
      chevron.dataset.lucide = 'chevron-down';
      toggle.append(page, content, meta, chevron);
      const detail = renderDetail(slide);
      renderScope.event(toggle, 'click', () => {
        const open = toggle.getAttribute('aria-expanded') === 'true';
        toggle.setAttribute('aria-expanded', String(!open));
        item.classList.toggle('is-open', !open);
        detail.hidden = open;
      });
      item.append(toggle, detail);
      list.append(item);
    });
    refreshIcons();
    renderSummary();
  }

  function updateControls() {
    if (!manifest) {
      if (exportButton) { exportButton.disabled = true; exportButton.hidden = true; }
      return;
    }
    const valid = pageFilterValid();
    pageFilter?.classList.toggle('is-invalid', !valid);
    const plan = valid ? exportPlan() : null;
    renderSummary();
    if (exportButton) {
      const canExport = !busy && Boolean(plan?.selected_count);
      exportButton.disabled = !canExport;
      exportButton.hidden = !canExport;
      exportButton.textContent = (aiMode?.value || 'none') === 'none' ? text('exportRaw') : text('exportAi');
    }
    const selected = selectedSet();
    list?.querySelectorAll('.ppt-text-item').forEach(item => item.classList.toggle('is-filtered-out', selected ? !selected.has(Number(item.dataset.page)) : false));
  }

  function resetState() {
    guard.cancel();
    manifest = null;
    file = null;
    lastOutputPath = '';
    busy = false;
    if (input) input.value = '';
    if (fileName) { fileName.textContent = ''; fileName.classList.remove('visible'); }
    setCtaLabel('cta');
    if (cta) cta.disabled = false;
    if (empty) empty.hidden = false;
    if (results) results.hidden = true;
    if (summary) summary.replaceChildren();
    if (pageFilter) { pageFilter.value = ''; pageFilter.classList.remove('is-invalid'); }
    if (format) format.value = 'markdown';
    if (aiMode) aiMode.value = 'none';
    list?.replaceChildren();
    dropZone?.classList.remove('visible');
    if (exportButton) { exportButton.disabled = true; exportButton.hidden = true; }
    scrollTop?.classList.remove('visible');
    if (workspace) workspace.scrollTop = 0;
    setInteractiveLayer(successOverlay, false);
    setProgress(0, text('processing'), false);
  }

  function open() {
    if (!overlay) return;
    session?.dispose();
    session = createLifecycleScope({ onError: error => console.error('[PPT Text] session cleanup:', error) });
    resetState();
    overlay.classList.add('visible');
    overlay.setAttribute('aria-hidden', 'false');
    if (workspace) workspace.scrollTop = 0;
    if (background) plasma = initStandardToolPlasma(background);
    if (isTauri) void registerNativePptxDrop({
      owner: session,
      isCurrent: () => isOpen(session),
      onVisibility: visible => { if (!busy) dropZone?.classList.toggle('visible', visible); },
      onUnsupported: () => notify(text('unsupportedFormat')),
      onDrop: handleFile
    }).catch(error => console.error('[PPT Text] drag registration failed:', error));
  }

  function close() {
    guard.cancel();
    session?.dispose();
    session = null;
    busy = false;
    setInteractiveLayer(successOverlay, false);
    setInteractiveLayer(processMask, false);
    overlay.classList.remove('visible');
    overlay.setAttribute('aria-hidden', 'true');
    plasma = disposeStandardToolPlasma(plasma);
    resetState();
  }

  async function handleFile(nextFile) {
    if (!nextFile || busy || !isOpen(session)) return;
    if (!isPptxFile(nextFile)) { notify(text('unsupportedFormat')); return; }
    const owner = session;
    const operation = guard.begin();
    if (!operation) return;
    const operationScope = createLifecycleScope();
    operation.signal = operationScope.abortController().signal;
    guard.attachScope(operation, operationScope);
    busy = true;
    setProgress(12, text('reading'));
    try {
      const bytes = await readPptxFile(nextFile, { isTauri, maxBytes: PPT_TEXT_EXTRACT_LIMITS.maxInputBytes, errorPrefix: 'ppt-text-extract' });
      guard.assertCurrent(operation);
      setProgress(48, text('analyzing'));
      const nextManifest = await analyzePptxText(bytes, { sourceName: nextFile.name || nextFile.path || 'presentation.pptx', signal: operation.signal });
      guard.assertCurrent(operation);
      file = nextFile;
      manifest = nextManifest;
      if (fileName) { fileName.textContent = `${nextFile.name || nextFile.path || 'presentation.pptx'} · ${summaryText()}`; fileName.classList.add('visible'); }
      setCtaLabel('replace');
      if (empty) empty.hidden = true;
      if (results) results.hidden = false;
      renderList();
      setProgress(100, text('analyzing'));
      notify(text('scanDone', { slides: manifest.slide_count, chars: manifest.text_characters }));
    } catch (error) {
      if (!guard.isCurrent(operation)) return;
      console.error('[PPT Text] scan failed:', error);
      setProgress(0, text('processing'), false);
      const message = String(error?.userMessage || error?.message || error);
      notify(message.includes('invalid_extension') ? text('unsupportedFormat') : message, { kind: 'error' });
    } finally {
      if (!guard.isCurrent(operation)) return;
      busy = false;
      guard.finish(operation);
      updateControls();
      hideProgressSoon(owner);
    }
  }

  function formatsFor(value) { return value === 'all' ? ['markdown', 'txt', 'json'] : [value]; }
  function outputName(value) { return value === 'markdown' ? 'slides.md' : value === 'txt' ? 'slides.txt' : 'slides.json'; }
  function serialize(value, result) { return value === 'markdown' ? createPptTextMarkdown(result) : value === 'txt' ? createPptTextTxt(result) : createPptTextJson(result); }

  async function buildAiResult(baseResult, plan, operation) {
    const mode = normalizePptTextAiMode(plan.ai_mode);
    if (mode === 'none') return null;
    const locale = getLang() === 'en' ? 'en' : 'zh-CN';
    const { messages, source } = buildPptTextAiMessages({ ...baseResult, locale }, { ai_mode: mode, locale });
    const controller = operationScopeAbort(operation);
    const timeout = operation.scope.timeout(() => controller.abort(), 120000);
    try {
      const content = await requestAi(messages, controller.signal, 4096);
      guard.assertCurrent(operation);
      return { mode, content: String(content || '').trim(), source };
    } catch (error) {
      if (controller.signal.aborted) throw new Error(text('requestTimeout'));
      throw error;
    } finally { clearTimeout(timeout); }
  }

  function operationScopeAbort(operation) {
    return operation.scope.abortController();
  }

  async function exportResult() {
    if (!manifest || busy) return;
    if (!pageFilterValid()) { notify(text('invalidPageFilter', { count: manifest.slide_count })); updateControls(); return; }
    let plan;
    try { plan = exportPlan(); } catch (error) { notify(String(error?.userMessage || error?.message || error)); return; }
    const operation = guard.begin();
    if (!operation) return;
    const owner = session;
    operation.scope = createLifecycleScope();
    operation.signal = operation.scope.abortController().signal;
    const encoder = new TextEncoder();
    busy = true;
    setProgress(8, text('exporting'));
    try {
      const result = { ...manifest, input: { name: file?.name || manifest.source_name, path: file?.path || null }, selected_slides: plan.selected_slides, selected_count: plan.selected_count, selected_text_characters: plan.selected_text_characters, pages: plan.pages, format: normalizePptTextFormat(plan.format), ai_mode: normalizePptTextAiMode(plan.ai_mode), locale: getLang() === 'en' ? 'en' : 'zh-CN', outputs: [] };
      if (result.ai_mode !== 'none') { setProgress(44, text('aiOrganizing')); result.ai_result = await buildAiResult(result, plan, operation); }
      guard.assertCurrent(operation);
      const baseName = sanitizePptTextBaseName(file?.name || file?.path || manifest.source_name);
      const outputDir = await uniqueOutputDirectory({ getOutputDir, isTauri, category: 'PPT_Text', baseName: `${baseName}_ppt_text` });
      setProgress(76, text('writing'));
      if (isTauri) {
        const { invoke } = await tauriCorePromise;
        for (const value of formatsFor(result.format)) {
          guard.assertCurrent(operation);
          const name = outputName(value);
          const bytes = encoder.encode(serialize(value, { ...result, output_dir: outputDir }));
          const path = await writeUniqueFile(invoke, outputDir, name, bytes);
          result.outputs.push({ path, relative_path: name, format: value });
        }
        if (result.ai_result?.content) {
          const name = `ai-${result.ai_mode}.md`;
          const path = await writeUniqueFile(invoke, outputDir, name, encoder.encode(`${result.ai_result.content.trim()}\n`));
          result.outputs.push({ path, relative_path: name, format: 'markdown', kind: 'ai_result' });
        }
        await writeUniqueFile(invoke, outputDir, 'manifest.json', encoder.encode(JSON.stringify({ ...result, output_dir: outputDir }, null, 2)));
      } else {
        const JSZip = (await import('jszip')).default;
        const zip = new JSZip();
        for (const value of formatsFor(result.format)) { const name = outputName(value); zip.file(name, serialize(value, { ...result, output_dir: outputDir })); result.outputs.push({ relative_path: name, format: value }); }
        if (result.ai_result?.content) { const name = `ai-${result.ai_mode}.md`; zip.file(name, `${result.ai_result.content.trim()}\n`); result.outputs.push({ relative_path: name, format: 'markdown', kind: 'ai_result' }); }
        zip.file('manifest.json', JSON.stringify({ ...result, output_dir: outputDir }, null, 2));
        const blob = await zip.generateAsync({ type: 'blob' });
        guard.assertCurrent(operation);
        const url = URL.createObjectURL(blob);
        const anchor = createElement(documentRef, 'a'); anchor.href = url; anchor.download = `${baseName}_ppt_text.zip`; anchor.hidden = true; documentRef.body.append(anchor); anchor.click(); anchor.remove();
        retainBrowserObjectUrl(owner, url);
      }
      guard.assertCurrent(operation);
      result.output_dir = outputDir;
      lastOutputPath = outputDir;
      if (successMeta) successMeta.textContent = text('successMeta');
      if (successCount) successCount.textContent = String(result.outputs.length);
      if (successPath) successPath.textContent = displayFilesystemPath(outputDir);
      setInteractiveLayer(successOverlay, true);
      setProgress(100, text('writing'));
      notify(text('exportDone', { count: result.outputs.length }));
    } catch (error) {
      if (!guard.isCurrent(operation)) return;
      console.error('[PPT Text] export failed:', error);
      notify(String(error?.userMessage || error?.message || error), { kind: 'error' });
    } finally {
      if (!guard.isCurrent(operation)) return;
      busy = false;
      guard.finish(operation);
      setProgress(0, text('processing'), false);
      updateControls();
    }
  }

  lifecycle.event(overlay, 'dragover', event => { if (dragHasExternalFiles(event)) { event.preventDefault(); if (!busy) dropZone?.classList.add('visible'); } });
  lifecycle.event(overlay, 'dragleave', event => { if (event.target === overlay) dropZone?.classList.remove('visible'); });
  lifecycle.event(overlay, 'drop', event => { if (!dragHasExternalFiles(event)) return; event.preventDefault(); dropZone?.classList.remove('visible'); const dropped = Array.from(event.dataTransfer?.files || []).find(isPptxFile); if (dropped) void handleFile(dropped); else notify(text('unsupportedFormat')); });
  lifecycle.event(back, 'click', close);
  lifecycle.event(cta, 'click', () => { if (!busy) void choosePptxFile({ isTauri, input, onSelected: handleFile, onError: error => notify(String(error?.message || error)) }); });
  lifecycle.event(input, 'change', event => { const selected = event.target.files?.[0]; if (selected) void handleFile(selected); });
  lifecycle.event(pageFilter, 'input', updateControls);
  lifecycle.event(pageFilter, 'blur', () => { if (manifest && !pageFilterValid()) notify(text('invalidPageFilter', { count: manifest.slide_count })); });
  lifecycle.event(format, 'change', updateControls);
  lifecycle.event(aiMode, 'change', updateControls);
  lifecycle.event(exportButton, 'click', () => { void exportResult(); });
  lifecycle.event(workspace, 'scroll', () => scrollTop?.classList.toggle('visible', workspace.scrollTop > 160), { passive: true });
  lifecycle.event(scrollTop, 'click', () => workspace?.scrollTo({ top: 0, behavior: 'smooth' }));
  lifecycle.event(successOk, 'click', () => setInteractiveLayer(successOverlay, false));
  lifecycle.event(successOpenFolder, 'click', async () => { if (isTauri && lastOutputPath) await openOutputFolder(lastOutputPath); });
  bindPptChrome(lifecycle, overlay, { onClose: close, openSettings, openSupport, openExternalUrl, handleWindowAction });
  lifecycle.use(onLangChange(() => { if (!isOpen(session)) return; applyTranslations(); if (manifest) { if (fileName && file) fileName.textContent = `${file.name || file.path || 'presentation.pptx'} · ${summaryText()}`; renderList(); updateControls(); } }));

  return {
    open,
    close,
    dispose() { close(); lifecycle.dispose(); },
    get busy() { return busy; }
  };
}
