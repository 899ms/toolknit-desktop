import { createIcons, icons } from 'lucide';
import * as tauriCore from '@tauri-apps/api/core';
import { onLangChange, t } from './i18n.js';
import { enhanceToolSelects } from './tool-custom-select.js';
import {
  commitEditStroke,
  createEditHistory,
  joinNativePath,
  parentDirectoryFromPath,
  redoEditStroke,
  resetEditHistory,
  selectInstalledModels,
  transitionBgRemovalState,
  undoEditStroke
} from './bg-removal-core.js';

const PREF_KEY = 'toolknit.bgremoval.preferences.v2';
const MAX_PREVIEW_EDGE = 4096;

function readPreferences() {
  try {
    const value = JSON.parse(localStorage.getItem(PREF_KEY) || '{}');
    return {
      modelId: typeof value.modelId === 'string' ? value.modelId : '',
      feather: Number.isFinite(Number(value.feather)) ? Number(value.feather) : 1.2,
      brushSize: Number.isFinite(Number(value.brushSize)) ? Number(value.brushSize) : 36
    };
  } catch {
    return { modelId: '', feather: 1.2, brushSize: 36 };
  }
}

function mimeFor(path) {
  return /\.jpe?g$/i.test(path) ? 'image/jpeg'
    : /\.webp$/i.test(path) ? 'image/webp'
      : /\.bmp$/i.test(path) ? 'image/bmp'
        : 'image/png';
}

function fileNameFromPath(path) {
  return String(path || '').split(/[\\/]/).pop() || '';
}

