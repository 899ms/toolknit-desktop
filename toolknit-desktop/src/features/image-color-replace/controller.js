import { createLifecycleScope } from '../../app/tool-lifecycle.js';
import { tauriCorePromise } from '../../platform/tauri-runtime.js';
import { COLOR_REPLACE_LIMITS, hexToRgb, rgbToHex, sampleRgbaPixel } from './core.js';

export function createImageColorReplaceController({
  overlay,
  notify = (message, options) => window.showToast?.(message, options)
}) {
  const lifecycle = createLifecycleScope();
  const q = selector => overlay.querySelector(selector);
  const canvas = q('[data-cr-canvas]');
  const stage = q('[data-cr-stage]');
  const context = canvas.getContext('2d');
  const previewCanvas = document.createElement('canvas');
  const previewContext = previewCanvas.getContext('2d');
  const resultCanvas = document.createElement('canvas');
  const resultContext = resultCanvas.getContext('2d');

  let disposed = false;
  let active = false;
  let worker = null;
  let workerBusy = false;
  let previewTimer = 0;
  let taskId = 0;
  let lifecycleId = 0;
  let loadId = 0;
  let exportOperationId = '';
  let source = null;
  let previewImageData = null;
  let resultImageData = null;
  let compare = false;
  let eyedropper = true;
  let format = 'png';
  let zoom = 1;
  let pan = { x: 0, y: 0 };
  let drag = null;
  let history = [];

  const state = {
    source: [255, 255, 255],
    target: [45, 122, 210],
    threshold: 20,
    softness: 24,
    smart: true,
    preserveLuminance: true,
    seedX: 0,
    seedY: 0
  };

  async function invoke(command, args) {
    const tauri = await tauriCorePromise;
    return tauri.invoke(command, args);
  }

  async function outputRoot() {
    return (await invoke('get_output_root')) || (await invoke('get_default_output_root'));
  }

  function snapshot() {
    return JSON.stringify(state);
  }

  function pushHistory() {
    const value = snapshot();
    if (history.at(-1) !== value) {
      history.push(value);
      if (history.length > 40) history.shift();
    }
    q('[data-cr-undo]').disabled = history.length < 2;
  }

  function syncLabels() {
    const sourceHex = rgbToHex(state.source);
    const targetHex = rgbToHex(state.target);
    q('[data-cr-source-label]').textContent = sourceHex;
    q('[data-cr-source-swatch]').style.background = sourceHex;
    q('[data-cr-target-label]').textContent = targetHex;
    q('[data-cr-target-swatch]').style.background = targetHex;
    q('[data-cr-threshold-value]').textContent = state.threshold;
    q('[data-cr-softness-value]').textContent = `${state.softness}%`;
    q('[data-cr-warning]').hidden = state.smart;
  }

  function restore(value) {
    Object.assign(state, JSON.parse(value));
    q('[data-cr-threshold]').value = state.threshold;
    q('[data-cr-softness]').value = state.softness;
    q('[data-cr-smart]').checked = state.smart;
    q('[data-cr-luminance]').checked = state.preserveLuminance;
    q('[data-cr-target]').value = rgbToHex(state.target);
    syncLabels();
    schedulePreview();
  }

  function draw() {
    if (!source || !previewImageData) return;
    const rect = stage.getBoundingClientRect();
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    const pixelWidth = Math.max(1, Math.round(rect.width * ratio));
    const pixelHeight = Math.max(1, Math.round(rect.height * ratio));
    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
      canvas.width = pixelWidth;
      canvas.height = pixelHeight;
      canvas.style.width = `${rect.width}px`;
      canvas.style.height = `${rect.height}px`;
    }
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, rect.width, rect.height);
    const drawable = compare || !resultImageData ? previewCanvas : resultCanvas;
    const base = Math.min(
      (rect.width - 48) / source.previewWidth,
      (rect.height - 48) / source.previewHeight
    );
    const scale = base * zoom;
    const width = source.previewWidth * scale;
    const height = source.previewHeight * scale;
    const x = (rect.width - width) / 2 + pan.x;
    const y = (rect.height - height) / 2 + pan.y;
    source.display = { x, y, width, height, scale };
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    context.drawImage(drawable, x, y, width, height);
  }

  function ensureWorker() {
    if (worker) return;
    worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    worker.addEventListener('message', event => {
      if (event.data?.taskId !== taskId || !source) return;
      workerBusy = false;
      q('[data-cr-busy]').hidden = true;
      if (!event.data.ok) {
        notify(`预览失败：${event.data.error}`);
        return;
      }
      resultImageData = new ImageData(
        new Uint8ClampedArray(event.data.buffer),
        source.previewWidth,
        source.previewHeight
      );
      resultCanvas.width = source.previewWidth;
      resultCanvas.height = source.previewHeight;
      resultContext.putImageData(resultImageData, 0, 0);
      draw();
      q('[data-cr-meta]').textContent = `${source.width} × ${source.height} px · 已匹配 ${Number(event.data.changedPixels).toLocaleString()} 个预览像素`;
    });
    worker.addEventListener('error', event => {
      workerBusy = false;
      q('[data-cr-busy]').hidden = true;
      notify(`预览线程异常：${event.message || '无法继续处理'}`);
      worker?.terminate();
      worker = null;
    }, { once: true });
  }

  function schedulePreview(immediate = false) {
    if (!source || !previewImageData) return;
    clearTimeout(previewTimer);
    const requestedTask = ++taskId;
    const run = () => {
      if (!source || !previewImageData) return;
      if (workerBusy) {
        worker?.terminate();
        worker = null;
        workerBusy = false;
      }
      ensureWorker();
      workerBusy = true;
      q('[data-cr-busy]').hidden = false;
      const copy = new Uint8ClampedArray(previewImageData.data);
      worker.postMessage({
        taskId: requestedTask,
        buffer: copy.buffer,
        width: source.previewWidth,
        height: source.previewHeight,
        options: state
      }, [copy.buffer]);
    };
    if (immediate) run();
    else previewTimer = window.setTimeout(run, 60);
  }

  async function load(path) {
    const requestId = ++loadId;
    const sessionId = lifecycleId;
    try {
      const [info] = await invoke('inspect_image_stitch_inputs', { inputPaths: [path] });
      if (requestId !== loadId || sessionId !== lifecycleId) return;
      if (!info) throw new Error('无法读取图片');

      const url = info.preview_data_url || info.previewDataUrl;
      const image = new Image();
      await new Promise((resolve, reject) => {
        image.onload = resolve;
        image.onerror = reject;
        image.src = url;
      });
      if (requestId !== loadId || sessionId !== lifecycleId) {
        image.src = '';
        return;
      }

      const max = COLOR_REPLACE_LIMITS.previewMaxEdge;
      const scale = Math.min(1, max / Math.max(image.naturalWidth, image.naturalHeight));
      const width = Math.max(1, Math.round(image.naturalWidth * scale));
      const height = Math.max(1, Math.round(image.naturalHeight * scale));
      previewCanvas.width = width;
      previewCanvas.height = height;
      previewContext.imageSmoothingEnabled = true;
      previewContext.imageSmoothingQuality = 'medium';
      previewContext.drawImage(image, 0, 0, width, height);
      image.src = '';
      previewImageData = previewContext.getImageData(0, 0, width, height);
      resultImageData = null;
      resultCanvas.width = 1;
      resultCanvas.height = 1;
      source = {
        path,
        name: path.split(/[\\/]/).pop(),
        width: Number(info.width) || width,
        height: Number(info.height) || height,
        previewWidth: width,
        previewHeight: height
      };
      state.seedX = 0;
      state.seedY = 0;
      state.source = sampleRgbaPixel(previewImageData.data, width, height, 0, 0).slice(0, 3);
      history = [];
      pushHistory();
      q('[data-cr-file]').textContent = source.name;
      q('[data-cr-stage]').classList.add('has-image');
      q('[data-cr-export]').disabled = false;
      q('[data-cr-compare]').disabled = false;
      q('[data-cr-reset]').disabled = false;
      zoom = 1;
      pan = { x: 0, y: 0 };
      q('[data-cr-zoom]').value = '100';
      q('[data-cr-zoom-value]').textContent = '100%';
      syncLabels();
      schedulePreview(true);
    } catch (error) {
      if (requestId === loadId && sessionId === lifecycleId) {
        notify(`无法载入图片：${String(error?.message || error)}`);
      }
    }
  }

  async function pick() {
    const sessionId = lifecycleId;
    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const path = await open({
        multiple: false,
        filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp'] }]
      });
      if (sessionId !== lifecycleId || !overlay.classList.contains('visible')) return;
      if (typeof path === 'string') await load(path);
    } catch (error) {
      if (sessionId === lifecycleId) {
        notify(`无法选择图片：${String(error?.message || error)}`);
      }
    }
  }

  function showExportResult(outputPath) {
    const rawPath = String(outputPath || '').trim();
    const path = rawPath.startsWith('\\\\?\\') ? rawPath.slice(4) : rawPath;
    if (!path) return;
    const toast = notify(`图片已导出：${path}`, {
      duration: 12000,
      className: 'color-replace-export-toast'
    });
    const message = toast?.el?.querySelector?.('.app-toast-message');
    if (!message) return;
    message.textContent = '图片已导出：';
    const link = document.createElement('a');
    link.className = 'color-replace-output-link';
    link.href = '#';
    link.textContent = path;
    link.title = '在文件管理器中打开所在文件夹';
    link.addEventListener('click', async event => {
      event.preventDefault();
      try {
        await invoke('open_path', { path });
      } catch (error) {
        notify(`打开文件夹失败：${String(error?.message || error)}`);
      }
    });
    message.appendChild(link);
  }

  function canvasPoint(event) {
    const box = canvas.getBoundingClientRect();
    return { x: event.clientX - box.left, y: event.clientY - box.top };
  }

  function sample(event) {
    if (!source?.display || !eyedropper) return;
    const point = canvasPoint(event);
    const px = Math.floor((point.x - source.display.x) / source.display.scale);
    const py = Math.floor((point.y - source.display.y) / source.display.scale);
    if (px < 0 || py < 0 || px >= source.previewWidth || py >= source.previewHeight) return;
    state.seedX = px;
    state.seedY = py;
    state.source = sampleRgbaPixel(
      previewImageData.data,
      source.previewWidth,
      source.previewHeight,
      px,
      py
    ).slice(0, 3);
    pushHistory();
    syncLabels();
    schedulePreview();
  }

  function releaseCompare() {
    compare = false;
    draw();
  }

  function handleOverlayClick(event) {
    if (event.target.closest('[data-cr-pick]')) void pick();
    if (event.target.closest('[data-cr-eyedropper]')) {
      eyedropper = !eyedropper;
      q('[data-cr-eyedropper]').classList.toggle('is-active', eyedropper);
      canvas.classList.toggle('is-eyedropper', eyedropper);
    }

    const formatButton = event.target.closest('[data-cr-formats] button');
    if (formatButton) {
      format = formatButton.dataset.format;
      overlay.querySelectorAll('[data-cr-formats] button').forEach(item => {
        item.classList.toggle('is-active', item === formatButton);
      });
      q('[data-cr-quality]').hidden = format !== 'jpg';
    }

    if (event.target.closest('[data-cr-undo]') && history.length > 1) {
      history.pop();
      restore(history.at(-1));
      q('[data-cr-undo]').disabled = history.length < 2;
    }

    if (event.target.closest('[data-cr-reset]') && source) {
      Object.assign(state, {
        source: sampleRgbaPixel(
          previewImageData.data,
          source.previewWidth,
          source.previewHeight,
          0,
          0
        ).slice(0, 3),
        target: [45, 122, 210],
        threshold: 20,
        softness: 24,
        smart: true,
        preserveLuminance: true,
        seedX: 0,
        seedY: 0
      });
      pushHistory();
      restore(snapshot());
    }

    if (event.target.closest('[data-cr-export]')) void exportImage();
  }

  async function exportImage() {
    if (!source || exportOperationId) return;
    const sessionId = lifecycleId;
    const operationId = crypto.randomUUID();
    exportOperationId = operationId;
    const button = q('[data-cr-export]');
    button.disabled = true;
    button.classList.add('is-busy');
    try {
      const root = await outputRoot();
      if (sessionId !== lifecycleId) return;
      const seedX = Math.min(
        source.width - 1,
        Math.max(0, Math.floor((state.seedX + 0.5) / source.previewWidth * source.width))
      );
      const seedY = Math.min(
        source.height - 1,
        Math.max(0, Math.floor((state.seedY + 0.5) / source.previewHeight * source.height))
      );
      const result = await invoke('export_replaced_image', {
        inputPath: source.path,
        outputDir: `${root}\\Images\\Color Replace`,
        outputName: `${source.name.replace(/\.[^.]+$/, '')}_recolor`,
        sourceRgb: state.source,
        targetRgb: state.target,
        threshold: state.threshold,
        seedX,
        seedY,
        smart: state.smart,
        softness: state.softness,
        preserveLuminance: state.preserveLuminance,
        format,
        jpegQuality: Number(q('[data-cr-quality-input]').value) || 92,
        operationId
      });
      if (sessionId === lifecycleId) {
        showExportResult(result.output_path || result.outputPath);
      }
    } catch (error) {
      const message = String(error?.message || error);
      if (sessionId === lifecycleId && !message.includes('tool-operation:cancelled')) {
        notify(`导出失败：${message.replace('color-replace:', '')}`);
      }
    } finally {
      if (exportOperationId === operationId) exportOperationId = '';
      if (sessionId === lifecycleId) {
        button.disabled = !source;
        button.classList.remove('is-busy');
      }
    }
  }

  lifecycle.event(overlay, 'click', handleOverlayClick);
  lifecycle.event(q('[data-cr-target]'), 'input', event => {
    state.target = hexToRgb(event.target.value);
    syncLabels();
    schedulePreview();
  });
  lifecycle.event(q('[data-cr-target]'), 'change', pushHistory);

  for (const [attribute, key] of [['threshold', 'threshold'], ['softness', 'softness']]) {
    const input = q(`[data-cr-${attribute}]`);
    lifecycle.event(input, 'input', event => {
      state[key] = Number(event.target.value);
      syncLabels();
      schedulePreview();
    });
    lifecycle.event(input, 'change', pushHistory);
  }

  lifecycle.event(q('[data-cr-smart]'), 'change', event => {
    state.smart = event.target.checked;
    pushHistory();
    syncLabels();
    schedulePreview();
  });
  lifecycle.event(q('[data-cr-luminance]'), 'change', event => {
    state.preserveLuminance = event.target.checked;
    pushHistory();
    schedulePreview();
  });
  lifecycle.event(q('[data-cr-zoom]'), 'input', event => {
    zoom = Number(event.target.value) / 100;
    q('[data-cr-zoom-value]').textContent = `${event.target.value}%`;
    draw();
  });
  lifecycle.event(q('[data-cr-quality-input]'), 'input', event => {
    q('[data-cr-quality-value]').textContent = event.target.value;
  });
  lifecycle.event(q('[data-cr-compare]'), 'pointerdown', event => {
    event.currentTarget.setPointerCapture(event.pointerId);
    compare = true;
    draw();
  });
  lifecycle.event(q('[data-cr-compare]'), 'pointerup', releaseCompare);
  lifecycle.event(q('[data-cr-compare]'), 'pointercancel', releaseCompare);
  lifecycle.event(canvas, 'click', sample);
  lifecycle.event(canvas, 'pointerdown', event => {
    if (eyedropper) return;
    drag = { point: canvasPoint(event), pan: { ...pan } };
    canvas.setPointerCapture(event.pointerId);
  });
  lifecycle.event(canvas, 'pointermove', event => {
    if (!drag) return;
    const point = canvasPoint(event);
    pan = {
      x: drag.pan.x + point.x - drag.point.x,
      y: drag.pan.y + point.y - drag.point.y
    };
    draw();
  });
  const releaseDrag = () => { drag = null; };
  lifecycle.event(canvas, 'pointerup', releaseDrag);
  lifecycle.event(canvas, 'pointercancel', releaseDrag);
  lifecycle.event(canvas, 'lostpointercapture', releaseDrag);
  lifecycle.event(canvas, 'wheel', event => {
    if (!source) return;
    event.preventDefault();
    zoom = Math.max(0.5, Math.min(3, zoom * (event.deltaY > 0 ? 0.9 : 1.1)));
    const value = String(Math.round(zoom * 100));
    q('[data-cr-zoom]').value = value;
    q('[data-cr-zoom-value]').textContent = `${value}%`;
    draw();
  }, { passive: false });

  const resizeObserver = new ResizeObserver(() => {
    if (overlay.classList.contains('visible')) draw();
  });

  function open() {
    if (disposed || active) return;
    active = true;
    lifecycleId += 1;
    q('[data-cr-busy]').hidden = true;
    resizeObserver.observe(stage);
    eyedropper = true;
    q('[data-cr-eyedropper]').classList.add('is-active');
    canvas.classList.add('is-eyedropper');
    window.requestAnimationFrame(draw);
  }

  function close() {
    if (!active) return;
    active = false;
    lifecycleId += 1;
    loadId += 1;
    clearTimeout(previewTimer);
    previewTimer = 0;
    taskId += 1;
    worker?.terminate();
    worker = null;
    workerBusy = false;
    if (exportOperationId) {
      const operationId = exportOperationId;
      exportOperationId = '';
      void invoke('cancel_tool_operation', { operationId }).catch(() => {});
    }
    resizeObserver.disconnect();
    previewImageData = null;
    resultImageData = null;
    source = null;
    history = [];
    drag = null;
    compare = false;
    previewCanvas.width = 1;
    previewCanvas.height = 1;
    resultCanvas.width = 1;
    resultCanvas.height = 1;
    canvas.width = 1;
    canvas.height = 1;
    q('[data-cr-busy]').hidden = true;
    q('[data-cr-stage]').classList.remove('has-image');
    q('[data-cr-file]').textContent = '等待载入图片';
    q('[data-cr-meta]').textContent = 'PNG / JPG / WebP / BMP';
    q('[data-cr-export]').disabled = true;
    q('[data-cr-export]').classList.remove('is-busy');
    q('[data-cr-compare]').disabled = true;
    q('[data-cr-reset]').disabled = true;
    q('[data-cr-undo]').disabled = true;
  }

  function dispose() {
    if (disposed) return;
    close();
    disposed = true;
    lifecycle.dispose();
    resizeObserver.disconnect();
  }

  syncLabels();
  return { open, close, dispose };
}
