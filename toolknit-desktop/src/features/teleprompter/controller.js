import { createIcons, icons } from 'lucide';
import { getLang, onLangChange, t } from '../../i18n.js';
import { enhanceToolSelects } from '../../tool-custom-select.js';
import { createWaveformSlider } from '../../tool-waveform-slider.js';
import { createTeleprompterRecognitionController } from './recognition.js';
import { createTeleprompterDiagnostics } from './diagnostics.js';
import { teleprompterTemplate } from './template.js';
import {
  TELEPROMPTER_LIMITS,
  createSpeechFollower,
  estimateTeleprompterDuration,
  formatTeleprompterTime,
  segmentTeleprompterScript
} from '../../teleprompter-core.js';

const PREF_KEY = 'toolknit.teleprompter.preferences.v2';
const LEGACY_PREF_KEY = 'toolknit.teleprompter.preferences.v1';

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function readPreferences(isTauri = false) {
  const defaults = { engine: isTauri ? 'offline' : 'auto', voiceFollow: false, speed: 1, fontSize: 52, mirrorX: false, mirrorY: false };
  try {
    const stored = localStorage.getItem(PREF_KEY);
    const value = JSON.parse(stored || localStorage.getItem(LEGACY_PREF_KEY) || '{}');
    return {
      // V1 tried WebView2 speech first. Existing desktop preferences migrate
      // to the verified local engine while preserving every visual setting.
      engine: stored && ['auto', 'system', 'offline'].includes(value.engine) ? value.engine : defaults.engine,
      voiceFollow: Boolean(value.voiceFollow),
      speed: clamp(Number(value.speed) || 1, .4, 3),
      fontSize: clamp(Number(value.fontSize) || 52, TELEPROMPTER_LIMITS.minFontSize, TELEPROMPTER_LIMITS.maxFontSize),
      mirrorX: Boolean(value.mirrorX),
      mirrorY: Boolean(value.mirrorY)
    };
  } catch {
    return defaults;
  }
}

function savePreferences(value) {
  const safe = {
    engine: value.engine,
    voiceFollow: Boolean(value.voiceFollow),
    speed: value.speed,
    fontSize: value.fontSize,
    mirrorX: Boolean(value.mirrorX),
    mirrorY: Boolean(value.mirrorY)
  };
  localStorage.setItem(PREF_KEY, JSON.stringify(safe));
}

function isEditableTarget(target) {
  const tag = target?.tagName?.toLowerCase();
  return ['input', 'textarea', 'select'].includes(tag)
    || Boolean(target?.isContentEditable)
    || target?.getAttribute?.('role') === 'slider';
}

