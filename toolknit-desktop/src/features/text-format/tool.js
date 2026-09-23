import { createLifecycleScope } from '../../app/tool-lifecycle.js';
import { onLangChange, t } from '../../i18n.js';
import { bindTextDocumentDrop } from '../../shared/text-document-drop.js';
import {
  readTextDocument,
  TEXT_DOCUMENT_EXTENSIONS,
  textDocumentErrorKey
} from '../../shared/text-document-reader.js';
import { TEXT_FORMAT_LIMITS, TextFormatError, executeTextFormat } from '../../text-format-core.js';
import { TEXT_STATS_LIMITS } from '../../text-stats-core.js';
import './text-format.css';

const EMPTY_SOURCE = Object.freeze({ type: 'manual', name: '', bytes: 0, kind: '' });

export function initTextFormatTool({
  overlay,
  isTauri = false,
  notify = () => {},
  formatFileSize = value => `${Number(value) || 0} B`,
  initStandardToolPlasma = () => null,
  disposeStandardToolPlasma = instance => instance
} = {}) {
  if (!overlay) throw new Error('text-format:missing-overlay');
  const lifecycle = createLifecycleScope();
  const byId = id => overlay.querySelector(`#${id}`);
  const back = byId('textFormatBack');
  const background = byId('textFormatBg');
  const dropZone = byId('textFormatDropZone');
  const dropCard = byId('textFormatDropCard');
  const cta = byId('textFormatCta');
  const selectFileButton = byId('textFormatSelectFileBtn');
  const fileInput = byId('textFormatFileInput');
  const fileInfo = byId('textFormatFileInfo');
  const fileName = byId('textFormatFileName');
  const fileMeta = byId('textFormatFileMeta');
  const input = byId('textFormatInput');
  const output = byId('textFormatOutput');
  const actions = byId('textFormatActions');
  const copyButton = byId('textFormatCopyBtn');
  const clearButton = byId('textFormatClearBtn');
  const useAsInputButton = byId('textFormatUseAsInputBtn');

  let source = { ...EMPTY_SOURCE };
  let plasma = null;
  let focusTimer = 0;
  let copyTimer = 0;
  let copyButtonLabel = '';
  let readRunId = 0;

  const copy = (key, params) => t(`home.textFormat.${key}`, params);

  function clearScheduledWork() {
    if (focusTimer) clearTimeout(focusTimer);
    if (copyTimer) clearTimeout(copyTimer);
    focusTimer = 0;
    copyTimer = 0;
    if (copyButton && copyButtonLabel) copyButton.textContent = copyButtonLabel;
    copyButtonLabel = '';
  }

  function updateSource(next = EMPTY_SOURCE) {
    source = { ...EMPTY_SOURCE, ...next };
    const manual = source.type === 'manual';
    fileInfo?.classList.toggle('has-file', !manual);
    if (fileName) fileName.textContent = manual ? copy('manualInput') : source.name;
    if (fileMeta) {
      fileMeta.textContent = manual
        ? copy('manualMeta')
        : copy('fileMeta', {
            type: source.kind || copy('document'),
            size: formatFileSize(source.bytes || 0)
          });
    }
  }

  function documentErrorMessage(error) {
    const key = textDocumentErrorKey(error);
    if (key === 'fileTooLarge') return copy(key, { max: Math.round(TEXT_STATS_LIMITS.maxDocumentBytes / 1024 / 1024) });
    if (key === 'tooManyPdfPages') return copy(key, { max: TEXT_STATS_LIMITS.maxPdfPages });
    return copy(key);
  }

  async function loadDocument(file) {
    if (!file) return;
    const runId = ++readRunId;
    const token = lifecycle.token();
    overlay.classList.add('is-reading-file');
    try {
      const result = await readTextDocument(file, {
        isTauri,
        fallbackName: copy('document'),
        onTrim: max => {
          if (runId === readRunId && lifecycle.isCurrent(token)) {
            notify(t('home.textStats.documentTrimmed', { max }));
          }
        }
      });
      if (runId !== readRunId || !lifecycle.isCurrent(token) || !overlay.classList.contains('visible')) return;
      if (input) {
        input.value = result.text;
        input.focus();
      }
      if (output) output.value = '';
      updateSource({ type: 'file', name: result.name, bytes: result.bytes, kind: result.kind });
      notify(copy('fileLoaded', { name: result.name }));
    } catch (error) {
      if (runId === readRunId && lifecycle.isCurrent(token)) notify(documentErrorMessage(error));
    } finally {
      if (runId === readRunId) overlay.classList.remove('is-reading-file');
      if (fileInput) fileInput.value = '';
    }
  }

  async function chooseDocument() {
    if (overlay.classList.contains('is-reading-file')) return;
    if (!isTauri) {
      fileInput?.click();
      return;
    }
    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const selected = await open({
        multiple: false,
        filters: [{ name: 'Documents', extensions: [...TEXT_DOCUMENT_EXTENSIONS] }]
      });
      if (selected) await loadDocument({ path: selected, name: String(selected).split(/[/\\]/).pop() });
    } catch (error) {
      console.error('Text format file picker failed:', error);
      notify(copy('readFailed'));
    }
  }

  function runAction(event) {
    const button = event.target.closest('[data-action]');
    if (!button || !actions?.contains(button)) return;
    const value = input?.value || '';
    if (!value) return;
    try {
      if (output) output.value = executeTextFormat(button.dataset.action, value);
    } catch (error) {
      if (error instanceof TextFormatError && error.code === 'result_too_long') {
        notify(copy('resultTooLong', { max: TEXT_FORMAT_LIMITS.maxInputChars }));
      } else if (error instanceof TextFormatError && error.code === 'too_many_lines') {
        notify(copy('tooManyLines', { max: TEXT_FORMAT_LIMITS.maxLines }));
      } else if (error instanceof RangeError) {
        notify(copy('inputTooLong', { max: TEXT_FORMAT_LIMITS.maxInputChars }));
      } else {
        console.error('[Text Format] Processing error:', error);
      }
    }
  }

  function copyOutput() {
    if (!output?.value) return;
    if (!navigator.clipboard?.writeText) {
      notify(copy('copyFailed'));
      return;
    }
    navigator.clipboard.writeText(output.value).then(() => {
      if (!copyButton) return;
      if (copyTimer) clearTimeout(copyTimer);
      copyButtonLabel = copyButton.textContent;
      copyButton.textContent = '✓';
      copyTimer = setTimeout(() => {
        copyTimer = 0;
        if (copyButtonLabel) copyButton.textContent = copyButtonLabel;
        copyButtonLabel = '';
      }, 1500);
    }).catch(() => notify(copy('copyFailed')));
  }

  lifecycle.event(back, 'click', () => { void api.close(); });
  lifecycle.event(cta, 'click', () => { void chooseDocument(); });
  lifecycle.event(selectFileButton, 'click', () => { void chooseDocument(); });
  lifecycle.event(fileInput, 'change', event => {
    const file = event.target.files?.[0];
    if (file) void loadDocument(file);
  });
  lifecycle.event(actions, 'click', runAction);
  lifecycle.event(input, 'input', () => {
    if (input.value.length > TEXT_FORMAT_LIMITS.maxInputChars) {
      input.value = input.value.slice(0, TEXT_FORMAT_LIMITS.maxInputChars);
      notify(copy('inputTooLong', { max: TEXT_FORMAT_LIMITS.maxInputChars }));
    }
    updateSource();
  });
  lifecycle.event(copyButton, 'click', copyOutput);
  lifecycle.event(clearButton, 'click', () => {
    if (input) input.value = '';
    if (output) output.value = '';
    updateSource();
    input?.focus();
  });
  lifecycle.event(useAsInputButton, 'click', () => {
    if (!output?.value) return;
    if (output.value.length > TEXT_FORMAT_LIMITS.maxInputChars) {
      notify(copy('resultTooLong', { max: TEXT_FORMAT_LIMITS.maxInputChars }));
      return;
    }
    if (input) input.value = output.value;
    output.value = '';
    updateSource();
    input?.focus();
  });
  lifecycle.use(onLangChange(() => {
    if (copyTimer) clearTimeout(copyTimer);
    copyTimer = 0;
    copyButtonLabel = '';
    updateSource(source);
  }));
  bindTextDocumentDrop({
    lifecycle,
    overlay,
    dropZone,
    dropCard,
    isTauri,
    onFile: loadDocument,
    onError: error => console.error('Text format drag registration failed:', error)
  });

  const api = {
    open() {
      lifecycle.invalidate();
      clearScheduledWork();
      overlay.classList.add('visible');
      overlay.setAttribute('aria-hidden', 'false');
      updateSource(source);
      if (background && !plasma) plasma = initStandardToolPlasma(background);
      focusTimer = setTimeout(() => {
        focusTimer = 0;
        if (overlay.classList.contains('visible')) input?.focus();
      }, 300);
    },
    close() {
      lifecycle.invalidate();
      readRunId += 1;
      clearScheduledWork();
      overlay.classList.remove('visible', 'drag-over', 'is-reading-file');
      overlay.setAttribute('aria-hidden', 'true');
      dropZone?.classList.remove('visible');
      dropCard?.classList.remove('is-dragging');
      if (fileInput) fileInput.value = '';
      plasma = disposeStandardToolPlasma(plasma);
    },
    dispose() {
      api.close();
      lifecycle.dispose();
    }
  };

  return api;
}
