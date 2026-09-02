import { createLifecycleScope } from '../../app/tool-lifecycle.js';
import { t } from '../../i18n.js';
import {
  loadTauriDialog,
  loadTauriWebview,
  tauriCorePromise
} from '../../platform/tauri-runtime.js';
import {
  cropStatesEqual,
  constrainCropToRatio,
  displayPointToSource,
  exportCropRect,
  fitCropToRatio,
  flipCropRect,
  moveCropRect,
  normalizeRotation,
  resizeCropRect,
  rotateCropRect,
  snapCropToCenter,
  sourceRectToDisplay,
  transformedImageSize
} from './core.js';

const WEBSITE_URL = 'https://toolknit.com';
const IMAGE_PATH_PATTERN = /\.(?:jpe?g|png|webp|bmp|gif)$/i;
const IMAGE_FILE_ACCEPT = 'image/jpeg,image/png,image/webp,image/bmp,image/gif';

function errorMessage(error) {
  const code = String(error?.message || error || '');
  if (code.includes('invalid-output-name')) return '文件名包含 Windows 不允许的字符，请修改后重试。';
  if (code.includes('crop-out-of-bounds')) return '裁剪区域超出图片边界，请重置裁剪框后重试。';
  if (code.includes('invalid-input') || code.includes('decode-failed')) return '无法读取这张图片，文件可能已损坏或格式不受支持。';
  if (code.includes('output-dir') || code.includes('publish-failed')) return '无法写入输出目录，请检查存储设置和磁盘权限。';
  return `导出失败：${code.replace('image-crop:', '')}`;
}

