import { applyTranslations, getLang, onLangChange, t } from '../../i18n.js';
import { createLifecycleScope } from '../../app/tool-lifecycle.js';
import { loadTauriDialog, loadTauriWebview, tauriCorePromise } from '../../platform/tauri-runtime.js';
import { bindToolPageChrome, moveFocusOutOfHiddenRegion } from '../../shared/tool-page-shell.js';
import { conversionError, isPdfFile, isVisionModelConfigured, normalizeBytes, PDF_AI_MARKDOWN_LIMITS, sourceName } from './core.js';
import { serializeAiMarkdown, serializeAiPage } from './markdown-serializer.js';
import { analyzePdfPages } from './pipeline.js';
import { loadAiPdf, renderPageAsDataUrl } from './page-renderer.js';

const ERRORS = { 'file-too-large': 'fileTooLarge', 'too-many-pages': 'tooManyPages', 'password-protected': 'passwordProtected', 'all-pages-failed': 'allPagesFailed', 'invalid-response': 'invalidModelResponse', 'page-too-large': 'truncatedResponse', response_truncated: 'truncatedResponse', timeout: 'requestTimeout', provider_changed: 'providerChanged', invalid_config: 'modelPending', invalid_request: 'visionError' };
function visibility(element, visible) {
  if (!visible) moveFocusOutOfHiddenRegion(element);
  element.hidden = !visible;
  element.classList.toggle('visible', visible);
  element.setAttribute('aria-hidden', String(!visible));
  element.inert = !visible;
}

