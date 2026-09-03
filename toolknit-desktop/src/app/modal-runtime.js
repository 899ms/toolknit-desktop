const A11Y_ROOT_SELECTOR = [
  '[id$="Overlay"]',
  '[id$="Workspace"]',
  '[id$="Dialog"]',
  '#pdfMergeSelection',
  '#aiDocStyleInspector'
].join(', ');

const OVERFLOW_ROOT_SELECTOR = [
  '.audio-convert-success-overlay',
  '.audio-clip-success-overlay',
  '.pdf-preview-drawer',
  '.donation-overlay',
  '.transcription-model-overlay',
  '.transcription-gate-overlay',
  '.pdf-editor-edit-modal',
  '#pdfEncryptPasswordDialog',
  '#pdfDecryptPasswordDialog'
].join(', ');

const OVERFLOW_TARGET_SELECTOR = [
  '.audio-convert-success-meta',
  '.audio-convert-success-value',
  '.audio-convert-success-path',
  '.audio-clip-success-meta',
  '.audio-clip-success-path',
  '.cleanup-large-files-success-failures span',
  '.pdf-page-workspace-file',
  '.ppt-render-v2-file',
  '.ppt-images-v2-file',
  '.ppt-text-v2-file',
  '.ppt-compress-v2-file',
  '.transcription-selected-file',
  '.pdf-editor-filecard-name'
].join(', ');

const OVERFLOW_ARIA_SELECTOR = [
  '.audio-convert-success-value',
  '.audio-convert-success-path',
  '.audio-clip-success-path',
  '.pdf-page-workspace-file',
  '.ppt-render-v2-file',
  '.ppt-images-v2-file',
  '.ppt-text-v2-file',
  '.ppt-compress-v2-file',
  '.transcription-selected-file',
  '.pdf-editor-filecard-name'
].join(', ');

const isElement = node => node?.nodeType === 1;

/** Owns modal inert/aria state and overflow metadata observers. */
export function createModalRuntime({ documentRef = globalThis.document } = {}) {
  const observers = [];

  const syncA11y = root => {
    if (!isElement(root)) return;
    const visible = root.classList.contains('visible');
    root.toggleAttribute('inert', !visible);
    root.setAttribute('aria-hidden', String(!visible));
  };

  const initA11y = () => {
    const roots = Array.from(documentRef?.querySelectorAll?.(A11Y_ROOT_SELECTOR) || []);
    roots.forEach(syncA11y);
    if (typeof globalThis.MutationObserver !== 'function') return;
    const observer = new globalThis.MutationObserver(entries => entries.forEach(entry => syncA11y(entry.target)));
    roots.forEach(root => observer.observe(root, { attributes: true, attributeFilter: ['class'] }));
    observers.push(observer);
  };

  const syncOverflowTitle = node => {
    if (!isElement(node) || node.id === 'dependencyGateDesc') return;
    const value = (node.textContent || '').replace(/\s+/g, ' ').trim();
    const ownsTitle = node.dataset.tkOverflowTitle === '1';
    const ownsAria = node.dataset.tkOverflowAria === '1';
    const clear = () => {
      if (ownsTitle) node.removeAttribute('title');
      if (ownsAria) node.removeAttribute('aria-label');
      delete node.dataset.tkOverflowTitle;
      delete node.dataset.tkOverflowAria;
    };
    if (!value) { clear(); return; }
    const needsHint = value.length >= 28 || /(?:[A-Za-z]:[\\/]|https?:\/\/|\\\\)/.test(value);
    if (!needsHint) { clear(); return; }
    node.setAttribute('title', value);
    node.dataset.tkOverflowTitle = '1';
    if (node.matches(OVERFLOW_ARIA_SELECTOR) && !node.hasAttribute('aria-label')) {
      node.setAttribute('aria-label', value);
      node.dataset.tkOverflowAria = '1';
    } else if (ownsAria) node.setAttribute('aria-label', value);
  };

  const scanOverflow = node => {
    if (!node) return;
    if (node.nodeType === 3) {
      if (node.parentElement?.matches(OVERFLOW_TARGET_SELECTOR)) syncOverflowTitle(node.parentElement);
      return;
    }
    if (!isElement(node)) return;
    if (node.matches(OVERFLOW_TARGET_SELECTOR)) syncOverflowTitle(node);
    node.querySelectorAll?.(OVERFLOW_TARGET_SELECTOR).forEach(syncOverflowTitle);
  };

  const initOverflow = () => {
    const roots = Array.from(documentRef?.querySelectorAll?.(OVERFLOW_ROOT_SELECTOR) || []);
    if (typeof globalThis.MutationObserver !== 'function') {
      roots.forEach(scanOverflow);
      return;
    }
    roots.forEach(root => {
      scanOverflow(root);
      const observer = new globalThis.MutationObserver(records => records.forEach(record => {
        if (record.type === 'characterData') scanOverflow(record.target);
        else {
          scanOverflow(record.target);
          record.addedNodes.forEach(scanOverflow);
        }
      }));
      observer.observe(root, { childList: true, characterData: true, subtree: true });
      observers.push(observer);
    });
  };

  const dispose = () => observers.splice(0).forEach(observer => observer.disconnect());
  return Object.freeze({ dispose, initA11y, initOverflow, scanOverflow, syncA11y, syncOverflowTitle });
}

export { A11Y_ROOT_SELECTOR, OVERFLOW_ARIA_SELECTOR, OVERFLOW_ROOT_SELECTOR, OVERFLOW_TARGET_SELECTOR };