export function createImageCropController({
  overlay,
  successOverlay,
  notify = message => window.showToast?.(message),
  isTauri = false,
  initStandardToolPlasma = () => null,
  disposeStandardToolPlasma = disposer => disposer?.(),
  getOutputDir,
  formatFileSize = value => String(value || 0),
  displayFilesystemPath = value => String(value || ''),
  openSettings = () => {},
  openSupport = () => {},
  openExternalUrl = () => {},
  handleWindowAction = () => {},
  refreshIcons = () => {}
} = {}) {
  if (!overlay || !successOverlay || typeof getOutputDir !== 'function') {
    return { open() {}, close() {}, dispose() {} };
  }

  const lifecycle = createLifecycleScope();
  const query = selector => overlay.querySelector(selector);
  const successQuery = selector => successOverlay.querySelector(selector);
  const listen = (target, type, handler, options) => target
    ? lifecycle.event(target, type, handler, options)
    : () => {};

  const canvas = query('#imageCropCanvas');
  const stageShell = query('#imageCropStageShell');
  const empty = query('#imageCropEmpty');
  const pick = query('#imageCropPick');
  const pickLabel = query('#imageCropPickLabel');
  const exportButton = query('#imageCropExport');
  const processing = query('#imageCropProcessing');
  const snapIndicator = query('#imageCropSnapIndicator');
  const selectionSize = query('#imageCropSelectionSize');
  const fileMeta = query('#imageCropFileMeta');
  const outputName = query('#imageCropOutputName');
  const quality = query('#imageCropQuality');
  const qualityValue = query('#imageCropQualityValue');
  const qualityWrap = query('#imageCropQualityWrap');
  const backgroundWrap = query('#imageCropBackgroundWrap');
  const background = query('#imageCropBackground');
  const guide = query('#imageCropGuide');
  const spiralDirection = query('#imageCropSpiralDirection');
  const snap = query('#imageCropSnap');
  const undo = query('#imageCropUndo');
  const redo = query('#imageCropRedo');
  const plasmaBackground = query('#imageCropPlasmaBg');
  const dropZone = query('#imageCropDropZone');
  const ratioGrid = query('#imageCropRatioGrid');
  const customRatio = query('#imageCropCustomRatio');
  const ratioWidth = query('#imageCropRatioWidth');
  const ratioHeight = query('#imageCropRatioHeight');
  const transformTools = query('.image-crop-icon-tools');
  const formatOptions = query('#imageCropFormat');
  const successMeta = successQuery('#imageCropSuccessMeta');
  const successSize = successQuery('#imageCropSuccessSize');
  const successPath = successQuery('#imageCropSuccessPath');

  let disposed = false;
  let session = null;
  let image = null;
  let objectUrl = '';
  let source = null;
  let cropRect = null;
  let displayRect = null;
  let rotation = 0;
  let flipHorizontal = false;
  let flipVertical = false;
  let ratioMode = 'free';
  let format = 'png';
  let spiralRotation = 0;
  let interaction = null;
  let snapState = { x: false, y: false };
  let history = [];
  let historyIndex = -1;
  let frame = 0;
  let busy = false;
  let lastOutputPath = '';
  let loadSequence = 0;
  let operationSequence = 0;
  let activeOperation = null;

  const isOpenSession = owner => owner && owner === session && !owner.disposed
    && !disposed && overlay.classList.contains('visible');
  const isCurrentLoad = (owner, requestId) => isOpenSession(owner) && requestId === loadSequence;
  const isCurrentOperation = operation => operation && activeOperation === operation
    && isOpenSession(operation.owner) && operation.id === operationSequence;

  function currentSize() {
    if (!source) return { width: 1, height: 1 };
    return transformedImageSize(source.width, source.height, rotation);
  }

  function ratioValue() {
    if (ratioMode === 'free') return null;
    const size = currentSize();
    if (ratioMode === 'original') return size.width / size.height;
    if (ratioMode === 'custom') {
      const width = Math.max(1, Number(ratioWidth?.value) || 1);
      const height = Math.max(1, Number(ratioHeight?.value) || 1);
      return width / height;
    }
    const [width, height] = ratioMode.split(':').map(Number);
    return width > 0 && height > 0 ? width / height : null;
  }

  function snapshot() {
    return {
      rect: cropRect ? { ...cropRect } : null,
      rotation,
      flipHorizontal,
      flipVertical
    };
  }

  function updateHistoryButtons() {
    if (undo) undo.disabled = historyIndex <= 0 || busy;
    if (redo) redo.disabled = historyIndex < 0 || historyIndex >= history.length - 1 || busy;
  }

  function pushHistory() {
    if (!cropRect) return;
    const next = snapshot();
    const current = history[historyIndex];
    if (current && cropStatesEqual(current, next)) return;
    history.splice(historyIndex + 1);
    history.push(next);
    if (history.length > 60) history.shift();
    historyIndex = history.length - 1;
    updateHistoryButtons();
  }

  function applySnapshot(next) {
    if (!next?.rect) return;
    cropRect = { ...next.rect };
    rotation = normalizeRotation(next.rotation);
    flipHorizontal = Boolean(next.flipHorizontal);
    flipVertical = Boolean(next.flipVertical);
    snapState = { x: false, y: false };
    scheduleRender();
    updateHistoryButtons();
  }

  function drawGuideLines(context, crop) {
    const selectedGuide = guide?.value || 'thirds';
    if (selectedGuide === 'none') return;
    const { x, y, width, height } = crop;
    context.save();
    context.beginPath();
    context.rect(x, y, width, height);
    context.clip();
    context.strokeStyle = 'rgba(255,255,255,.58)';
    context.lineWidth = 1;
    const line = (x1, y1, x2, y2) => {
      context.moveTo(x1, y1);
      context.lineTo(x2, y2);
    };
    context.beginPath();
    if (selectedGuide === 'thirds') {
      line(x + width / 3, y, x + width / 3, y + height);
      line(x + width * 2 / 3, y, x + width * 2 / 3, y + height);
      line(x, y + height / 3, x + width, y + height / 3);
      line(x, y + height * 2 / 3, x + width, y + height * 2 / 3);
    } else if (selectedGuide === 'golden') {
      const short = 0.381966;
      line(x + width * short, y, x + width * short, y + height);
      line(x + width * (1 - short), y, x + width * (1 - short), y + height);
      line(x, y + height * short, x + width, y + height * short);
      line(x, y + height * (1 - short), x + width, y + height * (1 - short));
    } else if (selectedGuide === 'crosshair') {
      line(x + width / 2, y, x + width / 2, y + height);
      line(x, y + height / 2, x + width, y + height / 2);
      const radius = Math.min(width, height) * 0.08;
      context.moveTo(x + width / 2 + radius, y + height / 2);
      context.arc(x + width / 2, y + height / 2, radius, 0, Math.PI * 2);
    } else if (selectedGuide === 'diagonals') {
      line(x, y, x + width, y + height);
      line(x + width, y, x, y + height);
    } else if (selectedGuide === 'grid') {
      for (let index = 1; index < 4; index += 1) {
        line(x + width * index / 4, y, x + width * index / 4, y + height);
        line(x, y + height * index / 4, x + width, y + height * index / 4);
      }
    } else if (selectedGuide === 'safe-area') {
      context.rect(x + width * 0.05, y + height * 0.05, width * 0.9, height * 0.9);
      context.rect(x + width * 0.1, y + height * 0.1, width * 0.8, height * 0.8);
    }
    context.stroke();
    if (selectedGuide === 'spiral') {
      const golden = 1.61803398875;
      context.translate(x + width / 2, y + height / 2);
      context.rotate(spiralRotation * Math.PI / 2);
      context.beginPath();
      const baseRadius = Math.min(width, height) * 0.025;
      for (let angle = 0; angle <= Math.PI * 4.5; angle += 0.05) {
        const value = baseRadius * Math.pow(golden, angle / (Math.PI / 2));
        const pointX = Math.cos(angle) * value;
        const pointY = Math.sin(angle) * value;
        if (angle === 0) context.moveTo(pointX, pointY);
        else context.lineTo(pointX, pointY);
      }
      context.stroke();
    }
    context.restore();
  }

  function renderCanvas() {
    frame = 0;
    if (!canvas || !stageShell || !image || !cropRect || !isOpenSession(session)) return;
    const width = Math.max(1, canvas.clientWidth);
    const height = Math.max(1, canvas.clientHeight);
    const pixelRatio = Math.min(2, window.devicePixelRatio || 1);
    const pixelWidth = Math.round(width * pixelRatio);
    const pixelHeight = Math.round(height * pixelRatio);
    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
      canvas.width = pixelWidth;
      canvas.height = pixelHeight;
    }
    const context = canvas.getContext('2d');
    if (!context) return;
    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    context.clearRect(0, 0, width, height);
    const imageSize = currentSize();
    const padding = Math.min(34, Math.max(14, Math.min(width, height) * 0.05));
    const scale = Math.min((width - padding * 2) / imageSize.width, (height - padding * 2) / imageSize.height);
    const displayWidth = imageSize.width * scale;
    const displayHeight = imageSize.height * scale;
    displayRect = {
      x: (width - displayWidth) / 2,
      y: (height - displayHeight) / 2,
      width: displayWidth,
      height: displayHeight
    };

    context.save();
    context.translate(width / 2, height / 2);
    context.scale(scale * (flipHorizontal ? -1 : 1), scale * (flipVertical ? -1 : 1));
    context.rotate(rotation * Math.PI / 180);
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    context.drawImage(image, -source.width / 2, -source.height / 2, source.width, source.height);
    context.restore();

    const crop = sourceRectToDisplay(cropRect, displayRect, imageSize);
    context.save();
    context.fillStyle = 'rgba(0,0,0,.62)';
    context.beginPath();
    context.rect(displayRect.x, displayRect.y, displayRect.width, displayRect.height);
    context.rect(crop.x, crop.y, crop.width, crop.height);
    context.fill('evenodd');
    context.restore();

    if (snapState.x || snapState.y) {
      context.save();
      context.strokeStyle = 'rgba(255,255,255,.42)';
      context.setLineDash([3, 5]);
      context.beginPath();
      if (snapState.x) {
        context.moveTo(displayRect.x + displayRect.width / 2, displayRect.y);
        context.lineTo(displayRect.x + displayRect.width / 2, displayRect.y + displayRect.height);
      }
      if (snapState.y) {
        context.moveTo(displayRect.x, displayRect.y + displayRect.height / 2);
        context.lineTo(displayRect.x + displayRect.width, displayRect.y + displayRect.height / 2);
      }
      context.stroke();
      context.restore();
    }

    drawGuideLines(context, crop);
    context.save();
    context.strokeStyle = 'rgba(255,255,255,.96)';
    context.lineWidth = 1.5;
    context.strokeRect(crop.x + 0.75, crop.y + 0.75, Math.max(0, crop.width - 1.5), Math.max(0, crop.height - 1.5));
    const handles = [
      [crop.x, crop.y], [crop.x + crop.width / 2, crop.y], [crop.x + crop.width, crop.y],
      [crop.x, crop.y + crop.height / 2], [crop.x + crop.width, crop.y + crop.height / 2],
      [crop.x, crop.y + crop.height], [crop.x + crop.width / 2, crop.y + crop.height],
      [crop.x + crop.width, crop.y + crop.height]
    ];
    context.fillStyle = '#fff';
    context.strokeStyle = 'rgba(0,0,0,.7)';
    handles.forEach(([handleX, handleY]) => {
      context.fillRect(handleX - 3.5, handleY - 3.5, 7, 7);
      context.strokeRect(handleX - 3.5, handleY - 3.5, 7, 7);
    });
    context.restore();
    const exported = exportCropRect(cropRect, imageSize);
    if (selectionSize) selectionSize.textContent = `${exported.width} × ${exported.height} px · ${format.toUpperCase()}`;
  }

  function scheduleRender() {
    if (!frame && isOpenSession(session)) frame = requestAnimationFrame(renderCanvas);
  }

  function hitTest(point) {
    if (!cropRect || !displayRect) return null;
    const crop = sourceRectToDisplay(cropRect, displayRect, currentSize());
    const threshold = 11;
    const nearX = Math.abs(point.x - crop.x) <= threshold
      ? 'w'
      : Math.abs(point.x - crop.x - crop.width) <= threshold ? 'e' : '';
    const nearY = Math.abs(point.y - crop.y) <= threshold
      ? 'n'
      : Math.abs(point.y - crop.y - crop.height) <= threshold ? 's' : '';
    if (nearX && point.y >= crop.y - threshold && point.y <= crop.y + crop.height + threshold) return `${nearY}${nearX}` || nearX;
    if (nearY && point.x >= crop.x - threshold && point.x <= crop.x + crop.width + threshold) return `${nearY}${nearX}` || nearY;
    if (point.x >= crop.x && point.x <= crop.x + crop.width && point.y >= crop.y && point.y <= crop.y + crop.height) return 'move';
    return null;
  }

  function pointerPoint(event) {
    const bounds = canvas.getBoundingClientRect();
    return { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
  }

  function clearInteraction() {
    if (interaction && canvas) {
      try {
        if (canvas.hasPointerCapture(interaction.pointerId)) canvas.releasePointerCapture(interaction.pointerId);
      } catch {}
    }
    interaction = null;
    snapState = { x: false, y: false };
    snapIndicator?.classList.remove('visible');
    canvas?.classList.remove('is-moving', 'is-resizing');
  }

  function finishPointer(event) {
    if (!interaction || (event.pointerId !== undefined && event.pointerId !== interaction.pointerId)) return;
    clearInteraction();
    pushHistory();
    scheduleRender();
  }

  function clearSource() {
    loadSequence += 1;
    clearInteraction();
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = '';
    if (image) image.src = '';
    image = null;
    source = null;
    cropRect = null;
    displayRect = null;
    history = [];
    historyIndex = -1;
    stageShell?.classList.remove('has-image', 'is-dragging');
    dropZone?.classList.remove('visible');
    if (exportButton) exportButton.disabled = true;
    if (fileMeta) fileMeta.textContent = '精确构图，原始分辨率本地导出';
    if (selectionSize) selectionSize.textContent = '等待载入图片';
    updateHistoryButtons();
  }

  async function invoke(command, args) {
    const api = await tauriCorePromise;
    return api.invoke(command, args);
  }

  async function loadSource(nextSource, owner = session) {
    if (!nextSource || busy || !isOpenSession(owner)) return;
    const requestId = ++loadSequence;
    let localObjectUrl = '';
    try {
      let previewUrl;
      let path = '';
      let name = nextSource.name || '';
      let width;
      let height;
      if (typeof nextSource === 'string') {
        path = nextSource;
        name = path.split(/[\\/]/).pop() || path;
        const [inspected] = await invoke('inspect_image_stitch_inputs', { inputPaths: [path] });
        if (!isCurrentLoad(owner, requestId)) return;
        if (!inspected) throw new Error('无法读取图片');
        previewUrl = inspected.preview_data_url || inspected.previewDataUrl
          || inspected.thumbnail_data_url || inspected.thumbnailDataUrl;
        width = inspected.width;
        height = inspected.height;
      } else {
        if (!/^image\//.test(nextSource.type || '')) throw new Error('请选择图片文件');
        localObjectUrl = URL.createObjectURL(nextSource);
        previewUrl = localObjectUrl;
      }

      const decoded = new Image();
      await new Promise((resolve, reject) => {
        decoded.onload = resolve;
        decoded.onerror = () => reject(new Error('图片解码失败'));
        decoded.src = previewUrl;
      });
      if (!isCurrentLoad(owner, requestId)) {
        decoded.src = '';
        if (localObjectUrl) URL.revokeObjectURL(localObjectUrl);
        return;
      }
      if (localObjectUrl) {
        if (objectUrl) URL.revokeObjectURL(objectUrl);
        objectUrl = localObjectUrl;
        localObjectUrl = '';
      }
      image = decoded;
      source = {
        path,
        name,
        width: Number(width) || decoded.naturalWidth,
        height: Number(height) || decoded.naturalHeight
      };
      rotation = 0;
      flipHorizontal = false;
      flipVertical = false;
      ratioMode = 'free';
      ratioGrid?.querySelectorAll('[data-ratio]').forEach(button => {
        button.classList.toggle('active', button.dataset.ratio === 'free');
      });
      if (customRatio) customRatio.hidden = true;
      cropRect = fitCropToRatio(currentSize(), null, 0.88);
      history = [snapshot()];
      historyIndex = 0;
      stageShell?.classList.add('has-image');
      if (exportButton) exportButton.disabled = !path;
      if (fileMeta) fileMeta.textContent = `${name} · ${source.width} × ${source.height} px`;
      if (outputName) outputName.value = `${name.replace(/\.[^.]+$/, '')}_crop`;
      if (pickLabel) pickLabel.textContent = '替换图片';
      updateHistoryButtons();
      scheduleRender();
      canvas?.focus({ preventScroll: true });
    } catch (error) {
      if (localObjectUrl) URL.revokeObjectURL(localObjectUrl);
      if (!isCurrentLoad(owner, requestId)) return;
      notify(`无法载入图片：${String(error?.message || error).replace('image-stitch:', '')}`);
    }
  }

  async function pickSource() {
    const owner = session;
    if (busy || !isOpenSession(owner)) return;
    if (isTauri) {
      const { open } = await loadTauriDialog();
      const selected = await open({
        multiple: false,
        filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'webp', 'bmp', 'gif'] }]
      });
      if (!isOpenSession(owner)) return;
      if (typeof selected === 'string') await loadSource(selected, owner);
      return;
    }
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = IMAGE_FILE_ACCEPT;
    input.addEventListener('change', () => {
      if (isOpenSession(owner) && input.files?.[0]) void loadSource(input.files[0], owner);
    }, { once: true });
    input.click();
  }

  async function registerNativeDrop(owner) {
    if (!isTauri) return;
    try {
      const { getCurrentWebview } = await loadTauriWebview();
      if (!isOpenSession(owner)) return;
      const unlisten = await getCurrentWebview().onDragDropEvent(event => {
        if (!isOpenSession(owner) || busy) return;
        const payload = event.payload;
        if (payload.type === 'enter' || payload.type === 'over') dropZone?.classList.add('visible');
        else if (payload.type === 'leave') dropZone?.classList.remove('visible');
        else if (payload.type === 'drop') {
          dropZone?.classList.remove('visible');
          const path = (payload.paths || []).find(value => IMAGE_PATH_PATTERN.test(value));
          if (path) void loadSource(path, owner);
        }
      });
      if (!isOpenSession(owner)) {
        unlisten();
        return;
      }
      owner.use(unlisten);
    } catch {
      // Native drag/drop is optional; picker loading remains available.
    }
  }

  async function exportImage() {
    if (!source?.path || !cropRect || busy || !isOpenSession(session)) return;
    const operation = { id: ++operationSequence, owner: session };
    activeOperation = operation;
    busy = true;
    processing?.classList.add('visible');
    exportButton.disabled = true;
    updateHistoryButtons();
    try {
      const crop = exportCropRect(cropRect, currentSize());
      const outputDir = await getOutputDir('Images/Image Crop');
      if (!isCurrentOperation(operation)) return;
      const result = await invoke('crop_image', {
        inputPath: source.path,
        outputDir,
        outputName: outputName?.value.trim() || null,
        cropX: crop.x,
        cropY: crop.y,
        cropWidth: crop.width,
        cropHeight: crop.height,
        rotation,
        flipHorizontal,
        flipVertical,
        format,
        jpegQuality: Number(quality?.value) || 92,
        backgroundRgba: `${background?.value || '#ffffff'}FF`
      });
      if (!isCurrentOperation(operation)) return;
      lastOutputPath = result.output_path || result.outputPath || '';
      if (successMeta) successMeta.textContent = `${result.format} · ${formatFileSize(Number(result.bytes) || 0)}`;
      if (successSize) successSize.textContent = `${result.width} × ${result.height} px`;
      if (successPath) successPath.textContent = displayFilesystemPath(lastOutputPath);
      successOverlay.classList.add('visible');
    } catch (error) {
      if (isCurrentOperation(operation)) notify(errorMessage(error));
    } finally {
      const shouldRestore = isCurrentOperation(operation);
      if (activeOperation === operation) activeOperation = null;
      if (!shouldRestore) return;
      busy = false;
      processing?.classList.remove('visible');
      exportButton.disabled = !source?.path;
      updateHistoryButtons();
    }
  }

  async function openOutput() {
    const path = lastOutputPath;
    successOverlay.classList.remove('visible');
    if (!isTauri || !path) return;
    try {
      await invoke('open_path', { path });
    } catch {
      notify(t('common.openFolderFailed'));
    }
  }

  function resetSessionState() {
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    activeOperation = null;
    operationSequence += 1;
    busy = false;
    processing?.classList.remove('visible');
    clearSource();
    lastOutputPath = '';
    successOverlay.classList.remove('visible');
    if (pickLabel) pickLabel.textContent = '选择图片';
  }

  listen(canvas, 'pointerdown', event => {
    if (busy || !displayRect || !cropRect) return;
    const point = pointerPoint(event);
    const handle = hitTest(point);
    if (!handle) return;
    event.preventDefault();
    canvas.setPointerCapture(event.pointerId);
    interaction = {
      pointerId: event.pointerId,
      handle,
      start: displayPointToSource(point, displayRect, currentSize()),
      rect: { ...cropRect }
    };
    canvas.classList.toggle('is-moving', handle === 'move');
    canvas.classList.toggle('is-resizing', handle !== 'move');
  });
  listen(canvas, 'pointermove', event => {
    const point = pointerPoint(event);
    if (!interaction) {
      const handle = hitTest(point);
      canvas.style.cursor = handle === 'move'
        ? 'move'
        : handle ? `${handle === 'ne' || handle === 'sw' ? 'nesw' : handle === 'n' || handle === 's' ? 'ns' : handle === 'e' || handle === 'w' ? 'ew' : 'nwse'}-resize` : 'default';
      return;
    }
    const sourcePoint = displayPointToSource(point, displayRect, currentSize());
    const deltaX = sourcePoint.x - interaction.start.x;
    const deltaY = sourcePoint.y - interaction.start.y;
    const imageSize = currentSize();
    if (interaction.handle === 'move') {
      cropRect = moveCropRect(interaction.rect, deltaX, deltaY, imageSize);
      if (snap?.checked && !event.altKey) {
        const displayScale = displayRect.width / imageSize.width;
        const snapped = snapCropToCenter(cropRect, imageSize, displayScale, snapState);
        cropRect = snapped.rect;
        snapState = snapped.snapped;
      } else snapState = { x: false, y: false };
    } else {
      cropRect = resizeCropRect(interaction.rect, interaction.handle, deltaX, deltaY, imageSize, ratioValue());
      snapState = { x: false, y: false };
    }
    snapIndicator?.classList.toggle('visible', snapState.x || snapState.y);
    scheduleRender();
  });
  listen(canvas, 'pointerup', finishPointer);
  listen(canvas, 'pointercancel', finishPointer);
  listen(canvas, 'lostpointercapture', finishPointer);
  listen(canvas, 'keydown', event => {
    if (!cropRect || busy || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
    event.preventDefault();
    const step = event.shiftKey ? 10 : 1;
    cropRect = moveCropRect(
      cropRect,
      event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0,
      event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0,
      currentSize()
    );
    pushHistory();
    scheduleRender();
  });

  listen(query('#imageCropBack'), 'click', () => api.close());
  listen(pick, 'click', () => { void pickSource(); });
  listen(empty, 'click', () => { void pickSource(); });
  listen(ratioGrid, 'click', event => {
    const button = event.target.closest('[data-ratio]');
    if (!button || busy) return;
    ratioMode = button.dataset.ratio;
    ratioGrid.querySelectorAll('[data-ratio]').forEach(item => item.classList.toggle('active', item === button));
    if (customRatio) customRatio.hidden = ratioMode !== 'custom';
    if (cropRect) {
      cropRect = fitCropToRatio(currentSize(), ratioValue(), 0.88);
      pushHistory();
      scheduleRender();
    }
  });
  const updateCustomRatio = () => {
    if (ratioMode === 'custom' && cropRect) {
      cropRect = fitCropToRatio(currentSize(), ratioValue(), 0.88);
      pushHistory();
      scheduleRender();
    }
  };
  listen(ratioWidth, 'change', updateCustomRatio);
  listen(ratioHeight, 'change', updateCustomRatio);
  listen(transformTools, 'click', event => {
    const button = event.target.closest('[data-crop-transform]');
    if (!button || !cropRect || busy) return;
    const action = button.dataset.cropTransform;
    const size = currentSize();
    if (action === 'rotate-left' || action === 'rotate-right') {
      const direction = action === 'rotate-left' ? 270 : 90;
      const rotated = rotateCropRect(cropRect, size, direction);
      cropRect = rotated.rect;
      rotation = normalizeRotation(rotation + direction);
      [flipHorizontal, flipVertical] = [flipVertical, flipHorizontal];
      if (ratioMode !== 'free') cropRect = constrainCropToRatio(cropRect, currentSize(), ratioValue());
    } else if (action === 'flip-horizontal') {
      cropRect = flipCropRect(cropRect, size, 'horizontal');
      flipHorizontal = !flipHorizontal;
    } else if (action === 'flip-vertical') {
      cropRect = flipCropRect(cropRect, size, 'vertical');
      flipVertical = !flipVertical;
    } else if (action === 'reset') {
      rotation = 0;
      flipHorizontal = false;
      flipVertical = false;
      cropRect = fitCropToRatio(currentSize(), ratioValue(), 0.88);
    }
    pushHistory();
    scheduleRender();
  });
  listen(undo, 'click', () => {
    if (historyIndex > 0) {
      historyIndex -= 1;
      applySnapshot(history[historyIndex]);
    }
  });
  listen(redo, 'click', () => {
    if (historyIndex < history.length - 1) {
      historyIndex += 1;
      applySnapshot(history[historyIndex]);
    }
  });
  listen(guide, 'change', () => {
    if (spiralDirection) spiralDirection.hidden = guide.value !== 'spiral';
    scheduleRender();
  });
  listen(spiralDirection, 'click', () => {
    spiralRotation = (spiralRotation + 1) % 4;
    scheduleRender();
  });
  listen(snap, 'change', () => {
    snapState = { x: false, y: false };
    snapIndicator?.classList.remove('visible');
    scheduleRender();
  });
  listen(quality, 'input', () => {
    if (qualityValue) qualityValue.textContent = quality.value;
  });
  listen(formatOptions, 'click', event => {
    const button = event.target.closest('[data-format]');
    if (!button || busy) return;
    format = button.dataset.format;
    formatOptions.querySelectorAll('[data-format]').forEach(item => item.classList.toggle('active', item === button));
    const jpeg = format === 'jpg';
    if (qualityWrap) qualityWrap.hidden = !jpeg;
    if (backgroundWrap) backgroundWrap.hidden = !jpeg;
    scheduleRender();
  });
  listen(exportButton, 'click', () => { void exportImage(); });
  listen(successQuery('#imageCropSuccessOk'), 'click', () => successOverlay.classList.remove('visible'));
  listen(successQuery('#imageCropOpenFolder'), 'click', () => { void openOutput(); });
  listen(query('[data-home-link="website"]'), 'click', event => {
    event.preventDefault();
    void openExternalUrl(WEBSITE_URL);
  });
  listen(query('[data-open-support]'), 'click', openSupport);
  listen(query('#imageCropV2Settings'), 'click', openSettings);
  queryAllWindowButtons().forEach(button => {
    listen(button, 'pointerdown', event => event.stopPropagation(), { capture: true });
    listen(button, 'mousedown', event => event.stopPropagation(), { capture: true });
    listen(button, 'click', event => {
      event.preventDefault();
      event.stopPropagation();
      void handleWindowAction(button.dataset.action);
    });
  });

  function queryAllWindowButtons() {
    return Array.from(overlay.querySelectorAll('.ctrl-btn[data-action]'));
  }

  const api = {
    open() {
      if (disposed || session) return;
      const owner = createLifecycleScope();
      session = owner;
      overlay.classList.add('visible');
      overlay.setAttribute('aria-hidden', 'false');
      const plasma = initStandardToolPlasma(plasmaBackground);
      owner.use(() => disposeStandardToolPlasma(plasma));
      if (stageShell && typeof ResizeObserver !== 'undefined') {
        const observer = new ResizeObserver(scheduleRender);
        observer.observe(stageShell);
        owner.use(() => observer.disconnect());
      }
      void registerNativeDrop(owner);
      scheduleRender();
      refreshIcons();
    },
    close({ force = false } = {}) {
      if (!session || (busy && !force)) return false;
      const owner = session;
      session = null;
      owner.dispose();
      resetSessionState();
      overlay.classList.remove('visible');
      overlay.setAttribute('aria-hidden', 'true');
      return true;
    },
    dispose() {
      if (disposed) return;
      api.close({ force: true });
      disposed = true;
      lifecycle.dispose();
    }
  };

  return api;
}
