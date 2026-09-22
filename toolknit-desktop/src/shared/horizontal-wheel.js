/** Maps wheel input inside a horizontal strip, with one scroll write per frame. */
export function bindHorizontalWheel(element, {
  enabled = () => true,
  requestFrame = callback => requestAnimationFrame(callback),
  cancelFrame = id => cancelAnimationFrame(id)
} = {}) {
  if (!element?.addEventListener) return () => {};
  let frame = null;
  let pending = 0;
  let disposed = false;
  const flush = () => {
    frame = null;
    if (!disposed && enabled()) {
      const max = Math.max(0, element.scrollWidth - element.clientWidth);
      element.scrollLeft = Math.max(0, Math.min(max, element.scrollLeft + pending));
    }
    pending = 0;
  };
  const onWheel = event => {
    if (disposed || !enabled() || event.defaultPrevented || event.ctrlKey || event.metaKey) return;
    if (element.scrollWidth <= element.clientWidth) return;
    if (event.target?.closest?.('input, textarea, select, [contenteditable="true"]')) return;
    const raw = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? element.clientWidth : 1;
    const delta = raw * unit;
    if (!Number.isFinite(delta) || !delta) return;
    event.preventDefault();
    pending += delta;
    if (frame === null) frame = requestFrame(flush);
  };
  element.addEventListener('wheel', onWheel, { passive: false });
  return () => {
    if (disposed) return;
    disposed = true;
    element.removeEventListener('wheel', onWheel);
    if (frame !== null) cancelFrame(frame);
    frame = null;
    pending = 0;
  };
}