function fileStem(path) {
  return (fileNameFromPath(path) || 'cutout').replace(/\.[^.]+$/, '');
}

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(value >= 10 * 1024 * 1024 ? 0 : 1)} MB`;
}

function isEditableTarget(target) {
  const tag = target?.tagName?.toLowerCase();
  return ['input', 'textarea', 'select'].includes(tag) || Boolean(target?.isContentEditable);
}

function htmlTemplate() {
  return `
    <div class="plasma-bg bg-removal-bg" data-bgr-bg></div>
    <header class="pdf-merge-v2-topbar bg-removal-topbar" data-tauri-drag-region>
      <div class="pdf-merge-v2-topbar-left">
        <button class="settings-v2-back settings-back pdf-merge-v2-back" type="button" data-bgr-action="back" data-bgr-title="backTitle" title="返回">
          <i data-lucide="arrow-left"></i><span data-bgr-text="backTitle">返回</span>
        </button>
        <span class="pdf-merge-v2-top-tag">BACKGROUND REMOVAL · TOOL PAGE 2.3</span>
      </div>
      <div class="home-v2-top-actions pdf-merge-v2-top-actions">
        <button class="home-v2-nav-link" type="button" data-bgr-action="website" data-bgr-title="website">
          <i data-lucide="globe-2"></i><span data-bgr-text="website">网页版本</span>
        </button>
        <button class="home-v2-support-top" type="button" data-bgr-action="support">
          <i data-lucide="heart"></i><span data-bgr-text="support">支持作者</span>
        </button>
        <div class="home-v2-window-cluster" aria-label="窗口与设置">
          <button class="home-v2-icon-button" type="button" data-bgr-action="settings" data-bgr-title="settingsTitle"><i data-lucide="settings"></i></button>
          <div class="home-v2-window-controls" aria-label="窗口控制">
            <button class="home-v2-window-button" type="button" data-window-action="minimize" data-bgr-title="minimize"><i data-lucide="minus"></i></button>
            <button class="home-v2-window-button" type="button" data-window-action="maximize" data-bgr-title="maximize"><i data-lucide="square"></i></button>
            <button class="home-v2-window-button" type="button" data-window-action="close" data-bgr-title="close"><i data-lucide="x"></i></button>
          </div>
        </div>
      </div>
    </header>

    <div class="bg-removal-body" data-bgr-body>
      <button class="bg-removal-drawer-scrim" type="button" data-bgr-action="close-params" data-bgr-title="closeParams" tabindex="-1" hidden></button>
      <aside class="bg-removal-panel" data-bgr-params data-bgr-title="params" aria-label="处理参数">
        <div class="bg-removal-drawer-head">
          <span data-bgr-text="params">处理参数</span>
          <button class="bg-removal-icon-button" type="button" data-bgr-action="close-params" data-bgr-title="closeParams"><i data-lucide="x"></i></button>
        </div>
        <div class="bg-removal-intro">
          <span class="bg-removal-kicker">IMAGE TOOL / AI CUTOUT</span>
          <h1 class="bg-removal-title" data-bgr-text="title">背景移除</h1>
          <p class="bg-removal-subtitle" data-bgr-text="subtitle">AI 一键抠出主体，发丝级边缘，导出透明 PNG。</p>
        </div>
        <div class="bg-removal-note">
          <i data-lucide="shield-check"></i>
          <span data-bgr-text="localNote">推理在本机完成，照片不会上传。</span>
        </div>

        <section class="bg-removal-file-section" aria-labelledby="bgRemovalFileHeading">
          <div class="bg-removal-section-row">
            <span id="bgRemovalFileHeading" class="bg-removal-field-label" data-bgr-text="fileInfo">图片信息</span>
            <span class="bg-removal-file-badge" data-bgr-file-badge>—</span>
          </div>
          <div class="bg-removal-file-empty" data-bgr-file-empty data-bgr-text="noImage">尚未选择图片</div>
          <dl class="bg-removal-file-details" data-bgr-file-details hidden>
            <div><dt data-bgr-text="imageName">文件</dt><dd data-bgr-file-name></dd></div>
            <div><dt data-bgr-text="imageSize">尺寸</dt><dd data-bgr-file-size></dd></div>
            <div><dt data-bgr-text="fileSize">大小</dt><dd data-bgr-file-bytes></dd></div>
          </dl>
          <button class="bg-removal-upload" type="button" data-bgr-action="upload">
            <i data-lucide="image-up"></i><span data-bgr-upload-label data-bgr-text="upload">选择图片</span>
          </button>
        </section>

        <section class="bg-removal-parameters">
          <div>
            <div class="bg-removal-section-row">
              <label class="bg-removal-field-label" for="bgRemovalModel" data-bgr-text="modelLabel">抠图模型</label>
              <button class="bg-removal-link-button" type="button" data-bgr-action="manage-models">
                <i data-lucide="box"></i><span data-bgr-text="manageModels">管理模型</span>
              </button>
            </div>
            <select id="bgRemovalModel" class="bg-removal-select" data-bgr-model></select>
          </div>
          <div>
            <label class="bg-removal-field-label" for="bgRemovalFeather" data-bgr-text="featherLabel">边缘羽化</label>
            <div class="bg-removal-slider-row">
              <input id="bgRemovalFeather" class="bg-removal-slider" data-bgr-feather type="range" min="0" max="8" step="0.2" value="1.2">
              <span class="bg-removal-slider-value" data-bgr-feather-value>1.2px</span>
            </div>
          </div>
        </section>

        <div class="bg-removal-status" data-bgr-status data-state="idle" role="status" aria-live="polite"><span></span></div>
        <button class="bg-removal-process" type="button" data-bgr-action="process" disabled>
          <i data-lucide="wand-sparkles"></i><span data-bgr-process-label data-bgr-text="startCutout">开始抠图</span>
        </button>
      </aside>

      <main class="bg-removal-stage">
        <div class="bg-removal-panel-head">
          <div><span class="bg-removal-section-kicker">AI CUTOUT</span><h2 data-bgr-text="previewTitle">透明预览</h2></div>
          <button class="bg-removal-params-button" type="button" data-bgr-action="open-params">
            <i data-lucide="sliders-horizontal"></i><span data-bgr-text="params">处理参数</span>
          </button>
        </div>

        <div class="bg-removal-screen" data-bgr-screen data-state="empty" data-processed="false">
          <div class="bg-removal-viewport" data-bgr-viewport>
            <div class="bg-removal-canvas-stack" data-bgr-canvas-stack hidden>
              <canvas class="bg-removal-canvas-original" data-bgr-canvas-original></canvas>
              <canvas class="bg-removal-canvas-result" data-bgr-canvas-result></canvas>
            </div>
          </div>

          <button class="bg-removal-empty" type="button" data-bgr-empty data-bgr-action="upload">
            <span class="bg-removal-empty-icon"><i data-lucide="image-up"></i></span>
            <strong data-bgr-text="emptyTitle">选择一张图片开始</strong>
            <span data-bgr-text="emptyDesc">支持 JPG、PNG、WebP、BMP，也可以直接拖入。</span>
            <em data-bgr-text="emptyAction">选择图片</em>
          </button>

          <div class="bg-removal-progress" data-bgr-progress hidden>
            <span class="bg-removal-spinner" aria-hidden="true"></span>
            <strong data-bgr-progress-title></strong>
            <span data-bgr-text="processingHint">推理完全在本机进行，请保持窗口开启。</span>
          </div>

          <div class="bg-removal-toolbar" data-bgr-toolbar hidden>
            <button class="bg-removal-tool-btn" type="button" data-bgr-tool="pan" data-bgr-title="pan"><i data-lucide="hand"></i></button>
            <span class="bg-removal-tool-divider"></span>
            <button class="bg-removal-tool-btn" type="button" data-bgr-tool="restore" data-bgr-title="restore"><i data-lucide="brush"></i></button>
            <button class="bg-removal-tool-btn" type="button" data-bgr-tool="erase" data-bgr-title="erase"><i data-lucide="eraser"></i></button>
            <span class="bg-removal-tool-divider"></span>
            <button class="bg-removal-tool-btn" type="button" data-bgr-action="undo" data-bgr-title="undo"><i data-lucide="undo-2"></i></button>
            <button class="bg-removal-tool-btn" type="button" data-bgr-action="redo" data-bgr-title="redo"><i data-lucide="redo-2"></i></button>
            <button class="bg-removal-tool-btn" type="button" data-bgr-action="reset-edits" data-bgr-title="resetEdits"><i data-lucide="rotate-ccw"></i></button>
            <div class="bg-removal-brush-wrap" data-bgr-brush-wrap>
              <button class="bg-removal-tool-btn is-size" type="button" data-bgr-action="brush-size" data-bgr-title="brushSize"><i data-lucide="circle"></i></button>
              <div class="bg-removal-brush-pop" data-bgr-brush-pop hidden>
                <span data-bgr-text="brushSize">笔刷粗细</span>
                <input class="bg-removal-slider" data-bgr-brush-size type="range" min="4" max="160" step="2" value="36">
                <span class="bg-removal-slider-value" data-bgr-brush-size-value>36px</span>
              </div>
            </div>
          </div>

          <div class="bg-removal-zoombar" data-bgr-zoombar hidden>
            <button class="bg-removal-tool-btn" type="button" data-bgr-action="zoom-out" data-bgr-title="zoomOut"><i data-lucide="minus"></i></button>
            <span class="bg-removal-zoom-value" data-bgr-zoom-value>100%</span>
            <button class="bg-removal-tool-btn" type="button" data-bgr-action="zoom-in" data-bgr-title="zoomIn"><i data-lucide="plus"></i></button>
            <button class="bg-removal-tool-btn" type="button" data-bgr-action="zoom-fit" data-bgr-title="zoomFit"><i data-lucide="scan"></i></button>
            <span class="bg-removal-tool-divider"></span>
            <button class="bg-removal-tool-btn is-compare" type="button" data-bgr-action="compare" data-bgr-title="holdCompare" aria-pressed="false"><i data-lucide="eye"></i></button>
          </div>
        </div>

        <footer class="bg-removal-footer">
          <button class="bg-removal-small-button is-primary" type="button" data-bgr-action="save" hidden>
            <i data-lucide="download"></i><span data-bgr-save-label data-bgr-text="savePng">保存透明 PNG</span>
          </button>
        </footer>
      </main>
    </div>

    <div class="audio-clip-success-overlay bg-removal-success-overlay" data-bgr-success aria-hidden="true" inert>
      <div class="audio-clip-success-dialog" role="dialog" aria-modal="true" aria-labelledby="bgRemovalSuccessTitle">
        <div class="audio-clip-success-icon"><i data-lucide="check"></i></div>
        <h3 class="audio-clip-success-title" id="bgRemovalSuccessTitle" data-bgr-text="doneTitle">背景移除完成</h3>
        <div class="audio-clip-success-meta" data-bgr-text="doneMeta">透明 PNG 已保存到本机。</div>
        <div class="audio-convert-success-detail">
          <div class="audio-convert-success-row">
            <span class="audio-convert-success-key" data-bgr-text="doneFileLabel">输出文件</span>
            <span class="audio-convert-success-value" data-bgr-success-file></span>
          </div>
          <div class="audio-convert-success-row">
            <span class="audio-convert-success-key" data-bgr-text="donePathLabel">保存路径</span>
            <span class="audio-convert-success-value" data-bgr-success-path></span>
          </div>
        </div>
        <div class="audio-clip-success-actions">
          <button class="audio-clip-success-btn audio-clip-success-btn-secondary" type="button" data-bgr-action="open-folder" data-bgr-text="openFolder">打开文件夹</button>
          <button class="audio-clip-success-btn audio-clip-success-btn-primary" type="button" data-bgr-action="success-ok" data-bgr-text="ok">确定</button>
        </div>
      </div>
    </div>
  `;
}

export function initBgRemovalTool({
  overlay,
  notify = () => {},
  isTauri = false,
  initStandardToolPlasma,
  disposeStandardToolPlasma,
  openSettings,
  openMattingModelManager,
  openSupport,
  openExternalUrl,
  handleWindowAction
} = {}) {
  if (!overlay) return { open() {}, close() {}, dispose() {} };

  overlay.innerHTML = htmlTemplate();
  overlay.classList.add('bg-removal-overlay');

  const query = selector => overlay.querySelector(selector);
  const listeners = new AbortController();
  const listenerOptions = { signal: listeners.signal };
  const bg = query('[data-bgr-bg]');
  const body = query('[data-bgr-body]');
  const paramsPanel = query('[data-bgr-params]');
  const drawerScrim = query('.bg-removal-drawer-scrim');
  const screen = query('[data-bgr-screen]');
  const viewport = query('[data-bgr-viewport]');
  const canvasStack = query('[data-bgr-canvas-stack]');
  const originalDisplayCanvas = query('[data-bgr-canvas-original]');
  const resultCanvas = query('[data-bgr-canvas-result]');
  const empty = query('[data-bgr-empty]');
  const progress = query('[data-bgr-progress]');
  const progressTitle = query('[data-bgr-progress-title]');
  const statusEl = query('[data-bgr-status]');
  const statusText = statusEl?.querySelector('span');
  const modelSelect = query('[data-bgr-model]');
  const modelSelectControl = enhanceToolSelects([modelSelect])[0] || null;
  const featherInput = query('[data-bgr-feather]');
  const featherValue = query('[data-bgr-feather-value]');
  const brushSizeInput = query('[data-bgr-brush-size]');
  const brushSizeValue = query('[data-bgr-brush-size-value]');
  const brushPop = query('[data-bgr-brush-pop]');
  const toolbar = query('[data-bgr-toolbar]');
  const zoombar = query('[data-bgr-zoombar]');
  const zoomValue = query('[data-bgr-zoom-value]');
  const processButton = query('[data-bgr-action="process"]');
  const processLabel = query('[data-bgr-process-label]');
  const saveButton = query('[data-bgr-action="save"]');
  const saveLabel = query('[data-bgr-save-label]');
  const successOverlay = query('[data-bgr-success]');
  const successFile = query('[data-bgr-success-file]');
  const successPath = query('[data-bgr-success-path]');
  const successOk = query('[data-bgr-action="success-ok"]');
  const fileEmpty = query('[data-bgr-file-empty]');
  const fileDetails = query('[data-bgr-file-details]');
  const fileBadge = query('[data-bgr-file-badge]');
  const fileNameEl = query('[data-bgr-file-name]');
  const fileSizeEl = query('[data-bgr-file-size]');
  const fileBytesEl = query('[data-bgr-file-bytes]');
  const uploadLabel = query('[data-bgr-upload-label]');
  const compareButton = query('[data-bgr-action="compare"]');

  const originalDisplayCtx = originalDisplayCanvas.getContext('2d');
  const resultCtx = resultCanvas.getContext('2d');
  const sourceCanvas = document.createElement('canvas');
  const sourceCtx = sourceCanvas.getContext('2d');
  const rawMask = document.createElement('canvas');
  const rawMaskCtx = rawMask.getContext('2d');
  const featheredMask = document.createElement('canvas');
  const featheredMaskCtx = featheredMask.getContext('2d');
  const workMask = document.createElement('canvas');
  const workMaskCtx = workMask.getContext('2d');

  const preferences = readPreferences();
  featherInput.value = String(Math.min(8, Math.max(0, preferences.feather)));
  brushSizeInput.value = String(Math.min(160, Math.max(4, preferences.brushSize)));

  let disposed = false;
  let plasmaInstance = null;
  let nativeDragUnlisten = null;
  let languageUnsubscribe = () => {};
  let resizeObserver = null;
  let state = 'empty';
  let stableState = 'empty';
  let statusKey = 'statusIdle';
  let statusParams;
  let operationKind = '';
  let models = [];
  let installedModels = [];
  let currentImagePath = '';
  let currentFileBytes = 0;
  let sourceWidth = 0;
  let sourceHeight = 0;
  let imageWidth = 0;
  let imageHeight = 0;
  let outputDir = '';
  let processed = false;
  let savedPath = '';
  let dirty = false;
  let segmentRequestSequence = 0;
  let activeSegmentRequest = 0;
  let operationEpoch = 0;
  let paramsOpen = false;
  let featherRenderFrame = 0;

  let view = { scale: 1, x: 0, y: 0, fit: true };
  let activeTool = 'pan';
  let brushSize = Number(brushSizeInput.value);
  let painting = false;
  let activeStroke = null;
  let panning = false;
  let panStart = null;
  let compareHeld = false;
  const history = createEditHistory();

  function copy(key, params) {
    return t(`home.bgRemoval.${key}`, params);
  }

  function persistPreferences() {
    try { localStorage.setItem(PREF_KEY, JSON.stringify(preferences)); } catch {}
  }

  function isBusy() {
    return state === 'processing' || state === 'saving';
  }

  function setStatus(kind, key, params) {
    statusKey = key;
    statusParams = params;
    if (!statusEl || !statusText) return;
    statusEl.dataset.state = kind;
    statusText.textContent = copy(key, params);
  }

  function setState(next, key, params, { status = 'idle' } = {}) {
    try {
      state = transitionBgRemovalState(state, next);
    } catch (error) {
      console.error('[BgRemoval] state transition failed:', error);
      state = next;
    }
    if (['empty', 'ready', 'editing', 'saved'].includes(next)) stableState = next;
    if (key) setStatus(status, key, params);
    renderState();
  }

  function safeFocus(element) {
    try { element?.focus?.({ preventScroll: true }); } catch {}
  }

  function setSuccessState(visible, { restoreFocus = true } = {}) {
    successOverlay?.classList.toggle('visible', visible);
    successOverlay?.setAttribute('aria-hidden', visible ? 'false' : 'true');
    if (visible) {
      successOverlay?.removeAttribute('inert');
      safeFocus(successOk);
    } else {
      successOverlay?.setAttribute('inert', '');
      if (restoreFocus) safeFocus(processButton);
    }
  }

  function renderSuccess() {
    if (!savedPath) return;
    if (successFile) {
      successFile.textContent = fileNameFromPath(savedPath);
      successFile.title = savedPath;
    }
    if (successPath) {
      const actualDirectory = parentDirectoryFromPath(savedPath);
      successPath.textContent = actualDirectory;
      successPath.title = actualDirectory;
    }
  }

  function renderLocale() {
    overlay.querySelectorAll('[data-bgr-text]').forEach(element => {
      element.textContent = copy(element.dataset.bgrText);
    });
    overlay.querySelectorAll('[data-bgr-title]').forEach(element => {
      const label = copy(element.dataset.bgrTitle);
      element.title = label;
      element.setAttribute('aria-label', label);
    });
    renderModels();
    setStatus(statusEl?.dataset.state || 'idle', statusKey, statusParams);
    renderState();
    if (savedPath) renderSuccess();
  }

  function renderModels() {
    if (!modelSelect) return;
    const selectedBefore = modelSelect.value || preferences.modelId;
    const selection = selectInstalledModels(models, selectedBefore);
    installedModels = selection.installed;
    modelSelect.replaceChildren();
    if (!installedModels.length) {
      const option = document.createElement('option');
      option.value = '';
      option.textContent = copy('noInstalledModels');
      modelSelect.append(option);
      modelSelect.value = '';
      modelSelectControl?.refresh();
      return;
    }
    for (const model of installedModels) {
      const option = document.createElement('option');
      option.value = model.id;
      option.textContent = `${model.display_name} · ${Math.round(model.bytes / 1024 / 1024)} MB`;
      modelSelect.append(option);
    }
    modelSelect.value = selection.preferred?.id || installedModels[0].id;
    preferences.modelId = modelSelect.value;
    persistPreferences();
    modelSelectControl?.refresh();
  }

  async function refreshModels() {
    if (!isTauri) {
      models = [];
      renderModels();
      renderState();
      return;
    }
    try {
      models = await tauriCore.invoke('list_matting_models');
      renderModels();
      if (!installedModels.length && currentImagePath) setStatus('error', 'modelMissing');
    } catch (error) {
      console.error('[BgRemoval] cannot list models:', error);
      models = [];
      renderModels();
    }
    renderState();
  }

  function updateFileInfo() {
    const hasImage = Boolean(currentImagePath && imageWidth && imageHeight);
    fileEmpty.hidden = hasImage;
    fileDetails.hidden = !hasImage;
    fileBadge.textContent = hasImage ? fileNameFromPath(currentImagePath).split('.').pop()?.toUpperCase() || 'IMG' : '—';
    if (!hasImage) return;
    fileNameEl.textContent = fileNameFromPath(currentImagePath);
    fileNameEl.title = currentImagePath;
    fileSizeEl.textContent = `${sourceWidth} × ${sourceHeight}`;
    fileBytesEl.textContent = formatBytes(currentFileBytes);
  }

  function renderState() {
    const hasImage = Boolean(currentImagePath && imageWidth && imageHeight);
    const busy = isBusy();
    overlay.dataset.bgRemovalState = state;
    screen.dataset.state = state;
    screen.dataset.processed = String(processed);
    canvasStack.hidden = !hasImage;
    empty.hidden = hasImage;
    progress.hidden = state !== 'processing';
    toolbar.hidden = !processed || busy;
    zoombar.hidden = !hasImage || state === 'processing';
    processButton.disabled = !hasImage || busy || !installedModels.length || !isTauri;
    modelSelect.disabled = busy || !installedModels.length;
    modelSelectControl?.refresh();
    featherInput.disabled = busy || !hasImage;
    saveButton.hidden = !processed;
    saveButton.disabled = busy || !outputDir || (!dirty && state === 'saved');
    processLabel.textContent = copy(processed ? 'rerun' : 'startCutout');
    saveLabel.textContent = copy(state === 'saving' ? 'saving' : 'savePng');
    uploadLabel.textContent = copy(hasImage ? 'chooseAnother' : 'upload');
    progressTitle.textContent = copy(operationKind === 'loading' ? 'loading' : 'processing');
    paramsPanel.classList.toggle('is-open', paramsOpen);
    body.classList.toggle('is-params-open', paramsOpen);
    drawerScrim.hidden = !paramsOpen;
    updateFileInfo();
    updateHistoryButtons();
  }

  function updateHistoryButtons() {
    const undoButton = query('[data-bgr-action="undo"]');
    const redoButton = query('[data-bgr-action="redo"]');
    if (undoButton) undoButton.disabled = !history.strokes.length || isBusy();
    if (redoButton) redoButton.disabled = !history.redo.length || isBusy();
  }

  function sizeCanvases(width, height) {
    [originalDisplayCanvas, resultCanvas, sourceCanvas, rawMask, featheredMask, workMask].forEach(canvas => {
      canvas.width = width;
      canvas.height = height;
    });
    canvasStack.style.width = `${width}px`;
    canvasStack.style.height = `${height}px`;
  }

  function bakeOriginal(bitmap) {
    sourceCtx.clearRect(0, 0, imageWidth, imageHeight);
    originalDisplayCtx.clearRect(0, 0, imageWidth, imageHeight);
    sourceCtx.drawImage(bitmap, 0, 0, imageWidth, imageHeight);
    originalDisplayCtx.drawImage(sourceCanvas, 0, 0);
  }

  function renderResult() {
    resultCtx.clearRect(0, 0, imageWidth, imageHeight);
    resultCtx.drawImage(sourceCanvas, 0, 0);
    resultCtx.globalCompositeOperation = 'destination-in';
    resultCtx.drawImage(workMask, 0, 0);
    resultCtx.globalCompositeOperation = 'source-over';
  }

  function renderResultRegion(from, to, radius) {
    const padding = Math.max(2, radius + 2);
    const left = Math.max(0, Math.floor(Math.min(from.x, to.x) - padding));
    const top = Math.max(0, Math.floor(Math.min(from.y, to.y) - padding));
    const right = Math.min(imageWidth, Math.ceil(Math.max(from.x, to.x) + padding));
    const bottom = Math.min(imageHeight, Math.ceil(Math.max(from.y, to.y) + padding));
    if (right <= left || bottom <= top) return;
    resultCtx.save();
    resultCtx.beginPath();
    resultCtx.rect(left, top, right - left, bottom - top);
    resultCtx.clip();
    resultCtx.clearRect(left, top, right - left, bottom - top);
    resultCtx.drawImage(sourceCanvas, 0, 0);
    resultCtx.globalCompositeOperation = 'destination-in';
    resultCtx.drawImage(workMask, 0, 0);
    resultCtx.restore();
  }

  function drawDab(context, point, radius, mode) {
    const r = Math.max(1, radius);
    context.save();
    context.globalCompositeOperation = mode === 'erase' ? 'destination-out' : 'source-over';
    const gradient = context.createRadialGradient(point.x, point.y, 0, point.x, point.y, r);
    gradient.addColorStop(0, 'rgba(255,255,255,1)');
    gradient.addColorStop(0.68, 'rgba(255,255,255,0.94)');
    gradient.addColorStop(1, 'rgba(255,255,255,0)');
    context.fillStyle = gradient;
    context.fillRect(point.x - r, point.y - r, r * 2, r * 2);
    context.restore();
  }

  function drawStroke(context, stroke) {
    const points = stroke?.points || [];
    if (!points.length) return;
    drawDab(context, points[0], stroke.radius, stroke.mode);
    for (let index = 1; index < points.length; index += 1) {
      drawStrokeSegment(context, points[index - 1], points[index], stroke);
    }
  }

  function drawStrokeSegment(context, from, to, stroke) {
    const distance = Math.hypot(to.x - from.x, to.y - from.y);
    const spacing = Math.max(1, stroke.radius * 0.28);
    const steps = Math.max(1, Math.ceil(distance / spacing));
    for (let index = 1; index <= steps; index += 1) {
      const amount = index / steps;
      drawDab(context, {
        x: from.x + (to.x - from.x) * amount,
        y: from.y + (to.y - from.y) * amount
      }, stroke.radius, stroke.mode);
    }
  }

  function rebuildWorkMask() {
    workMaskCtx.clearRect(0, 0, imageWidth, imageHeight);
    workMaskCtx.drawImage(featheredMask, 0, 0);
    for (const stroke of history.strokes) drawStroke(workMaskCtx, stroke);
    renderResult();
    updateHistoryButtons();
  }

  function applyFeather() {
    featheredMaskCtx.save();
    featheredMaskCtx.clearRect(0, 0, imageWidth, imageHeight);
    const radius = Number(featherInput.value) || 0;
    featheredMaskCtx.filter = radius > 0.01 ? `blur(${radius}px)` : 'none';
    featheredMaskCtx.drawImage(rawMask, 0, 0);
    featheredMaskCtx.restore();
    featheredMaskCtx.filter = 'none';
    rebuildWorkMask();
  }

  async function extractAiMask(cutoutBytes) {
    const blob = new Blob([new Uint8Array(cutoutBytes)], { type: 'image/png' });
    const bitmap = await createImageBitmap(blob);
    rawMaskCtx.clearRect(0, 0, imageWidth, imageHeight);
    rawMaskCtx.drawImage(bitmap, 0, 0, imageWidth, imageHeight);
    bitmap.close?.();
    const pixels = rawMaskCtx.getImageData(0, 0, imageWidth, imageHeight);
    for (let index = 0; index < pixels.data.length; index += 4) {
      pixels.data[index] = 255;
      pixels.data[index + 1] = 255;
      pixels.data[index + 2] = 255;
    }
    rawMaskCtx.putImageData(pixels, 0, 0);
  }

  function applyView() {
    canvasStack.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.scale})`;
    zoomValue.textContent = `${Math.round(view.scale * 100)}%`;
  }

  function zoomToFit() {
    if (!imageWidth) return;
    const rect = viewport.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const scale = Math.min(rect.width / imageWidth, rect.height / imageHeight, 1) * 0.92;
    view = {
      scale,
      x: (rect.width - imageWidth * scale) / 2,
      y: (rect.height - imageHeight * scale) / 2,
      fit: true
    };
    applyView();
  }

  function zoomAt(factor, centerX, centerY) {
    if (!imageWidth) return;
    const rect = viewport.getBoundingClientRect();
    const cx = centerX ?? rect.left + rect.width / 2;
    const cy = centerY ?? rect.top + rect.height / 2;
    const px = (cx - rect.left - view.x) / view.scale;
    const py = (cy - rect.top - view.y) / view.scale;
    view.scale = Math.min(12, Math.max(0.05, view.scale * factor));
    view.x = cx - rect.left - px * view.scale;
    view.y = cy - rect.top - py * view.scale;
    view.fit = false;
    applyView();
  }

  function toImageCoords(clientX, clientY) {
    const rect = canvasStack.getBoundingClientRect();
    return {
      x: Math.min(imageWidth, Math.max(0, (clientX - rect.left) / view.scale)),
      y: Math.min(imageHeight, Math.max(0, (clientY - rect.top) / view.scale))
    };
  }

  function setTool(tool) {
    activeTool = tool;
    overlay.querySelectorAll('[data-bgr-tool]').forEach(button => {
      button.classList.toggle('is-active', button.dataset.bgrTool === activeTool);
      button.setAttribute('aria-pressed', String(button.dataset.bgrTool === activeTool));
    });
    viewport.style.cursor = activeTool === 'pan' ? 'grab' : 'none';
    if (activeTool === 'pan') removeBrushCursor();
  }

  function updateBrushCursor(clientX, clientY) {
    if (activeTool === 'pan' || !processed || isBusy()) {
      removeBrushCursor();
      return;
    }
    let ring = viewport.querySelector('.bg-removal-brush-cursor');
    if (!ring) {
      ring = document.createElement('div');
      ring.className = 'bg-removal-brush-cursor';
      viewport.append(ring);
    }
    const viewportRect = viewport.getBoundingClientRect();
    const diameter = brushSize * view.scale;
    ring.style.width = `${diameter}px`;
    ring.style.height = `${diameter}px`;
    ring.style.left = `${clientX - viewportRect.left - diameter / 2}px`;
    ring.style.top = `${clientY - viewportRect.top - diameter / 2}px`;
  }

  function removeBrushCursor() {
    viewport.querySelector('.bg-removal-brush-cursor')?.remove();
  }

  function markEdited(key = 'unsavedEdits') {
    dirty = true;
    if (state === 'saved' || state === 'error') state = 'editing';
    stableState = 'editing';
    setStatus('idle', key);
    renderState();
  }

  function undo() {
    if (!processed || !undoEditStroke(history)) return;
    rebuildWorkMask();
    markEdited();
  }

  function redo() {
    if (!processed || !redoEditStroke(history)) return;
    rebuildWorkMask();
    markEdited();
  }

  function resetEdits() {
    if (!processed) return;
    resetEditHistory(history);
    rebuildWorkMask();
    markEdited('resetDone');
  }

  async function acceptImage(imagePath) {
    if (!imagePath || isBusy()) return;
    window.cancelAnimationFrame(featherRenderFrame);
    featherRenderFrame = 0;
    const epoch = ++operationEpoch;
    const returnState = stableState;
    operationKind = 'loading';
    setState('processing', 'loading', undefined, { status: 'working' });
    try {
      const bytes = await tauriCore.invoke('read_file_bytes', { path: imagePath });
      if (epoch !== operationEpoch) return;
      const blob = new Blob([new Uint8Array(bytes)], { type: mimeFor(imagePath) });
      const bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });
      if (epoch !== operationEpoch) {
        bitmap.close?.();
        return;
      }
      sourceWidth = bitmap.width;
      sourceHeight = bitmap.height;
      currentFileBytes = bytes.length;
      const previewScale = Math.min(1, MAX_PREVIEW_EDGE / Math.max(sourceWidth, sourceHeight));
      imageWidth = Math.max(1, Math.round(sourceWidth * previewScale));
      imageHeight = Math.max(1, Math.round(sourceHeight * previewScale));
      currentImagePath = imagePath;
      processed = false;
      dirty = false;
      savedPath = '';
      setSuccessState(false, { restoreFocus: false });
      resetEditHistory(history);
      sizeCanvases(imageWidth, imageHeight);
      bakeOriginal(bitmap);
      bitmap.close?.();
      renderResult();
      view.fit = true;
      setState('ready', 'readyToProcess');
      requestAnimationFrame(zoomToFit);
      if (window.matchMedia('(max-width: 839px)').matches) setParamsOpen(true);
    } catch (error) {
      console.error('[BgRemoval] load image failed:', error);
      state = returnState;
      setState('error', 'pickFailed', undefined, { status: 'error' });
      notify(copy('pickFailed'));
    } finally {
      operationKind = '';
      renderState();
    }
  }

  async function chooseImage() {
    if (!isTauri) {
      notify(copy('desktopOnly'));
      setStatus('error', 'desktopOnly');
      return;
    }
    if (isBusy()) return;
    try {
      const { open: openDialog } = await import('@tauri-apps/plugin-dialog');
      const selected = await openDialog({
        multiple: false,
        filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'webp', 'bmp'] }]
      });
      if (typeof selected === 'string') await acceptImage(selected);
    } catch (error) {
      console.error('[BgRemoval] file picker failed:', error);
      setStatus('error', 'pickFailed');
    }
  }

  async function runSegment() {
    if (disposed || !isTauri || !currentImagePath || isBusy() || !modelSelect.value) return;
    window.cancelAnimationFrame(featherRenderFrame);
    featherRenderFrame = 0;
    const epoch = ++operationEpoch;
    const requestId = ++segmentRequestSequence;
    activeSegmentRequest = requestId;
    operationKind = 'segmenting';
    setCompareHeld(false);
    setParamsOpen(false);
    setState('processing', 'processing', undefined, { status: 'working' });
    let previewPath = '';
    try {
      const result = await tauriCore.invoke('segment_image', {
        inputPath: currentImagePath,
        modelId: modelSelect.value,
        previewMaxSize: MAX_PREVIEW_EDGE,
        requestId
      });
      previewPath = result.path;
      if (epoch !== operationEpoch || requestId !== activeSegmentRequest) return;
      const cutoutBytes = await tauriCore.invoke('read_file_bytes', { path: previewPath });
      if (epoch !== operationEpoch || requestId !== activeSegmentRequest) return;
      await extractAiMask(cutoutBytes);
      resetEditHistory(history);
      processed = true;
      dirty = true;
      savedPath = '';
      applyFeather();
      setTool('pan');
      setState('editing', 'editHint', undefined, { status: 'done' });
    } catch (error) {
      const message = String(error?.message || error || '');
      if (/cancelled/i.test(message) || epoch !== operationEpoch) return;
      console.error('[BgRemoval] segment failed:', error);
      const key = /model-not-installed/i.test(message) ? 'modelMissing' : 'segmentFailed';
      setState('error', key, undefined, { status: 'error' });
      notify(copy(key));
    } finally {
      if (previewPath) {
        void tauriCore.invoke('discard_matting_preview', { path: previewPath }).catch(() => {});
      }
      if (activeSegmentRequest === requestId) activeSegmentRequest = 0;
      operationKind = '';
      renderState();
    }
  }

  function canvasToPngBytes(canvas) {
    return new Promise((resolve, reject) => {
      canvas.toBlob(async blob => {
        if (!blob) {
          reject(new Error('matting:mask-encode-failed'));
          return;
        }
        resolve(new Uint8Array(await blob.arrayBuffer()));
      }, 'image/png');
    });
  }

  async function saveResult() {
    if (!isTauri || !processed || isBusy() || !currentImagePath || !outputDir) return;
    if (featherRenderFrame) {
      window.cancelAnimationFrame(featherRenderFrame);
      featherRenderFrame = 0;
      applyFeather();
      markEdited();
    }
    if (state === 'error') state = 'editing';
    setSuccessState(false, { restoreFocus: false });
    setState('saving', 'saving', undefined, { status: 'working' });
    try {
      const maskBytes = await canvasToPngBytes(workMask);
      const result = await tauriCore.invoke('export_segmented_image', {
        inputPath: currentImagePath,
        outputDir,
        fileName: `${fileStem(currentImagePath)}_透明`,
        maskBytes
      });
      savedPath = result.path;
      dirty = false;
      setState('saved', 'saved', undefined, { status: 'done' });
      renderSuccess();
      setSuccessState(true);
    } catch (error) {
      console.error('[BgRemoval] export failed:', error);
      const tooLarge = /image-too-large/i.test(String(error?.message || error || ''));
      setState('error', tooLarge ? 'imageTooLarge' : 'saveFailed', undefined, { status: 'error' });
      notify(copy(tooLarge ? 'imageTooLarge' : 'saveFailed'));
    }
  }

  async function openOutputFolder() {
    if (!isTauri || !savedPath) return;
    try { await tauriCore.invoke('open_path', { path: savedPath }); } catch (error) {
      console.error('[BgRemoval] cannot open output folder:', error);
    }
  }

  async function startNativeDragListener() {
    if (!isTauri || nativeDragUnlisten) return;
    try {
      const { getCurrentWebview } = await import('@tauri-apps/api/webview');
      nativeDragUnlisten = await getCurrentWebview().onDragDropEvent(event => {
        if (!overlay.classList.contains('visible')) return;
        const payload = event.payload || {};
        if (payload.type === 'enter' || payload.type === 'over') overlay.classList.add('drag-over');
        else if (payload.type === 'leave') overlay.classList.remove('drag-over');
        else if (payload.type === 'drop') {
          overlay.classList.remove('drag-over');
          const path = payload.paths?.[0];
          if (path && /\.(jpe?g|png|webp|bmp)$/i.test(path)) void acceptImage(path);
          else setStatus('error', 'unsupportedFile');
        }
      });
    } catch (error) {
      console.error('[BgRemoval] native drag listener failed:', error);
    }
  }

  function stopNativeDragListener() {
    try { nativeDragUnlisten?.(); } catch {}
    nativeDragUnlisten = null;
    overlay.classList.remove('drag-over');
  }

  function setParamsOpen(open) {
    paramsOpen = Boolean(open);
    renderState();
  }

  function setCompareHeld(held) {
    compareHeld = Boolean(held && processed && !isBusy());
    canvasStack.classList.toggle('is-compare', compareHeld);
    compareButton?.setAttribute('aria-pressed', String(compareHeld));
  }

  function handleAction(action) {
    if (action === 'back') close();
    else if (action === 'website') openExternalUrl?.('https://toolknit.com');
    else if (action === 'support') openSupport?.();
    else if (action === 'settings') openSettings?.();
    else if (action === 'manage-models') openMattingModelManager?.();
    else if (action === 'upload') void chooseImage();
    else if (action === 'process') void runSegment();
    else if (action === 'save') void saveResult();
    else if (action === 'open-folder') void openOutputFolder();
    else if (action === 'success-ok') setSuccessState(false);
    else if (action === 'reset-edits') resetEdits();
    else if (action === 'undo') undo();
    else if (action === 'redo') redo();
    else if (action === 'zoom-in') zoomAt(1.25);
    else if (action === 'zoom-out') zoomAt(0.8);
    else if (action === 'zoom-fit') zoomToFit();
    else if (action === 'open-params') setParamsOpen(true);
    else if (action === 'close-params') setParamsOpen(false);
    else if (action === 'brush-size') brushPop.hidden = !brushPop.hidden;
  }

  overlay.addEventListener('click', event => {
    const actionNode = event.target.closest('[data-bgr-action]');
    if (actionNode && actionNode.dataset.bgrAction !== 'compare') handleAction(actionNode.dataset.bgrAction);
    const windowNode = event.target.closest('[data-window-action]');
    if (windowNode) void handleWindowAction?.(windowNode.dataset.windowAction);
    if (!event.target.closest('[data-bgr-brush-wrap]')) brushPop.hidden = true;
  }, listenerOptions);

  overlay.querySelectorAll('[data-bgr-tool]').forEach(button => {
    button.addEventListener('click', () => setTool(button.dataset.bgrTool), listenerOptions);
  });

  modelSelect.addEventListener('change', () => {
    preferences.modelId = modelSelect.value;
    persistPreferences();
  }, listenerOptions);

  featherInput.addEventListener('input', () => {
    preferences.feather = Number(featherInput.value);
    featherValue.textContent = `${preferences.feather.toFixed(1)}px`;
    persistPreferences();
    if (processed && !isBusy()) {
      window.cancelAnimationFrame(featherRenderFrame);
      featherRenderFrame = window.requestAnimationFrame(() => {
        featherRenderFrame = 0;
        applyFeather();
        markEdited();
      });
    }
  }, listenerOptions);

  brushSizeInput.addEventListener('input', () => {
    brushSize = Number(brushSizeInput.value);
    preferences.brushSize = brushSize;
    brushSizeValue.textContent = `${Math.round(brushSize)}px`;
    persistPreferences();
  }, listenerOptions);

  viewport.addEventListener('wheel', event => {
    if (!imageWidth || state === 'processing') return;
    event.preventDefault();
    zoomAt(Math.exp(-event.deltaY * 0.0015), event.clientX, event.clientY);
  }, { ...listenerOptions, passive: false });

  viewport.addEventListener('pointerdown', event => {
    if (!imageWidth || isBusy()) return;
    if (activeTool !== 'pan' && processed && event.button === 0) {
      viewport.setPointerCapture(event.pointerId);
      painting = true;
      const point = toImageCoords(event.clientX, event.clientY);
      activeStroke = {
        mode: activeTool === 'erase' ? 'erase' : 'restore',
        radius: brushSize / 2,
        points: [point]
      };
      drawDab(workMaskCtx, point, activeStroke.radius, activeStroke.mode);
      renderResultRegion(point, point, activeStroke.radius);
      return;
    }
    if (event.button === 0 || event.button === 1) {
      viewport.setPointerCapture(event.pointerId);
      panning = true;
      panStart = { x: event.clientX, y: event.clientY, viewX: view.x, viewY: view.y };
      viewport.style.cursor = 'grabbing';
    }
  }, listenerOptions);

  viewport.addEventListener('pointermove', event => {
    updateBrushCursor(event.clientX, event.clientY);
    if (painting && activeStroke) {
      const point = toImageCoords(event.clientX, event.clientY);
      const last = activeStroke.points[activeStroke.points.length - 1];
      if (Math.hypot(point.x - last.x, point.y - last.y) >= Math.max(1, activeStroke.radius * 0.18)) {
        activeStroke.points.push(point);
        drawStrokeSegment(workMaskCtx, last, point, activeStroke);
        renderResultRegion(last, point, activeStroke.radius);
      }
      return;
    }
    if (panning && panStart) {
      view.x = panStart.viewX + event.clientX - panStart.x;
      view.y = panStart.viewY + event.clientY - panStart.y;
      view.fit = false;
      applyView();
    }
  }, listenerOptions);

  viewport.addEventListener('pointerleave', () => {
    if (!painting) removeBrushCursor();
  }, listenerOptions);

  const endPointer = event => {
    if (painting && activeStroke) {
      painting = false;
      if (commitEditStroke(history, activeStroke)) markEdited();
      activeStroke = null;
    }
    if (panning) {
      panning = false;
      panStart = null;
      viewport.style.cursor = activeTool === 'pan' ? 'grab' : 'none';
    }
    try { viewport.releasePointerCapture(event.pointerId); } catch {}
  };
  viewport.addEventListener('pointerup', endPointer, listenerOptions);
  viewport.addEventListener('pointercancel', endPointer, listenerOptions);

  compareButton.addEventListener('pointerdown', event => {
    event.preventDefault();
    setCompareHeld(true);
  }, listenerOptions);
  compareButton.addEventListener('pointerup', () => setCompareHeld(false), listenerOptions);
  compareButton.addEventListener('pointerleave', () => setCompareHeld(false), listenerOptions);
  window.addEventListener('pointerup', () => setCompareHeld(false), listenerOptions);
  window.addEventListener('blur', () => setCompareHeld(false), listenerOptions);

  document.addEventListener('keydown', event => {
    if (!overlay.classList.contains('visible')) return;
    if (event.key === 'Escape' && successOverlay?.classList.contains('visible')) {
      event.preventDefault();
      setSuccessState(false);
      return;
    }
    if (isEditableTarget(event.target)) return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      event.shiftKey ? redo() : undo();
    } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'y') {
      event.preventDefault();
      redo();
    }
  }, listenerOptions);

  document.addEventListener('toolknit:matting-models-changed', () => void refreshModels(), listenerOptions);

  resizeObserver = new ResizeObserver(() => {
    if (view.fit && imageWidth && overlay.classList.contains('visible')) zoomToFit();
  });
  resizeObserver.observe(viewport);

  async function initializeRuntime() {
    try {
      const root = await tauriCore.invoke('get_output_root');
      const base = root || await tauriCore.invoke('get_default_output_root');
      outputDir = joinNativePath(base, '背景移除');
      await refreshModels();
    } catch (error) {
      console.error('[BgRemoval] initialization failed:', error);
      setStatus('error', 'initFailed');
    }
  }

  function open() {
    if (disposed) return;
    overlay.classList.add('visible');
    overlay.setAttribute('aria-hidden', 'false');
    plasmaInstance ||= initStandardToolPlasma?.(bg) || null;
    featherValue.textContent = `${Number(featherInput.value).toFixed(1)}px`;
    brushSizeValue.textContent = `${Math.round(brushSize)}px`;
    renderLocale();
    setTool(activeTool);
    createIcons({ icons, attrs: { 'aria-hidden': 'true' } });
    void startNativeDragListener();
    if (isTauri) void initializeRuntime();
    else setStatus('idle', 'desktopOnly');
    requestAnimationFrame(() => { if (view.fit) zoomToFit(); });
  }

  function close() {
    if (!overlay.classList.contains('visible')) return;
    operationEpoch += 1;
    if (activeSegmentRequest) {
      void tauriCore.invoke('cancel_matting_segmentation', { requestId: activeSegmentRequest }).catch(() => {});
      activeSegmentRequest = 0;
    }
    painting = false;
    activeStroke = null;
    panning = false;
    panStart = null;
    setCompareHeld(false);
    setParamsOpen(false);
    setSuccessState(false, { restoreFocus: false });
    modelSelectControl?.close();
    removeBrushCursor();
    if (state === 'processing') {
      state = stableState;
      const key = stableState === 'editing' || stableState === 'saved'
        ? 'editHint'
        : stableState === 'ready' ? 'readyToProcess' : 'statusIdle';
      setStatus('idle', key);
    }
    overlay.classList.remove('visible', 'drag-over');
    overlay.setAttribute('aria-hidden', 'true');
    stopNativeDragListener();
    plasmaInstance = disposeStandardToolPlasma?.(plasmaInstance) || null;
  }

  function dispose() {
    if (disposed) return;
    close();
    disposed = true;
    listeners.abort();
    resizeObserver?.disconnect();
    modelSelectControl?.dispose();
    window.cancelAnimationFrame(featherRenderFrame);
    try { languageUnsubscribe(); } catch {}
    overlay.replaceChildren();
  }

  languageUnsubscribe = onLangChange(renderLocale) || (() => {});
  window.addEventListener('beforeunload', dispose, { ...listenerOptions, once: true });
  renderLocale();
  setTool('pan');

  return { open, close, dispose };
}
