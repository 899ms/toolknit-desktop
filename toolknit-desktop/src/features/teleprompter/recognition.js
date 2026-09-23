import { tauriCorePromise } from '../../platform/tauri-runtime.js';
import { createSystemSpeechTranscriptState, simplifyChineseText } from '../../teleprompter-core.js';
import { createLiveAudioWindow, LIVE_AUDIO_TIMING } from './audio-window.js';
import { createTeleprompterDiagnostics } from './diagnostics.js';

export const TELEPROMPTER_RECOGNITION_TIMING = Object.freeze({
  offlineSampleRate: LIVE_AUDIO_TIMING.sampleRate,
  systemStartTimeoutMs: 3_500,
  systemFirstResultTimeoutMs: 12_000
});

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function resampleTeleprompterAudio(input, sourceRate) {
  if (!input?.length) return new Int16Array();
  const ratio = sourceRate / TELEPROMPTER_RECOGNITION_TIMING.offlineSampleRate;
  const length = Math.max(1, Math.floor(input.length / ratio));
  const output = new Int16Array(length);
  for (let index = 0; index < length; index += 1) {
    const sourcePosition = index * ratio;
    const left = Math.floor(sourcePosition);
    const right = Math.min(input.length - 1, left + 1);
    const fraction = sourcePosition - left;
    const sample = input[left] * (1 - fraction) + input[right] * fraction;
    output[index] = Math.round(clamp(sample, -1, 1) * (sample < 0 ? 32768 : 32767));
  }
  return output;
}