export function createPdfAiMarkdownController({
  overlay, isTauri = false, notify = () => {}, openLazyTool,
  refreshIcons = () => {}, formatFileSize = value => `${(value / 1024 / 1024).toFixed(2)} MB`, requestAi,
  getAiApiKey = async () => '', getAiPlatformConfig = () => ({}), requestAiKeyConfiguration,
  initStandardToolPlasma = () => null, disposeStandardToolPlasma = () => {}
} = {}) {
  if (!overlay) throw conversionError('missing-overlay');
  const query = suffix => overlay.querySelector(`#pdfAiMarkdown${suffix}`);
  const lifecycle = createLifecycleScope();
  let session = null;
  let operation = null;
  let disposed = false;
  let returnFocus = null;
  let selectedFile = null;
  let pdf = null;
  let state = 'empty';
  let statusKey = 'emptyDesc';
  let warningKey = '';
  let pages = [];
  let result = null;
  let lastProvider = null;
  let selectedPage = 0;
  let progress = { current: 0, total: 0, phase: '', page: 0 };

  const localize = (key, vars = {}) => t(`home.pdfAiMarkdown.${key}`, vars);
  const isOpen = owner => owner && owner === session && !owner.disposed && !disposed;
  const current = owner => owner === operation && isOpen(owner.session) && !owner.signal.aborted;
  const busy = () => state === 'processing' || state === 'loading';
  const setState = (next, message = `${next}Desc`) => { state = next; statusKey = message; };
  const showToast = key => notify(localize(key), { duration: 7000, dismissible: true });

  function cancelOperation() {
    const previous = operation;
    operation = null;
    previous?.scope.dispose();
  }
  function beginOperation() {
    cancelOperation();
    const scope = createLifecycleScope();
    operation = { scope, session, signal: scope.abortController().signal };
    return operation;
  }
  function releasePdf() { pdf?.destroy(); pdf = null; selectedFile = null; lastProvider = null; }
  function labels() {
    return Object.fromEntries(['contents', 'overview', 'image', 'formula', 'note', 'column', 'failed', 'blank', 'source'].map(key => [key, localize(`md.${key}`)]));
  }
  function renderProgress() {
    query('ProgressFill').style.width = `${progress.total ? Math.round(progress.current / progress.total * 100) : 0}%`;
    query('ProgressText').textContent = localize('progressText', progress);
    query('ProgressDetail').textContent = progress.phase ? localize(progress.phase, progress) : '';
    query('ProcessedPages').textContent = `${progress.current} / ${progress.total}`;
    query('BlockCount').textContent = pages.reduce((sum, page) => sum + (page?.blocks?.length || 0), 0).toLocaleString();
    query('SourceType').textContent = localize(selectedFile ? 'sourceVision' : 'sourcePending');
  }
  function renderResult() {
    const visible = Boolean(result && ['success', 'partial'].includes(state));
    query('Result').hidden = !visible;
    if (!visible) { query('PageTabs').replaceChildren(); query('Preview').textContent = ''; return; }
    query('ResultSummary').textContent = result.summary?.summary || localize('resultSummary', { pages: pages.filter(page => !page.failed).length });
    query('PageTabs').replaceChildren();
    for (const [index, page] of pages.entries()) {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.previewPage = String(index);
      button.setAttribute('aria-pressed', String(index === selectedPage));
      button.textContent = localize(page.failed ? 'previewFailedPage' : 'previewPage', { page: page.pageNumber });
      query('PageTabs').append(button);
    }
    const markdown = pages[selectedPage] ? serializeAiPage(pages[selectedPage], labels()) : '';
    query('Preview').textContent = markdown.slice(0, 3000) + (markdown.length > 3000 ? '\n…' : '');
    query('Retry').hidden = !pages.some(page => page.failed) && !result.summaryFailed;
    query('Retry').querySelector('span').textContent = localize(pages.some(page => page.failed) ? 'retry' : 'retrySummary');
  }
  function render() {
    overlay.dataset.state = state;
    overlay.dataset.hasFile = String(Boolean(selectedFile));
    query('StatusTitle').textContent = localize(`${state}Title`);
    query('StatusBadge').textContent = localize(`${state}Badge`);
    query('StatusBadge').dataset.state = state;
    query('StatusMessage').textContent = localize(statusKey);
    query('FileCard').hidden = !selectedFile;
    query('FileName').textContent = sourceName(selectedFile);
    query('FileSize').textContent = selectedFile ? formatFileSize(selectedFile.size) : '';
    query('PageCount').textContent = String(pdf?.document.numPages || '-');
    const config = state === 'processing' || result ? lastProvider || getAiPlatformConfig() : getAiPlatformConfig();
    query('Model').textContent = config?.model || localize('modelPending');
    let endpoint = '';
    try { endpoint = new URL(config.url).origin; } catch { /* Incomplete settings remain visible as a prompt. */ }
    query('Provider').textContent = endpoint || localize('modelPending');
    query('Warning').hidden = !warningKey;
    query('WarningText').textContent = warningKey ? localize(warningKey) : '';
    query('ProgressWrap').hidden = state !== 'processing';
    query('Remove').disabled = busy();
    query('Cta').disabled = busy();
    query('Process').disabled = state === 'loading' || !pdf;
    query('Process').classList.toggle('is-cancel', state === 'processing');
    query('ProcessIcon').hidden = state === 'processing';
    query('CancelIcon').hidden = state !== 'processing';
    query('ProcessLabel').textContent = localize(state === 'processing' ? 'cancel' : 'process');
    renderProgress(); renderResult(); refreshIcons();
  }

  async function inspectFile(file) {
    if (!isOpen(session) || busy()) return;
    if (!isPdfFile(file)) { showToast('unsupportedFile'); return; }
    if (file.size > PDF_AI_MARKDOWN_LIMITS.maxDocumentBytes) { showToast('fileTooLarge'); return; }
    const owner = beginOperation();
    releasePdf(); pages = []; result = null; warningKey = ''; selectedPage = 0;
    selectedFile = { name: sourceName(file), size: file.size || 0 };
    setState('loading'); render();
    try {
      const bytes = normalizeBytes(isTauri && file.path
        ? await (await tauriCorePromise).invoke('read_file_bytes_limited', { path: file.path, maxBytes: PDF_AI_MARKDOWN_LIMITS.maxDocumentBytes })
        : await file.arrayBuffer());
      if (!current(owner)) return;
      if (bytes.byteLength > PDF_AI_MARKDOWN_LIMITS.maxDocumentBytes) throw conversionError('file-too-large');
      selectedFile.size = bytes.byteLength;
      const loaded = await loadAiPdf(bytes, owner.signal);
      if (!current(owner)) { loaded.destroy(); return; }
      pdf = loaded;
      if (pdf.document.numPages > PDF_AI_MARKDOWN_LIMITS.maxPages) throw conversionError('too-many-pages');
      progress = { current: 0, total: pdf.document.numPages, phase: '', page: 0 };
      setState('selected');
    } catch (error) {
      if (!current(owner)) return;
      releasePdf(); setState('error', ERRORS[error.code] || 'invalidPdf');
    } finally {
      if (current(owner)) { operation = null; owner.scope.dispose(); render(); }
    }
  }

  async function requestFile() {
    if (busy()) return;
    if (!isTauri) { query('FileInput').click(); return; }
    const owner = session;
    try {
      const { open: dialog } = await loadTauriDialog();
      if (!isOpen(owner)) return;
      const path = await dialog({ multiple: false, filters: [{ name: 'PDF', extensions: ['pdf'] }] });
      if (isOpen(owner) && typeof path === 'string') await inspectFile({ path, name: sourceName({ path }), size: 0 });
    } catch { if (isOpen(owner)) showToast('readFailed'); }
  }

  function partialResult() {
    if (!pages.some(page => page && !page.failed)) return null;
    pages = Array.from({ length: pdf.document.numPages }, (_, index) => pages[index] || { pageNumber: index + 1, failed: true, blocks: [], warnings: [] });
    return { pages, summary: {}, summaryFailed: true };
  }
  async function run() {
    if (!isOpen(session) || !pdf || busy()) return;
    const owner = beginOperation();
    const provider = { ...getAiPlatformConfig() };
    lastProvider = provider;
    setState('processing'); warningKey = ''; render();
    try {
      const key = await getAiApiKey();
      if (!current(owner)) return;
      if (!key || !isVisionModelConfigured(getAiPlatformConfig())) {
        setState(result ? 'partial' : 'selected');
        warningKey = 'noApiKey';
        requestAiKeyConfiguration?.();
        return;
      }
      const handle = pdf.document;
      const converted = await analyzePdfPages({ totalPages: handle.numPages, previousPages: pages,
        renderPage: (number, signal) => renderPageAsDataUrl(handle, number, signal),
        requestAi: (messages, signal, tokens, options) => requestAi(messages, signal, tokens, { ...options, expectedProvider: provider }),
        signal: owner.signal, language: getLang() === 'zh' ? 'zh-CN' : 'en',
        onProgress: snapshot => { if (current(owner)) { pages = snapshot.pages; progress = snapshot; renderProgress(); } }
      });
      if (!current(owner)) return;
      pages = converted.pages; result = converted;
      warningKey = converted.summaryFailed ? 'summaryFailed' : pages.some(page => page.failed || page.warnings.length) ? 'reviewWarning' : '';
      setState(warningKey ? 'partial' : 'success');
    } catch (error) {
      if (!current(owner)) return;
      result = partialResult();
      setState(result ? 'partial' : 'error');
      warningKey = error.code === 'http_error' ? ([400, 404, 413, 415, 422].includes(error.status) ? 'visionError' : [401, 402, 403].includes(error.status) ? 'authError' : error.status === 429 ? 'rateLimited' : 'processError') : ERRORS[error.code] || 'processError';
    } finally {
      if (current(owner)) { operation = null; owner.scope.dispose(); render(); }
    }
  }
  function cancel() {
    cancelOperation();
    if (state === 'loading') { reset(); return; }
    result = partialResult();
    setState(result ? 'partial' : 'selected', 'cancelledDesc');
    warningKey = ''; render();
  }
  function reset() {
    cancelOperation(); releasePdf(); pages = []; result = null; warningKey = ''; selectedPage = 0;
    progress = { current: 0, total: 0, phase: '', page: 0 };
    setState('empty'); query('FileInput').value = ''; render();
    if (isOpen(session)) query('Cta').focus({ preventScroll: true });
  }
  async function importMarkdown() {
    if (!result || !['success', 'partial'].includes(state)) return;
    const name = sourceName(selectedFile);
    const markdown = serializeAiMarkdown({ fileName: name, ...result, labels: labels() });
    try {
      const instance = await openLazyTool?.('markdown-editor');
      const importer = instance?.raw?.importMarkdown || instance?.importMarkdown;
      if (typeof importer !== 'function' || !importer(markdown, name)) showToast('importUnavailable');
    } catch { showToast('importUnavailable'); }
  }
  function setDropVisible(visible) {
    query('DropZone').classList.toggle('visible', visible);
    overlay.classList.toggle('drag-over', visible);
  }
  async function nativeDrop(owner) {
    if (!isTauri) return;
    try {
      const { getCurrentWebview } = await loadTauriWebview();
      if (!isOpen(owner)) return;
      const unlisten = await getCurrentWebview().onDragDropEvent(event => {
        if (!isOpen(owner) || busy()) return;
        const payload = event.payload;
        setDropVisible(['enter', 'over'].includes(payload?.type));
        if (payload?.type !== 'drop') return;
        if (payload.paths?.length !== 1) { showToast('singleFileOnly'); return; }
        void inspectFile({ path: payload.paths[0], name: sourceName({ path: payload.paths[0] }), size: 0 });
      });
      owner.use(unlisten);
    } catch { /* File selection remains available when native drag/drop is unavailable. */ }
  }
  function open() {
    if (disposed || session) return;
    returnFocus = document.activeElement;
    session = createLifecycleScope();
    visibility(overlay, true); reset();
    const background = initStandardToolPlasma(overlay.querySelector('.pdf-merge-v2-bg'));
    const owner = session;
    owner.use(() => disposeStandardToolPlasma(background));
    void nativeDrop(owner);
  }
  function close({ restoreFocus = true } = {}) {
    cancelOperation(); session?.dispose(); session = null; releasePdf(); pages = []; result = null;
    query('PageTabs').replaceChildren(); query('Preview').textContent = ''; query('FileInput').value = '';
    setDropVisible(false); visibility(overlay, false);
    if (restoreFocus && returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
    returnFocus = null;
    return true;
  }
  function dispose() { if (disposed) return; close({ restoreFocus: false }); disposed = true; lifecycle.dispose(); }

  lifecycle.use(bindToolPageChrome(overlay.querySelector('.tool-page-v2-topbar'), close));
  lifecycle.use(onLangChange(() => { applyTranslations(overlay); render(); }));
  lifecycle.event(query('Cta'), 'click', () => { void requestFile(); });
  lifecycle.event(query('Remove'), 'click', reset);
  lifecycle.event(query('Reset'), 'click', reset);
  lifecycle.event(query('Import'), 'click', () => { void importMarkdown(); });
  lifecycle.event(query('Retry'), 'click', () => { void run(); });
  lifecycle.event(query('Process'), 'click', () => { if (state === 'processing') cancel(); else void run(); });
  lifecycle.event(query('FileInput'), 'change', event => {
    const file = event.target.files?.[0]; event.target.value = '';
    if (file) void inspectFile(file);
  });
  lifecycle.event(query('PageTabs'), 'click', event => {
    const button = event.target.closest('[data-preview-page]');
    if (!button) return;
    selectedPage = Number(button.dataset.previewPage); renderResult(); query('Preview').scrollTop = 0;
  });
  for (const type of ['dragenter', 'dragover']) lifecycle.event(overlay, type, event => { event.preventDefault(); if (!busy()) setDropVisible(true); });
  lifecycle.event(overlay, 'dragleave', event => { if (!event.relatedTarget || !overlay.contains(event.relatedTarget)) setDropVisible(false); });
  lifecycle.event(overlay, 'drop', event => {
    event.preventDefault(); setDropVisible(false);
    if (isTauri || busy() || !isOpen(session)) return;
    if (event.dataTransfer?.files?.length !== 1) { showToast('singleFileOnly'); return; }
    void inspectFile(event.dataTransfer.files[0]);
  });
  lifecycle.event(document, 'keydown', event => {
    if (event.key !== 'Escape' || !isOpen(session) || event.defaultPrevented) return;
    event.preventDefault(); if (busy()) cancel(); else close();
  });
  lifecycle.event(window, 'pagehide', dispose);
  visibility(overlay, false); render();
  return { open, close, dispose };
}
