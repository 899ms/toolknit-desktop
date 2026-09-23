const EMPTY_FRAME = Symbol('pdf-crop-empty-frame');

const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const clamp = (value, min, max) => Math.min(max, Math.max(min, finite(value, min)));

export function normalizePdfCropPointer(point, bounds) {
  const left = finite(bounds?.left);
  const top = finite(bounds?.top);
  const width = Math.max(1, finite(bounds?.width, 1));
  const height = Math.max(1, finite(bounds?.height, 1));
  return {
    x: clamp((finite(point?.clientX) - left) / width, 0, 1),
    y: clamp((finite(point?.clientY) - top) / height, 0, 1)
  };
}

function normalizeInteractionRect(value, minWidth, minHeight) {
  const minimumWidth = clamp(minWidth, 0.0001, 0.5);
  const minimumHeight = clamp(minHeight, 0.0001, 0.5);
  let x = clamp(value?.x, 0, 1);
  let y = clamp(value?.y, 0, 1);
  const width = clamp(value?.width, minimumWidth, 1);
  const height = clamp(value?.height, minimumHeight, 1);
  if (x + width > 1) x = Math.max(0, 1 - width);
  if (y + height > 1) y = Math.max(0, 1 - height);
  return { x, y, width, height };
}

export function calculatePdfCropInteractionRect({
  mode,
  handle = '',
  start,
  point,
  rect,
  minWidth = 0.002,
  minHeight = 0.002
}) {
  const origin = normalizePdfCropPointer({ clientX: start?.x, clientY: start?.y }, {
    left: 0,
    top: 0,
    width: 1,
    height: 1
  });
  const current = normalizePdfCropPointer({ clientX: point?.x, clientY: point?.y }, {
    left: 0,
    top: 0,
    width: 1,
    height: 1
  });
  const initial = normalizeInteractionRect(rect, minWidth, minHeight);

  if (mode === 'draw') {
    return normalizeInteractionRect({
      x: Math.min(origin.x, current.x),
      y: Math.min(origin.y, current.y),
      width: Math.max(minWidth, Math.abs(current.x - origin.x)),
      height: Math.max(minHeight, Math.abs(current.y - origin.y))
    }, minWidth, minHeight);
  }

  if (mode === 'move') {
    return {
      ...initial,
      x: clamp(initial.x + current.x - origin.x, 0, 1 - initial.width),
      y: clamp(initial.y + current.y - origin.y, 0, 1 - initial.height)
    };
  }

  if (mode !== 'resize') return initial;
  let left = initial.x;
  let right = initial.x + initial.width;
  let top = initial.y;
  let bottom = initial.y + initial.height;
  if (handle.includes('w')) left = clamp(current.x, 0, right - minWidth);
  if (handle.includes('e')) right = clamp(current.x, left + minWidth, 1);
  if (handle.includes('n')) top = clamp(current.y, 0, bottom - minHeight);
  if (handle.includes('s')) bottom = clamp(current.y, top + minHeight, 1);
  return normalizeInteractionRect({
    x: left,
    y: top,
    width: right - left,
    height: bottom - top
  }, minWidth, minHeight);
}

export function createLatestFrameScheduler(callback, {
  requestFrame = handler => globalThis.requestAnimationFrame(handler),
  cancelFrame = frame => globalThis.cancelAnimationFrame(frame)
} = {}) {
  let frame = null;
  let pending = EMPTY_FRAME;

  function commit() {
    frame = null;
    if (pending === EMPTY_FRAME) return undefined;
    const value = pending;
    pending = EMPTY_FRAME;
    callback(value);
    return value;
  }

  return {
    schedule(value) {
      pending = value;
      if (frame === null) frame = requestFrame(commit);
    },
    flush() {
      if (frame !== null) cancelFrame(frame);
      frame = null;
      return commit();
    },
    cancel() {
      if (frame !== null) cancelFrame(frame);
      frame = null;
      pending = EMPTY_FRAME;
    }
  };
}
