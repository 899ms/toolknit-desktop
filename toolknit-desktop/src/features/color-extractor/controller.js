import { createLifecycleScope } from '../../app/tool-lifecycle.js';
import { applyTranslations } from '../../i18n.js';
import { loadTauriWebview, tauriCorePromise, tauriEventPromise } from '../../platform/tauri-runtime.js';
import { assertColorExtractorFile, assertColorExtractorImageBytes, assertColorExtractorDimensions, paletteFromRgba } from '../../color-extractor-core.js';

function fileNameFromPath(value) {
  return String(value || '').split(/[\\/]/).pop() || '';
}

function copyText(value) {
  const text = String(value || '');
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text);
  return new Promise((resolve, reject) => {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
    document.body.appendChild(textarea);
    textarea.select();
    try {
      if (!document.execCommand?.('copy')) throw new Error('clipboard-unavailable');
      resolve();
    } catch (error) {
      reject(error);
    } finally {
      textarea.remove();
    }
  });
}

function colorFromSample(sample) {
  const hex = String(sample?.hex || '').match(/^#[0-9a-f]{6}$/i)?.[0]?.toUpperCase() || '#000000';
  const match = String(sample?.rgb || '').match(/^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/i);
  const rgb = {
    r: Math.max(0, Math.min(255, Number(match?.[1]) || 0)),
    g: Math.max(0, Math.min(255, Number(match?.[2]) || 0)),
    b: Math.max(0, Math.min(255, Number(match?.[3]) || 0))
  };
  const normalized = [rgb.r / 255, rgb.g / 255, rgb.b / 255];
  const max = Math.max(...normalized);
  const min = Math.min(...normalized);
  const lightness = (max + min) / 2;
  if (max === min) return { hex, rgb, hsl: { h: 0, s: 0, l: Math.round(lightness * 100) } };
  const delta = max - min;
  const saturation = lightness > 0.5 ? delta / (2 - max - min) : delta / (max + min);
  let hue;
  if (max === normalized[0]) hue = ((normalized[1] - normalized[2]) / delta + (normalized[1] < normalized[2] ? 6 : 0)) / 6;
  else if (max === normalized[1]) hue = ((normalized[2] - normalized[0]) / delta + 2) / 6;
  else hue = ((normalized[0] - normalized[1]) / delta + 4) / 6;
  return { hex, rgb, hsl: { h: Math.round(hue * 360), s: Math.round(saturation * 100), l: Math.round(lightness * 100) } };
}

function createImageLoader({ onLoad, onError }) {
  return blob => {
    const url = URL.createObjectURL(blob);
    const image = new Image();
    image.onload = () => onLoad(image, url);
    image.onerror = () => {
      URL.revokeObjectURL(url);
      onError();
    };
    image.src = url;
    return url;
  };
}

export function createColorExtractorController({
  overlay,
  notify = message => window.showToast?.(message),
  isTauri = false,
  t = key => key,
  getLang = () => 'zh',
  onLangChange = () => () => {},
  openNativeScreenPicker = null,
  closeNativeScreenPicker = null
} = {}) {
  if (!overlay) throw new Error('color-extractor:missing-overlay');
  const scope = createLifecycleScope({ onError: error => console.warn('[Color Extractor] cleanup failed:', error) });
  const q = selector => overlay.querySelector(selector);
  const status = q('#colorExtractorStatus');
  const imageModeButton = q('#colorExtractorImageModeBtn');
  const screenModeButton = q('#colorExtractorScreenModeBtn');
  const imageMode = q('#colorExtractorImageMode');
  const screenMode = q('#colorExtractorScreenMode');
  const uploadZone = q('#colorExtractorUploadZone');
  const fileInput = q('#colorExtractorFileInput');
  const imagePreview = q('#colorExtractorImagePreview');
  const image = q('#colorExtractorImage');
  const imageName = q('#colorExtractorImageName');
  const imageMeta = q('#colorExtractorImageMeta');
  const replaceButton = q('#colorExtractorReplaceBtn');
  const screenStartButton = q('#colorExtractorScreenStartBtn');
  const screenResult = q('#colorExtractorScreenResult');
  const screenSwatch = q('#colorExtractorScreenSwatch');
  const screenHex = q('#colorExtractorScreenHex');
  const screenRgb = q('#colorExtractorScreenRgb');
  const screenCopyButton = q('#colorExtractorScreenCopyBtn');
  const paletteEmpty = q('#colorExtractorPaletteEmpty');
  const paletteGrid = q('#colorExtractorPaletteGrid');
  const detailSwatch = q('#colorExtractorDetailSwatch');
  const detailHex = q('#colorExtractorDetailHex');
  const detailRgb = q('#colorExtractorDetailRgb');
  const detailHsl = q('#colorExtractorDetailHsl');
  const detailHint = q('#colorExtractorDetailHint');

  let disposed = false;
  let open = false;
  let mode = 'image';
  let requestRevision = 0;
  let previewUrl = null;
  let colors = [];
  let selectedIndex = -1;
  let dragCounter = 0;
  let nativeDragUnlisten = null;
  let paletteScope = null;

  scope.use(() => paletteScope?.dispose());

  const statusText = value => { if (status) status.textContent = value; };

  function releasePreviewUrl() {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = null;
  }

  function renderDetail(color) {
    if (detailSwatch) detailSwatch.style.backgroundColor = color?.hex || 'rgba(255,255,255,.04)';
    if (detailHex) detailHex.textContent = color?.hex || '—';
    if (detailRgb) detailRgb.textContent = color ? `rgb(${color.rgb.r}, ${color.rgb.g}, ${color.rgb.b})` : '—';
    if (detailHsl) detailHsl.textContent = color ? `hsl(${color.hsl.h}, ${color.hsl.s}%, ${color.hsl.l}%)` : '—';
    if (detailHint) detailHint.hidden = Boolean(color);
  }

  function selectColor(index) {
    const color = colors[index];
    if (!color) return;
    selectedIndex = index;
    paletteGrid?.querySelectorAll('.color-extractor-palette-card').forEach(card => {
      card.classList.toggle('is-selected', Number(card.dataset.colorIndex) === index);
    });
    renderDetail(color);
  }

  function renderPalette() {
    const hasColors = colors.length > 0;
    if (paletteEmpty) paletteEmpty.hidden = hasColors;
    if (paletteGrid) paletteGrid.hidden = !hasColors;
    if (!paletteGrid) return;
    paletteScope?.dispose();
    paletteScope = createLifecycleScope();
    paletteGrid.replaceChildren();
    if (!hasColors) return;
    colors.forEach((color, index) => {
      const card = document.createElement('div');
      card.className = `color-extractor-palette-card${index === selectedIndex ? ' is-selected' : ''}`;
      card.dataset.colorIndex = String(index);
      card.setAttribute('role', 'button');
      card.tabIndex = 0;
      card.title = getLang() === 'zh' ? `查看 ${color.hex}` : `View ${color.hex}`;
      const swatch = document.createElement('span');
      swatch.className = 'color-extractor-palette-swatch';
      swatch.style.backgroundColor = color.hex;
      const copy = document.createElement('span');
      copy.className = 'color-extractor-palette-copy';
      const hex = document.createElement('strong');
      hex.textContent = color.hex;
      const rgb = document.createElement('small');
      rgb.textContent = `rgb(${color.rgb.r}, ${color.rgb.g}, ${color.rgb.b})`;
      copy.append(hex, rgb);
      const percentage = document.createElement('span');
      percentage.className = 'color-extractor-palette-share';
      percentage.textContent = color.percentage === undefined ? '' : `${Math.round(color.percentage)}%`;
      card.append(swatch, copy, percentage);
      paletteScope.event(card, 'click', () => selectColor(index));
      paletteScope.event(card, 'keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); selectColor(index); }
      });
      paletteScope.event(card, 'contextmenu', event => {
        event.preventDefault();
        void copyText(color.hex).then(() => notify(t('home.colorExtractor.copySuccess'))).catch(() => notify(t('home.colorExtractor.copyFailed')));
      });
      paletteGrid.appendChild(card);
    });
  }

  function resetState() {
    requestRevision += 1;
    colors = [];
    selectedIndex = -1;
    releasePreviewUrl();
    if (fileInput) fileInput.value = '';
    if (uploadZone) { uploadZone.hidden = false; uploadZone.classList.remove('dragover'); }
    if (imagePreview) imagePreview.hidden = true;
    if (image) image.removeAttribute('src');
    if (imageName) imageName.textContent = '';
    if (imageMeta) imageMeta.textContent = '';
    if (screenResult) screenResult.hidden = true;
    if (screenSwatch) screenSwatch.style.removeProperty('background-color');
    if (screenHex) screenHex.textContent = '#000000';
    if (screenRgb) screenRgb.textContent = 'rgb(0, 0, 0)';
    renderPalette();
    renderDetail(null);
    statusText(t('home.colorExtractor.waiting'));
  }

  function setMode(nextMode) {
    mode = nextMode === 'screen' ? 'screen' : 'image';
    const screenSelected = mode === 'screen';
    imageModeButton?.classList.toggle('is-active', !screenSelected);
    screenModeButton?.classList.toggle('is-active', screenSelected);
    imageModeButton?.setAttribute('aria-selected', String(!screenSelected));
    screenModeButton?.setAttribute('aria-selected', String(screenSelected));
    if (imageMode) imageMode.hidden = screenSelected;
    if (screenMode) screenMode.hidden = !screenSelected;
    statusText(screenSelected ? t('home.colorExtractor.screenMode') : (colors.length ? (getLang() === 'zh' ? '已提取配色' : 'Palette ready') : t('home.colorExtractor.waiting')));
  }

  function extractPalette(imageElement, revision) {
    if (!imageElement?.naturalWidth || !imageElement?.naturalHeight || revision !== requestRevision) return;
    const maxDim = 200;
    const scale = Math.min(maxDim / imageElement.naturalWidth, maxDim / imageElement.naturalHeight, 1);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(imageElement.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(imageElement.naturalHeight * scale));
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) return;
    context.drawImage(imageElement, 0, 0, canvas.width, canvas.height);
    try {
      colors = paletteFromRgba(context.getImageData(0, 0, canvas.width, canvas.height).data, 9);
    } catch (error) {
      console.warn('[Color Extractor] pixel read failed:', error);
      notify(t('home.colorExtractor.extractFailed'));
      return;
    }
    if (!colors.length) { notify(t('home.colorExtractor.extractFailed')); return; }
    selectedIndex = 0;
    renderPalette();
    renderDetail(colors[0]);
    statusText(getLang() === 'zh' ? `已提取 ${colors.length} 种颜色` : `${colors.length} colors extracted`);
  }

  async function handleFile(file) {
    resetState();
    const revision = requestRevision;
    try { assertColorExtractorFile(file); } catch (error) {
      notify(error instanceof RangeError ? t('home.colorExtractor.fileTooLarge', { max: 20 }) : t('home.colorExtractor.unsupportedFormat'));
      return;
    }
    const mimeType = file.type === 'image/png' || /\.png$/i.test(file.name || '') ? 'image/png'
      : file.type === 'image/webp' || /\.webp$/i.test(file.name || '') ? 'image/webp' : 'image/jpeg';
    const useImage = (imageElement, url) => {
      if (revision !== requestRevision) { URL.revokeObjectURL(url); return; }
      try { assertColorExtractorDimensions(imageElement.naturalWidth, imageElement.naturalHeight); } catch {
        URL.revokeObjectURL(url);
        if (previewUrl === url) previewUrl = null;
        notify(t('home.colorExtractor.dimensionsTooLarge'));
        return;
      }
      previewUrl = url;
      if (uploadZone) uploadZone.hidden = true;
      if (image) image.src = url;
      if (imagePreview) imagePreview.hidden = false;
      if (imageName) imageName.textContent = file.name || (getLang() === 'zh' ? '图片' : 'Image');
      if (imageMeta) imageMeta.textContent = `${imageElement.naturalWidth} × ${imageElement.naturalHeight}`;
      extractPalette(imageElement, revision);
    };
    const load = createImageLoader({ onLoad: useImage, onError: () => { if (revision === requestRevision) notify(t('home.colorExtractor.extractFailed')); } });
    if (isTauri && file.path) {
      try {
        const { invoke } = await tauriCorePromise;
        const size = Number(await invoke('get_file_size', { path: file.path }));
        assertColorExtractorFile(file, size);
        const raw = await invoke('read_file_bytes', { path: file.path });
        const bytes = Array.isArray(raw) ? Uint8Array.from(raw) : new Uint8Array(raw);
        assertColorExtractorFile(file, bytes.byteLength);
        assertColorExtractorImageBytes(bytes);
        load(new Blob([bytes], { type: mimeType }));
      } catch (error) {
        if (revision === requestRevision) notify(error instanceof RangeError ? t('home.colorExtractor.fileTooLarge', { max: 20 }) : t('home.colorExtractor.extractFailed'));
      }
      return;
    }
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (revision !== requestRevision) return;
      assertColorExtractorImageBytes(bytes);
      load(file);
    } catch (error) {
      if (revision === requestRevision) notify(error instanceof RangeError ? t('home.colorExtractor.dimensionsTooLarge') : t('home.colorExtractor.extractFailed'));
    }
  }

  function renderScreenResult(sample) {
    const color = colorFromSample(sample);
    if (screenSwatch) screenSwatch.style.backgroundColor = color.hex;
    if (screenHex) screenHex.textContent = color.hex;
    if (screenRgb) screenRgb.textContent = `rgb(${color.rgb.r}, ${color.rgb.g}, ${color.rgb.b})`;
    if (screenResult) screenResult.hidden = false;
    const existing = colors.findIndex(item => item.hex === color.hex);
    if (existing >= 0) selectedIndex = existing;
    else { colors.unshift(color); selectedIndex = 0; }
    renderPalette();
    renderDetail(colors[selectedIndex]);
    statusText(t('home.colorExtractor.screenPicked'));
    if (screenStartButton) screenStartButton.disabled = false;
  }

  async function startScreenPicker() {
    if (!isTauri && typeof window.EyeDropper === 'function') {
      try {
        const result = await new window.EyeDropper().open();
        const hex = String(result?.sRGBHex || '#000000').match(/^#[0-9a-f]{6}$/i)?.[0] || '#000000';
        const channels = [1, 3, 5].map(index => parseInt(hex.slice(index, index + 2), 16));
        renderScreenResult({ hex, rgb: `rgb(${channels[0]}, ${channels[1]}, ${channels[2]})` });
      } catch (error) { if (error?.name !== 'AbortError') notify('浏览器暂不支持屏幕取色。'); }
      return;
    }
    if (!isTauri) { notify('桌面屏幕取色仅支持桌面版。'); return; }
    if (screenStartButton) screenStartButton.disabled = true;
    statusText(getLang() === 'zh' ? '正在启动取色器…' : 'Starting picker…');
    try {
      if (openNativeScreenPicker) await openNativeScreenPicker();
      else {
        const { invoke } = await tauriCorePromise;
        await invoke('open_screen_color_picker');
      }
    }
    catch (error) { if (screenStartButton) screenStartButton.disabled = false; statusText(getLang() === 'zh' ? '取色器启动失败' : 'Picker failed to start'); notify(String(error?.message || error)); }
  }

  scope.event(imageModeButton, 'click', () => setMode('image'));
  scope.event(screenModeButton, 'click', () => setMode('screen'));
  scope.event(screenStartButton, 'click', () => { void startScreenPicker(); });
  scope.event(screenCopyButton, 'click', () => void copyText(screenHex?.textContent).then(() => notify(t('home.colorExtractor.copySuccess'))).catch(() => notify(t('home.colorExtractor.copyFailed'))));
  scope.event(window, 'toolknit:screen-color-picked', event => renderScreenResult(event.detail));
  scope.event(replaceButton, 'click', () => fileInput?.click());
  scope.event(fileInput, 'change', event => { const file = event.target.files?.[0]; if (file) void handleFile(file); });
  scope.event(uploadZone, 'click', () => fileInput?.click());
  scope.event(uploadZone, 'keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); fileInput?.click(); } });
  scope.event(uploadZone, 'dragover', event => { event.preventDefault(); uploadZone.classList.add('dragover'); });
  scope.event(uploadZone, 'dragenter', event => { event.preventDefault(); dragCounter += 1; uploadZone.classList.add('dragover'); });
  scope.event(uploadZone, 'dragleave', () => { dragCounter = Math.max(0, dragCounter - 1); if (!dragCounter) uploadZone.classList.remove('dragover'); });
  scope.event(uploadZone, 'drop', event => { event.preventDefault(); dragCounter = 0; uploadZone.classList.remove('dragover'); const file = event.dataTransfer?.files?.[0]; if (file) void handleFile(file); });
  scope.use(onLangChange(() => { applyTranslations(); renderPalette(); setMode(mode); }));

  async function bindNativeDrop() {
    if (!isTauri || nativeDragUnlisten) return;
    try {
      const { getCurrentWebview } = await loadTauriWebview();
      nativeDragUnlisten = await getCurrentWebview().onDragDropEvent(event => {
        if (!open || !overlay.classList.contains('visible')) return;
        const payload = event.payload || {};
        if (payload.type === 'enter' || payload.type === 'over') uploadZone?.classList.add('dragover');
        else if (payload.type === 'leave') uploadZone?.classList.remove('dragover');
        else if (payload.type === 'drop') {
          uploadZone?.classList.remove('dragover');
          const path = (payload.paths || []).find(value => /\.(png|jpe?g|webp)$/i.test(value));
          if (!path) { notify(t('home.colorExtractor.unsupportedFormat')); return; }
          void handleFile({ name: fileNameFromPath(path), path, size: 0, type: /\.png$/i.test(path) ? 'image/png' : /\.webp$/i.test(path) ? 'image/webp' : 'image/jpeg' });
        }
      });
      scope.use(() => { nativeDragUnlisten?.(); nativeDragUnlisten = null; });
    } catch (error) { console.warn('[Color Extractor] native drag binding failed:', error); }
  }

  async function bindScreenEvents() {
    if (!isTauri) return;
    const { listen } = await tauriEventPromise;
    scope.use(await listen('screen-color-picked', event => { if (open) renderScreenResult(event?.payload); }));
    scope.use(await listen('screen-picker-ready', () => { statusText(t('home.colorExtractor.screenReady')); if (screenStartButton) screenStartButton.disabled = false; }));
    scope.use(await listen('screen-picker-cancelled', () => { statusText(getLang() === 'zh' ? '已取消取色' : 'Sampling cancelled'); if (screenStartButton) screenStartButton.disabled = false; }));
    scope.use(await listen('screen-picker-closed', () => { if (screenStartButton) screenStartButton.disabled = false; }));
  }
  void bindNativeDrop().catch(error => console.warn('[Color Extractor] native drag binding failed:', error));
  void bindScreenEvents().catch(error => console.warn('[Color Extractor] screen event binding failed:', error));

  return {
    open() { if (disposed || open) return; open = true; resetState(); setMode('image'); },
    close() {
      if (!open) return;
      open = false;
      requestRevision += 1;
      releasePreviewUrl();
      if (closeNativeScreenPicker) void closeNativeScreenPicker();
      else if (isTauri) void tauriCorePromise.then(({ invoke }) => invoke('close_screen_color_picker')).catch(() => {});
    },
    dispose() { if (disposed) return; disposed = true; open = false; requestRevision += 1; releasePreviewUrl(); scope.dispose(); }
  };
}
