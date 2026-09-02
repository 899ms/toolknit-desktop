export const BG_REMOVAL_STATES = Object.freeze([
  'empty',
  'ready',
  'processing',
  'editing',
  'saving',
  'saved',
  'error'
]);

const TRANSITIONS = Object.freeze({
  empty: new Set(['processing', 'error']),
  ready: new Set(['processing', 'empty', 'error']),
  processing: new Set(['ready', 'editing', 'empty', 'error']),
  editing: new Set(['processing', 'saving', 'ready', 'empty', 'error']),
  saving: new Set(['saved', 'editing', 'empty', 'error']),
  saved: new Set(['editing', 'saving', 'processing', 'ready', 'empty', 'error']),
  error: new Set(['empty', 'processing', 'ready', 'editing'])
});

export function canTransitionBgRemovalState(from, to) {
  return from === to || Boolean(TRANSITIONS[from]?.has(to));
}

export function transitionBgRemovalState(from, to) {
  if (!BG_REMOVAL_STATES.includes(to)) throw new Error(`Unknown background-removal state: ${to}`);
  if (!canTransitionBgRemovalState(from, to)) {
    throw new Error(`Invalid background-removal transition: ${from} -> ${to}`);
  }
  return to;
}

export function createEditHistory() {
  return { strokes: [], redo: [] };
}

export function commitEditStroke(history, stroke) {
  if (!stroke?.points?.length) return false;
  history.strokes.push(stroke);
  history.redo.length = 0;
  return true;
}

export function undoEditStroke(history) {
  const stroke = history.strokes.pop();
  if (!stroke) return null;
  history.redo.push(stroke);
  return stroke;
}

export function redoEditStroke(history) {
  const stroke = history.redo.pop();
  if (!stroke) return null;
  history.strokes.push(stroke);
  return stroke;
}

export function resetEditHistory(history) {
  history.strokes.length = 0;
  history.redo.length = 0;
}

export function selectInstalledModels(models, preferredId = '') {
  const installed = (Array.isArray(models) ? models : []).filter(model => model?.installed);
  const preferred = installed.find(model => model.id === preferredId)
    || installed.find(model => model.current)
    || installed[0]
    || null;
  return { installed, preferred };
}

export function applyAlphaDabValue(currentAlpha, strength, mode) {
  const current = Math.min(1, Math.max(0, Number(currentAlpha) || 0));
  const source = Math.min(1, Math.max(0, Number(strength) || 0));
  return mode === 'erase'
    ? current * (1 - source)
    : source + current * (1 - source);
}

export function joinNativePath(root, child) {
  const base = String(root || '').trim();
  const segment = String(child || '').trim();
  if (!base) return segment;
  if (!segment) return base;
  const separator = base.includes('\\') ? '\\' : '/';
  const normalizedRoot = base.replace(/[\\/]+$/, '');
  const normalizedChild = segment
    .replace(/[\\/]+/g, separator)
    .replace(separator === '\\' ? /^\\+|\\+$/g : /^\/+|\/+$/g, '');
  return `${normalizedRoot}${separator}${normalizedChild}`;
}

export function parentDirectoryFromPath(path) {
  const value = String(path || '').trim().replace(/[\\/]+$/, '');
  if (!value) return '';
  const parent = value.replace(/[\\/][^\\/]+$/, '');
  return parent && parent !== value ? parent : value;
}
