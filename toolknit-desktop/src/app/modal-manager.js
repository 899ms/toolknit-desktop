/** Central modal accessibility and focus lifecycle. */
export function createModalManager({ root = document } = {}) {
  const previousFocus = new WeakMap();
  const setVisible = (modal, visible) => {
    if (!modal) return;
    if (visible) {
      previousFocus.set(modal, root.activeElement);
      modal.classList.add('visible');
      modal.setAttribute('aria-hidden', 'false');
      modal.removeAttribute('inert');
      modal.querySelector('button, [href], input, textarea, select, [tabindex]:not([tabindex="-1"])')?.focus();
    } else {
      modal.classList.remove('visible');
      modal.setAttribute('aria-hidden', 'true');
      modal.setAttribute('inert', '');
      previousFocus.get(modal)?.focus?.();
    }
  };
  return Object.freeze({ open: modal => setVisible(modal, true), close: modal => setVisible(modal, false), setVisible });
}
