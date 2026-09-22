const MIN_DURATION = 5200;
const LONG_DURATION = 7200;
const MAX_VISIBLE = 3;
const TOAST_KINDS = new Set(['info', 'success', 'warning', 'error']);

function kindFor(message, requestedKind) {
  const requested = String(requestedKind || '').trim().toLowerCase();
  if (TOAST_KINDS.has(requested)) return requested;
  const text = String(message || '');
  if (/(失败|错误|无法|无效|不像|不支持|阻止|failed|invalid|not valid|not a valid|must be (?:a )?valid|could not|error|cannot|unable|blocked)/i.test(text)) return 'error';
  if (/(警告|注意|风险|warning|caution|risk)/i.test(text)) return 'warning';
  if (/(成功|完成|已保存|已复制|已更新|success|completed|saved|copied|updated)/i.test(text)) return 'success';
  return 'info';
}

function appendIcon(parent, createIconElement, name, fallback = '') {
  try {
    const icon = createIconElement(name);
    if (icon) {
      parent.appendChild(icon);
      return;
    }
  } catch (_) {}
  if (fallback) parent.textContent = fallback;
}

/** Owns global transient feedback and its timers. */
export function createToastManager({
  root = document,
  getLanguage = () => 'en',
  createIconElement = () => null,
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

    const kind = kindFor(text, options.kind);
    const toast = root.createElement('div');
    toast.className = 'app-toast';
    toast.classList.add(`app-toast--${kind}`);
    if (options.className) toast.classList.add(...String(options.className).split(/\s+/).filter(Boolean));
    toast.setAttribute('role', kind === 'error' ? 'alert' : 'status');
    toast.setAttribute('aria-live', kind === 'error' ? 'assertive' : 'polite');
    const iconEl = root.createElement('span');
    iconEl.className = 'app-toast-icon';
    iconEl.setAttribute('aria-hidden', 'true');
    appendIcon(iconEl, createIconElement, kind, kind === 'error' || kind === 'warning' ? '!' : 'i');
    const messageEl = root.createElement('div');
    messageEl.className = 'app-toast-message';
    messageEl.textContent = text;
    const closeBtn = root.createElement('button');
    closeBtn.className = 'app-toast-close';
    closeBtn.type = 'button';
    closeBtn.setAttribute('aria-label', getLanguage() === 'zh' ? '关闭提示' : 'Dismiss notification');
    appendIcon(closeBtn, createIconElement, 'close', '×');
    if (options.dismissible === false) closeBtn.style.display = 'none';
    toast.append(iconEl, messageEl, closeBtn);
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
