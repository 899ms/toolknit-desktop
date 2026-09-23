import { createLifecycleScope } from '../../app/tool-lifecycle.js';
import { tauriCorePromise, tauriEventPromise } from '../../platform/tauri-runtime.js';
import './color-extractor.css';

const LENS_SIZE = 200;
const SAMPLE_INTERVAL_MS = 30;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function frameSize(bounds) {
  return {
    width: window.innerWidth || Number(bounds?.width) || 1,
    height: window.innerHeight || Number(bounds?.height) || 1
  };
}

function createScreenPickerController({ overlay = document.getElementById('screenPickerOverlay') } = {}) {
  const lifecycle = createLifecycleScope({ onError: error => console.warn('[screen-picker] cleanup failed:', error) });
  const canvas = overlay?.querySelector('#screenPickerCanvas');
  const crosshair = overlay?.querySelector('.screen-picker-crosshair');
  const readout = overlay?.querySelector('.screen-picker-readout');
  const readoutSwatch = overlay?.querySelector('#screenPickerReadoutSwatch');
  const readoutHex = overlay?.querySelector('#screenPickerReadoutHex');
  const readoutRgb = overlay?.querySelector('#screenPickerReadoutRgb');
  const finishButton = overlay?.querySelector('#screenPickerFinishBtn');
  const locked = overlay?.querySelector('#screenPickerLocked');

  let bounds = null;
  let scaleX = 1;
  let scaleY = 1;
  let latestSample = null;
  let dragging = false;
  let dragOffsetX = 0;
  let dragOffsetY = 0;
  let sampleTimer = 0;
  let sampleRaf = 0;
  let sampling = false;
  let isLocked = false;
  let closed = false;

  const emit = async (name, payload) => {
    try {
      const { emitTo } = await tauriEventPromise;
      await emitTo('main', name, payload);
    } catch (error) {
      console.warn('[screen-picker] event emit failed:', error);
    }
  };

  function stopSampling() {
    if (sampleTimer) {
      clearTimeout(sampleTimer);
      sampleTimer = 0;
    }
    if (sampleRaf) {
      cancelAnimationFrame(sampleRaf);
      sampleRaf = 0;
    }
  }

  function draw(sample) {
    if (!canvas || !sample?.pixels?.length) return;
    const width = Number(sample.width) || 21;
    const height = Number(sample.height) || 21;
    const context = canvas.getContext('2d');
    if (!context) return;
    if (canvas.width !== LENS_SIZE || canvas.height !== LENS_SIZE) {
      canvas.width = LENS_SIZE;
      canvas.height = LENS_SIZE;
    }
    context.clearRect(0, 0, LENS_SIZE, LENS_SIZE);
    context.imageSmoothingEnabled = false;
    const cellWidth = LENS_SIZE / width;
    const cellHeight = LENS_SIZE / height;
    for (let row = 0; row < height; row += 1) {
      for (let column = 0; column < width; column += 1) {
        const offset = (row * width + column) * 3;
        const red = Number(sample.pixels[offset]) || 0;
        const green = Number(sample.pixels[offset + 1]) || 0;
        const blue = Number(sample.pixels[offset + 2]) || 0;
        context.fillStyle = `rgb(${red}, ${green}, ${blue})`;
        context.fillRect(
          Math.floor(column * cellWidth),
          Math.floor(row * cellHeight),
          Math.ceil(cellWidth) + 1,
          Math.ceil(cellHeight) + 1
        );
      }
    }
    const centerX = (Math.floor(width / 2) + 0.5) * cellWidth;
    const centerY = (Math.floor(height / 2) + 0.5) * cellHeight;
    context.save();
    context.strokeStyle = 'rgba(255,255,255,.95)';
    context.lineWidth = 2;
    context.shadowColor = 'rgba(0,0,0,.85)';
    context.shadowBlur = 2;
    context.beginPath();
    context.moveTo(centerX - 8, centerY);
    context.lineTo(centerX + 8, centerY);
    context.moveTo(centerX, centerY - 8);
    context.lineTo(centerX, centerY + 8);
    context.stroke();
    context.restore();
  }

  function positionLens() {
    if (!crosshair || !bounds || !canvas) return;
    const viewport = frameSize(bounds);
    const localX = Number.parseFloat(crosshair.style.left) || 0;
    const localY = Number.parseFloat(crosshair.style.top) || 0;
    let left = localX + 34;
    let top = localY - LENS_SIZE - 30;
    if (left + LENS_SIZE > viewport.width - 16) left = localX - LENS_SIZE - 34;
    if (top < 16) top = localY + 34;
    left = clamp(left, 16, Math.max(16, viewport.width - LENS_SIZE - 16));
    top = clamp(top, 16, Math.max(16, viewport.height - LENS_SIZE - 16));
    canvas.style.left = `${left}px`;
    canvas.style.top = `${top}px`;
    if (readout) {
      readout.style.left = `${left}px`;
      readout.style.top = `${clamp(top + LENS_SIZE + 12, 16, Math.max(16, viewport.height - 58))}px`;
    }
  }

  function setCrosshair(localX, localY) {
    if (!crosshair) return;
    const viewport = frameSize(bounds);
    crosshair.style.left = `${clamp(localX, 0, viewport.width)}px`;
    crosshair.style.top = `${clamp(localY, 0, viewport.height)}px`;
    positionLens();
  }

  function physicalPoint() {
    if (!crosshair || !bounds) return null;
    const localX = Number.parseFloat(crosshair.style.left) || 0;
    const localY = Number.parseFloat(crosshair.style.top) || 0;
    return {
      x: Math.round((Number(bounds.x) || 0) + localX / scaleX),
      y: Math.round((Number(bounds.y) || 0) + localY / scaleY)
    };
  }

  function applySample(sample) {
    if (!sample) return;
    latestSample = sample;
    draw(sample);
    const hex = String(sample.hex || '#000000').toUpperCase();
    const rgb = String(sample.rgb || 'rgb(0, 0, 0)');
    if (readoutSwatch) readoutSwatch.style.backgroundColor = hex;
    if (readoutHex) readoutHex.textContent = hex;
    if (readoutRgb) readoutRgb.textContent = rgb;
  }

  async function sampleNow() {
    if (sampling || isLocked || closed) return;
    const point = physicalPoint();
    if (!point) return;
    sampling = true;
    if (crosshair) crosshair.style.visibility = 'hidden';
    try {
      const { invoke } = await tauriCorePromise;
      applySample(await invoke('screen_color_sample', point));
    } catch (error) {
      console.warn('[screen-picker] sample failed:', error);
    } finally {
      if (crosshair) crosshair.style.visibility = '';
      sampling = false;
    }
  }

  function scheduleSample() {
    if (closed || isLocked || sampleTimer || sampleRaf) return;
    sampleTimer = window.setTimeout(() => {
      sampleTimer = 0;
      sampleRaf = requestAnimationFrame(() => {
        sampleRaf = 0;
        void sampleNow().finally(scheduleSample);
      });
    }, SAMPLE_INTERVAL_MS);
  }

  function reset(nextBounds = null) {
    if (nextBounds && typeof nextBounds === 'object') bounds = nextBounds;
    if (!bounds || closed) return;
    const viewport = frameSize(bounds);
    scaleX = viewport.width / Math.max(1, Number(bounds.width) || viewport.width);
    scaleY = viewport.height / Math.max(1, Number(bounds.height) || viewport.height);
    isLocked = false;
    latestSample = null;
    if (locked) locked.hidden = true;
    setCrosshair(viewport.width / 2, viewport.height / 2);
    void emit('screen-picker-ready');
    scheduleSample();
  }

  async function pick() {
    if (closed || isLocked) return;
    stopSampling();
    const point = physicalPoint();
    let picked = latestSample;
    if (point) {
      if (crosshair) crosshair.style.visibility = 'hidden';
      try {
        const { invoke } = await tauriCorePromise;
        const sample = await invoke('screen_color_sample', point);
        applySample(sample);
        picked = sample || picked;
      } catch (error) {
        console.warn('[screen-picker] pick failed:', error);
      } finally {
        if (crosshair) crosshair.style.visibility = '';
      }
    }
    isLocked = true;
    if (locked) locked.hidden = false;
    await emit('screen-color-picked', picked);
  }

  async function close(eventName = 'screen-picker-closed') {
    if (closed) return;
    closed = true;
    stopSampling();
    isLocked = false;
    latestSample = null;
    if (locked) locked.hidden = true;
    await emit(eventName);
    try {
      const { invoke } = await tauriCorePromise;
      await invoke('close_screen_color_picker');
    } catch (error) {
      console.warn('[screen-picker] close failed:', error);
    }
  }

  lifecycle.event(crosshair, 'mousedown', event => {
    if (event.button !== 0 || closed) return;
    event.preventDefault();
    event.stopPropagation();
    dragging = true;
    dragOffsetX = event.clientX - (Number.parseFloat(crosshair.style.left) || 0);
    dragOffsetY = event.clientY - (Number.parseFloat(crosshair.style.top) || 0);
    crosshair.classList.add('dragging');
  });
  lifecycle.event(window, 'mousemove', event => {
    if (!dragging || closed) return;
    setCrosshair(event.clientX - dragOffsetX, event.clientY - dragOffsetY);
  }, { passive: true });
  lifecycle.event(window, 'mouseup', event => {
    if (!dragging || event.button !== 0) return;
    dragging = false;
    crosshair?.classList.remove('dragging');
    void pick();
  });
  lifecycle.event(window, 'keydown', event => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    void close('screen-picker-cancelled');
  }, { capture: true });
  lifecycle.event(finishButton, 'click', event => {
    event.preventDefault();
    event.stopPropagation();
    void close();
  });
  lifecycle.event(overlay, 'click', event => {
    if (event.target.closest('#screenPickerFinishBtn')) return;
    if (isLocked || !latestSample) return;
    void pick();
  });

  return {
    async start() {
      if (closed) return;
      const [{ invoke }, { listen }] = await Promise.all([tauriCorePromise, tauriEventPromise]);
      lifecycle.use(await listen('screen-picker-opened', event => {
        // The native window is hidden and reused between picks. Re-open must
        // reactivate this controller before resetting the sampling loop.
        closed = false;
        reset(event?.payload);
      }));
      try { bounds = await invoke('screen_picker_bounds'); } catch (error) { console.warn('[screen-picker] bounds failed:', error); }
      reset(bounds);
    },
    dispose() {
      if (!closed) {
        closed = true;
        stopSampling();
      }
      lifecycle.dispose();
    }
  };
}

export async function bootstrapScreenPickerOverlay({ overlay = document.getElementById('screenPickerOverlay') } = {}) {
  if (!overlay || window.__toolknitScreenPickerBootstrapped) return;
  window.__toolknitScreenPickerBootstrapped = true;
  document.documentElement.dataset.screenPicker = '1';
  overlay.classList.add('visible');
  const controller = createScreenPickerController({ overlay });
  window.addEventListener('pagehide', () => controller.dispose(), { once: true });
  try {
    await controller.start();
  } catch (error) {
    console.error('[screen-picker] bootstrap failed:', error);
    controller.dispose();
  }
}

export { createScreenPickerController };
