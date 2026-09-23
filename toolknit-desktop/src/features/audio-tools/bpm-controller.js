import { createLifecycleScope } from '../../app/tool-lifecycle.js';
import { onLangChange } from '../../i18n.js';
import { loadTauriDialog, loadTauriWebview, tauriCorePromise } from '../../platform/tauri-runtime.js';
import {
  BpmDetectError,
  analyzeAudioKeyPcm,
  analyzeBpmPcm,
  analyzeMusicTempoPcm,
  assertBpmAudioBuffer,
  assertBpmInputSize,
  fuseBpmAnalyses,
  getBpmAnalysisSpec,
  isBpmSupportedAudioName
} from '../../bpm-detect-core.js';
export function createBpmDetectController({
  overlay,
  isTauri = false,
  t = value => value,
  onLangChange: registerLanguageChange = onLangChange,
  refreshIcons = () => {},
  initStandardToolPlasma = () => null,
  disposeStandardToolPlasma = instance => instance?.(),
  openSettings = () => {},
  openSupport = () => {},
  openExternalUrl = () => {},
  handleWindowAction = () => {},
  getLang = () => 'zh',
  documentRef = globalThis.document,
  windowRef = globalThis.window,
  notify = message => windowRef?.alert?.(message)
} = {}) {
  if (!overlay || !documentRef) throw new Error('bpm-detect:missing-root');
  const document = documentRef;
  const window = windowRef || globalThis.window;
  const lifecycle = createLifecycleScope({ onError: error => console.error('[BPM Detect] cleanup:', error) });
  let bpmNativeUnlisten = null;
  let disposed = false;

      // ===== BPM Detect Tool =====
      const bpmDetectOverlay = document.getElementById('bpmDetectOverlay');
      const bpmDetectBack = document.getElementById('bpmDetectBack');
      const bpmDetectCta = document.getElementById('bpmDetectCta');
      const bpmDetectHeroTop = document.getElementById('bpmDetectHeroTop');
      const bpmResult = document.getElementById('bpmResult');
      const bpmResultNumber = document.getElementById('bpmResultNumber');
      const bpmTimelineTrack = document.getElementById('bpmTimelineTrack');
      const bpmResultHint = document.getElementById('bpmResultHint');
      const bpmConfidenceValue = document.getElementById('bpmConfidenceValue');
      const bpmKeyValue = document.getElementById('bpmKeyValue');
      const bpmCandidateList = document.getElementById('bpmCandidateList');
      const bpmReanalyzeBtn = document.getElementById('bpmReanalyzeBtn');
      const bpmProcessMask = document.getElementById('bpmProcessMask');
      const bpmProcessBarFill = document.getElementById('bpmProcessBarFill');
      const bpmDropZone = document.getElementById('bpmDropZone');
      const bpmPlasmaBg = document.getElementById('bpmPlasmaBg');
      const bpmAnalysisEmpty = document.getElementById('bpmAnalysisEmpty');
      const bpmDemoStatusText = document.getElementById('bpmDemoStatusText');
      let bpmPlasmaInstance = null;
      let bpmAudioContext = null;
      let bpmAnalyzing = false;
      let bpmAnalysisRunId = 0;
      let bpmProgressInterval = null;
      let bpmResultTimer = null;
      let bpmReanalyzeTimer = null;

      function clearBpmProgress() {
        if (bpmProgressInterval) {
          clearInterval(bpmProgressInterval);
          bpmProgressInterval = null;
        }
      }

      function isCurrentBpmRun(runId) {
        return runId === bpmAnalysisRunId && bpmDetectOverlay.classList.contains('visible');
      }

      function finishBpmRun(runId) {
        if (runId === bpmAnalysisRunId) bpmAnalyzing = false;
      }

      function invalidateBpmRun() {
        bpmAnalysisRunId += 1;
        bpmAnalyzing = false;
        clearBpmProgress();
        if (bpmResultTimer) {
          clearTimeout(bpmResultTimer);
          bpmResultTimer = null;
        }
        if (bpmReanalyzeTimer) {
          clearTimeout(bpmReanalyzeTimer);
          bpmReanalyzeTimer = null;
        }
      }

      function startBpmRun() {
        if (bpmAnalyzing) return null;
        disposeBpmDemoPlayback({ clearBuffer: true, closeContext: true });
        if (bpmDemoOverlay) bpmDemoOverlay.classList.remove('visible');
        if (bpmDemoBpmNumber) bpmDemoBpmNumber.textContent = '--';
        if (bpmDemoPlayBtn) {
          bpmDemoPlayBtn.disabled = true;
          bpmDemoPlayBtn.style.display = 'inline-flex';
        }
        if (bpmDemoStopBtn) bpmDemoStopBtn.style.display = 'none';
        if (bpmDemoStatusText) {
          bpmDemoStatusText.textContent = t('home.bpmDetect.demoWorkspaceHint');
        }
        bpmAnalyzing = true;
        return ++bpmAnalysisRunId;
      }

      function getBpmErrorMessage(error) {
        if (!(error instanceof BpmDetectError)) {
          return t('home.bpmDetect.analyzeError') + ': ' + (error?.message || error);
        }
        const messageKey = {
          invalid_input: 'invalidInput',
          input_too_large: 'inputTooLarge',
          invalid_audio: 'invalidAudio',
          audio_too_long: 'audioTooLong',
          unsupported_channels: 'unsupportedChannels',
          decoded_audio_too_large: 'decodedAudioTooLarge',
          audio_context_unavailable: 'audioContextUnavailable'
        }[error.code];
        return messageKey ? t(`home.bpmDetect.${messageKey}`) : error.message;
      }

      function showBpmError(error, runId = null) {
        if (runId !== null && !isCurrentBpmRun(runId)) return;
        console.error('BPM analysis error:', error);
        notify(getBpmErrorMessage(error));
        resetBpmResult();
      }

      function openBpmDetectOverlay() {
        if (bpmDetectOverlay.classList.contains('visible')) return;
        bpmDetectOverlay.classList.add('visible');
        // Reset to initial state
        bpmDetectHeroTop.style.display = '';
        bpmResult.classList.remove('visible');
        if (bpmAnalysisEmpty) bpmAnalysisEmpty.style.display = '';
        // Init plasma bg
        if (bpmPlasmaBg && !bpmPlasmaInstance) {
          bpmPlasmaInstance = initStandardToolPlasma(bpmPlasmaBg);
        }
      }

      function closeBpmDetectOverlay() {
        invalidateBpmRun();
        bpmDetectOverlay.classList.remove('visible');
        bpmResult.classList.remove('visible');
        closeBpmDemo();
        // Destroy plasma instance to free GPU/CPU
        if (bpmPlasmaInstance) bpmPlasmaInstance = disposeStandardToolPlasma(bpmPlasmaInstance);
        bpmProcessMask.classList.remove('visible');
        bpmProcessBarFill.style.width = '0%';
        if (bpmAudioContext) {
          const context = bpmAudioContext;
          bpmAudioContext = null;
          context.close().catch(() => {});
        }
        // Reset hero display
        bpmDetectHeroTop.style.display = '';
      }

      if (bpmDetectBack) {
        lifecycle.event(bpmDetectBack, 'click', closeBpmDetectOverlay);
      }

      // Runs entirely in the renderer. A run ID prevents stale decode/analyzer work from changing a later UI state.
      function getBpmAudioContext() {
        if (bpmAudioContext) return bpmAudioContext;
        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        if (!AudioContextClass) {
          throw new BpmDetectError('audio_context_unavailable', 'This browser does not support local audio analysis.');
        }
        bpmAudioContext = new AudioContextClass();
        return bpmAudioContext;
      }

      // The upstream analyzer makes an additional OfflineAudioContext copy. Keep that copy bounded and mono.
      function createBpmAnalysisBuffer(audioBuffer) {
        const { sampleRate, frameCount } = getBpmAnalysisSpec(audioBuffer);
        const analysisBuffer = getBpmAudioContext().createBuffer(1, frameCount, sampleRate);
        const output = analysisBuffer.getChannelData(0);
        const sourceChannels = Array.from(
          { length: audioBuffer.numberOfChannels },
          (_, index) => audioBuffer.getChannelData(index)
        );
        const sourceStep = audioBuffer.sampleRate / sampleRate;
        for (let frame = 0; frame < frameCount; frame++) {
          const sourceFrame = Math.min(Math.floor(frame * sourceStep), audioBuffer.length - 1);
          let sample = 0;
          for (const channel of sourceChannels) sample += channel[sourceFrame];
          output[frame] = sample / sourceChannels.length;
        }
        return analysisBuffer;
      }

      async function analyzeBpmAudioBuffer(arrayBuffer, runId) {
        if (!isCurrentBpmRun(runId)) return;
        let resultDeliveryScheduled = false;

        bpmDetectHeroTop.style.display = '';
        bpmProcessMask.classList.add('visible');
        bpmProcessBarFill.style.width = '0%';

        let progress = 0;
        clearBpmProgress();
        bpmProgressInterval = setInterval(() => {
          if (!isCurrentBpmRun(runId)) {
            clearBpmProgress();
            return;
          }
          if (progress < 90) {
            progress += Math.random() * 8 + 2;
            bpmProcessBarFill.style.width = Math.min(progress, 90) + '%';
          }

        }, 200);

        try {
          assertBpmInputSize(arrayBuffer?.byteLength);
          const audioContext = getBpmAudioContext();
          const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
          if (!isCurrentBpmRun(runId)) return;
          assertBpmAudioBuffer(audioBuffer);

          const analysisBuffer = createBpmAnalysisBuffer(audioBuffer);
          const analysisPcm = analysisBuffer.getChannelData(0);
          const localBpmAnalysis = analyzeBpmPcm(analysisPcm, analysisBuffer.sampleRate);
          const keyAnalysis = analyzeAudioKeyPcm(analysisPcm, analysisBuffer.sampleRate);
          const musicTempoModule = await import('music-tempo');
          const MusicTempoCtor = musicTempoModule.default || musicTempoModule;
          const beatrootAnalysis = analyzeMusicTempoPcm(analysisPcm, analysisBuffer.sampleRate, MusicTempoCtor);
          const { analyzeFullBuffer } = await import('realtime-bpm-analyzer');
          const tempos = await analyzeFullBuffer(analysisBuffer);
          if (!isCurrentBpmRun(runId)) return;
          const fusedBpmAnalysis = fuseBpmAnalyses({ realtimeTempos: tempos, pcmAnalysis: localBpmAnalysis, beatrootAnalysis });

          clearBpmProgress();
          bpmProcessBarFill.style.width = '100%';
          resultDeliveryScheduled = true;
          bpmResultTimer = setTimeout(() => {
            bpmResultTimer = null;
            if (!isCurrentBpmRun(runId)) return;
            try {
              bpmProcessMask.classList.remove('visible');
              showBpmResult({ bpmAnalysis: fusedBpmAnalysis, keyAnalysis }, audioBuffer);
            } catch (error) {
              showBpmError(error, runId);
            } finally {
              finishBpmRun(runId);
            }
          }, 300);
        } catch (err) {
          clearBpmProgress();
          if (!isCurrentBpmRun(runId)) return;
          bpmProcessMask.classList.remove('visible');
          showBpmError(err, runId);
        } finally {
          if (!resultDeliveryScheduled) finishBpmRun(runId);
        }
      }

      async function analyzeBpmFromFile(filePath) {
        const runId = startBpmRun();
        if (!runId) return;
        let analysisStarted = false;
        try {
          const { invoke } = await tauriCorePromise;
          const byteLength = Number(await invoke('get_file_size', { path: filePath }));
          assertBpmInputSize(byteLength);
          if (!isCurrentBpmRun(runId)) return;
          const bytes = await invoke('read_file_bytes_limited', {
            path: filePath,
            maxBytes: 50 * 1024 * 1024
          });
          if (!isCurrentBpmRun(runId)) return;
          const arrayBuffer = new Uint8Array(bytes).buffer;
          analysisStarted = true;
          await analyzeBpmAudioBuffer(arrayBuffer, runId);
        } catch (err) {
          showBpmError(err, runId);
        } finally {
          if (!analysisStarted) finishBpmRun(runId);
        }
      }

      async function analyzeBpmBrowserFile(file) {
        try {
          assertBpmInputSize(file?.size);
        } catch (error) {
          showBpmError(error);
          return;
        }

        const runId = startBpmRun();
        if (!runId) return;
        let analysisStarted = false;
        try {
          const arrayBuffer = await file.arrayBuffer();
          if (!isCurrentBpmRun(runId)) return;
          analysisStarted = true;
          await analyzeBpmAudioBuffer(arrayBuffer, runId);
        } catch (error) {
          showBpmError(error, runId);
        } finally {
          if (!analysisStarted) finishBpmRun(runId);
        }
      }

      function setBpmDemoTempo(bpm) {
        const value = Math.round(Number(bpm));
        if (!Number.isFinite(value) || value <= 0) return;
        bpmResultNumber.textContent = value;
        bpmDemoState.bpm = value;
        bpmDemoBpmNumber.textContent = value;
        if (bpmDemoStatusText) {
          bpmDemoStatusText.textContent = t('home.bpmDetect.demoWorkspaceReady', { bpm: value });
        }
      }

      function renderBpmCandidateButtons(bpmAnalysis, activeBpm) {
        if (!bpmCandidateList) return;
        bpmCandidateList.innerHTML = '';
        const unique = [];
        for (const candidate of Array.isArray(bpmAnalysis?.candidates) ? bpmAnalysis.candidates : []) {
          const bpm = Math.round(Number(candidate.bpm));
          if (!Number.isFinite(bpm) || unique.some(item => Math.abs(item.bpm - bpm) <= 1)) continue;
          unique.push({ bpm, confidence: Number(candidate.confidence) || 0, sources: candidate.sources || [] });
          if (unique.length >= 5) break;
        }
        if (!unique.some(item => item.bpm === activeBpm)) unique.unshift({ bpm: activeBpm, confidence: bpmAnalysis?.confidence || 0, sources: ['selected'] });
        for (const candidate of unique.slice(0, 5)) {
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'bpm-candidate-chip';
          if (candidate.bpm === activeBpm) button.classList.add('active');
          button.dataset.bpm = String(candidate.bpm);
          button.innerHTML = `<span>${candidate.bpm}</span><em>BPM</em>`;
          button.title = getLang() === 'zh' ? `切换到 ${candidate.bpm} BPM 试听` : `Switch demo to ${candidate.bpm} BPM`;
          button.addEventListener('click', () => {
            setBpmDemoTempo(candidate.bpm);
            bpmCandidateList.querySelectorAll('.bpm-candidate-chip').forEach(item => item.classList.toggle('active', item === button));
            if (bpmResultHint) {
              bpmResultHint.textContent = t('home.bpmDetect.candidateSelectedHint', { bpm: candidate.bpm });
              bpmResultHint.classList.add('visible');
            }
          });
          bpmCandidateList.appendChild(button);
        }
      }

      function showBpmResult(analysis, audioBuffer) {
        disposeBpmDemoPlayback({ clearBuffer: true, closeContext: true });
        const bpmAnalysis = analysis?.bpmAnalysis;
        const keyAnalysis = analysis?.keyAnalysis;
        if (!bpmAnalysis || bpmAnalysis.bpm === null) {
          bpmResult.classList.add('visible');
          bpmResultNumber.textContent = '?';
          bpmTimelineTrack.innerHTML = '';
          bpmResultHint.textContent = t('home.bpmDetect.noBeatDetected');
          bpmResultHint.classList.add('visible');
          if (bpmConfidenceValue) bpmConfidenceValue.textContent = '--';
          if (bpmKeyValue) bpmKeyValue.textContent = '--';
          if (bpmCandidateList) bpmCandidateList.innerHTML = '';
          if (bpmAnalysisEmpty) bpmAnalysisEmpty.style.display = 'none';
          bpmDemoBpmNumber.textContent = '--';
          bpmDemoPlayBtn.disabled = true;
          if (bpmDemoStatusText) {
            bpmDemoStatusText.textContent = t('home.bpmDetect.demoUnavailable');
          }
          return;
        }

        const bpm = Math.round(bpmAnalysis.bpm);
        const confidence = Number.isFinite(bpmAnalysis.confidence)
          ? Math.round(Math.max(0, Math.min(1, bpmAnalysis.confidence)) * 100)
          : null;
        const keyLabel = keyAnalysis?.key
          ? `${keyAnalysis.key}${Number.isFinite(keyAnalysis.confidence) ? ` · ${Math.round(keyAnalysis.confidence * 100)}%` : ''}`
          : t('home.bpmDetect.keyUnknown');

        // Show result card
        bpmResult.classList.add('visible');
        bpmResultNumber.textContent = bpm;
        if (bpmConfidenceValue) bpmConfidenceValue.textContent = confidence === null ? '--' : `${confidence}%`;
        if (bpmKeyValue) bpmKeyValue.textContent = keyLabel;
        renderBpmCandidateButtons(bpmAnalysis, bpm);
        if (bpmAnalysisEmpty) {
          bpmAnalysisEmpty.style.display = 'none';
        }

        // Generate timeline bars from actual audio data
        bpmTimelineTrack.innerHTML = '';
        const barCount = 64;
        const channelData = audioBuffer.getChannelData(0);
        const samplesPerBar = Math.floor(channelData.length / barCount);
        const expectedBeatCount = Math.max(1, Math.round(audioBuffer.duration * bpm / 60));
        const barsPerBeat = Math.max(1, Math.round(barCount / expectedBeatCount));

        for (let i = 0; i < barCount; i++) {
          const start = i * samplesPerBar;
          const end = Math.min(start + samplesPerBar, channelData.length);
          let peak = 0;
          const sampleStep = Math.max(1, Math.ceil((end - start) / 2048));
          for (let j = start; j < end; j += sampleStep) {
            const abs = Math.abs(channelData[j]);
            if (abs > peak) peak = abs;
          }
          const bar = document.createElement('div');
          bar.className = 'bpm-timeline-bar';
          const height = Math.max(3, peak * 24);
          bar.style.height = height + 'px';
          if (i % barsPerBeat === 0) {
            bar.classList.add('beat');
          }

          bpmTimelineTrack.appendChild(bar);
        }

        // Half/double time hints
        bpmResultHint.classList.remove('visible');
        if (bpm < 70) {
          bpmResultHint.textContent = t('home.bpmDetect.doubleTimeHint', { bpm: bpm * 2 });
          bpmResultHint.classList.add('visible');
        } else if (bpm > 160) {
          bpmResultHint.textContent = t('home.bpmDetect.halfTimeHint', { bpm: Math.round(bpm / 2) });
          bpmResultHint.classList.add('visible');
        } else if (Array.isArray(bpmAnalysis.candidates) && bpmAnalysis.candidates.length > 1) {
          const alternate = bpmAnalysis.candidates.find(candidate => Math.abs(candidate.bpm - bpm) >= 2);
          if (alternate) {
            bpmResultHint.textContent = t('home.bpmDetect.alternateHint', { bpm: alternate.bpm });
            bpmResultHint.classList.add('visible');
          }
        }

        if (bpmDemoOverlay) {
          bpmDemoOverlay.classList.add('visible');
        }
        bpmDemoState.bpm = bpm;
        bpmDemoState.audioBuffer = audioBuffer;
        bpmDemoPlayBtn.style.display = 'inline-flex';
        bpmDemoStopBtn.style.display = 'none';
        if (bpmDemoStatusText) {
          bpmDemoStatusText.textContent = t('home.bpmDetect.demoWorkspaceReady', { bpm });
        }
        bpmDemoBpmNumber.textContent = bpm;
        bpmDemoPlayBtn.disabled = false;
      }

      function resetBpmResult() {
        closeBpmDemo();
        bpmResult.classList.remove('visible');
        bpmDetectHeroTop.style.display = '';
        bpmTimelineTrack.innerHTML = '';
        bpmResultHint.classList.remove('visible');
        if (bpmCandidateList) bpmCandidateList.innerHTML = '';
        if (bpmConfidenceValue) bpmConfidenceValue.textContent = '--';
        if (bpmKeyValue) bpmKeyValue.textContent = '--';
        if (bpmAnalysisEmpty) {
          bpmAnalysisEmpty.style.display = '';
        }
      }

      async function selectBpmAudioFile() {
        if (bpmAnalyzing) return;
        if (isTauri) {
          try {
            const { open } = await loadTauriDialog();
            const selected = await open({
              multiple: false,
              filters: [{
                name: 'Audio Files',
                extensions: ['mp3', 'wav', 'flac', 'aac', 'ogg', 'm4a']
              }]
            });
            if (selected && typeof selected === 'string') {
              analyzeBpmFromFile(selected);
            }
          } catch (e) {
            console.error('BPM file selection error', e);
          }
        } else {
          const input = document.createElement('input');
          input.type = 'file';
          input.accept = 'audio/*';
          input.addEventListener('change', async () => {
            const file = input.files[0];
            if (!file) return;
            if (isTauri && file.path) await analyzeBpmFromFile(file.path);
            else await analyzeBpmBrowserFile(file);
          });
          input.click();
        }
      }

      if (bpmDetectCta) {
        lifecycle.event(bpmDetectCta, 'click', () => {
          selectBpmAudioFile();
        });
      }

      if (bpmReanalyzeBtn) {
        lifecycle.event(bpmReanalyzeBtn, 'click', () => {
          if (bpmAnalyzing) return;
          resetBpmResult();
          bpmReanalyzeTimer = setTimeout(() => {
            bpmReanalyzeTimer = null;
            if (bpmDetectOverlay.classList.contains('visible')) selectBpmAudioFile();
          }, 300);
        });
      }

      // Native drag/drop belongs to this feature instance and is released on dispose.
      if (isTauri && bpmDetectOverlay) {
        void loadTauriWebview().then(async ({ getCurrentWebview }) => {
          const unlisten = await getCurrentWebview().onDragDropEvent((event) => {
            if (!bpmDetectOverlay.classList.contains('visible') || bpmAnalyzing) return;
            const payload = event?.payload || {};
            if (payload.type === 'enter' || payload.type === 'over') {
              bpmDetectOverlay.classList.add('drag-over');
              bpmDropZone.classList.add('visible');
            } else if (payload.type === 'leave') {
              bpmDetectOverlay.classList.remove('drag-over');
              bpmDropZone.classList.remove('visible');
            } else if (payload.type === 'drop') {
              bpmDetectOverlay.classList.remove('drag-over');
              bpmDropZone.classList.remove('visible');
              const audioPath = (payload.paths || []).find(isBpmSupportedAudioName);
              if (audioPath) void analyzeBpmFromFile(audioPath);
            }
          });
          if (disposed) unlisten?.();
          else bpmNativeUnlisten = lifecycle.use(unlisten);
        }).catch(error => console.warn('[BPM Detect] native drop unavailable:', error));
      }

      // HTML5 drag-drop fallback (non-Tauri)
      if (bpmDetectOverlay && !isTauri) {
        lifecycle.event(bpmDetectOverlay, 'dragover', (e) => {
          e.preventDefault();
          bpmDetectOverlay.classList.add('drag-over');
          bpmDropZone.classList.add('visible');
        });
        lifecycle.event(bpmDetectOverlay, 'dragleave', (e) => {
          if (e.relatedTarget && bpmDetectOverlay.contains(e.relatedTarget)) return;
          bpmDetectOverlay.classList.remove('drag-over');
          bpmDropZone.classList.remove('visible');
        });
        lifecycle.event(bpmDetectOverlay, 'drop', (e) => {
          e.preventDefault();
          bpmDetectOverlay.classList.remove('drag-over');
          bpmDropZone.classList.remove('visible');
          const file = e.dataTransfer.files[0];
          if (file && (file.type.startsWith('audio/') || isBpmSupportedAudioName(file.name))) {
            (async () => {
              if (isTauri && file.path) await analyzeBpmFromFile(file.path);
              else await analyzeBpmBrowserFile(file);
            })();
          }
        });
      }

      // ===== BPM Beat Demo =====
      const bpmDemoOverlay = document.getElementById('bpmDemoOverlay');
      const bpmDemoClose = document.getElementById('bpmDemoClose');
      const bpmDemoBpmNumber = document.getElementById('bpmDemoBpmNumber');
      const bpmDemoBeatIndicator = document.getElementById('bpmDemoBeatIndicator');
      const bpmDemoPlayBtn = document.getElementById('bpmDemoPlayBtn');
      const bpmDemoStopBtn = document.getElementById('bpmDemoStopBtn');
      const bpmDemoAudioVolume = document.getElementById('bpmDemoAudioVolume');
      const bpmDemoBeatVolume = document.getElementById('bpmDemoBeatVolume');

      let bpmDemoState = {
        bpm: 128,
        audioBuffer: null,
        isPlaying: false,
        audioContext: null,
        audioSource: null,
        audioGainNode: null,
        beatGainNode: null,
        beatTimeoutId: null,
        beatVisualTimeoutId: null,
      };

      function setBpmDemoIdleButtons() {
        if (bpmDemoPlayBtn) bpmDemoPlayBtn.style.display = 'inline-flex';
        if (bpmDemoStopBtn) bpmDemoStopBtn.style.display = 'none';
      }

      function disposeBpmDemoPlayback({ clearBuffer = false, closeContext = false } = {}) {
        bpmDemoState.isPlaying = false;

        if (bpmDemoState.beatTimeoutId) {
          clearTimeout(bpmDemoState.beatTimeoutId);
          bpmDemoState.beatTimeoutId = null;
        }
        if (bpmDemoState.beatVisualTimeoutId) {
          clearTimeout(bpmDemoState.beatVisualTimeoutId);
          bpmDemoState.beatVisualTimeoutId = null;
        }

        if (bpmDemoState.audioSource) {
          try { bpmDemoState.audioSource.stop(); } catch(e) {}
          try { bpmDemoState.audioSource.disconnect(); } catch(e) {}
          bpmDemoState.audioSource = null;
        }

        if (bpmDemoState.audioGainNode) {
          try { bpmDemoState.audioGainNode.disconnect(); } catch(e) {}
          bpmDemoState.audioGainNode = null;
        }
        if (bpmDemoState.beatGainNode) {
          try { bpmDemoState.beatGainNode.disconnect(); } catch(e) {}
          bpmDemoState.beatGainNode = null;
        }

        if (bpmDemoBeatIndicator) {
          bpmDemoBeatIndicator.classList.remove('beat-active');
        }
        setBpmDemoIdleButtons();
        if (clearBuffer) bpmDemoState.audioBuffer = null;

        if (closeContext && bpmDemoState.audioContext) {
          const context = bpmDemoState.audioContext;
          bpmDemoState.audioContext = null;
          if (typeof context.close === 'function' && context.state !== 'closed') {
            context.close().catch(() => {});
          }
        }
      }

      function closeBpmDemo() {
        disposeBpmDemoPlayback({ clearBuffer: true, closeContext: true });
        bpmDemoOverlay.classList.remove('visible');
        bpmDemoBpmNumber.textContent = '--';
        bpmDemoPlayBtn.disabled = true;
        setBpmDemoIdleButtons();
        if (bpmDemoStatusText) {
          bpmDemoStatusText.textContent = t('home.bpmDetect.demoWorkspaceHint');
        }
        if (bpmAnalysisEmpty && !bpmResult.classList.contains('visible')) {
          bpmAnalysisEmpty.style.display = '';
        }
      }

      if (bpmDemoClose) {
        lifecycle.event(bpmDemoClose, 'click', closeBpmDemo);
      }

      function startBpmDemo() {
        if (bpmDemoState.isPlaying) return;
        if (!bpmDemoState.audioBuffer) return;
        disposeBpmDemoPlayback({ clearBuffer: false, closeContext: false });
        bpmDemoState.isPlaying = true;
        bpmDemoPlayBtn.style.display = 'none';
        bpmDemoStopBtn.style.display = 'inline-flex';

        // Create or resume AudioContext
        if (!bpmDemoState.audioContext) {
          bpmDemoState.audioContext = new (window.AudioContext || window.webkitAudioContext)();
        }
        if (bpmDemoState.audioContext.state === 'suspended') {
          bpmDemoState.audioContext.resume().catch(() => {});
        }
        const ctx = bpmDemoState.audioContext;
        const now = ctx.currentTime;

        // Audio gain node (low volume)
        bpmDemoState.audioGainNode = ctx.createGain();
        const audioVol = parseInt(bpmDemoAudioVolume.value) / 100;
        bpmDemoState.audioGainNode.gain.setValueAtTime(audioVol, now);
        bpmDemoState.audioGainNode.connect(ctx.destination);

        // Beat gain node (high volume)
        bpmDemoState.beatGainNode = ctx.createGain();
        const beatVol = parseInt(bpmDemoBeatVolume.value) / 100;
        bpmDemoState.beatGainNode.gain.setValueAtTime(beatVol, now);
        bpmDemoState.beatGainNode.connect(ctx.destination);

        // Play audio
        if (bpmDemoState.audioBuffer) {
          bpmDemoState.audioSource = ctx.createBufferSource();
          bpmDemoState.audioSource.buffer = bpmDemoState.audioBuffer;
          bpmDemoState.audioSource.loop = true;
          bpmDemoState.audioSource.connect(bpmDemoState.audioGainNode);
          bpmDemoState.audioSource.start(0);
        }

        // Start metronome
        const beatIntervalMs = 60000 / bpmDemoState.bpm;
        let beatCount = 0;

        function scheduleBeat() {
          if (!bpmDemoState.isPlaying) return;

          // Play click sound using oscillator
          const beatTime = bpmDemoState.audioContext.currentTime;
          const osc = bpmDemoState.audioContext.createOscillator();
          const env = bpmDemoState.audioContext.createGain();
          osc.frequency.setValueAtTime(beatCount % 4 === 0 ? 1200 : 800, beatTime);
          env.gain.setValueAtTime(0, beatTime);
          env.gain.linearRampToValueAtTime(1, beatTime + 0.001);
          env.gain.exponentialRampToValueAtTime(0.001, beatTime + 0.05);
          osc.connect(env);
          env.connect(bpmDemoState.beatGainNode);
          osc.start(beatTime);
          osc.stop(beatTime + 0.05);
          osc.onended = () => {
            try { osc.disconnect(); } catch {}
            try { env.disconnect(); } catch {}
          };

          // Visual indicator
          bpmDemoBeatIndicator.classList.add('beat-active');
          bpmDemoState.beatVisualTimeoutId = setTimeout(() => {
            bpmDemoBeatIndicator.classList.remove('beat-active');
            bpmDemoState.beatVisualTimeoutId = null;
          }, 80);

          beatCount++;
          bpmDemoState.beatTimeoutId = setTimeout(scheduleBeat, beatIntervalMs);
        }

        scheduleBeat();
      }

      function stopBpmDemo() {
        disposeBpmDemoPlayback({ clearBuffer: false, closeContext: false });
      }

      if (bpmDemoPlayBtn) {
        lifecycle.event(bpmDemoPlayBtn, 'click', startBpmDemo);
      }

      if (bpmDemoStopBtn) {
        lifecycle.event(bpmDemoStopBtn, 'click', stopBpmDemo);
      }

      if (bpmDemoAudioVolume) {
        lifecycle.event(bpmDemoAudioVolume, 'input', () => {
          if (bpmDemoState.audioGainNode && bpmDemoState.audioContext) {
            const vol = parseInt(bpmDemoAudioVolume.value) / 100;
            bpmDemoState.audioGainNode.gain.setValueAtTime(vol, bpmDemoState.audioContext.currentTime);
          }
        });
      }

      if (bpmDemoBeatVolume) {
        lifecycle.event(bpmDemoBeatVolume, 'input', () => {
          if (bpmDemoState.beatGainNode && bpmDemoState.audioContext) {
            const vol = parseInt(bpmDemoBeatVolume.value) / 100;
            bpmDemoState.beatGainNode.gain.setValueAtTime(vol, bpmDemoState.audioContext.currentTime);
          }
        });
      }


  const bindChrome = (id, event, handler) => {
    const node = document.getElementById(id);
    if (node) lifecycle.event(node, event, eventObject => { eventObject.stopPropagation(); handler(eventObject); });
  };
  bindChrome('bpmDetectV2Settings', 'click', openSettings);
  overlay.querySelectorAll('[data-home-link="website"]').forEach(node => lifecycle.event(node, 'click', () => openExternalUrl('https://toolknit.com')));
  overlay.querySelectorAll('[data-open-support]').forEach(node => lifecycle.event(node, 'click', openSupport));
  overlay.querySelectorAll('[data-action]').forEach(node => lifecycle.event(node, 'click', () => handleWindowAction(node.dataset.action)));
  lifecycle.use(registerLanguageChange(() => refreshIcons()));

  function open() {
    if (disposed) return;
    openBpmDetectOverlay();
  }

  function close() {
    closeBpmDetectOverlay();
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    closeBpmDetectOverlay();
    bpmNativeUnlisten?.();
    bpmNativeUnlisten = null;
    lifecycle.dispose();
  }

  return { open, close, dispose };
}
