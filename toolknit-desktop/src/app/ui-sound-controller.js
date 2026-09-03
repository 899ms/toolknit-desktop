/* Application-wide sound feedback and lifecycle ownership. */
import { createLifecycleScope } from './tool-lifecycle.js';

export function initUiSoundController({ isScreenPickerWindow = false } = {}) {
const lifecycle = createLifecycleScope();
const UI_SOUND_STORAGE_KEY = 'toolknit.ui-sound.v1';
const UI_SOUND_STYLES = Object.freeze({
  '1': Object.freeze({
    touch: Object.freeze([{ frequency: 360, endFrequency: 430, duration: 0.065, volume: 0.14, waveform: 'sine' }]),
    slide: Object.freeze([{ frequency: 285, endFrequency: 330, duration: 0.045, volume: 0.08, waveform: 'sine' }]),
    hover: Object.freeze([{ frequency: 440, endFrequency: 470, duration: 0.04, volume: 0.1, waveform: 'sine' }])
  }),
  '2': Object.freeze({
    touch: Object.freeze([{ frequency: 430, endFrequency: 510, duration: 0.055, volume: 0.12, waveform: 'triangle' }]),
    slide: Object.freeze([{ frequency: 330, endFrequency: 390, duration: 0.04, volume: 0.07, waveform: 'triangle' }]),
    hover: Object.freeze([{ frequency: 520, endFrequency: 550, duration: 0.035, volume: 0.09, waveform: 'triangle' }])
  }),
  '3': Object.freeze({
    touch: Object.freeze([{ frequency: 190, endFrequency: 250, duration: 0.07, volume: 0.1, waveform: 'square' }]),
    slide: Object.freeze([{ frequency: 150, endFrequency: 205, duration: 0.05, volume: 0.065, waveform: 'square' }]),
    hover: Object.freeze([{ frequency: 280, endFrequency: 305, duration: 0.038, volume: 0.08, waveform: 'square' }])
  })
});
const UI_SOUND_MIN_INTERVALS = Object.freeze({ touch: 55, slide: 42, hover: 115 });

function readUiSoundState() {
  let parsed = null;
  try { parsed = JSON.parse(localStorage.getItem(UI_SOUND_STORAGE_KEY) || 'null'); } catch { /* storage may be unavailable */ }
  return {
    enabled: parsed?.enabled !== false,
    style: Object.prototype.hasOwnProperty.call(UI_SOUND_STYLES, String(parsed?.style)) ? String(parsed.style) : '1'
  };
}

let uiSoundState = readUiSoundState();
let uiSoundContext = null;
let uiSoundMaster = null;
let uiSoundLastPlayed = Object.create(null);
let uiSoundDragState = null;
const uiSoundVoices = new Set();

function saveUiSoundState() {
  try { localStorage.setItem(UI_SOUND_STORAGE_KEY, JSON.stringify(uiSoundState)); } catch { /* keep runtime behavior if storage is blocked */ }
}

function setUiSoundState(patch = {}) {
  uiSoundState = {
    enabled: patch.enabled === undefined ? uiSoundState.enabled : Boolean(patch.enabled),
    style: Object.prototype.hasOwnProperty.call(UI_SOUND_STYLES, String(patch.style ?? uiSoundState.style))
      ? String(patch.style ?? uiSoundState.style)
      : uiSoundState.style
  };
  saveUiSoundState();
  if (!uiSoundState.enabled) {
    // Disabled means no live audio graph should remain behind the UI.
    uiSoundDragState = null;
    disposeUiSoundContext();
  }
  window.dispatchEvent(new CustomEvent('toolknit-ui-sound-change', { detail: { ...uiSoundState } }));
  return { ...uiSoundState };
}

function ensureUiSoundContext({ userGesture = false } = {}) {
  if (!uiSoundState.enabled || isScreenPickerWindow) return null;
  if (uiSoundContext?.state === 'closed') disposeUiSoundContext();
  if (!userGesture && !uiSoundContext) return null;
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) return null;
  if (!uiSoundContext) {
    let candidateContext = null;
    try {
      candidateContext = new AudioContextClass();
      uiSoundContext = candidateContext;
      uiSoundMaster = uiSoundContext.createGain();
      uiSoundMaster.gain.value = 0.6;
      uiSoundMaster.connect(uiSoundContext.destination);
    } catch {
      try { candidateContext?.close().catch(() => {}); } catch { /* context creation failed */ }
      uiSoundContext = null;
      uiSoundMaster = null;
      return null;
    }
  }
  if (userGesture && uiSoundContext.state === 'suspended') uiSoundContext.resume().catch(() => {});
  return uiSoundContext;
}

