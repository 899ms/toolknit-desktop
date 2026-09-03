import { createLifecycleScope } from '../../app/tool-lifecycle.js';
import { onLangChange } from '../../i18n.js';
import { loadTauriDialog, tauriCorePromise, tauriEventPromise } from '../../platform/tauri-runtime.js';
import { frameTimeLabel, normalizeVideoFrameFormat, normalizeVideoFrameTimestamp, validateVideoFrameInput } from '../../video-frame-core.js';
import {
  VIDEO_EXTENSIONS,
  clearQueuedVideoPreview,
  createPreviewQueue,
  fileNameFromPath,
  localVideoFile,
  registerNativeVideoDrop,
  scheduleVideoPreview,
  setDropVisible
} from './shared.js';

const PREVIEW_WINDOW_MS = 30_000;

export function createVideoFrameController({
  overlay,
  isTauri = false,
  t = value => value,
  onLangChange: registerLanguageChange = onLangChange,
  notify = () => {},
  initStandardToolPlasma = () => null,
  disposeStandardToolPlasma = instance => instance?.(),
  getOutputDir = async () => '',
  openOutputFolder = async () => false,
  displayFilesystemPath = value => String(value || ''),
  refreshIcons = () => {},
  openSettings = () => {},
  openSupport = () => {},
  openExternalUrl = () => {},
  handleWindowAction = () => {},
  documentRef = globalThis.document
} = {}) {
  if (!overlay || !documentRef) throw new Error('video-frame:missing-root');
  const byId = id => documentRef.getElementById(id);
  const dropZone = byId('videoFrameDropZone');
  const empty = byId('videoFrameEmpty');
  const editor = byId('videoFrameEditor');
  const previewVideo = byId('videoFramePreviewVideo');
  const previewImage = byId('videoFramePreviewImage');
  const previewToggle = byId('videoFramePreviewToggle');
  const timeline = byId('videoFrameTimeline');
  const timestampInput = byId('videoFrameTimestamp');
  const timeLabel = byId('videoFrameTime');
  const fileName = byId('videoFrameName');
  const formatOptions = byId('videoFrameFormat');
  const processMask = byId('videoFrameProcessMask');
  const processFill = byId('videoFrameProcessBarFill');
  const processText = byId('videoFrameProcessText');
  const success = byId('videoFrameSuccessOverlay');
  const successMeta = byId('videoFrameSuccessMeta');
  const successFormat = byId('videoFrameSuccessFormat');
  const successTime = byId('videoFrameSuccessTime');
  const successPath = byId('videoFrameSuccessPath');
  const plasmaBackground = byId('videoFramePlasmaBg');
  const lifecycle = createLifecycleScope({ onError: error => console.error('[Video Frame] cleanup:', error) });
  let session = null;
  let plasma = null;
  let nativeDropUnlisten = null;
  let file = null;
  let duration = 0;
  let stepMs = 33;
  let timestampMs = 0;
  let outputFormat = 'png';
  let previewRange = null;
  let previewToken = 0;
  let previewLoading = false;
  let processing = false;
  let operationId = 0;
  let outputPath = '';
  const previewQueue = createPreviewQueue();
  let disposed = false;

  const current = owner => Boolean(owner && owner === session && !disposed && overlay.classList.contains('visible'));
  const maxMs = () => Math.max(0, Math.round(duration * 1000));

  function setProgress(value, message = t('home.videoFrame.processing'), visible = true) {
    if (processFill) processFill.style.width = `${Math.max(0, Math.min(100, value))}%`;
    if (processText) processText.textContent = message;
    processMask?.classList.toggle('visible', visible);
  }

  function updateToggle() {
    const playing = Boolean(previewVideo && !previewVideo.paused && !previewVideo.ended);
    const enabled = Boolean(file?.path && duration > 0 && !previewLoading);
    if (previewToggle) {
      previewToggle.disabled = !enabled;
      previewToggle.classList.toggle('is-loading', previewLoading);
      previewToggle.classList.toggle('is-playing', playing);
      previewToggle.setAttribute('aria-pressed', String(playing));
      previewToggle.setAttribute('aria-label', playing ? '暂停视频' : '播放视频');
    }
    previewToggle?.querySelector('.video-gif-preview-play-icon')?.toggleAttribute('hidden', playing);
    previewToggle?.querySelector('.video-gif-preview-pause-icon')?.toggleAttribute('hidden', !playing);
  }

  function updateTimestamp(value, render = true, immediate = false) {
    timestampMs = Math.max(0, Math.min(maxMs(), Math.round(Number(value) || 0)));
    if (timeline) timeline.value = String(timestampMs);
    if (timestampInput) timestampInput.value = String(timestampMs);
    if (timeLabel) timeLabel.textContent = frameTimeLabel(timestampMs);
    if (render && file?.path) {
      if (previewRange && timestampMs >= previewRange.startMs && timestampMs <= previewRange.endMs && previewVideo) {
        previewVideo.currentTime = Math.max(0, (timestampMs - previewRange.startMs) / 1000);
        previewVideo.hidden = false;
        if (previewImage) previewImage.hidden = true;
      } else {
        previewVideo?.pause();
        previewVideo && (previewVideo.hidden = true);
        if (previewImage) {
          previewImage.hidden = false;
          scheduleVideoPreview(previewQueue, previewImage, file.path, timestampMs, { immediate, notify });
        }
      }
    }
    return timestampMs;
  }

  function clearPreview() {
    previewToken += 1;
    previewRange = null;
    previewLoading = false;
    clearQueuedVideoPreview(previewQueue, previewImage);
    if (previewVideo) {
      previewVideo.pause();
      previewVideo.removeAttribute('src');
      previewVideo.load();
      previewVideo.hidden = true;
    }
    updateToggle();
  }

  async function loadPreviewClip(at = timestampMs, autoplay = false) {
    if (!isTauri || !file?.path || !previewVideo) return false;
    const end = maxMs();
    if (!end) return false;
    const windowMs = Math.min(PREVIEW_WINDOW_MS, end);
    const start = end > windowMs ? Math.min(Math.floor(at / windowMs) * windowMs, end - windowMs) : 0;
    const range = { startMs: start, endMs: Math.max(start + 1, Math.min(end, start + windowMs)) };
    const token = ++previewToken;
    previewLoading = true;
    updateToggle();
    try {
      const { invoke } = await tauriCorePromise;
      const result = await invoke('render_video_preview_clip', { inputPath: file.path, startMs: range.startMs, endMs: range.endMs });
      const source = result?.media_data_url || result?.mediaDataUrl;
      if (!source || token !== previewToken) return false;
      previewVideo.pause();
      previewVideo.src = source;
      previewVideo.hidden = false;
      if (previewImage) previewImage.hidden = true;
      previewVideo.load();
      previewRange = range;
      updateTimestamp(at, true, true);
      if (autoplay) await previewVideo.play();
      return true;
    } catch (error) {
      if (token === previewToken) {
        previewRange = null;
        if (file?.path && previewImage) {
          previewVideo.hidden = true;
          previewImage.hidden = false;
          scheduleVideoPreview(previewQueue, previewImage, file.path, at, { immediate: true, notify });
        }
      }
      return false;
    } finally {
      if (token === previewToken) { previewLoading = false; updateToggle(); }
    }
  }

  async function loadFile(path) {
    if (!isTauri || !path || processing) return;
    const owner = session;
    const request = ++operationId;
    try {
      const { invoke } = await tauriCorePromise;
      const nextFile = localVideoFile(path);
      validateVideoFrameInput(nextFile);
      const probe = await invoke('probe_video', { inputPath: path });
      const nextDuration = Number(probe?.duration);
      if (!Number.isFinite(nextDuration) || nextDuration <= 0) throw new Error('无法读取视频时长。');
      if (!current(owner) || request !== operationId) return;
      file = { ...nextFile, size: Number(probe?.file_size ?? probe?.fileSize) || 0 };
      duration = nextDuration;
      stepMs = Number.isFinite(probe?.frame_rate) && probe.frame_rate > 0 && probe.frame_rate <= 240 ? 1000 / probe.frame_rate : 33;
      clearPreview();
      if (fileName) fileName.textContent = file.name;
      timeline && (timeline.max = String(maxMs()));
      empty && (empty.hidden = true);
      editor && (editor.hidden = false);
      overlay.classList.add('is-editing');
      updateTimestamp(0, true, true);
    } catch (error) {
      if (current(owner) && request === operationId) notify(error?.message || '无法读取视频文件。');
    }
  }

  async function chooseFile() {
    if (!isTauri || processing) { notify(t('home.videoFrame.desktopOnly')); return; }
    try {
      const { open } = await loadTauriDialog();
      const selected = await open({ multiple: false, filters: [{ name: 'Video', extensions: VIDEO_EXTENSIONS }] });
      if (typeof selected === 'string') await loadFile(selected);
    } catch (error) { console.error('[Video Frame] file picker failed:', error); }
  }

  async function playPreview() {
    if (!file?.path || previewLoading || !previewVideo) return;
    if (!previewRange || timestampMs < previewRange.startMs || timestampMs > previewRange.endMs) {
      await loadPreviewClip(timestampMs, true);
      return;
    }
    try { previewVideo.hidden = false; if (previewImage) previewImage.hidden = true; updateTimestamp(timestampMs, true, true); await previewVideo.play(); }
    catch (error) { notify(error?.message || '无法播放视频。'); }
  }

  function clearFile() {
    operationId += 1;
    file = null;
    duration = 0;
    timestampMs = 0;
    clearPreview();
    timeline && (timeline.max = '0');
    overlay.classList.remove('is-editing');
    editor && (editor.hidden = true);
    empty && (empty.hidden = false);
  }

  async function exportFrame() {
    if (!isTauri || !file?.path || processing) return;
    const owner = session;
    const request = ++operationId;
    processing = true;
    setProgress(8, t('home.videoFrame.processing'));
    let release = null;
    try {
      const [{ invoke }, { listen }] = await Promise.all([tauriCorePromise, tauriEventPromise]);
      const outputDir = await getOutputDir('Videos');
      const rawUnlisten = await listen('video-frame-progress', event => {
        if (!current(owner) || request !== operationId) return;
        const value = Math.max(0, Math.min(1, Number(event?.payload?.progress) || 0));
        setProgress(Math.max(8, value * 100), event?.payload?.phase === 'publish' ? '正在发布图片...' : '正在定位并导出帧...');
      });
      release = session?.use ? session.use(rawUnlisten) : rawUnlisten;
      const result = await invoke('extract_video_frame', { inputPath: file.path, outputDir, timestampMs, format: normalizeVideoFrameFormat(outputFormat) });
      release?.();
      if (!current(owner) || request !== operationId) return;
      outputPath = result?.output_path || result?.outputPath || '';
      successMeta && (successMeta.textContent = file.name);
      successFormat && (successFormat.textContent = String(result?.format || outputFormat).toUpperCase());
      successTime && (successTime.textContent = frameTimeLabel(result?.timestamp_ms ?? timestampMs));
      successPath && (successPath.textContent = displayFilesystemPath(outputPath));
      setProgress(100);
      session?.timeout(() => { if (current(owner) && request === operationId) { processing = false; setProgress(0, undefined, false); success?.classList.add('visible'); } }, 240);
    } catch (error) {
      release?.();
      if (current(owner) && request === operationId) { processing = false; setProgress(0, undefined, false); notify(error?.message || '导出失败。'); }
    }
  }

  function cancel() {
    operationId += 1;
    processing = false;
    setProgress(0, undefined, false);
    if (isTauri) void tauriCorePromise.then(({ invoke }) => invoke('cancel_convert')).catch(() => {});
  }

  function bindActions() {
    const action = (id, handler) => { const node = byId(id); if (node) lifecycle.event(node, 'click', event => { event.stopPropagation(); handler(event); }); };
    action('videoFrameBack', close);
    action('videoFrameV2Settings', openSettings);
    action('videoFramePick', () => { void chooseFile(); });
    action('videoFrameChange', () => { void chooseFile(); });
    action('videoFramePrev', () => updateTimestamp(timestampMs - stepMs));
    action('videoFrameNext', () => updateTimestamp(timestampMs + stepMs));
    action('videoFrameExport', () => { void exportFrame(); });
    action('videoFrameCancelBtn', cancel);
    action('videoFrameSuccessOk', () => success?.classList.remove('visible'));
    action('videoFrameOpenFolder', () => { if (outputPath) void openOutputFolder(outputPath); success?.classList.remove('visible'); });
    action('videoFramePreviewToggle', () => { if (previewVideo && !previewVideo.paused && !previewVideo.ended) previewVideo.pause(); else void playPreview(); });
    overlay.querySelectorAll('[data-home-link="website"]').forEach(node => lifecycle.event(node, 'click', () => openExternalUrl('https://toolknit.com')));
    overlay.querySelectorAll('[data-open-support]').forEach(node => lifecycle.event(node, 'click', openSupport));
    overlay.querySelectorAll('[data-action]').forEach(node => lifecycle.event(node, 'click', () => handleWindowAction(node.dataset.action)));
    lifecycle.event(timeline, 'input', () => updateTimestamp(timeline.value));
    lifecycle.event(timestampInput, 'change', () => { try { updateTimestamp(normalizeVideoFrameTimestamp(timestampInput.value, duration), true, true); } catch { updateTimestamp(timestampMs, false); } });
    lifecycle.event(formatOptions, 'click', event => {
      const button = event.target?.closest?.('[data-format]');
      if (!button) return;
      outputFormat = normalizeVideoFrameFormat(button.dataset.format);
      formatOptions.querySelectorAll('[data-format]').forEach(item => item.classList.toggle('active', item === button));
    });
    lifecycle.event(previewVideo, 'play', updateToggle);
    lifecycle.event(previewVideo, 'pause', updateToggle);
    lifecycle.event(previewVideo, 'ended', updateToggle);
    lifecycle.event(previewVideo, 'timeupdate', () => {
      if (!previewRange || !previewVideo || previewVideo.seeking) return;
      updateTimestamp(previewRange.startMs + Math.round(previewVideo.currentTime * 1000), false);
    });
    lifecycle.event(previewVideo, 'seeked', () => {
      if (!previewRange || !previewVideo) return;
      updateTimestamp(previewRange.startMs + Math.round(previewVideo.currentTime * 1000), false);
    });
    lifecycle.use(registerLanguageChange(() => refreshIcons()));
  }

  function open() {
    if (disposed) return;
    session?.dispose();
    session = createLifecycleScope();
    overlay.classList.add('visible');
    overlay.setAttribute('aria-hidden', 'false');
    if (!plasma && plasmaBackground) plasma = initStandardToolPlasma(plasmaBackground);
  }

  function close() {
    operationId += 1;
    cancel();
    session?.dispose();
    session = null;
    clearFile();
    success?.classList.remove('visible');
    overlay.classList.remove('visible');
    overlay.setAttribute('aria-hidden', 'true');
    setDropVisible(overlay, dropZone, false);
    plasma = disposeStandardToolPlasma(plasma);
  }

  bindActions();
  void registerNativeVideoDrop({
    isTauri,
    overlay,
    scope: lifecycle,
    isActive: () => overlay.classList.contains('visible'),
    isBusy: () => processing,
    onVisibility: visible => setDropVisible(overlay, dropZone, visible),
    onDrop: path => { void loadFile(path); },
    onUnsupported: () => notify('请拖入支持的视频文件。')
  }).then(unlisten => { if (!disposed) nativeDropUnlisten = unlisten; else unlisten?.(); }).catch(error => console.warn('[Video Frame] native drop unavailable:', error));

  return {
    open,
    close,
    dispose() {
      if (disposed) return;
      disposed = true;
      close();
      nativeDropUnlisten?.();
      nativeDropUnlisten = null;
      lifecycle.dispose();
    }
  };
}
