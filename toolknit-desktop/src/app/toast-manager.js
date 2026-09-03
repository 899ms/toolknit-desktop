const MIN_DURATION = 5200;
const LONG_DURATION = 7200;
const MAX_VISIBLE = 3;

/** Owns global transient feedback and its timers. */
export function createToastManager({
  root = document,
  getLanguage = () => 'en',
  setTimeoutFn = globalThis.setTimeout,
  clearTimeoutFn = globalThis.clearTimeout
} = {}) {
  const active = [];

  function durationFor(message, requestedDuration) {
    const numeric = Number(requestedDuration);
    const text = String(message || '');
    const important = /(失败|错误|无法|不支持|需要|请|未|阻止|警告|failed|error|cannot|unable|blocked|warning|required|please)/i.test(text);
    const lengthBonus = Math.min(2600, Math.max(0, text.length - 28) * 45);
    const base = important ? LONG_DURATION : MIN_DURATION;
    return (Number.isFinite(numeric) && numeric > 0
      ? Math.max(base, numeric, MIN_DURATION)
      : base) + lengthBonus;
  }

  function remove(record, immediate = false) {
    if (!record || record.removed) return;
    record.removed = true;
    if (record.timer) clearTimeoutFn(record.timer);
    const index = active.indexOf(record);
    if (index >= 0) active.splice(index, 1);
    if (immediate) {
      record.el.remove();
      return;
    }
    record.el.classList.add('hiding');
    record.el.addEventListener('animationend', () => record.el.remove(), { once: true });
  }

  function schedule(record, duration) {
    if (!record || record.removed) return;
    if (record.timer) clearTimeoutFn(record.timer);
    record.startedAt = Date.now();
    record.remaining = Math.max(800, duration);
    record.timer = setTimeoutFn(() => remove(record), record.remaining);
  }

  function show(message, optionsOrDuration = {}) {
    const container = root.getElementById?.('toastContainer');
    if (!container) return;
    const text = String(message ?? '').trim();
    if (!text) return;
    const options = typeof optionsOrDuration === 'number'
      ? { duration: optionsOrDuration }
      : (optionsOrDuration && typeof optionsOrDuration === 'object' ? optionsOrDuration : {});
    const duplicate = active.find(record => record.message === text && !record.removed);
    if (duplicate) {
      duplicate.messageEl.textContent = text;
      schedule(duplicate, durationFor(text, options.duration));
      return handleFor(duplicate);
    }
    while (active.length >= MAX_VISIBLE) remove(active[0], true);

    const toast = root.createElement('div');
    toast.className = 'app-toast';
    if (options.className) toast.classList.add(...String(options.className).split(/\s+/).filter(Boolean));
    toast.setAttribute('role', 'status');
    toast.setAttribute('aria-live', 'polite');
    const messageEl = root.createElement('div');
    messageEl.className = 'app-toast-message';
    messageEl.textContent = text;
    const closeBtn = root.createElement('button');
    closeBtn.className = 'app-toast-close';
    closeBtn.type = 'button';
    closeBtn.setAttribute('aria-label', getLanguage() === 'zh' ? '关闭提示' : 'Dismiss notification');
    closeBtn.textContent = '×';
    if (options.dismissible === false) closeBtn.style.display = 'none';
    toast.append(messageEl, closeBtn);
    container.appendChild(toast);
    const record = { el: toast, messageEl, message: text, timer: null, startedAt: Date.now(), remaining: durationFor(text, options.duration), removed: false };
    active.push(record);
    closeBtn.addEventListener('click', () => remove(record));
    toast.addEventListener('mouseenter', () => {
      if (record.timer) clearTimeoutFn(record.timer);
      record.timer = null;
      record.remaining = Math.max(1600, record.remaining - (Date.now() - record.startedAt));
    });
    toast.addEventListener('mouseleave', () => schedule(record, record.remaining));
    schedule(record, record.remaining);
    return handleFor(record);
  }

  function handleFor(record) {
    return {
      el: record.el,
      close: () => remove(record),
      update: nextMessage => {
        const nextText = String(nextMessage ?? '').trim();
        if (nextText) record.messageEl.textContent = nextText;
      }
    };
  }

  function dispose() {
    [...active].forEach(record => remove(record, true));
  }

  return Object.freeze({ show, dispose, get activeCount() { return active.length; } });
}
