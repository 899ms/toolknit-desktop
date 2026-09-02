const DEFAULT_FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])'
].join(',');

function isHTMLElement(element, windowRef) {
  const HTMLElementCtor = windowRef?.HTMLElement || globalThis.HTMLElement;
  return typeof HTMLElementCtor === 'function' && element instanceof HTMLElementCtor;
}

/**
 * Keeps modal focus behavior independent from PDF editor state and rendering.
 * The DOM references are supplied by the feature so the manager never queries
 * unrelated application overlays.
 */
export function createPdfEditorFocusManager({
  overlay,
  processMask,
  successOverlay,
  editModal,
  documentRef = globalThis.document,
  windowRef = globalThis.window,
  isDisposed = () => false,
  focusableSelector = DEFAULT_FOCUSABLE_SELECTOR
} = {}) {
  function focusedElement() {
    return documentRef?.activeElement || null;
  }

  function canReceiveFocus(target) {
    return Boolean(target?.isConnected
      && !target.disabled
      && !target.closest?.('[inert], [aria-hidden="true"]'));
  }

  function restoreFocus(target) {
    if (isDisposed() || !canReceiveFocus(target)) return;
    const frame = windowRef?.requestAnimationFrame || globalThis.requestAnimationFrame;
    const focus = () => {
      if (isDisposed() || !canReceiveFocus(target)) return;
      try { target.focus({ preventScroll: true }); } catch (_) {}
    };
    if (typeof frame === 'function') frame(focus);
    else focus();
  }

  function focusableElements(roots) {
    const elements = [];
    const seen = new Set();
    for (const root of (roots || []).filter(Boolean)) {
      for (const element of root.querySelectorAll?.(focusableSelector) || []) {
        if (!isHTMLElement(element, windowRef) || seen.has(element)) continue;
        if (element.hidden || element.closest?.('[inert], [aria-hidden="true"]')) continue;
        const style = windowRef?.getComputedStyle?.(element);
        if (style?.display === 'none' || style?.visibility === 'hidden') continue;
        seen.add(element);
        elements.push(element);
      }
    }
    return elements;
  }

  function trapFocus(event, roots) {
    if (event.key !== 'Tab') return;
    const elements = focusableElements(roots);
    if (!elements.length) {
      event.preventDefault();
      return;
    }
    const first = elements[0];
    const last = elements[elements.length - 1];
    const active = focusedElement();
    if (!elements.includes(active)) {
      event.preventDefault();
      first.focus();
    } else if (event.shiftKey && active === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function activeFocusRoots() {
    if (successOverlay?.classList.contains('visible')) return [successOverlay];
    if (processMask?.classList.contains('visible')) return [processMask];
    if (editModal?.classList.contains('visible')) return [editModal];
    if (overlay?.classList.contains('visible')) return [overlay];
    return [];
  }

  return {
    activeFocusRoots,
    canReceiveFocus,
    focusedElement,
    focusableElements,
    restoreFocus,
    trapFocus
  };
}