function playUiSound(kind = 'hover', { userGesture = false, styleOverride = null, force = false } = {}) {
  if ((!uiSoundState.enabled && !force) || !UI_SOUND_STYLES[styleOverride || uiSoundState.style]?.[kind]) return false;
  const now = performance.now();
  const minInterval = UI_SOUND_MIN_INTERVALS[kind] || 40;
  if (!force && now - (uiSoundLastPlayed[kind] || 0) < minInterval) return false;
  const context = ensureUiSoundContext({ userGesture });
  if (!context || !uiSoundMaster || context.state === 'closed') return false;
  uiSoundLastPlayed[kind] = now;
  const profile = UI_SOUND_STYLES[styleOverride || uiSoundState.style][kind];
  const start = context.currentTime + 0.004;
  profile.forEach(tone => {
    let oscillator = null;
    let gain = null;
    let voice = null;
    const releaseVoice = () => {
      if (voice) uiSoundVoices.delete(voice);
      try { oscillator?.disconnect(); } catch { /* already disconnected */ }
      try { gain?.disconnect(); } catch { /* already disconnected */ }
    };
    try {
      oscillator = context.createOscillator();
      gain = context.createGain();
      voice = { oscillator, gain };
      const duration = Math.max(0.025, Number(tone.duration) || 0.06);
      const volume = Math.max(0.001, Number(tone.volume) || 0.02);
      oscillator.type = tone.waveform || 'sine';
      oscillator.frequency.setValueAtTime(Number(tone.frequency) || 440, start);
      oscillator.frequency.exponentialRampToValueAtTime(Math.max(20, Number(tone.endFrequency) || tone.frequency || 440), start + duration);
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(volume, start + Math.min(0.012, duration * 0.28));
      gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
      oscillator.connect(gain);
      gain.connect(uiSoundMaster);
      uiSoundVoices.add(voice);
      oscillator.addEventListener('ended', releaseVoice, { once: true });
      oscillator.start(start);
      oscillator.stop(start + duration + 0.012);
    } catch {
      releaseVoice();
    }
  });
  return true;
}

function disposeUiSoundContext() {
  const context = uiSoundContext;
  uiSoundVoices.forEach(({ oscillator, gain }) => {
    try { oscillator.stop(); } catch { /* voice may already be stopped */ }
    try { oscillator.disconnect(); } catch { /* already disconnected */ }
    try { gain.disconnect(); } catch { /* already disconnected */ }
  });
  uiSoundVoices.clear();
  try { uiSoundMaster?.disconnect(); } catch { /* already disconnected */ }
  uiSoundMaster = null;
  uiSoundContext = null;
  if (context && context.state !== 'closed') context.close().catch(() => {});
}

function isUiSoundInteractive(target) {
  return target instanceof Element
    && target.closest('button, a, input, select, textarea, summary, [role="button"], [role="switch"], [data-sound-click]');
}

function initUiSoundEvents() {
  if (isScreenPickerWindow) return;
  // WebView/browser autoplay policy requires a real user gesture before
  // an AudioContext may run. Unlock silently on the first normal press so
  // later hover feedback does not depend on clicking a specific control.
  lifecycle.event(document, 'pointerdown', event => {
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest('.no-ui-sound')) return;
    ensureUiSoundContext({ userGesture: true });
  }, { capture: true, passive: true });
  lifecycle.event(document, 'pointerover', event => {
    const target = isUiSoundInteractive(event.target);
    if (!target || target.matches(':disabled,[aria-disabled="true"],.no-ui-sound') || (event.relatedTarget instanceof Node && target.contains(event.relatedTarget))) return;
    // Hover never creates an AudioContext; it becomes active after the first gesture.
    playUiSound('hover');
  }, { passive: true });
  lifecycle.event(document, 'pointerdown', event => {
    const target = event.target instanceof Element ? event.target.closest('input[type="range"], [draggable="true"], [data-sound-slide], .audio-clip-handle') : null;
    if (!target || target.matches(':disabled,[aria-disabled="true"],.no-ui-sound')) return;
    uiSoundDragState = { pointerId: event.pointerId, target, x: event.clientX, y: event.clientY };
    playUiSound('touch', { userGesture: true });
  }, { passive: true });
  lifecycle.event(document, 'pointermove', event => {
    if (!uiSoundDragState || event.pointerId !== uiSoundDragState.pointerId) return;
    const distance = Math.hypot(event.clientX - uiSoundDragState.x, event.clientY - uiSoundDragState.y);
    if (distance < 4) return;
    uiSoundDragState.x = event.clientX;
    uiSoundDragState.y = event.clientY;
    playUiSound('slide');
  }, { passive: true });
  const stopDrag = event => {
    if (uiSoundDragState && (event.pointerId === undefined || event.pointerId === uiSoundDragState.pointerId)) uiSoundDragState = null;
  };
  lifecycle.event(document, 'pointerup', stopDrag, { passive: true });
  lifecycle.event(document, 'pointercancel', stopDrag, { passive: true });
  lifecycle.event(document, 'input', event => {
    if (event.target instanceof HTMLInputElement && event.target.type === 'range') playUiSound('slide', { userGesture: true });
  }, { passive: true });
  lifecycle.event(document, 'dragstart', event => {
    if (event.target instanceof Element && !event.target.closest('.no-ui-sound')) playUiSound('touch', { userGesture: true });
  }, { passive: true });
  const suspendUiSound = () => {
    uiSoundDragState = null;
    if (uiSoundContext?.state === 'running') uiSoundContext.suspend().catch(() => {});
  };
  lifecycle.event(document, 'visibilitychange', () => { if (document.hidden) suspendUiSound(); });
  lifecycle.event(window, 'blur', suspendUiSound, { passive: true });
  const disposeAllAudio = () => {
    disposeUiSoundContext();
  };
  lifecycle.event(window, 'pagehide', disposeAllAudio, { passive: true });
  lifecycle.event(window, 'beforeunload', disposeAllAudio, { passive: true });
}

window.toolknitUiSound = Object.freeze({
  getState: () => ({ ...uiSoundState }),
  setEnabled: enabled => setUiSoundState({ enabled }),
  setStyle: style => setUiSoundState({ style }),
  play: (kind = 'hover', options = {}) => playUiSound(kind, { ...options, userGesture: true }),
  preview: style => playUiSound('hover', { styleOverride: String(style || uiSoundState.style), userGesture: true, force: true })
});
initUiSoundEvents();
return Object.freeze({ dispose: () => lifecycle.dispose() });
}
