import { PDFDocument } from 'pdf-lib';
import {
  PDF_EDITOR_LIMITS,
  assertPdfEditorFile,
  assertPdfEditorMergeSelection,
  assertPdfEditorPageCount
} from '../../pdf-editor-core.js';
import { loadTauriDialog } from '../../platform/tauri-runtime.js';
import { PdfEditorCancelledError } from './errors.js';

/**
 * Owns PDF Editor file selection and document replacement/append sessions.
 * Loading is staged before replacement so a bad or cancelled file cannot
 * destroy the current editor document.
 */
export function createPdfEditorFileSession({
  isTauri = false,
  documentRef = globalThis.document,
  windowRef = globalThis.window,
  fileInput = null,
  appendInput = null,
  pageStrip = null,
  t = key => key,
  isDisposed = () => false,
  getActiveOperation = () => null,
  getIdCounter = () => 0,
  setIdCounter = () => {},
  getSources = () => [],
  setSources = () => {},
  getPages = () => [],
  setPages = () => {},
  setSourceStore = () => {},
  getSourceStore = () => new Map(),
  setCurrentId = () => {},
  setSelectedIds = () => {},
  setSelectionAnchorId = () => {},
  getDocuments = () => null,
  getPageState = () => null,
  hasDocument = () => false,
  confirmDiscardChanges = () => true,
  resetDocument = async () => {},
  fileSizeFor = async file => Number(file?.size || 0),
  readBytes = async file => new Uint8Array(await file.arrayBuffer()),
  beginOperation = () => null,
  assertOperation = () => {},
  endOperation = () => {},
  showProcess = () => {},
  setLocalizedProgress = () => {},
  buildTiles = () => {},
  updateFileCard = () => {},
  syncStageVisibility = () => {},
  renderMainPreview = () => {},
  updateControls = () => {},
  resetEditorHistory = () => {},
  setBaselineSnapshot = () => {},
  setSavedSnapshot = () => {},
  commitEditorHistory = () => {},
  cloneState = value => value,
  editorHistoryFirstSnapshot = () => null,
  messageForError = error => String(error?.message || error),
  showToast = () => {}
} = {}) {
  function currentSources() {
    return getSources() || [];
  }

  function currentPages() {
    return getPages() || [];
  }

  async function loadMainFile(file) {
    if (isDisposed() || !file || getActiveOperation()) {
      if (getActiveOperation()) showToast(t('home.pdfEditor.busy'));
      return;
    }
    const name = String(file.name || '');
    if (!/\.pdf$/i.test(name)) {
      showToast(t('home.pdfEditor.pdfOnly'));
      return;
    }
    if (!confirmDiscardChanges('replace')) return;
    const operation = beginOperation('load');
    showProcess('loadingDocument', 3);
    let stagedDocument = null;
    let documentCommitted = false;
    try {
      const size = await fileSizeFor(file);
      assertOperation(operation);
      assertPdfEditorFile(name, size);
      setLocalizedProgress(12, 'loadingDocument');
      const bytes = await readBytes(file);
      assertOperation(operation);
      const documents = getDocuments();
      const loaded = await documents.loadBytes(bytes, {
        onLoadingTask: loadingTask => {
          operation.loadingTask = loadingTask;
        }
      });
      stagedDocument = loaded.document;
      assertOperation(operation);
      assertPdfEditorPageCount(stagedDocument.numPages);
      setLocalizedProgress(70, 'preparingPages');

      let stagedIdCounter = getIdCounter();
      const source = {
        id: `src-${++stagedIdCounter}`,
        name,
        bytes,
        size,
        pageCount: stagedDocument.numPages
      };
      const stagedPages = Array.from({ length: stagedDocument.numPages }, (_, index) => ({
        id: `page-${++stagedIdCounter}`,
        sourceId: source.id,
        pageIndex: index,
        rotation: 0
      }));

      await resetDocument();
      assertOperation(operation);
      setIdCounter(stagedIdCounter);
      setSources([source]);
      setSourceStore(new Map([[source.id, source]]));
      documents.set(source.id, stagedDocument);
      setPages(stagedPages);
      documentCommitted = true;
      stagedDocument = null;
      const firstPageId = stagedPages[0]?.id || null;
      setSelectedIds(firstPageId ? new Set([firstPageId]) : new Set());
      setCurrentId(firstPageId);
      setSelectionAnchorId(firstPageId);
      setLocalizedProgress(90, 'preparingPages');
      buildTiles(false);
      updateFileCard();
      syncStageVisibility();
      // Build the thumbnail observer once, then paint the selected page here.
      renderMainPreview();
      resetEditorHistory();
      const firstSnapshot = editorHistoryFirstSnapshot();
      setBaselineSnapshot(cloneState(firstSnapshot));
      setSavedSnapshot(cloneState(firstSnapshot));
      setLocalizedProgress(100, 'loadingDocument');
    } catch (error) {
      const cancelled = operation?.cancelled || error instanceof PdfEditorCancelledError;
      if (stagedDocument) {
        try { await stagedDocument.destroy(); } catch (_) {}
      }
      if (documentCommitted) await resetDocument();
      if (!isDisposed()) {
        showToast(
          cancelled ? t('home.pdfEditor.loadCancelled') : messageForError(error, 'load'),
          cancelled ? 4500 : 9000
        );
      }
    } finally {
      if (operation) delete operation.loadingTask;
      endOperation(operation);
    }
  }

  async function appendPdfBytes(bytes, name, size) {
    if (getActiveOperation()) {
      showToast(t('home.pdfEditor.busy'));
      return;
    }
    const operation = beginOperation('append');
    showProcess('appending', 8);
    try {
      assertPdfEditorFile(name, size);
      const appendSources = [...currentSources(), { name, size }];
      const totalBytes = appendSources.reduce((sum, source) => sum + Number(source.size || 0), 0);
      assertPdfEditorMergeSelection(appendSources, totalBytes);
      setLocalizedProgress(30, 'appending');
      const pdfDoc = await PDFDocument.load(bytes.slice());
      assertOperation(operation);
      const pageCount = pdfDoc.getPageCount();
      assertPdfEditorPageCount(pageCount);
      if (currentPages().length + pageCount > PDF_EDITOR_LIMITS.maxPages) {
        throw new Error('PDF exceeds the maximum page count');
      }
      const idCounter = getIdCounter();
      const source = { id: `src-${idCounter + 1}`, name, bytes, size, pageCount };
      setIdCounter(idCounter + 1);
      const sources = currentSources();
      sources.push(source);
      getSourceStore().set(source.id, source);
      const pages = currentPages();
      const newPages = Array.from({ length: pageCount }, (_, index) => ({
        id: `page-${getIdCounter() + 1 + index}`,
        sourceId: source.id,
        pageIndex: index,
        rotation: 0
      }));
      setIdCounter(getIdCounter() + pageCount);
      pages.push(...newPages);
      setLocalizedProgress(80, 'preparingPages');
      buildTiles();
      updateFileCard();
      if (newPages.length) {
        const lastPageId = newPages[newPages.length - 1].id;
        setCurrentId(lastPageId);
        setSelectedIds(new Set([lastPageId]));
      }
      updateControls();
      renderMainPreview();
      windowRef?.requestAnimationFrame?.(() => {
        pageStrip?.scrollTo?.({ top: pageStrip.scrollHeight, behavior: 'smooth' });
      });
      commitEditorHistory();
      setLocalizedProgress(100, 'appending');
    } catch (error) {
      const cancelled = operation?.cancelled || error instanceof PdfEditorCancelledError;
      showToast(
        cancelled ? t('home.pdfEditor.cancelled') : messageForError(error, 'append'),
        cancelled ? 4500 : 9000
      );
    } finally {
      endOperation(operation);
    }
  }

  function chooseMainFile() {
    if (getActiveOperation()) {
      showToast(t('home.pdfEditor.busy'));
      return;
    }
    if (isTauri) {
      void (async () => {
        try {
          const { open } = await loadTauriDialog();
          const selected = await open({
            multiple: false,
            filters: [{ name: 'PDF Files', extensions: ['pdf'] }]
          });
          if (!isDisposed() && typeof selected === 'string') {
            await loadMainFile({
              name: selected.split(/[\\/]/).pop() || selected,
              path: selected,
              size: 0
            });
          }
        } catch (error) {
          showToast(messageForError(error, 'load'));
        }
      })();
      return;
    }
    if (fileInput) {
      fileInput.value = '';
      fileInput.click();
    }
  }

  function chooseAppendFile() {
    if (getActiveOperation()) {
      showToast(t('home.pdfEditor.busy'));
      return;
    }
    if (!hasDocument()) {
      showToast(t('home.pdfEditor.appendNeedsFile'));
      return;
    }
    if (isTauri) {
      void (async () => {
        try {
          const { open } = await loadTauriDialog();
          const selected = await open({
            multiple: false,
            filters: [{ name: 'PDF Files', extensions: ['pdf'] }]
          });
          if (!isDisposed() && typeof selected === 'string') {
            const name = selected.split(/[\\/]/).pop() || selected;
            const size = await fileSizeFor({ path: selected, name });
            const bytes = await readBytes({ path: selected, name });
            await appendPdfBytes(bytes, name, size);
          }
        } catch (error) {
          showToast(messageForError(error, 'append'));
        }
      })();
      return;
    }
    if (appendInput) {
      appendInput.value = '';
      appendInput.click();
    }
  }

  return {
    appendPdfBytes,
    chooseAppendFile,
    chooseMainFile,
    loadMainFile
  };
}
