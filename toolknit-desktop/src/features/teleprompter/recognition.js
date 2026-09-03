import { tauriCorePromise } from '../../platform/tauri-runtime.js';
import { createSystemSpeechTranscriptState } from '../../teleprompter-core.js';

export const TELEPROMPTER_RECOGNITION_TIMING = Object.freeze({
  offlineSampleRate: 16_000,
  offlineWindowSeconds: 3.2,
  offlineOverlapSeconds: 0.6,
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
  logError = (...args) => console.error(...args)
} = {}) {
  let systemRecognition = null;
  let systemRestartTimer = 0;
  let systemStartTimer = 0;
  let systemResultTimer = 0;
  let generation = 0;
  let microphoneStream = null;
  let audioContext = null;
  let audioSource = null;
  let audioProcessor = null;
  let audioSink = null;
  let offlineSessionId = '';
  let offlineSamples = [];
  let offlineInference = false;

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
      if (!state.transcript) return;
      receivedResult = true;
      windowRef?.clearTimeout(systemResultTimer);
      systemResultTimer = 0;
      setRuntime('active');
      applyTranscript(state.latest || state.transcript, state.final, {
        context: state.transcript,
        cumulative: true
      });
    };
    recognition.onerror = event => {
      if (activeGeneration !== generation) return;
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

  async function stopOfflineRecognition() {
    const sessionId = offlineSessionId;
    offlineSessionId = '';
    offlineSamples = [];
    offlineInference = false;
    if (audioProcessor) audioProcessor.onaudioprocess = null;
    try { audioProcessor?.disconnect(); } catch {}
    try { audioSource?.disconnect(); } catch {}
    try { audioSink?.disconnect(); } catch {}
    audioProcessor = null;
    audioSource = null;
    audioSink = null;
    microphoneStream?.getTracks?.().forEach(track => track.stop());
    microphoneStream = null;
    if (audioContext) {
      try { await audioContext.close(); } catch {}
      audioContext = null;
    }
    if (isTauri && sessionId) {
      try { await invoke('stop_teleprompter_recognition', { sessionId }); } catch {}
    }
  }

  async function processOfflineWindow(activeGeneration) {
    if (offlineInference || !offlineSessionId || activeGeneration !== generation || !isPlaying()) return;
    const sessionId = offlineSessionId;
    const targetLength = Math.round(
      TELEPROMPTER_RECOGNITION_TIMING.offlineSampleRate
      * TELEPROMPTER_RECOGNITION_TIMING.offlineWindowSeconds
    );
    const overlapLength = Math.round(
      TELEPROMPTER_RECOGNITION_TIMING.offlineSampleRate
      * TELEPROMPTER_RECOGNITION_TIMING.offlineOverlapSeconds
    );
    if (offlineSamples.length < targetLength) return;
    if (offlineSamples.length > targetLength * 2) offlineSamples = offlineSamples.slice(-targetLength);
    const chunk = offlineSamples.slice(0, targetLength);
    offlineSamples = offlineSamples.slice(Math.max(0, targetLength - overlapLength));
    offlineInference = true;
    setStatus('listening', 'engineRecognizing');
    try {
      const result = await invoke('transcribe_teleprompter_audio', {
        sessionId,
        samples: chunk,
        prompt: getPrompt()
      });
      if (activeGeneration === generation && isPlaying() && result?.text) {
        applyTranscript(result.text, true);
      }
    } catch (error) {
      const message = String(error?.message || error || '');
      if (activeGeneration === generation && !/stopped|cancelled|session-not-found/i.test(message)) {
        logError('[Teleprompter] offline recognition failed:', error);
        useScrollFallback();
        void stopOfflineRecognition();
      }
    } finally {
      if (activeGeneration !== generation || sessionId !== offlineSessionId) return;
      offlineInference = false;
      if (activeGeneration === generation && isPlaying() && offlineSamples.length >= targetLength) {
        void processOfflineWindow(activeGeneration);
      }
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
    try {
      offlineSessionId = await invoke('start_teleprompter_recognition', {
        language: getLanguage() === 'zh' ? 'zh' : 'en'
      });
      if (activeGeneration !== generation || !isPlaying()) {
        await stopOfflineRecognition();
        return false;
      }
      microphoneStream = await navigatorRef.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false
      });
      if (activeGeneration !== generation || !isPlaying()) {
        await stopOfflineRecognition();
        return false;
      }
      const AudioContextCtor = windowRef?.AudioContext || windowRef?.webkitAudioContext;
      if (!AudioContextCtor) throw new Error('audio-context unavailable');
      audioContext = new AudioContextCtor({ latencyHint: 'interactive' });
      await audioContext.resume();
      if (audioContext.state !== 'running') {
        throw Object.assign(new Error('audio-context suspended'), { name: 'AudioContextSuspended' });
      }
      audioSource = audioContext.createMediaStreamSource(microphoneStream);
      audioProcessor = audioContext.createScriptProcessor(4096, 1, 1);
      audioSink = audioContext.createGain();
      audioSink.gain.value = 0;
      audioProcessor.onaudioprocess = event => {
        if (activeGeneration !== generation || !isPlaying()) return;
        const converted = resampleTeleprompterAudio(
          event.inputBuffer.getChannelData(0),
          audioContext.sampleRate
        );
        for (let index = 0; index < converted.length; index += 1) offlineSamples.push(converted[index]);
        const maxBuffered = TELEPROMPTER_RECOGNITION_TIMING.offlineSampleRate * 11;
        if (offlineSamples.length > maxBuffered) {
          offlineSamples = offlineSamples.slice(-Math.round(
            TELEPROMPTER_RECOGNITION_TIMING.offlineSampleRate
            * TELEPROMPTER_RECOGNITION_TIMING.offlineWindowSeconds
          ));
        }
        void processOfflineWindow(activeGeneration);
      };
      audioSource.connect(audioProcessor);
      audioProcessor.connect(audioSink);
      audioSink.connect(audioContext.destination);
      setRuntime('active');
      setStatus('listening', 'engineListening');
      return true;
    } catch (error) {
      logError('[Teleprompter] recognition start failed:', error);
      await stopOfflineRecognition();
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
    generation += 1;
    stopSystemRecognition();
    await stopOfflineRecognition();
    setRuntime('idle');
    if (updateStatus) {
      if (!getVoiceFollow()) setStatus('idle', 'engineIdle');
      else setStatus('idle', 'enginePaused');
    }
  }

  async function start() {
    await stop({ updateStatus: false });
    if (!isPlaying() || !getVoiceFollow()) return;
    const activeGeneration = ++generation;
    setRuntime('starting');
    const beginOffline = async () => {
      if (activeGeneration !== generation || !isPlaying() || !getVoiceFollow()) return;
      await startOfflineRecognition(activeGeneration);
    };
    const beginOfflineWithGate = async () => {
      const ready = await ensureOfflineModelThen(beginOffline);
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