export function createTeleprompterRecognitionController({
  isTauri = false,
  windowRef = globalThis.window,
  navigatorRef = globalThis.navigator,
  invoke = (...args) => tauriCorePromise.then(api => api.invoke(...args)),
  getLanguage = () => 'en',
  getEngine = () => 'auto',
  getVoiceFollow = () => false,
  isPlaying = () => false,
  isDisposed = () => false,
  requestOfflineModel,
  copy = key => key,
  notify = () => {},
  setRuntime = () => {},
  setStatus = () => {},
  applyTranscript = () => {},
  getPrompt = () => '',
  logError = (...args) => console.error(...args),
  diagnostics = createTeleprompterDiagnostics({ windowRef })
} = {}) {
  let systemRecognition = null;
  let systemRestartTimer = 0;
  let systemStartTimer = 0;
  let systemResultTimer = 0;
  let generation = 0;
  let offlineOwner = null;

  function recognitionConstructor() {
    return windowRef?.SpeechRecognition || windowRef?.webkitSpeechRecognition || null;
  }

  function useScrollFallback() {
    setRuntime('fallback');
    setStatus('error', 'engineScrollFallback');
  }

  function stopSystemRecognition() {
    windowRef?.clearTimeout(systemRestartTimer);
    windowRef?.clearTimeout(systemStartTimer);
    windowRef?.clearTimeout(systemResultTimer);
    systemRestartTimer = 0;
    systemStartTimer = 0;
    systemResultTimer = 0;
    if (!systemRecognition) return;
    const recognition = systemRecognition;
    systemRecognition = null;
    recognition.onstart = null;
    recognition.onresult = null;
    recognition.onerror = null;
    recognition.onend = null;
    try { recognition.abort(); } catch {}
  }

  function startSystemRecognition(activeGeneration, onUnavailable) {
    const Recognition = recognitionConstructor();
    if (!Recognition) return false;
    stopSystemRecognition();
    const recognition = new Recognition();
    const transcriptState = createSystemSpeechTranscriptState();
    let fallingBack = false;
    let cycleStarted = false;
    let receivedResult = false;
    let requestId = 0;
    systemRecognition = recognition;
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;
    recognition.lang = getLanguage() === 'zh' ? 'zh-CN' : 'en-US';

    const fallback = () => {
      if (fallingBack || activeGeneration !== generation || systemRecognition !== recognition) return;
      fallingBack = true;
      stopSystemRecognition();
      setRuntime('starting');
      setStatus('idle', 'engineSwitchingOffline');
      void onUnavailable?.();
    };

    const armStartWatchdog = () => {
      windowRef?.clearTimeout(systemStartTimer);
      systemStartTimer = windowRef?.setTimeout(
        fallback,
        TELEPROMPTER_RECOGNITION_TIMING.systemStartTimeoutMs
      ) || 0;
    };

    const startCycle = () => {
      if (fallingBack || activeGeneration !== generation || !isPlaying() || systemRecognition !== recognition) return;
      cycleStarted = false;
      setStatus('idle', 'engineStarting');
      armStartWatchdog();
      try {
        recognition.start();
      } catch {
        fallback();
      }
    };

    recognition.onstart = () => {
      if (activeGeneration !== generation || systemRecognition !== recognition) return;
      cycleStarted = true;
      windowRef?.clearTimeout(systemStartTimer);
      systemStartTimer = 0;
      setRuntime('active');
      setStatus('listening', 'engineListening');
      diagnostics.event('system-ready', { session: activeGeneration, language: recognition.lang });
      if (!receivedResult && !systemResultTimer) {
        systemResultTimer = windowRef?.setTimeout(
          fallback,
          TELEPROMPTER_RECOGNITION_TIMING.systemFirstResultTimeoutMs
        ) || 0;
      }
    };
    recognition.onresult = event => {
      if (activeGeneration !== generation || !isPlaying()) return;
      const state = transcriptState.push(event.results, event.resultIndex);
      state.latest = simplifyChineseText(state.latest);
      state.transcript = simplifyChineseText(state.transcript);
      requestId += 1;
      diagnostics.event('transcript', {
        engine: 'system', session: activeGeneration, requestId,
        text: String(state.latest || state.transcript || '').slice(-2000), final: state.final,
        skipped: state.transcript ? null : 'empty-transcript'
      });
      if (!state.transcript) return;
      receivedResult = true;
      windowRef?.clearTimeout(systemResultTimer);
      systemResultTimer = 0;
      setRuntime('active');
      applyTranscript(state.latest || state.transcript, state.final, {
        context: state.transcript,
        cumulative: true, recognitionSession: activeGeneration, requestId
      });
    };
    recognition.onerror = event => {
      if (activeGeneration !== generation) return;
      diagnostics.event('system-error', { session: activeGeneration, error: event.error });
      const denied = ['not-allowed', 'audio-capture'].includes(event.error);
      if (!denied) return fallback();
      stopSystemRecognition();
      setRuntime('fallback');
      setStatus('error', 'enginePermissionDenied');
      notify(copy('microphoneDenied'));
    };
    recognition.onend = () => {
      if (activeGeneration !== generation || !isPlaying() || !getVoiceFollow()
        || systemRecognition !== recognition) return;
      transcriptState.endSession();
      if (!cycleStarted && !receivedResult) return fallback();
      systemRestartTimer = windowRef?.setTimeout(() => {
        systemRestartTimer = 0;
        startCycle();
      }, 320) || 0;
    };
    setRuntime('starting');
    startCycle();
    return true;
  }

  async function stopOfflineRecognition(owner = offlineOwner) {
    if (!owner) return;
    if (offlineOwner === owner) offlineOwner = null;
    owner.closed = true;
    owner.captureDiagnostics?.stop();
    owner.captureDiagnostics = null;
    diagnostics.event('stopped', { session: owner.generation });
    const { sessionId, audioContext } = owner;
    owner.sessionId = '';
    owner.audioContext = null;
    if (owner.audioProcessor) owner.audioProcessor.onaudioprocess = null;
    try { owner.audioProcessor?.disconnect(); } catch {}
    try { owner.audioSource?.disconnect(); } catch {}
    try { owner.audioSink?.disconnect(); } catch {}
    owner.microphoneStream?.getTracks?.().forEach(track => track.stop());
    owner.microphoneStream = null;
    const closeAudio = Promise.resolve().then(() => audioContext?.close()).catch(() => {});
    if (isTauri && sessionId) {
      try { await invoke('stop_teleprompter_recognition', { sessionId }); } catch {}
    }
    await closeAudio;
  }

  function isCurrent(owner) {
    return offlineOwner === owner && !owner.closed && owner.generation === generation
      && isPlaying() && getVoiceFollow() && !isDisposed();
  }

  async function processOfflineWindow(owner) {
    if (!isCurrent(owner) || owner.inference || !owner.sessionId) return;
    const window = owner.audio.take();
    if (!window) return;
    owner.inference = true;
    const requestId = ++owner.requestCount;
    owner.inferenceStarted = diagnostics.now();
    diagnostics.event('recognize', {
      session: owner.generation, requestId, samples: window.samples.length,
      audioMs: Math.round(window.samples.length / LIVE_AUDIO_TIMING.sampleRate * 1000),
      windowStart: window.windowStart, windowEnd: window.windowEnd,
      inputRms: Number(window.inputRms.toFixed(1)), gain: Number(window.gain.toFixed(2))
    });
    setStatus('listening', 'engineRecognizing');
    try {
      const result = await invoke('transcribe_teleprompter_audio', {
        sessionId: owner.sessionId,
        samples: window.samples,
        prompt: getPrompt()
      });
      const current = isCurrent(owner);
      if (result?.text) result.text = simplifyChineseText(result.text);
      const accepted = current && result?.text && (result.confidence == null || result.confidence >= 0.35);
      diagnostics.event('transcript', () => ({
        engine: 'offline', session: owner.generation, requestId,
        elapsedMs: Math.round(diagnostics.now() - owner.inferenceStarted),
        text: String(result?.text || '').slice(0, 2000),
        confidence: result?.confidence ?? null, model: result?.model_id ?? null,
        skipped: accepted ? null : !current ? 'stale-session' : !result?.text ? 'empty-transcript' : 'low-speech-confidence'
      }));
      if (accepted) {
        const { windowStart, windowEnd, utterance } = window;
        applyTranscript(result.text, false, {
          rolling: true, windowStart, windowEnd, utterance, recognitionSession: owner.generation, requestId
        });
      }
    } catch (error) {
      diagnostics.event('recognition-error', { session: owner.generation, requestId, error: error?.name || 'Error' });
      const message = String(error?.message || error || '');
      if (isCurrent(owner) && !/stopped|cancelled|session-not-found/i.test(message)) {
        logError('[Teleprompter] offline recognition failed:', error);
        useScrollFallback();
        void stopOfflineRecognition(owner);
      }
    } finally {
      owner.inference = false;
      if (isCurrent(owner)) void processOfflineWindow(owner);
    }
  }

  async function ensureOfflineModelThen(callback) {
    if (typeof requestOfflineModel !== 'function') return false;
    return await requestOfflineModel(callback);
  }

  async function startOfflineRecognition(activeGeneration) {
    if (!isTauri) {
      notify(copy('desktopOnly'));
      useScrollFallback();
      return false;
    }
    if (!navigatorRef?.mediaDevices?.getUserMedia) {
      notify(copy('microphoneUnavailable'));
      useScrollFallback();
      return false;
    }
    setStatus('idle', 'engineLoading');
    const owner = { generation: activeGeneration, audio: createLiveAudioWindow(), closed: false, requestCount: 0 };
    offlineOwner = owner;
    diagnostics.event('model-loading', { session: activeGeneration });
    try {
      owner.sessionId = await invoke('start_teleprompter_recognition', {
        language: getLanguage() === 'zh' ? 'zh' : 'en'
      });
      if (!isCurrent(owner)) {
        await stopOfflineRecognition(owner);
        return false;
      }
      diagnostics.event('microphone-request', { session: activeGeneration });
      owner.microphoneStream = await navigatorRef.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false
      });
      if (!isCurrent(owner)) {
        await stopOfflineRecognition(owner);
        return false;
      }
      const AudioContextCtor = windowRef?.AudioContext || windowRef?.webkitAudioContext;
      if (!AudioContextCtor) throw new Error('audio-context unavailable');
      const audioContext = owner.audioContext = new AudioContextCtor({ latencyHint: 'interactive' });
      await audioContext.resume();
      if (!isCurrent(owner)) {
        await stopOfflineRecognition(owner);
        return false;
      }
      if (audioContext.state !== 'running') {
        throw Object.assign(new Error('audio-context suspended'), { name: 'AudioContextSuspended' });
      }
      const audioSource = owner.audioSource = audioContext.createMediaStreamSource(owner.microphoneStream);
      const audioProcessor = owner.audioProcessor = audioContext.createScriptProcessor(1024, 1, 1);
      const audioSink = owner.audioSink = audioContext.createGain();
      audioSink.gain.value = 0;
      const readAudioState = () => {
        const track = owner.microphoneStream?.getAudioTracks?.()[0];
        return {
          session: activeGeneration, contextState: audioContext.state, sourceSampleRate: audioContext.sampleRate,
          trackEnabled: track?.enabled ?? null, trackMuted: track?.muted ?? null, trackState: track?.readyState ?? null,
          inference: Boolean(owner.inference),
          inferenceMs: owner.inference ? Math.round(diagnostics.now() - owner.inferenceStarted) : 0
        };
      };
      diagnostics.event('microphone-ready', readAudioState);
      owner.captureDiagnostics = diagnostics.capture(readAudioState);
      audioProcessor.onaudioprocess = event => {
        if (!isCurrent(owner)) return;
        const converted = resampleTeleprompterAudio(
          event.inputBuffer.getChannelData(0),
          audioContext.sampleRate
        );
        owner.audio.append(converted);
        owner.captureDiagnostics?.accept(converted, owner.audio.state());
        void processOfflineWindow(owner);
      };
      audioSource.connect(audioProcessor);
      audioProcessor.connect(audioSink);
      audioSink.connect(audioContext.destination);
      setRuntime('active');
      setStatus('listening', 'engineListening');
      return true;
    } catch (error) {
      const current = isCurrent(owner);
      await stopOfflineRecognition(owner);
      if (!current || activeGeneration !== generation) return false;
      diagnostics.event('start-error', { session: activeGeneration, error: error?.name || 'Error' });
      logError('[Teleprompter] recognition start failed:', error);
      const message = String(error?.message || error || '');
      if (/model-not-installed/i.test(message)) {
        setRuntime('fallback');
        setStatus('idle', 'engineNeedsModel');
        void ensureOfflineModelThen(() => {
          if (isPlaying() && getVoiceFollow() && !isDisposed()) void start();
        });
        return false;
      }
      const denied = /notallowed|permission|denied|audio-capture/i.test(`${error?.name || ''} ${message}`);
      setRuntime('fallback');
      setStatus('error', denied ? 'enginePermissionDenied' : 'engineScrollFallback');
      notify(copy(denied ? 'microphoneDenied' : 'recognitionFailed'));
      return false;
    }
  }

  async function stop({ updateStatus = true } = {}) {
    const stoppedGeneration = ++generation;
    stopSystemRecognition();
    await stopOfflineRecognition();
    if (stoppedGeneration !== generation) return;
    setRuntime('idle');
    if (updateStatus) {
      if (!getVoiceFollow()) setStatus('idle', 'engineIdle');
      else setStatus('idle', 'enginePaused');
    }
  }

  async function start() {
    const stopped = stop({ updateStatus: false });
    const activeGeneration = generation;
    await stopped;
    diagnostics.event('start', {
      session: activeGeneration, engine: getEngine(), voiceFollow: getVoiceFollow(),
      playing: isPlaying(), language: getLanguage(), desktop: isTauri
    });
    if (activeGeneration !== generation || !isPlaying() || !getVoiceFollow() || isDisposed()) return;
    setRuntime('starting');
    const beginOffline = async () => {
      if (activeGeneration !== generation || !isPlaying() || !getVoiceFollow()) return;
      await startOfflineRecognition(activeGeneration);
    };
    const beginOfflineWithGate = async () => {
      const ready = await ensureOfflineModelThen(beginOffline);
      diagnostics.event('model-gate', { session: activeGeneration, ready: Boolean(ready) });
      if (ready) await beginOffline();
      else if (activeGeneration === generation) {
        setRuntime('fallback');
        setStatus('idle', 'engineNeedsModel');
      }
    };
    const systemFallback = async () => {
      if (isTauri) await beginOfflineWithGate();
      else useScrollFallback();
    };
    const engine = getEngine();
    const shouldUseSystem = engine === 'system' || (!isTauri && engine === 'auto');
    if (shouldUseSystem) {
      if (!startSystemRecognition(activeGeneration, systemFallback)) await systemFallback();
      return;
    }
    await beginOfflineWithGate();
  }

  return {
    start,
    stop,
    dispose() {
      return stop({ updateStatus: false });
    }
  };
}