function formatFileSize(bytes) {
  const value = Number(bytes) || 0;
  if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(value >= 10 * 1024 * 1024 ? 0 : 1)} MB`;
  if (value >= 1024) return `${Math.round(value / 1024)} KB`;
  return `${value} B`;
}

export function initTeleprompterTool({
  overlay,
  notify = () => {},
  isTauri = false,
  readTextDocument,
  requestOfflineModel,
  initStandardToolPlasma,
  disposeStandardToolPlasma,
  openSettings,
  openSupport,
  openExternalUrl,
  handleWindowAction
} = {}) {
  if (!overlay) return { open() {}, close() {}, dispose() {} };
  const diagnostics = createTeleprompterDiagnostics();
  overlay.innerHTML = teleprompterTemplate();
  overlay.classList.add('teleprompter-overlay');

  const query = selector => overlay.querySelector(selector);
  const listeners = new AbortController();
  const listenerOptions = { signal: listeners.signal };
  const bg = query('[data-tele-bg]');
  const input = query('[data-tele-input]');
  const fileInput = query('[data-tele-file]');
  const fileName = query('[data-tele-file-name]');
  const engineSelect = query('[data-tele-engine]');
  const engineStatus = query('[data-tele-engine-status]');
  const engineHelp = query('[data-tele-engine-help]');
  const voiceButton = query('[data-tele-action="voice"]');
  const screen = query('[data-tele-screen]');
  const scroller = query('[data-tele-scroll]');
  const content = query('[data-tele-content]');
  const empty = query('[data-tele-empty]');
  const countLabel = query('[data-tele-count]');
  const durationLabel = query('[data-tele-duration]');
  const currentCopy = query('[data-tele-current-copy]');
  const elapsedLabel = query('[data-tele-elapsed]');
  const remainingLabel = query('[data-tele-remaining]');
  const progressBar = query('[data-tele-progress]');
  const playStatus = query('[data-tele-play-status]');
  const playButton = query('[data-tele-action="play"]');
  const speedSliderSlot = query('[data-tele-speed-slider]');
  const fontSliderSlot = query('[data-tele-font-slider]');
  const customSelects = enhanceToolSelects([engineSelect]);
  const preferences = readPreferences(isTauri);

  const speedSlider = speedSliderSlot ? createWaveformSlider({
    min: 0.4,
    max: 3,
    step: 0.1,
    value: preferences.speed,
    ariaLabel: copy('speedSlider'),
    onInput: value => applySpeed(value),
    onChange: () => persistPreferences()
  }) : null;
  if (speedSlider) {
    speedSlider.setBadgeFormatter(value => `${value.toFixed(1)}×`);
    speedSliderSlot.append(speedSlider.element);
  }
  const fontSlider = fontSliderSlot ? createWaveformSlider({
    min: TELEPROMPTER_LIMITS.minFontSize,
    max: TELEPROMPTER_LIMITS.maxFontSize,
    step: 4,
    value: preferences.fontSize,
    ariaLabel: copy('fontSlider'),
    onInput: value => applyFontSize(value)
  }) : null;
  if (fontSlider) {
    fontSlider.setBadgeFormatter(value => `${value}px`);
    fontSliderSlot.append(fontSlider.element);
  }

  let disposed = false;
  let plasmaInstance = null;
  let script = segmentTeleprompterScript('');
  let follower = createSpeechFollower([], 0);
  let currentIndex = 0;
  let playing = false;
  let focusMode = false;
  let animationFrame = 0;
  let lastFrameTime = 0;
  let scrollSpeed = 0;
  let scrollSpeedDirty = true;
  let playbackOffset = 0;
  let sentenceNodes = [];
  let sentenceCenters = [];
  let sentenceStateInitialized = false;
  let sentenceMetricsDirty = true;
  let renderTimer = 0;
  let layoutTimer = 0;
  let scrollSyncTimer = 0;
  let fileRunId = 0;
  let nativeDragUnlisten = null;
  let languageUnsubscribe = () => {};
  let resizeObserver = null;
  let suppressScrollSync = false;
  let recognitionRuntime = 'idle';
  let readingProgress = 0;
  let recognitionController = null;

  function copy(key, params) {
    return t(`home.teleprompter.${key}`, params);
  }

  function persistPreferences() {
    savePreferences(preferences);
  }

  function engineDescription() {
    if (preferences.engine === 'offline') return copy('engineOfflineHelp');
    if (preferences.engine === 'system') return copy('engineSystemHelp');
    return copy('engineAutoHelp');
  }

  function usesAutomaticScroll() {
    return !preferences.voiceFollow || recognitionRuntime === 'fallback';
  }

  function setRecognitionRuntime(state) {
    const wasAutomatic = usesAutomaticScroll();
    recognitionRuntime = state;
    const isAutomatic = usesAutomaticScroll();
    if (!playing || wasAutomatic === isAutomatic) return;
    if (!isAutomatic) commitTransformScroll();
    else {
      lastFrameTime = 0;
      invalidateScrollSpeed();
    }
  }

  function setEngineStatus(state, key = 'engineIdle') {
    if (!engineStatus) return;
    engineStatus.dataset.state = state;
    engineStatus.textContent = copy(key);
  }

  function renderLocale() {
    overlay.querySelectorAll('[data-tele-text]').forEach(element => {
      element.textContent = copy(element.dataset.teleText);
    });
    overlay.querySelectorAll('[data-tele-placeholder]').forEach(element => {
      element.placeholder = copy(element.dataset.telePlaceholder);
    });
    overlay.querySelectorAll('[data-tele-title]').forEach(element => {
      const label = copy(element.dataset.teleTitle);
      element.title = label;
      element.setAttribute('aria-label', label);
    });
    overlay.querySelectorAll('[data-tele-option]').forEach(option => {
      option.textContent = copy(option.dataset.teleOption);
    });
    if (engineHelp) engineHelp.textContent = engineDescription();
    speedSlider?.setAriaLabel(copy('speedSlider'));
    fontSlider?.setAriaLabel(copy('fontSlider'));
    customSelects.forEach(control => control.refresh());
    renderPlaybackState();
    updateProgress();
  }

  function sentenceElements() {
    return sentenceNodes;
  }

  // Sentence geometry is stable while scrolling. Measure it only after a
  // render or a layout change, then use a binary search during playback.
  function cacheSentenceMetrics() {
    if (!sentenceNodes.length || !scroller.clientHeight) {
      sentenceCenters = [];
      sentenceMetricsDirty = false;
      return;
    }
    const scrollRect = scroller.getBoundingClientRect();
    const scrollTop = effectiveScrollTop();
    sentenceCenters = sentenceNodes.map(element => {
      const rect = element.getBoundingClientRect();
      return scrollTop + rect.top - scrollRect.top + rect.height / 2;
    });
    sentenceMetricsDirty = false;
  }

  function invalidateSentenceMetrics() {
    sentenceMetricsDirty = true;
  }

  // Playback scrolling runs on the compositor: a float offset is rendered as
  // a transform instead of native scrollTop, which Chromium quantizes to the
  // device pixel grid and stutters at sub-pixel speeds.
  function isTransformScrollActive() {
    return playing && usesAutomaticScroll() && !disposed;
  }

  function effectiveScrollTop() {
    return scroller.scrollTop + playbackOffset;
  }

  function maxScrollTop() {
    return Math.max(0, scroller.scrollHeight - scroller.clientHeight);
  }

  function applyContentTransform() {
    // Translate comes first in the list so mirror scales flip the content
    // without flipping the scroll direction.
    const parts = [];
    if (playbackOffset) parts.push(`translate3d(0, ${(-playbackOffset).toFixed(2)}px, 0)`);
    if (preferences.mirrorX) parts.push('scaleX(-1)');
    if (preferences.mirrorY) parts.push('scaleY(-1)');
    content.style.transform = parts.join(' ') || 'none';
  }

  function setVirtualScrollTop(value) {
    playbackOffset = clamp(value, 0, maxScrollTop()) - scroller.scrollTop;
    applyContentTransform();
  }

  // Land the float offset back into native scrollTop so wheel, clicks, and
  // the scrollbar keep working whenever playback stops driving the transform.
  function commitTransformScroll() {
    if (playbackOffset) {
      scroller.scrollTop = clamp(effectiveScrollTop(), 0, maxScrollTop());
      playbackOffset = 0;
    }
    applyContentTransform();
  }

  function applySentenceState(nextIndex, previousIndex = null) {
    if (!sentenceNodes.length) return;
    if (!sentenceStateInitialized || previousIndex === null) {
      sentenceNodes.forEach((element, index) => {
        const isCurrent = index === nextIndex;
        element.classList.toggle('is-current', isCurrent);
        element.classList.toggle('is-past', index < nextIndex);
        element.setAttribute('aria-current', isCurrent ? 'true' : 'false');
      });
      sentenceStateInitialized = true;
      return;
    }
    if (previousIndex === nextIndex) return;
    const start = Math.max(0, Math.min(previousIndex, nextIndex));
    const end = Math.min(sentenceNodes.length - 1, Math.max(previousIndex, nextIndex));
    for (let index = start; index <= end; index += 1) {
      const element = sentenceNodes[index];
      const isCurrent = index === nextIndex;
      element.classList.toggle('is-current', isCurrent);
      element.classList.toggle('is-past', index < nextIndex);
      element.setAttribute('aria-current', isCurrent ? 'true' : 'false');
    }
  }

  function renderScript() {
    script = segmentTeleprompterScript(input.value);
    follower = createSpeechFollower(script.sentences, Math.min(currentIndex, Math.max(0, script.sentences.length - 1)));
    currentIndex = follower.index;
    content.replaceChildren();

    script.paragraphs.forEach(paragraph => {
      const paragraphNode = document.createElement('p');
      paragraphNode.className = 'teleprompter-paragraph';
      paragraphNode.dataset.paragraphIndex = String(paragraph.id);
      paragraph.sentenceIds.forEach((sentenceId, offset) => {
        const sentence = script.sentences[sentenceId];
        const node = document.createElement('span');
        node.className = 'teleprompter-sentence';
        node.dataset.sentenceIndex = String(sentence.id);
        node.textContent = sentence.text;
        node.tabIndex = 0;
        paragraphNode.append(node);
        const next = script.sentences[paragraph.sentenceIds[offset + 1]];
        if (next && /[\p{L}\p{N}]$/u.test(sentence.text) && /^[\p{L}\p{N}]/u.test(next.text)) {
          paragraphNode.append(document.createTextNode(' '));
        }
      });
      content.append(paragraphNode);
    });

    sentenceNodes = Array.from(content.querySelectorAll('[data-sentence-index]'));
    const readingLine = document.createElement('span');
    readingLine.className = 'teleprompter-reading-line';
    readingLine.hidden = true;
    content.append(readingLine);
    sentenceStateInitialized = false;
    invalidateSentenceMetrics();
    invalidateScrollSpeed();
    updateReadingLine();

    empty.hidden = script.sentences.length > 0;
    countLabel.textContent = String(Array.from(script.text).length);
    durationLabel.textContent = formatTeleprompterTime(estimateTeleprompterDuration(script.text, preferences.speed));
    if (script.truncated) notify(copy('tooLong', { max: TELEPROMPTER_LIMITS.maxInputChars }));
    setCurrentIndex(currentIndex, { scroll: false, source: 'render' });
    renderControls();
  }

  function scheduleScriptRender() {
    window.clearTimeout(renderTimer);
    renderTimer = window.setTimeout(() => {
      renderTimer = 0;
      renderScript();
    }, input.value.length > 20_000 ? 180 : 70);
  }

  function currentElement(index = currentIndex) {
    return content.querySelector(`[data-sentence-index="${index}"]`);
  }

  function scrollSentenceToFocus(index, behavior = 'smooth') {
    const element = currentElement(index);
    if (!element || !scroller.clientHeight) return;
    const scrollRect = scroller.getBoundingClientRect();
    const elementRect = element.getBoundingClientRect();
    const target = Math.max(0, effectiveScrollTop() + elementRect.top - scrollRect.top - scroller.clientHeight / 2 + elementRect.height / 2);
    if (isTransformScrollActive()) {
      setVirtualScrollTop(target);
      return;
    }
    suppressScrollSync = true;
    scroller.scrollTo({ top: target, behavior });
    // The restore timer lives apart from layoutTimer so competing layout work
    // can never leave scroll sync suppressed forever.
    window.clearTimeout(scrollSyncTimer);
    scrollSyncTimer = window.setTimeout(() => { suppressScrollSync = false; }, behavior === 'smooth' ? 460 : 60);
  }

  function setCurrentIndex(index, { scroll = false, behavior = 'smooth', source = 'manual' } = {}) {
    const max = Math.max(0, script.sentences.length - 1);
    const previousIndex = currentIndex;
    currentIndex = clamp(Math.trunc(Number(index) || 0), 0, max);
    if (source !== 'speech') follower.reset(currentIndex);
    applySentenceState(currentIndex, sentenceStateInitialized ? previousIndex : null);
    if (previousIndex !== currentIndex) readingProgress = 0;
    updateReadingLine();
    const current = script.sentences[currentIndex];
    currentCopy.textContent = current?.text || copy('notStarted');
    currentCopy.title = current?.text || '';
    if (scroll) scrollSentenceToFocus(currentIndex, behavior);
    if (source === 'speech') setEngineStatus('listening', 'engineMatched');
    updateProgress();
    renderControls();
  }

  function syncCurrentFromScroll() {
    if (suppressScrollSync || !script.sentences.length) return;
    if (sentenceMetricsDirty) cacheSentenceMetrics();
    if (!sentenceCenters.length) return;
    const focusY = effectiveScrollTop() + scroller.clientHeight / 2;
    let low = 0;
    let high = sentenceCenters.length - 1;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (sentenceCenters[middle] < focusY) low = middle + 1;
      else high = middle;
    }
    let closest = low;
    if (low > 0 && Math.abs(sentenceCenters[low - 1] - focusY) <= Math.abs(sentenceCenters[low] - focusY)) {
      closest = low - 1;
    }
    if (closest !== currentIndex) setCurrentIndex(closest, { scroll: false, source: 'scroll' });
  }

  // Progress mirrors the real scroll position instead of the sentence index,
  // so the bar advances every frame and no longer freezes between sentences.
  function scrollRatio() {
    if (!script.sentences.length) return 0;
    const distance = scroller.scrollHeight - scroller.clientHeight;
    if (distance <= 2) return currentIndex >= script.sentences.length - 1 ? 1 : 0;
    return clamp(effectiveScrollTop() / distance, 0, 1);
  }

  function updateProgress() {
    const ratio = scrollRatio();
    progressBar.style.width = `${(ratio * 100).toFixed(2)}%`;
    const totalSeconds = estimateTeleprompterDuration(script.text, preferences.speed);
    elapsedLabel.textContent = formatTeleprompterTime(totalSeconds * ratio);
    remainingLabel.textContent = formatTeleprompterTime(totalSeconds * (1 - ratio));
    durationLabel.textContent = formatTeleprompterTime(totalSeconds);
  }

  // The scroll pace is derived from the same duration estimate shown in the
  // UI, so the document finishes scrolling exactly when the clock runs out,
  // regardless of font size or script length.
  function resolveScrollSpeed() {
    if (!scrollSpeedDirty) return scrollSpeed;
    const distance = scroller.scrollHeight - scroller.clientHeight;
    const totalSeconds = Math.max(6, estimateTeleprompterDuration(script.text, preferences.speed));
    scrollSpeed = distance > 0 ? clamp(distance / totalSeconds, 4, 600) : 0;
    scrollSpeedDirty = false;
    return scrollSpeed;
  }

  function invalidateScrollSpeed() {
    scrollSpeedDirty = true;
  }

  function updateScreenStyle() {
    screen.style.setProperty('--teleprompter-font-size', `${preferences.fontSize}px`);
    screen.classList.toggle('is-mirror-x', preferences.mirrorX);
    screen.classList.toggle('is-mirror-y', preferences.mirrorY);
    applyContentTransform();
    query('[data-tele-action="mirror-x"]')?.classList.toggle('is-active', preferences.mirrorX);
    query('[data-tele-action="mirror-y"]')?.classList.toggle('is-active', preferences.mirrorY);
    speedSlider?.setValue(preferences.speed);
    fontSlider?.setValue(preferences.fontSize);
    overlay.classList.toggle('is-following', preferences.voiceFollow);
    voiceButton.setAttribute('aria-pressed', String(preferences.voiceFollow));
    voiceButton.classList.toggle('is-active', preferences.voiceFollow);
    engineSelect.value = preferences.engine;
    customSelects.forEach(control => control.refresh());
    if (engineHelp) engineHelp.textContent = engineDescription();
  }

  function renderControls() {
    const hasScript = script.sentences.length > 0;
    playButton.disabled = !hasScript;
    query('[data-tele-action="previous"]').disabled = !hasScript || currentIndex <= 0;
    query('[data-tele-action="next"]').disabled = !hasScript || currentIndex >= script.sentences.length - 1;
    query('[data-tele-action="reset"]').disabled = !hasScript;
    const playIcon = playing ? 'pause' : 'play';
    if (playButton.dataset.icon !== playIcon) {
      playButton.dataset.icon = playIcon;
      playButton.innerHTML = `<i data-lucide="${playIcon}"></i>`;
      createIcons({ icons, attrs: { 'aria-hidden': 'true' } });
    }
    const playTitle = copy(playing ? 'pause' : 'play');
    playButton.title = playTitle;
    playButton.setAttribute('aria-label', playTitle);
    playButton.setAttribute('aria-pressed', String(playing));
  }

  function renderPlaybackState() {
    overlay.classList.toggle('is-running', playing);
    overlay.classList.toggle('is-paused', !playing);
    overlay.classList.toggle('is-focus', focusMode);
    playStatus.textContent = copy(playing ? 'playing' : (script.sentences.length ? 'ready' : 'waiting'));
    renderControls();
  }

  function animationStep(timestamp) {
    if (!playing || disposed || !overlay.classList.contains('visible')) return;
    if (!lastFrameTime) lastFrameTime = timestamp;
    // Short frames catch up so a stuttering machine keeps the real pace,
    // while the cap still prevents one huge jump after a long stall.
    const delta = Math.min(100, Math.max(0, timestamp - lastFrameTime));
    lastFrameTime = timestamp;
    if (usesAutomaticScroll()) {
      // Compositor-driven motion: a float position rendered as a transform
      // stays sub-pixel smooth at any speed, unlike native scrollTop.
      setVirtualScrollTop(effectiveScrollTop() + resolveScrollSpeed() * delta / 1000);
      syncCurrentFromScroll();
      updateProgress();
      if (effectiveScrollTop() + scroller.clientHeight >= scroller.scrollHeight - 2) {
        pausePlayback();
        return;
      }
    }
    animationFrame = requestAnimationFrame(animationStep);
  }

  function stopAnimation() {
    if (animationFrame) cancelAnimationFrame(animationFrame);
    animationFrame = 0;
    lastFrameTime = 0;
  }

  function nearbyPrompt() {
    // Only past context: future sentences can be decoded as unspoken text.
    return script.sentences.slice(Math.max(0, currentIndex - 2), currentIndex).map(sentence => sentence.text).join(' ').slice(-120);
  }

  function applyRecognitionText(transcript, final = false, options = {}) {
    const previousIndex = currentIndex;
    const result = follower.push(transcript, { ...options, final });
    if (result?.moved) setCurrentIndex(result.index, { scroll: true, source: 'speech' });
    else if (result && !result.pending) setEngineStatus('listening', 'engineListening');
    if (result && !result.pending) updateReadingProgress(result.progress);
    diagnostics.event('follow', () => ({
      session: options.recognitionSession ?? null, requestId: options.requestId ?? null,
      text: String(transcript || '').slice(0, 2000),
      decision: !result ? 'no-match-or-duplicate' : result.pending ? 'pending' : result.moved ? 'moved' : 'matched',
      fromSentence: previousIndex + 1, currentSentence: currentIndex + 1,
      targetText: script.sentences[currentIndex]?.text.slice(0, 180) || '',
      score: result?.score ?? null, progress: readingProgress,
      cursorVisible: content.querySelector('.teleprompter-reading-line')?.hidden === false
    }));
  }

  recognitionController = createTeleprompterRecognitionController({
    isTauri,
    diagnostics,
    getLanguage: getLang,
    getEngine: () => preferences.engine,
    getVoiceFollow: () => preferences.voiceFollow,
    isPlaying: () => playing,
    isDisposed: () => disposed,
    requestOfflineModel,
    copy,
    notify,
    setRuntime: setRecognitionRuntime,
    setStatus: setEngineStatus,
    applyTranscript: applyRecognitionText,
    getPrompt: nearbyPrompt
  });

  // While following, a small white cursor bar sits under the exact character
  // the reader is on, so it is obvious where the tracking believes they are.
  function updateReadingProgress(progress) {
    if (!preferences.voiceFollow || !script.sentences.length) return;
    const sentence = script.sentences[currentIndex];
    if (!sentence) return;
    const computed = clamp(Number(progress) || 0, 0, 1);
    if (computed >= readingProgress) readingProgress = computed;
    updateReadingLine();
  }

  function updateReadingLine() {
    const line = content.querySelector('.teleprompter-reading-line');
    if (!line) return;
    const sentence = script.sentences[currentIndex];
    const element = currentElement(currentIndex);
    const textNode = element?.firstChild;
    if (!preferences.voiceFollow || !sentence || !element || !textNode || textNode.nodeType !== Node.TEXT_NODE) {
      line.hidden = true;
      return;
    }
    const total = sentence.text.length;
    const index = clamp(Math.round(readingProgress * Math.max(0, total - 1)), 0, Math.max(0, total - 1));
    const contentRect = content.getBoundingClientRect();
    let rect = null;
    for (let attempt = index; attempt >= Math.max(0, index - 2) && !rect; attempt -= 1) {
      const range = document.createRange();
      range.setStart(textNode, attempt);
      range.setEnd(textNode, Math.min(total, attempt + 1));
      const candidate = range.getBoundingClientRect();
      if (candidate.width || candidate.height) rect = candidate;
    }
    if (!rect) {
      line.hidden = true;
      return;
    }
    line.style.left = `${(rect.left + rect.width / 2 - contentRect.left).toFixed(1)}px`;
    line.style.top = `${(rect.bottom - contentRect.top + 5).toFixed(1)}px`;
    line.hidden = false;
  }

  function startPlayback() {
    diagnostics.event('playback', {
      engine: preferences.engine, voiceFollow: preferences.voiceFollow,
      alreadyPlaying: playing, sentences: script.sentences.length, currentSentence: currentIndex + 1
    });
    if (playing || !script.sentences.length) return;
    playing = true;
    renderPlaybackState();
    suspendBackgroundMotion();
    // Playback continues from exactly where the view is; no re-centering.
    lastFrameTime = 0;
    animationFrame = requestAnimationFrame(animationStep);
    if (preferences.voiceFollow) {
      setRecognitionRuntime('starting');
      void recognitionController?.start();
    }
  }

  function pausePlayback() {
    if (!playing) return;
    playing = false;
    stopAnimation();
    commitTransformScroll();
    void recognitionController?.stop();
    renderPlaybackState();
    resumeBackgroundMotion();
  }

  function togglePlayback() {
    if (playing) pausePlayback();
    else startPlayback();
  }

  function resetPlayback() {
    pausePlayback();
    setCurrentIndex(0, { scroll: true, behavior: 'smooth', source: 'reset' });
  }

  function applySpeed(value) {
    preferences.speed = clamp(Math.round(Number(value) * 10) / 10, .4, 3);
    invalidateScrollSpeed();
    updateProgress();
  }

  function applyFontSize(value) {
    preferences.fontSize = clamp(Math.round(Number(value) / 4) * 4, TELEPROMPTER_LIMITS.minFontSize, TELEPROMPTER_LIMITS.maxFontSize);
    updateScreenStyle();
    invalidateSentenceMetrics();
    invalidateScrollSpeed();
    scrollSentenceToFocus(currentIndex, 'auto');
    updateReadingLine();
  }

  function changeSpeed(delta) {
    preferences.speed = clamp(Math.round((preferences.speed + delta) * 10) / 10, .4, 3);
    persistPreferences();
    speedSlider?.setValue(preferences.speed);
    invalidateScrollSpeed();
    updateProgress();
  }

  function changeFont(delta) {
    preferences.fontSize = clamp(preferences.fontSize + delta, TELEPROMPTER_LIMITS.minFontSize, TELEPROMPTER_LIMITS.maxFontSize);
    persistPreferences();
    fontSlider?.setValue(preferences.fontSize);
    updateScreenStyle();
    invalidateSentenceMetrics();
    invalidateScrollSpeed();
    scrollSentenceToFocus(currentIndex, 'auto');
    updateReadingLine();
  }

  function toggleFocus(force) {
    focusMode = typeof force === 'boolean' ? force : !focusMode;
    renderPlaybackState();
    window.clearTimeout(layoutTimer);
    layoutTimer = window.setTimeout(() => scrollSentenceToFocus(currentIndex, 'auto'), 80);
  }

  async function ensureOfflineModelThen(callback) {
    if (typeof requestOfflineModel !== 'function') return false;
    return await requestOfflineModel(callback);
  }

  async function chooseEngine(value) {
    preferences.engine = ['auto', 'system', 'offline'].includes(value) ? value : (isTauri ? 'offline' : 'auto');
    persistPreferences();
    updateScreenStyle();
    const shouldRestart = playing && preferences.voiceFollow;
    if (shouldRestart) {
      await recognitionController?.stop({ updateStatus: false });
      if (!playing || !preferences.voiceFollow) return;
      setRecognitionRuntime('starting');
    }
    if (preferences.engine === 'offline' || (preferences.engine === 'auto' && isTauri)) {
      setEngineStatus('idle', 'engineChecking');
      const ready = await ensureOfflineModelThen(() => {
        setEngineStatus('idle', 'engineReady');
        if (playing && preferences.voiceFollow) void recognitionController?.start();
      });
      if (ready) {
        setEngineStatus('idle', 'engineReady');
        if (playing && preferences.voiceFollow) void recognitionController?.start();
      } else if (shouldRestart) {
        setRecognitionRuntime('fallback');
        setEngineStatus('idle', 'engineNeedsModel');
      }
    } else {
      setEngineStatus('idle', 'engineReady');
      if (playing && preferences.voiceFollow) void recognitionController?.start();
    }
  }

  async function toggleVoiceFollow() {
    preferences.voiceFollow = !preferences.voiceFollow;
    persistPreferences();
    updateScreenStyle();
    // Leaving transform mode mid-play must land the offset before the native
    // smooth scrolls used by voice following take over.
    if (playing && !isTransformScrollActive()) commitTransformScroll();
    if (!preferences.voiceFollow) await recognitionController?.stop();
    else if (playing) await recognitionController?.start();
    else setEngineStatus('idle', 'engineReady');
  }

  async function readSelectedDocument(file) {
    if (!file || typeof readTextDocument !== 'function') return;
    const runId = ++fileRunId;
    overlay.classList.add('is-loading-document');
    try {
      const result = await readTextDocument(file);
      if (runId !== fileRunId || !overlay.classList.contains('visible')) return;
      pausePlayback();
      input.value = result.text || '';
      fileName.textContent = result.name || copy('document');
      fileName.title = `${result.kind || copy('document')} · ${formatFileSize(result.bytes)}`;
      currentIndex = 0;
      renderScript();
      scrollSentenceToFocus(0, 'auto');
      notify(copy('fileLoaded', { name: result.name || copy('document') }));
    } catch (error) {
      console.error('[Teleprompter] document read failed:', error);
      notify(copy('readFailed'));
    } finally {
      if (runId === fileRunId) overlay.classList.remove('is-loading-document');
      if (fileInput) fileInput.value = '';
    }
  }

  async function chooseDocument() {
    if (isTauri) {
      try {
        const { open } = await import('@tauri-apps/plugin-dialog');
        const selected = await open({
          multiple: false,
          filters: [{ name: copy('document'), extensions: ['txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'html', 'htm', 'docx', 'pdf'] }]
        });
        if (typeof selected === 'string') {
          await readSelectedDocument({ path: selected, name: selected.split(/[\\/]/).pop() || selected });
        }
      } catch (error) {
        console.error('[Teleprompter] file picker failed:', error);
      }
    } else {
      fileInput?.click();
    }
  }

  function clearScript() {
    if (!input.value) return;
    pausePlayback();
    input.value = '';
    fileName.textContent = copy('manualInput');
    fileName.title = '';
    currentIndex = 0;
    renderScript();
    input.focus({ preventScroll: true });
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
          if (path) void readSelectedDocument({ path, name: path.split(/[\\/]/).pop() || path });
        }
      });
    } catch (error) {
      console.error('[Teleprompter] native drag listener failed:', error);
    }
  }

  function stopNativeDragListener() {
    try { nativeDragUnlisten?.(); } catch {}
    nativeDragUnlisten = null;
    overlay.classList.remove('drag-over');
  }

  // The WebGL background competes with prompt scrolling for frames on weaker
  // machines, so it only runs while playback is paused.
  function suspendBackgroundMotion() {
    if (!plasmaInstance) return;
    plasmaInstance = disposeStandardToolPlasma?.(plasmaInstance) || null;
  }

  function resumeBackgroundMotion() {
    if (plasmaInstance || disposed || !overlay.classList.contains('visible')) return;
    plasmaInstance = initStandardToolPlasma?.(bg) || null;
  }

  function open() {
    if (disposed) return;
    diagnostics.event('ready', { engine: preferences.engine, voiceFollow: preferences.voiceFollow, consoleOnly: true });
    suppressScrollSync = false;
    window.clearTimeout(scrollSyncTimer);
    scrollSyncTimer = 0;
    invalidateScrollSpeed();
    overlay.classList.add('visible');
    overlay.setAttribute('aria-hidden', 'false');
    plasmaInstance ||= initStandardToolPlasma?.(bg) || null;
    updateScreenStyle();
    renderScript();
    renderLocale();
    createIcons({ icons, attrs: { 'aria-hidden': 'true' } });
    resizeObserver?.observe(screen);
    void startNativeDragListener();
    requestAnimationFrame(() => input.focus({ preventScroll: true }));
  }

  function close() {
    if (!overlay.classList.contains('visible')) return;
    // Drop the visibility flag first so the resume path inside pausePlayback
    // does not rebuild the background motion on the way out.
    overlay.classList.remove('visible');
    customSelects.forEach(control => control.close());
    pausePlayback();
    void recognitionController?.stop();
    focusMode = false;
    overlay.classList.remove('is-focus', 'is-running', 'drag-over');
    overlay.classList.add('is-paused');
    overlay.setAttribute('aria-hidden', 'true');
    fileRunId += 1;
    window.clearTimeout(renderTimer);
    renderTimer = 0;
    window.clearTimeout(layoutTimer);
    layoutTimer = 0;
    window.clearTimeout(scrollSyncTimer);
    scrollSyncTimer = 0;
    suppressScrollSync = false;
    resizeObserver?.disconnect();
    stopNativeDragListener();
    plasmaInstance = disposeStandardToolPlasma?.(plasmaInstance) || null;
    sentenceNodes = [];
    sentenceCenters = [];
    sentenceStateInitialized = false;
    sentenceMetricsDirty = true;
  }

  function handleAction(action) {
    if (action === 'back') close();
    else if (action === 'website') openExternalUrl?.('https://toolknit.com');
    else if (action === 'support') openSupport?.();
    else if (action === 'settings') openSettings?.();
    else if (action === 'upload') void chooseDocument();
    else if (action === 'clear') clearScript();
    else if (action === 'play') togglePlayback();
    else if (action === 'reset') resetPlayback();
    else if (action === 'previous') setCurrentIndex(currentIndex - 1, { scroll: true });
    else if (action === 'next') setCurrentIndex(currentIndex + 1, { scroll: true });
    else if (action === 'mirror-x') { preferences.mirrorX = !preferences.mirrorX; persistPreferences(); updateScreenStyle(); }
    else if (action === 'mirror-y') { preferences.mirrorY = !preferences.mirrorY; persistPreferences(); updateScreenStyle(); }
    else if (action === 'focus') toggleFocus();
    else if (action === 'exit-focus') toggleFocus(false);
    else if (action === 'voice') void toggleVoiceFollow();
  }

  overlay.addEventListener('click', event => {
    const sentenceNode = event.target.closest('[data-sentence-index]');
    if (sentenceNode) {
      setCurrentIndex(Number(sentenceNode.dataset.sentenceIndex), { scroll: true, source: 'sentence-click' });
      return;
    }
    const actionNode = event.target.closest('[data-tele-action]');
    if (actionNode) handleAction(actionNode.dataset.teleAction);
    const windowNode = event.target.closest('[data-window-action]');
    if (windowNode) void handleWindowAction?.(windowNode.dataset.windowAction);
  }, listenerOptions);

  input.addEventListener('input', () => {
    if (input.value.length > TELEPROMPTER_LIMITS.maxInputChars) {
      input.value = input.value.slice(0, TELEPROMPTER_LIMITS.maxInputChars);
      notify(copy('tooLong', { max: TELEPROMPTER_LIMITS.maxInputChars }));
    }
    fileName.textContent = copy('manualInput');
    fileName.title = '';
    scheduleScriptRender();
  }, listenerOptions);

  fileInput.addEventListener('change', event => {
    const file = event.target.files?.[0];
    if (file) void readSelectedDocument(file);
  }, listenerOptions);

  engineSelect.addEventListener('change', () => void chooseEngine(engineSelect.value), listenerOptions);
  scroller.addEventListener('scroll', () => {
    updateProgress();
    updateReadingLine();
    if (!playing) syncCurrentFromScroll();
  }, { ...listenerOptions, passive: true });
  scroller.addEventListener('wheel', () => {
    if (playing) pausePlayback();
    requestAnimationFrame(syncCurrentFromScroll);
  }, { ...listenerOptions, passive: true });

  overlay.addEventListener('dragover', event => {
    if (isTauri) return;
    event.preventDefault();
    overlay.classList.add('drag-over');
  }, listenerOptions);
  overlay.addEventListener('dragleave', event => {
    if (!overlay.contains(event.relatedTarget)) overlay.classList.remove('drag-over');
  }, listenerOptions);
  overlay.addEventListener('drop', event => {
    if (isTauri) return;
    event.preventDefault();
    overlay.classList.remove('drag-over');
    const file = event.dataTransfer?.files?.[0];
    if (file) void readSelectedDocument(file);
  }, listenerOptions);

  document.addEventListener('keydown', event => {
    if (!overlay.classList.contains('visible')) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      // The shell has a global Escape handler for lazy tools. Keep the first
      // Escape inside the teleprompter so it exits focus mode before the tool
      // itself is eligible to close.
      event.stopImmediatePropagation();
      if (focusMode) toggleFocus(false);
      else close();
      return;
    }
    if (isEditableTarget(event.target)) return;
    if (event.code === 'Space') { event.preventDefault(); togglePlayback(); }
    else if (event.key === 'ArrowLeft') { event.preventDefault(); setCurrentIndex(currentIndex - 1, { scroll: true }); }
    else if (event.key === 'ArrowRight') { event.preventDefault(); setCurrentIndex(currentIndex + 1, { scroll: true }); }
    else if (event.key === '+' || event.key === '=') { event.preventDefault(); changeSpeed(.1); }
    else if (event.key === '-' || event.key === '_') { event.preventDefault(); changeSpeed(-.1); }
    else if (event.key.toLowerCase() === 'r') { event.preventDefault(); resetPlayback(); }
    else if (event.key.toLowerCase() === 'f') { event.preventDefault(); toggleFocus(); }
  }, { ...listenerOptions, capture: true });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden && overlay.classList.contains('visible') && playing) pausePlayback();
  }, listenerOptions);

  resizeObserver = new ResizeObserver(() => {
    if (!overlay.classList.contains('visible') || !script.sentences.length) return;
    // Measure-only: play/pause panel collapses and window resizes must never
    // move the view on their own. Explicit actions (font change, focus mode,
    // sentence clicks) re-center themselves.
    invalidateSentenceMetrics();
    invalidateScrollSpeed();
    updateReadingLine();
  });
  languageUnsubscribe = onLangChange(renderLocale) || (() => {});
  window.addEventListener('beforeunload', () => dispose(), { ...listenerOptions, once: true });

  engineSelect.value = preferences.engine;
  persistPreferences();
  updateScreenStyle();
  renderScript();
  renderLocale();
  renderPlaybackState();
  overlay.classList.add('is-paused');
  overlay.setAttribute('aria-hidden', 'true');
  createIcons({ icons, attrs: { 'aria-hidden': 'true' } });

  function dispose() {
    if (disposed) return;
    close();
    disposed = true;
    listeners.abort();
    resizeObserver?.disconnect();
    resizeObserver = null;
    customSelects.forEach(control => control.dispose());
    speedSlider?.dispose();
    fontSlider?.dispose();
    try { languageUnsubscribe(); } catch {}
    languageUnsubscribe = () => {};
    stopNativeDragListener();
    stopAnimation();
    void recognitionController?.dispose();
    overlay.replaceChildren();
  }

  return { open, close, dispose };
}
