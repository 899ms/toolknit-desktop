      import { LogicalSize, currentMonitor, getCurrentWindow } from '@tauri-apps/api/window';
      import { createElement as createLucideElement, createIcons, icons } from 'lucide';
      import pdfWorkerUrl from 'pdfjs-dist/legacy/build/pdf.worker.mjs?url';
      import { initLightRays } from './lightrays.js';
      import { initPlasma } from './plasma.js';
      import { getLang, setLang, applyTranslations, onLangChange, t } from './i18n.js';
      import { initUpdatePreview } from './update-preview.js';
      import { compareVersions, createUpdateService, UPDATE_RELEASES_PAGE } from './update-service.js';
      import { readResponseTextLimited } from './core/bounded-response.js';
      import { createLazyToolRegistry } from './app/lazy-tool-registry.js';
      import { LAZY_TOOL_SPECS } from './features/lazy-tools.js';
      import { joinPath, uniqueOutputDirectory, writeUniqueFile } from './features/ppt-workflows/shared.js';
      import { tauriCorePromise, tauriEventPromise } from './platform/tauri-runtime.js';
      import { readTextDocument } from './shared/text-document-reader.js';
      import { formatFileSize } from './shared/file-size.js';
      import { HELP_CONTENT, getHelpContent } from './help-data.js';
      import { SUPPORT_JOURNAL_ENTRIES } from './support-journal-data.js';
      import { getLegalContent } from './legal-data.js';
      import { AiProviderError, normalizeAiProviderConfig, requestAiCompletion } from './ai-provider-core.js';
      import {
        COLOR_EXTRACTOR_LIMITS,
        assertColorExtractorImageBytes,
        assertColorExtractorDimensions,
        assertColorExtractorFile,
        paletteFromRgba
      } from './color-extractor-core.js';
      import {
        AudioConvertError,
        normalizeAudioTargetFormat,
        validateAudioBatchSelection
      } from './audio-convert-core.js';
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
      } from './bpm-detect-core.js';
      import {
        AudioClipError,
        assertAudioClipBuffer,
        assertAudioClipInput,
        assertAudioClipSelection,
        isAudioClipSupportedName
      } from './audio-clip-core.js';
      import {
        VideoConvertError,
        normalizeVideoTargetFormat,
        validateVideoBatchSelection
      } from './video-convert-core.js';
      import { frameTimeLabel, normalizeVideoFrameFormat, normalizeVideoFrameTimestamp, validateVideoFrameInput } from './video-frame-core.js';
      import { createDefaultVideoGifSelection, normalizeVideoGifRequest, validateVideoGifInput, videoGifTimeLabel } from './video-gif-core.js';
      import {
        PPT_TEXT_EXTRACT_LIMITS,
        analyzePptxText,
        buildPptTextAiMessages,
        createPptTextMarkdown,
        createPptTextJson,
        createPptTextTxt,
        normalizePptTextAiMode,
        normalizePptTextFormat,
        normalizePptTextPageSelection,
        planPptTextExport,
        sanitizePptTextBaseName
      } from './ppt-text-extract-core.js';
      import {
        PPT_COMPRESS_LIMITS,
        compressPptxBytes,
        createPptCompressManifest,
        sanitizePptCompressBaseName
      } from './ppt-compress-core.js';
      import { TaskRunner } from '../shared/task-runtime.mjs';
      // Keep custom tool menus, but preserve native editing menus in text fields.
      document.addEventListener('contextmenu', (e) => {
        if (e.target.closest('input, textarea, select, [contenteditable="true"]')) return;
        if (e.target.closest('.audio-list-item')) return;
        if (e.target.closest('.cleanup-large-files-table tr[data-path], .cleanup-large-files-context-menu')) return;
        e.preventDefault();
      });

      const WINDOW_RADIUS_KEY = 'toolknit.window-radius.v1';
      const WINDOW_RESIZE_KEY = 'toolknit.window-resizable.v1';
      // Keep the native constraint low enough for compact and high-DPI laptop
      // work areas. Individual pages already switch to their compact layouts
      // before this floor, while larger screens receive their preferred size
      // from the native startup fitting below.
      const WINDOW_MIN_WIDTH = 720;
      const WINDOW_MIN_HEIGHT = 480;
      const WINDOW_ABSOLUTE_MIN_WIDTH = 480;
      const WINDOW_ABSOLUTE_MIN_HEIGHT = 360;
      const WINDOW_SAFE_MARGIN = 32;
      const WINDOW_RADIUS_PRESETS = {
        none: 0,
        small: 10,
        large: 18
      };
      const WINDOW_RADIUS_CUSTOM_DEFAULT = 10;
      const WINDOW_RADIUS_MAX = 32;
      const isTauri = typeof window !== 'undefined' && !!window.__TAURI_INTERNALS__;

      function readTextStatsDocument(file) {
        return readTextDocument(file, {
          isTauri,
          fallbackName: t('home.textStats.document'),
          onTrim: max => window.showToast?.(t('home.textStats.documentTrimmed', { max }))
        });
      }
      const isScreenPickerWindow = typeof window !== 'undefined'
        && new URLSearchParams(window.location.search).get('screen-picker') === '1';
      const appWindow = isTauri ? getCurrentWindow() : null;

      const LEGACY_AI_API_KEY_NAMES = ['ai_api_key', 'deepseek_api_key'];

      function readLegacyAiApiKey() {
        try {
          for (const name of LEGACY_AI_API_KEY_NAMES) {
            const value = localStorage.getItem(name)?.trim();
            if (value) return value;
          }
        } catch {
          // Continue without migration when WebView storage is unavailable.
        }
        return '';
      }

      function clearLegacyAiApiKeys() {
        try {
          LEGACY_AI_API_KEY_NAMES.forEach(name => localStorage.removeItem(name));
        } catch {
          // The DPAPI copy is already durable, so storage cleanup is best-effort.
        }
      }

      let aiApiKeyCache = readLegacyAiApiKey();
      const aiApiKeyReady = (async () => {
        if (!isTauri) return aiApiKeyCache;
        try {
          const { invoke } = await tauriCorePromise;
          const protectedKey = await invoke('load_ai_api_key');
          if (typeof protectedKey === 'string' && protectedKey) {
            aiApiKeyCache = protectedKey;
            clearLegacyAiApiKeys();
          } else if (aiApiKeyCache) {
            await invoke('store_ai_api_key', { apiKey: aiApiKeyCache });
            clearLegacyAiApiKeys();
          }
        } catch {
          // Preserve the legacy key until a later run can complete migration.
        }
        return aiApiKeyCache;
      })();

      async function getAiApiKey() {
        await aiApiKeyReady;
        return aiApiKeyCache;
      }

      async function persistAiApiKey(apiKey) {
        await aiApiKeyReady;
        if (isTauri) {
          const { invoke } = await tauriCorePromise;
          await invoke('store_ai_api_key', { apiKey });
        }
        aiApiKeyCache = apiKey;
        clearLegacyAiApiKeys();
      }

      async function removeAiApiKey() {
        await aiApiKeyReady;
        if (isTauri) {
          const { invoke } = await tauriCorePromise;
          await invoke('clear_ai_api_key');
        }
        aiApiKeyCache = '';
        clearLegacyAiApiKeys();
      }

      // Global UI feedback is intentionally kept separate from tool audio
      // contexts (BPM, typing and audio clipping). It is synthesized locally,
      // so no asset download or additional permission is required.
      const UI_SOUND_STORAGE_KEY = 'toolknit.ui-sound.v1';
      const UI_SOUND_STYLES = Object.freeze({
        '1': Object.freeze({
          touch: Object.freeze([{ frequency: 360, endFrequency: 430, duration: 0.065, volume: 0.14, waveform: 'sine' }]),
          slide: Object.freeze([{ frequency: 285, endFrequency: 330, duration: 0.045, volume: 0.08, waveform: 'sine' }]),
          hover: Object.freeze([{ frequency: 440, endFrequency: 470, duration: 0.04, volume: 0.1, waveform: 'sine' }])
        }),
        '2': Object.freeze({
          touch: Object.freeze([{ frequency: 430, endFrequency: 510, duration: 0.055, volume: 0.12, waveform: 'triangle' }]),
          slide: Object.freeze([{ frequency: 330, endFrequency: 390, duration: 0.04, volume: 0.07, waveform: 'triangle' }]),
          hover: Object.freeze([{ frequency: 520, endFrequency: 550, duration: 0.035, volume: 0.09, waveform: 'triangle' }])
        }),
        '3': Object.freeze({
          touch: Object.freeze([{ frequency: 190, endFrequency: 250, duration: 0.07, volume: 0.1, waveform: 'square' }]),
          slide: Object.freeze([{ frequency: 150, endFrequency: 205, duration: 0.05, volume: 0.065, waveform: 'square' }]),
          hover: Object.freeze([{ frequency: 280, endFrequency: 305, duration: 0.038, volume: 0.08, waveform: 'square' }])
        })
      });
      const UI_SOUND_MIN_INTERVALS = Object.freeze({ touch: 55, slide: 42, hover: 115 });

      function readUiSoundState() {
        let parsed = null;
        try { parsed = JSON.parse(localStorage.getItem(UI_SOUND_STORAGE_KEY) || 'null'); } catch { /* storage may be unavailable */ }
        return {
          enabled: parsed?.enabled !== false,
          style: Object.prototype.hasOwnProperty.call(UI_SOUND_STYLES, String(parsed?.style)) ? String(parsed.style) : '1'
        };
      }

      let uiSoundState = readUiSoundState();
      let uiSoundContext = null;
      let uiSoundMaster = null;
      let uiSoundLastPlayed = Object.create(null);
      let uiSoundDragState = null;
      const uiSoundVoices = new Set();

      function saveUiSoundState() {
        try { localStorage.setItem(UI_SOUND_STORAGE_KEY, JSON.stringify(uiSoundState)); } catch { /* keep runtime behavior if storage is blocked */ }
      }

      function setUiSoundState(patch = {}) {
        uiSoundState = {
          enabled: patch.enabled === undefined ? uiSoundState.enabled : Boolean(patch.enabled),
          style: Object.prototype.hasOwnProperty.call(UI_SOUND_STYLES, String(patch.style ?? uiSoundState.style))
            ? String(patch.style ?? uiSoundState.style)
            : uiSoundState.style
        };
        saveUiSoundState();
        if (!uiSoundState.enabled) {
          // Disabled means no live audio graph should remain behind the UI.
          uiSoundDragState = null;
          disposeUiSoundContext();
        }
        window.dispatchEvent(new CustomEvent('toolknit-ui-sound-change', { detail: { ...uiSoundState } }));
        return { ...uiSoundState };
      }

      function ensureUiSoundContext({ userGesture = false } = {}) {
        if (!uiSoundState.enabled || isScreenPickerWindow) return null;
        if (uiSoundContext?.state === 'closed') disposeUiSoundContext();
        if (!userGesture && !uiSoundContext) return null;
        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        if (!AudioContextClass) return null;
        if (!uiSoundContext) {
          let candidateContext = null;
          try {
            candidateContext = new AudioContextClass();
            uiSoundContext = candidateContext;
            uiSoundMaster = uiSoundContext.createGain();
            uiSoundMaster.gain.value = 0.6;
            uiSoundMaster.connect(uiSoundContext.destination);
          } catch {
            try { candidateContext?.close().catch(() => {}); } catch { /* context creation failed */ }
            uiSoundContext = null;
            uiSoundMaster = null;
            return null;
          }
        }
        if (userGesture && uiSoundContext.state === 'suspended') uiSoundContext.resume().catch(() => {});
        return uiSoundContext;
      }

      function playUiSound(kind = 'hover', { userGesture = false, styleOverride = null, force = false } = {}) {
        if ((!uiSoundState.enabled && !force) || !UI_SOUND_STYLES[styleOverride || uiSoundState.style]?.[kind]) return false;
        const now = performance.now();
        const minInterval = UI_SOUND_MIN_INTERVALS[kind] || 40;
        if (!force && now - (uiSoundLastPlayed[kind] || 0) < minInterval) return false;
        const context = ensureUiSoundContext({ userGesture });
        if (!context || !uiSoundMaster || context.state === 'closed') return false;
        uiSoundLastPlayed[kind] = now;
        const profile = UI_SOUND_STYLES[styleOverride || uiSoundState.style][kind];
        const start = context.currentTime + 0.004;
        profile.forEach(tone => {
          let oscillator = null;
          let gain = null;
          let voice = null;
          const releaseVoice = () => {
            if (voice) uiSoundVoices.delete(voice);
            try { oscillator?.disconnect(); } catch { /* already disconnected */ }
            try { gain?.disconnect(); } catch { /* already disconnected */ }
          };
          try {
            oscillator = context.createOscillator();
            gain = context.createGain();
            voice = { oscillator, gain };
            const duration = Math.max(0.025, Number(tone.duration) || 0.06);
            const volume = Math.max(0.001, Number(tone.volume) || 0.02);
            oscillator.type = tone.waveform || 'sine';
            oscillator.frequency.setValueAtTime(Number(tone.frequency) || 440, start);
            oscillator.frequency.exponentialRampToValueAtTime(Math.max(20, Number(tone.endFrequency) || tone.frequency || 440), start + duration);
            gain.gain.setValueAtTime(0.0001, start);
            gain.gain.exponentialRampToValueAtTime(volume, start + Math.min(0.012, duration * 0.28));
            gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
            oscillator.connect(gain);
            gain.connect(uiSoundMaster);
            uiSoundVoices.add(voice);
            oscillator.addEventListener('ended', releaseVoice, { once: true });
            oscillator.start(start);
            oscillator.stop(start + duration + 0.012);
          } catch {
            releaseVoice();
          }
        });
        return true;
      }

      function disposeUiSoundContext() {
        const context = uiSoundContext;
        uiSoundVoices.forEach(({ oscillator, gain }) => {
          try { oscillator.stop(); } catch { /* voice may already be stopped */ }
          try { oscillator.disconnect(); } catch { /* already disconnected */ }
          try { gain.disconnect(); } catch { /* already disconnected */ }
        });
        uiSoundVoices.clear();
        try { uiSoundMaster?.disconnect(); } catch { /* already disconnected */ }
        uiSoundMaster = null;
        uiSoundContext = null;
        if (context && context.state !== 'closed') context.close().catch(() => {});
      }

      function isUiSoundInteractive(target) {
        return target instanceof Element
          && target.closest('button, a, input, select, textarea, summary, [role="button"], [role="switch"], [data-sound-click]');
      }

      function initUiSoundEvents() {
        if (isScreenPickerWindow) return;
        // WebView/browser autoplay policy requires a real user gesture before
        // an AudioContext may run. Unlock silently on the first normal press so
        // later hover feedback does not depend on clicking a specific control.
        document.addEventListener('pointerdown', event => {
          const target = event.target instanceof Element ? event.target : null;
          if (target?.closest('.no-ui-sound')) return;
          ensureUiSoundContext({ userGesture: true });
        }, { capture: true, passive: true });
        document.addEventListener('pointerover', event => {
          const target = isUiSoundInteractive(event.target);
          if (!target || target.matches(':disabled,[aria-disabled="true"],.no-ui-sound') || (event.relatedTarget instanceof Node && target.contains(event.relatedTarget))) return;
          // Hover never creates an AudioContext; it becomes active after the first gesture.
          playUiSound('hover');
        }, { passive: true });
        document.addEventListener('pointerdown', event => {
          const target = event.target instanceof Element ? event.target.closest('input[type="range"], [draggable="true"], [data-sound-slide], .audio-clip-handle') : null;
          if (!target || target.matches(':disabled,[aria-disabled="true"],.no-ui-sound')) return;
          uiSoundDragState = { pointerId: event.pointerId, target, x: event.clientX, y: event.clientY };
          playUiSound('touch', { userGesture: true });
        }, { passive: true });
        document.addEventListener('pointermove', event => {
          if (!uiSoundDragState || event.pointerId !== uiSoundDragState.pointerId) return;
          const distance = Math.hypot(event.clientX - uiSoundDragState.x, event.clientY - uiSoundDragState.y);
          if (distance < 4) return;
          uiSoundDragState.x = event.clientX;
          uiSoundDragState.y = event.clientY;
          playUiSound('slide');
        }, { passive: true });
        const stopDrag = event => {
          if (uiSoundDragState && (event.pointerId === undefined || event.pointerId === uiSoundDragState.pointerId)) uiSoundDragState = null;
        };
        document.addEventListener('pointerup', stopDrag, { passive: true });
        document.addEventListener('pointercancel', stopDrag, { passive: true });
        document.addEventListener('input', event => {
          if (event.target instanceof HTMLInputElement && event.target.type === 'range') playUiSound('slide', { userGesture: true });
        }, { passive: true });
        document.addEventListener('dragstart', event => {
          if (event.target instanceof Element && !event.target.closest('.no-ui-sound')) playUiSound('touch', { userGesture: true });
        }, { passive: true });
        const suspendUiSound = () => {
          uiSoundDragState = null;
          if (uiSoundContext?.state === 'running') uiSoundContext.suspend().catch(() => {});
        };
        document.addEventListener('visibilitychange', () => { if (document.hidden) suspendUiSound(); });
        window.addEventListener('blur', suspendUiSound, { passive: true });
        const disposeAllAudio = () => {
          disposeUiSoundContext();
        };
        window.addEventListener('pagehide', disposeAllAudio, { passive: true });
        window.addEventListener('beforeunload', disposeAllAudio, { passive: true });
      }

      window.toolknitUiSound = Object.freeze({
        getState: () => ({ ...uiSoundState }),
        setEnabled: enabled => setUiSoundState({ enabled }),
        setStyle: style => setUiSoundState({ style }),
        play: (kind = 'hover', options = {}) => playUiSound(kind, { ...options, userGesture: true }),
        preview: style => playUiSound('hover', { styleOverride: String(style || uiSoundState.style), userGesture: true, force: true })
      });
      initUiSoundEvents();
      if (isScreenPickerWindow) {
        setTimeout(() => { void bootstrapScreenPickerOverlay(); }, 0);
      }
      let nativeWindowRadiusQueue = Promise.resolve();
      let nativeWindowChromeRepairQueue = Promise.resolve();

      // Self-contained early bootstrap for the full-screen color picker window.
      // It runs on a macrotask so an unrelated top-level init failure elsewhere
      // in this bundle cannot leave the picker stuck on "starting…".
      async function bootstrapScreenPickerOverlay() {
        if (window.__toolknitScreenPickerBootstrapped) return;
        window.__toolknitScreenPickerBootstrapped = true;
        const overlay = document.getElementById('screenPickerOverlay');
        if (!overlay) return;
        document.documentElement.dataset.screenPicker = '1';
        overlay.classList.add('visible');

        const canvas = document.getElementById('screenPickerCanvas');
        const crosshair = overlay.querySelector('.screen-picker-crosshair');
        const readoutSwatch = document.getElementById('screenPickerReadoutSwatch');
        const readoutHex = document.getElementById('screenPickerReadoutHex');
        const readoutRgb = document.getElementById('screenPickerReadoutRgb');
        const readout = overlay.querySelector('.screen-picker-readout');
        const finishBtn = document.getElementById('screenPickerFinishBtn');

        const LENS_SIZE = 200;

        let bounds = null;
        let scaleX = 1;
        let scaleY = 1;
        let latestSample = null;
        let dragging = false;
        let dragOffsetX = 0;
        let dragOffsetY = 0;
        let rafId = null;
        let nextSampleAt = 0;
        let sampling = false;

        const { invoke } = await tauriCorePromise;
        const { emitTo, listen } = await tauriEventPromise;

        const emit = (name, payload) => {
          return emitTo('main', name, payload).catch(error => console.error('[screen-picker] emit failed', name, error));
        };
        const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

        const crosshairPhysical = () => {
          if (!crosshair || !bounds) return null;
          const localX = parseFloat(crosshair.style.left) || 0;
          const localY = parseFloat(crosshair.style.top) || 0;
          return {
            x: Math.round((Number(bounds.x) || 0) + localX / scaleX),
            y: Math.round((Number(bounds.y) || 0) + localY / scaleY),
          };
        };

        const draw = (sample) => {
          if (!canvas || !sample?.pixels?.length) return;
          const gridWidth = Number(sample.width) || 21;
          const gridHeight = Number(sample.height) || 21;
          const ctx = canvas.getContext('2d');
          if (!ctx) return;
          const size = LENS_SIZE;
          if (canvas.width !== size || canvas.height !== size) { canvas.width = size; canvas.height = size; }
          ctx.clearRect(0, 0, size, size);
          ctx.imageSmoothingEnabled = false;
          const cellW = size / gridWidth;
          const cellH = size / gridHeight;
          for (let row = 0; row < gridHeight; row++) {
            for (let col = 0; col < gridWidth; col++) {
              const offset = (row * gridWidth + col) * 3;
              const r = Number(sample.pixels[offset]) || 0;
              const g = Number(sample.pixels[offset + 1]) || 0;
              const b = Number(sample.pixels[offset + 2]) || 0;
              ctx.fillStyle = `rgb(${r}, ${g}, ${b})`;
              ctx.fillRect(Math.floor(col * cellW), Math.floor(row * cellH), Math.ceil(cellW) + 1, Math.ceil(cellH) + 1);
            }
          }
          const centerCol = Math.floor(gridWidth / 2);
          const centerRow = Math.floor(gridHeight / 2);
          const cx = centerCol * cellW + cellW / 2;
          const cy = centerRow * cellH + cellH / 2;
          ctx.save();
          ctx.strokeStyle = 'rgba(255,255,255,.95)';
          ctx.lineWidth = 2;
          ctx.shadowColor = 'rgba(0,0,0,.85)';
          ctx.shadowBlur = 2;
          ctx.beginPath();
          ctx.moveTo(cx - 8, cy);
          ctx.lineTo(cx + 8, cy);
          ctx.moveTo(cx, cy - 8);
          ctx.lineTo(cx, cy + 8);
          ctx.stroke();
          ctx.restore();
        };

        const position = () => {
          if (!crosshair || !canvas || !bounds) return;
          const localX = parseFloat(crosshair.style.left) || 0;
          const localY = parseFloat(crosshair.style.top) || 0;
          const viewportWidth = window.innerWidth || bounds.width;
          const viewportHeight = window.innerHeight || bounds.height;
          let lensLeft = localX + 34;
          let lensTop = localY - LENS_SIZE - 30;
          if (lensLeft + LENS_SIZE > viewportWidth - 16) lensLeft = localX - LENS_SIZE - 34;
          if (lensTop < 16) lensTop = localY + 34;
          lensLeft = clamp(lensLeft, 16, Math.max(16, viewportWidth - LENS_SIZE - 16));
          lensTop = clamp(lensTop, 16, Math.max(16, viewportHeight - LENS_SIZE - 16));
          canvas.style.left = `${lensLeft}px`;
          canvas.style.top = `${lensTop}px`;
          if (readout) {
            readout.style.left = `${lensLeft}px`;
            readout.style.top = `${clamp(lensTop + LENS_SIZE + 12, 16, Math.max(16, viewportHeight - 58))}px`;
          }
        };

        const placeCrosshair = (localX, localY) => {
          if (!crosshair || !bounds) return;
          const viewportWidth = window.innerWidth || bounds.width;
          const viewportHeight = window.innerHeight || bounds.height;
          crosshair.style.left = `${clamp(localX, 0, viewportWidth)}px`;
          crosshair.style.top = `${clamp(localY, 0, viewportHeight)}px`;
          position();
        };

        const applySample = (sample) => {
          if (!sample) return;
          latestSample = sample;
          draw(sample);
          const hex = String(sample?.hex || '#000000').toUpperCase();
          const rgb = String(sample?.rgb || 'rgb(0, 0, 0)');
          if (readoutSwatch) readoutSwatch.style.backgroundColor = hex;
          if (readoutHex) readoutHex.textContent = hex;
          if (readoutRgb) readoutRgb.textContent = rgb;
        };

        const sampleNow = async () => {
          if (sampling) return;
          const target = crosshairPhysical();
          if (!target) return;
          sampling = true;
          if (crosshair) crosshair.style.visibility = 'hidden';
          try {
            const next = await invoke('screen_color_sample', { x: target.x, y: target.y });
            applySample(next);
          } catch (error) {
            console.error('[screen-picker] sample failed', error);
          } finally {
            if (crosshair) crosshair.style.visibility = '';
            sampling = false;
          }
        };

        const loop = (now) => {
          rafId = null;
          if (!bounds) return;
          if (now >= nextSampleAt) {
            nextSampleAt = now + 30;
            void sampleNow();
          }
          rafId = requestAnimationFrame(loop);
        };

        const startLoop = () => {
          if (rafId !== null) return;
          nextSampleAt = performance.now();
          rafId = requestAnimationFrame(loop);
        };

        const stopLoop = () => {
          if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null; }
        };

        const pick = async () => {
          stopLoop();
          const target = crosshairPhysical();
          let picked = latestSample;
          if (target) {
            if (crosshair) crosshair.style.visibility = 'hidden';
            try {
              const next = await invoke('screen_color_sample', { x: target.x, y: target.y });
              applySample(next);
              picked = next || picked;
            } catch (error) {
              console.error('[screen-picker] pick failed', error);
            } finally {
              if (crosshair) crosshair.style.visibility = '';
            }
          }
          await emit('screen-color-picked', picked);
          try { await navigator.clipboard.writeText(String(picked?.hex || '')); } catch {}
          await emit('screen-picker-closed');
          await invoke('close_screen_color_picker').catch(() => {});
        };

        const cancel = () => {
          stopLoop();
          latestSample = null;
          void (async () => {
            await emit('screen-picker-cancelled');
            await invoke('close_screen_color_picker').catch(() => {});
          })();
        };

        const reset = (nextBounds = null) => {
          if (nextBounds && typeof nextBounds === 'object') bounds = nextBounds;
          if (!bounds) return;
          scaleX = (window.innerWidth || bounds.width) / Math.max(1, Number(bounds.width) || 1);
          scaleY = (window.innerHeight || bounds.height) / Math.max(1, Number(bounds.height) || 1);
          dragging = false;
          latestSample = null;
          placeCrosshair((window.innerWidth || bounds.width) / 2, (window.innerHeight || bounds.height) / 2);
          emit('screen-picker-ready');
          startLoop();
        };

        crosshair?.addEventListener('mousedown', (event) => {
          if (event.button !== 0) return;
          event.preventDefault();
          event.stopPropagation();
          dragging = true;
          dragOffsetX = event.clientX - (parseFloat(crosshair.style.left) || 0);
          dragOffsetY = event.clientY - (parseFloat(crosshair.style.top) || 0);
          crosshair.classList.add('dragging');
        });

        window.addEventListener('mousemove', (event) => {
          if (!dragging) return;
          placeCrosshair(event.clientX - dragOffsetX, event.clientY - dragOffsetY);
        }, { passive: true });

        window.addEventListener('mouseup', (event) => {
          if (!dragging || event.button !== 0) return;
          dragging = false;
          crosshair?.classList.remove('dragging');
          void pick();
        });

        finishBtn?.addEventListener('click', (event) => {
          event.preventDefault();
          event.stopPropagation();
          cancel();
        });

        window.addEventListener('keydown', (event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            cancel();
          }
        }, { capture: true });

        try {
          await listen('screen-picker-opened', (event) => reset(event?.payload));
        } catch (error) {
          console.error('[screen-picker] listen failed', error);
        }

        try {
          bounds = await invoke('screen_picker_bounds');
        } catch (error) {
          console.error('[screen-picker] bounds failed', error);
        }
        reset(bounds);
      }

      function clampWindowRadius(value) {
        const numeric = Number(value);
        if (!Number.isFinite(numeric)) return WINDOW_RADIUS_CUSTOM_DEFAULT;
        return Math.max(0, Math.min(WINDOW_RADIUS_MAX, Math.round(numeric)));
      }

      function readWindowRadiusSetting() {
        try {
          const parsed = JSON.parse(localStorage.getItem(WINDOW_RADIUS_KEY) || 'null');
          const mode = ['none', 'small', 'large', 'custom'].includes(parsed?.mode) ? parsed.mode : 'none';
          const custom = clampWindowRadius(parsed?.custom ?? WINDOW_RADIUS_CUSTOM_DEFAULT);
          return { mode, custom };
        } catch {
          return { mode: 'none', custom: WINDOW_RADIUS_CUSTOM_DEFAULT };
        }
      }

      function windowRadiusPixels(setting = readWindowRadiusSetting()) {
        if (setting.mode === 'custom') return clampWindowRadius(setting.custom);
        return WINDOW_RADIUS_PRESETS[setting.mode] ?? 0;
      }

      function clearLegacyWindowRadiusStyles() {
        document.querySelectorAll('html, body, .app, .settings-overlay, .global-window-controls, .transition-mask').forEach(layer => {
          layer.style.removeProperty('border-radius');
          layer.style.removeProperty('clip-path');
          layer.style.removeProperty('-webkit-clip-path');
          layer.style.removeProperty('overflow');
        });
      }

      function applyNativeWindowRadius(radius) {
        if (!isTauri) return;

        // Queue updates so a quick custom-radius edit cannot finish out of order.
        nativeWindowRadiusQueue = nativeWindowRadiusQueue
          .catch(() => undefined)
          .then(async () => {
            const { invoke } = await tauriCorePromise;
            await invoke('set_window_corner_radius', { radius });
          })
          .catch(error => {
            // Browser preview and older desktop builds simply keep the CSS fallback.
            console.warn('Native window corner radius is unavailable:', error);
          });
      }

      function repairNativeWindowChrome() {
        if (!isTauri || !appWindow || isScreenPickerWindow) return Promise.resolve();

        // Do not repeatedly rewrite the native window style. Apart from being
        // unnecessary for a normally frameless window, that can race a resize
        // or a title-bar click on WebView2. Repair only if decoration really
        // returned after a Windows state transition.
        nativeWindowChromeRepairQueue = nativeWindowChromeRepairQueue
          .catch(() => undefined)
          .then(async () => {
            const hasNativeDecorations = typeof appWindow.isDecorated === 'function'
              ? await appWindow.isDecorated()
              : true;
            if (hasNativeDecorations && typeof appWindow.setDecorations === 'function') {
              await appWindow.setDecorations(false);
            }
          })
          .catch(error => {
            console.warn('Native frameless chrome repair failed:', error);
          });

        return nativeWindowChromeRepairQueue;
      }

      let nativeWindowChromeRepairTimer = 0;
      function scheduleNativeWindowChromeRepair({ reapplyRadius = true } = {}) {
        if (!isTauri || !appWindow || isScreenPickerWindow) return;
        clearTimeout(nativeWindowChromeRepairTimer);
        nativeWindowChromeRepairTimer = window.setTimeout(() => {
          nativeWindowChromeRepairTimer = 0;
          repairNativeWindowChrome().finally(() => {
            if (reapplyRadius) applyWindowRadiusSetting(readWindowRadiusSetting());
          });
        }, 140);
      }

      function applyWindowRadiusSetting(setting = readWindowRadiusSetting()) {
        if (isScreenPickerWindow) return 0;
        const radius = windowRadiusPixels(setting);
        const value = `${radius}px`;
        const root = document.documentElement;
        root.style.setProperty('--toolknit-window-radius', value);
        root.dataset.windowRadius = setting.mode;
        const body = document.body;
        body?.classList.remove('use-native-window-radius');
        body?.classList.toggle('use-css-window-radius', radius > 0);
        body?.style.setProperty('--toolknit-window-radius', value);
        body?.setAttribute('data-window-radius', setting.mode);
        document.querySelectorAll('.app, .settings-overlay, .global-window-controls, .transition-mask').forEach(layer => {
          layer.style.setProperty('--toolknit-window-radius', value);
        });

        clearLegacyWindowRadiusStyles();

        if (isTauri) {
          // The native command clears the old binary GDI region. The body is
          // the single alpha-antialiased clipping surface for every page.
          applyNativeWindowRadius(radius);
        } else if (body) {
          // Preview fallback: one clipping boundary only, without reintroducing
          // the stacked overlay clips that make the desktop window look square.
          root.style.setProperty('border-radius', value, 'important');
          root.style.setProperty('overflow', 'hidden', 'important');
          root.style.setProperty('clip-path', `inset(0 round ${value})`, 'important');
          root.style.setProperty('-webkit-clip-path', `inset(0 round ${value})`, 'important');
        }
        return radius;
      }

      let windowRadiusSyncTimer = null;
      function syncWindowRadiusAfterLayoutChange() {
        if (!isTauri || !appWindow || isScreenPickerWindow) return;
        clearTimeout(windowRadiusSyncTimer);
        windowRadiusSyncTimer = setTimeout(() => {
          applyWindowRadiusSetting(readWindowRadiusSetting());
        }, 80);
      }

      function setWindowFrameMaximizedState(enabled) {
        const maximized = Boolean(enabled);
        document.documentElement?.classList.toggle('window-is-maximized', maximized);
        document.body?.classList.toggle('window-is-maximized', maximized);

        // Keep every page's shared title-bar control honest. The same button
        // toggles maximize/restore, so its icon and accessible label must
        // follow the native state instead of remaining a permanent square.
        const iconName = maximized ? 'copy' : 'square';
        const labelKey = maximized ? 'common.restore' : 'common.maximize';
        const label = t(labelKey);
        let iconChanged = false;
        document.querySelectorAll('.ctrl-btn[data-action="maximize"]').forEach(button => {
          const icon = button.querySelector('[data-lucide]');
          if (icon && icon.getAttribute('data-lucide') !== iconName) {
            icon.setAttribute('data-lucide', iconName);
            iconChanged = true;
          }
          button.dataset.i18nTitle = labelKey;
          button.dataset.i18nAriaLabel = labelKey;
          button.title = label;
          button.setAttribute('aria-label', label);
          button.setAttribute('aria-pressed', maximized ? 'true' : 'false');
        });
        if (iconChanged) {
          try { createIcons({ icons }); } catch (error) {
            console.warn('Window control icon refresh failed:', error);
          }
        }
      }

      async function readWindowFrameMaximizedState() {
        if (!isTauri || !appWindow || isScreenPickerWindow) return false;
        try {
          const maximized = await appWindow.isMaximized();
          const fullscreen = typeof appWindow.isFullscreen === 'function'
            ? await appWindow.isFullscreen().catch(() => false)
            : false;
          return Boolean(maximized || fullscreen);
        } catch {
          return false;
        }
      }

      async function syncWindowFrameState() {
        if (!isTauri || !appWindow || isScreenPickerWindow || !document?.body) return;
        setWindowFrameMaximizedState(await readWindowFrameMaximizedState());
      }

      function syncWindowFrameAfterLayoutChange() {
        if (!isTauri || !appWindow || isScreenPickerWindow) return;
        [0, 180].forEach(delay => {
          setTimeout(async () => {
            await syncWindowFrameState();
            applyWindowRadiusSetting(readWindowRadiusSetting());
          }, delay);
        });
      }

      let nativeWindowFrameStateTimer = 0;

      function scheduleNativeWindowFrameStateSync() {
        if (!isTauri || !appWindow || isScreenPickerWindow) return;
        clearTimeout(nativeWindowFrameStateTimer);
        nativeWindowFrameStateTimer = setTimeout(async () => {
          nativeWindowFrameStateTimer = 0;
          await syncWindowFrameState();
          applyWindowRadiusSetting(readWindowRadiusSetting());
        }, 120);
      }

      function observeNativeWindowFrameState() {
        if (!isTauri || !appWindow || isScreenPickerWindow) return;
        ['onResized', 'onScaleChanged'].forEach(method => {
          if (typeof appWindow[method] !== 'function') return;
          appWindow[method](scheduleNativeWindowFrameStateSync).catch(error => {
            console.warn(`Native window ${method} listener failed:`, error);
          });
        });
      }

      let windowMaximizeQueue = Promise.resolve();
      function toggleWindowFrameMaximize() {
        if (!isTauri || !appWindow || isScreenPickerWindow) return Promise.resolve();
        windowMaximizeQueue = windowMaximizeQueue
          .catch(() => undefined)
          .then(async () => {
            await appWindow.toggleMaximize();
            // Read the native state after the command completes. This avoids
            // a stale optimistic icon when Windows is still changing bounds.
            await syncWindowFrameState();
            scheduleNativeWindowChromeRepair();
            syncWindowFrameAfterLayoutChange();
          });
        return windowMaximizeQueue;
      }

      async function handleWindowControlAction(action) {
        if (!isTauri || !appWindow || isScreenPickerWindow || !action) return;
        try {
          if (action === 'minimize') {
            await appWindow.minimize();
          } else if (action === 'maximize') {
            await toggleWindowFrameMaximize();
          } else if (action === 'close') {
            await appWindow.hide();
          }
        } catch (e) {
          console.error('Window control failed:', e);
        }
      }

      function saveWindowRadiusSetting(setting) {
        const normalized = {
          mode: ['none', 'small', 'large', 'custom'].includes(setting?.mode) ? setting.mode : 'none',
          custom: clampWindowRadius(setting?.custom ?? WINDOW_RADIUS_CUSTOM_DEFAULT)
        };
        try { localStorage.setItem(WINDOW_RADIUS_KEY, JSON.stringify(normalized)); } catch {}
        applyWindowRadiusSetting(normalized);
        return normalized;
      }

      function readWindowResizeSetting() {
        try { return localStorage.getItem(WINDOW_RESIZE_KEY) === '1'; } catch { return false; }
      }

      function saveWindowResizeSetting(enabled) {
        try { localStorage.setItem(WINDOW_RESIZE_KEY, enabled ? '1' : '0'); } catch {}
        return Boolean(enabled);
      }

      applyWindowRadiusSetting();
      scheduleNativeWindowChromeRepair();
      observeNativeWindowFrameState();

      createIcons({ icons });
      applyTranslations();

      // Full-screen tools are visually hidden with opacity while inactive. Keep
      // their controls out of the keyboard and accessibility trees until open.
      const MODAL_A11Y_ROOT_SELECTOR = [
        '[id$="Overlay"]',
        '[id$="Workspace"]',
        '[id$="Dialog"]',
        '#pdfMergeSelection',
        '#aiDocStyleInspector'
      ].join(', ');

      function syncModalA11yState(root) {
        if (!(root instanceof HTMLElement)) return;
        const visible = root.classList.contains('visible');
        root.toggleAttribute('inert', !visible);
        root.setAttribute('aria-hidden', String(!visible));
      }

      function initModalA11yStates() {
        const roots = Array.from(document.querySelectorAll(MODAL_A11Y_ROOT_SELECTOR));
        roots.forEach(syncModalA11yState);
        const observer = new MutationObserver(entries => {
          entries.forEach(entry => syncModalA11yState(entry.target));
        });
        roots.forEach(root => observer.observe(root, {
          attributes: true,
          attributeFilter: ['class']
        }));
      }

      initModalA11yStates();

      // Keep long dynamic values inspectable without letting result dialogs
      // grow past their bounds. The visual rule uses ellipsis; title/aria-label
      // retain the complete value for mouse and assistive-technology users.
      const MODAL_OVERFLOW_ROOT_SELECTOR = [
        '.audio-convert-success-overlay',
        '.audio-clip-success-overlay',
        '.pdf-preview-drawer',
        '.donation-overlay',
        '.transcription-model-overlay',
        '.transcription-gate-overlay',
        '.pdf-editor-edit-modal',
        '#pdfEncryptPasswordDialog',
        '#pdfDecryptPasswordDialog'
      ].join(', ');
      const MODAL_OVERFLOW_TARGET_SELECTOR = [
        '.audio-convert-success-meta',
        '.audio-convert-success-value',
        '.audio-convert-success-path',
        '.audio-clip-success-meta',
        '.audio-clip-success-path',
        '.cleanup-large-files-success-failures span',
        '.pdf-page-workspace-file',
        '.ppt-render-v2-file',
        '.ppt-images-v2-file',
        '.ppt-text-v2-file',
        '.ppt-compress-v2-file',
        '.transcription-selected-file',
        '.pdf-editor-filecard-name'
      ].join(', ');
      const MODAL_OVERFLOW_ARIA_SELECTOR = [
        '.audio-convert-success-value',
        '.audio-convert-success-path',
        '.audio-clip-success-path',
        '.pdf-page-workspace-file',
        '.ppt-render-v2-file',
        '.ppt-images-v2-file',
        '.ppt-text-v2-file',
        '.ppt-compress-v2-file',
        '.transcription-selected-file',
        '.pdf-editor-filecard-name'
      ].join(', ');

      function syncModalOverflowTitle(node) {
        if (!(node instanceof HTMLElement) || node.id === 'dependencyGateDesc') return;
        const value = (node.textContent || '').replace(/\s+/g, ' ').trim();
        const ownsTitle = node.dataset.tkOverflowTitle === '1';
        const ownsAria = node.dataset.tkOverflowAria === '1';
        if (!value) {
          if (ownsTitle) node.removeAttribute('title');
          if (ownsAria) node.removeAttribute('aria-label');
          delete node.dataset.tkOverflowTitle;
          delete node.dataset.tkOverflowAria;
          return;
        }

        // Paths and filenames are the common offenders. Avoid a layout read
        // here because result text can update several times during a batch.
        const needsOverflowHint = value.length >= 28 || /(?:[A-Za-z]:[\\/]|https?:\/\/|\\\\)/.test(value);
        if (!needsOverflowHint) {
          if (ownsTitle) node.removeAttribute('title');
          if (ownsAria) node.removeAttribute('aria-label');
          delete node.dataset.tkOverflowTitle;
          delete node.dataset.tkOverflowAria;
          return;
        }

        node.setAttribute('title', value);
        node.dataset.tkOverflowTitle = '1';
        if (node.matches(MODAL_OVERFLOW_ARIA_SELECTOR) && !node.hasAttribute('aria-label')) {
          node.setAttribute('aria-label', value);
          node.dataset.tkOverflowAria = '1';
        } else if (ownsAria) {
          node.setAttribute('aria-label', value);
        }
      }

      function scanModalOverflowNode(node) {
        if (!node) return;
        if (node.nodeType === 3) {
          if (node.parentElement?.matches(MODAL_OVERFLOW_TARGET_SELECTOR)) syncModalOverflowTitle(node.parentElement);
          return;
        }
        if (node.nodeType !== 1) return;
        if (node.matches(MODAL_OVERFLOW_TARGET_SELECTOR)) syncModalOverflowTitle(node);
        node.querySelectorAll?.(MODAL_OVERFLOW_TARGET_SELECTOR).forEach(syncModalOverflowTitle);
      }

      function initModalOverflowTitles() {
        const roots = Array.from(document.querySelectorAll(MODAL_OVERFLOW_ROOT_SELECTOR));
        roots.forEach(root => {
          scanModalOverflowNode(root);
          const observer = new MutationObserver(records => {
            records.forEach(record => {
              if (record.type === 'characterData') scanModalOverflowNode(record.target);
              else {
                scanModalOverflowNode(record.target);
                record.addedNodes.forEach(scanModalOverflowNode);
              }
            });
          });
          observer.observe(root, { childList: true, characterData: true, subtree: true });
        });
      }

      initModalOverflowTitles();

      function enablePdfPageStageHorizontalWheel(stage) {
        if (!stage) return;
        stage.addEventListener('wheel', (event) => {
          if (event.ctrlKey || event.metaKey || stage.scrollWidth <= stage.clientWidth) return;
          const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY)
            ? event.deltaX
            : event.deltaY;
          if (!delta) return;

          const maxScrollLeft = stage.scrollWidth - stage.clientWidth;
          const nextScrollLeft = Math.max(0, Math.min(maxScrollLeft, stage.scrollLeft + delta));
          if (nextScrollLeft === stage.scrollLeft) return;

          event.preventDefault();
          stage.scrollLeft = nextScrollLeft;
        }, { passive: false });
      }

      document.querySelectorAll('.pdf-merge-page-stage').forEach(enablePdfPageStageHorizontalWheel);

      function stopDefaultDynamicBackground() {
      }

      function syncDefaultDynamicBackground() {
        stopDefaultDynamicBackground();
      }
      document.addEventListener('visibilitychange', syncDefaultDynamicBackground);
      window.addEventListener('pageshow', syncDefaultDynamicBackground);
      window.addEventListener('pagehide', stopDefaultDynamicBackground);
      syncDefaultDynamicBackground();

      const STANDARD_TOOL_PLASMA_OPTIONS = {
        color: '#6B6B6B',
        speed: 0.8,
        direction: 'forward',
        scale: 1,
        opacity: 1,
        mouseInteractive: false
      };

      // Custom backgrounds use the same host nodes as the existing plasma
      // layers.  Keep the media lifecycle here instead of adding listeners to
      // every tool: there are many independent overlays, but only one custom
      // image/video should ever be decoding or playing at a time.
      const CUSTOM_BACKGROUND_STORAGE_KEY = 'toolknit.customBackground.v1';
      const CUSTOM_BACKGROUND_CHANGE_EVENT = 'toolknit-custom-background-change';
      const customBackgroundRuntime = {
        config: null,
        configKey: '',
        source: '',
        sourceKey: '',
        sourcePromise: null,
        media: null,
        mediaRole: '',
        mediaToken: 0,
        homeHost: null,
        homeSession: null,
        homeReady: false,
        homeFailedKey: '',
        toolSessions: new Set()
      };

      function readCustomBackgroundConfig() {
        let parsed = null;
        try {
          parsed = JSON.parse(localStorage.getItem(CUSTOM_BACKGROUND_STORAGE_KEY) || 'null');
        } catch {
          parsed = null;
        }
        if (!parsed || typeof parsed !== 'object') return null;
        const mediaType = String(parsed.media_type || parsed.type || '').toLowerCase();
        if (mediaType !== 'image' && mediaType !== 'video') return null;
        const path = typeof parsed.path === 'string' ? parsed.path.trim() : '';
        const source = typeof parsed.src === 'string' ? parsed.src.trim() : '';
        if (!path && !source) return null;
        return {
          type: mediaType,
          path,
          src: source,
          poster: typeof parsed.poster === 'string' ? parsed.poster.trim() : '',
          name: typeof parsed.name === 'string' ? parsed.name.trim() : ''
        };
      }

      function customBackgroundConfigKey(config) {
        if (!config) return '';
        const source = String(config.src || '');
        // Do not copy an entire browser data URL into every comparison. Keep
        // a small fingerprint so a reselected file still invalidates stale
        // media without making category switches scan megabytes of text.
        const sourceFingerprint = source
          ? `${source.length}:${source.slice(0, 24)}:${source.slice(-24)}`
          : '';
        return [config.type, config.path, config.name, config.size || '', sourceFingerprint, config.poster].join('|');
      }

      function refreshCustomBackgroundConfig() {
        const config = readCustomBackgroundConfig();
        const key = customBackgroundConfigKey(config);
        if (key !== customBackgroundRuntime.configKey) {
          customBackgroundRuntime.config = config;
          customBackgroundRuntime.configKey = key;
          customBackgroundRuntime.source = '';
          customBackgroundRuntime.sourceKey = '';
          customBackgroundRuntime.sourcePromise = null;
          customBackgroundRuntime.homeFailedKey = '';
          customBackgroundRuntime.homeReady = false;
        } else {
          customBackgroundRuntime.config = config;
        }
        return config;
      }

      function isAllowedCustomBackgroundSource(source) {
        if (!source) return false;
        // Native imports are served from the loopback range server.  Browser
        // previews may use blob/data URLs.  Reject arbitrary local file paths
        // and unknown schemes so a stale localStorage value cannot bypass CSP.
        return /^(?:blob:|data:|https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?(?:\/|$))/i.test(source);
      }

      async function resolveCustomBackgroundSource(config) {
        const current = config || refreshCustomBackgroundConfig();
        if (!current) return '';
        const key = customBackgroundConfigKey(current);
        if (customBackgroundRuntime.sourceKey === key && customBackgroundRuntime.source) {
          return customBackgroundRuntime.source;
        }
        if (customBackgroundRuntime.sourcePromise && customBackgroundRuntime.sourceKey === key) {
          return customBackgroundRuntime.sourcePromise;
        }
        customBackgroundRuntime.sourceKey = key;
        customBackgroundRuntime.sourcePromise = (async () => {
          let source = current.src;
          if (!source && isTauri && current.path) {
            try {
              const { invoke } = await tauriCorePromise;
              source = await invoke('get_custom_background_media_url', { path: current.path });
            } catch (error) {
              console.error('Failed to resolve custom background:', error);
              try {
                const { invoke } = await tauriCorePromise;
                await invoke('log_custom_background_event', { event: 'resolve-failed' });
              } catch { /* logging is best effort */ }
              source = '';
            }
          }
          if (!isAllowedCustomBackgroundSource(source)) return '';
          customBackgroundRuntime.source = source;
          return source;
        })();
        try {
          return await customBackgroundRuntime.sourcePromise;
        } finally {
          if (customBackgroundRuntime.sourceKey === key) customBackgroundRuntime.sourcePromise = null;
        }
      }

      function ensureCustomHomeHost() {
        const root = document.querySelector('.app');
        if (!root) return null;
        if (customBackgroundRuntime.homeHost?.isConnected) return customBackgroundRuntime.homeHost;
        const host = document.createElement('div');
        host.className = 'home-v2-custom-background-host';
        host.setAttribute('aria-hidden', 'true');
        root.insertBefore(host, root.firstChild);
        customBackgroundRuntime.homeHost = host;
        return host;
      }

      function disposeCustomBackgroundMedia(expectedToken = null) {
        if (expectedToken !== null && expectedToken !== customBackgroundRuntime.mediaToken) return;
        const media = customBackgroundRuntime.media;
        const host = media?.parentElement;
        customBackgroundRuntime.media = null;
        customBackgroundRuntime.mediaRole = '';
        customBackgroundRuntime.mediaToken += 1;
        if (!media) return;
        host?.classList.remove('has-custom-background');
        try {
          if (media instanceof HTMLVideoElement) {
            media.pause();
            media.removeAttribute('src');
            media.load();
          } else {
            media.removeAttribute('src');
          }
        } catch { /* media cleanup is best effort */ }
        media.remove();
      }

      function mountCustomBackgroundMedia(host, config, source, role) {
        if (!host || !config || !source || !host.isConnected) return null;
        disposeCustomBackgroundMedia();
        const token = customBackgroundRuntime.mediaToken;
        const media = config.type === 'video'
          ? document.createElement('video')
          : document.createElement('img');
        media.className = 'toolknit-custom-background-media';
        media.dataset.backgroundRole = role;
        media.setAttribute('aria-hidden', 'true');
        media.setAttribute('draggable', 'false');
        if (config.type === 'video') {
          media.autoplay = true;
          media.loop = true;
          media.muted = true;
          media.playsInline = true;
          media.preload = 'metadata';
          if (config.poster && isAllowedCustomBackgroundSource(config.poster)) media.poster = config.poster;
        } else {
          media.decoding = 'async';
          media.loading = 'eager';
        }
        customBackgroundRuntime.media = media;
        customBackgroundRuntime.mediaRole = role;
        host.appendChild(media);

        let settled = false;
        let resolveReady;
        const ready = new Promise(resolve => { resolveReady = resolve; });
        const settle = ok => {
          if (settled || token !== customBackgroundRuntime.mediaToken) return;
          settled = true;
          resolveReady(Boolean(ok));
          if (!ok) {
            try {
              if (isTauri) {
                tauriCorePromise.then(({ invoke }) => invoke('log_custom_background_event', {
                  event: `media-error:${role}`
                })).catch(() => {});
              }
            } catch { /* logging is best effort */ }
          }
        };
        const handleError = () => settle(false);
        const handleReady = () => {
          settle(true);
          if (media instanceof HTMLVideoElement) media.play().catch(() => {});
        };
        media.addEventListener('error', handleError, { once: true });
        if (media instanceof HTMLVideoElement) {
          media.addEventListener('canplay', handleReady, { once: true });
          media.addEventListener('loadeddata', handleReady, { once: true });
        } else {
          media.addEventListener('load', handleReady, { once: true });
        }
        media.src = source;
        if (media instanceof HTMLVideoElement) media.load();

        const dispose = () => {
          if (token !== customBackgroundRuntime.mediaToken) return;
          disposeCustomBackgroundMedia(token);
        };
        return { token, media, ready, dispose };
      }

      function syncCustomHomeBackground() {
        const config = refreshCustomBackgroundConfig();
        const root = document.querySelector('.app');
        const homeActive = Boolean(root?.classList.contains('is-v2-home')) && customBackgroundRuntime.toolSessions.size === 0;
        root?.classList.toggle('has-custom-background', Boolean(config && homeActive && customBackgroundRuntime.homeReady));
        if (!root?.classList.contains('is-v2-home') || customBackgroundRuntime.toolSessions.size > 0 || !config) {
          customBackgroundRuntime.homeReady = false;
          if (customBackgroundRuntime.homeSession) {
            customBackgroundRuntime.homeSession.dispose();
            customBackgroundRuntime.homeSession = null;
          }
          return;
        }
        const host = ensureCustomHomeHost();
        if (!host) return;
        const configKey = customBackgroundRuntime.configKey;
        if (customBackgroundRuntime.homeSession?.configKey === configKey) return;
        if (customBackgroundRuntime.homeFailedKey === configKey) return;
        customBackgroundRuntime.homeReady = false;
        customBackgroundRuntime.homeSession?.dispose();
        const session = { configKey, disposed: false, dispose: () => {} };
        customBackgroundRuntime.homeSession = session;
        resolveCustomBackgroundSource(config).then(source => {
          if (session.disposed || customBackgroundRuntime.homeSession !== session) return;
          if (!source) {
            customBackgroundRuntime.homeFailedKey = configKey;
            session.dispose();
            syncHomeV2Background();
            return;
          }
          const mounted = mountCustomBackgroundMedia(host, config, source, 'home');
          if (!mounted) return;
          mounted.ready.then(ok => {
            if (ok && !session.disposed && customBackgroundRuntime.homeSession === session) {
              customBackgroundRuntime.homeReady = true;
              host.classList.add('has-custom-background');
              root?.classList.toggle('has-custom-background', Boolean(root?.classList.contains('is-v2-home') && customBackgroundRuntime.toolSessions.size === 0));
              syncHomeV2Background();
            } else if (!ok && !session.disposed) {
              customBackgroundRuntime.homeFailedKey = configKey;
              session.dispose();
              syncHomeV2Background();
            }
          });
          session.dispose = () => {
            if (session.disposed) return;
            session.disposed = true;
            if (customBackgroundRuntime.homeSession === session) customBackgroundRuntime.homeSession = null;
            customBackgroundRuntime.homeReady = false;
            mounted.dispose();
          };
        }).catch(() => {});
        session.dispose = () => {
          if (session.disposed) return;
          session.disposed = true;
          if (customBackgroundRuntime.homeSession === session) customBackgroundRuntime.homeSession = null;
          customBackgroundRuntime.homeReady = false;
        };
      }

      window.toolknitCustomBackground = {
        refresh: () => {
          refreshCustomBackgroundConfig();
          syncCustomHomeBackground();
          customBackgroundRuntime.toolSessions.forEach(session => session.refresh?.());
          syncHomeV2Background();
        },
        getConfig: () => ({ ...(refreshCustomBackgroundConfig() || {}) })
      };
      window.addEventListener(CUSTOM_BACKGROUND_CHANGE_EVENT, () => {
        // A user-initiated selection should be allowed to retry the same
        // source after a transient decode or local-server failure.
        customBackgroundRuntime.homeFailedKey = '';
        window.toolknitCustomBackground.refresh();
      });

      function pauseCustomBackgroundMedia() {
        const media = customBackgroundRuntime.media;
        if (media instanceof HTMLVideoElement) media.pause();
      }

      function resumeCustomBackgroundMedia() {
        const media = customBackgroundRuntime.media;
        if (!(media instanceof HTMLVideoElement) || document.hidden || !media.isConnected) return;
        media.play().catch(() => {});
      }

      document.addEventListener('visibilitychange', () => {
        if (document.hidden) pauseCustomBackgroundMedia();
        else resumeCustomBackgroundMedia();
        syncCustomBackgroundPreviewPlayback?.();
      });
      window.addEventListener('pagehide', pauseCustomBackgroundMedia);
      window.addEventListener('pageshow', () => {
        resumeCustomBackgroundMedia();
        syncCustomBackgroundPreviewPlayback?.();
      });

      function initStandardToolPlasma(containerEl) {
        if (!containerEl) return null;
        let disposed = false;
        let innerDispose = null;
        let rebuildRaf = 0;
        let customSession = null;
        let customConfigKey = '';

        const startStandard = () => {
          if (disposed || innerDispose || document.hidden || !containerEl.isConnected) return;
          innerDispose = initPlasma(containerEl, STANDARD_TOOL_PLASMA_OPTIONS);
        };

        const stopInner = () => {
          if (rebuildRaf) {
            cancelAnimationFrame(rebuildRaf);
            rebuildRaf = 0;
          }
          if (typeof innerDispose === 'function') {
            innerDispose();
            innerDispose = null;
          }
        };

        const startInner = () => {
          rebuildRaf = 0;
          startStandard();
        };

        const scheduleStart = () => {
          if (disposed || innerDispose || rebuildRaf) return;
          rebuildRaf = requestAnimationFrame(startInner);
        };

        const sync = () => {
          if (disposed) return;
          if (document.hidden) stopInner();
          else if (customSession) stopInner();
          else scheduleStart();
        };

        document.addEventListener('visibilitychange', sync);
        window.addEventListener('pageshow', sync);
        window.addEventListener('pagehide', stopInner);
        scheduleStart();

        const session = {
          refresh: () => {
            if (disposed) return;
            const config = refreshCustomBackgroundConfig();
            const nextKey = customBackgroundConfigKey(config);
            const ownsMedia = Boolean(
              customSession?.media?.isConnected
              && customSession.media.parentElement === containerEl
            );
            if (nextKey === customConfigKey && (ownsMedia || !config)) return;
            if (customSession && !ownsMedia) customSession = null;
            customConfigKey = nextKey;
            containerEl.classList.remove('has-custom-background');
            customSession?.dispose();
            customSession = null;
            if (!config) {
              if (!innerDispose && !document.hidden) scheduleStart();
              return;
            }
            // Keep the shader as an immediate fallback while the native range
            // URL is resolved and the first media frame is decoded.
            if (!innerDispose && !document.hidden) scheduleStart();
            const localKey = nextKey;
            resolveCustomBackgroundSource(config).then(source => {
              if (disposed || localKey !== customConfigKey || !source) return;
              const mounted = mountCustomBackgroundMedia(containerEl, config, source, 'tool');
              if (!mounted) return;
              customSession = mounted;
              mounted.ready.then(ok => {
                if (disposed || localKey !== customConfigKey) return;
                if (ok) {
                  containerEl.classList.add('has-custom-background');
                  stopInner();
                }
                else {
                  containerEl.classList.remove('has-custom-background');
                  mounted.dispose();
                  if (customSession === mounted) customSession = null;
                  if (!innerDispose && !document.hidden) scheduleStart();
                }
              });
            }).catch(() => {});
          },
          dispose: () => {
            if (disposed) return;
            disposed = true;
            customBackgroundRuntime.toolSessions.delete(session);
            containerEl.classList.remove('has-custom-background');
            customSession?.dispose();
            customSession = null;
          }
        };
        customBackgroundRuntime.toolSessions.add(session);
        syncCustomHomeBackground();
        session.refresh();

        return () => {
          session.dispose();
          document.removeEventListener('visibilitychange', sync);
          window.removeEventListener('pageshow', sync);
          window.removeEventListener('pagehide', stopInner);
          stopInner();
          // Nested workspaces can keep an older tool session alive. If the
          // newest workspace released the shared media node, let the older
          // session reclaim it instead of leaving its background blank.
          customBackgroundRuntime.toolSessions.forEach(other => other.refresh?.());
          if (customBackgroundRuntime.toolSessions.size === 0) syncCustomHomeBackground();
        };
      }

      function disposeStandardToolPlasma(dispose) {
        if (typeof dispose === 'function') dispose();
        return null;
      }

      // Lazy 2.1 pages mount their own background host when opened. Reusing
      // this lifecycle keeps custom image/video backgrounds shared and makes
      // sure the plasma RAF and media node are released when a page closes.
      window.toolknitToolBackground = {
        mount: container => initStandardToolPlasma(container),
        dispose: dispose => disposeStandardToolPlasma(dispose)
      };

      const OUTPUT_ROOT_KEY = 'toolknit.output-root.v1';

      let windowResizeQueue = Promise.resolve();
      async function adaptiveMinimumWindowSize() {
        if (!isTauri) return new LogicalSize(WINDOW_MIN_WIDTH, WINDOW_MIN_HEIGHT);
        try {
          const monitor = await currentMonitor();
          const scale = Number(monitor?.scaleFactor) || 1;
          const physicalSize = monitor?.workArea?.size;
          if (!physicalSize || scale <= 0) {
            return new LogicalSize(WINDOW_MIN_WIDTH, WINDOW_MIN_HEIGHT);
          }
          const usableWidth = Math.max(
            WINDOW_ABSOLUTE_MIN_WIDTH,
            (Number(physicalSize.width) / scale) - WINDOW_SAFE_MARGIN
          );
          const usableHeight = Math.max(
            WINDOW_ABSOLUTE_MIN_HEIGHT,
            (Number(physicalSize.height) / scale) - WINDOW_SAFE_MARGIN
          );
          return new LogicalSize(
            Math.max(WINDOW_ABSOLUTE_MIN_WIDTH, Math.min(WINDOW_MIN_WIDTH, usableWidth)),
            Math.max(WINDOW_ABSOLUTE_MIN_HEIGHT, Math.min(WINDOW_MIN_HEIGHT, usableHeight))
          );
        } catch (error) {
          console.warn('Unable to inspect monitor work area for window sizing:', error);
          return new LogicalSize(WINDOW_MIN_WIDTH, WINDOW_MIN_HEIGHT);
        }
      }

      function applyWindowResizeSetting(enabled = readWindowResizeSetting()) {
        const requested = Boolean(enabled);
        if (isScreenPickerWindow || !isTauri || !appWindow) return Promise.resolve(requested);

        // All native style changes share one queue. This prevents a fast
        // double-click from interleaving setResizable with unmaximize or a
        // delayed frame repair and leaving the toggle out of sync.
        windowResizeQueue = windowResizeQueue
          .catch(() => undefined)
          .then(async () => {
            await appWindow.setMinSize(await adaptiveMinimumWindowSize());
            await appWindow.setMaxSize(null);
            await repairNativeWindowChrome();

            if (!requested) {
              try {
                if (await appWindow.isMaximized()) await appWindow.unmaximize();
              } catch (error) {
                // A transient maximize-state read must not prevent the user
                // from changing the resizable setting itself.
                console.warn('Unable to restore window before disabling resize:', error);
              }
            }
            await appWindow.setResizable(requested);

            const applied = await appWindow.isResizable();
            if (applied !== requested) {
              throw new Error(`Native resizable state mismatch: requested=${requested}, applied=${applied}`);
            }
            syncWindowFrameAfterLayoutChange();
            return applied;
          });
        return windowResizeQueue;
      }

      if (!isScreenPickerWindow) {
        const initialResizePreference = readWindowResizeSetting();
        void applyWindowResizeSetting(initialResizePreference).catch(error => {
          console.error('Failed to apply saved window resize setting:', error);
        });
      }

      function canStartNativeWindowDrag(event) {
        if (event.button !== 0 || event.defaultPrevented) return false;
        const target = event.target;
        if (!(target instanceof Element)) return false;
        return !target.closest('button, a, input, select, textarea, summary, [contenteditable="true"], [role="button"], [data-no-window-drag]');
      }

      // A data-tauri-drag-region on a complete header also includes its nested
      // controls. On Windows that lets the native drag handler win over a
      // settings/minimize/maximize click intermittently. Dedicated empty drag
      // strips retain the native attribute; interactive headers start dragging
      // only from genuinely empty space.
      function initNativeWindowDragRegions() {
        if (!isTauri || !appWindow || isScreenPickerWindow) return;
        document.querySelectorAll('.main-header-drag-region').forEach(region => {
          region.setAttribute('data-tauri-drag-region', '');
        });

        const headerSelector = '.settings-header, .settings-v2-topbar, .home-v2-topbar, .api-key-header, .feedback-header, .audio-convert-header, .audio-clip-header, .help-v2-topbar, .pdf-merge-v2-topbar, .help-sidebar-header, .help-content-header, .transcription-model-header, .pdf-merge-page-picker-header, .pdf-page-workspace-header, .pdf-preview-drawer-header, .update-preview-stage-topbar';
        document.querySelectorAll(headerSelector).forEach(header => {
          header.removeAttribute('data-tauri-drag-region');
          header.style.setProperty('-webkit-app-region', 'no-drag');
          header.addEventListener('pointerdown', event => {
            if (!canStartNativeWindowDrag(event)) return;
            event.preventDefault();
            appWindow.startDragging().catch(error => {
              console.warn('Native window drag failed:', error);
            });
          });
        });
      }

      initNativeWindowDragRegions();

      function configuredOutputRoot() {
        try { return localStorage.getItem(OUTPUT_ROOT_KEY)?.trim() || ''; } catch { return ''; }
      }

      async function syncConfiguredOutputRoot() {
        if (!isTauri) return;
        try {
          const { invoke } = await tauriCorePromise;
          const savedInBrowser = configuredOutputRoot();
          let savedInApp = await invoke('get_output_root');
          // Migrate the earlier browser-only setting once, then always use the native record.
          if (!savedInApp && savedInBrowser) {
            await invoke('set_output_root', { outputDir: savedInBrowser });
            savedInApp = savedInBrowser;
          }
          if (savedInApp) localStorage.setItem(OUTPUT_ROOT_KEY, savedInApp);
          else localStorage.removeItem(OUTPUT_ROOT_KEY);
        } catch (error) {
          console.error('Failed to sync output folder:', error);
        }
      }

      async function getOutputDir(subFolder) {
        const joinOutputSubFolder = (root, child) => {
          const separator = root.includes('\\') ? '\\' : '/';
          const normalizedChild = String(child || '')
            .replace(/[\\/]+/g, separator)
            .replace(separator === '\\' ? /^\\+|\\+$/g : /^\/+|\/+$/g, '');
          const normalizedRoot = root.replace(/[\/\\]+$/, '');
          return normalizedChild ? normalizedRoot + separator + normalizedChild : normalizedRoot;
        };
        let configuredRoot = configuredOutputRoot();
        if (isTauri) {
          try {
            const { invoke } = await tauriCorePromise;
            const savedInApp = await invoke('get_output_root');
            configuredRoot = typeof savedInApp === 'string' ? savedInApp.trim() : '';
            if (configuredRoot) localStorage.setItem(OUTPUT_ROOT_KEY, configuredRoot);
            else localStorage.removeItem(OUTPUT_ROOT_KEY);
          } catch (error) {
            // Keep the last known path as a temporary fallback when native config is unavailable.
            console.error('Failed to read output folder:', error);
          }
        }
        if (configuredRoot) {
          return joinOutputSubFolder(configuredRoot, subFolder);
        }
        if (!isTauri) return '~/Downloads/ToolKnit/' + subFolder;
        try {
          const { invoke } = await tauriCorePromise;
          const defaultRoot = await invoke('get_default_output_root');
          return joinOutputSubFolder(defaultRoot, subFolder);
        } catch (e) {
          console.error('Failed to get default output folder:', e);
          return 'C:\\Users\\Downloads\\ToolKnit\\' + subFolder;
        }
      }
      function outputParentFolder(outputPath) {
        const value = String(outputPath || '').trim();
        if (!value) return '';
        const normalized = value.replace(/[\\/]+$/, '');
        const parent = normalized.replace(/[/\\][^/\\]+$/, '');
        return parent && parent !== normalized ? parent : normalized;
      }
      function displayFilesystemPath(path) {
        const value = String(path || '').trim();
        if (!value) return '';
        const cleaned = value
          .replace(/^\\\\\?\\UNC\\/i, '\\\\')
          .replace(/^\\\\\?\\/i, '')
          .replace(/^\/\/\?\/UNC\//i, '//')
          .replace(/^\/\/\?\//i, '');
        const looksLikeWindowsPath = /^[a-z]:[\\/]/i.test(cleaned) || /^\\\\/.test(cleaned) || /^\/\//.test(cleaned);
        return looksLikeWindowsPath ? cleaned.replace(/\//g, '\\') : cleaned;
      }
      function displayOutputParentFolder(outputPath) {
        return displayFilesystemPath(outputParentFolder(outputPath));
      }
      async function openOutputFolder(outputPath) {
        if (!isTauri || !outputPath) return false;
        const targetPath = String(outputPath).trim();
        if (!targetPath) return false;
        try {
          const { invoke } = await tauriCorePromise;
          await invoke('open_path', { path: targetPath });
          return true;
        } catch (error) {
          console.error('Open output folder failed:', error);
          window.showToast?.(t('common.openFolderFailed'));
          return false;
        }
      }
      const transitionMask = document.getElementById('transitionMask');
      const navItems = document.querySelectorAll('.nav-item');
      const contentSections = document.querySelectorAll('.content-section');
      const mainContent = document.querySelector('.main-content');
      let isSwitching = false;

      // Tool card mouse spotlight effect and accessibility
      document.querySelectorAll('.tool-card').forEach(card => {
        card.setAttribute('role', 'button');
        card.setAttribute('tabindex', '0');
        const toolName = card.querySelector('.tool-name');
        if (toolName) {
          card.setAttribute('aria-label', toolName.textContent || t('common.tool'));
        }
        card.addEventListener('mousemove', (e) => {
          const rect = card.getBoundingClientRect();
          const x = ((e.clientX - rect.left) / rect.width) * 100;
          const y = ((e.clientY - rect.top) / rect.height) * 100;
          card.style.setProperty('--mouse-x', `${x}%`);
          card.style.setProperty('--mouse-y', `${y}%`);
        });
        card.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            card.click();
          }
        });
      });

      // Audio list items accessibility + mouse spotlight
      document.querySelectorAll('.audio-list-item').forEach(item => {
        item.addEventListener('mousemove', (e) => {
          const rect = item.getBoundingClientRect();
          const x = ((e.clientX - rect.left) / rect.width) * 100;
          const y = ((e.clientY - rect.top) / rect.height) * 100;
          item.style.setProperty('--mouse-x', `${x}%`);
          item.style.setProperty('--mouse-y', `${y}%`);
        });
        item.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            item.click();
          }
        });
      });

      // Audio tool search: trigger by button click with spider mascot loading for at least 1s
      // After search: input hides, clear button shows; footer shows at bottom of results
      // Clear button: mask animation, then restore input
      const audioSearchInput = document.getElementById('audioSearchInput');
      const audioSearchBtn = document.getElementById('audioSearchBtn');
      const audioClearBtn = document.getElementById('audioClearBtn');
      const audioSearchFooter = document.getElementById('audioSearchFooter');
      const audioSearchWrap = document.getElementById('audioSearchWrap');

      if (audioSearchBtn && audioSearchInput) {
        let audioSearching = false;
        const doAudioSearch = () => {
          if (audioSearching) return;
          audioSearching = true;
          if (transitionMask) transitionMask.classList.add('visible');
          setTimeout(() => {
            const query = audioSearchInput.value.trim().toLowerCase();
            document.querySelectorAll('.audio-list-item').forEach(item => {
              const text = item.textContent.toLowerCase();
              item.style.display = text.includes(query) ? '' : 'none';
            });
            // Hide input + search button, show clear button
            audioSearchInput.style.display = 'none';
            audioSearchBtn.style.display = 'none';
            audioClearBtn.style.display = 'block';
            // Show footer
            if (audioSearchFooter) audioSearchFooter.style.display = 'flex';
            if (transitionMask) transitionMask.classList.remove('visible');
            audioSearching = false;
          }, 1000);
        };
        audioSearchBtn.addEventListener('click', doAudioSearch);
        audioSearchInput.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') doAudioSearch();
        });
      }

      let audioClearing = false;
      const doAudioClear = () => {
        if (audioClearing) return;
        audioClearing = true;
        if (transitionMask) transitionMask.classList.add('visible');
        setTimeout(() => {
          // Reset all items
          document.querySelectorAll('.audio-list-item').forEach(item => {
            item.style.display = '';
          });
          // Restore input + search button, hide clear button
          if (audioSearchInput) { audioSearchInput.value = ''; audioSearchInput.style.display = ''; }
          if (audioSearchBtn) audioSearchBtn.style.display = '';
          if (audioClearBtn) audioClearBtn.style.display = 'none';
          if (audioSearchFooter) audioSearchFooter.style.display = 'none';
          if (transitionMask) transitionMask.classList.remove('visible');
          audioClearing = false;
        }, 1000);
      };

      if (audioClearBtn) audioClearBtn.addEventListener('click', doAudioClear);

      // Generic tools search for all other category pages
      document.querySelectorAll('.content-section').forEach(section => {
        if (section.dataset.category === 'audio') return; // audio has its own logic
        const searchInput = section.querySelector('.tools-search-input');
        const searchBtn = section.querySelector('.tools-search-btn');
        const clearBtn = section.querySelector('.tools-clear-btn');
        if (!searchInput || !searchBtn) return;

        let searching = false;
        const doSearch = () => {
          if (searching) return;
          const query = searchInput.value.trim();
          if (!query) return;
          searching = true;
          if (transitionMask) transitionMask.classList.add('visible');
          setTimeout(() => {
            const query = searchInput.value.trim().toLowerCase();
            section.querySelectorAll('.audio-list-item').forEach(item => {
              const text = item.textContent.toLowerCase();
              item.style.display = text.includes(query) ? '' : 'none';
            });
            searchInput.style.display = 'none';
            searchBtn.style.display = 'none';
            if (clearBtn) clearBtn.style.display = 'block';
            if (transitionMask) transitionMask.classList.remove('visible');
            searching = false;
          }, 1000);
        };
        searchBtn.addEventListener('click', doSearch);
        searchInput.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') doSearch();
        });

        if (clearBtn) {
          clearBtn.addEventListener('click', () => {
            if (searching) return;
            searching = true;
            if (transitionMask) transitionMask.classList.add('visible');
            setTimeout(() => {
              section.querySelectorAll('.audio-list-item').forEach(item => {
                item.style.display = '';
              });
              searchInput.value = '';
              searchInput.style.display = '';
              searchBtn.style.display = '';
              clearBtn.style.display = 'none';
              if (transitionMask) transitionMask.classList.remove('visible');
              searching = false;
            }, 1000);
          });
        }
      });

      const appRoot = document.querySelector('.app');

      function syncHomeV2Background() {
        if (!appRoot?.classList.contains('is-v2-home') || document.body.classList.contains('update-preview-open')) return;
        syncCustomHomeBackground();
      }

      function syncV2HomeShell(category) {
        const isHome = category === 'home';
        appRoot?.classList.toggle('is-v2-home', isHome);
        document.body.classList.toggle('v2-home-active', isHome);
        syncCustomHomeBackground();
        syncHomeV2Background();
      }

      syncV2HomeShell(document.querySelector('.content-section.active')?.dataset.category || 'home');

      function switchCategory(category) {
        if (isSwitching) return;
        isSwitching = true;

        navItems.forEach(item => item.classList.remove('active'));
        const targetNav = document.querySelector(`.nav-item[data-category="${category}"]`);
        if (targetNav) targetNav.classList.add('active');

        contentSections.forEach(section => section.classList.remove('active', 'section-entering'));
        const targetSection = document.querySelector(`.content-section[data-category="${category}"]`);
        if (targetSection) {
          targetSection.classList.add('active');
          mainContent.scrollTop = 0;

          // A short root-level transition keeps navigation responsive while giving every category a shared rhythm.
          void targetSection.offsetWidth;
          targetSection.classList.add('section-entering');
          const clearEnteringState = event => {
            if (event.target !== targetSection || event.animationName !== 'sectionMicroEnter') return;
            targetSection.classList.remove('section-entering');
            targetSection.removeEventListener('animationend', clearEnteringState);
          };
          targetSection.addEventListener('animationend', clearEnteringState);
        }
        syncV2HomeShell(category);
        isSwitching = false;
      }

      function launchToolFromHome(toolId) {
        if (!toolId) return;
        const toolItem = Array.from(document.querySelectorAll('.audio-list-item'))
          .find(item => item.dataset.tool === toolId);
        if (!toolItem || toolItem.dataset.availability === 'planned') return;
        // Invoke the target tool directly. Keeping this event local avoids any
        // category-level click handlers replaying the intermediate page first.
        toolItem.dispatchEvent(new MouseEvent('click', {
          bubbles: false,
          cancelable: true,
          view: window
        }));
      }

      navItems.forEach(item => {
        item.addEventListener('click', () => {
          const category = item.dataset.category;
          if (category && !item.classList.contains('active')) {
            switchCategory(category);
          }
        });
      });

      document.querySelectorAll('[data-home-return]').forEach(button => {
        button.addEventListener('click', () => switchCategory('home'));
      });

      if (isTauri && appWindow && !isScreenPickerWindow) {
        document.querySelectorAll('.ctrl-btn[data-action]').forEach(btn => {
          btn.addEventListener('pointerdown', (e) => e.stopPropagation(), { capture: true });
          btn.addEventListener('mousedown', (e) => e.stopPropagation(), { capture: true });
          btn.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            void handleWindowControlAction(btn.dataset.action);
          });
        });
      }

      const settingsOverlay = document.getElementById('settingsOverlay');
      const settingsBtns = document.querySelectorAll('#settingsBtn, button[id$="V2Settings"]');
      const settingsBack = document.getElementById('settingsBack');
      const settingsContent = settingsOverlay?.querySelector('.settings-content');

      // Language selection in settings
      const langOptionBtns = document.querySelectorAll('.settings-row.lang-options .lang-option');
      function syncLangButtons() {
        const current = getLang();
        langOptionBtns.forEach(btn => {
          btn.classList.toggle('active', btn.dataset.lang === current);
        });
      }
      langOptionBtns.forEach(btn => {
        btn.addEventListener('click', () => {
          if (transitionMask) transitionMask.classList.add('visible');
          setTimeout(() => {
            setLang(btn.dataset.lang);
            setTimeout(() => {
              if (transitionMask) transitionMask.classList.remove('visible');
            }, 300);
          }, 300);
        });
      });
      onLangChange(syncLangButtons);
      syncLangButtons();

      const uiSoundToggle = document.getElementById('uiSoundToggle');
      const uiSoundStyleBtns = document.querySelectorAll('[data-sound-style]');
      const uiSoundPreview = document.getElementById('uiSoundPreview');

      function syncUiSoundControls(state = window.toolknitUiSound?.getState?.() || { enabled: true, style: '1' }) {
        const enabled = state.enabled !== false;
        uiSoundToggle?.classList.toggle('active', enabled);
        uiSoundToggle?.setAttribute('aria-pressed', enabled ? 'true' : 'false');
        uiSoundStyleBtns.forEach(button => {
          const active = String(button.dataset.soundStyle) === String(state.style);
          button.classList.toggle('active', active);
          button.setAttribute('aria-pressed', active ? 'true' : 'false');
        });
        uiSoundPreview?.toggleAttribute('disabled', !enabled);
      }

      uiSoundToggle?.addEventListener('click', () => {
        const current = window.toolknitUiSound?.getState?.() || { enabled: true, style: '1' };
        const next = window.toolknitUiSound?.setEnabled?.(!current.enabled) || { ...current, enabled: !current.enabled };
        syncUiSoundControls(next);
        if (next.enabled) window.toolknitUiSound?.preview?.(next.style);
      });
      uiSoundStyleBtns.forEach(button => {
        button.addEventListener('click', () => {
          const style = String(button.dataset.soundStyle || '1');
          const next = window.toolknitUiSound?.setStyle?.(style) || { enabled: true, style };
          syncUiSoundControls(next);
          if (next.enabled) window.toolknitUiSound?.preview?.(style);
        });
      });
      uiSoundPreview?.addEventListener('click', () => {
        const state = window.toolknitUiSound?.getState?.() || { enabled: true, style: '1' };
        if (!state.enabled) return;
        window.toolknitUiSound?.preview?.(state.style);
      });
      window.addEventListener('toolknit-ui-sound-change', event => syncUiSoundControls(event.detail));
      syncUiSoundControls();

      const windowRadiusOptionBtns = document.querySelectorAll('.settings-radius-option[data-window-radius-mode]');
      const windowRadiusCustomInput = document.getElementById('windowRadiusCustomInput');
      const windowRadiusValue = document.getElementById('windowRadiusValue');
      const windowRadiusCustomWrap = document.getElementById('windowRadiusCustomWrap');
      const windowResizeToggle = document.getElementById('windowResizeToggle');
      let applyingWindowResizeSetting = false;

      function syncWindowResizeControl(enabled = readWindowResizeSetting()) {
        windowResizeToggle?.classList.toggle('active', enabled);
        windowResizeToggle?.setAttribute('aria-pressed', enabled ? 'true' : 'false');
        windowResizeToggle?.toggleAttribute('disabled', applyingWindowResizeSetting);
      }

      function syncWindowRadiusControls(setting = readWindowRadiusSetting()) {
        const radius = applyWindowRadiusSetting(setting);
        windowRadiusOptionBtns.forEach(btn => {
          btn.classList.toggle('active', btn.dataset.windowRadiusMode === setting.mode);
        });
        if (windowRadiusCustomInput) {
          windowRadiusCustomInput.value = String(clampWindowRadius(setting.custom));
          windowRadiusCustomInput.disabled = setting.mode !== 'custom';
        }
        if (windowRadiusValue) windowRadiusValue.textContent = `${radius}px`;
        windowRadiusCustomWrap?.classList.toggle('is-disabled', setting.mode !== 'custom');
      }

      windowRadiusOptionBtns.forEach(btn => {
        btn.addEventListener('click', () => {
          const current = readWindowRadiusSetting();
          const next = saveWindowRadiusSetting({
            mode: btn.dataset.windowRadiusMode || 'none',
            custom: current.custom
          });
          syncWindowRadiusControls(next);
        });
      });

      windowRadiusCustomInput?.addEventListener('input', () => {
        const next = saveWindowRadiusSetting({
          mode: 'custom',
          custom: windowRadiusCustomInput.value
        });
        windowRadiusOptionBtns.forEach(btn => {
          btn.classList.toggle('active', btn.dataset.windowRadiusMode === 'custom');
        });
        if (windowRadiusCustomInput) windowRadiusCustomInput.disabled = false;
        if (windowRadiusValue) windowRadiusValue.textContent = `${windowRadiusPixels(next)}px`;
        windowRadiusCustomWrap?.classList.remove('is-disabled');
      });

      windowRadiusCustomInput?.addEventListener('change', () => {
        syncWindowRadiusControls(readWindowRadiusSetting());
      });

      windowResizeToggle?.addEventListener('click', async () => {
        if (applyingWindowResizeSetting) return;
        const previous = readWindowResizeSetting();
        const next = !previous;
        applyingWindowResizeSetting = true;
        syncWindowResizeControl(previous);
        try {
          const applied = await applyWindowResizeSetting(next);
          saveWindowResizeSetting(applied);
          syncWindowResizeControl(applied);
        } catch (error) {
          console.error('Failed to apply window resize setting:', error);
          syncWindowResizeControl(previous);
          window.showToast?.(getLang() === 'zh' ? '窗口拉伸设置应用失败，请重试。' : 'Failed to apply window resize setting. Please try again.');
        } finally {
          applyingWindowResizeSetting = false;
          syncWindowResizeControl(readWindowResizeSetting());
        }
      });

      syncWindowResizeControl();
      syncWindowRadiusControls();

      // Re-apply translations when language changes externally
      onLangChange(() => {
        applyTranslations();
        syncWindowRadiusControls();
      });

      // Refresh help content on language change
      onLangChange(() => {
        helpSearchCache = null;
        const activeItem = helpNav && helpNav.querySelector('.help-nav-item.active');
        if (activeItem && activeItem.dataset.helpSection) {
          showHelpSection(activeItem.dataset.helpSection);
        }
      });


      async function ensureFfmpegAvailable() {
        if (!isTauri) return false;
        try {
          const { invoke } = await tauriCorePromise;
          return await invoke('check_ffmpeg');
        } catch (e) {
          console.error('FFmpeg check failed:', e);
          return false;
        }
      }

      // Intercept tool entry: check ffmpeg before opening the tool overlay
      async function openToolWithFfmpegCheck(openFn) {
        const ready = await ensureFfmpegAvailable();
        if (ready) { openFn(); return; }
        showDependencyGate({ openFn, needsFfmpeg: true, needsModel: false });
      }

      // Storage path display + open folder
      const storagePathDisplay = document.getElementById('storagePathDisplay');
      const openStorageFolder = document.getElementById('openStorageFolder');
      const chooseStorageFolder = document.getElementById('chooseStorageFolder');
      async function refreshStoragePath() {
        if (!storagePathDisplay) return;
        if (!isTauri) { storagePathDisplay.textContent = '~/Downloads/ToolKnit'; return; }
        try {
          const { invoke } = await tauriCorePromise;
          const customRoot = await invoke('get_output_root');
          if (typeof customRoot === 'string' && customRoot.trim()) {
            localStorage.setItem(OUTPUT_ROOT_KEY, customRoot);
            storagePathDisplay.textContent = displayFilesystemPath(customRoot);
            return;
          }
          localStorage.removeItem(OUTPUT_ROOT_KEY);
          storagePathDisplay.textContent = displayFilesystemPath(await invoke('get_default_output_root'));
        } catch { storagePathDisplay.textContent = '--'; }
      }
      if (storagePathDisplay) {
        void syncConfiguredOutputRoot().then(refreshStoragePath);
      }
      chooseStorageFolder?.addEventListener('click', async () => {
        if (!isTauri) return;
        try {
          const { open } = await import('@tauri-apps/plugin-dialog');
          const selected = await open({ directory: true, multiple: false, title: '选择 ToolKnit 输出位置' });
          if (!selected || Array.isArray(selected)) return;
          const { invoke } = await tauriCorePromise;
          await invoke('set_output_root', { outputDir: selected });
          localStorage.setItem(OUTPUT_ROOT_KEY, selected);
          await refreshStoragePath();
          window.showToast?.(t('settings.storageFolderUpdated'));
        } catch (error) {
          console.error('Choose output folder failed:', error);
          window.showToast?.(t('settings.storageFolderChooseFailed'));
        }
      });
      if (openStorageFolder) {
        openStorageFolder.addEventListener('click', async () => {
          if (!isTauri) return;
          try {
            const { invoke } = await tauriCorePromise;
            const customRoot = await invoke('get_output_root');
            const defaultRoot = await invoke('get_default_output_root');
            await invoke('open_path', { path: customRoot || defaultRoot });
          } catch (e) {
            console.error('Open folder failed:', e);
            window.showToast?.(t('settings.storageFolderOpenFailed'));
          }
        });
      }

      onLangChange(() => {
        void refreshStoragePath();
      });

      // ===== Custom Advanced Dark background =====
      // Keep only lightweight metadata in localStorage. Desktop media is
      // copied into app data by Rust and exposed through the local range
      // server; browser fallback stores a small data URL for development.
      const CUSTOM_BACKGROUND_BROWSER_MAX_BYTES = 8 * 1024 * 1024;
      const settingsBackgroundPreview = document.getElementById('settingsBackgroundPreview');
      const settingsBackgroundSummary = document.getElementById('settingsBackgroundSummary');
      const chooseBackgroundImage = document.getElementById('chooseBackgroundImage');
      const chooseBackgroundVideo = document.getElementById('chooseBackgroundVideo');
      const clearCustomBackground = document.getElementById('clearCustomBackground');
      const customBackgroundImageInput = document.getElementById('customBackgroundImageInput');
      const customBackgroundVideoInput = document.getElementById('customBackgroundVideoInput');
      const settingsBackgroundImportStatus = document.getElementById('settingsBackgroundImportStatus');
      const settingsBackgroundImportTrack = document.getElementById('settingsBackgroundImportTrack');
      const settingsBackgroundImportLabel = document.getElementById('settingsBackgroundImportLabel');
      let customBackgroundRenderToken = 0;
      let customBackgroundPreviewMedia = null;
      let customBackgroundImportBusy = false;

      function readCustomBackgroundMetadata() {
        try {
          const raw = localStorage.getItem(CUSTOM_BACKGROUND_STORAGE_KEY);
          if (!raw) return null;
          const parsed = JSON.parse(raw);
          if (!parsed || !['image', 'video'].includes(String(parsed.type || parsed.media_type))) return null;
          return {
            ...parsed,
            type: parsed.type === 'video' || parsed.media_type === 'video' ? 'video' : 'image'
          };
        } catch {
          return null;
        }
      }

      function saveCustomBackgroundMetadata(metadata) {
        try {
          if (!metadata) localStorage.removeItem(CUSTOM_BACKGROUND_STORAGE_KEY);
          else localStorage.setItem(CUSTOM_BACKGROUND_STORAGE_KEY, JSON.stringify(metadata));
        } catch (error) {
          console.warn('Unable to persist custom background metadata:', error);
        }
      }

      function customBackgroundName(path = '') {
        const value = String(path || '');
        return value.split(/[\\/]/).pop() || '';
      }

      function customBackgroundImportLabel(phase = 'preparing') {
        const labels = {
          validating: 'settings.backgroundImportPreparing',
          prepare: 'settings.backgroundImportPreparing',
          preparing: 'settings.backgroundImportPreparing',
          copying: 'settings.backgroundImportCopying',
          probing: 'settings.backgroundImportAnalyzing',
          analyzing: 'settings.backgroundImportAnalyzing',
          converting: 'settings.backgroundImportTranscoding',
          transcoding: 'settings.backgroundImportTranscoding',
          verify: 'settings.backgroundImportFinalizing',
          finalizing: 'settings.backgroundImportFinalizing',
          complete: 'settings.backgroundImportComplete',
          error: 'settings.backgroundImportFailed',
          failed: 'settings.backgroundImportFailed'
        };
        return t(labels[String(phase || '').toLowerCase()] || 'settings.backgroundImportPreparing');
      }

      function syncCustomBackgroundControls() {
        const hasBackground = Boolean(readCustomBackgroundMetadata());
        if (chooseBackgroundImage) chooseBackgroundImage.disabled = customBackgroundImportBusy;
        if (chooseBackgroundVideo) chooseBackgroundVideo.disabled = customBackgroundImportBusy;
        if (clearCustomBackground) clearCustomBackground.disabled = customBackgroundImportBusy || !hasBackground;
      }

      function setCustomBackgroundImportState(active, { percent = 0, phase = 'preparing' } = {}) {
        customBackgroundImportBusy = Boolean(active);
        const rawPercent = Number(percent) || 0;
        // Rust progress is normalized to 0..1; local browser stages use an
        // already human-facing 0..100 range.
        const normalizedPercent = Math.max(0, Math.min(100, rawPercent <= 1 ? rawPercent * 100 : rawPercent));
        if (settingsBackgroundImportStatus) settingsBackgroundImportStatus.hidden = !customBackgroundImportBusy;
        if (settingsBackgroundImportLabel && customBackgroundImportBusy) {
          settingsBackgroundImportLabel.textContent = customBackgroundImportLabel(phase);
        }
        if (settingsBackgroundImportTrack) {
          settingsBackgroundImportTrack.value = normalizedPercent;
          settingsBackgroundImportTrack.setAttribute('aria-valuenow', String(Math.round(normalizedPercent)));
        }
        syncCustomBackgroundControls();
      }

      function dispatchCustomBackgroundChange(metadata, src = '') {
        window.dispatchEvent(new CustomEvent('toolknit-custom-background-change', {
          detail: metadata ? { ...metadata, src } : null
        }));
      }

      function resetCustomBackgroundPreview() {
        if (!settingsBackgroundPreview) return;
        settingsBackgroundPreview.querySelectorAll('img, video').forEach(media => {
          try { media.pause?.(); } catch {}
          media.removeAttribute('src');
          media.load?.();
          media.remove();
        });
        customBackgroundPreviewMedia = null;
        settingsBackgroundPreview.classList.remove('has-media');
        const copy = settingsBackgroundPreview.querySelector('.settings-v2-background-preview-copy');
        if (copy) copy.hidden = false;
        syncCustomBackgroundControls();
      }

      function syncCustomBackgroundPreviewPlayback() {
        const media = customBackgroundPreviewMedia;
        if (!(media instanceof HTMLVideoElement)) return;
        const shouldPlay = Boolean(settingsOverlay?.classList.contains('visible') && !document.hidden);
        if (shouldPlay) media.play().catch(() => {});
        else media.pause();
      }

      function setCustomBackgroundSummary(metadata = null) {
        if (!settingsBackgroundSummary) return;
        if (!metadata) {
          settingsBackgroundSummary.textContent = t('settings.customBackgroundEmptyHint');
          return;
        }
        const kind = metadata.type === 'video' ? t('settings.chooseBackgroundVideo') : t('settings.chooseBackgroundImage');
        settingsBackgroundSummary.textContent = `${kind} · ${metadata.name || customBackgroundName(metadata.path) || t('settings.customBackground')}`;
      }

      async function renderCustomBackground(metadata) {
        const token = ++customBackgroundRenderToken;
        resetCustomBackgroundPreview();
        if (!metadata) {
          setCustomBackgroundSummary(null);
          dispatchCustomBackgroundChange(null);
          return;
        }
        let src = metadata.src || '';
        try {
          if (!src && isTauri && metadata.path) {
            const { invoke } = await tauriCorePromise;
            src = await invoke('get_custom_background_media_url', { path: metadata.path });
          }
          if (!src) throw new Error('Background source is unavailable');
          if (token !== customBackgroundRenderToken || !settingsBackgroundPreview) return;
          const isVideo = metadata.type === 'video' || metadata.media_type === 'video';
          const media = document.createElement(isVideo ? 'video' : 'img');
          media.src = src;
          media.alt = '';
          media.setAttribute('aria-hidden', 'true');
          if (isVideo) {
            media.muted = true;
            media.loop = true;
            media.autoplay = false;
            media.playsInline = true;
            media.preload = 'metadata';
            media.addEventListener('error', () => window.showToast?.(t('settings.customBackgroundImportFailed')), { once: true });
          } else {
            media.decoding = 'async';
            media.addEventListener('error', () => window.showToast?.(t('settings.customBackgroundImportFailed')), { once: true });
          }
          settingsBackgroundPreview.appendChild(media);
          customBackgroundPreviewMedia = isVideo ? media : null;
          syncCustomBackgroundPreviewPlayback();
          settingsBackgroundPreview.classList.add('has-media');
          const copy = settingsBackgroundPreview.querySelector('.settings-v2-background-preview-copy');
          if (copy) copy.hidden = true;
          setCustomBackgroundSummary(metadata);
          syncCustomBackgroundControls();
          dispatchCustomBackgroundChange(metadata, src);
        } catch (error) {
          console.error('Failed to render custom background:', error);
          setCustomBackgroundSummary(null);
          syncCustomBackgroundControls();
          window.showToast?.(t('settings.customBackgroundImportFailed'));
          dispatchCustomBackgroundChange(null);
        }
      }

      function fileToDataUrl(file) {
        return new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result || ''));
          reader.onerror = () => reject(reader.error || new Error('Unable to read background file'));
          reader.readAsDataURL(file);
        });
      }

      async function importBrowserBackground(file, type) {
        if (!file || customBackgroundImportBusy) return;
        const mime = String(file.type || '').toLowerCase();
        const extension = String(file.name || '').toLowerCase().split('.').pop();
        const allowedExtensions = type === 'video'
          ? ['mp4', 'webm', 'ogv', 'ogg', 'mov']
          : ['png', 'jpg', 'jpeg', 'webp', 'avif', 'gif', 'bmp'];
        const validType = type === 'video' ? mime.startsWith('video/') : mime.startsWith('image/');
        if (!validType && !allowedExtensions.includes(extension)) {
          window.showToast?.(t('settings.customBackgroundImportFailed'));
          return;
        }
        if (file.size > CUSTOM_BACKGROUND_BROWSER_MAX_BYTES) {
          window.showToast?.(t('settings.customBackgroundTooLarge'));
          return;
        }
        setCustomBackgroundImportState(true, { percent: 12, phase: 'preparing' });
        try {
          setCustomBackgroundImportState(true, { percent: 48, phase: 'copying' });
          const src = await fileToDataUrl(file);
          const metadata = { type, media_type: type, name: file.name, mime: file.type, size: file.size, src };
          saveCustomBackgroundMetadata(metadata);
          setCustomBackgroundImportState(true, { percent: 88, phase: 'finalizing' });
          await renderCustomBackground(metadata);
          setCustomBackgroundImportState(true, { percent: 100, phase: 'complete' });
        } catch (error) {
          console.error('Failed to import browser background:', error);
          setCustomBackgroundImportState(true, { percent: 0, phase: 'failed' });
          window.showToast?.(t('settings.customBackgroundImportFailed'));
        } finally {
          window.setTimeout(() => setCustomBackgroundImportState(false), 220);
        }
      }

      async function chooseDesktopBackground(type) {
        if (customBackgroundImportBusy) return;
        let unlistenProgress = null;
        try {
          const { open } = await import('@tauri-apps/plugin-dialog');
          const extensions = type === 'video'
            ? ['mp4', 'webm', 'ogv', 'ogg', 'mov']
            : ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'];
          const selected = await open({
            multiple: false,
            directory: false,
            title: type === 'video' ? t('settings.chooseBackgroundVideo') : t('settings.chooseBackgroundImage'),
            filters: [{ name: type === 'video' ? 'Video' : 'Image', extensions }]
          });
          if (!selected || Array.isArray(selected)) return;
          const jobId = `background-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
          const [{ invoke }, { listen }] = await Promise.all([
            tauriCorePromise,
            tauriEventPromise
          ]);
          setCustomBackgroundImportState(true, {
            percent: type === 'video' ? 6 : 10,
            phase: type === 'video' ? 'analyzing' : 'copying'
          });
          unlistenProgress = await listen('custom-background-import-progress', event => {
            const progress = event?.payload || {};
            const progressJobId = progress.jobId || progress.job_id;
            if (progressJobId && progressJobId !== jobId) return;
            setCustomBackgroundImportState(true, {
              percent: progress.percent,
              phase: progress.phase || 'preparing'
            });
          });
          const asset = await invoke('import_custom_background', { sourcePath: selected, jobId });
          const metadata = {
            type: asset?.media_type === 'video' ? 'video' : type,
            media_type: asset?.media_type || type,
            path: asset?.path || selected,
            name: customBackgroundName(selected)
          };
          saveCustomBackgroundMetadata(metadata);
          await renderCustomBackground(metadata);
          setCustomBackgroundImportState(true, { percent: 100, phase: 'complete' });
        } catch (error) {
          console.error('Failed to import desktop background:', error);
          setCustomBackgroundImportState(true, { percent: 0, phase: 'failed' });
          window.showToast?.(String(error?.message || error) || t('settings.customBackgroundImportFailed'));
        } finally {
          try { unlistenProgress?.(); } catch {}
          if (customBackgroundImportBusy) {
            window.setTimeout(() => setCustomBackgroundImportState(false), 340);
          }
        }
      }

      chooseBackgroundImage?.addEventListener('click', () => {
        if (isTauri) void chooseDesktopBackground('image');
        else customBackgroundImageInput?.click();
      });
      chooseBackgroundVideo?.addEventListener('click', () => {
        if (isTauri) void chooseDesktopBackground('video');
        else customBackgroundVideoInput?.click();
      });
      customBackgroundImageInput?.addEventListener('change', event => {
        void importBrowserBackground(event.target.files?.[0], 'image');
        event.target.value = '';
      });
      customBackgroundVideoInput?.addEventListener('change', event => {
        void importBrowserBackground(event.target.files?.[0], 'video');
        event.target.value = '';
      });
      clearCustomBackground?.addEventListener('click', async () => {
        if (customBackgroundImportBusy) return;
        try {
          if (isTauri) {
            const { invoke } = await tauriCorePromise;
            await invoke('clear_custom_background');
          }
          saveCustomBackgroundMetadata(null);
          await renderCustomBackground(null);
          window.showToast?.(t('settings.customBackgroundCleared'));
        } catch (error) {
          console.error('Failed to clear custom background:', error);
          window.showToast?.(t('settings.customBackgroundImportFailed'));
        }
      });

      void renderCustomBackground(readCustomBackgroundMetadata());
      onLangChange(() => setCustomBackgroundSummary(readCustomBackgroundMetadata()));

      // ===== Local interface font overrides =====
      // The four slots are always loaded as a coherent family pair. This lets
      // a user replace only one slot while all other weights keep their bundled
      // counterparts, without relying on browser-generated faux bold text.
      const CUSTOM_FONT_DEFAULTS = Object.freeze({
        'cn-medium': Object.freeze({ family: 'ToolKnitRuntimeCn', weight: '100 500', path: '/assets/fonts/Alibaba-PuHuiTi-Medium.ttf', name: 'Alibaba PuHuiTi Medium' }),
        'cn-bold': Object.freeze({ family: 'ToolKnitRuntimeCn', weight: '600 900', path: '/assets/fonts/Alibaba-PuHuiTi-Bold.ttf', name: 'Alibaba PuHuiTi Bold' }),
        'en-regular': Object.freeze({ family: 'ToolKnitRuntimeEn', weight: '100 500', path: '/assets/fonts/Fonarto-Regular.otf', name: 'Fonarto Regular' }),
        'en-bold': Object.freeze({ family: 'ToolKnitRuntimeEn', weight: '600 900', path: '/assets/fonts/Fonarto-Bold.otf', name: 'Fonarto Bold' })
      });
      const customFontSlots = [...document.querySelectorAll('[data-font-slot]')];
      const customFontAssets = new Map();
      let customFontMetadataParserPromise = null;
      let activeRuntimeFontFaces = [];
      let customFontBusySlot = '';

      function setInterfaceFontFamilies(useRuntimeFonts) {
        const root = document.documentElement;
        root.style.setProperty('--tk-font-ui-cn', useRuntimeFonts ? "'ToolKnitRuntimeCn'" : "'ToolKnitBuiltinCn'");
        root.style.setProperty('--tk-font-display-cn', useRuntimeFonts ? "'ToolKnitRuntimeCnHeading'" : "'ToolKnitBuiltinCnHeading'");
        root.style.setProperty('--tk-font-ui-en', useRuntimeFonts ? "'ToolKnitRuntimeEn'" : "'ToolKnitBuiltinEn'");
        root.style.setProperty('--tk-font-display-en', useRuntimeFonts
          ? "'ToolKnitRuntimeEnHeading', 'ToolKnitRuntimeCnHeading'"
          : "'ToolKnitBuiltinEnHeading', 'ToolKnitBuiltinCnHeading'");
      }

      function renderCustomFontSlots() {
        customFontSlots.forEach(slotElement => {
          const slot = slotElement.dataset.fontSlot;
          const asset = customFontAssets.get(slot);
          const summary = slotElement.querySelector('[data-font-slot-summary]');
          const upload = slotElement.querySelector('[data-font-upload]');
          const reset = slotElement.querySelector('[data-font-reset]');
          const busy = customFontBusySlot === slot;
          if (summary) summary.textContent = asset?.displayName || asset?.fileName || CUSTOM_FONT_DEFAULTS[slot]?.name || '';
          slotElement.classList.toggle('is-custom', Boolean(asset));
          slotElement.classList.toggle('is-busy', busy);
          if (upload) upload.disabled = Boolean(customFontBusySlot);
          if (reset) reset.disabled = Boolean(customFontBusySlot) || !asset;
        });
      }

      function removeRuntimeFontFaces() {
        activeRuntimeFontFaces.forEach(face => {
          try { document.fonts.delete(face); } catch {}
        });
        activeRuntimeFontFaces = [];
      }

      async function resolveCustomFontSource(asset) {
        if (!asset?.path) return '';
        const { convertFileSrc } = await tauriCorePromise;
        return convertFileSrc(asset.path);
      }

      async function enrichCustomFontAsset(asset, invoke) {
        if (!asset?.path || typeof invoke !== 'function') return asset;
        try {
          if (!customFontMetadataParserPromise) {
            customFontMetadataParserPromise = import('./font-metadata.js').then(module => module.default || module.parseFontMetadata);
          }
          const parseFontMetadata = await customFontMetadataParserPromise;
          if (typeof parseFontMetadata !== 'function') return asset;
          const rawBytes = await invoke('read_file_bytes_limited', {
            path: asset.path,
            maxBytes: 40 * 1024 * 1024
          });
          const metadata = await parseFontMetadata(normalizeDesktopBytes(rawBytes));
          if (!metadata?.displayName) return asset;
          return { ...asset, ...metadata };
        } catch (error) {
          console.warn('Unable to read custom font metadata:', error);
          return asset;
        }
      }

      async function applyCustomInterfaceFonts(fontAssets = customFontAssets) {
        if (!fontAssets.size) {
          removeRuntimeFontFaces();
          setInterfaceFontFamilies(false);
          window.dispatchEvent(new Event('toolknit-interface-font-change'));
          return;
        }
        const loadedFaces = [];
        for (const [slot, defaults] of Object.entries(CUSTOM_FONT_DEFAULTS)) {
          const source = fontAssets.has(slot)
            ? await resolveCustomFontSource(fontAssets.get(slot))
            : defaults.path;
          if (!source) throw new Error('Custom font source is unavailable');
          const face = new FontFace(
            defaults.family,
            `url(${JSON.stringify(source)})`,
            { style: 'normal', weight: defaults.weight, display: 'swap' }
          );
          await face.load();
          loadedFaces.push(face);
        }
        for (const slot of ['cn-bold', 'en-bold']) {
          const defaults = CUSTOM_FONT_DEFAULTS[slot];
          const source = fontAssets.has(slot)
            ? await resolveCustomFontSource(fontAssets.get(slot))
            : defaults.path;
          const face = new FontFace(
            slot === 'cn-bold' ? 'ToolKnitRuntimeCnHeading' : 'ToolKnitRuntimeEnHeading',
            `url(${JSON.stringify(source)})`,
            { style: 'normal', weight: '100 900', display: 'swap' }
          );
          await face.load();
          loadedFaces.push(face);
        }
        removeRuntimeFontFaces();
        loadedFaces.forEach(face => document.fonts.add(face));
        activeRuntimeFontFaces = loadedFaces;
        setInterfaceFontFamilies(true);
        await document.fonts.ready;
        window.dispatchEvent(new Event('toolknit-interface-font-change'));
      }

      async function refreshCustomFonts() {
        if (!isTauri) {
          await applyCustomInterfaceFonts(new Map());
          customFontAssets.clear();
          renderCustomFontSlots();
          return;
        }
        const { invoke } = await tauriCorePromise;
        const assets = await invoke('list_custom_fonts');
        const validAssets = (Array.isArray(assets) ? assets : []).filter(asset => CUSTOM_FONT_DEFAULTS[String(asset?.slot || '')]);
        const enrichedAssets = await Promise.all(validAssets.map(asset => enrichCustomFontAsset(asset, invoke)));
        const nextAssets = new Map();
        enrichedAssets.forEach(asset => {
          const slot = String(asset?.slot || '');
          if (CUSTOM_FONT_DEFAULTS[slot]) nextAssets.set(slot, asset);
        });
        await applyCustomInterfaceFonts(nextAssets);
        customFontAssets.clear();
        nextAssets.forEach((asset, slot) => customFontAssets.set(slot, asset));
        renderCustomFontSlots();
      }

      async function chooseCustomFont(slot) {
        if (!CUSTOM_FONT_DEFAULTS[slot] || customFontBusySlot) return;
        if (!isTauri) {
          window.showToast?.(t('settings.fontDesktopOnly'));
          return;
        }
        customFontBusySlot = slot;
        renderCustomFontSlots();
        try {
          const { open } = await import('@tauri-apps/plugin-dialog');
          const selected = await open({
            multiple: false,
            directory: false,
            title: t('settings.fontUpload'),
            filters: [{ name: 'Font', extensions: ['ttf', 'otf', 'woff', 'woff2'] }]
          });
          if (!selected || Array.isArray(selected)) return;
          const { invoke } = await tauriCorePromise;
          await invoke('import_custom_font', { slot, sourcePath: selected });
          await refreshCustomFonts();
          window.showToast?.(t('settings.fontUploadSuccess'));
        } catch (error) {
          console.error('Unable to apply custom font:', error);
          window.showToast?.(t('settings.fontUploadFailed'));
        } finally {
          customFontBusySlot = '';
          renderCustomFontSlots();
        }
      }

      async function restoreDefaultFont(slot) {
        if (!customFontAssets.has(slot) || customFontBusySlot) return;
        customFontBusySlot = slot;
        renderCustomFontSlots();
        try {
          const { invoke } = await tauriCorePromise;
          await invoke('reset_custom_font', { slot });
          await refreshCustomFonts();
          window.showToast?.(t('settings.fontRestoreSuccess'));
        } catch (error) {
          console.error('Unable to restore default font:', error);
          window.showToast?.(t('settings.fontUploadFailed'));
        } finally {
          customFontBusySlot = '';
          renderCustomFontSlots();
        }
      }

      customFontSlots.forEach(slotElement => {
        const slot = slotElement.dataset.fontSlot;
        slotElement.querySelector('[data-font-upload]')?.addEventListener('click', () => void chooseCustomFont(slot));
        slotElement.querySelector('[data-font-reset]')?.addEventListener('click', () => void restoreDefaultFont(slot));
      });
      void refreshCustomFonts().catch(error => {
        console.error('Unable to initialize custom fonts:', error);
        setInterfaceFontFamilies(false);
        renderCustomFontSlots();
      });
      onLangChange(renderCustomFontSlots);

      // ===== Version update check =====
      const versionUpdateStatus = document.getElementById('versionUpdateStatus');
      const checkVersionUpdateBtn = document.getElementById('checkVersionUpdateBtn');
      const openReleasePageBtn = document.getElementById('openReleasePageBtn');
      const APP_VERSION_FALLBACK = '2.3.1';
      let versionCheckRunning = false;
      let updatePreviewController = null;
      let lastVersionUpdateResult = null;
      let versionUpdateState = { kind: 'neutral', version: APP_VERSION_FALLBACK };
      const updateService = createUpdateService();

      async function getLocalAppVersion() {
        if (!isTauri) return APP_VERSION_FALLBACK;
        try {
          const { getVersion } = await import('@tauri-apps/api/app');
          const version = await getVersion();
          if (version && String(version).trim()) return String(version).trim();
        } catch (error) {
          console.error('Failed to read app version:', error);
        }
        return APP_VERSION_FALLBACK;
      }

      function renderVersionUpdateStatus() {
        if (!versionUpdateStatus) return;
        const { kind, version } = versionUpdateState;
        const text = kind === 'checking'
          ? t('settings.versionChecking')
          : kind === 'available'
            ? t('settings.versionAvailable', { version })
            : kind === 'up-to-date'
              ? t('settings.versionUpToDate', { version })
              : kind === 'error'
                ? t('settings.versionUpdateFailed')
                : t('settings.versionCurrent', { version });
        versionUpdateStatus.textContent = text;
        versionUpdateStatus.dataset.kind = kind;
        if (openReleasePageBtn) openReleasePageBtn.hidden = kind !== 'available';
      }

      function setVersionUpdateState(kind, version = APP_VERSION_FALLBACK) {
        versionUpdateState = { kind, version };
        renderVersionUpdateStatus();
      }

      async function runVersionUpdateCheck({ force = true, showUpdate = true } = {}) {
        if (versionCheckRunning) return;
        versionCheckRunning = true;
        if (checkVersionUpdateBtn) checkVersionUpdateBtn.disabled = true;
        setVersionUpdateState('checking');
        try {
          const localVersion = await getLocalAppVersion();
          const result = await updateService.check({ force });
          lastVersionUpdateResult = result;
          const updateAvailable = compareVersions(result.release.version, localVersion) > 0;
          if (updateAvailable) {
            setVersionUpdateState('available', result.release.version);
            // A manual Settings check deliberately bypasses a previous
            // “Not right now” choice. The choice only suppresses automatic
            // reminders for the same release.
            if (showUpdate) updatePreviewController?.open({ ...result.release, currentVersion: localVersion });
          } else {
            setVersionUpdateState('up-to-date', localVersion);
          }
          return result;
        } catch (error) {
          if (showUpdate) console.error('Version update check failed:', error);
          setVersionUpdateState('error');
          return null;
        } finally {
          versionCheckRunning = false;
          if (checkVersionUpdateBtn) checkVersionUpdateBtn.disabled = false;
        }
      }

      checkVersionUpdateBtn?.addEventListener('click', () => void runVersionUpdateCheck());
      openReleasePageBtn?.addEventListener('click', () => {
        void openExternalUrl(lastVersionUpdateResult?.release?.htmlUrl || UPDATE_RELEASES_PAGE);
      });

      void getLocalAppVersion().then(version => {
        setVersionUpdateState('neutral', version);
      });

      onLangChange(renderVersionUpdateStatus);

      // ===== Screen picker global shortcut =====
      const screenPickerShortcutBtn = document.getElementById('screenPickerShortcutBtn');
      const screenPickerShortcutLabel = document.getElementById('screenPickerShortcutLabel');
      const screenPickerShortcutReset = document.getElementById('screenPickerShortcutReset');
      let screenPickerRecording = false;
      let screenPickerKeyHandler = null;

      async function refreshScreenPickerShortcut() {
        if (!screenPickerShortcutLabel) return;
        if (!isTauri) {
          screenPickerShortcutLabel.textContent = 'Ctrl+Shift+C';
          return;
        }
        try {
          const { invoke } = await tauriCorePromise;
          const info = await invoke('get_screen_picker_shortcut');
          screenPickerShortcutLabel.textContent = info?.value || info?.default || 'Ctrl+Shift+C';
        } catch (error) {
          console.error('Cannot read screen picker shortcut:', error);
          screenPickerShortcutLabel.textContent = 'Ctrl+Shift+C';
        }
      }

      function stopScreenPickerRecording() {
        screenPickerRecording = false;
        if (screenPickerKeyHandler) {
          window.removeEventListener('keydown', screenPickerKeyHandler, true);
          screenPickerKeyHandler = null;
        }
        screenPickerShortcutBtn?.classList.remove('is-recording');
      }

      function screenPickerKeyToken(event) {
        const code = event?.code || '';
        if (/^Key[A-Z]$/.test(code)) return code.slice(3);
        if (/^Digit[0-9]$/.test(code)) return code.slice(5);
        if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code;
        return '';
      }

      function screenPickerShortcutFromEvent(event) {
        const modifiers = [];
        if (event.ctrlKey) modifiers.push('Ctrl');
        if (event.altKey) modifiers.push('Alt');
        if (event.shiftKey) modifiers.push('Shift');
        if (event.metaKey) modifiers.push('Super');
        const key = screenPickerKeyToken(event);
        if (!key || key === 'Escape') return '';
        return [...modifiers, key].join('+');
      }

      screenPickerShortcutBtn?.addEventListener('click', async () => {
        if (!isTauri) {
          showToast(getLang() === 'zh' ? '屏幕取色快捷键仅支持桌面版。' : 'Screen picker shortcut is desktop-only.');
          return;
        }
        if (screenPickerRecording) {
          stopScreenPickerRecording();
          await refreshScreenPickerShortcut();
          return;
        }
        screenPickerRecording = true;
        screenPickerShortcutBtn.classList.add('is-recording');
        screenPickerShortcutLabel.textContent = t('settings.screenPickerShortcutRecording');
        screenPickerKeyHandler = async (event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            stopScreenPickerRecording();
            await refreshScreenPickerShortcut();
            return;
          }
          const next = screenPickerShortcutFromEvent(event);
          if (!next) return;
          event.preventDefault();
          event.stopPropagation();
          stopScreenPickerRecording();
          try {
            const { invoke } = await tauriCorePromise;
            await invoke('set_screen_picker_shortcut', { shortcut: next });
            await refreshScreenPickerShortcut();
            showToast(t('settings.screenPickerShortcutSaved'));
          } catch (error) {
            await refreshScreenPickerShortcut();
            showToast(String(error?.message || error) || t('settings.screenPickerShortcutInvalid'));
          }
        };
        window.addEventListener('keydown', screenPickerKeyHandler, true);
      });

      screenPickerShortcutReset?.addEventListener('click', async () => {
        if (!isTauri) return;
        try {
          const { invoke } = await tauriCorePromise;
          const info = await invoke('get_screen_picker_shortcut');
          await invoke('set_screen_picker_shortcut', { shortcut: info?.default || 'Ctrl+Shift+C' });
          stopScreenPickerRecording();
          await refreshScreenPickerShortcut();
          showToast(t('settings.screenPickerShortcutResetDone'));
        } catch (error) {
          showToast(String(error?.message || error));
        }
      });

      void refreshScreenPickerShortcut();

      // ===== Offline model manager and local transcription =====
      const MODEL_SOURCE_KEY = 'toolknit.transcription-model-source.v1';
      const offlineModelSummary = document.getElementById('offlineModelSummary');
      const manageOfflineModels = document.getElementById('manageOfflineModels');
      const transcriptionModelOverlay = document.getElementById('transcriptionModelOverlay');
      const transcriptionModelClose = document.getElementById('transcriptionModelClose');
      const transcriptionModelList = document.getElementById('transcriptionModelList');
      const transcriptionSourceOptions = document.getElementById('transcriptionSourceOptions');
      const transcriptionOverlay = document.getElementById('transcriptionOverlay');
      const transcriptionBack = document.getElementById('transcriptionBack');
      const transcriptionCta = document.getElementById('transcriptionCta');
      const transcriptionCtaText = document.getElementById('transcriptionCtaText');
      const transcriptionInput = document.getElementById('transcriptionInput');
      const transcriptionFiles = document.getElementById('transcriptionFiles');
      const transcriptionPreview = document.getElementById('transcriptionPreview');
      const transcriptionCopyTextBtn = document.getElementById('transcriptionCopyTextBtn');
      const transcriptionOpenFolderBtn = document.getElementById('transcriptionOpenFolderBtn');
      const transcriptionSelectedFile = document.getElementById('transcriptionSelectedFile');
      const transcriptionSelectedFileName = document.getElementById('transcriptionSelectedFileName');
      const transcriptionProcessBtn = document.getElementById('transcriptionProcessBtn');
      const transcriptionProcessMask = document.getElementById('transcriptionProcessMask');
      const transcriptionProcessText = document.getElementById('transcriptionProcessText');
      const transcriptionProcessBarFill = document.getElementById('transcriptionProcessBarFill');
      const transcriptionLanguageOptions = document.getElementById('transcriptionLanguageOptions');
      const transcriptionRefine = document.getElementById('transcriptionRefine');
      const transcriptionDropZone = document.getElementById('transcriptionDropZone');
      const dependencyGateOverlay = document.getElementById('dependencyGateOverlay');
      const dependencyGateTitle = document.getElementById('dependencyGateTitle');
      const dependencyGateDesc = document.getElementById('dependencyGateDesc');
      const dependencyGateList = document.getElementById('dependencyGateList');
      const dependencyGateProgress = document.getElementById('dependencyGateProgress');
      const dependencyGateProgressFill = document.getElementById('dependencyGateProgressFill');
      const dependencyGateProgressText = document.getElementById('dependencyGateProgressText');
      const dependencyGateError = document.getElementById('dependencyGateError');
      const dependencyGateCancel = document.getElementById('dependencyGateCancel');
      const dependencyGateInstall = document.getElementById('dependencyGateInstall');
      const transcriptionPlasmaBg = document.getElementById('transcriptionPlasmaBg');
      const transcriptionSuccessOverlay = document.getElementById('transcriptionSuccessOverlay');
      const transcriptionSuccessMeta = document.getElementById('transcriptionSuccessMeta');
      const transcriptionSuccessCount = document.getElementById('transcriptionSuccessCount');
      const transcriptionSuccessPath = document.getElementById('transcriptionSuccessPath');
      const transcriptionSuccessOpenFolder = document.getElementById('transcriptionSuccessOpenFolder');
      const transcriptionSuccessOk = document.getElementById('transcriptionSuccessOk');
      let transcriptionModels = [];
      let transcriptionModelProgress = new Map();
      let transcriptionDownloadSource = localStorage.getItem(MODEL_SOURCE_KEY) || 'auto';
      let transcriptionFile = null;
      let transcriptionLanguage = 'auto';
      let transcriptionProcessing = false;
      let transcriptionPlasmaDispose = null;
      let transcriptionOutputDir = '';
      let transcriptionPreviewText = '';
      let dependencyGateState = null;

      function setTranscriptionOutputDir(outputDir = '') {
        transcriptionOutputDir = String(outputDir || '');
        if (transcriptionOpenFolderBtn) transcriptionOpenFolderBtn.disabled = !transcriptionOutputDir;
      }

      function setTranscriptionCopyButtonState(copied = false) {
        if (!transcriptionCopyTextBtn) return;
        const label = transcriptionCopyTextBtn.querySelector('span');
        if (label) label.textContent = copied ? t('home.transcription.copiedText') : t('home.transcription.copyText');
        transcriptionCopyTextBtn.disabled = !transcriptionPreviewText;
      }

      function syncTranscriptionInlineLabels() {
        if (transcriptionFiles) transcriptionFiles.dataset.empty = t('home.transcription.emptyOutputs');
        setTranscriptionCopyButtonState(false);
      }

      function formatTranscriptionBytes(bytes) {
        if (!Number.isFinite(bytes) || bytes < 1) return '--';
        const units = ['B', 'KB', 'MB', 'GB'];
        const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
        return `${(bytes / (1024 ** index)).toFixed(index < 2 ? 0 : 1)} ${units[index]}`;
      }

      function activeTranscriptionModel() {
        return transcriptionModels.find(model => model.current && model.installed) || null;
      }

      function updateOfflineModelSummary() {
        if (!offlineModelSummary) return;
        const current = activeTranscriptionModel();
        offlineModelSummary.textContent = current
          ? t('settings.offlineModelsCurrent', { model: current.display_name })
          : t('settings.offlineModelsEmpty');
      }

      function setTranscriptionProgress(progress, message) {
        if (transcriptionProcessBarFill) transcriptionProcessBarFill.style.width = `${Math.max(0, Math.min(100, progress))}%`;
        if (message && transcriptionProcessText) transcriptionProcessText.textContent = message;
      }

      function renderTranscriptionModels() {
        if (!transcriptionModelList) return;
        transcriptionModelList.replaceChildren();
        transcriptionModels.forEach(model => {
          const row = document.createElement('div');
          row.className = 'transcription-model-row';
          const info = document.createElement('div');
          const name = document.createElement('div');
          name.className = 'transcription-model-name';
          name.textContent = model.display_name;
          const meta = document.createElement('div');
          meta.className = 'transcription-model-meta';
          meta.textContent = `${formatTranscriptionBytes(model.bytes)} ${model.id === 'small' ? `- ${t('home.transcription.recommended')}` : ''}`;
          info.append(name, meta);
          const actions = document.createElement('div');
          actions.className = 'transcription-model-actions';
          const progress = transcriptionModelProgress.get(model.id);
          if (progress && progress.phase !== 'complete') {
            const status = document.createElement('span');
            status.className = 'transcription-model-current';
            status.textContent = progress.phase === 'verifying'
              ? t('home.transcription.verifying')
              : `${Math.min(100, Math.round((progress.downloaded_bytes / Math.max(1, progress.total_bytes)) * 100))}%`;
            actions.append(status);
          } else if (model.installed) {
            if (model.current) {
              const current = document.createElement('span');
              current.className = 'transcription-model-current';
              current.textContent = t('home.transcription.current');
              actions.append(current);
            } else {
              const use = document.createElement('button');
              use.type = 'button'; use.className = 'settings-btn'; use.textContent = t('home.transcription.useModel');
              use.addEventListener('click', async () => {
                const { invoke } = await tauriCorePromise;
                await invoke('set_current_transcription_model', { modelId: model.id });
                await refreshTranscriptionModels();
              });
              actions.append(use);
            }
            const remove = document.createElement('button');
            remove.type = 'button'; remove.className = 'settings-btn'; remove.textContent = t('home.transcription.deleteModel');
            remove.addEventListener('click', async () => {
              const { invoke } = await tauriCorePromise;
              await invoke('delete_transcription_model', { modelId: model.id });
              await refreshTranscriptionModels();
            });
            actions.append(remove);
          } else {
            const install = document.createElement('button');
            install.type = 'button'; install.className = 'settings-btn'; install.textContent = t('home.transcription.downloadModel');
            install.addEventListener('click', async () => {
              try {
                transcriptionModelProgress.set(model.id, { phase: 'downloading', downloaded_bytes: 0, total_bytes: model.bytes });
                renderTranscriptionModels();
                const { invoke } = await tauriCorePromise;
                await invoke('download_transcription_model', { modelId: model.id, source: resolvedModelDownloadSource() });
                transcriptionModelProgress.delete(model.id);
                await refreshTranscriptionModels();
              } catch (error) {
                transcriptionModelProgress.delete(model.id);
                renderTranscriptionModels();
                window.showToast?.(String(error));
              }
            });
            actions.append(install);
          }
          row.append(info, actions);
          if (progress && progress.phase !== 'complete') {
            const bar = document.createElement('div');
            bar.className = 'transcription-model-progress';
            const fill = document.createElement('span');
            fill.style.width = `${Math.min(100, (progress.downloaded_bytes / Math.max(1, progress.total_bytes)) * 100)}%`;
            bar.append(fill); row.append(bar);
          }
          transcriptionModelList.append(row);
        });
        if (window.lucide) window.lucide.createIcons();
      }

      async function refreshTranscriptionModels() {
        if (!isTauri) return;
        try {
          const { invoke } = await tauriCorePromise;
          transcriptionModels = await invoke('list_transcription_models');
          updateOfflineModelSummary();
          renderTranscriptionModels();
        } catch (error) {
          console.error('Cannot read offline transcription models:', error);
        }
      }

      function openTranscriptionModelManager() {
        if (!transcriptionModelOverlay) return;
        transcriptionModelOverlay.classList.add('visible');
        transcriptionModelOverlay.setAttribute('aria-hidden', 'false');
        void refreshTranscriptionModels();
      }

      function closeTranscriptionModelManager() {
        transcriptionModelOverlay?.classList.remove('visible');
        transcriptionModelOverlay?.setAttribute('aria-hidden', 'true');
      }

      manageOfflineModels?.addEventListener('click', openTranscriptionModelManager);
      transcriptionModelClose?.addEventListener('click', closeTranscriptionModelManager);
      transcriptionModelOverlay?.addEventListener('click', event => { if (event.target === transcriptionModelOverlay) closeTranscriptionModelManager(); });
      transcriptionSourceOptions?.querySelectorAll('[data-source]').forEach(button => {
        button.classList.toggle('active', button.dataset.source === transcriptionDownloadSource);
        button.addEventListener('click', () => {
          transcriptionDownloadSource = button.dataset.source || 'auto';
          localStorage.setItem(MODEL_SOURCE_KEY, transcriptionDownloadSource);
          transcriptionSourceOptions.querySelectorAll('[data-source]').forEach(item => item.classList.toggle('active', item === button));
        });
      });
      if (isTauri) {
        void refreshTranscriptionModels();
        (async () => {
          const { listen } = await tauriEventPromise;
          await listen('transcription-model-download-progress', event => {
            const progress = event.payload;
            if (!progress?.model_id) return;
            transcriptionModelProgress.set(progress.model_id, progress);
            renderTranscriptionModels();
            updateDependencyGateProgress('model', progress);
          });
        })().catch(error => console.error('Cannot listen for model download progress:', error));
      }

      // FFmpeg is a separately managed runtime so the desktop installer remains compact.
      const FFMPEG_SOURCE_KEY = 'toolknit.ffmpeg-runtime-source.v1';
      const ffmpegRuntimeSummary = document.getElementById('ffmpegRuntimeSummary');
      const manageFfmpegRuntime = document.getElementById('manageFfmpegRuntime');
      const ffmpegRuntimeOverlay = document.getElementById('ffmpegRuntimeOverlay');
      const ffmpegRuntimeClose = document.getElementById('ffmpegRuntimeClose');
      const ffmpegRuntimeList = document.getElementById('ffmpegRuntimeList');
      const ffmpegRuntimeSourceOptions = document.getElementById('ffmpegRuntimeSourceOptions');
      let ffmpegRuntimeStatus = null;
      let ffmpegRuntimeProgress = null;
      let ffmpegRuntimeSource = localStorage.getItem(FFMPEG_SOURCE_KEY) || 'auto';

      function formatRuntimeBytes(bytes) {
        if (!Number.isFinite(bytes) || bytes < 1) return '--';
        const units = ['B', 'KB', 'MB', 'GB'];
        const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
        return `${(bytes / (1024 ** index)).toFixed(index < 2 ? 0 : 1)} ${units[index]}`;
      }

      function isManagedRuntime(status) {
        return status?.source === 'managed';
      }

      function detectedRuntimeLabel(status) {
        if (!status?.installed) return '';
        if (!isManagedRuntime(status)) return getLang() === 'en' ? 'Detected system dependency' : '已检测到系统依赖';
        const size = formatRuntimeBytes(status.bytes);
        return size === '--'
          ? (getLang() === 'en' ? 'Installed' : '已安装')
          : (getLang() === 'en' ? `Installed (${size})` : `已安装 (${size})`);
      }

      function runtimeMetadata(status) {
        if (!status?.installed) return '';
        return [status.version, displayFilesystemPath(status.path)].filter(Boolean).join(' · ');
      }

      function updateFfmpegRuntimeSummary() {
        if (!ffmpegRuntimeSummary) return;
        ffmpegRuntimeSummary.textContent = ffmpegRuntimeStatus?.installed
          ? detectedRuntimeLabel(ffmpegRuntimeStatus)
          : t('settings.ffmpegRuntimeEmpty');
      }

      function renderFfmpegRuntime() {
        if (!ffmpegRuntimeList) return;
        ffmpegRuntimeList.replaceChildren();
        const row = document.createElement('div'); row.className = 'transcription-model-row';
        const info = document.createElement('div');
        const name = document.createElement('div'); name.className = 'transcription-model-name'; name.textContent = 'FFmpeg';
        const meta = document.createElement('div'); meta.className = 'transcription-model-meta';
        meta.textContent = ffmpegRuntimeStatus?.installed
          ? runtimeMetadata(ffmpegRuntimeStatus)
          : (getLang() === 'en' ? 'Required for audio and video tools' : '音频、视频工具所需的本地运行时');
        info.append(name, meta);
        const actions = document.createElement('div'); actions.className = 'transcription-model-actions';
        if (ffmpegRuntimeProgress && ffmpegRuntimeProgress.phase !== 'complete') {
          const progress = document.createElement('span'); progress.className = 'transcription-model-current';
          const total = Math.max(1, ffmpegRuntimeProgress.total_bytes || 0);
          progress.textContent = ffmpegRuntimeProgress.phase === 'installing'
            ? (getLang() === 'en' ? 'Installing' : '正在安装')
            : `${Math.min(100, Math.round((ffmpegRuntimeProgress.downloaded_bytes || 0) / total * 100))}%`;
          actions.append(progress);
        } else if (ffmpegRuntimeStatus?.installed && isManagedRuntime(ffmpegRuntimeStatus)) {
          const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'settings-btn'; remove.textContent = getLang() === 'en' ? 'Delete' : '删除';
          remove.addEventListener('click', async () => {
            try { const { invoke } = await tauriCorePromise; await invoke('delete_ffmpeg_runtime'); await refreshFfmpegRuntime(); }
            catch (error) { window.showToast?.(String(error?.message || error)); }
          });
          actions.append(remove);
        } else if (ffmpegRuntimeStatus?.installed) {
          const detected = document.createElement('span'); detected.className = 'transcription-model-current'; detected.textContent = detectedRuntimeLabel(ffmpegRuntimeStatus);
          actions.append(detected);
        } else {
          const install = document.createElement('button'); install.type = 'button'; install.className = 'settings-btn'; install.textContent = getLang() === 'en' ? 'Download' : '下载';
          install.addEventListener('click', async () => {
            try {
              ffmpegRuntimeProgress = { phase: 'downloading', downloaded_bytes: 0, total_bytes: 0 }; renderFfmpegRuntime();
              const { invoke } = await tauriCorePromise; await invoke('download_ffmpeg_runtime', { source: resolvedFfmpegDownloadSource() });
              ffmpegRuntimeProgress = null; await refreshFfmpegRuntime();
            } catch (error) { ffmpegRuntimeProgress = null; renderFfmpegRuntime(); window.showToast?.(String(error?.message || error)); }
          });
          actions.append(install);
        }
        row.append(info, actions);
        if (ffmpegRuntimeProgress && ffmpegRuntimeProgress.phase !== 'complete') {
          const bar = document.createElement('div'); bar.className = 'transcription-model-progress';
          const fill = document.createElement('span'); const total = Math.max(1, ffmpegRuntimeProgress.total_bytes || 0);
          fill.style.width = `${Math.min(100, (ffmpegRuntimeProgress.downloaded_bytes || 0) / total * 100)}%`; bar.append(fill); row.append(bar);
        }
        ffmpegRuntimeList.append(row);
      }

      async function refreshFfmpegRuntime() {
        if (!isTauri) return;
        try { const { invoke } = await tauriCorePromise; ffmpegRuntimeStatus = await invoke('get_ffmpeg_runtime_status'); updateFfmpegRuntimeSummary(); renderFfmpegRuntime(); }
        catch (error) { console.error('Cannot read FFmpeg runtime:', error); }
      }
      function openFfmpegRuntimeManager() { if (!ffmpegRuntimeOverlay) return; ffmpegRuntimeOverlay.classList.add('visible'); ffmpegRuntimeOverlay.setAttribute('aria-hidden', 'false'); void refreshFfmpegRuntime(); }
      function closeFfmpegRuntimeManager() { ffmpegRuntimeOverlay?.classList.remove('visible'); ffmpegRuntimeOverlay?.setAttribute('aria-hidden', 'true'); }
      manageFfmpegRuntime?.addEventListener('click', openFfmpegRuntimeManager);
      ffmpegRuntimeClose?.addEventListener('click', closeFfmpegRuntimeManager);
      ffmpegRuntimeOverlay?.addEventListener('click', event => { if (event.target === ffmpegRuntimeOverlay) closeFfmpegRuntimeManager(); });
      ffmpegRuntimeSourceOptions?.querySelectorAll('[data-source]').forEach(button => {
        button.classList.toggle('active', button.dataset.source === ffmpegRuntimeSource);
        button.addEventListener('click', () => { ffmpegRuntimeSource = button.dataset.source || 'auto'; localStorage.setItem(FFMPEG_SOURCE_KEY, ffmpegRuntimeSource); ffmpegRuntimeSourceOptions.querySelectorAll('[data-source]').forEach(item => item.classList.toggle('active', item === button)); });
      });
      if (isTauri) {
        void refreshFfmpegRuntime();
        (async () => { const { listen } = await tauriEventPromise; await listen('ffmpeg-runtime-download-progress', event => { ffmpegRuntimeProgress = event.payload; renderFfmpegRuntime(); updateDependencyGateProgress('ffmpeg', event.payload); }); })().catch(error => console.error('Cannot listen for FFmpeg runtime download:', error));
      }

      // LibreOffice is an optional, separately managed PPT rendering runtime.
      const LIBREOFFICE_SOURCE_KEY = 'toolknit.libreoffice-runtime-source.v1';
      const libreOfficeRuntimeSummary = document.getElementById('libreOfficeRuntimeSummary');
      const manageLibreOfficeRuntime = document.getElementById('manageLibreOfficeRuntime');
      const libreOfficeRuntimeOverlay = document.getElementById('libreOfficeRuntimeOverlay');
      const libreOfficeRuntimeClose = document.getElementById('libreOfficeRuntimeClose');
      const libreOfficeRuntimeList = document.getElementById('libreOfficeRuntimeList');
      const libreOfficeRuntimeSourceOptions = document.getElementById('libreOfficeRuntimeSourceOptions');
      let libreOfficeRuntimeStatus = null;
      let libreOfficeRuntimeProgress = null;
      let libreOfficeRuntimeSource = localStorage.getItem(LIBREOFFICE_SOURCE_KEY) || 'auto';
      // A full status lookup probes soffice and may walk hundreds of files to
      // calculate the managed runtime size. Keep that work out of the PPT
      // page-entry path and share in-flight checks between callers.
      const LIBREOFFICE_AVAILABILITY_TTL = 30_000;
      const LIBREOFFICE_STATUS_TTL = 15_000;
      let libreOfficeRuntimeAvailable = null;
      let libreOfficeRuntimeAvailabilityAt = 0;
      let libreOfficeRuntimeAvailabilityPromise = null;
      let libreOfficeRuntimeStatusAt = 0;
      let libreOfficeRuntimeStatusPromise = null;

      function normalizeLibreOfficeAvailability(value) {
        if (typeof value === 'boolean') return value;
        if (value && typeof value === 'object') {
          if (typeof value.available === 'boolean') return value.available;
          if (typeof value.installed === 'boolean') return value.installed;
        }
        return Boolean(value);
      }

      function cacheLibreOfficeAvailability(available, at = Date.now()) {
        libreOfficeRuntimeAvailable = Boolean(available);
        libreOfficeRuntimeAvailabilityAt = at;
        return libreOfficeRuntimeAvailable;
      }

      async function checkLibreOfficeRuntimeAvailable({ force = false } = {}) {
        if (!isTauri) return false;
        const now = Date.now();
        if (!force && typeof libreOfficeRuntimeAvailable === 'boolean'
          && now - libreOfficeRuntimeAvailabilityAt < LIBREOFFICE_AVAILABILITY_TTL) {
          return libreOfficeRuntimeAvailable;
        }
        if (libreOfficeRuntimeAvailabilityPromise) return libreOfficeRuntimeAvailabilityPromise;
        libreOfficeRuntimeAvailabilityPromise = (async () => {
          const { invoke } = await tauriCorePromise;
          try {
            const available = normalizeLibreOfficeAvailability(await invoke('is_libreoffice_runtime_available'));
            cacheLibreOfficeAvailability(available);
            return available;
          } catch (error) {
            // Older already-installed builds do not expose the lightweight
            // command. Fall back once, then use the same short-lived cache.
            try {
              const status = await invoke('get_libreoffice_runtime_status');
              libreOfficeRuntimeStatus = status;
              libreOfficeRuntimeStatusAt = Date.now();
              updateLibreOfficeRuntimeSummary();
              renderLibreOfficeRuntime();
              return cacheLibreOfficeAvailability(Boolean(status?.installed));
            } catch (fallbackError) {
              console.error('Cannot check PPT runtime availability:', fallbackError || error);
              return cacheLibreOfficeAvailability(false);
            }
          }
        })().finally(() => { libreOfficeRuntimeAvailabilityPromise = null; });
        return libreOfficeRuntimeAvailabilityPromise;
      }

      function updateLibreOfficeRuntimeSummary() {
        if (!libreOfficeRuntimeSummary) return;
        libreOfficeRuntimeSummary.textContent = libreOfficeRuntimeStatus?.installed
          ? detectedRuntimeLabel(libreOfficeRuntimeStatus)
          : t('settings.libreOfficeRuntimeEmpty');
      }

      function renderLibreOfficeRuntime() {
        if (!libreOfficeRuntimeList) return;
        libreOfficeRuntimeList.replaceChildren();
        const row = document.createElement('div'); row.className = 'transcription-model-row';
        const info = document.createElement('div');
        const name = document.createElement('div'); name.className = 'transcription-model-name'; name.textContent = 'LibreOffice';
        const meta = document.createElement('div'); meta.className = 'transcription-model-meta';
        meta.textContent = libreOfficeRuntimeStatus?.installed
          ? runtimeMetadata(libreOfficeRuntimeStatus)
          : (getLang() === 'en' ? 'Required for PPT to PDF and PPT to image' : 'PPT 转 PDF、PPT 转图像所需的本地运行时');
        info.append(name, meta);
        const actions = document.createElement('div'); actions.className = 'transcription-model-actions';
        if (libreOfficeRuntimeProgress && libreOfficeRuntimeProgress.phase !== 'complete') {
          const status = document.createElement('span'); status.className = 'transcription-model-current';
          const total = Math.max(1, libreOfficeRuntimeProgress.total_bytes || 0);
          status.textContent = libreOfficeRuntimeProgress.phase === 'installing'
            ? (getLang() === 'en' ? 'Installing' : '正在安装')
            : `${Math.min(100, Math.round((libreOfficeRuntimeProgress.downloaded_bytes || 0) / total * 100))}%`;
          actions.append(status);
        } else if (libreOfficeRuntimeStatus?.installed && isManagedRuntime(libreOfficeRuntimeStatus)) {
          const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'settings-btn'; remove.textContent = getLang() === 'en' ? 'Delete' : '删除';
          remove.addEventListener('click', async () => {
            try {
              const { invoke } = await tauriCorePromise;
              await invoke('delete_libreoffice_runtime');
              libreOfficeRuntimeStatus = null;
              libreOfficeRuntimeStatusAt = 0;
              libreOfficeRuntimeAvailable = null;
              libreOfficeRuntimeAvailabilityAt = 0;
              await refreshLibreOfficeRuntime({ force: true });
            }
            catch (error) { window.showToast?.(String(error?.message || error)); }
          });
          actions.append(remove);
        } else if (libreOfficeRuntimeStatus?.installed) {
          const detected = document.createElement('span'); detected.className = 'transcription-model-current'; detected.textContent = detectedRuntimeLabel(libreOfficeRuntimeStatus);
          actions.append(detected);
        } else {
          const install = document.createElement('button'); install.type = 'button'; install.className = 'settings-btn'; install.textContent = getLang() === 'en' ? 'Download' : '下载';
          install.addEventListener('click', async () => {
            try {
              libreOfficeRuntimeProgress = { phase: 'downloading', downloaded_bytes: 0, total_bytes: 0 }; renderLibreOfficeRuntime();
              const { invoke } = await tauriCorePromise;
              const status = await invoke('download_libreoffice_runtime', { source: resolvedLibreOfficeDownloadSource() });
              libreOfficeRuntimeProgress = null;
              if (status && typeof status === 'object') {
                libreOfficeRuntimeStatus = status;
                libreOfficeRuntimeStatusAt = Date.now();
                cacheLibreOfficeAvailability(Boolean(status.installed), libreOfficeRuntimeStatusAt);
              } else {
                cacheLibreOfficeAvailability(true);
              }
              updateLibreOfficeRuntimeSummary();
              renderLibreOfficeRuntime();
            } catch (error) { libreOfficeRuntimeProgress = null; renderLibreOfficeRuntime(); window.showToast?.(String(error?.message || error)); }
          });
          actions.append(install);
        }
        row.append(info, actions);
        if (libreOfficeRuntimeProgress && libreOfficeRuntimeProgress.phase !== 'complete') {
          const bar = document.createElement('div'); bar.className = 'transcription-model-progress';
          const fill = document.createElement('span'); const total = Math.max(1, libreOfficeRuntimeProgress.total_bytes || 0);
          fill.style.width = `${Math.min(100, (libreOfficeRuntimeProgress.downloaded_bytes || 0) / total * 100)}%`; bar.append(fill); row.append(bar);
        }
        libreOfficeRuntimeList.append(row);
      }

      async function refreshLibreOfficeRuntime({ force = false } = {}) {
        if (!isTauri) return null;
        const now = Date.now();
        if (!force && libreOfficeRuntimeStatus && now - libreOfficeRuntimeStatusAt < LIBREOFFICE_STATUS_TTL) {
          updateLibreOfficeRuntimeSummary();
          renderLibreOfficeRuntime();
          return libreOfficeRuntimeStatus;
        }
        if (libreOfficeRuntimeStatusPromise) return libreOfficeRuntimeStatusPromise;
        libreOfficeRuntimeStatusPromise = (async () => {
          try {
            const { invoke } = await tauriCorePromise;
            const status = await invoke('get_libreoffice_runtime_status');
            libreOfficeRuntimeStatus = status;
            libreOfficeRuntimeStatusAt = Date.now();
            cacheLibreOfficeAvailability(Boolean(status?.installed), libreOfficeRuntimeStatusAt);
            updateLibreOfficeRuntimeSummary();
            renderLibreOfficeRuntime();
            return status;
          } catch (error) {
            console.error('Cannot read PPT runtime:', error);
            return null;
          }
        })().finally(() => { libreOfficeRuntimeStatusPromise = null; });
        return libreOfficeRuntimeStatusPromise;
      }
      function openLibreOfficeRuntimeManager() { if (!libreOfficeRuntimeOverlay) return; libreOfficeRuntimeOverlay.classList.add('visible'); libreOfficeRuntimeOverlay.setAttribute('aria-hidden', 'false'); void refreshLibreOfficeRuntime({ force: true }); }
      function closeLibreOfficeRuntimeManager() { libreOfficeRuntimeOverlay?.classList.remove('visible'); libreOfficeRuntimeOverlay?.setAttribute('aria-hidden', 'true'); }
      manageLibreOfficeRuntime?.addEventListener('click', openLibreOfficeRuntimeManager);
      libreOfficeRuntimeClose?.addEventListener('click', closeLibreOfficeRuntimeManager);
      libreOfficeRuntimeOverlay?.addEventListener('click', event => { if (event.target === libreOfficeRuntimeOverlay) closeLibreOfficeRuntimeManager(); });
      libreOfficeRuntimeSourceOptions?.querySelectorAll('[data-source]').forEach(button => {
        button.classList.toggle('active', button.dataset.source === libreOfficeRuntimeSource);
        button.addEventListener('click', () => { libreOfficeRuntimeSource = button.dataset.source || 'auto'; localStorage.setItem(LIBREOFFICE_SOURCE_KEY, libreOfficeRuntimeSource); libreOfficeRuntimeSourceOptions.querySelectorAll('[data-source]').forEach(item => item.classList.toggle('active', item === button)); });
      });
      if (isTauri) {
        // The settings panel performs the detailed refresh on demand. Do not
        // start a recursive runtime-directory scan during app bootstrap.
        (async () => { const { listen } = await tauriEventPromise; await listen('libreoffice-runtime-download-progress', event => { libreOfficeRuntimeProgress = event.payload; renderLibreOfficeRuntime(); updateDependencyGateProgress('libreoffice', event.payload); }); })().catch(error => console.error('Cannot listen for PPT runtime download:', error));
      }

      function resolvedLibreOfficeDownloadSource() {
        if (libreOfficeRuntimeSource !== 'auto') return libreOfficeRuntimeSource;
        return getLang() === 'en' ? 'auto-official' : 'auto-china';
      }

      async function ensurePptRuntimeAvailable() {
        if (!isTauri) return false;
        // Export is the last user-visible gate, so refresh the cheap boolean
        // check in case the runtime was removed outside ToolKnit meanwhile.
        if (await checkLibreOfficeRuntimeAvailable({ force: true })) return true;
        showDependencyGate({ openFn: () => {}, needsFfmpeg: false, needsModel: false, needsLibreOffice: true });
        throw new Error('ppt-render:runtime-missing');
      }

      function resolvedFfmpegDownloadSource() {
        if (ffmpegRuntimeSource !== 'auto') return ffmpegRuntimeSource;
        return getLang() === 'en' ? 'auto-official' : 'auto-china';
      }

      function resolvedModelDownloadSource() {
        if (transcriptionDownloadSource !== 'auto') return transcriptionDownloadSource;
        return getLang() === 'en' ? 'official' : 'china';
      }

      function dependencyProgressPercent(progress) {
        if (!progress) return 0;
        if (['installing', 'verifying', 'complete'].includes(progress.phase)) return 100;
        return Math.max(0, Math.min(100, Math.round((Number(progress.downloaded_bytes) || 0) / Math.max(1, Number(progress.total_bytes) || 0) * 100)));
      }

      function dependencyStatusText(type, progress, complete) {
        if (complete || progress?.phase === 'complete') return t('home.dependencies.ready');
        if (!progress) return t('home.dependencies.waiting');
        if (progress.phase === 'installing') return t('home.dependencies.installing');
        if (progress.phase === 'verifying') return t('home.dependencies.verifying');
        const percent = dependencyProgressPercent(progress);
        return `${t('home.dependencies.downloading')} ${percent}%`;
      }

      function renderDependencyGate() {
        const state = dependencyGateState;
        if (!state || !dependencyGateList) return;
        if (dependencyGateOverlay && state.taskSnapshot) {
          dependencyGateOverlay.dataset.taskState = state.taskSnapshot.state;
          dependencyGateOverlay.dataset.taskId = state.taskSnapshot.task_id;
        }
        const isMatting = state.modelKind === 'matting';
        const isTranscription = state.needsModel && !isMatting;
        const isPpt = state.needsLibreOffice;
        if (dependencyGateTitle) dependencyGateTitle.textContent = t(isMatting ? 'home.dependencies.mattingTitle' : (isTranscription ? 'home.dependencies.transcriptionTitle' : (isPpt ? 'home.dependencies.pptTitle' : 'home.dependencies.title')));
        if (dependencyGateDesc) dependencyGateDesc.textContent = t(isMatting ? 'home.dependencies.mattingDesc' : (isTranscription ? 'home.dependencies.transcriptionDesc' : (isPpt ? 'home.dependencies.pptDesc' : 'home.dependencies.desc')));
        dependencyGateList.replaceChildren();
        const appendItem = (type, label, size, progress, complete) => {
          const row = document.createElement('div');
          row.className = 'audio-convert-success-row dependency-gate-row';
          const key = document.createElement('span'); key.className = 'audio-convert-success-key'; key.textContent = `${label} · ${size}`;
          const value = document.createElement('span'); value.className = 'audio-convert-success-value'; value.textContent = dependencyStatusText(type, progress, complete);
          value.dataset.state = complete || progress?.phase === 'complete' ? 'ready' : (progress ? 'active' : 'waiting');
          row.append(key, value); dependencyGateList.append(row);
        };
        if (state.needsFfmpeg) appendItem('ffmpeg', 'FFmpeg', '29 MB', state.ffmpegProgress, state.ffmpegComplete);
        if (state.needsModel) appendItem('model', state.modelLabel || 'Whisper Small', state.modelSizeText || '465 MB', state.modelProgress, state.modelComplete);
        if (state.needsLibreOffice) appendItem('libreoffice', 'LibreOffice', '356 MB', state.libreOfficeProgress, state.libreOfficeComplete);

        const types = [state.needsFfmpeg && 'ffmpeg', state.needsModel && 'model', state.needsLibreOffice && 'libreoffice'].filter(Boolean);
        const overall = types.length
          ? Math.round(types.reduce((sum, type) => sum + (state[`${type}Complete`] ? 100 : dependencyProgressPercent(state[`${type}Progress`])), 0) / types.length)
          : 100;
        const currentProgress = state.current === 'model'
          ? state.modelProgress
          : (state.current === 'libreoffice' ? state.libreOfficeProgress : state.ffmpegProgress);
        const currentPhase = currentProgress?.phase || '';
        const isPostDownload = currentPhase === 'installing' || currentPhase === 'verifying';
        if (dependencyGateProgress) dependencyGateProgress.hidden = !state.downloading;
        if (dependencyGateProgress) dependencyGateProgress.dataset.indeterminate = isPostDownload ? 'true' : 'false';
        if (dependencyGateProgressFill) dependencyGateProgressFill.style.width = isPostDownload ? '34%' : `${overall}%`;
        if (dependencyGateProgressText) {
          const currentName = state.current === 'model' ? (state.modelLabel || 'Whisper Small') : (state.current === 'libreoffice' ? 'LibreOffice' : 'FFmpeg');
          dependencyGateProgressText.textContent = state.cancelling
            ? t('home.dependencies.cancelling')
            : (currentPhase === 'installing'
              ? t('home.dependencies.installingDetail', { name: currentName })
              : (currentPhase === 'verifying'
                ? t('home.dependencies.verifyingDetail', { name: currentName })
                : `${t('home.dependencies.current')}${currentName} · ${overall}%`));
        }
        if (dependencyGateError) {
          dependencyGateError.hidden = !state.error;
          dependencyGateError.textContent = state.error || '';
        }
        if (dependencyGateCancel) dependencyGateCancel.textContent = state.cancelling ? t('home.dependencies.cancelling') : t('home.dependencies.cancel');
        if (dependencyGateInstall) {
          dependencyGateInstall.textContent = state.downloading ? t('home.dependencies.downloadingAll') : t('home.dependencies.installAll');
          dependencyGateInstall.disabled = state.downloading;
        }
      }

      function updateDependencyGateProgress(type, progress) {
        const state = dependencyGateState;
        if (!state || !state.downloading || !state[`needs${type === 'ffmpeg' ? 'Ffmpeg' : (type === 'model' ? 'Model' : 'LibreOffice')}`]) return;
        state[`${type}Progress`] = progress || null;
        if (progress?.phase === 'complete') state[`${type}Complete`] = true;
        renderDependencyGate();
      }

      function showDependencyGate({ openFn, needsFfmpeg, needsModel, needsLibreOffice, modelKind, modelLabel, modelSizeText }) {
        dependencyGateState = {
          openFn,
          needsFfmpeg: Boolean(needsFfmpeg),
          needsModel: Boolean(needsModel),
          needsLibreOffice: Boolean(needsLibreOffice),
          modelKind: modelKind === 'matting' ? 'matting' : 'transcription',
          modelLabel: modelLabel || 'Whisper Small',
          modelSizeText: modelSizeText || '465 MB',
          ffmpegProgress: null,
          modelProgress: null,
          libreOfficeProgress: null,
          ffmpegComplete: !needsFfmpeg,
          modelComplete: !needsModel,
          libreOfficeComplete: !needsLibreOffice,
          current: needsFfmpeg ? 'ffmpeg' : (needsModel ? 'model' : 'libreoffice'),
          downloading: false,
          cancelling: false,
          cancelled: false,
          error: '',
          runner: null,
          taskSnapshot: null
        };
        renderDependencyGate();
        dependencyGateOverlay?.classList.add('visible');
        dependencyGateOverlay?.setAttribute('aria-hidden', 'false');
        if (window.lucide) window.lucide.createIcons();
      }

      function closeDependencyGate(force = false) {
        if (dependencyGateState?.downloading && !force) return;
        dependencyGateOverlay?.classList.remove('visible');
        dependencyGateOverlay?.setAttribute('aria-hidden', 'true');
        dependencyGateState = null;
      }

      async function installDependencyGateRequirements() {
        const state = dependencyGateState;
        if (!state || state.downloading || !isTauri) return;
        state.downloading = true;
        state.error = '';
        renderDependencyGate();
        const runner = new TaskRunner({
          tool: 'dependencies.install',
          onEvent(event) {
            if (dependencyGateState !== state) return;
            state.taskSnapshot = event;
            renderDependencyGate();
          },
          onCancel: async () => {
            try {
              const { invoke } = await tauriCorePromise;
              await invoke('cancel_dependency_downloads');
            } catch (error) {
              console.error('Cannot cancel dependency download:', error);
            }
          }
        });
        state.runner = runner;
        try {
          const { invoke } = await tauriCorePromise;
          await runner.run(async ({ report, throwIfCancelled }) => {
            report(0, t('home.dependencies.downloadingAll'), { phase: 'prepare' });
            if (state.needsFfmpeg) {
              state.current = 'ffmpeg'; renderDependencyGate();
              report(8, 'FFmpeg', { phase: 'ffmpeg' });
              if (!await ensureFfmpegAvailable()) await invoke('download_ffmpeg_runtime', { source: resolvedFfmpegDownloadSource() });
              throwIfCancelled();
              state.ffmpegComplete = true; state.ffmpegProgress = { phase: 'complete', downloaded_bytes: 1, total_bytes: 1 };
              ffmpegRuntimeProgress = null;
              await refreshFfmpegRuntime();
              report(state.needsModel ? 50 : 96, 'FFmpeg', { phase: 'ffmpeg-complete' });
            }
            if (state.needsModel) {
              state.current = 'model'; renderDependencyGate();
              if (state.modelKind === 'matting') {
                report(8, state.modelLabel, { phase: 'model' });
                const unlistenMatting = await tauriEventPromise.then(({ listen }) => listen('matting-model-progress', event => {
                  state.modelProgress = event?.payload || null;
                  renderDependencyGate();
                }));
                try {
                  throwIfCancelled();
                  await installMattingModel(mattingDownloadSource);
                  throwIfCancelled();
                } finally {
                  try { unlistenMatting(); } catch {}
                }
                state.modelComplete = true;
                state.modelProgress = { phase: 'complete', downloaded_bytes: 1, total_bytes: 1 };
                renderDependencyGate();
                report(96, state.modelLabel, { phase: 'model-complete' });
              } else {
              report(state.needsFfmpeg ? 52 : 8, 'Whisper Small', { phase: 'model' });
              await refreshTranscriptionModels();
              if (!activeTranscriptionModel()) {
                const small = transcriptionModels.find(model => model.id === 'small');
                state.modelProgress = { phase: 'downloading', downloaded_bytes: 0, total_bytes: small?.bytes || 487_601_967 };
                renderDependencyGate();
                await invoke('download_transcription_model', { modelId: 'small', source: resolvedModelDownloadSource() });
                await invoke('set_current_transcription_model', { modelId: 'small' });
              }
              throwIfCancelled();
              state.modelComplete = true; state.modelProgress = { phase: 'complete', downloaded_bytes: 1, total_bytes: 1 };
              transcriptionModelProgress.delete('small');
              await refreshTranscriptionModels();
              report(96, 'Whisper Small', { phase: 'model-complete' });
              }
            }
            if (state.needsLibreOffice) {
              state.current = 'libreoffice'; renderDependencyGate();
              report(state.needsFfmpeg || state.needsModel ? 97 : 8, 'LibreOffice', { phase: 'libreoffice' });
              const available = await checkLibreOfficeRuntimeAvailable({ force: true });
              if (!available) {
                const pptRuntime = await invoke('download_libreoffice_runtime', { source: resolvedLibreOfficeDownloadSource() });
                if (pptRuntime && typeof pptRuntime === 'object') {
                  libreOfficeRuntimeStatus = pptRuntime;
                  libreOfficeRuntimeStatusAt = Date.now();
                  cacheLibreOfficeAvailability(Boolean(pptRuntime.installed), libreOfficeRuntimeStatusAt);
                } else {
                  cacheLibreOfficeAvailability(true);
                }
              }
              throwIfCancelled();
              state.libreOfficeComplete = true;
              state.libreOfficeProgress = { phase: 'complete', downloaded_bytes: 1, total_bytes: 1 };
              libreOfficeRuntimeProgress = null;
              updateLibreOfficeRuntimeSummary();
              renderLibreOfficeRuntime();
              report(96, 'LibreOffice', { phase: 'libreoffice-complete' });
            }
            return true;
          });
          const openFn = state.openFn;
          state.downloading = false;
          renderDependencyGate();
          closeDependencyGate(true);
          await openFn?.();
        } catch (error) {
          const message = String(error?.message || error || '');
          ffmpegRuntimeProgress = null;
          transcriptionModelProgress.delete('small');
          if (state.cancelled || error?.code === 'CANCELLED' || message.includes('dependency-download:cancelled')) {
            state.downloading = false;
            closeDependencyGate(true);
            return;
          }
          state.downloading = false;
          state.cancelling = false;
          state.error = `${t('home.dependencies.failed')} ${message}`.trim();
          renderFfmpegRuntime();
          renderTranscriptionModels();
          renderLibreOfficeRuntime();
          renderDependencyGate();
        }
      }

      dependencyGateInstall?.addEventListener('click', () => { void installDependencyGateRequirements(); });
      dependencyGateCancel?.addEventListener('click', async () => {
        const state = dependencyGateState;
        if (!state) return;
        if (!state.downloading) { closeDependencyGate(); return; }
        state.cancelled = true;
        state.cancelling = true;
        renderDependencyGate();
        await state.runner?.cancel(t('home.dependencies.cancelling'));
      });

      function updateTranscriptionUploadState() {
        const hasFile = Boolean(transcriptionFile?.name);
        const ctaLabel = hasFile ? t('home.transcription.reupload') : t('home.transcription.cta');
        if (transcriptionCtaText) transcriptionCtaText.textContent = ctaLabel;
        if (transcriptionCta) transcriptionCta.setAttribute('aria-label', ctaLabel);
        if (transcriptionSelectedFile) transcriptionSelectedFile.hidden = !hasFile;
        if (transcriptionSelectedFileName) {
          transcriptionSelectedFileName.textContent = hasFile ? transcriptionFile.name : '';
          transcriptionSelectedFileName.title = hasFile ? transcriptionFile.name : '';
        }
      }

      function renderTranscriptionFile() {
        transcriptionOverlay?.classList.remove('has-result');
        if (transcriptionFiles) {
          transcriptionFiles.replaceChildren();
          transcriptionFiles.classList.remove('has-files');
        }
        setTranscriptionOutputDir('');
        renderTranscriptionPreviewEmpty();
        updateTranscriptionUploadState();
      }

      function renderTranscriptionPreviewEmpty() {
        transcriptionPreviewText = '';
        setTranscriptionCopyButtonState(false);
        if (!transcriptionPreview) return;
        transcriptionPreview.classList.add('is-empty');
        transcriptionPreview.replaceChildren();
        const empty = document.createElement('div');
        empty.className = 'transcription-v2-preview-empty';
        empty.innerHTML = `
          <i data-lucide="subtitles"></i>
          <strong>${escapeHtml(t('home.transcription.previewEmptyTitle'))}</strong>
          <span>${escapeHtml(t('home.transcription.previewEmptyDesc'))}</span>
        `;
        transcriptionPreview.append(empty);
        createIcons?.({ icons });
      }

      function updateTranscriptionProcessButton() {
        if (!transcriptionProcessBtn) return;
        transcriptionProcessBtn.style.display = transcriptionFile ? '' : 'none';
        transcriptionProcessBtn.classList.toggle('visible', Boolean(transcriptionFile));
        transcriptionProcessBtn.disabled = transcriptionProcessing;
      }

      function addTranscriptionFile(file) {
        if (!file || transcriptionProcessing) return;
        transcriptionFile = file;
        renderTranscriptionFile();
        updateTranscriptionProcessButton();
      }

      function showTranscriptionTool() {
        transcriptionOverlay?.classList.add('visible');
        if (transcriptionPlasmaBg && !transcriptionPlasmaDispose) transcriptionPlasmaDispose = initStandardToolPlasma(transcriptionPlasmaBg);
      }

      async function openTranscriptionTool() {
        if (!isTauri) { window.showToast?.(t('home.transcription.desktopOnly')); return; }
        const { invoke } = await tauriCorePromise;
        const [engineReady, ffmpegReady] = await Promise.all([invoke('check_transcription_engine'), ensureFfmpegAvailable()]);
        if (!engineReady) { window.showToast?.(t('home.transcription.engineUnavailable')); return; }
        await refreshTranscriptionModels();
        const modelReady = Boolean(activeTranscriptionModel());
        if (!ffmpegReady || !modelReady) {
          showDependencyGate({ openFn: showTranscriptionTool, needsFfmpeg: !ffmpegReady, needsModel: !modelReady });
          return;
        }
        showTranscriptionTool();
      }

      function closeTranscriptionTool() {
        if (transcriptionProcessing) return;
        transcriptionOverlay?.classList.remove('visible');
        transcriptionFile = null;
        renderTranscriptionFile();
        updateTranscriptionProcessButton();
        if (transcriptionPlasmaDispose) { transcriptionPlasmaDispose(); transcriptionPlasmaDispose = null; }
      }

      transcriptionBack?.addEventListener('click', closeTranscriptionTool);
      transcriptionCta?.addEventListener('click', async () => {
        if (isTauri) {
          const { open } = await import('@tauri-apps/plugin-dialog');
          const selected = await open({ multiple: false, filters: [{ name: 'Audio and video', extensions: ['mp3', 'aac', 'm4a', 'wav', 'flac', 'alac', 'ogg', 'wma', 'mp4', 'mkv', 'avi', 'mov', 'webm', 'flv', 'wmv', 'ts'] }] });
          if (typeof selected === 'string') addTranscriptionFile({ path: selected, name: selected.split(/[\\/]/).pop() || selected });
        } else transcriptionInput?.click();
      });
      transcriptionInput?.addEventListener('change', () => { const file = transcriptionInput.files?.[0]; if (file) addTranscriptionFile(file); transcriptionInput.value = ''; });
      transcriptionLanguageOptions?.querySelectorAll('[data-language]').forEach(button => button.addEventListener('click', () => {
        transcriptionLanguage = button.dataset.language || 'auto';
        transcriptionLanguageOptions.querySelectorAll('[data-language]').forEach(item => item.classList.toggle('active', item === button));
      }));
      updateTranscriptionUploadState();
      syncTranscriptionInlineLabels();
      document.querySelectorAll('.audio-list-item[data-tool="transcription"]').forEach(item => {
        item.addEventListener('click', () => { void openTranscriptionTool(); });
        item.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); void openTranscriptionTool(); } });
      });

      if (isTauri && transcriptionOverlay) {
        (async () => {
          const { getCurrentWebview } = await import('@tauri-apps/api/webview');
          const webview = getCurrentWebview();
          await webview.onDragDropEvent(event => {
            if (!transcriptionOverlay.classList.contains('visible') || transcriptionProcessing) return;
            const payload = event.payload;
            if (payload.type === 'enter' || payload.type === 'over') transcriptionDropZone?.classList.add('visible');
            else if (payload.type === 'leave') transcriptionDropZone?.classList.remove('visible');
            else if (payload.type === 'drop') {
              transcriptionDropZone?.classList.remove('visible');
              const path = payload.paths?.[0];
              if (path) addTranscriptionFile({ path, name: path.split(/[\\/]/).pop() || path });
            }
          });
        })().catch(error => console.error('Cannot register transcription drag and drop:', error));
      }

      function transcriptionProgressLabel(phase) {
        const labels = {
          preparing: 'home.transcription.preparing',
          transcribing: 'home.transcription.transcribing',
          publishing: 'home.transcription.publishing',
          refining: 'home.transcription.refining',
          complete: 'home.transcription.complete'
        };
        return t(labels[phase] || 'home.transcription.preparing');
      }

      async function readTranscriptionText(path) {
        const { invoke } = await tauriCorePromise;
        const bytes = await invoke('read_file_bytes_limited', { path, maxBytes: 10 * 1024 * 1024 });
        return new TextDecoder('utf-8').decode(Uint8Array.from(bytes));
      }

      function parseTranscriptionSrt(value) {
        return String(value || '').replace(/^\uFEFF/, '').trim().split(/\r?\n\s*\r?\n/).map(block => {
          const lines = block.split(/\r?\n/).map(line => line.trimEnd()).filter(line => line.trim());
          if (!lines.length) return null;
          let id = Number(lines[0]);
          let timingIndex = 1;
          if (!Number.isInteger(id)) {
            id = 0;
            timingIndex = 0;
          }
          const timing = lines[timingIndex] || '';
          const match = /^(.+?)\s+-->\s+(.+?)(?:\s+.*)?$/.exec(timing.trim());
          const textLines = lines.slice(timingIndex + 1);
          if (!match || textLines.length === 0) return null;
          return { id, start: match[1], end: match[2], text: textLines.join('\n').trim() };
        }).filter(Boolean);
      }

      function renderTranscriptionPreview(segments, textValue = '') {
        const normalizedText = String(textValue || '').trim();
        transcriptionPreviewText = normalizedText || segments.map(segment => segment.text.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n');
        setTranscriptionCopyButtonState(false);
        if (!transcriptionPreview) return;
        transcriptionPreview.replaceChildren();
        transcriptionPreview.classList.remove('is-empty');
        if (!segments.length && !transcriptionPreviewText) {
          renderTranscriptionPreviewEmpty();
          return;
        }
        if (segments.length) {
          const fragment = document.createDocumentFragment();
          segments.slice(0, 500).forEach(segment => {
            const row = document.createElement('div');
            row.className = 'transcription-v2-segment';
            row.innerHTML = `
              <span class="transcription-v2-segment-time">${escapeHtml(segment.start)} → ${escapeHtml(segment.end)}</span>
              <p>${escapeHtml(segment.text)}</p>
            `;
            fragment.append(row);
          });
          if (segments.length > 500) {
            const more = document.createElement('div');
            more.className = 'transcription-v2-preview-more';
            more.textContent = t('home.transcription.previewLimit', { count: 500 });
            fragment.append(more);
          }
          transcriptionPreview.append(fragment);
          return;
        }
        const textBlock = document.createElement('div');
        textBlock.className = 'transcription-v2-text-preview';
        textBlock.textContent = transcriptionPreviewText;
        transcriptionPreview.append(textBlock);
      }

      function parseRefinedTranscriptionResponse(value, expectedIds) {
        const source = String(value || '').replace(/```(?:json)?/gi, '').replace(/```/g, '').trim();
        const start = source.indexOf('{');
        const json = start >= 0 ? extractBalancedJson(source, start) : null;
        const parsed = JSON.parse(json || source);
        if (!Array.isArray(parsed?.segments) || parsed.segments.length !== expectedIds.length) throw new Error('Invalid refinement response');
        const updated = new Map();
        for (const segment of parsed.segments) {
          const id = Number(segment?.id);
          const text = typeof segment?.text === 'string' ? segment.text.trim() : '';
          if (!expectedIds.has(id) || updated.has(id) || !text || text.length > 1200) throw new Error('Invalid refinement response');
          updated.set(id, text);
        }
        if (updated.size !== expectedIds.size) throw new Error('Invalid refinement response');
        return updated;
      }

      async function refineTranscriptionSegments(segments) {
        const updated = new Map();
        const chunkSize = 42;
        for (let offset = 0; offset < segments.length; offset += chunkSize) {
          const chunk = segments.slice(offset, offset + chunkSize);
          const payload = chunk.map(({ id, text }) => ({ id, text }));
          const response = await callDeepSeek([
            {
              role: 'system',
              content: 'You proofread speech-recognition subtitles. Return JSON only: {"segments":[{"id":number,"text":string}]}. Keep exactly the supplied IDs, one item per ID, in the same order. Do not add, remove, merge, or split segments. Do not invent names, numbers, facts, or missing speech. Correct punctuation, obvious grammar, and clearly contextual recognition errors only. Preserve the language of each segment.'
            },
            { role: 'user', content: JSON.stringify({ segments: payload }) }
          ], undefined, 4000);
          const edits = parseRefinedTranscriptionResponse(response, new Set(chunk.map(segment => segment.id)));
          edits.forEach((text, id) => updated.set(id, text));
        }
        return updated;
      }

      async function writeRefinedTranscription(result) {
        const rawSrt = await readTranscriptionText(result.raw_srt_path);
        const segments = parseTranscriptionSrt(rawSrt);
        if (segments.length === 0) throw new Error('No subtitle segments were produced');
        setTranscriptionProgress(97, transcriptionProgressLabel('refining'));
        const refined = await refineTranscriptionSegments(segments);
        const finalSegments = segments.map(segment => ({ ...segment, text: refined.get(segment.id) || segment.text }));
        const srt = finalSegments.map((segment, index) => `${index + 1}\n${segment.start} --> ${segment.end}\n${segment.text}`).join('\n\n') + '\n';
        const txt = finalSegments.map(segment => segment.text.replace(/\n/g, ' ')).join('\n') + '\n';
        const outputDir = result.raw_srt_path.replace(/[/\\][^/\\]+$/, '');
        const rawSrtName = result.raw_srt_path.split(/[\\/]/).pop() || 'transcript.srt';
        const rawTxtName = result.raw_txt_path.split(/[\\/]/).pop() || 'transcript.txt';
        const srtName = rawSrtName.replace(/\.srt$/i, '_refined.srt');
        const txtName = rawTxtName.replace(/\.txt$/i, '_refined.txt');
        const { invoke } = await tauriCorePromise;
        const written = await invoke('write_unique_file_pair', {
          directory: outputDir,
          firstFileName: srtName,
          firstBytes: Array.from(new TextEncoder().encode(srt)),
          secondFileName: txtName,
          secondBytes: Array.from(new TextEncoder().encode(txt))
        });
        return { srtPath: written.first_path, txtPath: written.second_path };
      }

      async function showTranscriptionResult(result, refined = null) {
        transcriptionOverlay?.classList.add('has-result');
        if (transcriptionFiles) {
          transcriptionFiles.replaceChildren();
          transcriptionFiles.classList.add('has-files');
        }
        const outputDir = String(result?.raw_srt_path || result?.raw_txt_path || '').replace(/[/\\][^/\\]+$/, '');
        setTranscriptionOutputDir(outputDir);
        const previewSrtPath = refined?.srtPath || result.raw_srt_path;
        const previewTxtPath = refined?.txtPath || result.raw_txt_path;
        try {
          const [srtValue, txtValue] = await Promise.all([
            previewSrtPath ? readTranscriptionText(previewSrtPath) : Promise.resolve(''),
            previewTxtPath ? readTranscriptionText(previewTxtPath) : Promise.resolve('')
          ]);
          renderTranscriptionPreview(parseTranscriptionSrt(srtValue), txtValue);
        } catch (error) {
          console.error('Cannot preview transcription result:', error);
          renderTranscriptionPreview([], '');
        }
        const paths = [
          [t('home.transcription.rawJson'), result.raw_json_path],
          [t('home.transcription.rawSrt'), result.raw_srt_path],
          [t('home.transcription.rawTxt'), result.raw_txt_path],
          ...(refined ? [[t('home.transcription.refinedSrt'), refined.srtPath], [t('home.transcription.refinedTxt'), refined.txtPath]] : [])
        ];
        paths.forEach(([label, path], index) => {
          if (!transcriptionFiles) return;
          const filePath = String(path || '');
          const item = document.createElement('div');
          item.className = 'audio-convert-file-item';
          item.title = displayFilesystemPath(filePath);
          item.innerHTML = `
            <span class="audio-convert-file-index">${index + 1}</span>
            <span class="audio-convert-file-name">${escapeHtml(filePath.split(/[\\/]/).pop() || label)}</span>
            <span class="transcription-result-type">${escapeHtml(label)}</span>
          `;
          item.addEventListener('dblclick', async () => {
            if (!isTauri || !filePath) return;
            try {
              const { invoke } = await tauriCorePromise;
              await invoke('open_path', { path: filePath });
            } catch (error) {
              console.error('Cannot open transcription output file:', error);
            }
          });
          transcriptionFiles.append(item);
        });
      }

      transcriptionCopyTextBtn?.addEventListener('click', async () => {
        if (!transcriptionPreviewText || !navigator.clipboard?.writeText) return;
        try {
          await navigator.clipboard.writeText(transcriptionPreviewText);
          setTranscriptionCopyButtonState(true);
          window.showToast?.(t('home.transcription.copyDone'));
          setTimeout(() => setTranscriptionCopyButtonState(false), 1200);
        } catch (error) {
          console.error('Cannot copy transcription text:', error);
        }
      });

      transcriptionOpenFolderBtn?.addEventListener('click', async () => {
        if (!isTauri || !transcriptionOutputDir) return;
        try {
          const { invoke } = await tauriCorePromise;
          await invoke('open_path', { path: transcriptionOutputDir });
        } catch (error) {
          console.error('Cannot open transcription output folder:', error);
        }
      });

      function showTranscriptionSuccess(result, refined = null, refineFailed = false) {
        const outputDir = String(result.raw_srt_path || '').replace(/[/\\][^/\\]+$/, '');
        setTranscriptionOutputDir(outputDir);
        if (transcriptionSuccessMeta) {
          transcriptionSuccessMeta.textContent = refineFailed
            ? t('home.transcription.refineFailed')
            : t('home.transcription.success');
        }
        if (transcriptionSuccessCount) transcriptionSuccessCount.textContent = String(refined ? 5 : 3);
        if (transcriptionSuccessPath) transcriptionSuccessPath.textContent = displayFilesystemPath(outputDir);
        window.showToast?.(refineFailed ? t('home.transcription.refineFailed') : t('home.transcription.doneInline'));
      }

      transcriptionSuccessOk?.addEventListener('click', () => transcriptionSuccessOverlay?.classList.remove('visible'));
      transcriptionSuccessOpenFolder?.addEventListener('click', async () => {
        if (!isTauri || !transcriptionOutputDir) return;
        try {
          const { invoke } = await tauriCorePromise;
          await invoke('open_path', { path: transcriptionOutputDir });
        } catch (error) {
          console.error('Cannot open transcription output folder:', error);
        }
      });

      transcriptionProcessBtn?.addEventListener('click', async () => {
        if (!transcriptionFile || transcriptionProcessing || !isTauri) return;
        if (!transcriptionFile.path) { window.showToast?.(t('home.transcription.desktopOnly')); return; }
        transcriptionProcessing = true;
        updateTranscriptionProcessButton();
        transcriptionProcessMask?.classList.add('visible');
        setTranscriptionProgress(2, transcriptionProgressLabel('preparing'));
        let unlisten = null;
        let completion = null;
        try {
          const { invoke } = await tauriCorePromise;
          const { listen } = await tauriEventPromise;
          unlisten = await listen('transcription-progress', event => {
            const progress = event.payload;
            if (!progress) return;
            setTranscriptionProgress(progress.progress || 0, transcriptionProgressLabel(progress.phase));
          });
          const result = await invoke('transcribe_media', {
            inputPath: transcriptionFile.path,
            outputDir: await getOutputDir('Transcripts'),
            language: transcriptionLanguage
          });
          let refined = null;
          let refineFailed = false;
          if (transcriptionRefine?.checked) {
            try {
              refined = await writeRefinedTranscription(result);
            } catch (error) {
              console.error('Transcription refinement failed:', error);
              refineFailed = true;
            }
          }
          await showTranscriptionResult(result, refined);
          completion = { result, refined, refineFailed };
          setTranscriptionProgress(100, transcriptionProgressLabel('complete'));
        } catch (error) {
          console.error('Transcription failed:', error);
          window.showToast?.(t('common.errorOccurred', { error: String(error?.message || error) }));
        } finally {
          unlisten?.();
          transcriptionProcessing = false;
          transcriptionProcessMask?.classList.remove('visible');
          updateTranscriptionProcessButton();
          setTranscriptionProgress(0, transcriptionProgressLabel('preparing'));
          if (completion) showTranscriptionSuccess(completion.result, completion.refined, completion.refineFailed);
        }
      });

      onLangChange(() => { updateTranscriptionUploadState(); syncTranscriptionInlineLabels(); updateOfflineModelSummary(); renderTranscriptionModels(); updateFfmpegRuntimeSummary(); renderFfmpegRuntime(); renderDependencyGate(); });

      const helpBtn = document.getElementById('helpBtn');
      function openSettingsOverlay() {
        if (!settingsOverlay) return;
        document.getElementById('helpOverlay')?.classList.remove('visible');
        if (settingsContent) settingsContent.scrollTop = 0;
        settingsOverlay.style.zIndex = '50000';
        settingsOverlay.classList.add('visible');
        syncCustomBackgroundPreviewPlayback?.();
      }

      if (settingsBtns.length && settingsOverlay) {
        settingsBtns.forEach(settingsBtn => settingsBtn.addEventListener('click', (event) => {
          event.preventDefault();
          event.stopPropagation();
          openSettingsOverlay();
        }));
      }
      if (helpBtn) {
        helpBtn.addEventListener('click', () => {
          openHelpOverlay('overview');
        });
      }

      if (settingsBack && settingsOverlay) {
        settingsBack.addEventListener('click', () => {
          settingsOverlay.classList.remove('visible');
          settingsOverlay.style.zIndex = '';
          syncCustomBackgroundPreviewPlayback?.();
        });
      }

      const helpLink = document.getElementById('helpLink');
      const feedbackLink = document.getElementById('feedbackLink');
      const declarationLink = document.getElementById('declarationLink');
      const usagePolicyLink = document.getElementById('usagePolicyLink');

      if (helpLink) {
        helpLink.addEventListener('click', (e) => {
          e.preventDefault();
          openHelpOverlay();
        });
      }

      const helpOverlay = document.getElementById('helpOverlay');
      const helpBackBtn = document.getElementById('helpBackBtn');
      const helpNav = document.getElementById('helpNav');
      const helpContentBody = document.getElementById('helpContentBody');
      const helpContentTitle = document.getElementById('helpContentTitle');
      const helpSearchInput = document.getElementById('helpSearchInput');

      function openHelpOverlay(sectionId = 'overview') {
        if (!helpOverlay) return;
        helpOverlay.classList.add('visible');
        showHelpSection(sectionId || 'overview');
      }

      function closeHelpOverlay() {
        if (!helpOverlay) return;
        helpOverlay.classList.remove('visible');
        if (helpSearchInput) helpSearchInput.value = '';
        if (helpNav) {
          helpNav.querySelectorAll('.help-nav-item').forEach(item => {
            item.style.display = '';
          });
          helpNav.querySelectorAll('.help-nav-group').forEach(g => g.style.display = '');
        }
      }

      if (helpBackBtn) {
        helpBackBtn.addEventListener('click', closeHelpOverlay);
      }

      let helpSearchCache = null;
      function buildHelpSearchCache() {
        const content = getHelpContent();
        if (helpSearchCache || !content) return;
        helpSearchCache = {};
        for (const key in content) {
          const entry = content[key];
          helpSearchCache[key] = (entry.title + ' ' + entry.html).toLowerCase();
        }
      }

      function showHelpSection(sectionId) {
        const content = getHelpContent();
        if (!content || !content[sectionId]) return;
        const data = content[sectionId];
        if (helpContentTitle) helpContentTitle.textContent = data.title;
        if (helpContentBody) {
          helpContentBody.innerHTML = data.html;
          helpContentBody.scrollTop = 0;
        }
        if (helpSearchInput) helpSearchInput.value = '';
        if (helpNav) {
          helpNav.querySelectorAll('.help-nav-item').forEach(item => {
            item.style.display = '';
            item.classList.toggle('active', item.dataset.helpSection === sectionId);
          });
          helpNav.querySelectorAll('.help-nav-group').forEach(g => g.style.display = '');
        }
      }

      if (helpNav) {
        helpNav.addEventListener('click', (e) => {
          const item = e.target.closest('.help-nav-item');
          if (!item) return;
          const section = item.dataset.helpSection;
          if (section) showHelpSection(section);
        });
      }

      if (helpContentBody) {
        helpContentBody.addEventListener('click', async (event) => {
          const button = event.target.closest('.help-prompt-copy');
          if (!button) return;
          const prompt = button.dataset.copyPrompt || '';
          if (!prompt) return;
          const originalLabel = button.textContent;
          try {
            await navigator.clipboard.writeText(prompt);
            button.textContent = getLang() === 'zh' ? '已复制' : 'Copied';
            button.classList.add('is-copied');
            setTimeout(() => {
              button.textContent = originalLabel;
              button.classList.remove('is-copied');
            }, 1600);
          } catch (error) {
            console.error('Could not copy Agent prompt:', error);
          }
        });
      }

      if (helpSearchInput) {
        helpSearchInput.addEventListener('input', () => {
          const query = helpSearchInput.value.trim().toLowerCase();
          if (!helpNav) return;
          if (!query) {
            helpNav.querySelectorAll('.help-nav-item').forEach(item => item.style.display = '');
            helpNav.querySelectorAll('.help-nav-group').forEach(g => g.style.display = '');
            const activeItem = helpNav.querySelector('.help-nav-item.active');
            if (activeItem && activeItem.dataset.helpSection) {
              const section = activeItem.dataset.helpSection;
              const content = getHelpContent();
              if (content[section]) {
                helpContentTitle.textContent = content[section].title;
                helpContentBody.innerHTML = content[section].html;
              }
            }
            return;
          }
          buildHelpSearchCache();
          let anyVisible = false;
          helpNav.querySelectorAll('.help-nav-group').forEach(group => {
            let groupHasVisible = false;
            group.querySelectorAll('.help-nav-item').forEach(item => {
              const text = (item.textContent || '').toLowerCase();
              const section = item.dataset.helpSection || '';
              const cached = (helpSearchCache && helpSearchCache[section]) || '';
              const match = text.includes(query) || cached.includes(query);
              item.style.display = match ? '' : 'none';
              if (match) groupHasVisible = true;
            });
            group.style.display = groupHasVisible ? '' : 'none';
            if (groupHasVisible) anyVisible = true;
          });
          if (helpContentBody) {
            if (!anyVisible) {
              helpContentBody.innerHTML = `<div class="help-search-empty">${escapeHtml(t('help.searchEmpty'))}</div>`;
            }
          }
        });
      }

      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && helpOverlay && helpOverlay.classList.contains('visible')) {
          closeHelpOverlay();
        }
      });

      const feedbackOverlay = document.getElementById('feedbackOverlay');
      const feedbackBack = document.getElementById('feedbackBack');
      const feedbackSettings = document.getElementById('feedbackV2Settings');
      const feedbackBtn = document.getElementById('feedbackBtn');
      const lightraysBg = document.getElementById('lightraysBg');
      let lightraysInstance = null;

      function openFeedbackOverlay() {
        if (!feedbackOverlay) return;
        feedbackOverlay.classList.add('visible');
        if (lightraysBg && !lightraysInstance) {
          lightraysInstance = initLightRays(lightraysBg, {
            raysOrigin: 'top-center',
            raysColor: '#ffffff',
            raysSpeed: 0.6,
            lightSpread: 0.6,
            rayLength: 3,
            followMouse: true,
            mouseInfluence: 0.1,
            noiseAmount: 0,
            distortion: 0,
            pulsating: false,
            fadeDistance: 1,
            saturation: 1
          });
        }
      }

      function closeFeedbackOverlay() {
        if (!feedbackOverlay) return;
        feedbackOverlay.classList.remove('visible');
        if (lightraysInstance) {
          lightraysInstance.destroy();
          lightraysInstance = null;
        }
      }

      if (feedbackLink && feedbackOverlay) {
        feedbackLink.addEventListener('click', (e) => {
          e.preventDefault();
          openFeedbackOverlay();
        });
      }

      if (feedbackBtn && feedbackOverlay) {
        feedbackBtn.addEventListener('click', () => {
          openFeedbackOverlay();
        });
      }

      if (feedbackBack && feedbackOverlay) {
        feedbackBack.addEventListener('click', () => {
          closeFeedbackOverlay();
        });
      }

      if (feedbackSettings && feedbackOverlay) {
        feedbackSettings.addEventListener('click', closeFeedbackOverlay);
      }

      // Audio Convert Tool Page
      const audioConvertOverlay = document.getElementById('audioConvertOverlay');
      const audioConvertBack = document.getElementById('audioConvertBack');
      const plasmaBg = document.getElementById('plasmaBg');
      let plasmaInstance = null;

      function openAudioConvertOverlay() {
        if (!audioConvertOverlay) return;
        audioConvertOverlay.classList.add('visible');
        if (plasmaBg && !plasmaInstance) {
          plasmaInstance = initStandardToolPlasma(plasmaBg);
        }
      }

      function closeAudioConvertOverlay() {
        if (!audioConvertOverlay) return;
        audioConvertOverlay.classList.remove('visible');
        if (plasmaInstance) {
          plasmaInstance();
          plasmaInstance = null;
        }
        cancelActiveAudioConversion();
        audioConvertProcessMask.classList.remove('visible');
        audioConvertProcessBarFill.style.width = '0%';
        // Clear file list for fresh start next time
        clearAudioFiles();
      }


      if (audioConvertBack) {
        audioConvertBack.addEventListener('click', closeAudioConvertOverlay);
      }

      // PPT image extraction is mounted by the lazy feature registry.



      // ===== Cleanup / Large Files =====
      const largeFileCleanupOverlay = document.getElementById('largeFileCleanupOverlay');
      const largeFileCleanupBody = largeFileCleanupOverlay?.querySelector('.cleanup-large-files-body');
      const largeFileCleanupPlasmaBg = document.getElementById('largeFileCleanupPlasmaBg');
      const largeFileCleanupBack = document.getElementById('largeFileCleanupBack');
      const largeFileCleanupFolder = document.getElementById('largeFileCleanupFolder');
      const largeFileCleanupChooseFolder = document.getElementById('largeFileCleanupChooseFolder');
      const largeFileCleanupThreshold = document.getElementById('largeFileCleanupThreshold');
      const largeFileCleanupModeGroup = document.getElementById('largeFileCleanupModeGroup');
      const largeFileCleanupScanBtn = document.getElementById('largeFileCleanupScanBtn');
      const largeFileCleanupAiCard = document.getElementById('largeFileCleanupAiCard');
      const largeFileCleanupAiTitle = document.getElementById('largeFileCleanupAiTitle');
      const largeFileCleanupAiDesc = document.getElementById('largeFileCleanupAiDesc');
      const largeFileCleanupAiBtn = document.getElementById('largeFileCleanupAiBtn');
      const largeFileCleanupAiProgress = document.getElementById('largeFileCleanupAiProgress');
      const largeFileCleanupAiProgressFill = document.getElementById('largeFileCleanupAiProgressFill');
      const largeFileCleanupAiProgressText = document.getElementById('largeFileCleanupAiProgressText');
      const largeFileCleanupSelectAllBtn = document.getElementById('largeFileCleanupSelectAllBtn');
      const largeFileCleanupClearBtn = document.getElementById('largeFileCleanupClearBtn');
      const largeFileCleanupDeleteBtn = document.getElementById('largeFileCleanupDeleteBtn');
      const largeFileCleanupSelectAllCheckbox = document.getElementById('largeFileCleanupSelectAllCheckbox');
      const largeFileCleanupSummary = document.getElementById('largeFileCleanupSummary');
      const largeFileCleanupTableBody = document.getElementById('largeFileCleanupTableBody');
      const largeFileCleanupSizeSort = document.getElementById('largeFileCleanupSizeSort');
      const largeFileCleanupSizeSortTrigger = document.getElementById('largeFileCleanupSizeSortTrigger');
      const largeFileCleanupSizeSortMenu = document.getElementById('largeFileCleanupSizeSortMenu');
      const largeFileCleanupSuccessOverlay = document.getElementById('largeFileCleanupSuccessOverlay');
      const largeFileCleanupSuccessMeta = document.getElementById('largeFileCleanupSuccessMeta');
      const largeFileCleanupSuccessAnalyzed = document.getElementById('largeFileCleanupSuccessAnalyzed');
      const largeFileCleanupSuccessMoved = document.getElementById('largeFileCleanupSuccessMoved');
      const largeFileCleanupSuccessSize = document.getElementById('largeFileCleanupSuccessSize');
      const largeFileCleanupSuccessFolder = document.getElementById('largeFileCleanupSuccessFolder');
      const largeFileCleanupSuccessFailures = document.getElementById('largeFileCleanupSuccessFailures');
      const largeFileCleanupSuccessOpenFolder = document.getElementById('largeFileCleanupSuccessOpenFolder');
      const largeFileCleanupSuccessOk = document.getElementById('largeFileCleanupSuccessOk');
      const largeFileCleanupDriveRootOverlay = document.getElementById('largeFileCleanupDriveRootOverlay');
      const largeFileCleanupDriveRootTitle = document.getElementById('largeFileCleanupDriveRootTitle');
      const largeFileCleanupDriveRootDesc = document.getElementById('largeFileCleanupDriveRootDesc');
      const largeFileCleanupDriveRootCancel = document.getElementById('largeFileCleanupDriveRootCancel');
      const largeFileCleanupDriveRootConfirm = document.getElementById('largeFileCleanupDriveRootConfirm');
      let largeFileCleanupPlasmaInstance = null;
      let largeFileCleanupRootPath = '';
      let largeFileCleanupMode = 'video';
      let largeFileCleanupCandidates = [];
      let largeFileCleanupSkippedDirs = 0;
      let largeFileCleanupScanRunId = 0;
      let largeFileCleanupAiRunId = 0;
      let largeFileCleanupBusy = false;
      let largeFileCleanupBusyKind = '';
      let largeFileCleanupSelectedPaths = new Set();
      let largeFileCleanupEmptyMessage = '';
      let largeFileCleanupSummaryStatus = '';
      let largeFileCleanupAiProgressDone = 0;
      let largeFileCleanupAiProgressTotal = 0;
      let largeFileCleanupDriveRootResolver = null;
      let largeFileCleanupHoverToast = null;
      let largeFileCleanupHoverToastTimer = null;
      let largeFileCleanupContextCandidate = null;
      let largeFileCleanupContextMenu = null;
      let largeFileCleanupSortMode = 'default';
      let largeFileCleanupSizeSortCloseTimer = null;
      let largeFileCleanupDriveSpace = null;
      let largeFileCleanupDriveSpaceRunId = 0;
      const LARGE_FILE_CLEANUP_FOLDER_KEY = 'toolknit.cleanup.large-file.folder.v1';

      function loadLargeFileCleanupFolder() {
        try {
          return localStorage.getItem(LARGE_FILE_CLEANUP_FOLDER_KEY)?.trim() || '';
        } catch {
          return '';
        }
      }

      function saveLargeFileCleanupFolder(path) {
        try {
          if (path) localStorage.setItem(LARGE_FILE_CLEANUP_FOLDER_KEY, path);
          else localStorage.removeItem(LARGE_FILE_CLEANUP_FOLDER_KEY);
        } catch {}
      }

      function largeFileCleanupBusyState() {
        return largeFileCleanupBusy;
      }

      function largeFileCleanupFormatDate(time) {
        if (!time) return '--';
        const date = new Date(time);
        if (Number.isNaN(date.getTime())) return '--';
        return new Intl.DateTimeFormat(getLang() === 'zh' ? 'zh-CN' : 'en-US', {
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit'
        }).format(date);
      }

      function largeFileCleanupSetBusy(nextBusy, kind = '') {
        largeFileCleanupBusy = !!nextBusy;
        largeFileCleanupBusyKind = largeFileCleanupBusy ? kind : '';
        [largeFileCleanupChooseFolder, largeFileCleanupThreshold, largeFileCleanupScanBtn, largeFileCleanupAiBtn, largeFileCleanupSelectAllBtn, largeFileCleanupClearBtn, largeFileCleanupDeleteBtn, largeFileCleanupSelectAllCheckbox]
          .forEach(el => {
            if (!el) return;
            el.disabled = largeFileCleanupBusy;
          });
        if (largeFileCleanupScanBtn) {
          largeFileCleanupScanBtn.textContent = largeFileCleanupBusyKind === 'scan'
            ? t('home.cleanupLargeFilesPage.scanning')
            : t('home.cleanupLargeFilesPage.scan');
        }
        if (largeFileCleanupAiBtn) {
          largeFileCleanupAiBtn.textContent = largeFileCleanupBusyKind === 'ai'
            ? t('home.cleanupLargeFilesPage.analysisRunning')
            : t('home.cleanupLargeFilesPage.aiAnalyze');
        }
        if (largeFileCleanupDeleteBtn && largeFileCleanupBusyKind === 'delete') {
          largeFileCleanupDeleteBtn.textContent = getLang() === 'zh' ? '正在移入回收站...' : 'Moving to Recycle Bin...';
        }
        largeFileCleanupRenderAiCard();
      }

      function largeFileCleanupSetMode(mode) {
        largeFileCleanupMode = mode || 'video';
        largeFileCleanupModeGroup?.querySelectorAll('[data-mode]').forEach(button => {
          button.classList.toggle('is-active', button.dataset.mode === largeFileCleanupMode);
        });
      }

      function largeFileCleanupNormalizeDriveSpace(space) {
        if (!space) return null;
        const freeBytes = Number(space.free_bytes ?? space.freeBytes);
        const totalBytes = Number(space.total_bytes ?? space.totalBytes);
        if (!Number.isFinite(totalBytes) || totalBytes <= 0) return null;
        return {
          drive: String(space.drive || largeFileCleanupDriveLabel(largeFileCleanupRootPath) || '').trim(),
          freeBytes: Math.max(0, Number.isFinite(freeBytes) ? freeBytes : 0),
          totalBytes
        };
      }

      function largeFileCleanupDriveSpaceText(space = largeFileCleanupDriveSpace) {
        const normalized = largeFileCleanupNormalizeDriveSpace(space);
        if (!normalized) return '';
        return t('home.cleanupLargeFilesPage.driveSpaceLabel', {
          free: formatFileSize(normalized.freeBytes),
          total: formatFileSize(normalized.totalBytes)
        });
      }

      function largeFileCleanupSetDriveSpace(space) {
        largeFileCleanupDriveSpace = largeFileCleanupNormalizeDriveSpace(space);
        largeFileCleanupSetFolderLabel(largeFileCleanupRootPath);
      }

      async function refreshLargeFileCleanupDriveSpace(path) {
        const rootPath = String(path || '').trim();
        const runId = ++largeFileCleanupDriveSpaceRunId;
        if (!isTauri || !isLargeFileCleanupDriveRoot(rootPath)) {
          largeFileCleanupSetDriveSpace(null);
          largeFileCleanupUpdateSummary();
          return;
        }
        largeFileCleanupSetDriveSpace(null);
        largeFileCleanupUpdateSummary();
        try {
          const { invoke } = await tauriCorePromise;
          const space = await invoke('get_cleanup_drive_space', { rootPath });
          if (runId !== largeFileCleanupDriveSpaceRunId) return;
          largeFileCleanupSetDriveSpace(space);
          largeFileCleanupUpdateSummary();
        } catch (error) {
          if (runId !== largeFileCleanupDriveSpaceRunId) return;
          console.warn('Read cleanup drive space failed:', error);
          largeFileCleanupSetDriveSpace(null);
          largeFileCleanupUpdateSummary();
        }
      }

      function largeFileCleanupSetFolderLabel(path) {
        if (!largeFileCleanupFolder) return;
        const value = String(path || '').trim();
        if (!value) {
          largeFileCleanupFolder.textContent = t('home.cleanupLargeFilesPage.folderPlaceholder');
          largeFileCleanupFolder.removeAttribute('title');
          return;
        }
        const driveSpaceText = isLargeFileCleanupDriveRoot(value) ? largeFileCleanupDriveSpaceText() : '';
        const displayPath = displayFilesystemPath(value);
        const label = driveSpaceText ? `${largeFileCleanupDriveLabel(value)} · ${driveSpaceText}` : displayPath;
        largeFileCleanupFolder.textContent = label;
        largeFileCleanupFolder.title = label;
      }

      function largeFileCleanupSetThreshold(value) {
        if (!largeFileCleanupThreshold) return;
        largeFileCleanupThreshold.value = String(Math.max(10, Math.min(102400, Number(value) || 50)));
      }

      function largeFileCleanupSelectedCount() {
        return largeFileCleanupSelectedPaths.size;
      }

      function largeFileCleanupTotalBytes() {
        return largeFileCleanupCandidates.reduce((sum, item) => sum + (Number(item.size_bytes) || 0), 0);
      }

      function largeFileCleanupSelectedBytes() {
        return largeFileCleanupCandidates.reduce((sum, item) => (
          largeFileCleanupSelectedPaths.has(item.path) ? sum + (Number(item.size_bytes) || 0) : sum
        ), 0);
      }

      function largeFileCleanupAnalyzeCount() {
        return largeFileCleanupCandidates.filter(item => item.ai_decision || item.aiDecision).length;
      }

      function largeFileCleanupSortedCandidates() {
        const items = largeFileCleanupCandidates.map((item, index) => ({ item, index: Number.isFinite(Number(item.__default_index)) ? Number(item.__default_index) : index }));
        if (largeFileCleanupSortMode === 'desc') {
          items.sort((a, b) => (Number(b.item.size_bytes) || 0) - (Number(a.item.size_bytes) || 0) || a.index - b.index);
        } else if (largeFileCleanupSortMode === 'asc') {
          items.sort((a, b) => (Number(a.item.size_bytes) || 0) - (Number(b.item.size_bytes) || 0) || a.index - b.index);
        } else {
          items.sort((a, b) => a.index - b.index);
        }
        return items.map(entry => entry.item);
      }

      function syncLargeFileCleanupSizeSortUi() {
        if (largeFileCleanupSizeSort) {
          largeFileCleanupSizeSort.dataset.sort = largeFileCleanupSortMode;
        }
        if (largeFileCleanupSizeSortTrigger) {
          largeFileCleanupSizeSortTrigger.setAttribute('aria-expanded', largeFileCleanupSizeSort?.classList.contains('is-open') ? 'true' : 'false');
        }
        largeFileCleanupSizeSortMenu?.querySelectorAll('[data-sort]').forEach(button => {
          button.classList.toggle('active', button.dataset.sort === largeFileCleanupSortMode);
        });
      }

      function openLargeFileCleanupSizeSortMenu() {
        if (largeFileCleanupSizeSortCloseTimer) {
          clearTimeout(largeFileCleanupSizeSortCloseTimer);
          largeFileCleanupSizeSortCloseTimer = null;
        }
        largeFileCleanupSizeSort?.classList.add('is-open');
        largeFileCleanupSizeSortMenu?.classList.add('is-open');
        if (largeFileCleanupSizeSortMenu && largeFileCleanupSizeSortTrigger) {
          const triggerRect = largeFileCleanupSizeSortTrigger.getBoundingClientRect();
          const menuWidth = largeFileCleanupSizeSortMenu.offsetWidth;
          const menuHeight = largeFileCleanupSizeSortMenu.offsetHeight;
          const padding = 10;
          let left = triggerRect.right - menuWidth;
          left = Math.min(left, window.innerWidth - menuWidth - padding);
          left = Math.max(padding, left);
          const belowTop = triggerRect.bottom + 8;
          const aboveTop = triggerRect.top - menuHeight - 8;
          let top = belowTop;
          if (belowTop + menuHeight > window.innerHeight - padding) {
            top = aboveTop;
          }
          top = Math.max(padding, Math.min(top, window.innerHeight - menuHeight - padding));
          largeFileCleanupSizeSortMenu.style.left = `${left}px`;
          largeFileCleanupSizeSortMenu.style.top = `${top}px`;
        }
        syncLargeFileCleanupSizeSortUi();
      }

      function closeLargeFileCleanupSizeSortMenu(delay = 320) {
        if (largeFileCleanupSizeSortCloseTimer) clearTimeout(largeFileCleanupSizeSortCloseTimer);
        largeFileCleanupSizeSortCloseTimer = setTimeout(() => {
          largeFileCleanupSizeSort?.classList.remove('is-open');
          largeFileCleanupSizeSortMenu?.classList.remove('is-open');
          syncLargeFileCleanupSizeSortUi();
          largeFileCleanupSizeSortCloseTimer = null;
        }, Math.max(0, delay));
      }

      function setLargeFileCleanupSortMode(mode) {
        largeFileCleanupSortMode = ['default', 'desc', 'asc'].includes(mode) ? mode : 'default';
        closeLargeFileCleanupSizeSortMenu(120);
        syncLargeFileCleanupSizeSortUi();
        largeFileCleanupRenderTable();
      }

      function largeFileCleanupHasAiKey() {
        return Boolean(aiApiKeyCache);
      }

      function largeFileCleanupRenderAiCard() {
        if (!largeFileCleanupAiCard) return;
        const total = largeFileCleanupCandidates.length;
        const analyzed = largeFileCleanupAnalyzeCount();
        const hasKey = largeFileCleanupHasAiKey();
        const isAiBusy = largeFileCleanupBusy && largeFileCleanupBusyKind === 'ai';
        let state = 'idle';
        let titleKey = 'aiIdleTitle';
        let descKey = 'aiIdleDesc';
        let buttonText = t('home.cleanupLargeFilesPage.aiWaitingScan');
        let buttonDisabled = largeFileCleanupBusy || total === 0;

        if (isAiBusy) {
          state = 'running';
          titleKey = 'aiRunningTitle';
          descKey = 'aiRunningDesc';
          buttonText = t('home.cleanupLargeFilesPage.analysisRunning');
          buttonDisabled = true;
        } else if (total > 0 && !hasKey) {
          state = 'need-key';
          titleKey = 'aiNeedKeyTitle';
          descKey = 'aiNeedKeyDesc';
          buttonText = t('home.cleanupLargeFilesPage.aiConfigureAndAnalyze');
          buttonDisabled = false;
        } else if (total > 0 && analyzed >= total) {
          state = 'done';
          titleKey = 'aiDoneTitle';
          descKey = 'aiDoneDesc';
          buttonText = t('home.cleanupLargeFilesPage.aiReanalyze');
          buttonDisabled = largeFileCleanupBusy;
        } else if (total > 0) {
          state = analyzed > 0 ? 'partial' : 'ready';
          titleKey = analyzed > 0 ? 'aiPartialTitle' : 'aiReadyTitle';
          descKey = analyzed > 0 ? 'aiPartialDesc' : 'aiReadyDesc';
          buttonText = analyzed > 0
            ? t('home.cleanupLargeFilesPage.aiContinueAnalyzeCount', { count: total })
            : t('home.cleanupLargeFilesPage.aiAnalyzeCount', { count: total });
          buttonDisabled = largeFileCleanupBusy;
        }

        largeFileCleanupAiCard.dataset.state = state;
        if (largeFileCleanupAiTitle) largeFileCleanupAiTitle.textContent = t(`home.cleanupLargeFilesPage.${titleKey}`);
        if (largeFileCleanupAiDesc) largeFileCleanupAiDesc.textContent = t(`home.cleanupLargeFilesPage.${descKey}`);
        if (largeFileCleanupAiBtn) {
          largeFileCleanupAiBtn.textContent = buttonText;
          largeFileCleanupAiBtn.disabled = buttonDisabled;
        }
        if (largeFileCleanupAiProgress) {
          const progressTotal = largeFileCleanupAiProgressTotal || total || 1;
          const progressDone = Math.min(progressTotal, Math.max(0, largeFileCleanupAiProgressDone));
          const percent = isAiBusy ? Math.max(8, Math.round((progressDone / progressTotal) * 100)) : 0;
          if (largeFileCleanupAiProgressFill) largeFileCleanupAiProgressFill.style.width = `${percent}%`;
          if (largeFileCleanupAiProgressText) {
            largeFileCleanupAiProgressText.textContent = isAiBusy
              ? t('home.cleanupLargeFilesPage.aiProgress', { done: progressDone, total: progressTotal })
              : '';
          }
          largeFileCleanupAiProgress.setAttribute('aria-hidden', isAiBusy ? 'false' : 'true');
        }
      }

      function largeFileCleanupUpdateSummary(extraText = '') {
        if (!largeFileCleanupSummary) return;
        const folderText = largeFileCleanupRootPath || t('home.cleanupLargeFilesPage.folderPlaceholder');
        const statusText = extraText || largeFileCleanupSummaryStatus || '';
        const labelMap = getLang() === 'zh'
          ? { folder: '目录', driveSpace: '盘空间', files: '候选', size: '合计', selected: '已选', selectedSize: '已选大小', skipped: '保护目录', analyzed: 'AI' }
          : { folder: 'Folder', driveSpace: 'Drive', files: 'Candidates', size: 'Total', selected: 'Selected', selectedSize: 'Selected size', skipped: 'Protected', analyzed: 'AI' };
        const driveSpaceText = isLargeFileCleanupDriveRoot(largeFileCleanupRootPath) ? largeFileCleanupDriveSpaceText() : '';
        const chips = [
          { key: 'folder', label: folderText, strong: labelMap.folder },
          ...(driveSpaceText ? [{ key: 'drive-space', label: driveSpaceText, strong: labelMap.driveSpace }] : []),
          { key: 'files', label: t('home.cleanupLargeFilesPage.summaryFiles', { count: largeFileCleanupCandidates.length }), strong: labelMap.files },
          { key: 'size', label: t('home.cleanupLargeFilesPage.summarySize', { size: formatFileSize(largeFileCleanupTotalBytes()) }), strong: labelMap.size },
          { key: 'selected', label: `${largeFileCleanupSelectedCount()} / ${largeFileCleanupCandidates.length}`, strong: labelMap.selected },
          { key: 'skipped', label: t('home.cleanupLargeFilesPage.summarySkipped', { count: largeFileCleanupSkippedDirs }), strong: labelMap.skipped },
          { key: 'analyzed', label: t('home.cleanupLargeFilesPage.summaryAnalyzed', { count: largeFileCleanupAnalyzeCount() }), strong: labelMap.analyzed },
          { key: 'selected-size', label: formatFileSize(largeFileCleanupSelectedBytes()), strong: labelMap.selectedSize }
        ];
        const statusChip = statusText ? `<span class="cleanup-large-files-summary-item cleanup-large-files-summary-status"><strong>${escapeHtml(statusText)}</strong></span>` : '';
        largeFileCleanupSummary.innerHTML = `${statusChip}${chips.map(({ key, label, strong }) => `<span class="cleanup-large-files-summary-item" data-kind="${escapeAttr(key)}"><strong>${escapeHtml(strong)}</strong><span>${escapeHtml(label)}</span></span>`).join('')}`;
        largeFileCleanupRenderAiCard();
      }

      function largeFileCleanupSyncSelectionUi() {
        if (!largeFileCleanupSelectAllCheckbox) return;
        const total = largeFileCleanupCandidates.length;
        const selected = largeFileCleanupSelectedCount();
        largeFileCleanupSelectAllCheckbox.checked = total > 0 && selected === total;
        largeFileCleanupSelectAllCheckbox.indeterminate = selected > 0 && selected < total;
        if (largeFileCleanupSelectAllBtn) {
          largeFileCleanupSelectAllBtn.textContent = `${t('home.cleanupLargeFilesPage.selectAll')} (${selected}/${total})`;
        }
        if (largeFileCleanupClearBtn) {
          largeFileCleanupClearBtn.textContent = `${t('home.cleanupLargeFilesPage.clearSelection')} (${selected})`;
        }
        if (largeFileCleanupDeleteBtn) {
          largeFileCleanupDeleteBtn.textContent = `${t('home.cleanupLargeFilesPage.deleteSelected')} (${selected})`;
          largeFileCleanupDeleteBtn.disabled = largeFileCleanupBusy || selected === 0;
        }
        largeFileCleanupRenderAiCard();
      }

      function largeFileCleanupDecisionLabel(decision) {
        const normalized = String(decision || '').toLowerCase();
        if (normalized === 'delete') return getLang() === 'zh' ? '建议删除' : 'Suggested delete';
        if (normalized === 'keep') return getLang() === 'zh' ? '建议保留' : 'Suggested keep';
        if (normalized === 'review') return getLang() === 'zh' ? '建议复核' : 'Suggested review';
        return '';
      }

      function largeFileCleanupReasonDisplay(candidate) {
        const decision = candidate.ai_decision || candidate.aiDecision || '';
        const localReason = String(candidate.local_reason || '').trim();
        const aiIdentity = String(candidate.ai_identity || candidate.aiIdentity || '').trim();
        const aiReason = String(candidate.ai_reason || candidate.aiReason || '').trim();
        const aiLabel = largeFileCleanupDecisionLabel(decision);
        const pairSeparator = getLang() === 'zh' ? '：' : ': ';
        const textParts = [];
        const htmlParts = [];
        if (localReason) {
          const label = getLang() === 'zh' ? '本地规则' : 'Local rule';
          textParts.push(`${label}${pairSeparator}${localReason}`);
          htmlParts.push(`<span class="cleanup-large-files-reason-line"><b>${escapeHtml(label)}</b>${pairSeparator}${escapeHtml(localReason)}</span>`);
        }
        if (aiIdentity) {
          const label = getLang() === 'zh' ? '文件识别' : 'File identity';
          textParts.push(`${label}${pairSeparator}${aiIdentity}`);
          htmlParts.push(`<span class="cleanup-large-files-reason-line"><b>${escapeHtml(label)}</b>${pairSeparator}${escapeHtml(aiIdentity)}</span>`);
        }
        if (aiLabel || aiReason) {
          const label = getLang() === 'zh' ? 'AI 建议' : 'AI suggestion';
          const valueSeparator = getLang() === 'zh' ? '：' : ': ';
          const value = [aiLabel, aiReason].filter(Boolean).join(aiReason && aiLabel ? valueSeparator : '');
          textParts.push(`${label}${pairSeparator}${value || '--'}`);
          htmlParts.push(`<span class="cleanup-large-files-reason-line"><b>${escapeHtml(label)}</b>${pairSeparator}${aiLabel ? `<strong class="cleanup-large-files-ai-label">${escapeHtml(aiLabel)}</strong>` : ''}${aiReason ? `${aiLabel ? valueSeparator : ''}${escapeHtml(aiReason)}` : ''}</span>`);
        }
        if (!textParts.length && !htmlParts.length) {
          textParts.push('--');
          htmlParts.push('<span class="cleanup-large-files-reason-line">--</span>');
        }
        return {
          text: textParts.join('\n'),
          html: htmlParts.join('')
        };
      }

      function closeLargeFileCleanupHoverToast(delay = 0) {
        if (largeFileCleanupHoverToastTimer) clearTimeout(largeFileCleanupHoverToastTimer);
        largeFileCleanupHoverToastTimer = setTimeout(() => {
          largeFileCleanupHoverToast?.close?.();
          largeFileCleanupHoverToast = null;
          largeFileCleanupHoverToastTimer = null;
        }, Math.max(0, delay));
      }

      function showLargeFileCleanupReasonToast(text) {
        const message = String(text || '').trim();
        if (!message || message === '--') return;
        if (largeFileCleanupHoverToastTimer) {
          clearTimeout(largeFileCleanupHoverToastTimer);
          largeFileCleanupHoverToastTimer = null;
        }
        largeFileCleanupHoverToast?.close?.();
        largeFileCleanupHoverToast = window.showToast?.(message, {
          duration: 600000,
          className: 'cleanup-reason-toast'
        }) || null;
        const toastEl = largeFileCleanupHoverToast?.el;
        if (toastEl) {
          toastEl.addEventListener('mouseenter', () => {
            if (largeFileCleanupHoverToastTimer) {
              clearTimeout(largeFileCleanupHoverToastTimer);
              largeFileCleanupHoverToastTimer = null;
            }
          });
          toastEl.addEventListener('mouseleave', () => closeLargeFileCleanupHoverToast(900));
        }
      }

      function ensureLargeFileCleanupContextMenu() {
        if (largeFileCleanupContextMenu) return largeFileCleanupContextMenu;
        const menu = document.createElement('div');
        menu.className = 'cleanup-large-files-context-menu';
        menu.innerHTML = `
          <div class="cleanup-large-files-context-title"></div>
          <button type="button" class="cleanup-large-files-context-item" data-action="open-folder">
            <span class="cleanup-large-files-context-icon" aria-hidden="true">↗</span>
            <span>${escapeHtml(t('home.cleanupLargeFilesPage.contextOpenFolder'))}</span>
          </button>
        `;
        document.body.appendChild(menu);
        menu.addEventListener('click', async event => {
          const action = event.target.closest('[data-action]')?.dataset.action || '';
          if (action === 'open-folder' && largeFileCleanupContextCandidate) {
            await openLargeFileCleanupCandidateFolder(largeFileCleanupContextCandidate);
          }
          hideLargeFileCleanupContextMenu();
        });
        largeFileCleanupContextMenu = menu;
        return menu;
      }

      function hideLargeFileCleanupContextMenu() {
        if (!largeFileCleanupContextMenu) return;
        largeFileCleanupContextMenu.classList.remove('visible');
        largeFileCleanupContextCandidate = null;
      }

      function showLargeFileCleanupContextMenu(event, candidate) {
        if (!candidate) return;
        hideLargeFileCleanupContextMenu();
        largeFileCleanupContextCandidate = candidate;
        const menu = ensureLargeFileCleanupContextMenu();
        const title = menu.querySelector('.cleanup-large-files-context-title');
        if (title) title.textContent = candidate.name || displayFilesystemPath(candidate.path) || '';
        const openFolderLabel = menu.querySelector('[data-action="open-folder"] span:last-child');
        if (openFolderLabel) openFolderLabel.textContent = t('home.cleanupLargeFilesPage.contextOpenFolder');
        menu.classList.add('visible');
        const rect = menu.getBoundingClientRect();
        const padding = 10;
        const left = Math.min(window.innerWidth - rect.width - padding, Math.max(padding, event.clientX));
        const top = Math.min(window.innerHeight - rect.height - padding, Math.max(padding, event.clientY));
        menu.style.left = `${left}px`;
        menu.style.top = `${top}px`;
      }

      async function openLargeFileCleanupCandidateFolder(candidate) {
        if (!candidate?.path) return;
        try {
          const { invoke } = await tauriCorePromise;
          await invoke('open_path', { path: candidate.path });
        } catch (error) {
          console.error('Open cleanup candidate folder failed:', error);
          window.showToast?.(error?.message || (getLang() === 'zh' ? '打开所在文件夹失败。' : 'Failed to open containing folder.'));
        }
      }

      function largeFileCleanupRenderTable() {
        if (!largeFileCleanupTableBody) return;
        syncLargeFileCleanupSizeSortUi();
        largeFileCleanupTableBody.innerHTML = '';
        if (!largeFileCleanupCandidates.length) {
          const row = document.createElement('tr');
          const cell = document.createElement('td');
          cell.colSpan = 7;
          cell.className = 'cleanup-large-files-summary-empty';
          cell.textContent = largeFileCleanupBusy
            ? t('home.cleanupLargeFilesPage.scanning')
            : (largeFileCleanupEmptyMessage || t('home.cleanupLargeFilesPage.noResults'));
          row.appendChild(cell);
          largeFileCleanupTableBody.appendChild(row);
          largeFileCleanupUpdateSummary();
          largeFileCleanupSyncSelectionUi();
          return;
        }

        for (const candidate of largeFileCleanupSortedCandidates()) {
          const selected = largeFileCleanupSelectedPaths.has(candidate.path);
          const reasonDisplay = largeFileCleanupReasonDisplay(candidate);
          const mainRow = document.createElement('tr');
          mainRow.dataset.path = candidate.path;
          if (selected) mainRow.classList.add('is-selected');
          mainRow.innerHTML = `
            <td><input class="cleanup-large-files-check" type="checkbox" data-path="${escapeAttr(candidate.path)}"${selected ? ' checked' : ''}></td>
            <td>
              <span class="cleanup-large-files-item-main">${escapeHtml(candidate.name)}</span>
              <span class="cleanup-large-files-item-sub">${escapeHtml(displayFilesystemPath(candidate.path))}</span>
            </td>
            <td>${escapeHtml(formatFileSize(Number(candidate.size_bytes) || 0))}</td>
            <td>${escapeHtml(candidate.category || '--')}</td>
            <td>${escapeHtml(largeFileCleanupFormatDate(candidate.modified_at))}</td>
            <td>${escapeHtml(candidate.folder_hint || '--')}</td>
            <td><span class="cleanup-large-files-risk cleanup-large-files-risk-${escapeHtml(candidate.risk || 'medium')}">${escapeHtml(candidate.risk || 'medium')}</span></td>
          `;
          largeFileCleanupTableBody.appendChild(mainRow);

          const reasonRow = document.createElement('tr');
          reasonRow.dataset.path = candidate.path;
          reasonRow.className = 'cleanup-large-files-reason-row';
          if (selected) reasonRow.classList.add('is-selected');
          reasonRow.innerHTML = `
            <td colspan="7" class="cleanup-large-files-reason">
              <div class="cleanup-large-files-reason-preview" data-full-reason="${escapeAttr(reasonDisplay.text)}">${reasonDisplay.html}</div>
            </td>
          `;
          largeFileCleanupTableBody.appendChild(reasonRow);
        }

        largeFileCleanupTableBody.querySelectorAll('.cleanup-large-files-check').forEach(checkbox => {
          checkbox.addEventListener('change', () => {
            const path = checkbox.dataset.path || '';
            if (!path) return;
            if (checkbox.checked) largeFileCleanupSelectedPaths.add(path);
            else largeFileCleanupSelectedPaths.delete(path);
            const row = checkbox.closest('tr');
            row?.classList.toggle('is-selected', checkbox.checked);
            const reasonRow = row?.nextElementSibling;
            if (reasonRow?.classList.contains('cleanup-large-files-reason-row')) {
              reasonRow.classList.toggle('is-selected', checkbox.checked);
            }
            largeFileCleanupSyncSelectionUi();
            largeFileCleanupUpdateSummary();
          });
        });
        largeFileCleanupTableBody.querySelectorAll('tr[data-path]').forEach(row => {
          row.addEventListener('contextmenu', event => {
            event.preventDefault();
            event.stopPropagation();
            const candidate = largeFileCleanupCandidates.find(item => item.path === row.dataset.path);
            showLargeFileCleanupContextMenu(event, candidate);
          });
        });

        largeFileCleanupUpdateSummary();
        largeFileCleanupSyncSelectionUi();
      }

      function largeFileCleanupResetSelection() {
        largeFileCleanupSelectedPaths = new Set();
        largeFileCleanupRenderTable();
      }

      function largeFileCleanupSetCandidates(candidates, skippedDirs) {
        largeFileCleanupCandidates = Array.isArray(candidates) ? candidates.map((item, index) => ({ ...item, __default_index: index })) : [];
        largeFileCleanupSkippedDirs = Number(skippedDirs) || 0;
        largeFileCleanupSelectedPaths = new Set();
        largeFileCleanupAiProgressDone = 0;
        largeFileCleanupAiProgressTotal = 0;
        if (largeFileCleanupCandidates.length) {
          largeFileCleanupEmptyMessage = '';
          largeFileCleanupSummaryStatus = '';
        }
        largeFileCleanupRenderTable();
      }

      function largeFileCleanupOpen() {
        if (!largeFileCleanupOverlay) return;
        largeFileCleanupOverlay.classList.add('visible');
        largeFileCleanupOverlay.setAttribute('aria-hidden', 'false');
        if (largeFileCleanupPlasmaBg && !largeFileCleanupPlasmaInstance) {
          largeFileCleanupPlasmaInstance = initStandardToolPlasma(largeFileCleanupPlasmaBg);
        }
        if (!largeFileCleanupRootPath) {
          const savedFolder = loadLargeFileCleanupFolder();
          if (savedFolder) largeFileCleanupRootPath = savedFolder;
        }
        largeFileCleanupSetFolderLabel(largeFileCleanupRootPath);
        refreshLargeFileCleanupDriveSpace(largeFileCleanupRootPath);
        largeFileCleanupSetThreshold(largeFileCleanupThreshold?.value || 50);
        largeFileCleanupSetMode(largeFileCleanupMode || 'video');
        largeFileCleanupUpdateSummary();
        largeFileCleanupRenderTable();
      }

      function largeFileCleanupClose() {
        if (largeFileCleanupBusyState()) {
          window.showToast?.(getLang() === 'zh' ? '正在处理，请稍后再关闭。' : 'Please wait until the current cleanup task finishes.');
          return;
        }
        if (!largeFileCleanupOverlay) return;
        largeFileCleanupOverlay.classList.remove('visible');
        largeFileCleanupOverlay.setAttribute('aria-hidden', 'true');
        if (largeFileCleanupPlasmaInstance) {
          largeFileCleanupPlasmaInstance();
          largeFileCleanupPlasmaInstance = null;
        }
      }

      async function chooseLargeFileCleanupFolder() {
        if (!isTauri) {
          window.showToast?.(getLang() === 'zh' ? '仅支持桌面端选择清理目录。' : 'Folder selection is only available in the desktop app.');
          return;
        }
        try {
          const { open } = await import('@tauri-apps/plugin-dialog');
          const selected = await open({ directory: true, multiple: false, title: getLang() === 'zh' ? '选择大文件扫描目录' : 'Choose a folder to scan' });
          if (typeof selected !== 'string' || !selected.trim()) return;
          largeFileCleanupRootPath = selected.trim();
          largeFileCleanupSetDriveSpace(null);
          saveLargeFileCleanupFolder(largeFileCleanupRootPath);
          largeFileCleanupSetFolderLabel(largeFileCleanupRootPath);
          largeFileCleanupUpdateSummary(getLang() === 'zh' ? '已选择目录' : 'Folder selected');
          window.showToast?.(t('home.cleanupLargeFilesPage.folderSelected', { path: displayFilesystemPath(largeFileCleanupRootPath) }));
          refreshLargeFileCleanupDriveSpace(largeFileCleanupRootPath);
        } catch (error) {
          console.error('Choose cleanup folder failed:', error);
          window.showToast?.(error?.message || (getLang() === 'zh' ? '选择目录失败。' : 'Failed to choose folder.'));
        }
      }

      function largeFileCleanupModeChipHandler(event) {
        const button = event.target.closest('[data-mode]');
        if (!button || largeFileCleanupBusyState()) return;
        largeFileCleanupSetMode(button.dataset.mode || 'video');
      }

      function largeFileCleanupCollectScanArgs() {
        const minSizeMb = Math.max(10, Math.min(102400, Number(largeFileCleanupThreshold?.value || 50) || 50));
        return {
          rootPath: largeFileCleanupRootPath,
          minSizeMb,
          mode: largeFileCleanupMode || 'video'
        };
      }

      function largeFileCleanupDriveLetter(path) {
        const value = String(path || '').trim();
        const match = value.match(/^([a-zA-Z]):[\\/]*$/);
        return match ? match[1].toUpperCase() : '';
      }

      function isLargeFileCleanupDriveRoot(path) {
        return !!largeFileCleanupDriveLetter(path);
      }

      function isLargeFileCleanupSystemDriveRoot(path) {
        const value = String(path || '').trim();
        const drive = largeFileCleanupDriveLetter(value);
        return drive === 'C' || value === '\\' || value === '/';
      }

      function largeFileCleanupDriveLabel(path) {
        const drive = largeFileCleanupDriveLetter(path);
        return drive ? `${drive}:\\` : String(path || '').trim();
      }

      function largeFileCleanupRootBlockedMessage(path) {
        const drive = largeFileCleanupDriveLetter(path) || 'C';
        return t('home.cleanupLargeFilesPage.rootBlockedDesc', { drive });
      }

      function closeLargeFileCleanupDriveRootOverlay(result = false) {
        if (largeFileCleanupDriveRootOverlay) {
          largeFileCleanupDriveRootOverlay.classList.remove('visible');
          largeFileCleanupDriveRootOverlay.setAttribute('aria-hidden', 'true');
        }
        const resolver = largeFileCleanupDriveRootResolver;
        largeFileCleanupDriveRootResolver = null;
        if (resolver) resolver(!!result);
      }

      function confirmLargeFileCleanupDataDriveRoot(path) {
        const drive = largeFileCleanupDriveLetter(path);
        if (!drive) return Promise.resolve(true);
        const driveLabel = largeFileCleanupDriveLabel(path);
        const title = t('home.cleanupLargeFilesPage.dataRootConfirmTitle', { drive });
        const desc = t('home.cleanupLargeFilesPage.dataRootConfirmDesc', { drive: driveLabel });
        if (largeFileCleanupDriveRootOverlay && largeFileCleanupDriveRootTitle && largeFileCleanupDriveRootDesc) {
          largeFileCleanupDriveRootTitle.textContent = title;
          largeFileCleanupDriveRootDesc.textContent = desc;
          largeFileCleanupDriveRootOverlay.classList.add('visible');
          largeFileCleanupDriveRootOverlay.setAttribute('aria-hidden', 'false');
          return new Promise(resolve => {
            largeFileCleanupDriveRootResolver = resolve;
          });
        }
        return Promise.resolve(window.confirm(`${title}\n\n${desc}`));
      }

      function largeFileCleanupFriendlyError(error) {
        const message = String(error?.message || error || '').trim();
        if (message.includes('System drive root is blocked') || message.includes('Please choose a user folder')) {
          return largeFileCleanupRootBlockedMessage(largeFileCleanupRootPath);
        }
        return message || t('home.cleanupLargeFilesPage.scanFailedDesc');
      }

      async function largeFileCleanupScan() {
        if (!isTauri) {
          window.showToast?.(getLang() === 'zh' ? '仅支持桌面端扫描。' : 'Scanning is only available in the desktop app.');
          return;
        }
        if (largeFileCleanupBusyState()) return;
        if (!largeFileCleanupRootPath) {
          await chooseLargeFileCleanupFolder();
          if (!largeFileCleanupRootPath) return;
        }
        const args = largeFileCleanupCollectScanArgs();
        if (!args.rootPath) {
          window.showToast?.(t('home.cleanupLargeFilesPage.noFolderChosen'));
          return;
        }
        if (isLargeFileCleanupSystemDriveRoot(args.rootPath)) {
          refreshLargeFileCleanupDriveSpace(args.rootPath);
          largeFileCleanupCandidates = [];
          largeFileCleanupSkippedDirs = 0;
          largeFileCleanupSelectedPaths = new Set();
          largeFileCleanupEmptyMessage = largeFileCleanupRootBlockedMessage(args.rootPath);
          largeFileCleanupSummaryStatus = t('home.cleanupLargeFilesPage.rootBlockedTitle');
          largeFileCleanupRenderTable();
          window.showToast?.(largeFileCleanupRootBlockedMessage(args.rootPath));
          return;
        }
        if (isLargeFileCleanupDriveRoot(args.rootPath)) {
          const confirmed = await confirmLargeFileCleanupDataDriveRoot(args.rootPath);
          if (!confirmed) {
            largeFileCleanupSummaryStatus = t('home.cleanupLargeFilesPage.dataRootCancelled');
            largeFileCleanupUpdateSummary();
            return;
          }
        }
        const runId = ++largeFileCleanupScanRunId;
        largeFileCleanupSetBusy(true, 'scan');
        largeFileCleanupSetDriveSpace(null);
        largeFileCleanupSetFolderLabel(args.rootPath);
        largeFileCleanupEmptyMessage = '';
        largeFileCleanupSummaryStatus = '';
        largeFileCleanupUpdateSummary(t('home.cleanupLargeFilesPage.scanning'));
        largeFileCleanupCandidates = [];
        largeFileCleanupSelectedPaths = new Set();
        largeFileCleanupAiProgressDone = 0;
        largeFileCleanupAiProgressTotal = 0;
        largeFileCleanupRenderTable();
        try {
          const { invoke } = await tauriCorePromise;
          const result = await invoke('scan_large_files', {
            rootPath: args.rootPath,
            minSizeMb: args.minSizeMb,
            mode: args.mode
          });
          if (runId !== largeFileCleanupScanRunId) return;
          largeFileCleanupRootPath = result?.root_path || args.rootPath;
          saveLargeFileCleanupFolder(largeFileCleanupRootPath);
          largeFileCleanupMode = result?.mode || args.mode;
          largeFileCleanupSetDriveSpace(result?.drive_space || null);
          if (isLargeFileCleanupDriveRoot(largeFileCleanupRootPath) && !largeFileCleanupDriveSpace) {
            refreshLargeFileCleanupDriveSpace(largeFileCleanupRootPath);
          }
          largeFileCleanupSetFolderLabel(largeFileCleanupRootPath);
          largeFileCleanupThreshold && (largeFileCleanupThreshold.value = String(args.minSizeMb));
          largeFileCleanupSetCandidates(result?.candidates || [], result?.skipped_dirs || 0);
          if (!largeFileCleanupCandidates.length) {
            largeFileCleanupEmptyMessage = t('home.cleanupLargeFilesPage.noResults');
            window.showToast?.(t('home.cleanupLargeFilesPage.noResults'));
            largeFileCleanupRenderTable();
          } else {
            window.showToast?.(t('home.cleanupLargeFilesPage.scanComplete', {
              count: largeFileCleanupCandidates.length,
              size: formatFileSize(largeFileCleanupTotalBytes())
            }));
          }
        } catch (error) {
          if (runId !== largeFileCleanupScanRunId) return;
          console.error('Cleanup scan failed:', error);
          const friendlyMessage = largeFileCleanupFriendlyError(error);
          largeFileCleanupEmptyMessage = friendlyMessage;
          largeFileCleanupSummaryStatus = t('home.cleanupLargeFilesPage.scanFailedTitle');
          largeFileCleanupSetCandidates([], 0);
          window.showToast?.(friendlyMessage);
        } finally {
          if (runId === largeFileCleanupScanRunId) {
            largeFileCleanupSetBusy(false);
            largeFileCleanupRenderTable();
            largeFileCleanupUpdateSummary();
            largeFileCleanupSyncSelectionUi();
          }
        }
      }

      function largeFileCleanupExtractJson(text) {
        const raw = String(text || '').trim();
        if (!raw) return null;
        const attempts = [raw];
        const firstBrace = raw.indexOf('{');
        const lastBrace = raw.lastIndexOf('}');
        if (firstBrace >= 0 && lastBrace > firstBrace) attempts.push(raw.slice(firstBrace, lastBrace + 1));
        const firstBracket = raw.indexOf('[');
        const lastBracket = raw.lastIndexOf(']');
        if (firstBracket >= 0 && lastBracket > firstBracket) attempts.push(raw.slice(firstBracket, lastBracket + 1));
        for (const attempt of attempts) {
          try {
            return JSON.parse(attempt);
          } catch {}
        }
        return null;
      }

      function largeFileCleanupApplyAiDecisions(payload) {
        const items = Array.isArray(payload?.items) ? payload.items : Array.isArray(payload) ? payload : [];
        const byId = new Map(items.map(item => [String(item?.id || ''), item]));
        largeFileCleanupCandidates = largeFileCleanupCandidates.map(candidate => {
          const entry = byId.get(String(candidate.id || ''));
          if (!entry) return candidate;
          const decision = String(entry.decision || entry.action || entry.recommendation || '').toLowerCase();
          const aiDecision = decision === 'delete' || decision === 'remove' ? 'delete'
            : decision === 'keep' ? 'keep'
              : decision === 'review' || decision === 'check' || decision === 'uncertain' ? 'review'
                : '';
          const safeDecision = candidate.risk === 'high' && aiDecision === 'delete' ? 'review' : aiDecision;
          const rawAiIdentity = String(entry.identity || entry.file_identity || entry.what_is_file || entry.summary || entry.purpose || '').trim();
          const rawAiReason = String(entry.reason || entry.note || entry.explanation || '').trim();
          const aiReason = candidate.risk === 'high' && aiDecision === 'delete'
            ? `${getLang() === 'zh' ? '本地保护策略：高风险文件不会自动建议删除，已改为人工复核。AI 原因：' : 'Local safety policy: high-risk files are never auto-suggested for deletion, changed to review. AI reason: '}${rawAiReason}`
            : rawAiReason;
          return {
            ...candidate,
            ai_decision: safeDecision || candidate.ai_decision || '',
            ai_identity: rawAiIdentity || candidate.ai_identity || '',
            ai_reason: aiReason || candidate.ai_reason || ''
          };
        });
        largeFileCleanupSelectedPaths = new Set(
          largeFileCleanupCandidates
            .filter(candidate => (candidate.ai_decision || candidate.aiDecision) === 'delete')
            .map(candidate => candidate.path)
        );
        largeFileCleanupRenderTable();
      }

      async function largeFileCleanupAnalyze() {
        if (!largeFileCleanupCandidates.length) {
          window.showToast?.(t('home.cleanupLargeFilesPage.noResults'));
          return;
        }
        if (!largeFileCleanupHasAiKey()) {
          showAiKeyRequiredOverlay();
          return;
        }
        if (largeFileCleanupBusyState()) return;
        const runId = ++largeFileCleanupAiRunId;
        largeFileCleanupAiProgressDone = 0;
        largeFileCleanupAiProgressTotal = largeFileCleanupCandidates.length;
        largeFileCleanupSetBusy(true, 'ai');
        largeFileCleanupUpdateSummary(t('home.cleanupLargeFilesPage.analysisRunning'));
        const batches = [];
        const batchSize = 16;
        for (let i = 0; i < largeFileCleanupCandidates.length; i += batchSize) {
          batches.push(largeFileCleanupCandidates.slice(i, i + batchSize));
        }
        const responseLanguage = getLang() === 'en' ? 'English' : '中文';
        const decisionHelp = getLang() === 'en'
          ? 'Use delete only for clearly redundant installers, archives, cache-like videos, or obvious downloads. Never return delete for high-risk items, chat folders, project/source folders, or model/development packages; return keep or review. Review anything uncertain. Explain what the file probably belongs to from its name and folder hint, but do not overclaim.'
          : '只对明显冗余的安装包、压缩包、缓存类视频、下载目录中的临时文件给出 delete。严禁对 high 风险项、聊天文件目录、项目源码目录、模型/开发包返回 delete；这类只能返回 keep 或 review。无法判断的给 review。需要根据文件名和目录线索解释文件大概属于什么软件/用途，但不要过度确定。';
        try {
          for (const batch of batches) {
            if (runId !== largeFileCleanupAiRunId) return;
            const prompt = [
              {
                role: 'system',
                content: `You are a careful local cleanup assistant. Only inspect file metadata, never ask for or infer file contents. Reply in ${responseLanguage} with strict JSON only. The JSON must be: {"items":[{"id":"...","identity":"...","decision":"delete|keep|review","reason":"..."}]}. "identity" explains what this file probably is or which app/component it likely belongs to, based on file name and folder hint. "reason" explains why the decision is safe or why human review is needed. Keep identity under 28 Chinese chars or 8 English words; keep reason under 90 Chinese chars or 35 English words. If file names or folder hints mention Devin, language_server, resources/app/extensions, identify them as Devin AI IDE main program or extension/runtime components when appropriate.`
              },
              {
                role: 'user',
                content: JSON.stringify({
                  privacy_note: 'Only relative folder hints are provided. Absolute local paths and file contents are intentionally withheld.',
                  mode: largeFileCleanupMode,
                  threshold_mb: Number(largeFileCleanupThreshold?.value || 50) || 50,
                  guidance: decisionHelp,
                  items: batch.map(item => ({
                    id: item.id,
                    name: item.name,
                    size_bytes: item.size_bytes,
                    category: item.category,
                    modified_at: item.modified_at,
                    folder_hint: item.folder_hint,
                    risk: item.risk,
                    local_reason: item.local_reason
                  }))
                }, null, 2)
              }
            ];
            const content = await callDeepSeek(prompt, undefined, 1800);
            const parsed = largeFileCleanupExtractJson(content);
            if (parsed) {
              largeFileCleanupApplyAiDecisions(parsed);
            }
            largeFileCleanupAiProgressDone = Math.min(largeFileCleanupAiProgressTotal, largeFileCleanupAiProgressDone + batch.length);
            largeFileCleanupRenderAiCard();
          }
          if (runId === largeFileCleanupAiRunId) {
            window.showToast?.(t('home.cleanupLargeFilesPage.analysisReady'));
          }
        } catch (error) {
          if (runId !== largeFileCleanupAiRunId) return;
          console.error('Cleanup AI analysis failed:', error);
          window.showToast?.(error?.message || t('home.cleanupLargeFilesPage.aiNeedKey'));
        } finally {
          if (runId === largeFileCleanupAiRunId) {
            largeFileCleanupSetBusy(false);
            largeFileCleanupUpdateSummary();
            largeFileCleanupSyncSelectionUi();
          }
        }
      }

      function largeFileCleanupSelectAll(nextSelected) {
        largeFileCleanupSelectedPaths = new Set(
          nextSelected
            ? largeFileCleanupCandidates.map(item => item.path)
            : []
        );
        largeFileCleanupRenderTable();
      }

      function largeFileCleanupFileNameFromPath(path) {
        const value = String(path || '').trim();
        if (!value) return '--';
        return value.split(/[\\/]/).filter(Boolean).pop() || value;
      }

      function largeFileCleanupFriendlyRecycleError(error) {
        const message = String(error || '').trim();
        const lower = message.toLowerCase();
        if (!message) return t('home.cleanupLargeFilesPage.recycleFailureUnknown');
        if (lower.includes('access') || lower.includes('permission') || message.includes('拒绝访问') || message.includes('权限')) {
          return t('home.cleanupLargeFilesPage.recycleFailureAccessDenied');
        }
        if (lower.includes('being used') || lower.includes('another process') || lower.includes('in use') || message.includes('另一个程序') || message.includes('进程') || message.includes('占用')) {
          return t('home.cleanupLargeFilesPage.recycleFailureInUse');
        }
        if (lower.includes('no longer exists') || lower.includes('cannot find') || message.includes('找不到') || message.includes('不存在')) {
          return t('home.cleanupLargeFilesPage.recycleFailureMissing');
        }
        if (lower.includes('recycle') || message.includes('回收站')) {
          return t('home.cleanupLargeFilesPage.recycleFailureRecycleUnavailable');
        }
        return message.length > 140 ? `${message.slice(0, 140)}...` : message;
      }

      function largeFileCleanupRenderFailureDetails(result) {
        if (!largeFileCleanupSuccessFailures) return;
        const failedItems = (Array.isArray(result?.items) ? result.items : []).filter(item => !item?.ok);
        if (!failedItems.length) {
          largeFileCleanupSuccessFailures.hidden = true;
          largeFileCleanupSuccessFailures.innerHTML = '';
          return;
        }
        const previewItems = failedItems.slice(0, 3);
        const rows = previewItems.map(item => {
          const name = largeFileCleanupFileNameFromPath(item?.path);
          const reason = largeFileCleanupFriendlyRecycleError(item?.error);
          return `<span title="${escapeAttr(`${name}：${reason}`)}">${escapeHtml(name)}：${escapeHtml(reason)}</span>`;
        });
        const remaining = failedItems.length - previewItems.length;
        if (remaining > 0) {
          rows.push(`<span>${escapeHtml(t('home.cleanupLargeFilesPage.deleteFailureMore', { count: remaining }))}</span>`);
        }
        rows.push(`<span>${escapeHtml(t('home.cleanupLargeFilesPage.deleteFailureHint'))}</span>`);
        largeFileCleanupSuccessFailures.innerHTML = `<strong>${escapeHtml(t('home.cleanupLargeFilesPage.deleteFailureTitle'))}</strong>${rows.join('')}`;
        largeFileCleanupSuccessFailures.hidden = false;
      }

      async function largeFileCleanupDeleteSelected() {
        if (!isTauri) {
          window.showToast?.(getLang() === 'zh' ? '仅支持桌面端清理。' : 'Cleanup is only available in the desktop app.');
          return;
        }
        if (largeFileCleanupBusyState()) return;
        const selected = largeFileCleanupCandidates.filter(item => largeFileCleanupSelectedPaths.has(item.path));
        if (!selected.length) {
          window.showToast?.(getLang() === 'zh' ? '请先勾选要移入回收站的文件。' : 'Please select files before moving them to the Recycle Bin.');
          return;
        }
        const selectedBytes = selected.reduce((sum, item) => sum + Number(item?.size_bytes || 0), 0);
        const confirmMessage = getLang() === 'zh'
          ? `确定将 ${selected.length} 个文件移入回收站吗？\n\n待释放约 ${formatFileSize(selectedBytes)}，清空回收站后才会真正释放磁盘空间。`
          : `Move ${selected.length} selected file(s) to the Recycle Bin?\n\nPending release about ${formatFileSize(selectedBytes)}. Disk space is freed only after emptying the Recycle Bin.`;
        if (!window.confirm(confirmMessage)) return;
        largeFileCleanupSetBusy(true, 'delete');
        try {
          const { invoke } = await tauriCorePromise;
          const result = await invoke('move_files_to_recycle_bin', {
            paths: selected.map(item => item.path)
          });
          const movedPaths = new Set((result?.items || []).filter(item => item?.ok).map(item => item.path));
          const failedPaths = new Set((result?.items || []).filter(item => !item?.ok).map(item => item.path));
          largeFileCleanupCandidates = largeFileCleanupCandidates.filter(item => !movedPaths.has(item.path));
          largeFileCleanupSelectedPaths = failedPaths;
          largeFileCleanupRenderTable();
          if (largeFileCleanupSuccessMeta) {
            largeFileCleanupSuccessMeta.textContent = t('home.cleanupLargeFilesPage.deleteSummary', {
              moved: Number(result?.moved || 0),
              failed: Number(result?.failed || 0),
              size: formatFileSize(Number(result?.freed_bytes || 0))
            });
          }
          largeFileCleanupRenderFailureDetails(result);
          if (largeFileCleanupSuccessAnalyzed) largeFileCleanupSuccessAnalyzed.textContent = String(largeFileCleanupAnalyzeCount());
          if (largeFileCleanupSuccessMoved) largeFileCleanupSuccessMoved.textContent = String(Number(result?.moved || 0));
          if (largeFileCleanupSuccessSize) largeFileCleanupSuccessSize.textContent = formatFileSize(Number(result?.freed_bytes || 0));
          if (largeFileCleanupSuccessFolder) largeFileCleanupSuccessFolder.textContent = t('home.cleanupLargeFilesPage.recycleNextStepValue');
          if (largeFileCleanupSuccessOverlay) largeFileCleanupSuccessOverlay.classList.add('visible');
        } catch (error) {
          console.error('Cleanup delete failed:', error);
          window.showToast?.(error?.message || (getLang() === 'zh' ? '移入回收站失败。' : 'Failed to move files to the Recycle Bin.'));
        } finally {
          largeFileCleanupSetBusy(false);
          largeFileCleanupUpdateSummary();
          largeFileCleanupSyncSelectionUi();
        }
      }

      if (!largeFileCleanupRootPath) {
        const savedFolder = loadLargeFileCleanupFolder();
        if (savedFolder) {
          largeFileCleanupRootPath = savedFolder;
          largeFileCleanupSetFolderLabel(savedFolder);
        }
      }

      largeFileCleanupBack?.addEventListener('click', largeFileCleanupClose);
      largeFileCleanupChooseFolder?.addEventListener('click', chooseLargeFileCleanupFolder);
      largeFileCleanupScanBtn?.addEventListener('click', largeFileCleanupScan);
      largeFileCleanupAiBtn?.addEventListener('click', largeFileCleanupAnalyze);
      largeFileCleanupSelectAllBtn?.addEventListener('click', () => largeFileCleanupSelectAll(true));
      largeFileCleanupClearBtn?.addEventListener('click', () => largeFileCleanupSelectAll(false));
      largeFileCleanupDeleteBtn?.addEventListener('click', largeFileCleanupDeleteSelected);
      largeFileCleanupSelectAllCheckbox?.addEventListener('change', () => largeFileCleanupSelectAll(!!largeFileCleanupSelectAllCheckbox.checked));
      largeFileCleanupModeGroup?.addEventListener('click', largeFileCleanupModeChipHandler);
      largeFileCleanupSuccessOpenFolder?.addEventListener('click', async () => {
        try {
          const { invoke } = await tauriCorePromise;
          await invoke('open_recycle_bin');
        } catch (error) {
          console.error('Open recycle bin failed:', error);
          window.showToast?.(getLang() === 'zh' ? '打开回收站失败，请手动从桌面或资源管理器打开。' : 'Failed to open Recycle Bin. Please open it manually.');
        }
      });
      largeFileCleanupSuccessOk?.addEventListener('click', () => {
        largeFileCleanupSuccessOverlay?.classList.remove('visible');
      });
      largeFileCleanupDriveRootCancel?.addEventListener('click', () => closeLargeFileCleanupDriveRootOverlay(false));
      largeFileCleanupDriveRootConfirm?.addEventListener('click', () => closeLargeFileCleanupDriveRootOverlay(true));
      largeFileCleanupDriveRootOverlay?.querySelector('.ffmpeg-overlay-bg')?.addEventListener('click', () => closeLargeFileCleanupDriveRootOverlay(false));
      if (largeFileCleanupSizeSortMenu && largeFileCleanupSizeSortMenu.parentElement !== document.body) {
        document.body.appendChild(largeFileCleanupSizeSortMenu);
      }
      largeFileCleanupSizeSort?.addEventListener('mouseenter', () => {
        openLargeFileCleanupSizeSortMenu();
      });
      largeFileCleanupSizeSort?.addEventListener('mouseleave', () => {
        closeLargeFileCleanupSizeSortMenu(420);
      });
      largeFileCleanupSizeSortMenu?.addEventListener('mouseenter', () => {
        if (largeFileCleanupSizeSortCloseTimer) {
          clearTimeout(largeFileCleanupSizeSortCloseTimer);
          largeFileCleanupSizeSortCloseTimer = null;
        }
      });
      largeFileCleanupSizeSortMenu?.addEventListener('mouseleave', () => {
        closeLargeFileCleanupSizeSortMenu(420);
      });
      largeFileCleanupSizeSortTrigger?.addEventListener('click', event => {
        event.stopPropagation();
        if (largeFileCleanupSizeSort?.classList.contains('is-open')) {
          closeLargeFileCleanupSizeSortMenu(160);
        } else {
          openLargeFileCleanupSizeSortMenu();
        }
      });
      largeFileCleanupSizeSortMenu?.addEventListener('click', event => {
        const button = event.target.closest('[data-sort]');
        if (!button) return;
        event.stopPropagation();
        setLargeFileCleanupSortMode(button.dataset.sort || 'default');
      });
      document.addEventListener('click', event => {
        if (largeFileCleanupContextMenu?.contains(event.target)) return;
        if (largeFileCleanupSizeSortMenu?.contains(event.target)) return;
        if (largeFileCleanupSizeSort?.contains(event.target)) return;
        closeLargeFileCleanupSizeSortMenu(0);
        hideLargeFileCleanupContextMenu();
      });
      document.addEventListener('keydown', event => {
        if (event.key === 'Escape') {
          closeLargeFileCleanupSizeSortMenu(0);
          hideLargeFileCleanupContextMenu();
          closeLargeFileCleanupHoverToast(0);
        }
      });
      largeFileCleanupOverlay?.addEventListener('scroll', hideLargeFileCleanupContextMenu, { passive: true });
      largeFileCleanupBody?.addEventListener('scroll', hideLargeFileCleanupContextMenu, { passive: true });

      document.querySelectorAll('.audio-list-item[data-tool="large-file-cleanup"]').forEach(item => {
        item.addEventListener('click', () => {
          largeFileCleanupOpen();
        });
        item.addEventListener('keydown', (event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            largeFileCleanupOpen();
          }
        });
      });

      onLangChange(() => {
        if (!largeFileCleanupOverlay?.classList.contains('visible')) return;
        largeFileCleanupSetFolderLabel(largeFileCleanupRootPath);
        largeFileCleanupRenderTable();
        syncLargeFileCleanupSizeSortUi();
        largeFileCleanupRenderAiCard();
      });

      // --- C-drive (system) cleanup ---
      const cDriveCleanupOverlay = document.getElementById('cDriveCleanupOverlay');
      const cDriveCleanupPlasmaBg = document.getElementById('cDriveCleanupPlasmaBg');
      const cDriveCleanupBack = document.getElementById('cDriveCleanupBack');
      const cDriveCleanupOptions = cDriveCleanupOverlay ? Array.from(cDriveCleanupOverlay.querySelectorAll('.c-drive-cleanup-option')) : [];
      const cDriveCleanupExplain = document.getElementById('cDriveCleanupExplain');
      const cDriveCleanupFooterBtn = document.getElementById('cDriveCleanupConfirmBtn');
      const cDriveCleanupAdminMask = document.getElementById('cDriveCleanupAdminMask');
      const cDriveCleanupAdminRelaunch = document.getElementById('cDriveCleanupAdminRelaunch');
      const cDriveCleanupConfirmMask = document.getElementById('cDriveCleanupConfirmMask');
      const cDriveCleanupConfirmTier = document.getElementById('cDriveCleanupConfirmTier');
      const cDriveCleanupConfirmList = document.getElementById('cDriveCleanupConfirmList');
      const cDriveCleanupConfirmConsequences = document.getElementById('cDriveCleanupConfirmConsequences');
      const cDriveCleanupConfirmRun = document.getElementById('cDriveCleanupConfirmRun');
      const cDriveCleanupConfirmCancel = document.getElementById('cDriveCleanupConfirmCancel');

      let cDriveCleanupPlasmaInstance = null;
      let cDriveCleanupSelectedTier = 'low';
      let cDriveCleanupScanData = null;
      let cDriveCleanupScanRunId = 0;
      let cDriveCleanupRunning = false;
      let cDriveCleanupRelaunching = false;
      let cDriveCleanupCountdownTimer = null;

      const CDRIVE_TIER_CONFIG = {
        low: {
          riskKey: 'home.cDriveCleanupPage.tierLow',
          nameKey: 'home.cDriveCleanupPage.tierLowName',
          titleKey: 'home.cDriveCleanupPage.explainLowTitle',
          bodyKey: 'home.cDriveCleanupPage.explainLowBody',
          itemsKey: 'home.cDriveCleanupPage.explainLowItems',
          warnKey: null
        },
        medium: {
          riskKey: 'home.cDriveCleanupPage.tierMedium',
          nameKey: 'home.cDriveCleanupPage.tierMediumName',
          titleKey: 'home.cDriveCleanupPage.explainMediumTitle',
          bodyKey: 'home.cDriveCleanupPage.explainMediumBody',
          itemsKey: 'home.cDriveCleanupPage.explainMediumItems',
          warnKey: null
        },
        high: {
          riskKey: 'home.cDriveCleanupPage.tierHigh',
          nameKey: 'home.cDriveCleanupPage.tierHighName',
          titleKey: 'home.cDriveCleanupPage.explainHighTitle',
          bodyKey: 'home.cDriveCleanupPage.explainHighBody',
          itemsKey: 'home.cDriveCleanupPage.explainHighItems',
          warnKey: 'home.cDriveCleanupPage.explainHighWarn'
        }
      };

      async function cDriveCleanupInvoke(name, args) {
        if (!isTauri) throw new Error('desktop-only');
        const { invoke } = await tauriCorePromise;
        return args === undefined ? invoke(name) : invoke(name, args);
      }

      function cDriveCleanupTierSummary(tier) {
        if (!cDriveCleanupScanData || !Array.isArray(cDriveCleanupScanData.tiers)) return null;
        return cDriveCleanupScanData.tiers.find(item => item.tier === tier) || null;
      }

      function cDriveCleanupSplitItems(text) {
        return String(text || '').split(/[、,，]/).map(item => item.trim()).filter(Boolean);
      }

      function cDriveCleanupRenderSizes() {
        cDriveCleanupOptions.forEach(button => {
          const summary = cDriveCleanupTierSummary(button.dataset.tier);
          const sizeEl = button.querySelector('.c-drive-cleanup-option-size');
          if (!sizeEl) return;
          if (summary) {
            button.classList.add('is-scanned');
            sizeEl.innerHTML = `<b>${escapeHtml(t('home.cDriveCleanupPage.estimate', { size: formatFileSize(summary.bytes || 0) }))}</b>`;
          } else {
            button.classList.remove('is-scanned');
            sizeEl.innerHTML = `<i class="c-drive-cleanup-spinner" aria-hidden="true"></i><span>${escapeHtml(t('home.cDriveCleanupPage.scanning'))}</span>`;
          }
        });
      }

      function cDriveCleanupRenderExplain() {
        if (!cDriveCleanupExplain) return;
        const config = CDRIVE_TIER_CONFIG[cDriveCleanupSelectedTier] || CDRIVE_TIER_CONFIG.low;
        const items = cDriveCleanupSplitItems(t(config.itemsKey));
        const chips = items.map(item => `<span class="c-drive-cleanup-explain-item">${escapeHtml(item)}</span>`).join('');
        const warn = config.warnKey
          ? `<div class="c-drive-cleanup-explain-warn"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg><span>${escapeHtml(t(config.warnKey))}</span></div>`
          : '';
        cDriveCleanupExplain.innerHTML = `
          <div class="c-drive-cleanup-explain-head">
            <span class="c-drive-cleanup-option-risk c-drive-cleanup-risk-${cDriveCleanupSelectedTier}">${escapeHtml(t(config.riskKey))}</span>
            <h2 class="c-drive-cleanup-explain-title">${escapeHtml(t(config.titleKey))}</h2>
          </div>
          <p class="c-drive-cleanup-explain-body">${escapeHtml(t(config.bodyKey))}</p>
          <div class="c-drive-cleanup-explain-items">${chips}</div>
          ${warn}`;
      }

      function cDriveCleanupSelect(tier) {
        cDriveCleanupSelectedTier = tier;
        cDriveCleanupOptions.forEach(button => {
          const active = button.dataset.tier === tier;
          button.setAttribute('aria-checked', active ? 'true' : 'false');
        });
        cDriveCleanupRenderExplain();
        if (cDriveCleanupFooterBtn) {
          cDriveCleanupFooterBtn.disabled = cDriveCleanupRunning || !cDriveCleanupTierSummary(tier);
        }
      }

      function cDriveCleanupShowAdminMask() {
        cDriveCleanupAdminMask?.classList.add('visible');
        cDriveCleanupAdminMask?.setAttribute('aria-hidden', 'false');
      }

      function cDriveCleanupHideAdminMask() {
        cDriveCleanupAdminMask?.classList.remove('visible');
        cDriveCleanupAdminMask?.setAttribute('aria-hidden', 'true');
      }

      function cDriveCleanupSetRelaunching(value) {
        cDriveCleanupRelaunching = Boolean(value);
        if (!cDriveCleanupAdminRelaunch) return;
        cDriveCleanupAdminRelaunch.disabled = cDriveCleanupRelaunching;
        cDriveCleanupAdminRelaunch.textContent = t(cDriveCleanupRelaunching
          ? 'home.cDriveCleanupPage.adminRelaunching'
          : 'home.cDriveCleanupPage.adminRelaunch');
      }

      function cDriveCleanupErrorCode(error) {
        return String(error?.message || error || '');
      }

      function cDriveCleanupAdminErrorMessage(error, fallbackKey) {
        const code = cDriveCleanupErrorCode(error);
        if (code.includes('system-cleanup:uac-cancelled')) {
          return t('home.cDriveCleanupPage.adminUacCancelled');
        }
        if (code.includes('system-cleanup:admin-check-failed')) {
          return t('home.cDriveCleanupPage.adminCheckFailed');
        }
        return t(fallbackKey);
      }

      function cDriveCleanupClearCountdown() {
        if (cDriveCleanupCountdownTimer) {
          clearTimeout(cDriveCleanupCountdownTimer);
          cDriveCleanupCountdownTimer = null;
        }
      }

      function cDriveCleanupCloseConfirm() {
        cDriveCleanupClearCountdown();
        if (cDriveCleanupConfirmRun) {
          cDriveCleanupConfirmRun.disabled = true;
          cDriveCleanupConfirmRun.textContent = t('home.cDriveCleanupPage.confirmCountdown', { n: 5 });
        }
        cDriveCleanupConfirmMask?.classList.remove('visible');
        cDriveCleanupConfirmMask?.setAttribute('aria-hidden', 'true');
      }

      function cDriveCleanupStartCountdown() {
        cDriveCleanupClearCountdown();
        let remaining = 5;
        const update = () => {
          if (remaining <= 0) {
            if (cDriveCleanupConfirmRun) {
              cDriveCleanupConfirmRun.disabled = false;
              cDriveCleanupConfirmRun.textContent = t('home.cDriveCleanupPage.confirmReady');
            }
            cDriveCleanupCountdownTimer = null;
            return;
          }
          if (cDriveCleanupConfirmRun) {
            cDriveCleanupConfirmRun.disabled = true;
            cDriveCleanupConfirmRun.textContent = t('home.cDriveCleanupPage.confirmCountdown', { n: remaining });
          }
          remaining -= 1;
          cDriveCleanupCountdownTimer = setTimeout(update, 1000);
        };
        update();
      }

      function cDriveCleanupOpenConfirm() {
        const config = CDRIVE_TIER_CONFIG[cDriveCleanupSelectedTier] || CDRIVE_TIER_CONFIG.low;
        const items = cDriveCleanupSplitItems(t(config.itemsKey));
        if (cDriveCleanupConfirmTier) cDriveCleanupConfirmTier.textContent = t(config.nameKey);
        if (cDriveCleanupConfirmList) {
          cDriveCleanupConfirmList.innerHTML = items.map(item => `<span>${escapeHtml(item)}</span>`).join('');
        }
        if (cDriveCleanupConfirmConsequences) {
          if (config.warnKey) {
            cDriveCleanupConfirmConsequences.textContent = t(config.warnKey);
            cDriveCleanupConfirmConsequences.hidden = false;
          } else {
            cDriveCleanupConfirmConsequences.hidden = true;
          }
        }
        cDriveCleanupConfirmMask?.classList.add('visible');
        cDriveCleanupConfirmMask?.setAttribute('aria-hidden', 'false');
        cDriveCleanupStartCountdown();
      }

      async function cDriveCleanupStartScan() {
        const runId = ++cDriveCleanupScanRunId;
        cDriveCleanupScanData = null;
        cDriveCleanupRenderSizes();
        if (cDriveCleanupFooterBtn) cDriveCleanupFooterBtn.disabled = true;
        try {
          const isAdmin = await cDriveCleanupInvoke('system_cleanup_is_admin');
          if (runId !== cDriveCleanupScanRunId) return;
          if (isAdmin === false) {
            cDriveCleanupShowAdminMask();
            return;
          }
          if (isAdmin !== true) {
            throw new Error('system-cleanup:admin-check-failed:invalid-response');
          }
          cDriveCleanupHideAdminMask();

          const data = await cDriveCleanupInvoke('system_cleanup_scan');
          if (runId !== cDriveCleanupScanRunId) return;
          cDriveCleanupScanData = data || null;
          if (data && data.is_admin === false) {
            cDriveCleanupShowAdminMask();
            return;
          }
          if (!data || data.is_admin !== true) {
            throw new Error('system-cleanup:admin-check-failed:invalid-scan-response');
          }
          cDriveCleanupRenderSizes();
          cDriveCleanupSelect(cDriveCleanupSelectedTier);
        } catch (error) {
          if (runId !== cDriveCleanupScanRunId) return;
          console.error('C-drive cleanup scan failed:', error);
          window.showToast?.(cDriveCleanupAdminErrorMessage(error, 'home.cDriveCleanupPage.scanFailed'));
        }
      }

      async function cDriveCleanupRunSelected() {
        if (cDriveCleanupRunning) return;
        const tier = cDriveCleanupSelectedTier;
        cDriveCleanupRunning = true;
        if (cDriveCleanupFooterBtn) cDriveCleanupFooterBtn.disabled = true;
        if (cDriveCleanupConfirmRun) {
          cDriveCleanupConfirmRun.disabled = true;
          cDriveCleanupConfirmRun.textContent = t('home.cDriveCleanupPage.cleaning');
        }
        try {
          const result = await cDriveCleanupInvoke('system_cleanup_run', { tier });
          cDriveCleanupCloseConfirm();
          window.showToast?.(t('home.cDriveCleanupPage.cleaningDone', { size: formatFileSize(result?.freed_bytes || 0) }));
          await cDriveCleanupStartScan();
        } catch (error) {
          console.error('C-drive cleanup run failed:', error);
          cDriveCleanupCloseConfirm();
          const code = cDriveCleanupErrorCode(error);
          if (code.includes('system-cleanup:admin-required')) {
            cDriveCleanupShowAdminMask();
            window.showToast?.(t('home.cDriveCleanupPage.adminRequiredAgain'));
          } else {
            window.showToast?.(cDriveCleanupAdminErrorMessage(error, 'home.cDriveCleanupPage.cleaningFailed'));
          }
        } finally {
          cDriveCleanupRunning = false;
          if (cDriveCleanupFooterBtn) {
            cDriveCleanupFooterBtn.disabled = !cDriveCleanupTierSummary(cDriveCleanupSelectedTier);
          }
        }
      }

      function cDriveCleanupOpen() {
        if (!cDriveCleanupOverlay) return;
        cDriveCleanupSetRelaunching(false);
        cDriveCleanupHideAdminMask();
        cDriveCleanupOverlay.classList.add('visible');
        cDriveCleanupOverlay.setAttribute('aria-hidden', 'false');
        if (cDriveCleanupPlasmaBg && !cDriveCleanupPlasmaInstance) {
          cDriveCleanupPlasmaInstance = initStandardToolPlasma(cDriveCleanupPlasmaBg);
        }
        cDriveCleanupSelectedTier = 'low';
        cDriveCleanupSelect('low');
        cDriveCleanupStartScan();
      }

      function cDriveCleanupClose() {
        if (cDriveCleanupRunning) {
          window.showToast?.(getLang() === 'zh' ? '正在清理，请稍后再关闭。' : 'Please wait until cleanup finishes.');
          return;
        }
        cDriveCleanupCloseConfirm();
        cDriveCleanupHideAdminMask();
        if (!cDriveCleanupOverlay) return;
        cDriveCleanupOverlay.classList.remove('visible');
        cDriveCleanupOverlay.setAttribute('aria-hidden', 'true');
        if (cDriveCleanupPlasmaInstance) {
          cDriveCleanupPlasmaInstance();
          cDriveCleanupPlasmaInstance = null;
        }
      }

      cDriveCleanupBack?.addEventListener('click', cDriveCleanupClose);
      cDriveCleanupOptions.forEach(button => {
        button.addEventListener('click', () => cDriveCleanupSelect(button.dataset.tier));
      });
      cDriveCleanupFooterBtn?.addEventListener('click', cDriveCleanupOpenConfirm);
      cDriveCleanupConfirmCancel?.addEventListener('click', cDriveCleanupCloseConfirm);
      cDriveCleanupConfirmRun?.addEventListener('click', cDriveCleanupRunSelected);
      cDriveCleanupAdminRelaunch?.addEventListener('click', async () => {
        if (cDriveCleanupRelaunching) return;
        cDriveCleanupSetRelaunching(true);
        try {
          const relaunchStarted = await cDriveCleanupInvoke('system_cleanup_relaunch_as_admin');
          if (relaunchStarted === false) {
            cDriveCleanupSetRelaunching(false);
            cDriveCleanupHideAdminMask();
            await cDriveCleanupStartScan();
          }
        } catch (error) {
          cDriveCleanupSetRelaunching(false);
          console.error('Relaunch as admin failed:', error);
          window.showToast?.(cDriveCleanupAdminErrorMessage(error, 'home.cDriveCleanupPage.adminRelaunchFailed'));
        }
      });
      document.querySelectorAll('.audio-list-item[data-tool="c-drive-cleanup"]').forEach(item => {
        item.addEventListener('click', cDriveCleanupOpen);
        item.addEventListener('keydown', event => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            cDriveCleanupOpen();
          }
        });
      });

      onLangChange(() => {
        if (!cDriveCleanupOverlay?.classList.contains('visible')) return;
        cDriveCleanupRenderSizes();
        cDriveCleanupRenderExplain();
        cDriveCleanupSetRelaunching(cDriveCleanupRelaunching);
        if (cDriveCleanupConfirmMask?.classList.contains('visible') && cDriveCleanupConfirmRun?.disabled) {
          cDriveCleanupStartCountdown();
        }
      });

      // Click on audio-list-item with data-tool="convert" to open the convert page
      document.querySelectorAll('.audio-list-item[data-tool="convert"]').forEach(item => {
        item.addEventListener('click', () => {
          openToolWithFfmpegCheck(openAudioConvertOverlay);
        });
        item.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            openToolWithFfmpegCheck(openAudioConvertOverlay);
          }
        });
      });

      // Audio Convert drag & drop / files / processing
      const audioConvertDropZone = document.getElementById('audioConvertDropZone');
      const audioConvertFiles = document.getElementById('audioConvertFiles');
      const audioConvertCta = document.getElementById('audioConvertCta');
      const audioConvertProcessBtn = document.getElementById('audioConvertProcessBtn');
      const audioConvertProcessMask = document.getElementById('audioConvertProcessMask');
      const audioConvertProcessBarFill = document.getElementById('audioConvertProcessBarFill');
      const audioConvertProcessText = document.getElementById('audioConvertProcessText');
      const audioConvertCancelBtn = document.getElementById('audioConvertCancelBtn');
      let selectedAudioFiles = [];
      let processingAudio = false;
      let targetAudioFormat = 'MP3';
      let audioConversionRunId = 0;
      let audioConvertUnlisten = null;
      const audioConvertSuccessOverlay = document.getElementById('audioConvertSuccessOverlay');
      const audioConvertSuccessPath = document.getElementById('audioConvertSuccessPath');
      const audioConvertSuccessMeta = document.getElementById('audioConvertSuccessMeta');
      const audioConvertSuccessFormat = document.getElementById('audioConvertSuccessFormat');
      const audioConvertSuccessCount = document.getElementById('audioConvertSuccessCount');
      const audioConvertOpenFolder = document.getElementById('audioConvertOpenFolder');
      const audioConvertSuccessOk = document.getElementById('audioConvertSuccessOk');
      const audioConvertFormatOptions = document.getElementById('audioConvertFormatOptions');

      function addAudioFiles(fileList) {
        if (!fileList || fileList.length === 0) return;
        const nextFiles = [...selectedAudioFiles];
        for (const file of fileList) {
          // Deduplicate by path (preferred) or name+size fallback
          const dup = file.path
            ? nextFiles.some(f => f.path === file.path)
            : nextFiles.some(f => f.name === file.name && f.size === file.size);
          if (dup) continue;
          nextFiles.push(file);
        }
        try {
          validateAudioBatchSelection(nextFiles);
        } catch (error) {
          console.error('Audio selection validation failed:', error);
          alert(error instanceof AudioConvertError ? error.message : t('home.audioConvert.conversionError'));
          return;
        }
        selectedAudioFiles = nextFiles;
        renderAudioFiles();
      }

      function removeAudioFile(index) {
        selectedAudioFiles.splice(index, 1);
        renderAudioFiles();
      }

      function clearAudioFiles() {
        selectedAudioFiles = [];
        renderAudioFiles();
      }

      function renderAudioFiles() {
        if (!audioConvertFiles) return;
        audioConvertFiles.innerHTML = '';
        if (selectedAudioFiles.length > 0) {
          audioConvertFiles.classList.add('has-files');
        } else {
          audioConvertFiles.classList.remove('has-files');
        }
        selectedAudioFiles.forEach((file, index) => {
          const item = document.createElement('div');
          item.className = 'audio-convert-file-item';
          item.dataset.index = index;
          const sizeText = Number(file.size) > 0 ? formatFileSize(file.size) : '';
          item.innerHTML = `
            <span class="audio-convert-file-index">${index + 1}</span>
            <span class="audio-convert-file-name">${escapeHtml(file.name)}</span>
            ${sizeText ? `<span class="audio-convert-file-size">${escapeHtml(sizeText)}</span>` : ''}
            <button class="audio-convert-file-remove" data-index="${index}" aria-label="remove">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
            </button>
          `;
          audioConvertFiles.appendChild(item);
        });
        audioConvertFiles.querySelectorAll('.audio-convert-file-remove').forEach(btn => {
          btn.addEventListener('click', () => {
            const idx = parseInt(btn.dataset.index, 10);
            if (!isNaN(idx)) removeAudioFile(idx);
          });
        });
        enableSortableFileList(audioConvertFiles, selectedAudioFiles, renderAudioFiles, () => processingAudio);
        toggleAudioProcessButton();
      }

      function toggleAudioProcessButton() {
        if (!audioConvertProcessBtn) return;
        if (selectedAudioFiles.length > 0) {
          audioConvertProcessBtn.style.display = '';
          requestAnimationFrame(() => audioConvertProcessBtn.classList.add('visible'));
        } else {
          audioConvertProcessBtn.classList.remove('visible');
          const onTransitionEnd = (e) => {
            if (e.propertyName === 'opacity' && !audioConvertProcessBtn.classList.contains('visible')) {
              audioConvertProcessBtn.style.display = 'none';
              audioConvertProcessBtn.removeEventListener('transitionend', onTransitionEnd);
            }
          };
          audioConvertProcessBtn.addEventListener('transitionend', onTransitionEnd);
        }
      }

      function showAudioDropZone() {
        if (audioConvertDropZone) audioConvertDropZone.classList.add('visible');
        if (audioConvertOverlay) audioConvertOverlay.classList.add('drag-over');
      }

      function hideAudioDropZone() {
        if (audioConvertDropZone) audioConvertDropZone.classList.remove('visible');
        if (audioConvertOverlay) audioConvertOverlay.classList.remove('drag-over');
      }

      // Tauri native drag-drop events — provides file paths
      // Must use getCurrentWebview (not getCurrentWindow) because drag-drop
      // events are emitted at the Webview level, not the Window level.
      if (isTauri && audioConvertOverlay) {
        (async () => {
          const { getCurrentWebview } = await import('@tauri-apps/api/webview');
          const webview = getCurrentWebview();
          await webview.onDragDropEvent((event) => {
            if (!audioConvertOverlay.classList.contains('visible') || processingAudio) return;
            const payload = event.payload;
            if (payload.type === 'enter' || payload.type === 'over') {
              showAudioDropZone();
            } else if (payload.type === 'leave') {
              hideAudioDropZone();
            } else if (payload.type === 'drop') {
              hideAudioDropZone();
              const paths = payload.paths || [];
              if (paths.length === 0) return;
              const audioExts = ['mp3', 'aac', 'm4a', 'wav', 'flac', 'alac', 'ogg', 'wma'];
              const fileList = paths
                .filter(p => audioExts.some(ext => p.toLowerCase().endsWith('.' + ext)))
                .map(path => ({ name: path.split(/[\\/]/).pop() || path, path, size: 0 }));
              if (fileList.length > 0) {
                addAudioFiles(fileList);
              }
            }
          });
        })();
      }

      if (audioConvertCta) {
        audioConvertCta.addEventListener('click', async () => {
          if (isTauri) {
            try {
              const { open } = await import('@tauri-apps/plugin-dialog');
              const selected = await open({
                multiple: true,
                filters: [{
                  name: 'Audio Files',
                  extensions: ['mp3', 'aac', 'm4a', 'wav', 'flac', 'alac', 'ogg', 'wma']
                }]
              });
              if (selected && Array.isArray(selected)) {
                const fileList = selected.map(path => ({ name: path.split(/[\\/]/).pop() || path, path, size: 0 }));
                addAudioFiles(fileList);
              }
            } catch (e) {
              console.error('Audio file selection error', e);
            }
          } else {
            const input = document.createElement('input');
            input.type = 'file';
            input.multiple = true;
            input.accept = 'audio/*';
            input.addEventListener('change', () => {
              addAudioFiles(input.files);
              input.value = '';
            });
            input.click();
          }
        });
      }

      function showSuccessDialog(result) {
        const outputPath = result?.output_dir || (isTauri
          ? 'C:\\Users\\Downloads\\toolknit-converted'
          : '~/Downloads/toolknit-converted');
        const successCount = result?.success_count ?? selectedAudioFiles.length;
        const failCount = result?.fail_count ?? 0;
        const firstFileName = selectedAudioFiles[0]?.name || '';

        // All files failed — show error alert instead of success dialog
        if (failCount > 0 && successCount === 0) {
          const errorDetails = result?.errors?.length > 0
            ? result.errors.slice(0, 3).join('\n')
            : '';
          alert(t('home.audioConvert.allFailed', { count: failCount }) + (errorDetails ? '\n\n' + errorDetails : ''));
          return;
        }

        let summary;
        if (failCount > 0 && successCount > 0) {
          summary = t('home.audioConvert.successSummaryPartial', { success: successCount, fail: failCount, format: targetAudioFormat });
        } else if (successCount > 1) {
          summary = t('home.audioConvert.successSummaryPlural', { count: successCount, format: targetAudioFormat });
        } else {
          summary = t('home.audioConvert.successSummarySingle', { name: firstFileName, format: targetAudioFormat });
        }
        if (audioConvertSuccessMeta) {
          audioConvertSuccessMeta.textContent = summary;
        }
        if (audioConvertSuccessFormat) {
          audioConvertSuccessFormat.textContent = targetAudioFormat;
        }
        if (audioConvertSuccessCount) {
          audioConvertSuccessCount.textContent = `${successCount} ${t('home.audioConvert.successCountUnit')}`;
        }
        if (audioConvertSuccessPath) {
          audioConvertSuccessPath.textContent = displayFilesystemPath(outputPath);
        }
        lastOutputPath = outputPath;
        if (audioConvertSuccessOverlay) {
          audioConvertSuccessOverlay.classList.add('visible');
        }
      }

      function closeSuccessDialog() {
        if (audioConvertSuccessOverlay) {
          audioConvertSuccessOverlay.classList.remove('visible');
        }
        clearAudioFiles();
      }

      if (audioConvertCancelBtn) {
        audioConvertCancelBtn.addEventListener('click', cancelActiveAudioConversion);
      }

      function cancelActiveAudioConversion() {
        const wasProcessing = processingAudio;
        audioConversionRunId += 1;
        if (audioConvertUnlisten) {
          audioConvertUnlisten();
          audioConvertUnlisten = null;
        }
        if (audioConvertProcessMask) audioConvertProcessMask.classList.remove('visible');
        if (audioConvertProcessBarFill) audioConvertProcessBarFill.style.width = '0%';
        processingAudio = false;
        if (isTauri && wasProcessing) {
          tauriCorePromise
            .then(({ invoke }) => invoke('cancel_convert'))
            .catch((error) => console.error('Cancel failed:', error));
        }
      }

      async function startAudioProcessing() {
        if (!audioConvertProcessMask || !audioConvertProcessBarFill || processingAudio) return;
        if (selectedAudioFiles.length === 0) return;
        try {
          validateAudioBatchSelection(selectedAudioFiles);
          targetAudioFormat = normalizeAudioTargetFormat(targetAudioFormat);
        } catch (error) {
          alert(error instanceof AudioConvertError ? error.message : t('home.audioConvert.conversionError'));
          return;
        }
        const runId = ++audioConversionRunId;
        processingAudio = true;
        audioConvertProcessMask.classList.add('visible');
        audioConvertProcessBarFill.style.width = '0%';

        if (isTauri) {
          let unlisten = null;
          try {
            const { invoke } = await tauriCorePromise;
            const { listen } = await tauriEventPromise;

            const finalOutputDir = await getOutputDir('Audio');

            // Collect file paths from selectedAudioFiles
            const inputPaths = selectedAudioFiles.map(f => f.path).filter(Boolean);
            if (inputPaths.length === 0) {
              console.error('No valid file paths were found in the audio selection.');
              if (runId === audioConversionRunId) {
                audioConvertProcessMask.classList.remove('visible');
                processingAudio = false;
              }
              alert(t('common.filePathsNotAvailable'));
              return;
            }

            let currentFile = 0;
            const totalFiles = inputPaths.length;

            // Ensure ffmpeg is available (prompt user to download if missing)
            const ffmpegReady = await ensureFfmpegAvailable();
            if (!ffmpegReady) {
              if (runId === audioConversionRunId) {
                audioConvertProcessMask.classList.remove('visible');
                processingAudio = false;
              }
              return;
            }

            unlisten = await listen('convert-progress', (event) => {
              if (runId !== audioConversionRunId) return;
              const data = event.payload;
              if (data.status === 'converting') {
                currentFile = data.current;
                const fileProgress = (data.current - 1 + data.progress) / data.total;
                const percent = Math.min(99, Math.round(fileProgress * 100));
                audioConvertProcessBarFill.style.width = `${percent}%`;
                if (audioConvertProcessText) {
                  audioConvertProcessText.textContent = `${t('home.audioConvert.processing')} (${data.current}/${data.total})`;
                }
              }
            });
            if (runId !== audioConversionRunId) {
              unlisten();
              return;
            }
            audioConvertUnlisten = unlisten;

            const result = await invoke('convert_audio_batch', {
              inputPaths: inputPaths,
              outputDir: finalOutputDir,
              targetFormat: targetAudioFormat,
              quality: null
            });

            unlisten();
            if (audioConvertUnlisten === unlisten) audioConvertUnlisten = null;
            if (runId !== audioConversionRunId) return;
            audioConvertProcessBarFill.style.width = '100%';

            setTimeout(() => {
              if (runId !== audioConversionRunId) return;
              audioConvertProcessMask.classList.remove('visible');
              audioConvertProcessBarFill.style.width = '0%';
              processingAudio = false;
              showSuccessDialog(result);
            }, 400);
          } catch (e) {
            console.error('Conversion failed:', e);
            if (unlisten) unlisten();
            if (audioConvertUnlisten === unlisten) audioConvertUnlisten = null;
            if (runId !== audioConversionRunId) return;
            audioConvertProcessMask.classList.remove('visible');
            audioConvertProcessBarFill.style.width = '0%';
            processingAudio = false;
            if (audioConvertProcessText) {
              audioConvertProcessText.textContent = t('home.audioConvert.processing');
            }
            alert(t('common.errorOccurred', { error: e?.message || e }));
          }
        } else {
          audioConvertProcessMask.classList.remove('visible');
          audioConvertProcessBarFill.style.width = '0%';
          processingAudio = false;
          alert(t('home.audioConvert.desktopOnly'));
        }
      }

      if (audioConvertProcessBtn) {
        audioConvertProcessBtn.addEventListener('click', () => {
          if (selectedAudioFiles.length > 0) startAudioProcessing();
        });
      }

      if (audioConvertSuccessOk) {
        audioConvertSuccessOk.addEventListener('click', () => {
          closeSuccessDialog();
        });
      }

      let lastOutputPath = '';
      if (audioConvertOpenFolder) {
        audioConvertOpenFolder.addEventListener('click', () => {
          if (isTauri && lastOutputPath) {
            openOutputFolder(lastOutputPath).catch(e => console.error('Open folder error', e));
          }
          closeSuccessDialog();
        });
      }

      if (audioConvertFormatOptions) {
        audioConvertFormatOptions.addEventListener('click', (e) => {
          const btn = e.target.closest('.audio-convert-format-option');
          if (!btn) return;
          audioConvertFormatOptions.querySelectorAll('.audio-convert-format-option').forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
          targetAudioFormat = normalizeAudioTargetFormat(btn.dataset.format);
        });
      }

      function escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
      }

      function escapeAttr(text) {
        return escapeHtml(text).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
      }

      function enableSortableFileList(container, files, render, isLocked = () => false) {
        if (!container || !Array.isArray(files)) return;
        const rows = Array.from(container.querySelectorAll(':scope > .audio-convert-file-item'));
        let draggingIndex = -1;
        rows.forEach((row, index) => {
          row.dataset.sortIndex = String(index);
          row.draggable = files.length > 1 && !isLocked();
          row.classList.toggle('is-sortable', row.draggable);
          row.addEventListener('dragstart', event => {
            const targetElement = event.target instanceof Element ? event.target : null;
            if (!row.draggable || targetElement?.closest('button, input, select, textarea, a')) {
              event.preventDefault();
              return;
            }
            draggingIndex = index;
            row.classList.add('dragging');
            event.dataTransfer?.setData('text/plain', String(index));
            if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
          });
          row.addEventListener('dragend', () => {
            draggingIndex = -1;
            rows.forEach(item => item.classList.remove('dragging', 'drag-target'));
          });
          row.addEventListener('dragover', event => {
            if (draggingIndex < 0 || isLocked()) return;
            event.preventDefault();
            rows.forEach(item => item.classList.remove('drag-target'));
            if (draggingIndex !== index) row.classList.add('drag-target');
            if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
          });
          row.addEventListener('drop', event => {
            if (draggingIndex < 0 || isLocked()) return;
            event.preventDefault();
            const from = draggingIndex;
            const to = Number(row.dataset.sortIndex);
            if (!Number.isInteger(to) || from === to || from < 0 || from >= files.length || to < 0 || to >= files.length) {
              rows.forEach(item => item.classList.remove('dragging', 'drag-target'));
              return;
            }
            const [moved] = files.splice(from, 1);
            files.splice(to, 0, moved);
            render();
          });
        });
      }

      // ===== Video Convert Tool =====
      const videoConvertOverlay = document.getElementById('videoConvertOverlay');
      const videoConvertBack = document.getElementById('videoConvertBack');
      const videoConvertPlasmaBg = document.getElementById('videoConvertPlasmaBg');
      let videoConvertPlasmaInstance = null;

      function openVideoConvertOverlay() {
        if (!videoConvertOverlay) return;
        videoConvertOverlay.classList.add('visible');
        if (videoConvertPlasmaBg && !videoConvertPlasmaInstance) {
          videoConvertPlasmaInstance = initStandardToolPlasma(videoConvertPlasmaBg);
        }
      }

      function closeVideoConvertOverlay() {
        if (!videoConvertOverlay) return;
        cancelActiveVideoConversion();
        videoConvertOverlay.classList.remove('visible');
        if (videoConvertPlasmaInstance) { videoConvertPlasmaInstance(); videoConvertPlasmaInstance = null; }
        clearVideoFiles();
      }

      if (videoConvertBack) videoConvertBack.addEventListener('click', closeVideoConvertOverlay);

      document.querySelectorAll('.audio-list-item[data-tool="video-convert"]').forEach(item => {
        item.addEventListener('click', () => openToolWithFfmpegCheck(openVideoConvertOverlay));
        item.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openToolWithFfmpegCheck(openVideoConvertOverlay); }
        });
      });

      const videoConvertDropZone = document.getElementById('videoConvertDropZone');
      const videoConvertFiles = document.getElementById('videoConvertFiles');
      const videoConvertCta = document.getElementById('videoConvertCta');
      const videoConvertProcessBtn = document.getElementById('videoConvertProcessBtn');
      const videoConvertProcessMask = document.getElementById('videoConvertProcessMask');
      const videoConvertProcessBarFill = document.getElementById('videoConvertProcessBarFill');
      const videoConvertProcessText = document.getElementById('videoConvertProcessText');
      const videoConvertCancelBtn = document.getElementById('videoConvertCancelBtn');
      let selectedVideoFiles = [];
      let processingVideo = false;
      let targetVideoFormat = 'MP4';
      let videoConversionRunId = 0;
      let videoConvertUnlisten = null;
      const videoConvertSuccessOverlay = document.getElementById('videoConvertSuccessOverlay');
      const videoConvertSuccessPath = document.getElementById('videoConvertSuccessPath');
      const videoConvertSuccessMeta = document.getElementById('videoConvertSuccessMeta');
      const videoConvertSuccessFormat = document.getElementById('videoConvertSuccessFormat');
      const videoConvertSuccessCount = document.getElementById('videoConvertSuccessCount');
      const videoConvertOpenFolder = document.getElementById('videoConvertOpenFolder');
      const videoConvertSuccessOk = document.getElementById('videoConvertSuccessOk');
      const videoConvertFormatOptions = document.getElementById('videoConvertFormatOptions');
      const videoExts = ['mp4', 'avi', 'mkv', 'mov', 'webm', 'flv', 'wmv', 'ts', 'm4v'];

      function addVideoFiles(fileList) {
        if (!fileList || fileList.length === 0) return;
        const nextFiles = [...selectedVideoFiles];
        for (const file of fileList) {
          const dup = file.path
            ? nextFiles.some(f => f.path === file.path)
            : nextFiles.some(f => f.name === file.name && f.size === file.size);
          if (dup) continue;
          nextFiles.push(file);
        }
        try {
          validateVideoBatchSelection(nextFiles);
        } catch (error) {
          console.error('Video selection validation failed:', error);
          alert(t('home.videoConvert.selectionError', {
            error: error instanceof VideoConvertError ? error.message : t('home.videoConvert.conversionError')
          }));
          return;
        }
        selectedVideoFiles = nextFiles;
        renderVideoFiles();
      }

      function removeVideoFile(index) { selectedVideoFiles.splice(index, 1); renderVideoFiles(); }
      function clearVideoFiles() { selectedVideoFiles = []; renderVideoFiles(); }

      function renderVideoFiles() {
        if (!videoConvertFiles) return;
        videoConvertFiles.innerHTML = '';
        if (selectedVideoFiles.length > 0) videoConvertFiles.classList.add('has-files');
        else videoConvertFiles.classList.remove('has-files');
        selectedVideoFiles.forEach((file, index) => {
          const item = document.createElement('div');
          item.className = 'audio-convert-file-item';
          item.dataset.index = index;
          const sizeText = Number(file.size) > 0 ? formatFileSize(file.size) : '';
          item.innerHTML = `
            <span class="audio-convert-file-index">${index + 1}</span>
            <span class="audio-convert-file-name">${escapeHtml(file.name)}</span>
            ${sizeText ? `<span class="audio-convert-file-size">${escapeHtml(sizeText)}</span>` : ''}
            <button class="audio-convert-file-remove" data-index="${index}" aria-label="remove">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
            </button>
          `;
          videoConvertFiles.appendChild(item);
        });
        videoConvertFiles.querySelectorAll('.audio-convert-file-remove').forEach(btn => {
          btn.addEventListener('click', () => { const idx = parseInt(btn.dataset.index, 10); if (!isNaN(idx)) removeVideoFile(idx); });
        });
        enableSortableFileList(videoConvertFiles, selectedVideoFiles, renderVideoFiles, () => processingVideo);
        toggleVideoProcessButton();
      }

      function toggleVideoProcessButton() {
        if (!videoConvertProcessBtn) return;
        if (selectedVideoFiles.length > 0) {
          videoConvertProcessBtn.style.display = '';
          requestAnimationFrame(() => videoConvertProcessBtn.classList.add('visible'));
        } else {
          videoConvertProcessBtn.classList.remove('visible');
          const onTransitionEnd = (e) => {
            if (e.propertyName === 'opacity' && !videoConvertProcessBtn.classList.contains('visible')) {
              videoConvertProcessBtn.style.display = 'none';
              videoConvertProcessBtn.removeEventListener('transitionend', onTransitionEnd);
            }
          };
          videoConvertProcessBtn.addEventListener('transitionend', onTransitionEnd);
        }
      }

      function showVideoDropZone() {
        if (videoConvertDropZone) videoConvertDropZone.classList.add('visible');
        if (videoConvertOverlay) videoConvertOverlay.classList.add('drag-over');
      }
      function hideVideoDropZone() {
        if (videoConvertDropZone) videoConvertDropZone.classList.remove('visible');
        if (videoConvertOverlay) videoConvertOverlay.classList.remove('drag-over');
      }

      if (isTauri && videoConvertOverlay) {
        (async () => {
          const { getCurrentWebview } = await import('@tauri-apps/api/webview');
          const webview = getCurrentWebview();
          await webview.onDragDropEvent((event) => {
            if (!videoConvertOverlay.classList.contains('visible') || processingVideo) return;
            const payload = event.payload;
            if (payload.type === 'enter' || payload.type === 'over') showVideoDropZone();
            else if (payload.type === 'leave') hideVideoDropZone();
            else if (payload.type === 'drop') {
              hideVideoDropZone();
              const paths = payload.paths || [];
              if (paths.length === 0) return;
              const fileList = paths
                .filter(p => videoExts.some(ext => p.toLowerCase().endsWith('.' + ext)))
                .map(path => ({ name: path.split(/[\\/]/).pop() || path, path, size: 0 }));
              if (fileList.length > 0) addVideoFiles(fileList);
            }
          });
        })();
      }

      if (videoConvertCta) {
        videoConvertCta.addEventListener('click', async () => {
          if (isTauri) {
            try {
              const { open } = await import('@tauri-apps/plugin-dialog');
              const selected = await open({ multiple: true, filters: [{ name: 'Video Files', extensions: videoExts }] });
              if (selected && Array.isArray(selected)) {
                addVideoFiles(selected.map(path => ({ name: path.split(/[\\/]/).pop() || path, path, size: 0 })));
              }
            } catch (e) { console.error('Video file selection error', e); }
          } else {
            const input = document.createElement('input');
            input.type = 'file'; input.multiple = true; input.accept = 'video/*';
            input.addEventListener('change', () => { addVideoFiles(input.files); input.value = ''; });
            input.click();
          }
        });
      }

      function showVideoSuccessDialog(result) {
        const outputPath = result?.output_dir || (isTauri ? 'C:\\Users\\Downloads\\toolknit-converted' : '~/Downloads/toolknit-converted');
        const successCount = result?.success_count ?? selectedVideoFiles.length;
        const failCount = result?.fail_count ?? 0;
        const firstFileName = selectedVideoFiles[0]?.name || '';
        if (failCount > 0 && successCount === 0) {
          const details = result?.errors?.length ? `\n\n${result.errors.slice(0, 3).join('\n')}` : '';
          alert(t('home.videoConvert.allFailed', { count: failCount }) + details);
          return;
        }
        let summary;
        if (failCount > 0) {
          summary = t('home.videoConvert.successSummaryPartial', { success: successCount, fail: failCount, format: targetVideoFormat });
        } else if (successCount > 1) {
          summary = t('home.videoConvert.successSummaryPlural', { count: successCount, format: targetVideoFormat });
        } else {
          summary = t('home.videoConvert.successSummarySingle', { name: firstFileName, format: targetVideoFormat });
        }
        if (videoConvertSuccessMeta) videoConvertSuccessMeta.textContent = summary;
        if (videoConvertSuccessFormat) videoConvertSuccessFormat.textContent = targetVideoFormat;
        if (videoConvertSuccessCount) videoConvertSuccessCount.textContent = `${successCount} ${t('home.videoConvert.successCountUnit')}`;
        if (videoConvertSuccessPath) videoConvertSuccessPath.textContent = displayFilesystemPath(outputPath);
        lastVideoOutputPath = outputPath;
        if (videoConvertSuccessOverlay) videoConvertSuccessOverlay.classList.add('visible');
      }

      function closeVideoSuccessDialog() {
        if (videoConvertSuccessOverlay) videoConvertSuccessOverlay.classList.remove('visible');
        clearVideoFiles();
      }

      if (videoConvertCancelBtn) {
        videoConvertCancelBtn.addEventListener('click', cancelActiveVideoConversion);
      }

      function cancelActiveVideoConversion() {
        const wasProcessing = processingVideo;
        videoConversionRunId += 1;
        if (videoConvertUnlisten) {
          videoConvertUnlisten();
          videoConvertUnlisten = null;
        }
        if (videoConvertProcessMask) videoConvertProcessMask.classList.remove('visible');
        if (videoConvertProcessBarFill) videoConvertProcessBarFill.style.width = '0%';
        if (videoConvertProcessText) videoConvertProcessText.textContent = t('home.videoConvert.processing');
        processingVideo = false;
        if (isTauri && wasProcessing) {
          tauriCorePromise
            .then(({ invoke }) => invoke('cancel_convert'))
            .catch((error) => console.error('Video cancellation failed:', error));
        }
      }

      async function startVideoProcessing() {
        if (!videoConvertProcessMask || !videoConvertProcessBarFill || processingVideo) return;
        if (selectedVideoFiles.length === 0) return;
        try {
          validateVideoBatchSelection(selectedVideoFiles);
          targetVideoFormat = normalizeVideoTargetFormat(targetVideoFormat);
        } catch (error) {
          alert(error instanceof VideoConvertError ? error.message : t('home.videoConvert.conversionError'));
          return;
        }
        if (!isTauri) {
          alert(t('home.videoConvert.desktopOnly'));
          return;
        }
        const runId = ++videoConversionRunId;
        processingVideo = true;
        videoConvertProcessMask.classList.add('visible');
        videoConvertProcessBarFill.style.width = '0%';

        let unlisten = null;
        try {
          const { invoke } = await tauriCorePromise;
          const { listen } = await tauriEventPromise;
          const inputPaths = selectedVideoFiles.map(file => file.path).filter(Boolean);
          if (inputPaths.length !== selectedVideoFiles.length) {
            throw new Error(t('common.filePathsNotAvailableShort'));
          }
          const finalOutputDir = await getOutputDir('Videos');
          if (runId !== videoConversionRunId) return;
          const ffmpegReady = await ensureFfmpegAvailable();
          if (!ffmpegReady || runId !== videoConversionRunId) return;

          const progressByFile = new Map();
          unlisten = await listen('convert-progress', (event) => {
            if (runId !== videoConversionRunId) return;
            const data = event.payload || {};
            const current = Number(data.current);
            const total = Number(data.total);
            if (!Number.isInteger(current) || !Number.isInteger(total) || current < 1 || total < 1) return;
            const progress = Number.isFinite(Number(data.progress)) ? Number(data.progress) : 0;
            const existing = progressByFile.get(current) || 0;
            const next = data.status === 'done' || data.status === 'error' ? 1 : Math.max(existing, Math.max(0, Math.min(progress, 0.99)));
            progressByFile.set(current, next);
            const completed = [...progressByFile.values()].reduce((sum, value) => sum + value, 0);
            const percent = Math.min(99, Math.round((completed / total) * 100));
            videoConvertProcessBarFill.style.width = `${percent}%`;
            if (videoConvertProcessText) videoConvertProcessText.textContent = `${t('home.videoConvert.processing')} (${current}/${total})`;
          });
          if (runId !== videoConversionRunId) {
            unlisten();
            return;
          }
          videoConvertUnlisten = unlisten;
          const result = await invoke('convert_video_batch', { inputPaths, outputDir: finalOutputDir, targetFormat: targetVideoFormat });
          unlisten();
          if (videoConvertUnlisten === unlisten) videoConvertUnlisten = null;
          if (runId !== videoConversionRunId) return;
          videoConvertProcessBarFill.style.width = '100%';
          setTimeout(() => {
            if (runId !== videoConversionRunId) return;
            videoConvertProcessMask.classList.remove('visible');
            videoConvertProcessBarFill.style.width = '0%';
            processingVideo = false;
            showVideoSuccessDialog(result);
          }, 400);
        } catch (e) {
          console.error('Video conversion failed:', e);
          if (unlisten) unlisten();
          if (videoConvertUnlisten === unlisten) videoConvertUnlisten = null;
          if (runId !== videoConversionRunId) return;
          videoConvertProcessMask.classList.remove('visible');
          videoConvertProcessBarFill.style.width = '0%';
          processingVideo = false;
          if (videoConvertProcessText) videoConvertProcessText.textContent = t('home.videoConvert.processing');
          alert(t('common.errorOccurred', { error: e?.message || e }));
        }
      }

      if (videoConvertProcessBtn) videoConvertProcessBtn.addEventListener('click', () => { if (selectedVideoFiles.length > 0) startVideoProcessing(); });
      if (videoConvertSuccessOk) videoConvertSuccessOk.addEventListener('click', () => closeVideoSuccessDialog());

      let lastVideoOutputPath = '';
      if (videoConvertOpenFolder) {
        videoConvertOpenFolder.addEventListener('click', () => {
          if (isTauri && lastVideoOutputPath) {
            openOutputFolder(lastVideoOutputPath).catch(e => console.error('Open folder error', e));
          }
          closeVideoSuccessDialog();
        });
      }

      if (videoConvertFormatOptions) {
        videoConvertFormatOptions.addEventListener('click', (e) => {
          const btn = e.target.closest('.audio-convert-format-option');
          if (!btn) return;
          videoConvertFormatOptions.querySelectorAll('.audio-convert-format-option').forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
          targetVideoFormat = btn.dataset.format;
        });
      }

      // ===== Video Frame Capture Tool =====
      const videoFrameOverlay = document.getElementById('videoFrameOverlay');
      const videoFrameBack = document.getElementById('videoFrameBack');
      const videoFramePick = document.getElementById('videoFramePick');
      const videoFrameChange = document.getElementById('videoFrameChange');
      const videoFrameDropZone = document.getElementById('videoFrameDropZone');
      const videoFrameEmpty = document.getElementById('videoFrameEmpty');
      const videoFrameEditor = document.getElementById('videoFrameEditor');
      const videoFramePreviewVideo = document.getElementById('videoFramePreviewVideo');
      const videoFramePreviewImage = document.getElementById('videoFramePreviewImage');
      const videoFramePreviewToggle = document.getElementById('videoFramePreviewToggle');
      const videoFramePreviewPlayIcon = videoFramePreviewToggle?.querySelector('.video-gif-preview-play-icon');
      const videoFramePreviewPauseIcon = videoFramePreviewToggle?.querySelector('.video-gif-preview-pause-icon');
      const videoFrameTimeline = document.getElementById('videoFrameTimeline');
      const videoFrameTimestamp = document.getElementById('videoFrameTimestamp');
      const videoFrameTime = document.getElementById('videoFrameTime');
      const videoFrameName = document.getElementById('videoFrameName');
      const videoFramePrev = document.getElementById('videoFramePrev');
      const videoFrameNext = document.getElementById('videoFrameNext');
      const videoFrameFormat = document.getElementById('videoFrameFormat');
      const videoFrameExport = document.getElementById('videoFrameExport');
      const videoFrameProcessMask = document.getElementById('videoFrameProcessMask');
      const videoFrameProcessBarFill = document.getElementById('videoFrameProcessBarFill');
      const videoFrameProcessText = document.getElementById('videoFrameProcessText');
      const videoFrameCancelBtn = document.getElementById('videoFrameCancelBtn');
      const videoFrameSuccessOverlay = document.getElementById('videoFrameSuccessOverlay');
      const videoFrameSuccessMeta = document.getElementById('videoFrameSuccessMeta');
      const videoFrameSuccessFormat = document.getElementById('videoFrameSuccessFormat');
      const videoFrameSuccessTime = document.getElementById('videoFrameSuccessTime');
      const videoFrameSuccessPath = document.getElementById('videoFrameSuccessPath');
      const videoFrameOpenFolder = document.getElementById('videoFrameOpenFolder');
      const videoFrameSuccessOk = document.getElementById('videoFrameSuccessOk');
      const videoFramePlasmaBg = document.getElementById('videoFramePlasmaBg');
      let videoFrameFile = null;
      let videoFrameDuration = 0;
      let videoFrameStepMs = 33;
      let videoFrameOutputFormat = 'png';
      let videoFramePlasmaDispose = null;
      let videoFrameProcessing = false;
      let videoFrameProgressUnlisten = null;
      let lastVideoFrameOutputPath = '';
      let videoFrameTimestampMs = 0;
      let videoFrameUseNativePreview = false;
      let videoFrameSeekRaf = 0;
      let videoFramePendingSeekMs = 0;
      let videoFramePreviewClipRange = null;
      let videoFramePreviewClipToken = 0;
      let videoFramePreviewClipLoading = false;
      const videoFramePreviewState = { token: 0, timer: null, pending: null, inFlight: false, errorShown: false };
      const VIDEO_FRAME_PREVIEW_WINDOW_MS = 30_000;

      function isSupportedVideoPath(filePath) {
        const lower = String(filePath || '').toLowerCase();
        return videoExts.some(ext => lower.endsWith(`.${ext}`));
      }

      function localVideoFile(filePath, size = 0) {
        return {
          name: String(filePath || '').split(/[\\/]/).pop() || String(filePath || ''),
          path: String(filePath || ''),
          size: Number(size) || 0
        };
      }

      function firstSupportedVideoPath(paths) {
        return (Array.isArray(paths) ? paths : []).find(isSupportedVideoPath) || '';
      }

      function clearQueuedVideoPreview(state, image) {
        state.token += 1;
        if (state.timer) clearTimeout(state.timer);
        state.timer = null;
        state.pending = null;
        state.errorShown = false;
        image?.removeAttribute('src');
        image?.classList.remove('is-loading', 'is-ready');
      }

      function runQueuedVideoPreview(state) {
        if (state.inFlight || !state.pending) return;
        const request = state.pending;
        state.pending = null;
        state.inFlight = true;
        request.image?.classList.add('is-loading');
        (async () => {
          try {
            const { invoke } = await tauriCorePromise;
            const result = await invoke('render_video_preview_frame', {
              inputPath: request.inputPath,
              timestampMs: request.timestampMs
            });
            const dataUrl = result?.image_data_url || result?.imageDataUrl;
            if (!dataUrl) throw new Error('video-preview:empty-result');
            if (request.token !== state.token) return;
            request.image.src = dataUrl;
            request.image.classList.add('is-ready');
            state.errorShown = false;
          } catch (error) {
            if (request.token === state.token && !state.errorShown) {
              state.errorShown = true;
              window.showToast?.('无法生成视频预览帧，仍可继续导出。');
              console.warn('Video preview frame failed:', error);
            }
          } finally {
            state.inFlight = false;
            if (request.token === state.token) request.image?.classList.remove('is-loading');
            if (state.pending) runQueuedVideoPreview(state);
          }
        })();
      }

      function scheduleVideoPreview(state, image, inputPath, timestampMs, immediate = false) {
        if (!image || !inputPath) return;
        const token = state.token + 1;
        state.token = token;
        state.pending = { token, image, inputPath, timestampMs };
        if (state.timer) clearTimeout(state.timer);
        const start = () => {
          state.timer = null;
          runQueuedVideoPreview(state);
        };
        if (immediate) start();
        else state.timer = setTimeout(start, 100);
      }

      function updateVideoFramePreviewToggle() {
        const isPlaying = Boolean(videoFramePreviewVideo && !videoFramePreviewVideo.paused && !videoFramePreviewVideo.ended);
        const enabled = Boolean(videoFrameFile?.path && videoFrameDuration > 0 && !videoFramePreviewClipLoading);
        if (videoFramePreviewToggle) {
          videoFramePreviewToggle.disabled = !enabled;
          videoFramePreviewToggle.classList.toggle('is-loading', videoFramePreviewClipLoading);
          videoFramePreviewToggle.classList.toggle('is-playing', isPlaying);
          videoFramePreviewToggle.setAttribute('aria-pressed', String(isPlaying));
          const label = videoFramePreviewClipLoading ? '正在准备视频预览' : (isPlaying ? '暂停视频' : '播放视频');
          videoFramePreviewToggle.setAttribute('aria-label', label);
          videoFramePreviewToggle.title = label;
        }
        if (videoFramePreviewPlayIcon) videoFramePreviewPlayIcon.hidden = isPlaying;
        if (videoFramePreviewPauseIcon) videoFramePreviewPauseIcon.hidden = !isPlaying;
      }

      function showVideoFrameFallbackPreview(inputPath, timestampMs, immediate = false) {
        if (videoFramePreviewVideo && videoFramePreviewVideo.paused) videoFramePreviewVideo.hidden = true;
        if (videoFramePreviewImage) videoFramePreviewImage.hidden = false;
        scheduleVideoPreview(videoFramePreviewState, videoFramePreviewImage, inputPath, timestampMs, immediate);
      }

      function updateVideoFrameTimestampUi(milliseconds) {
        const value = Math.max(0, Math.min(Math.round(videoFrameDuration * 1000), Math.round(milliseconds)));
        videoFrameTimestampMs = value;
        if (videoFrameTimeline) videoFrameTimeline.value = String(value);
        if (videoFrameTimestamp) videoFrameTimestamp.value = String(value);
        if (videoFrameTime) videoFrameTime.textContent = frameTimeLabel(value);
        return value;
      }

      function videoFrameMaxMs() {
        return Math.max(0, Math.round((Number(videoFrameDuration) || 0) * 1000));
      }

      function videoFrameClipWindowFor(milliseconds) {
        const maxMs = videoFrameMaxMs();
        if (maxMs <= 0) return null;
        const duration = Math.min(VIDEO_FRAME_PREVIEW_WINDOW_MS, maxMs);
        let startMs = 0;
        if (maxMs > duration) {
          startMs = Math.floor(Math.max(0, Math.min(maxMs, milliseconds)) / duration) * duration;
          startMs = Math.min(startMs, maxMs - duration);
        }
        let endMs = Math.min(maxMs, startMs + duration);
        if (endMs <= startMs) endMs = Math.min(maxMs, startMs + 1);
        if (endMs <= startMs) return null;
        return { startMs, endMs };
      }

      function videoFrameClipContains(milliseconds) {
        return Boolean(
          videoFramePreviewClipRange
          && milliseconds >= videoFramePreviewClipRange.startMs
          && milliseconds <= videoFramePreviewClipRange.endMs
        );
      }

      function seekVideoFramePreviewClip(milliseconds, immediate = false) {
        if (!videoFramePreviewVideo || !videoFrameClipContains(milliseconds)) return false;
        const applySeek = () => {
          if (!videoFramePreviewVideo || !videoFrameClipContains(videoFramePendingSeekMs)) return;
          const offsetSeconds = Math.max(0, Math.min(
            (videoFramePreviewClipRange.endMs - videoFramePreviewClipRange.startMs) / 1000,
            (videoFramePendingSeekMs - videoFramePreviewClipRange.startMs) / 1000
          ));
          try {
            videoFramePreviewVideo.currentTime = offsetSeconds;
            videoFramePreviewVideo.hidden = false;
            if (videoFramePreviewImage) videoFramePreviewImage.hidden = true;
          } catch (error) {
            if (videoFrameFile?.path) showVideoFrameFallbackPreview(videoFrameFile.path, videoFramePendingSeekMs, true);
          }
        };
        videoFramePendingSeekMs = Math.max(0, Math.round(milliseconds));
        if (immediate) {
          if (videoFrameSeekRaf) cancelAnimationFrame(videoFrameSeekRaf);
          videoFrameSeekRaf = 0;
          applySeek();
          return true;
        }
        if (!videoFrameSeekRaf) {
          videoFrameSeekRaf = requestAnimationFrame(() => {
            videoFrameSeekRaf = 0;
            applySeek();
          });
        }
        return true;
      }

      function resetVideoFramePreviewClip({ restoreStill = true } = {}) {
        videoFramePreviewClipToken += 1;
        videoFramePreviewClipLoading = false;
        videoFramePreviewClipRange = null;
        videoFrameUseNativePreview = false;
        if (videoFrameSeekRaf) cancelAnimationFrame(videoFrameSeekRaf);
        videoFrameSeekRaf = 0;
        if (videoFramePreviewVideo) {
          videoFramePreviewVideo.pause();
          videoFramePreviewVideo.removeAttribute('src');
          videoFramePreviewVideo.load();
          videoFramePreviewVideo.hidden = true;
        }
        if (restoreStill && videoFramePreviewImage) videoFramePreviewImage.hidden = false;
        updateVideoFramePreviewToggle();
      }

      async function loadVideoFramePreviewClip(milliseconds, { autoplay = false, showError = false } = {}) {
        if (!videoFramePreviewVideo || !videoFrameFile?.path || !isTauri) return false;
        const range = videoFrameClipWindowFor(milliseconds);
        if (!range) return false;
        const token = ++videoFramePreviewClipToken;
        videoFramePreviewClipLoading = true;
        updateVideoFramePreviewToggle();
        try {
          const { invoke } = await tauriCorePromise;
          const result = await invoke('render_video_preview_clip', {
            inputPath: videoFrameFile.path,
            startMs: range.startMs,
            endMs: range.endMs
          });
          const source = result?.media_data_url || result?.mediaDataUrl;
          if (!source) throw new Error('视频预览准备失败。');
          if (token !== videoFramePreviewClipToken) return false;
          await new Promise((resolve, reject) => {
            const ready = () => { cleanup(); resolve(); };
            const failed = () => { cleanup(); reject(new Error('无法播放视频预览。')); };
            const cleanup = () => {
              videoFramePreviewVideo.removeEventListener('canplay', ready);
              videoFramePreviewVideo.removeEventListener('error', failed);
            };
            videoFramePreviewVideo.addEventListener('canplay', ready, { once: true });
            videoFramePreviewVideo.addEventListener('error', failed, { once: true });
            videoFramePreviewVideo.pause();
            videoFramePreviewVideo.src = source;
            videoFramePreviewVideo.hidden = false;
            if (videoFramePreviewImage) videoFramePreviewImage.hidden = true;
            videoFramePreviewVideo.load();
          });
          if (token !== videoFramePreviewClipToken) return false;
          videoFramePreviewClipRange = range;
          videoFrameUseNativePreview = true;
          seekVideoFramePreviewClip(Math.max(range.startMs, Math.min(range.endMs, milliseconds)), true);
          if (autoplay) {
            await videoFramePreviewVideo.play();
          }
          return true;
        } catch (error) {
          if (token === videoFramePreviewClipToken) {
            videoFramePreviewClipRange = null;
            videoFrameUseNativePreview = false;
            if (showError) window.showToast?.(error?.message || '无法播放视频。');
            if (videoFrameFile?.path) showVideoFrameFallbackPreview(videoFrameFile.path, milliseconds, true);
          }
          return false;
        } finally {
          if (token === videoFramePreviewClipToken) {
            videoFramePreviewClipLoading = false;
            updateVideoFramePreviewToggle();
          }
        }
      }

      function seekVideoFramePreview(milliseconds, immediate = false) {
        if (seekVideoFramePreviewClip(milliseconds)) return true;
        if (videoFramePreviewVideo && !videoFramePreviewVideo.paused) videoFramePreviewVideo.pause();
        if (videoFrameFile?.path) showVideoFrameFallbackPreview(videoFrameFile.path, milliseconds, immediate);
        if (!videoFramePreviewClipLoading && (immediate || videoFrameMaxMs() <= VIDEO_FRAME_PREVIEW_WINDOW_MS)) {
          void loadVideoFramePreviewClip(milliseconds);
        }
        return true;
      }

      async function playVideoFramePreview() {
        if (!videoFramePreviewVideo || !videoFrameFile?.path || videoFramePreviewClipLoading) return;
        let targetMs = videoFrameTimestampMs;
        const maxMs = videoFrameMaxMs();
        if (maxMs > 0 && targetMs >= maxMs - 50) {
          targetMs = 0;
          updateVideoFrameTimestampUi(0);
        }
        try {
          if (!videoFrameClipContains(targetMs)) {
            await loadVideoFramePreviewClip(targetMs, { autoplay: true, showError: true });
            return;
          }
          seekVideoFramePreviewClip(targetMs, true);
          videoFramePreviewVideo.hidden = false;
          if (videoFramePreviewImage) videoFramePreviewImage.hidden = true;
          await videoFramePreviewVideo.play();
        } catch (error) {
          window.showToast?.(error?.message || '无法播放视频。');
          updateVideoFramePreviewToggle();
        }
      }

      function pauseVideoFramePreview() {
        videoFramePreviewVideo?.pause();
        updateVideoFramePreviewToggle();
      }

      function syncVideoFrameTimestamp(milliseconds, renderPreview = true, immediate = false) {
        const value = updateVideoFrameTimestampUi(milliseconds);
        if (renderPreview && videoFrameFile?.path) {
          seekVideoFramePreview(value, immediate);
        }
      }
      function clearVideoFrame() {
        videoFrameFile = null; videoFrameDuration = 0; videoFrameStepMs = 33; videoFrameTimestampMs = 0; videoFrameUseNativePreview = false; videoFramePendingSeekMs = 0; videoFramePreviewClipRange = null; videoFramePreviewClipLoading = false; videoFramePreviewClipToken += 1;
        if (videoFrameSeekRaf) cancelAnimationFrame(videoFrameSeekRaf);
        videoFrameSeekRaf = 0;
        clearQueuedVideoPreview(videoFramePreviewState, videoFramePreviewImage);
        if (videoFramePreviewVideo) {
          videoFramePreviewVideo.pause();
          videoFramePreviewVideo.removeAttribute('src');
          videoFramePreviewVideo.load();
          videoFramePreviewVideo.hidden = true;
        }
        if (videoFramePreviewImage) videoFramePreviewImage.hidden = true;
        updateVideoFramePreviewToggle();
        videoFrameOverlay?.classList.remove('is-editing');
        if (videoFrameEditor) videoFrameEditor.hidden = true;
        if (videoFrameEmpty) videoFrameEmpty.hidden = false;
      }
      function openVideoFrameOverlay() { videoFrameOverlay?.classList.add('visible'); if (videoFramePlasmaBg && !videoFramePlasmaDispose) videoFramePlasmaDispose = initStandardToolPlasma(videoFramePlasmaBg); }
      function closeVideoFrameOverlay() { videoFrameOverlay?.classList.remove('visible'); clearVideoFrame(); if (videoFramePlasmaDispose) { videoFramePlasmaDispose(); videoFramePlasmaDispose = null; } }
      async function loadVideoFrameFile(selected) {
        if (!isTauri) { window.showToast?.('视频单帧导出仅可在桌面端使用。'); return; }
        if (typeof selected !== 'string' || !selected) return;
        try {
          const file = { name: selected.split(/[\\/]/).pop() || selected, path: selected, size: 0 };
          validateVideoFrameInput(file);
          const { invoke } = await tauriCorePromise;
          const probe = await invoke('probe_video', { inputPath: selected });
          const duration = Number(probe?.duration);
          if (!Number.isFinite(duration) || duration <= 0) throw new Error('无法读取视频时长。');
          clearQueuedVideoPreview(videoFramePreviewState, videoFramePreviewImage);
          videoFrameFile = file;
          videoFrameDuration = duration;
          videoFrameStepMs = 33;
          videoFrameFile.size = Number(probe?.file_size ?? probe?.fileSize) || 0;
          videoFrameName.textContent = file.name;
          videoFrameTimeline.max = String(Math.floor(duration * 1000));
          if (Number.isFinite(probe?.frame_rate) && probe.frame_rate > 0 && probe.frame_rate <= 240) videoFrameStepMs = 1000 / probe.frame_rate;
          videoFrameEmpty.hidden = true;
          videoFrameEditor.hidden = false;
          videoFrameOverlay?.classList.add('is-editing');
          updateVideoFrameTimestampUi(0);
          await loadVideoFramePreviewClip(0);
          syncVideoFrameTimestamp(0, true, true);
        } catch (error) { window.showToast?.(error?.message || '无法读取视频文件。'); }
      }
      async function chooseVideoFrameFile() {
        if (!isTauri) { window.showToast?.('视频单帧导出仅可在桌面端使用。'); return; }
        try {
          const { open } = await import('@tauri-apps/plugin-dialog');
          const selected = await open({ multiple: false, filters: [{ name: 'Video', extensions: videoExts }] });
          if (typeof selected !== 'string') return;
          await loadVideoFrameFile(selected);
        } catch (error) { window.showToast?.(error?.message || '无法读取视频文件。'); }
      }
      videoFrameTimeline?.addEventListener('input', () => syncVideoFrameTimestamp(Number(videoFrameTimeline.value)));
      videoFrameTimestamp?.addEventListener('change', () => { try { syncVideoFrameTimestamp(normalizeVideoFrameTimestamp(Number(videoFrameTimestamp.value), videoFrameDuration), true, true); } catch (error) { syncVideoFrameTimestamp(videoFrameTimestampMs, false); } });
      videoFramePrev?.addEventListener('click', () => syncVideoFrameTimestamp(Math.round(videoFrameTimestampMs - videoFrameStepMs), true, true));
      videoFrameNext?.addEventListener('click', () => syncVideoFrameTimestamp(Math.round(videoFrameTimestampMs + videoFrameStepMs), true, true));
      videoFramePick?.addEventListener('click', chooseVideoFrameFile); videoFrameChange?.addEventListener('click', chooseVideoFrameFile); videoFrameBack?.addEventListener('click', closeVideoFrameOverlay);
      videoFrameFormat?.addEventListener('click', event => { const button = event.target.closest('[data-format]'); if (!button) return; videoFrameOutputFormat = button.dataset.format; videoFrameFormat.querySelectorAll('[data-format]').forEach(item => item.classList.toggle('active', item === button)); });
      videoFramePreviewToggle?.addEventListener('click', () => {
        if (!videoFrameFile?.path || !videoFramePreviewVideo || videoFramePreviewClipLoading) return;
        if (videoFramePreviewVideo.paused || videoFramePreviewVideo.ended) playVideoFramePreview();
        else pauseVideoFramePreview();
      });
      videoFramePreviewVideo?.addEventListener('play', updateVideoFramePreviewToggle);
      videoFramePreviewVideo?.addEventListener('pause', updateVideoFramePreviewToggle);
      videoFramePreviewVideo?.addEventListener('ended', updateVideoFramePreviewToggle);
      videoFramePreviewVideo?.addEventListener('loadedmetadata', () => {
        if (!videoFrameUseNativePreview) return;
        seekVideoFramePreviewClip(videoFrameTimestampMs, true);
        updateVideoFramePreviewToggle();
      });
      videoFramePreviewVideo?.addEventListener('timeupdate', () => {
        if (!videoFrameUseNativePreview || !videoFramePreviewVideo || videoFramePreviewVideo.seeking) return;
        const baseMs = videoFramePreviewClipRange?.startMs || 0;
        updateVideoFrameTimestampUi(baseMs + Math.round(videoFramePreviewVideo.currentTime * 1000));
      });
      videoFramePreviewVideo?.addEventListener('seeked', () => {
        if (!videoFrameUseNativePreview || !videoFramePreviewVideo) return;
        const baseMs = videoFramePreviewClipRange?.startMs || 0;
        updateVideoFrameTimestampUi(baseMs + Math.round(videoFramePreviewVideo.currentTime * 1000));
      });
      videoFramePreviewVideo?.addEventListener('error', () => {
        if (!videoFrameUseNativePreview) return;
        videoFrameUseNativePreview = false;
        videoFramePreviewClipRange = null;
        updateVideoFramePreviewToggle();
        if (videoFrameFile?.path) showVideoFrameFallbackPreview(videoFrameFile.path, videoFrameTimestampMs, true);
      });
      function closeVideoFrameSuccess() { videoFrameSuccessOverlay?.classList.remove('visible'); }
      function showVideoFrameSuccess(result) {
        lastVideoFrameOutputPath = result.output_path || result.outputPath || '';
        if (videoFrameSuccessMeta) videoFrameSuccessMeta.textContent = videoFrameFile?.name || '';
        if (videoFrameSuccessFormat) videoFrameSuccessFormat.textContent = String(result.format || videoFrameOutputFormat).toUpperCase();
        if (videoFrameSuccessTime) videoFrameSuccessTime.textContent = frameTimeLabel(result.timestamp_ms ?? videoFrameTimestampMs);
        if (videoFrameSuccessPath) videoFrameSuccessPath.textContent = displayFilesystemPath(lastVideoFrameOutputPath);
        videoFrameSuccessOverlay?.classList.add('visible');
      }
      videoFrameCancelBtn?.addEventListener('click', () => tauriCorePromise.then(({ invoke }) => invoke('cancel_convert')).catch(() => {}));
      videoFrameSuccessOk?.addEventListener('click', closeVideoFrameSuccess);
      videoFrameOpenFolder?.addEventListener('click', () => { if (lastVideoFrameOutputPath) openOutputFolder(lastVideoFrameOutputPath).catch(() => {}); closeVideoFrameSuccess(); });
      videoFrameExport?.addEventListener('click', async () => {
        if (!videoFrameFile?.path || !isTauri || videoFrameProcessing) return;
        videoFrameProcessing = true;
        if (videoFrameProcessBarFill) videoFrameProcessBarFill.style.width = '8%';
        if (videoFrameProcessText) videoFrameProcessText.textContent = '正在导出单帧图...';
        videoFrameProcessMask?.classList.add('visible');
        let unlisten;
        try {
          const [{ invoke }, { listen }] = await Promise.all([tauriCorePromise, tauriEventPromise]);
          unlisten = await listen('video-frame-progress', event => {
            const progress = Math.max(0, Math.min(1, Number(event.payload?.progress) || 0));
            if (videoFrameProcessBarFill) videoFrameProcessBarFill.style.width = `${Math.max(8, progress * 100)}%`;
            if (videoFrameProcessText) videoFrameProcessText.textContent = event.payload?.phase === 'publish' ? '正在发布图片...' : '正在定位并导出帧...';
          });
          const result = await invoke('extract_video_frame', { inputPath: videoFrameFile.path, outputDir: await getOutputDir('Videos'), timestampMs: videoFrameTimestampMs, format: normalizeVideoFrameFormat(videoFrameOutputFormat) });
          if (videoFrameProcessBarFill) videoFrameProcessBarFill.style.width = '100%';
          setTimeout(() => { videoFrameProcessMask?.classList.remove('visible'); if (videoFrameProcessBarFill) videoFrameProcessBarFill.style.width = '0%'; showVideoFrameSuccess(result); }, 240);
        } catch (error) {
          videoFrameProcessMask?.classList.remove('visible');
          if (videoFrameProcessBarFill) videoFrameProcessBarFill.style.width = '0%';
          window.showToast?.(error?.message || '导出失败。');
        } finally {
          if (unlisten) unlisten();
          videoFrameProcessing = false;
        }
      });
      document.querySelectorAll('.audio-list-item[data-tool="video-frame"]').forEach(item => {
        item.addEventListener('click', () => openToolWithFfmpegCheck(openVideoFrameOverlay));
        item.addEventListener('keydown', event => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            openToolWithFfmpegCheck(openVideoFrameOverlay);
          }
        });
      });
      function showVideoFrameDropZone() {
        videoFrameDropZone?.classList.add('visible');
        videoFrameOverlay?.classList.add('drag-over');
      }
      function hideVideoFrameDropZone() {
        videoFrameDropZone?.classList.remove('visible');
        videoFrameOverlay?.classList.remove('drag-over');
      }
      if (videoFrameOverlay && isTauri) {
        (async () => {
          const { getCurrentWebview } = await import('@tauri-apps/api/webview');
          await getCurrentWebview().onDragDropEvent(async event => {
            if (!videoFrameOverlay.classList.contains('visible') || videoFrameProcessing) return;
            const payload = event.payload;
            if (payload.type === 'enter' || payload.type === 'over') showVideoFrameDropZone();
            else if (payload.type === 'leave') hideVideoFrameDropZone();
            else if (payload.type === 'drop') {
              hideVideoFrameDropZone();
              const selected = firstSupportedVideoPath(payload.paths || []);
              if (selected) await loadVideoFrameFile(selected);
              else window.showToast?.('请拖入支持的视频文件。');
            }
          });
        })().catch(error => console.error('Cannot register video frame drag and drop:', error));
      }

      // ===== Video GIF Tool =====
      const videoGifOverlay = document.getElementById('videoGifOverlay');
      const videoGifBack = document.getElementById('videoGifBack');
      const videoGifPick = document.getElementById('videoGifPick');
      const videoGifChange = document.getElementById('videoGifChange');
      const videoGifDropZone = document.getElementById('videoGifDropZone');
      const videoGifEmpty = document.getElementById('videoGifEmpty');
      const videoGifEditor = document.getElementById('videoGifEditor');
      const videoGifPreviewImage = document.getElementById('videoGifPreviewImage');
      const videoGifRangePreview = document.getElementById('videoGifRangePreview');
      const videoGifPreviewToggle = document.getElementById('videoGifPreviewToggle');
      const videoGifPreviewPlayIcon = videoGifPreviewToggle?.querySelector('.video-gif-preview-play-icon');
      const videoGifPreviewPauseIcon = videoGifPreviewToggle?.querySelector('.video-gif-preview-pause-icon');
      const videoGifTimelineWrap = document.getElementById('videoGifTimelineWrap');
      const videoGifTimeline = document.getElementById('videoGifTimeline');
      const videoGifName = document.getElementById('videoGifName');
      const videoGifPreviewTime = document.getElementById('videoGifPreviewTime');
      const videoGifSelectStart = document.getElementById('videoGifSelectStart');
      const videoGifSelectEnd = document.getElementById('videoGifSelectEnd');
      const videoGifStartLabel = document.getElementById('videoGifStartLabel');
      const videoGifEndLabel = document.getElementById('videoGifEndLabel');
      const videoGifDurationLabel = document.getElementById('videoGifDurationLabel');
      const videoGifAdjustHint = document.getElementById('videoGifAdjustHint');
      const videoGifPrev = document.getElementById('videoGifPrev');
      const videoGifNext = document.getElementById('videoGifNext');
      const videoGifFrameRateOptions = document.getElementById('videoGifFrameRate');
      const videoGifResolutionOptions = document.getElementById('videoGifResolution');
      const videoGifQualityOptions = document.getElementById('videoGifQuality');
      const videoGifEstimate = document.getElementById('videoGifEstimate');
      const videoGifExport = document.getElementById('videoGifExport');
      const videoGifProcessMask = document.getElementById('videoGifProcessMask');
      const videoGifProcessBarFill = document.getElementById('videoGifProcessBarFill');
      const videoGifProcessText = document.getElementById('videoGifProcessText');
      const videoGifCancelBtn = document.getElementById('videoGifCancelBtn');
      const videoGifSuccessOverlay = document.getElementById('videoGifSuccessOverlay');
      const videoGifSuccessMeta = document.getElementById('videoGifSuccessMeta');
      const videoGifSuccessDuration = document.getElementById('videoGifSuccessDuration');
      const videoGifSuccessSpec = document.getElementById('videoGifSuccessSpec');
      const videoGifSuccessSize = document.getElementById('videoGifSuccessSize');
      const videoGifSuccessPath = document.getElementById('videoGifSuccessPath');
      const videoGifOpenFolder = document.getElementById('videoGifOpenFolder');
      const videoGifSuccessOk = document.getElementById('videoGifSuccessOk');
      const videoGifPlasmaBg = document.getElementById('videoGifPlasmaBg');
      let videoGifFile = null;
      let videoGifDuration = 0;
      let videoGifStepMs = 33;
      let videoGifStartMs = 0;
      let videoGifEndMs = 30_000;
      let videoGifActivePoint = 'start';
      let videoGifFrameRate = 12;
      let videoGifWidth = 640;
      let videoGifQuality = 'balanced';
      let videoGifSourceWidth = 0;
      let videoGifSourceHeight = 0;
      let videoGifSourceSize = 0;
      let videoGifProcessing = false;
      let videoGifPlasmaDispose = null;
      let lastVideoGifOutputPath = '';
      let videoGifPreviewTimestampMs = 0;
      const videoGifPreviewState = { token: 0, timer: null, pending: null, inFlight: false, errorShown: false };
      let videoGifPreviewPlaybackToken = 0;
      let videoGifPreviewPlaybackLoading = false;
      let videoGifPreviewPlaybackRange = null;
      const videoGifQualityLabels = { high: '清晰', balanced: '均衡', small: '小体积', tiny: '极小' };
      const videoGifEstimateFactors = { high: 0.21, balanced: 0.14, small: 0.095, tiny: 0.068 };

      function videoGifSelectionIsPlayable() {
        return Boolean(videoGifFile?.path)
          && Number.isFinite(videoGifStartMs)
          && Number.isFinite(videoGifEndMs)
          && videoGifEndMs > videoGifStartMs;
      }

      function videoGifSelectionKey() {
        return videoGifSelectionIsPlayable()
          ? `${videoGifFile.path}\u0000${videoGifStartMs}\u0000${videoGifEndMs}`
          : null;
      }

      function updateVideoGifPreviewToggle() {
        const isPlaying = Boolean(videoGifRangePreview && !videoGifRangePreview.paused && !videoGifRangePreview.ended);
        const enabled = videoGifSelectionIsPlayable() && !videoGifPreviewPlaybackLoading;
        if (videoGifPreviewToggle) {
          videoGifPreviewToggle.disabled = !enabled;
          videoGifPreviewToggle.classList.toggle('is-loading', videoGifPreviewPlaybackLoading);
          videoGifPreviewToggle.classList.toggle('is-playing', isPlaying);
          videoGifPreviewToggle.setAttribute('aria-pressed', String(isPlaying));
          const label = videoGifPreviewPlaybackLoading
            ? '正在准备所选片段预览'
            : isPlaying
              ? '暂停所选片段'
              : videoGifPreviewPlaybackRange
                ? '继续播放所选片段'
                : '播放所选片段';
          videoGifPreviewToggle.setAttribute('aria-label', label);
          videoGifPreviewToggle.title = label;
        }
        if (videoGifPreviewPlayIcon) videoGifPreviewPlayIcon.hidden = isPlaying;
        if (videoGifPreviewPauseIcon) videoGifPreviewPauseIcon.hidden = !isPlaying;
      }

      function videoGifPercent(milliseconds) {
        const max = Math.max(1, Math.round(videoGifDuration * 1000));
        return `${Math.max(0, Math.min(100, (Number(milliseconds) || 0) / max * 100)).toFixed(3)}%`;
      }

      function updateVideoGifTimelineVisual() {
        if (!videoGifTimelineWrap) return;
        videoGifTimelineWrap.style.setProperty('--gif-start', videoGifPercent(videoGifStartMs));
        videoGifTimelineWrap.style.setProperty('--gif-end', videoGifPercent(videoGifEndMs));
        videoGifTimelineWrap.style.setProperty('--gif-cursor', videoGifPercent(videoGifPreviewTimestampMs));
      }

      function estimateVideoGifBytes() {
        if (!videoGifSelectionIsPlayable()) return null;
        const durationSeconds = Math.max(0.001, (videoGifEndMs - videoGifStartMs) / 1000);
        const frames = Math.max(1, Math.round(durationSeconds * Math.max(1, videoGifFrameRate)));
        const sourceWidth = videoGifSourceWidth > 0 ? videoGifSourceWidth : videoGifWidth;
        const sourceHeight = videoGifSourceHeight > 0 ? videoGifSourceHeight : Math.round(sourceWidth * 9 / 16);
        const outputWidth = Math.max(160, Math.min(videoGifWidth, sourceWidth));
        const outputHeight = Math.max(2, Math.round(outputWidth * sourceHeight / Math.max(1, sourceWidth) / 2) * 2);
        const factor = videoGifEstimateFactors[videoGifQuality] || videoGifEstimateFactors.balanced;
        const rawEstimate = frames * outputWidth * outputHeight * factor;
        const sourceBound = videoGifSourceSize > 0 ? videoGifSourceSize * (durationSeconds / Math.max(durationSeconds, videoGifDuration || durationSeconds)) * 2.2 : 0;
        const center = Math.max(rawEstimate, sourceBound);
        return {
          low: Math.max(1, Math.round(center * 0.72)),
          high: Math.max(1, Math.round(center * 1.38)),
          frames,
          width: outputWidth,
          height: outputHeight
        };
      }

      function updateVideoGifEstimate() {
        if (!videoGifEstimate) return;
        const estimate = estimateVideoGifBytes();
        if (!estimate) {
          videoGifEstimate.textContent = '预计体积：选择视频后自动估算';
          return;
        }
        videoGifEstimate.textContent = `预计体积：${formatFileSize(estimate.low)} - ${formatFileSize(estimate.high)} · ${estimate.frames} 帧 · ${estimate.width}×${estimate.height} · ${videoGifQualityLabels[videoGifQuality] || '均衡'}`;
      }

      function resetVideoGifSelectionPlayback({ restoreStill = true } = {}) {
        videoGifPreviewPlaybackToken += 1;
        videoGifPreviewPlaybackLoading = false;
        videoGifPreviewPlaybackRange = null;
        if (videoGifRangePreview) {
          videoGifRangePreview.pause();
          videoGifRangePreview.removeAttribute('src');
          videoGifRangePreview.load();
          videoGifRangePreview.hidden = true;
        }
        if (restoreStill && videoGifPreviewImage) videoGifPreviewImage.hidden = false;
        updateVideoGifPreviewToggle();
      }

      function pauseVideoGifSelectionPlayback() {
        videoGifRangePreview?.pause();
        updateVideoGifPreviewToggle();
      }

      async function playVideoGifSelectionPlayback() {
        if (!videoGifSelectionIsPlayable() || !videoGifRangePreview) return;
        const selectionKey = videoGifSelectionKey();
        if (videoGifPreviewPlaybackRange === selectionKey && videoGifRangePreview.getAttribute('src')) {
          try {
            await videoGifRangePreview.play();
          } catch (error) {
            window.showToast?.(error?.message || '无法播放所选片段。');
          }
          updateVideoGifPreviewToggle();
          return;
        }

        const token = ++videoGifPreviewPlaybackToken;
        videoGifPreviewPlaybackLoading = true;
        updateVideoGifPreviewToggle();
        try {
          const { invoke } = await tauriCorePromise;
          const result = await invoke('render_video_preview_clip', {
            inputPath: videoGifFile.path,
            startMs: videoGifStartMs,
            endMs: videoGifEndMs
          });
          const source = result?.media_data_url || result?.mediaDataUrl;
          if (!source) throw new Error('视频预览准备失败。');
          if (token !== videoGifPreviewPlaybackToken || selectionKey !== videoGifSelectionKey()) return;

          await new Promise((resolve, reject) => {
            const ready = () => { cleanup(); resolve(); };
            const failed = () => { cleanup(); reject(new Error('无法播放所选片段。')); };
            const cleanup = () => {
              videoGifRangePreview.removeEventListener('canplay', ready);
              videoGifRangePreview.removeEventListener('error', failed);
            };
            videoGifRangePreview.addEventListener('canplay', ready, { once: true });
            videoGifRangePreview.addEventListener('error', failed, { once: true });
            videoGifRangePreview.src = source;
            videoGifRangePreview.hidden = false;
            if (videoGifPreviewImage) videoGifPreviewImage.hidden = true;
            videoGifRangePreview.load();
          });
          if (token !== videoGifPreviewPlaybackToken || selectionKey !== videoGifSelectionKey()) return;
          videoGifPreviewPlaybackRange = selectionKey;
          videoGifRangePreview.currentTime = 0;
          videoGifPreviewTimestampMs = videoGifStartMs;
          if (videoGifTimeline) videoGifTimeline.value = String(videoGifStartMs);
          if (videoGifPreviewTime) videoGifPreviewTime.textContent = videoGifTimeLabel(videoGifStartMs);
          updateVideoGifTimelineVisual();
          await videoGifRangePreview.play();
        } catch (error) {
          if (token === videoGifPreviewPlaybackToken) {
            resetVideoGifSelectionPlayback();
            window.showToast?.(error?.message || '无法播放所选片段。');
          }
        } finally {
          if (token === videoGifPreviewPlaybackToken) {
            videoGifPreviewPlaybackLoading = false;
            updateVideoGifPreviewToggle();
          }
        }
      }

      function updateVideoGifSelection() {
        if (videoGifStartLabel) videoGifStartLabel.textContent = videoGifTimeLabel(videoGifStartMs);
        if (videoGifEndLabel) videoGifEndLabel.textContent = videoGifTimeLabel(videoGifEndMs);
        if (videoGifDurationLabel) videoGifDurationLabel.textContent = `${((videoGifEndMs - videoGifStartMs) / 1000).toFixed(3)} 秒 / 最多 30 秒`;
        videoGifSelectStart?.classList.toggle('active', videoGifActivePoint === 'start');
        videoGifSelectEnd?.classList.toggle('active', videoGifActivePoint === 'end');
        if (videoGifAdjustHint) videoGifAdjustHint.textContent = videoGifActivePoint === 'start' ? '正在调整起始帧' : '正在调整结束帧';
        updateVideoGifTimelineVisual();
        updateVideoGifEstimate();
        updateVideoGifPreviewToggle();
      }
      function seekVideoGif(milliseconds, immediate = false) {
        const value = Math.max(0, Math.min(Math.round(videoGifDuration * 1000), Math.round(milliseconds)));
        videoGifPreviewTimestampMs = value;
        if (videoGifTimeline) videoGifTimeline.value = String(value);
        if (videoGifPreviewTime) videoGifPreviewTime.textContent = videoGifTimeLabel(value);
        updateVideoGifTimelineVisual();
        if (videoGifFile?.path) {
          scheduleVideoPreview(videoGifPreviewState, videoGifPreviewImage, videoGifFile.path, value, immediate);
        }
      }
      function setVideoGifPoint(point, milliseconds, previewImmediately = false) {
        resetVideoGifSelectionPlayback();
        const max = Math.round(videoGifDuration * 1000);
        let value = Math.max(0, Math.min(max, Math.round(milliseconds)));
        if (point === 'start') {
          value = Math.min(value, videoGifEndMs - 1);
          value = Math.max(0, videoGifEndMs - 30_000, value);
          videoGifStartMs = value;
        } else {
          value = Math.max(value, videoGifStartMs + 1);
          value = Math.min(max, videoGifStartMs + 30_000, value);
          videoGifEndMs = value;
        }
        updateVideoGifSelection();
        seekVideoGif(value, previewImmediately);
      }
      function clearVideoGif() {
        resetVideoGifSelectionPlayback();
        videoGifFile = null; videoGifDuration = 0; videoGifStartMs = 0; videoGifEndMs = 30_000; videoGifStepMs = 33; videoGifPreviewTimestampMs = 0; videoGifSourceWidth = 0; videoGifSourceHeight = 0; videoGifSourceSize = 0;
        clearQueuedVideoPreview(videoGifPreviewState, videoGifPreviewImage);
        videoGifOverlay?.classList.remove('is-editing');
        if (videoGifEditor) videoGifEditor.hidden = true;
        if (videoGifEmpty) videoGifEmpty.hidden = false;
        updateVideoGifSelection();
      }
      function openVideoGifOverlay() { videoGifOverlay?.classList.add('visible'); if (videoGifPlasmaBg && !videoGifPlasmaDispose) videoGifPlasmaDispose = initStandardToolPlasma(videoGifPlasmaBg); }
      function closeVideoGifOverlay() { videoGifOverlay?.classList.remove('visible'); clearVideoGif(); if (videoGifPlasmaDispose) { videoGifPlasmaDispose(); videoGifPlasmaDispose = null; } }
      async function loadVideoGifFile(selected) {
        if (!isTauri) { window.showToast?.('视频 GIF 导出仅可在桌面端使用。'); return; }
        if (typeof selected !== 'string' || !selected) return;
        try {
          const file = localVideoFile(selected);
          validateVideoGifInput(file);
          const { invoke } = await tauriCorePromise;
          const probe = await invoke('probe_video', { inputPath: selected });
          const duration = Number(probe?.duration);
          if (!Number.isFinite(duration) || duration <= 0) throw new Error('无法读取视频时长。');
          resetVideoGifSelectionPlayback();
          clearQueuedVideoPreview(videoGifPreviewState, videoGifPreviewImage);
          videoGifStepMs = 33;
          if (Number.isFinite(probe?.frame_rate) && probe.frame_rate > 0 && probe.frame_rate <= 240) videoGifStepMs = 1000 / probe.frame_rate;
          videoGifFile = file;
          videoGifDuration = duration;
          videoGifSourceWidth = Number(probe?.width) || 0;
          videoGifSourceHeight = Number(probe?.height) || 0;
          videoGifSourceSize = Number(probe?.file_size ?? probe?.fileSize ?? file.size) || 0;
          const defaultSelection = createDefaultVideoGifSelection(duration);
          videoGifStartMs = defaultSelection.start_ms;
          videoGifEndMs = defaultSelection.end_ms;
          if (videoGifEndMs <= videoGifStartMs) throw new Error('视频时长不足以生成 GIF。');
          videoGifName.textContent = file.name;
          videoGifTimeline.max = String(Math.floor(duration * 1000));
          videoGifActivePoint = 'start';
          updateVideoGifSelection();
          videoGifEmpty.hidden = true;
          videoGifEditor.hidden = false;
          videoGifOverlay?.classList.add('is-editing');
          seekVideoGif(0, true);
        } catch (error) { window.showToast?.(error?.message || '无法读取视频文件。'); }
      }
      async function chooseVideoGifFile() {
        if (!isTauri) { window.showToast?.('视频 GIF 导出仅可在桌面端使用。'); return; }
        try {
          const { open } = await import('@tauri-apps/plugin-dialog');
          const selected = await open({ multiple: false, filters: [{ name: 'Video', extensions: videoExts }] });
          if (typeof selected !== 'string') return;
          await loadVideoGifFile(selected);
        } catch (error) { window.showToast?.(error?.message || '无法读取视频文件。'); }
      }
      videoGifTimeline?.addEventListener('input', () => setVideoGifPoint(videoGifActivePoint, Number(videoGifTimeline.value)));
      videoGifSelectStart?.addEventListener('click', () => { resetVideoGifSelectionPlayback(); videoGifActivePoint = 'start'; updateVideoGifSelection(); seekVideoGif(videoGifStartMs, true); });
      videoGifSelectEnd?.addEventListener('click', () => { resetVideoGifSelectionPlayback(); videoGifActivePoint = 'end'; updateVideoGifSelection(); seekVideoGif(videoGifEndMs, true); });
      videoGifPrev?.addEventListener('click', () => setVideoGifPoint(videoGifActivePoint, (videoGifActivePoint === 'start' ? videoGifStartMs : videoGifEndMs) - videoGifStepMs, true));
      videoGifNext?.addEventListener('click', () => setVideoGifPoint(videoGifActivePoint, (videoGifActivePoint === 'start' ? videoGifStartMs : videoGifEndMs) + videoGifStepMs, true));
      videoGifPick?.addEventListener('click', chooseVideoGifFile); videoGifChange?.addEventListener('click', chooseVideoGifFile); videoGifBack?.addEventListener('click', closeVideoGifOverlay);
      videoGifPreviewToggle?.addEventListener('click', () => {
        if (videoGifPreviewPlaybackLoading) return;
        if (videoGifRangePreview && !videoGifRangePreview.paused && !videoGifRangePreview.ended) pauseVideoGifSelectionPlayback();
        else void playVideoGifSelectionPlayback();
      });
      videoGifRangePreview?.addEventListener('play', updateVideoGifPreviewToggle);
      videoGifRangePreview?.addEventListener('pause', updateVideoGifPreviewToggle);
      videoGifRangePreview?.addEventListener('timeupdate', () => {
        if (!videoGifPreviewPlaybackRange) return;
        const timestamp = Math.min(videoGifEndMs, videoGifStartMs + Math.round(videoGifRangePreview.currentTime * 1000));
        videoGifPreviewTimestampMs = timestamp;
        if (videoGifTimeline) videoGifTimeline.value = String(timestamp);
        if (videoGifPreviewTime) videoGifPreviewTime.textContent = videoGifTimeLabel(timestamp);
        updateVideoGifTimelineVisual();
      });
      videoGifRangePreview?.addEventListener('ended', () => {
        if (!videoGifPreviewPlaybackRange || videoGifPreviewPlaybackRange !== videoGifSelectionKey()) {
          updateVideoGifPreviewToggle();
          return;
        }
        videoGifRangePreview.currentTime = 0;
        videoGifPreviewTimestampMs = videoGifStartMs;
        if (videoGifTimeline) videoGifTimeline.value = String(videoGifStartMs);
        if (videoGifPreviewTime) videoGifPreviewTime.textContent = videoGifTimeLabel(videoGifStartMs);
        updateVideoGifTimelineVisual();
        videoGifRangePreview.play().catch(() => updateVideoGifPreviewToggle());
      });
      videoGifFrameRateOptions?.addEventListener('click', event => { const button = event.target.closest('[data-fps]'); if (!button) return; videoGifFrameRate = Number(button.dataset.fps); videoGifFrameRateOptions.querySelectorAll('[data-fps]').forEach(item => item.classList.toggle('active', item === button)); updateVideoGifEstimate(); });
      videoGifResolutionOptions?.addEventListener('click', event => { const button = event.target.closest('[data-width]'); if (!button) return; videoGifWidth = Number(button.dataset.width); videoGifResolutionOptions.querySelectorAll('[data-width]').forEach(item => item.classList.toggle('active', item === button)); updateVideoGifEstimate(); });
      videoGifQualityOptions?.addEventListener('click', event => { const button = event.target.closest('[data-quality]'); if (!button) return; videoGifQuality = String(button.dataset.quality || 'balanced'); videoGifQualityOptions.querySelectorAll('[data-quality]').forEach(item => item.classList.toggle('active', item === button)); updateVideoGifEstimate(); });
      function closeVideoGifSuccess() { videoGifSuccessOverlay?.classList.remove('visible'); }
      videoGifSuccessOk?.addEventListener('click', closeVideoGifSuccess);
      videoGifOpenFolder?.addEventListener('click', () => { if (lastVideoGifOutputPath) openOutputFolder(lastVideoGifOutputPath).catch(() => {}); closeVideoGifSuccess(); });
      videoGifCancelBtn?.addEventListener('click', () => tauriCorePromise.then(({ invoke }) => invoke('cancel_convert')).catch(() => {}));
      videoGifExport?.addEventListener('click', async () => {
        if (!videoGifFile?.path || !isTauri || videoGifProcessing) return;
        let settings;
        try { settings = normalizeVideoGifRequest({ start_ms: videoGifStartMs, end_ms: videoGifEndMs, frame_rate: videoGifFrameRate, width: videoGifWidth, quality: videoGifQuality }, videoGifDuration); }
        catch (error) { window.showToast?.(error?.message || 'GIF 选区无效。'); return; }
        videoGifProcessing = true; videoGifProcessMask?.classList.add('visible');
        if (videoGifProcessBarFill) videoGifProcessBarFill.style.width = '8%';
        let unlisten;
        try {
          const [{ invoke }, { listen }] = await Promise.all([tauriCorePromise, tauriEventPromise]);
          unlisten = await listen('video-gif-progress', event => { const progress = Math.max(0, Math.min(1, Number(event.payload?.progress) || 0)); if (videoGifProcessBarFill) videoGifProcessBarFill.style.width = `${Math.max(8, progress * 100)}%`; if (videoGifProcessText) videoGifProcessText.textContent = event.payload?.phase === 'publish' ? '正在发布 GIF...' : '正在生成调色板与 GIF...'; });
          const result = await invoke('extract_video_gif', { inputPath: videoGifFile.path, outputDir: await getOutputDir('Videos'), startMs: settings.start_ms, endMs: settings.end_ms, frameRate: settings.frame_rate, width: settings.width, quality: settings.quality });
          lastVideoGifOutputPath = result.output_path || result.outputPath || '';
          if (videoGifSuccessMeta) videoGifSuccessMeta.textContent = videoGifFile.name;
          if (videoGifSuccessDuration) videoGifSuccessDuration.textContent = `${(settings.duration_ms / 1000).toFixed(3)} 秒`;
          if (videoGifSuccessSpec) videoGifSuccessSpec.textContent = `${settings.width}px / ${settings.frame_rate} FPS / ${videoGifQualityLabels[settings.quality] || '均衡'}`;
          if (videoGifSuccessSize) videoGifSuccessSize.textContent = formatFileSize(Number(result.output_size ?? result.outputSize ?? 0));
          if (videoGifSuccessPath) videoGifSuccessPath.textContent = displayFilesystemPath(lastVideoGifOutputPath);
          if (videoGifProcessBarFill) videoGifProcessBarFill.style.width = '100%';
          setTimeout(() => { videoGifProcessMask?.classList.remove('visible'); if (videoGifProcessBarFill) videoGifProcessBarFill.style.width = '0%'; videoGifSuccessOverlay?.classList.add('visible'); }, 240);
        } catch (error) { videoGifProcessMask?.classList.remove('visible'); if (videoGifProcessBarFill) videoGifProcessBarFill.style.width = '0%'; window.showToast?.(error?.message || 'GIF 导出失败。'); }
        finally { if (unlisten) unlisten(); videoGifProcessing = false; }
      });
      document.querySelectorAll('.audio-list-item[data-tool="video-gif"]').forEach(item => {
        item.addEventListener('click', () => openToolWithFfmpegCheck(openVideoGifOverlay));
        item.addEventListener('keydown', event => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            openToolWithFfmpegCheck(openVideoGifOverlay);
          }
        });
      });
      function showVideoGifDropZone() {
        videoGifDropZone?.classList.add('visible');
        videoGifOverlay?.classList.add('drag-over');
      }
      function hideVideoGifDropZone() {
        videoGifDropZone?.classList.remove('visible');
        videoGifOverlay?.classList.remove('drag-over');
      }
      if (videoGifOverlay && isTauri) {
        (async () => {
          const { getCurrentWebview } = await import('@tauri-apps/api/webview');
          await getCurrentWebview().onDragDropEvent(async event => {
            if (!videoGifOverlay.classList.contains('visible') || videoGifProcessing) return;
            const payload = event.payload;
            if (payload.type === 'enter' || payload.type === 'over') showVideoGifDropZone();
            else if (payload.type === 'leave') hideVideoGifDropZone();
            else if (payload.type === 'drop') {
              hideVideoGifDropZone();
              const selected = firstSupportedVideoPath(payload.paths || []);
              if (selected) await loadVideoGifFile(selected);
              else window.showToast?.('请拖入支持的视频文件。');
            }
          });
        })().catch(error => console.error('Cannot register video GIF drag and drop:', error));
      }

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
      const bpmProcessText = document.getElementById('bpmProcessText');
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
      let lastAnalyzedAudioBuffer = null;

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
        lastAnalyzedAudioBuffer = null;
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
        alert(getBpmErrorMessage(error));
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
        if (bpmPlasmaInstance) {
          bpmPlasmaInstance();
          bpmPlasmaInstance = null;
        }
        bpmProcessMask.classList.remove('visible');
        bpmProcessBarFill.style.width = '0%';
        lastAnalyzedAudioBuffer = null;
        if (bpmAudioContext) {
          const context = bpmAudioContext;
          bpmAudioContext = null;
          context.close().catch(() => {});
        }
        // Reset hero display
        bpmDetectHeroTop.style.display = '';
      }

      if (bpmDetectBack) {
        bpmDetectBack.addEventListener('click', closeBpmDetectOverlay);
      }

      // Click on audio-list-item with data-tool="bpm-detect" to open
      document.querySelectorAll('.audio-list-item[data-tool="bpm-detect"]').forEach(item => {
        item.addEventListener('click', () => {
          openBpmDetectOverlay();
        });
        item.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            openBpmDetectOverlay();
          }
        });
      });

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
        lastAnalyzedAudioBuffer = audioBuffer;
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
            const { open } = await import('@tauri-apps/plugin-dialog');
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
        bpmDetectCta.addEventListener('click', () => {
          selectBpmAudioFile();
        });
      }

      if (bpmReanalyzeBtn) {
        bpmReanalyzeBtn.addEventListener('click', () => {
          if (bpmAnalyzing) return;
          resetBpmResult();
          bpmReanalyzeTimer = setTimeout(() => {
            bpmReanalyzeTimer = null;
            if (bpmDetectOverlay.classList.contains('visible')) selectBpmAudioFile();
          }, 300);
        });
      }

      // Tauri native drag-drop for BPM overlay
      if (isTauri && bpmDetectOverlay) {
        (async () => {
          const { getCurrentWebview } = await import('@tauri-apps/api/webview');
          const webview = getCurrentWebview();
          await webview.onDragDropEvent((event) => {
            if (!bpmDetectOverlay.classList.contains('visible') || bpmAnalyzing) return;
            const payload = event.payload;
            if (payload.type === 'enter' || payload.type === 'over') {
              bpmDetectOverlay.classList.add('drag-over');
              bpmDropZone.classList.add('visible');
            } else if (payload.type === 'leave') {
              bpmDetectOverlay.classList.remove('drag-over');
              bpmDropZone.classList.remove('visible');
            } else if (payload.type === 'drop') {
              bpmDetectOverlay.classList.remove('drag-over');
              bpmDropZone.classList.remove('visible');
              const paths = payload.paths || [];
              if (paths.length === 0) return;
              const audioPath = paths.find(isBpmSupportedAudioName);
              if (audioPath) {
                analyzeBpmFromFile(audioPath);
              }
            }
          });
        })();
      }

      // HTML5 drag-drop fallback (non-Tauri)
      if (bpmDetectOverlay && !isTauri) {
        bpmDetectOverlay.addEventListener('dragover', (e) => {
          e.preventDefault();
          bpmDetectOverlay.classList.add('drag-over');
          bpmDropZone.classList.add('visible');
        });
        bpmDetectOverlay.addEventListener('dragleave', (e) => {
          if (e.relatedTarget && bpmDetectOverlay.contains(e.relatedTarget)) return;
          bpmDetectOverlay.classList.remove('drag-over');
          bpmDropZone.classList.remove('visible');
        });
        bpmDetectOverlay.addEventListener('drop', (e) => {
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
        beatIntervalId: null,
        beatTimeoutId: null,
        beatVisualTimeoutId: null,
        audioStartTime: 0
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
        if (bpmDemoState.beatIntervalId) {
          clearInterval(bpmDemoState.beatIntervalId);
          bpmDemoState.beatIntervalId = null;
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
        bpmDemoState.audioStartTime = 0;
        if (clearBuffer) bpmDemoState.audioBuffer = null;

        if (closeContext && bpmDemoState.audioContext) {
          const context = bpmDemoState.audioContext;
          bpmDemoState.audioContext = null;
          if (typeof context.close === 'function' && context.state !== 'closed') {
            context.close().catch(() => {});
          }
        }
      }

      function openBpmDemo(bpm, audioBuffer) {
        disposeBpmDemoPlayback({ clearBuffer: true, closeContext: true });
        bpmDemoState.bpm = bpm;
        bpmDemoState.audioBuffer = audioBuffer;
        bpmDemoBpmNumber.textContent = bpm;
        bpmDemoPlayBtn.disabled = false;
        bpmDemoPlayBtn.style.display = 'inline-flex';
        bpmDemoStopBtn.style.display = 'none';
        if (bpmDemoStatusText) {
          bpmDemoStatusText.textContent = t('home.bpmDetect.demoWorkspaceActive', { bpm });
        }
        bpmDemoOverlay.classList.add('visible');
        if (bpmAnalysisEmpty) {
          bpmAnalysisEmpty.style.display = 'none';
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
        bpmDemoClose.addEventListener('click', closeBpmDemo);
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
          bpmDemoState.audioStartTime = ctx.currentTime;
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
        bpmDemoPlayBtn.addEventListener('click', startBpmDemo);
      }

      if (bpmDemoStopBtn) {
        bpmDemoStopBtn.addEventListener('click', stopBpmDemo);
      }

      if (bpmDemoAudioVolume) {
        bpmDemoAudioVolume.addEventListener('input', () => {
          if (bpmDemoState.audioGainNode && bpmDemoState.audioContext) {
            const vol = parseInt(bpmDemoAudioVolume.value) / 100;
            bpmDemoState.audioGainNode.gain.setValueAtTime(vol, bpmDemoState.audioContext.currentTime);
          }
        });
      }

      if (bpmDemoBeatVolume) {
        bpmDemoBeatVolume.addEventListener('input', () => {
          if (bpmDemoState.beatGainNode && bpmDemoState.audioContext) {
            const vol = parseInt(bpmDemoBeatVolume.value) / 100;
            bpmDemoState.beatGainNode.gain.setValueAtTime(vol, bpmDemoState.audioContext.currentTime);
          }
        });
      }

      // ===== Audio Clip Editor =====
      const audioClipOverlay = document.getElementById('audioClipOverlay');
      const audioClipBack = document.getElementById('audioClipBack');
      const audioClipCta = document.getElementById('audioClipCta');
      const audioClipHeroTop = document.getElementById('audioClipHeroTop');
      const audioClipBody = document.getElementById('audioClipBody');
      const audioClipDropZone = document.getElementById('audioClipDropZone');
      const audioClipPlasmaBg = document.getElementById('audioClipPlasmaBg');
      const audioClipFileInfo = document.getElementById('audioClipFileInfo');
      const audioClipFileName = document.getElementById('audioClipFileName');
      const audioClipFileDuration = document.getElementById('audioClipFileDuration');
      const audioClipFileRemove = document.getElementById('audioClipFileRemove');
      const audioClipWaveformWrap = document.getElementById('audioClipWaveformWrap');
      const audioClipCanvas = document.getElementById('audioClipCanvas');
      const audioClipSelection = document.getElementById('audioClipSelection');
      const audioClipPlayhead = document.getElementById('audioClipPlayhead');
      const audioClipTimeStart = document.getElementById('audioClipTimeStart');
      const audioClipTimeEnd = document.getElementById('audioClipTimeEnd');
      const audioClipSelectionInfo = document.getElementById('audioClipSelectionInfo');
      const audioClipSelStart = document.getElementById('audioClipSelStart');
      const audioClipSelEnd = document.getElementById('audioClipSelEnd');
      const audioClipSelDuration = document.getElementById('audioClipSelDuration');
      const audioClipControls = document.getElementById('audioClipControls');
      const audioClipPlayBtn = document.getElementById('audioClipPlayBtn');
      const audioClipMinusBtn = document.getElementById('audioClipMinusBtn');
      const audioClipPlusBtn = document.getElementById('audioClipPlusBtn');
      const audioClipResetBtn = document.getElementById('audioClipResetBtn');
      const audioClipCurrentTime = document.getElementById('audioClipCurrentTime');
      const audioClipTotalTime = document.getElementById('audioClipTotalTime');
      const audioClipExportBtn = document.getElementById('audioClipExportBtn');
      const audioClipHandleStart = document.getElementById('audioClipHandleStart');
      const audioClipHandleEnd = document.getElementById('audioClipHandleEnd');
      const audioClipHandleStartLabel = document.getElementById('audioClipHandleStartLabel');
      const audioClipHandleEndLabel = document.getElementById('audioClipHandleEndLabel');
      const audioClipSuccessOverlay = document.getElementById('audioClipSuccessOverlay');
      const audioClipSuccessPath = document.getElementById('audioClipSuccessPath');
      const audioClipSuccessMeta = document.getElementById('audioClipSuccessMeta');
      const audioClipSuccessFile = document.getElementById('audioClipSuccessFile');
      const audioClipSuccessDuration = document.getElementById('audioClipSuccessDuration');
      const audioClipSuccessOpenFolder = document.getElementById('audioClipSuccessOpenFolder');
      const audioClipSuccessOk = document.getElementById('audioClipSuccessOk');
      const audioClipProcessMask = document.getElementById('audioClipProcessMask');
      const audioClipProcessBarFill = document.getElementById('audioClipProcessBarFill');
      const audioClipProcessText = document.getElementById('audioClipProcessText');
      let audioClipPlasmaInstance = null;
      let clipLoadId = 0;
      let clipExportRunId = 0;
      let clipRedrawRafId = 0;

      let clipState = {
        audioBuffer: null,
        audioContext: null,
        audioSource: null,
        isPlaying: false,
        currentTime: 0,
        duration: 0,
        filePath: null,
        fileName: '',
        selStart: 0,
        selEnd: 0,
        hasSelection: false,
        rafId: null,
        isLoading: false,
        isExporting: false,
        outputPath: '',
        activeHandle: null,
      };

      function isCurrentClipLoad(loadId) {
        return loadId === clipLoadId && audioClipOverlay.classList.contains('visible');
      }

      function isCurrentClipExport(runId) {
        return runId === clipExportRunId && audioClipOverlay.classList.contains('visible');
      }

      function getAudioClipErrorMessage(error) {
        if (error instanceof AudioClipError) {
          const key = {
            invalid_input: 'invalidInput',
            input_too_large: 'inputTooLarge',
            invalid_audio: 'decodeError',
            audio_too_long: 'audioTooLong',
            unsupported_channels: 'unsupportedChannels',
            decoded_audio_too_large: 'decodedAudioTooLarge',
            invalid_selection: 'invalidSelection'
          }[error.code];
          if (key) return t(`home.audioClip.${key}`);
        }
        const code = String(typeof error === 'string' ? error : error?.message || '').toLowerCase();
        const backendCodeMap = {
          'audio-clip:invalid-input': 'invalidInput',
          'audio-clip:input-too-large': 'inputTooLarge',
          'audio-clip:audio-too-long': 'audioTooLong',
          'audio-clip:invalid-selection': 'invalidSelection',
          'audio-clip:cancelled': 'cancelled',
          'audio-clip:output-path': 'outputPathError',
          'audio-clip:failed': 'exportError'
        };
        const matchedCode = Object.keys(backendCodeMap).find(key => code.includes(key));
        if (matchedCode) return t(`home.audioClip.${backendCodeMap[matchedCode]}`);
        if (code.includes('cancelled')) return t('home.audioClip.cancelled');
        return t('home.audioClip.exportError');
      }

      function invalidateClipExport() {
        const wasExporting = clipState.isExporting;
        clipExportRunId += 1;
        clipState.isExporting = false;
        if (audioClipExportBtn) {
          audioClipExportBtn.disabled = false;
          audioClipExportBtn.style.opacity = '';
        }
        if (audioClipProcessMask) audioClipProcessMask.classList.remove('visible');
        if (audioClipProcessBarFill) audioClipProcessBarFill.style.width = '0%';
        if (wasExporting && isTauri) {
          tauriCorePromise
            .then(({ invoke }) => invoke('cancel_convert'))
            .catch(() => {});
        }
      }

      function formatTime(sec) {
        if (!sec || isNaN(sec)) return '0:00';
        const m = Math.floor(sec / 60);
        const s = Math.floor(sec % 60);
        return `${m}:${s.toString().padStart(2, '0')}`;
      }

      function setAudioClipPlayIcon(isPlaying) {
        if (!audioClipPlayBtn) return;
        audioClipPlayBtn.innerHTML = isPlaying
          ? '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>'
          : '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><polygon points="6 4 20 12 6 20 6 4"/></svg>';
      }

      function openAudioClipOverlay() {
        audioClipOverlay.classList.add('visible');
        audioClipHeroTop.style.display = '';
        if (audioClipPlasmaBg && !audioClipPlasmaInstance) {
          audioClipPlasmaInstance = initStandardToolPlasma(audioClipPlasmaBg);
        }
      }

      function closeAudioClipOverlay() {
        audioClipOverlay.classList.remove('visible');
        stopClipPlayback();
        resetClipState();
        if (clipState.audioContext) {
          const context = clipState.audioContext;
          clipState.audioContext = null;
          context.close().catch(() => {});
        }
        // Destroy plasma instance to free GPU/CPU
        if (audioClipPlasmaInstance) {
          audioClipPlasmaInstance();
          audioClipPlasmaInstance = null;
        }
      }

      function clearClipLoadedState() {
        stopClipPlayback();
        if (clipRedrawRafId) {
          cancelAnimationFrame(clipRedrawRafId);
          clipRedrawRafId = 0;
        }
        clipState.audioBuffer = null;
        clipState.audioSource = null;
        clipState.currentTime = 0;
        clipState.duration = 0;
        clipState.filePath = null;
        clipState.fileName = '';
        clipState.outputPath = '';
        clipState.selStart = 0;
        clipState.selEnd = 0;
        clipState.hasSelection = false;
        clipState.activeHandle = null;
        if (audioClipFileInfo) audioClipFileInfo.classList.remove('visible');
        if (audioClipFileName) audioClipFileName.textContent = '--';
        if (audioClipFileDuration) audioClipFileDuration.textContent = '--';
        if (audioClipWaveformWrap) audioClipWaveformWrap.classList.remove('visible');
        if (audioClipControls) audioClipControls.classList.remove('visible');
        if (audioClipSelectionInfo) audioClipSelectionInfo.classList.remove('visible');
        if (audioClipExportBtn) audioClipExportBtn.classList.remove('visible');
        if (audioClipOverlay) audioClipOverlay.classList.remove('has-file', 'drag-over');
        if (audioClipDropZone) audioClipDropZone.classList.remove('visible');
        if (audioClipSelection) {
          audioClipSelection.style.display = 'none';
          audioClipSelection.style.width = '0px';
        }
        if (audioClipPlayhead) audioClipPlayhead.style.display = 'none';
        if (audioClipHandleStart) audioClipHandleStart.style.display = 'none';
        if (audioClipHandleEnd) audioClipHandleEnd.style.display = 'none';
        if (audioClipHandleStart) audioClipHandleStart.classList.remove('active');
        if (audioClipHandleEnd) audioClipHandleEnd.classList.remove('active');
        if (audioClipHeroTop) audioClipHeroTop.style.display = '';
        if (audioClipSuccessOverlay) audioClipSuccessOverlay.classList.remove('visible');
        if (audioClipCurrentTime) audioClipCurrentTime.textContent = '0:00';
        if (audioClipTotalTime) audioClipTotalTime.textContent = '0:00';
        if (audioClipTimeStart) audioClipTimeStart.textContent = '0:00';
        if (audioClipTimeEnd) audioClipTimeEnd.textContent = '0:00';
        if (audioClipSelStart) audioClipSelStart.textContent = '0:00';
        if (audioClipSelEnd) audioClipSelEnd.textContent = '0:00';
        if (audioClipSelDuration) audioClipSelDuration.textContent = '0:00';
        setActiveHandle(null);
      }

      function resetClipState() {
        clipLoadId += 1;
        invalidateClipExport();
        clipState.isLoading = false;
        clearClipLoadedState();
      }

      if (audioClipBack) {
        audioClipBack.addEventListener('click', closeAudioClipOverlay);
      }

      document.querySelectorAll('.audio-list-item[data-tool="audio-clip"]').forEach(item => {
        item.addEventListener('click', () => { openToolWithFfmpegCheck(openAudioClipOverlay); });
        item.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            openToolWithFfmpegCheck(openAudioClipOverlay);
          }
        });
      });

      async function selectClipAudioFile() {
        if (isTauri) {
          try {
            const { open } = await import('@tauri-apps/plugin-dialog');
            const selected = await open({
              multiple: false,
              filters: [{ name: 'Audio', extensions: ['mp3', 'wav', 'flac', 'aac', 'ogg', 'm4a', 'wma'] }],
            });
            if (selected) {
              loadClipAudioFile(selected);
            }
          } catch (e) {
            console.error('File select error:', e);
          }
        } else {
          const input = document.createElement('input');
          input.type = 'file';
          input.accept = 'audio/*';
          input.onchange = (e) => {
            const file = e.target.files[0];
            if (file) {
              loadClipAudioFile(file);
            }
          };
          input.click();
        }
      }

      if (audioClipCta) {
        audioClipCta.addEventListener('click', selectClipAudioFile);
      }

      if (audioClipFileRemove) {
        audioClipFileRemove.addEventListener('click', resetClipState);
      }

      async function loadClipAudioFile(filePathOrFile) {
        if (clipState.isLoading || clipState.isExporting) return;
        const loadId = ++clipLoadId;
        clipState.isLoading = true;
        clearClipLoadedState();

        // Show loading mask
        audioClipProcessBarFill.style.width = '30%';
        audioClipProcessText.textContent = t('home.audioClip.loading');
        audioClipProcessMask.classList.add('visible');
        let arrayBuffer;
        let fileName;
        let sourcePath = null;

        try {
          if (typeof filePathOrFile === 'string') {
            sourcePath = filePathOrFile;
            fileName = filePathOrFile.split(/[/\\]/).pop() || filePathOrFile;
            audioClipProcessBarFill.style.width = '50%';
            if (!isTauri) throw new AudioClipError('invalid_input', 'Desktop file paths are unavailable in a browser.');
            const { invoke } = await tauriCorePromise;
            const size = Number(await invoke('get_file_size', { path: filePathOrFile }));
            assertAudioClipInput({ name: fileName, size });
            if (!isCurrentClipLoad(loadId)) return;
            const bytes = await invoke('read_file_bytes_limited', {
              path: filePathOrFile,
              maxBytes: 100 * 1024 * 1024
            });
            if (!isCurrentClipLoad(loadId)) return;
            arrayBuffer = new Uint8Array(bytes).buffer;
          } else {
            fileName = filePathOrFile?.name || '';
            assertAudioClipInput(filePathOrFile);
            if (isTauri && filePathOrFile.path) {
              const { invoke } = await tauriCorePromise;
              sourcePath = filePathOrFile.path;
              const size = Number(await invoke('get_file_size', { path: sourcePath }));
              assertAudioClipInput({ name: fileName, size });
              if (!isCurrentClipLoad(loadId)) return;
              const bytes = await invoke('read_file_bytes_limited', {
                path: sourcePath,
                maxBytes: 100 * 1024 * 1024
              });
              if (!isCurrentClipLoad(loadId)) return;
              arrayBuffer = new Uint8Array(bytes).buffer;
            } else {
              arrayBuffer = await filePathOrFile.arrayBuffer();
            }
          }
          if (!isCurrentClipLoad(loadId)) return;
          audioClipProcessBarFill.style.width = '70%';
          if (!clipState.audioContext) {
            clipState.audioContext = new (window.AudioContext || window.webkitAudioContext)();
          }
          if (clipState.audioContext.state === 'suspended') {
            await clipState.audioContext.resume();
          }
          const audioBuffer = await clipState.audioContext.decodeAudioData(arrayBuffer);
          if (!isCurrentClipLoad(loadId)) return;
          assertAudioClipBuffer(audioBuffer);
          audioClipProcessBarFill.style.width = '90%';
          const duration = audioBuffer.duration;
          clipState.audioBuffer = audioBuffer;
          clipState.filePath = sourcePath;
          clipState.fileName = fileName;
          clipState.duration = duration;
          clipState.currentTime = 0;
          clipState.selStart = 0;
          clipState.selEnd = duration;
          clipState.hasSelection = true;
          setActiveHandle('start');

          // Update UI
          audioClipHeroTop.style.display = 'none';
          audioClipOverlay.classList.add('has-file');
          audioClipFileInfo.classList.add('visible');
          audioClipFileName.textContent = fileName || '--';
          audioClipFileDuration.textContent = formatTime(duration);
          audioClipWaveformWrap.classList.add('visible');
          audioClipControls.classList.add('visible');
          audioClipSelectionInfo.classList.add('visible');
          audioClipExportBtn.classList.add('visible');

          audioClipTimeStart.textContent = '0:00';
          audioClipTimeEnd.textContent = formatTime(duration);
          audioClipTotalTime.textContent = formatTime(duration);
          audioClipCurrentTime.textContent = '0:00';
          audioClipSelStart.textContent = '0:00';
          audioClipSelEnd.textContent = formatTime(duration);
          audioClipSelDuration.textContent = formatTime(duration);

          audioClipProcessBarFill.style.width = '100%';

          // Draw waveform (deferred to ensure canvas has dimensions after CSS transition)
          scheduleAudioClipRedraw();

          if (window.lucide) window.lucide.createIcons();
        } catch (error) {
          console.error('Audio clip load error:', error);
          if (isCurrentClipLoad(loadId)) alert(getAudioClipErrorMessage(error));
        } finally {
          if (isCurrentClipLoad(loadId)) {
            audioClipProcessMask.classList.remove('visible');
            audioClipProcessBarFill.style.width = '0%';
            clipState.isLoading = false;
          }
        }
      }

      function drawWaveform() {
        if (!clipState.audioBuffer || !audioClipCanvas) return;
        const canvas = audioClipCanvas;
        const ctx = canvas.getContext('2d');
        const dpr = window.devicePixelRatio || 1;
        const rect = canvas.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return;
        canvas.width = rect.width * dpr;
        canvas.height = rect.height * dpr;
        ctx.scale(dpr, dpr);

        const width = rect.width;
        const height = rect.height;
        const buffer = clipState.audioBuffer;
        const channelCount = Math.max(1, Math.min(buffer.numberOfChannels || 1, 2));
        const channels = Array.from({ length: channelCount }, (_, index) => buffer.getChannelData(index));
        const samplesPerPixel = Math.max(1, Math.floor(buffer.length / width));

        ctx.clearRect(0, 0, width, height);
        ctx.fillStyle = 'rgba(255, 255, 255, 0.78)';
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.18)';
        ctx.lineWidth = 1;

        const midY = height / 2;
        ctx.beginPath();
        ctx.moveTo(0, midY);
        ctx.lineTo(width, midY);
        ctx.stroke();

        for (let x = 0; x < width; x++) {
          let min = 1.0;
          let max = -1.0;
          const start = x * samplesPerPixel;
          const end = Math.min(start + samplesPerPixel, buffer.length);
          const sampleStep = Math.max(1, Math.ceil((end - start) / 1024));
          for (let i = start; i < end; i += sampleStep) {
            for (const channelData of channels) {
              const v = channelData[i] || 0;
              if (v < min) min = v;
              if (v > max) max = v;
            }
          }
          const yMin = midY + min * midY * 0.9;
          const yMax = midY + max * midY * 0.9;
          ctx.fillRect(x, yMin, 1, Math.max(2, yMax - yMin));
        }
      }

      function getClipTrackMetrics() {
        const canvasRect = audioClipCanvas.getBoundingClientRect();
        const wrapRect = audioClipWaveformWrap.getBoundingClientRect();
        const left = Math.max(0, canvasRect.left - wrapRect.left);
        const width = Math.max(1, canvasRect.width);
        return { left, width, canvasLeft: canvasRect.left };
      }

      function timeToX(time) {
        const { left, width } = getClipTrackMetrics();
        if (!clipState.duration) return left;
        return left + (time / clipState.duration) * width;
      }

      function clientXToClipTime(clientX) {
        const { canvasLeft, width } = getClipTrackMetrics();
        const ratio = Math.max(0, Math.min(1, (clientX - canvasLeft) / width));
        return ratio * clipState.duration;
      }

      function scheduleAudioClipRedraw() {
        if (!clipState.audioBuffer || !audioClipWaveformWrap.classList.contains('visible')) return;
        if (clipRedrawRafId) cancelAnimationFrame(clipRedrawRafId);
        clipRedrawRafId = requestAnimationFrame(() => {
          clipRedrawRafId = 0;
          drawWaveform();
          updateSelectionOverlay();
          updatePlayhead();
        });
      }

      function setActiveHandle(handle) {
        clipState.activeHandle = handle;
        audioClipHandleStart.classList.toggle('active', handle === 'start');
        audioClipHandleEnd.classList.toggle('active', handle === 'end');
        if (handle) {
          audioClipMinusBtn.disabled = false;
          audioClipPlusBtn.disabled = false;
        } else {
          audioClipMinusBtn.disabled = true;
          audioClipPlusBtn.disabled = true;
        }
      }

      function updateSelectionOverlay() {
        if (!clipState.hasSelection) {
          audioClipSelection.style.display = 'none';
          audioClipHandleStart.style.display = 'none';
          audioClipHandleEnd.style.display = 'none';
          setActiveHandle(null);
          return;
        }
        const startX = timeToX(clipState.selStart);
        const endX = timeToX(clipState.selEnd);
        audioClipSelection.style.display = 'block';
        audioClipSelection.style.left = `${startX}px`;
        audioClipSelection.style.width = `${endX - startX}px`;

        audioClipHandleStart.style.display = 'flex';
        audioClipHandleStart.style.left = `${startX}px`;
        audioClipHandleStartLabel.textContent = formatTime(clipState.selStart);

        audioClipHandleEnd.style.display = 'flex';
        audioClipHandleEnd.style.left = `${endX}px`;
        audioClipHandleEndLabel.textContent = formatTime(clipState.selEnd);

        audioClipSelStart.textContent = formatTime(clipState.selStart);
        audioClipSelEnd.textContent = formatTime(clipState.selEnd);
        audioClipSelDuration.textContent = formatTime(clipState.selEnd - clipState.selStart);
      }

      function updatePlayhead() {
        if (!clipState.duration) {
          audioClipPlayhead.style.display = 'none';
          return;
        }
        const x = timeToX(clipState.currentTime);
        audioClipPlayhead.style.display = 'block';
        audioClipPlayhead.style.left = `${x}px`;
        audioClipCurrentTime.textContent = formatTime(clipState.currentTime);
      }

      function startClipPlayback() {
        if (!clipState.audioBuffer || clipState.isPlaying) return;
        clipState.isPlaying = true;
        const ctx = clipState.audioContext;
        if (ctx.state === 'suspended') ctx.resume().catch(() => {});

        const selStart = clipState.hasSelection ? clipState.selStart : 0;
        const selEnd = clipState.hasSelection ? clipState.selEnd : clipState.duration;

        function playSegment(fromTime) {
          // Cancel any existing animation frame before starting a new segment
          if (clipState.rafId) {
            cancelAnimationFrame(clipState.rafId);
            clipState.rafId = null;
          }
          const source = ctx.createBufferSource();
          source.buffer = clipState.audioBuffer;
          source.connect(ctx.destination);
          source.start(0, fromTime);
          clipState.audioSource = source;
          const startTime = ctx.currentTime - fromTime;

          source.onended = () => {
            // Only handle natural end (buffer exhausted), not manual stop
            if (clipState.isPlaying && clipState.audioSource === source) {
              clipState.audioSource = null;
              // Loop back to selStart
              if (clipState.isPlaying) {
                clipState.currentTime = selStart;
                playSegment(selStart);
              }
            }
          };

          function tick() {
            if (!clipState.isPlaying) return;
            clipState.currentTime = ctx.currentTime - startTime;
            if (clipState.currentTime >= selEnd) {
              // Reached end of selection — loop back to start
              try { source.stop(); } catch(e) {}
              clipState.audioSource = null;
              clipState.currentTime = selStart;
              playSegment(selStart);
              return;
            }
            updatePlayhead();
            clipState.rafId = requestAnimationFrame(tick);
          }
          clipState.rafId = requestAnimationFrame(tick);
        }

        // Start from current position if within selection, otherwise from selStart
        const startOffset = (clipState.currentTime >= selStart && clipState.currentTime < selEnd) ? clipState.currentTime : selStart;
        clipState.currentTime = startOffset;
        playSegment(startOffset);

        setAudioClipPlayIcon(true);
      }

      function stopClipPlayback() {
        if (clipState.audioSource) {
          try { clipState.audioSource.stop(); } catch(e) {}
          clipState.audioSource = null;
        }
        if (clipState.rafId) {
          cancelAnimationFrame(clipState.rafId);
          clipState.rafId = null;
        }
        clipState.isPlaying = false;
        setAudioClipPlayIcon(false);
      }

      function togglePlayPause() {
        if (clipState.isPlaying) {
          stopClipPlayback();
        } else {
          startClipPlayback();
        }
      }

      if (audioClipPlayBtn) {
        audioClipPlayBtn.addEventListener('click', togglePlayPause);
      }

      if (audioClipMinusBtn) {
        audioClipMinusBtn.addEventListener('click', () => {
          if (!clipState.hasSelection || !clipState.activeHandle) return;
          stopClipPlayback();
          if (clipState.activeHandle === 'end') {
            clipState.selEnd = Math.max(clipState.selStart + 0.1, clipState.selEnd - 1);
          } else {
            clipState.selStart = Math.max(0, clipState.selStart - 1);
            if (clipState.selStart >= clipState.selEnd) clipState.selStart = Math.max(0, clipState.selEnd - 0.1);
          }
          clipState.currentTime = clipState.activeHandle === 'end' ? clipState.selEnd : clipState.selStart;
          updatePlayhead();
          updateSelectionOverlay();
        });
      }

      if (audioClipPlusBtn) {
        audioClipPlusBtn.addEventListener('click', () => {
          if (!clipState.hasSelection || !clipState.activeHandle) return;
          stopClipPlayback();
          if (clipState.activeHandle === 'end') {
            clipState.selEnd = Math.min(clipState.duration, clipState.selEnd + 1);
          } else {
            clipState.selStart = Math.min(clipState.selEnd - 0.1, clipState.selStart + 1);
          }
          clipState.currentTime = clipState.activeHandle === 'end' ? clipState.selEnd : clipState.selStart;
          updatePlayhead();
          updateSelectionOverlay();
        });
      }

      if (audioClipResetBtn) {
        audioClipResetBtn.addEventListener('click', () => {
          stopClipPlayback();
          clipState.currentTime = 0;
          clipState.selStart = 0;
          clipState.selEnd = clipState.duration;
          clipState.hasSelection = true;
          setActiveHandle('start');
          updatePlayhead();
          updateSelectionOverlay();
        });
      }

      // Handle-based selection: drag start/end handles to select region.
      // Canvas pointer only moves playhead, keeping clip selection intentional.
      if (audioClipCanvas) {
        audioClipCanvas.addEventListener('pointerdown', (e) => {
          if (!clipState.audioBuffer) return;
          if (e.pointerType === 'mouse' && e.button !== 0) return;
          const time = clientXToClipTime(e.clientX);
          stopClipPlayback();
          clipState.currentTime = time;
          setActiveHandle(null);
          updatePlayhead();
        });
      }

      function beginAudioClipHandleDrag(event, handle) {
        if (!clipState.audioBuffer) return;
        if (event.pointerType === 'mouse' && event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        setActiveHandle(handle);
        stopClipPlayback();
        event.currentTarget?.setPointerCapture?.(event.pointerId);
        document.body.classList.add('audio-clip-pointer-dragging');

        function onMove(ev) {
          const time = clientXToClipTime(ev.clientX);
          if (handle === 'start') {
            clipState.selStart = Math.max(0, Math.min(clipState.selEnd - 0.1, time));
            clipState.currentTime = clipState.selStart;
          } else {
            clipState.selEnd = Math.min(clipState.duration, Math.max(clipState.selStart + 0.1, time));
            clipState.currentTime = clipState.selEnd;
          }
          updatePlayhead();
          updateSelectionOverlay();
        }
        function onUp() {
          document.body.classList.remove('audio-clip-pointer-dragging');
          document.removeEventListener('pointermove', onMove);
          document.removeEventListener('pointerup', onUp);
          document.removeEventListener('pointercancel', onUp);
        }
        document.addEventListener('pointermove', onMove);
        document.addEventListener('pointerup', onUp);
        document.addEventListener('pointercancel', onUp);
      }

      if (audioClipHandleStart) {
        audioClipHandleStart.addEventListener('pointerdown', event => beginAudioClipHandleDrag(event, 'start'));
      }

      if (audioClipHandleEnd) {
        audioClipHandleEnd.addEventListener('pointerdown', event => beginAudioClipHandleDrag(event, 'end'));
      }

      // Export clip
      if (audioClipExportBtn) {
        audioClipExportBtn.addEventListener('click', async () => {
          if (clipState.isExporting) return;
          if (!isTauri) {
            alert(t('home.audioClip.desktopOnly'));
            return;
          }
          if (!clipState.filePath) {
            alert(t('home.audioClip.noFile'));
            return;
          }
          let selection;
          try {
            selection = assertAudioClipSelection(
              clipState.hasSelection ? clipState.selStart : 0,
              clipState.hasSelection ? clipState.selEnd : clipState.duration,
              clipState.duration
            );
          } catch (error) {
            alert(getAudioClipErrorMessage(error));
            return;
          }
          const request = {
            inputPath: clipState.filePath,
            fileName: clipState.fileName,
            startTime: selection.start,
            endTime: selection.end,
            duration: selection.end - selection.start
          };
          const runId = ++clipExportRunId;
          clipState.isExporting = true;
          audioClipExportBtn.disabled = true;
          audioClipExportBtn.style.opacity = '0.6';
          audioClipProcessBarFill.style.width = '15%';
          audioClipProcessText.textContent = t('home.audioClip.exporting');
          audioClipProcessMask.classList.add('visible');

          try {
            const { invoke } = await tauriCorePromise;
            const outputDir = await getOutputDir('Audio');
            if (!isCurrentClipExport(runId)) return;

            const ffmpegReady = await ensureFfmpegAvailable();
            if (!isCurrentClipExport(runId)) return;
            if (!ffmpegReady) throw new Error('Audio trim runtime unavailable');

            audioClipProcessBarFill.style.width = '70%';
            const result = await invoke('trim_audio', {
              inputPath: request.inputPath,
              outputDir,
              startTime: request.startTime,
              endTime: request.endTime,
            });
            if (!isCurrentClipExport(runId)) return;
            if (!result?.success || !result.output_path) throw new Error(result?.error || 'Audio trim failed');

            audioClipProcessBarFill.style.width = '100%';
            clipState.outputPath = result.output_path;
            const durStr = formatTime(request.duration);
            if (audioClipSuccessMeta) {
              audioClipSuccessMeta.textContent = t('home.audioClip.successSummary', { name: request.fileName, duration: durStr });
            }
            if (audioClipSuccessFile) audioClipSuccessFile.textContent = request.fileName;
            if (audioClipSuccessDuration) audioClipSuccessDuration.textContent = durStr;
            if (audioClipSuccessPath) audioClipSuccessPath.textContent = displayFilesystemPath(result.output_path);
            audioClipSuccessOverlay.classList.add('visible');
          } catch (error) {
            if (isCurrentClipExport(runId)) {
              console.error('Audio clip export error:', error);
              alert(getAudioClipErrorMessage(error));
            }
          } finally {
            if (!isCurrentClipExport(runId)) return;
            audioClipProcessMask.classList.remove('visible');
            audioClipProcessBarFill.style.width = '0%';
            audioClipProcessText.textContent = t('home.audioClip.loading');
            clipState.isExporting = false;
            audioClipExportBtn.disabled = false;
            audioClipExportBtn.style.opacity = '';
          }
        });
      }

      // Success dialog
      if (audioClipSuccessOk) {
        audioClipSuccessOk.addEventListener('click', () => {
          audioClipSuccessOverlay.classList.remove('visible');
        });
      }
      if (audioClipSuccessOpenFolder) {
        audioClipSuccessOpenFolder.addEventListener('click', async () => {
          if (isTauri && clipState.outputPath) {
            await openOutputFolder(outputParentFolder(clipState.outputPath));
          }
        });
      }

      // Tauri native drag-drop for audio clip overlay
      if (isTauri && audioClipOverlay) {
        (async () => {
          const { getCurrentWebview } = await import('@tauri-apps/api/webview');
          const webview = getCurrentWebview();
          await webview.onDragDropEvent((event) => {
            if (!audioClipOverlay.classList.contains('visible') || clipState.isLoading || clipState.isExporting) return;
            const payload = event.payload;
            if (payload.type === 'enter' || payload.type === 'over') {
              audioClipOverlay.classList.add('drag-over');
              audioClipDropZone.classList.add('visible');
            } else if (payload.type === 'leave') {
              audioClipOverlay.classList.remove('drag-over');
              audioClipDropZone.classList.remove('visible');
            } else if (payload.type === 'drop') {
              audioClipOverlay.classList.remove('drag-over');
              audioClipDropZone.classList.remove('visible');
              const paths = payload.paths || [];
              if (paths.length === 0) return;
              loadClipAudioFile(paths[0]);
            }
          });
        })();
      }

      // HTML5 drag-drop fallback (non-Tauri)
      if (audioClipOverlay && !isTauri) {
        audioClipOverlay.addEventListener('dragover', (e) => {
          if (clipState.isLoading || clipState.isExporting) return;
          e.preventDefault();
          audioClipOverlay.classList.add('drag-over');
          audioClipDropZone.classList.add('visible');
        });
        audioClipOverlay.addEventListener('dragleave', (e) => {
          if (e.relatedTarget && audioClipOverlay.contains(e.relatedTarget)) return;
          audioClipOverlay.classList.remove('drag-over');
          audioClipDropZone.classList.remove('visible');
        });
        audioClipOverlay.addEventListener('drop', (e) => {
          if (clipState.isLoading || clipState.isExporting) return;
          e.preventDefault();
          audioClipOverlay.classList.remove('drag-over');
          audioClipDropZone.classList.remove('visible');
          const file = e.dataTransfer.files[0];
          if (file && (file.type.startsWith('audio/') || isAudioClipSupportedName(file.name))) {
            loadClipAudioFile(file);
          }
        });
      }

      // Redraw waveform on window resize
      window.addEventListener('resize', () => {
        scheduleAudioClipRedraw();
        syncWindowFrameAfterLayoutChange();
      });

      // Random marquee reviews
      const marqueeTrack = document.getElementById('marqueeTrack');
      if (marqueeTrack) {
        function getReviewers() {
          return [
            { name: 'Sarah', text: t('home.feedbackPage.review1') },
            { name: 'Michael', text: t('home.feedbackPage.review2') },
            { name: 'Emily', text: t('home.feedbackPage.review3') },
            { name: 'David', text: t('home.feedbackPage.review4') },
            { name: 'Jessica', text: t('home.feedbackPage.review5') },
            { name: 'James', text: t('home.feedbackPage.review6') },
            { name: 'Olivia', text: t('home.feedbackPage.review7') },
            { name: 'Christopher', text: t('home.feedbackPage.review8') },
            { name: 'Amanda', text: t('home.feedbackPage.review9') },
            { name: 'Matthew', text: t('home.feedbackPage.review10') },
            { name: 'Elizabeth', text: t('home.feedbackPage.review11') },
            { name: 'Daniel', text: t('home.feedbackPage.review12') }
          ];
        }

        function renderReviews() {
          const stars = Array.from({ length: 5 }, () => '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" stroke="none"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>').join('');
          const reviewers = getReviewers();

          const cards = reviewers.map((r, i) => {
            const initial = r.name.charAt(0).toUpperCase();
            const palettes = [
              ['#667eea', '#764ba2'], ['#f093fb', '#f5576c'], ['#4facfe', '#00f2fe'],
              ['#43e97b', '#38f9d7'], ['#fa709a', '#fee140'], ['#30cfd0', '#330867'],
              ['#a8edea', '#fed6e3'], ['#ff9a9e', '#fecfef'], ['#ffecd2', '#fcb69f'],
              ['#a18cd1', '#fbc2eb'], ['#fbc2eb', '#a6c1ee'], ['#84fab0', '#8fd3f4']
            ];
            const [c1, c2] = palettes[i % palettes.length];
            const avatarSvg = `<div class="marquee-avatar" style="background:linear-gradient(135deg,${c1},${c2});display:flex;align-items:center;justify-content:center;font-size:15px;font-weight:700;color:#fff;flex-shrink:0;">${escapeHtml(initial)}</div>`;
            return `
              <div class="marquee-card">
                <div class="marquee-card-header">
                  ${avatarSvg}
                  <div class="marquee-info">
                    <div class="marquee-name">${escapeHtml(r.name)}</div>
                    <div class="marquee-stars">${stars}</div>
                  </div>
                </div>
                <p class="marquee-text">${escapeHtml(r.text)}</p>
              </div>
            `;
          }).join('');

          // Duplicate for seamless loop
          marqueeTrack.innerHTML = cards + cards;
        }

        renderReviews();
        onLangChange(renderReviews);
      }

      // ===== Legal Overlay (Declaration & Usage Policy) =====
      const legalOverlay = document.getElementById('legalOverlay');
      const legalBackBtn = document.getElementById('legalBackBtn');
      const legalNav = document.getElementById('legalNav');
      const legalContentTitle = document.getElementById('legalContentTitle');
      const legalContentBody = document.getElementById('legalContentBody');

      function showLegalSection(sectionId) {
        const content = getLegalContent();
        if (!content || !content[sectionId]) return;
        const data = content[sectionId];
        if (legalContentTitle) legalContentTitle.textContent = data.title;
        if (legalContentBody) {
          legalContentBody.innerHTML = data.html;
          legalContentBody.scrollTop = 0;
        }
        if (legalNav) {
          legalNav.querySelectorAll('.help-nav-item').forEach(item => {
            item.classList.toggle('active', item.dataset.legalSection === sectionId);
          });
        }
      }

      function openLegalOverlay(sectionId) {
        if (legalOverlay) legalOverlay.classList.add('visible');
        showLegalSection(sectionId || 'declaration');
      }

      function closeLegalOverlay() {
        if (legalOverlay) legalOverlay.classList.remove('visible');
      }

      if (legalBackBtn) {
        legalBackBtn.addEventListener('click', closeLegalOverlay);
      }

      if (legalNav) {
        legalNav.querySelectorAll('.help-nav-item').forEach(item => {
          item.addEventListener('click', () => {
            const section = item.dataset.legalSection;
            if (section) showLegalSection(section);
          });
        });
      }

      if (declarationLink) {
        declarationLink.addEventListener('click', (e) => {
          e.preventDefault();
          openLegalOverlay('declaration');
        });
      }

      if (usagePolicyLink) {
        usagePolicyLink.addEventListener('click', (e) => {
          e.preventDefault();
          openLegalOverlay('usage-policy');
        });
      }

      // Refresh legal content on language change
      onLangChange(() => {
        if (legalOverlay && legalOverlay.classList.contains('visible')) {
          const activeItem = legalNav && legalNav.querySelector('.help-nav-item.active');
          showLegalSection(activeItem ? activeItem.dataset.legalSection : 'declaration');
        }
      });

      // API key configuration lives in Settings in the open-source desktop app.
      const btnApiKey = document.getElementById('settingsApiKey');
      const apiKeyOverlay = document.getElementById('apiKeyOverlay');
      const apiKeyBack = document.getElementById('apiKeyBack');
      const apiKeyInput = document.getElementById('apiKeyInput');
      const apiKeyToggle = document.getElementById('apiKeyToggle');
      const apiKeySave = document.getElementById('apiKeySave');
      const apiKeyClear = document.getElementById('apiKeyClear');
      const apiKeyStatus = document.getElementById('apiKeyStatus');
      const apiKeyDropdown = document.getElementById('apiKeyDropdown');
      const apiKeyDropdownTrigger = document.getElementById('apiKeyDropdownTrigger');
      const apiKeyDropdownMenu = document.getElementById('apiKeyDropdownMenu');
      const apiKeyDropdownValue = document.getElementById('apiKeyDropdownValue');
      let apiKeyPlatformValue = 'deepseek';
      const apiKeyCustomWrap = document.getElementById('apiKeyCustomWrap');
      const apiKeyCustomUrl = document.getElementById('apiKeyCustomUrl');
      const apiKeyCustomModel = document.getElementById('apiKeyCustomModel');
      const apiKeyPrivateHttpSwitch = document.getElementById('apiKeyPrivateHttpSwitch');

      // AI platform configurations
      const AI_PLATFORMS = {
        deepseek: { url: 'https://api.deepseek.com/v1/chat/completions', model: 'deepseek-chat', label: 'DeepSeek' },
        openai: { url: 'https://api.openai.com/v1/chat/completions', model: 'gpt-4o-mini', label: 'OpenAI' },
        qwen: { url: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', model: 'qwen-plus', label: 'Qwen' },
        moonshot: { url: 'https://api.moonshot.cn/v1/chat/completions', model: 'moonshot-v1-8k', label: 'Moonshot' },
        custom: { url: '', model: '' },
      };

      function getAiPlatformConfig() {
        const platform = localStorage.getItem('ai_platform') || 'deepseek';
        const base = AI_PLATFORMS[platform] || AI_PLATFORMS.deepseek;
        if (platform === 'custom') {
          return {
            url: localStorage.getItem('ai_custom_url') || '',
            model: localStorage.getItem('ai_custom_model') || '',
            allowPrivateHttp: localStorage.getItem('ai_custom_allow_private_http') === 'true',
          };
        }
        return { url: base.url, model: base.model, allowPrivateHttp: false };
      }

      function hasAiApiKey() {
        return Boolean(aiApiKeyCache);
      }

      function setApiKeyPlatform(value) {
        apiKeyPlatformValue = value;
        const items = apiKeyDropdownMenu.querySelectorAll('.api-key-dropdown-item');
        items.forEach(item => {
          item.classList.toggle('active', item.dataset.value === value);
          if (item.dataset.value === value) {
            apiKeyDropdownValue.textContent = item.textContent;
          }
        });
        if (value === 'custom') {
          if (apiKeyCustomWrap) apiKeyCustomWrap.style.display = '';
        } else {
          if (apiKeyCustomWrap) apiKeyCustomWrap.style.display = 'none';
        }
      }

      function setPrivateHttpPermission(enabled) {
        if (!apiKeyPrivateHttpSwitch) return;
        apiKeyPrivateHttpSwitch.classList.toggle('active', enabled);
        apiKeyPrivateHttpSwitch.setAttribute('aria-checked', enabled ? 'true' : 'false');
      }

      if (apiKeyPrivateHttpSwitch) {
        apiKeyPrivateHttpSwitch.addEventListener('click', () => {
          setPrivateHttpPermission(apiKeyPrivateHttpSwitch.getAttribute('aria-checked') !== 'true');
        });
      }

      if (apiKeyDropdownTrigger && apiKeyDropdown) {
        apiKeyDropdownTrigger.addEventListener('click', (e) => {
          e.stopPropagation();
          apiKeyDropdown.classList.toggle('open');
        });
        document.addEventListener('click', (e) => {
          if (!apiKeyDropdown.contains(e.target)) {
            apiKeyDropdown.classList.remove('open');
          }
        });
      }
      if (apiKeyDropdownMenu) {
        apiKeyDropdownMenu.querySelectorAll('.api-key-dropdown-item').forEach(item => {
          item.addEventListener('click', () => {
            setApiKeyPlatform(item.dataset.value);
            apiKeyDropdown.classList.remove('open');
          });
        });
      }

      if (btnApiKey && apiKeyOverlay) {
        btnApiKey.addEventListener('click', async (e) => {
          e.stopPropagation();
          const savedPlatform = localStorage.getItem('ai_platform') || 'deepseek';
          const savedKey = await getAiApiKey();
          setApiKeyPlatform(savedPlatform);
          apiKeyInput.value = savedKey;
          if (apiKeyCustomUrl) apiKeyCustomUrl.value = localStorage.getItem('ai_custom_url') || '';
          if (apiKeyCustomModel) apiKeyCustomModel.value = localStorage.getItem('ai_custom_model') || '';
          setPrivateHttpPermission(localStorage.getItem('ai_custom_allow_private_http') === 'true');
          apiKeyStatus.classList.remove('show', 'success', 'error');
          apiKeyOverlay.classList.add('visible');
        });
      }
      if (apiKeyBack && apiKeyOverlay) {
        apiKeyBack.addEventListener('click', () => {
          apiKeyOverlay.classList.remove('visible');
        });
      }
      if (apiKeyToggle) {
        apiKeyToggle.addEventListener('click', () => {
          apiKeyInput.type = apiKeyInput.type === 'password' ? 'text' : 'password';
        });
      }
      if (apiKeySave) {
        apiKeySave.addEventListener('click', async () => {
          const key = apiKeyInput.value.trim();
          if (!key) {
            apiKeyStatus.textContent = t('apiKey.errEmpty');
            apiKeyStatus.className = 'api-key-status show error';
            return;
          }
          const platform = apiKeyPlatformValue;
          let customUrl = '';
          let customModel = '';
          if (platform === 'custom') {
            customUrl = apiKeyCustomUrl ? apiKeyCustomUrl.value.trim() : '';
            customModel = apiKeyCustomModel ? apiKeyCustomModel.value.trim() : '';
            if (!customUrl || !customModel) {
              apiKeyStatus.textContent = t('apiKey.errCustom');
              apiKeyStatus.className = 'api-key-status show error';
              return;
            }
            try {
              const normalizedConfig = normalizeAiProviderConfig({
                url: customUrl,
                model: customModel,
                allowPrivateHttp: apiKeyPrivateHttpSwitch?.getAttribute('aria-checked') === 'true'
              });
              customUrl = normalizedConfig.url;
              customModel = normalizedConfig.model;
            } catch (error) {
              const errorKey = error instanceof AiProviderError && error.code === 'private_http_requires_opt_in'
                ? 'apiKey.errPrivateHttp'
                : error instanceof AiProviderError && error.code === 'insecure_http_not_allowed'
                  ? 'apiKey.errInsecureHttp'
                  : 'apiKey.errInvalidUrl';
              apiKeyStatus.textContent = t(errorKey);
              apiKeyStatus.className = 'api-key-status show error';
              return;
            }
          }
          apiKeySave.disabled = true;
          try {
            await persistAiApiKey(key);
            localStorage.setItem('ai_platform', platform);
            if (platform === 'custom') {
              localStorage.setItem('ai_custom_url', customUrl);
              localStorage.setItem('ai_custom_model', customModel);
              localStorage.setItem('ai_custom_allow_private_http', apiKeyPrivateHttpSwitch?.getAttribute('aria-checked') === 'true' ? 'true' : 'false');
            }
            apiKeyStatus.textContent = t('apiKey.saved');
            apiKeyStatus.className = 'api-key-status show success';
            largeFileCleanupRenderAiCard();
            setTimeout(() => apiKeyOverlay.classList.remove('visible'), 800);
          } catch {
            apiKeyStatus.textContent = t('apiKey.errStorage');
            apiKeyStatus.className = 'api-key-status show error';
          } finally {
            apiKeySave.disabled = false;
          }
        });
      }
      if (apiKeyClear) {
        apiKeyClear.addEventListener('click', async () => {
          apiKeyClear.disabled = true;
          try {
            await removeAiApiKey();
            apiKeyInput.value = '';
            localStorage.removeItem('ai_platform');
            localStorage.removeItem('ai_custom_url');
            localStorage.removeItem('ai_custom_model');
            localStorage.removeItem('ai_custom_allow_private_http');
            setPrivateHttpPermission(false);
            apiKeyStatus.textContent = t('apiKey.cleared');
            apiKeyStatus.className = 'api-key-status show success';
            largeFileCleanupRenderAiCard();
            setTimeout(() => apiKeyOverlay.classList.remove('visible'), 800);
          } catch {
            apiKeyStatus.textContent = t('apiKey.errStorage');
            apiKeyStatus.className = 'api-key-status show error';
          } finally {
            apiKeyClear.disabled = false;
          }
        });
      }

      // AI key required overlay
      const aiKeyRequiredOverlay = document.getElementById('aiKeyRequiredOverlay');
      const aiKeyRequiredCancel = document.getElementById('aiKeyRequiredCancel');
      const aiKeyRequiredGoSettings = document.getElementById('aiKeyRequiredGoSettings');

      function showAiKeyRequiredOverlay() {
        if (aiKeyRequiredOverlay) {
          aiKeyRequiredOverlay.classList.add('visible');
          aiKeyRequiredOverlay.setAttribute('aria-hidden', 'false');
          return;
        }
        window.showToast?.(t('home.aiKeyRequired.desc'));
      }

      function hideAiKeyRequiredOverlay() {
        if (aiKeyRequiredOverlay) {
          aiKeyRequiredOverlay.classList.remove('visible');
          aiKeyRequiredOverlay.setAttribute('aria-hidden', 'true');
        }
      }
      if (aiKeyRequiredCancel) {
        aiKeyRequiredCancel.addEventListener('click', hideAiKeyRequiredOverlay);
      }
      if (aiKeyRequiredGoSettings) {
        aiKeyRequiredGoSettings.addEventListener('click', () => {
          hideAiKeyRequiredOverlay();
          if (btnApiKey) btnApiKey.click();
        });
      }

      // Check AI API key before opening AI tool overlay
      async function openToolWithAiCheck(openFn) {
        await aiApiKeyReady;
        if (!hasAiApiKey()) {
          showAiKeyRequiredOverlay();
          return;
        }
        openFn();
      }

      const APP_TOAST_MIN_DURATION = 5200;
      const APP_TOAST_LONG_DURATION = 7200;
      const APP_TOAST_MAX_VISIBLE = 3;
      const activeAppToasts = [];

      function appToastDurationFor(message, requestedDuration) {
        const numericDuration = Number(requestedDuration);
        const text = String(message || '');
        const looksImportant = /(失败|错误|无法|不支持|需要|请|未|阻止|警告|failed|error|cannot|unable|blocked|warning|required|please)/i.test(text);
        const lengthBonus = Math.min(2600, Math.max(0, text.length - 28) * 45);
        const base = looksImportant ? APP_TOAST_LONG_DURATION : APP_TOAST_MIN_DURATION;
        if (Number.isFinite(numericDuration) && numericDuration > 0) {
          return Math.max(base, numericDuration, APP_TOAST_MIN_DURATION) + lengthBonus;
        }
        return base + lengthBonus;
      }

      function removeAppToast(record, immediate = false) {
        if (!record || record.removed) return;
        record.removed = true;
        if (record.timer) clearTimeout(record.timer);
        const index = activeAppToasts.indexOf(record);
        if (index >= 0) activeAppToasts.splice(index, 1);
        if (immediate) {
          record.el.remove();
          return;
        }
        record.el.classList.add('hiding');
        record.el.addEventListener('animationend', () => record.el.remove(), { once: true });
      }

      function scheduleAppToastRemoval(record, duration) {
        if (!record || record.removed) return;
        if (record.timer) clearTimeout(record.timer);
        record.startedAt = Date.now();
        record.remaining = Math.max(800, duration);
        record.timer = setTimeout(() => removeAppToast(record), record.remaining);
      }

      function showToast(message, optionsOrDuration = {}) {
        const container = document.getElementById('toastContainer');
        if (!container) return;
        const text = String(message ?? '').trim();
        if (!text) return;

        const options = typeof optionsOrDuration === 'number'
          ? { duration: optionsOrDuration }
          : (optionsOrDuration && typeof optionsOrDuration === 'object' ? optionsOrDuration : {});

        const duplicate = activeAppToasts.find(record => record.message === text && !record.removed);
        if (duplicate) {
          duplicate.messageEl.textContent = text;
          scheduleAppToastRemoval(duplicate, appToastDurationFor(text, options.duration));
          return {
            el: duplicate.el,
            close: () => removeAppToast(duplicate),
            update: nextMessage => {
              const nextText = String(nextMessage ?? '').trim();
              if (nextText) duplicate.messageEl.textContent = nextText;
            }
          };
        }

        while (activeAppToasts.length >= APP_TOAST_MAX_VISIBLE) {
          removeAppToast(activeAppToasts[0], true);
        }

        const toast = document.createElement('div');
        toast.className = 'app-toast';
        if (options.className) toast.classList.add(...String(options.className).split(/\s+/).filter(Boolean));
        toast.setAttribute('role', 'status');
        toast.setAttribute('aria-live', 'polite');

        const messageEl = document.createElement('div');
        messageEl.className = 'app-toast-message';
        messageEl.textContent = text;

        const closeBtn = document.createElement('button');
        closeBtn.className = 'app-toast-close';
        closeBtn.type = 'button';
        closeBtn.setAttribute('aria-label', getLang() === 'zh' ? '关闭提示' : 'Dismiss notification');
        closeBtn.textContent = '×';
        if (options.dismissible === false) closeBtn.style.display = 'none';

        toast.appendChild(messageEl);
        toast.appendChild(closeBtn);
        container.appendChild(toast);

        const record = {
          el: toast,
          messageEl,
          message: text,
          timer: null,
          startedAt: Date.now(),
          remaining: appToastDurationFor(text, options.duration),
          removed: false
        };
        activeAppToasts.push(record);

        closeBtn.addEventListener('click', () => removeAppToast(record));
        toast.addEventListener('mouseenter', () => {
          if (record.timer) clearTimeout(record.timer);
          record.timer = null;
          const elapsed = Date.now() - record.startedAt;
          record.remaining = Math.max(1600, record.remaining - elapsed);
        });
        toast.addEventListener('mouseleave', () => {
          scheduleAppToastRemoval(record, record.remaining);
        });
        scheduleAppToastRemoval(record, record.remaining);
        return {
          el: toast,
          close: () => removeAppToast(record),
          update: nextMessage => {
            const nextText = String(nextMessage ?? '').trim();
            if (nextText) messageEl.textContent = nextText;
          }
        };
      }
      window.showToast = showToast;
      window.alert = message => {
        try {
          showToast(message);
        } catch (error) {
          console.error('Toast fallback failed:', error);
        }
      };

      const HOME_LINKS = {
        website: 'https://toolknit.com',
        github: 'https://github.com/ZihangDong/toolknit-desktop',
        feedback: 'https://github.com/ZihangDong/toolknit-desktop/issues'
      };

      async function openExternalUrl(url) {
        let parsedUrl;
        try {
          if (typeof url !== 'string' || url.length > 2048 || /[\u0000-\u001f\u007f]/.test(url)) throw new Error('invalid');
          parsedUrl = new URL(url);
          if (!['http:', 'https:'].includes(parsedUrl.protocol) || !parsedUrl.hostname || parsedUrl.username || parsedUrl.password) throw new Error('unsupported');
        } catch {
          console.warn('Blocked an invalid external URL.');
          return;
        }
        if (isTauri) {
          try {
            const { invoke } = await tauriCorePromise;
            await invoke('open_url', { url: parsedUrl.href });
          } catch (err) {
            console.error('Failed to open URL:', err);
            window.showToast?.(t('common.openLinkFailed'));
          }
        } else {
          window.open(parsedUrl.href, '_blank', 'noopener,noreferrer');
        }
      }

      document.querySelectorAll('[data-home-link]').forEach(link => {
        link.addEventListener('click', event => {
          const url = HOME_LINKS[link.dataset.homeLink];
          if (url) {
            event.preventDefault();
            void openExternalUrl(url);
          }
        });
      });

      document.getElementById('homeLatestUpdates')?.addEventListener('click', () => openHelpOverlay('update'));
      document.getElementById('homeAboutAuthor')?.addEventListener('click', () => openExternalUrl('https://github.com/ZihangDong'));

      const donationOverlay = document.getElementById('donationOverlay');
      const donationDialog = donationOverlay?.querySelector('.donation-dialog');
      const donationScroll = donationOverlay?.querySelector('.donation-scroll');
      const donationJournalReader = document.getElementById('donationJournalReader');
      const donationJournalDate = document.getElementById('donationJournalDate');
      const donationJournalReaderCount = document.getElementById('donationJournalReaderCount');
      const donationJournalReaderTitle = document.getElementById('donationJournalReaderTitle');
      const donationJournalReaderBody = document.getElementById('donationJournalReaderBody');
      const donationJournalReaderHint = document.getElementById('donationJournalReaderHint');
      const donationJournalProgressBar = document.getElementById('donationJournalProgressBar');
      const donationJournalStatus = document.getElementById('donationJournalStatus');
      let donationReturnFocus = null;

      /* Legacy remote/list renderer retained in source history; the local
         translated reader below is the only active journal implementation.
      const DONATION_JOURNAL_FALLBACK = [
        ['Aug 5, 2026', 'Background Remover: Safer Local AI, Better Editing & Flexible Export', 'A safer local-AI workflow with explicit model downloads, mask refinement, transparent previews and full-resolution export.', true],
        ['Aug 1, 2026', 'Whiteboard V3, Desktop Momentum & a Huge Milestone', 'Whiteboard V3 rebuilt the drawing workspace around dependable selection, recovery, layering and responsive tools.', true],
        ['Jul 30, 2026', 'Image Stitcher Release & Tool Directory Baseline', 'A new local image stitcher and a careful release checklist made the public directory easier to trust.', true],
        ['Jul 26, 2026', 'Every Tool Page Now Runs on ToolKnit’s New Architecture', 'After six weeks of page-by-page work, the tool collection moved to one shared bilingual architecture.', true],
        ['Jul 2, 2026', 'ToolKnit Desktop v1.0', 'The first native Windows client arrived with Rust, Tauri and an offline-first local workflow.', true],
        ['Jun 26, 2026', '100 Days of ToolKnit', 'A small homepage celebration for the first one hundred days of building the project in public.', true],
        ['Jun 20, 2026', 'Desktop EXE Client Announced', 'The desktop client moved from an idea to a working PDF suite demo and a concrete release plan.', true],
        ['Jun 11, 2026', 'Developer’s Journal', 'A quiet note from the middle of the migration: progress was measured in small fixes that made the next page easier.', true],
        ['Jun 6, 2026', 'Developer’s Journal - Cyber Reunion', 'A personal pause between releases, and a reminder that software is also made of memories and people.', true],
        ['Jun 4, 2026 · 18:40', 'Developer’s Journal', 'An evening entry about the decisions behind the architecture and the cost of keeping every tool private.', true],
        ['Jun 4, 2026 · 08:30', 'A Personal Note', 'A short morning note from the developer before another day of shipping small, useful tools.', true],
        ['May 13, 2026', 'The Botanical Garden Edition', 'A slower release day, with documentation, consistency checks and a note from the developer.', true]
      ];

      // Keep the complete public timeline available when the web changelog is
      // unavailable to the desktop webview (the site intentionally has no CORS
      // header). Online responses replace these concise local summaries.
      const DONATION_JOURNAL_INDEX = `
Aug 18, 2026|Analytics Counters: Safer Concurrent Updates
Aug 17, 2026|Search Quality: Clearer Promises, More Useful Pages
Aug 17, 2026|ToolKnit Desktop v2.0: 49 Local Tools, Nearing 500 Stars
Aug 14, 2026|Homepage Navigation: A Stable, Shake-Free Sticky Filter Rail
Aug 10, 2026|Sitewide SEO Reliability Audit
Aug 9, 2026|Homepage Catalog: Faster Browsing for Large Tool Libraries
Aug 6, 2026|Performance Pass: Smoother Local Processing Across Four Tools
Aug 5, 2026|Background Remover: Safer Local AI, Better Editing & Flexible Export|note
Aug 4, 2026|ToolKnit Desktop v1.2 Page Refresh
Aug 2, 2026|Daily Planner Polish & Strict Image and PDF Target Sizes|note
Aug 1, 2026|Whiteboard V3, Desktop Momentum & a Huge Milestone|note
Jul 31, 2026|Homepage Translation Cache Fix
Jul 30, 2026|Image Stitcher Release & Tool Directory Baseline|note
Jul 27, 2026|PDF & Image Workflow Security, Search Cleanup & Production Fixes|note
Jul 26, 2026|Every Tool Page Now Runs on ToolKnit's New Architecture|note
Jul 25, 2026|FMHY Recognition & Bilingual Migration Progress|note
Jul 23, 2026|New Architecture Consistency, FAQ Coverage & Cache Cleanup|note
Jul 21, 2026|New Tool: Text to Speech - 69 AI Neural Voices, Server-Side Architecture
Jul 19, 2026|iOS Safari Download Fix, Newline Character Bug Fix & Chinese Search Support|note
Jul 14, 2026|Merge PDF Major Upgrade - Page Selector, Custom Filename, Homepage Light Mode Fixes & New Blog|note
Jul 13, 2026|Ask Fate Full Overhaul & Whiteboard Enhancement - Multi-Mode Oracle, Shape Fill, Layer Manager & Dark Canvas|note
Jul 8, 2026|Dice Roller Major Upgrade - Batch Auto-Roll, Game Presets, CSV Export & Full-Site SEO Data Refresh|note
Jul 6, 2026|Breathing Relaxation + Sitemap Overhaul + Full-Site Encoding & SEO Repair - 90 Tools, Best SEO Yet|note
Jul 5, 2026|Quit Smoking Tracker & Bilingual Migration Milestone - 55 Tools Now EN + Chinese|note
Jul 3, 2026|New Tool: Emoji Finder - Search & Copy 560+ Emojis|note
Jul 2, 2026|ToolKnit Desktop v1.0 - A Native Windows Client Built with Rust & Tauri|note
Jun 28, 2026|Bilingual Migration Halfway Done - PDF, Image, Video, Audio & Text Suites Complete|note
Jun 26, 2026|100 Days of ToolKnit - Fireworks on the Homepage|note
Jun 23, 2026|Text Animation Maker, True MP4 Export & Drawer Refinement
Jun 20, 2026|Desktop EXE Client Announced - PDF Suite Demo 0.1 & Web Migration Milestone|note
Jun 17, 2026|Silk Screen, Image Tools & Audio Tools Migration - Metronome + WAV to MP3 Bilingual
Jun 16, 2026|All 4 AI Tools Fully Migrated - Image Tools Next & Developer's Journal|note
Jun 15, 2026|AI Ex-Partner Chat & Background Remover Bilingual Migration, Library Manager Launch
Jun 13, 2026|Image Tools Bilingual Migration & Mic/Camera Permissions Fix
Jun 12, 2026|New Architecture, Two New Tools & PDF Suite Rebuilt
Jun 11, 2026|Developer's Journal|note
Jun 11, 2026|Lyric Visualizer, Live Photo Frame Removed & Bilingual i18n
Jun 10, 2026|Spin the Dare, Live Photo Frame (Beta), Bilingual UI & AI Pixel Art GIF Reverted
Jun 9, 2026|AI Life Trajectory Predictor, Silk Screen Filter, AI Pixel Art GIF Removed & MIDI Sustain Fix
Jun 8, 2026|AI Text Adventure RPG Systems, Architecture Overhaul & AI Tools Category
Jun 7, 2026|Meeting Cost Calculator, MIDI Keyboard & Dev Fixes
Jun 6, 2026|Developer's Journal - Cyber Reunion|note
Jun 6, 2026|AI Ex-Partner Chat, Screenshot OCR Overhaul & Tool Count -> 76
Jun 4, 2026|Emotional Neglect Test & Tool Count -> 75 & New Category: Self-Test
Jun 4, 2026|The Great Tool Audit - 25 Tools Inspected, Major Speed Upgrades
Jun 4, 2026 - 18:40|Developer's Journal|note
Jun 4, 2026 - 08:30|A Personal Note|note
Jun 3, 2026|Noise Generator, Hash Generator & Tool Count -> 74
Jun 2, 2026|Item Locator, ASCII Art, ASCII Banner & Tool Count -> 72
Jun 1, 2026|BPM Detector, Circle Crop, Video Screenshot & Architecture Overhaul
May 28, 2026|CSV Chart Maker Launch, Pixel Art Presets & Export Polish
May 26, 2026|Tool Page Cleanup, Status Analytics Fixes & Privacy Hardening
May 25, 2026|Long-Tail Blog Expansion, Schema Cleanup & Homepage Footer Fixes
May 24, 2026|Flashcard Maker Launch & Signature Maker Preview Fix
May 23, 2026|Signature Maker, Metronome, Homepage Polish & SEO Sweep
May 19, 2026|The AI to PNG & Second Milestone Edition
May 19, 2026|The Homepage Simplification
May 17, 2026|The Haircut & Housekeeping Edition
May 15, 2026|The World Holidays Edition
May 13, 2026|The Botanical Garden Edition|note
May 12, 2026|The Rest Day Edition
May 10 - 11, 2026|The Overtime & Power Outage Edition
May 9, 2026|50+ Tools - A Midnight Milestone
May 8, 2026|7 New Tools - Biggest Single-Day Drop Yet
May 7, 2026|Background Remover - AI-Powered Image Background Removal
May 3 - 6, 2026|The Black & White Reset - A Full-Site Visual & Architectural Overhaul
April 30, 2026|Coin Flip, Dice Roller & Legal Pages Refresh
April 28, 2026|CPS Test & SEO Refresh
April 21, 2026|Aim Trainer & Login System Removal
April 14, 2026|Image Resizer & Lorem Ipsum Generator
April 12, 2026|Pixel Art Converter & Video to Audio
April 11, 2026|Keystroke Counter & Changelog Page
April 9, 2026|QR Code Generator & SEO Improvements
April 7, 2026|Reaction Time Test
April 4, 2026|Keyboard Tester & Random Spinner
April 1, 2026|Creative Tools: Drawing Board, What to Eat & Ask Fate
March 29, 2026|Image Crop & Grid Splitter
March 26, 2026|Time Tools: Stopwatch, Timer & World Clock
March 23, 2026|Text Tools & Audio Converters
March 20, 2026|Video Tools & Image Format Converters
March 18, 2026|Launch Day
      `.trim().split('\n').map((line, index) => {
        const [date, title, marker] = line.split('|');
        return {
          date,
          title,
          summary: marker === 'note' ? 'Developer journal entry - a personal note from the work behind ToolKnit.' : 'Public release note from the ToolKnit development timeline.',
          isNote: marker === 'note',
          number: index + 1
        };
      });

      function donationJournalText(value) {
        return String(value || '').replace(/\s+/g, ' ').trim();
      }

      function normalizeDonationJournalEntries(html) {
        const parser = new DOMParser();
        const doc = parser.parseFromString(html, 'text/html');
        return Array.from(doc.querySelectorAll('.changelog-entry')).map((entry, index) => {
          const date = donationJournalText(entry.querySelector('.entry-date')?.textContent);
          const title = donationJournalText(entry.querySelector('.entry-title')?.textContent) || 'ToolKnit update';
          const body = entry.querySelector('.entry-body');
          const bodyText = donationJournalText(body?.textContent);
          const paragraph = donationJournalText(body?.querySelector('p')?.textContent) || bodyText;
          const isNote = /developer.{0,4}(note|journal)|a note from the developer/i.test(bodyText);
          return {
            date,
            title,
            summary: paragraph.length > 260 ? `${paragraph.slice(0, 257)}...` : paragraph,
            isNote,
            number: index + 1
          };
        }).filter(entry => entry.title && entry.date);
      }

      function renderDonationJournal(entries, source = 'offline') {
        if (!donationJournalList) return;
        donationJournalList.replaceChildren();
        entries.forEach((entry, index) => {
          const article = document.createElement('article');
          article.className = `donation-journal-entry${entry.isNote ? ' is-note' : ''}`;
          const meta = document.createElement('div');
          meta.className = 'donation-journal-meta';
          const number = document.createElement('span');
          number.className = 'donation-journal-number';
          number.textContent = String(entry.number || index + 1).padStart(2, '0');
          const date = document.createElement('time');
          date.textContent = entry.date;
          meta.append(number, date);
          const title = document.createElement('h4');
          title.textContent = entry.title;
          const summary = document.createElement('p');
          summary.textContent = entry.summary;
          article.append(meta, title, summary);
          donationJournalList.append(article);
        });
        if (donationJournalCount) donationJournalCount.textContent = source === 'remote' ? String(entries.length) : '81';
        if (donationJournalStatus) {
          donationJournalStatus.textContent = source === 'remote'
            ? `${entries.length} ${getLang() === 'zh' ? '条记录，按时间倒序排列' : 'entries, newest first'}`
            : 'Offline: showing selected journal notes / 81';
        }
        if (typeof createIcons === 'function') createIcons({ icons });
      }

      function loadDonationJournal() {
        if (donationJournalPromise) return donationJournalPromise;
        donationJournalPromise = fetch('https://toolknit.com/changelog.html', { mode: 'cors' })
          .then(response => {
            if (!response.ok) throw new Error(`Changelog request failed: ${response.status}`);
            return response.text();
          })
          .then(html => {
            const entries = normalizeDonationJournalEntries(html);
            if (entries.length < 20) throw new Error('Incomplete changelog response');
            renderDonationJournal(entries, 'remote');
          })
          .catch(() => {
            renderDonationJournal(DONATION_JOURNAL_INDEX);
          });
        return donationJournalPromise;
      }

      */

      // The support page uses a shuffle bag so every translated developer note
      // appears once before the sequence is reshuffled. RAF keeps the progress
      // indicator accurate when the reader is paused or the window is hidden.
      let donationJournalOrder = [];
      let donationJournalIndex = -1;
      let donationJournalTimer = null;
      let donationJournalRaf = null;
      let donationJournalTransitionTimer = null;
      let donationJournalPaused = false;
      let donationJournalStartedAt = 0;
      let donationJournalElapsed = 0;
      let donationJournalWasPlayingBeforeHidden = false;
      const DONATION_JOURNAL_DURATION_MS = 15_000;

      function shuffleDonationJournalOrder() {
        const previousIndex = donationJournalIndex >= 0 ? donationJournalOrder[donationJournalIndex] : -1;
        donationJournalOrder = Array.from({ length: SUPPORT_JOURNAL_ENTRIES.length }, (_, index) => index);
        for (let index = donationJournalOrder.length - 1; index > 0; index -= 1) {
          const swapIndex = Math.floor(Math.random() * (index + 1));
          [donationJournalOrder[index], donationJournalOrder[swapIndex]] = [donationJournalOrder[swapIndex], donationJournalOrder[index]];
        }
        if (donationJournalOrder.length > 1 && donationJournalOrder[0] === previousIndex) {
          [donationJournalOrder[0], donationJournalOrder[1]] = [donationJournalOrder[1], donationJournalOrder[0]];
        }
        donationJournalIndex = -1;
      }

      function stopDonationJournalPlayback() {
        if (donationJournalTimer !== null) window.clearTimeout(donationJournalTimer);
        if (donationJournalTransitionTimer !== null) window.clearTimeout(donationJournalTransitionTimer);
        if (donationJournalRaf !== null) window.cancelAnimationFrame(donationJournalRaf);
        donationJournalTimer = null;
        donationJournalTransitionTimer = null;
        donationJournalRaf = null;
        donationJournalStartedAt = 0;
        donationJournalElapsed = 0;
        donationJournalPaused = false;
        donationJournalWasPlayingBeforeHidden = false;
        donationJournalProgressBar?.style.setProperty('width', '0%');
        donationJournalReader?.classList.remove('is-paused', 'is-entering', 'is-leaving');
        donationJournalReader?.setAttribute('aria-pressed', 'false');
        if (donationJournalReaderHint) donationJournalReaderHint.textContent = '点击文字暂停 · 再次点击继续播放';
      }

      function renderDonationJournalEntry(entry, orderPosition) {
        if (!entry || !donationJournalReader) return;
        donationJournalReader.classList.remove('is-entering');
        donationJournalReader.classList.add('is-leaving');
        if (donationJournalTransitionTimer !== null) window.clearTimeout(donationJournalTransitionTimer);
        donationJournalTransitionTimer = window.setTimeout(() => {
          donationJournalTransitionTimer = null;
          donationJournalDate.textContent = entry.date || '';
          donationJournalReaderCount.textContent = `${String(orderPosition + 1).padStart(2, '0')} / ${SUPPORT_JOURNAL_ENTRIES.length}`;
          donationJournalReaderTitle.textContent = entry.title || '';
          donationJournalReaderBody.replaceChildren();
          (Array.isArray(entry.paragraphs) ? entry.paragraphs : []).forEach(paragraphText => {
            const paragraph = document.createElement('p');
            paragraph.textContent = paragraphText;
            donationJournalReaderBody.append(paragraph);
          });
          donationJournalReader.classList.remove('is-leaving');
          donationJournalReader.classList.add('is-entering');
          window.requestAnimationFrame(() => donationJournalReader.classList.remove('is-entering'));
        }, 180);
      }

      function scheduleNextDonationJournalEntry() {
        if (!donationOverlay?.classList.contains('visible') || donationJournalPaused) return;
        if (!donationJournalOrder.length || donationJournalIndex >= donationJournalOrder.length - 1) shuffleDonationJournalOrder();
        donationJournalIndex += 1;
        const entry = SUPPORT_JOURNAL_ENTRIES[donationJournalOrder[donationJournalIndex]];
        renderDonationJournalEntry(entry, donationJournalIndex);
        donationJournalElapsed = 0;
        donationJournalStartedAt = performance.now();
        donationJournalProgressBar?.style.setProperty('width', '0%');
        if (donationJournalTimer !== null) window.clearTimeout(donationJournalTimer);
        donationJournalTimer = window.setTimeout(() => {
          donationJournalTimer = null;
          scheduleNextDonationJournalEntry();
        }, DONATION_JOURNAL_DURATION_MS);
      }

      function donationJournalProgressTick(now) {
        if (!donationJournalStartedAt || donationJournalPaused || !donationOverlay?.classList.contains('visible')) return;
        donationJournalElapsed = Math.min(DONATION_JOURNAL_DURATION_MS, now - donationJournalStartedAt);
        donationJournalProgressBar?.style.setProperty('width', `${(donationJournalElapsed / DONATION_JOURNAL_DURATION_MS) * 100}%`);
        donationJournalRaf = window.requestAnimationFrame(donationJournalProgressTick);
      }

      function pauseDonationJournalPlayback() {
        if (donationJournalPaused) return;
        donationJournalElapsed = donationJournalStartedAt ? Math.min(DONATION_JOURNAL_DURATION_MS, performance.now() - donationJournalStartedAt) : 0;
        donationJournalPaused = true;
        donationJournalReader?.classList.add('is-paused');
        donationJournalReader?.setAttribute('aria-pressed', 'true');
        if (donationJournalTimer !== null) window.clearTimeout(donationJournalTimer);
        if (donationJournalRaf !== null) window.cancelAnimationFrame(donationJournalRaf);
        donationJournalTimer = null;
        donationJournalRaf = null;
        if (donationJournalReaderHint) donationJournalReaderHint.textContent = '已暂停 · 再次点击继续播放';
      }

      function resumeDonationJournalPlayback() {
        if (!donationJournalPaused) return;
        donationJournalPaused = false;
        donationJournalStartedAt = performance.now() - donationJournalElapsed;
        donationJournalReader?.classList.remove('is-paused');
        donationJournalReader?.setAttribute('aria-pressed', 'false');
        if (donationJournalReaderHint) donationJournalReaderHint.textContent = '点击文字暂停 · 再次点击继续播放';
        donationJournalTimer = window.setTimeout(() => {
          donationJournalTimer = null;
          scheduleNextDonationJournalEntry();
        }, Math.max(0, DONATION_JOURNAL_DURATION_MS - donationJournalElapsed));
        donationJournalRaf = window.requestAnimationFrame(donationJournalProgressTick);
      }

      function toggleDonationJournalPlayback() {
        if (donationJournalPaused) resumeDonationJournalPlayback();
        else pauseDonationJournalPlayback();
      }

      function startDonationJournalPlayback() {
        if (!donationJournalReader || !SUPPORT_JOURNAL_ENTRIES.length) return;
        stopDonationJournalPlayback();
        shuffleDonationJournalOrder();
        if (donationJournalStatus) donationJournalStatus.textContent = `${SUPPORT_JOURNAL_ENTRIES.length} 篇开发者手记 · 随机循环播放`;
        scheduleNextDonationJournalEntry();
        donationJournalRaf = window.requestAnimationFrame(donationJournalProgressTick);
      }

      donationJournalReader?.addEventListener('click', toggleDonationJournalPlayback);
      donationJournalReader?.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          toggleDonationJournalPlayback();
        }
      });

      document.addEventListener('visibilitychange', () => {
        if (!donationOverlay?.classList.contains('visible')) return;
        if (document.hidden) {
          donationJournalWasPlayingBeforeHidden = !donationJournalPaused;
          if (donationJournalWasPlayingBeforeHidden) pauseDonationJournalPlayback();
        } else if (donationJournalWasPlayingBeforeHidden) {
          donationJournalWasPlayingBeforeHidden = false;
          resumeDonationJournalPlayback();
        }
      });

      function openDonationOverlay() {
        if (!donationOverlay) return;
        if (donationOverlay.classList.contains('visible')) return;
        donationReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        donationOverlay.classList.add('visible');
        donationOverlay.setAttribute('aria-hidden', 'false');
        document.body.classList.add('donation-open');
        startDonationJournalPlayback();
        window.requestAnimationFrame(() => {
          if (donationScroll) donationScroll.scrollTop = 0;
          donationDialog?.focus({ preventScroll: true });
        });
      }

      function closeDonationOverlay() {
        if (!donationOverlay) return;
        donationOverlay.classList.remove('visible');
        donationOverlay.setAttribute('aria-hidden', 'true');
        document.body.classList.remove('donation-open');
        stopDonationJournalPlayback();
        if (donationReturnFocus?.isConnected) donationReturnFocus.focus({ preventScroll: true });
        donationReturnFocus = null;
      }

      donationOverlay?.querySelectorAll('[data-donation-close]').forEach(button => {
        button.addEventListener('click', closeDonationOverlay);
      });
      donationOverlay?.querySelectorAll('[data-donation-link]').forEach(button => {
        button.addEventListener('click', () => {
          const links = {
            changelog: 'https://toolknit.com/changelog.html',
            github: 'https://github.com/ZihangDong/toolknit-desktop'
          };
          const url = links[button.dataset.donationLink];
          if (url) void openExternalUrl(url);
        });
      });
      donationOverlay?.querySelector('[data-donation-top]')?.addEventListener('click', () => {
        donationScroll?.scrollTo({
          top: 0,
          behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth'
        });
      });
      document.addEventListener('keydown', event => {
        if (event.key === 'Escape' && donationOverlay?.classList.contains('visible')) {
          closeDonationOverlay();
        }
      });

      const GITHUB_REPOSITORY = 'ZihangDong/toolknit-desktop';
      const GITHUB_STATS_CACHE_KEY = 'toolknit_github_home_stats';
      const GITHUB_CONTRIBUTORS_URL = `https://raw.githubusercontent.com/${GITHUB_REPOSITORY}/main/toolknit-desktop/public/contributors.json`;
      const GITHUB_LOCAL_CONTRIBUTORS_URL = new URL('contributors.json', document.baseURI).href;
      const GITHUB_FIXED_ACTIVITY_POINTS = '0,62 248,62 280,8';
      // A shipped snapshot prevents a blank metric on first launch without a network connection.
      const DEFAULT_GITHUB_STAR_COUNT = 435;
      const DEFAULT_DONATION_TOTAL = 83.88;
      const GITHUB_REQUEST_TIMEOUT_MS = 8_000;
      const GITHUB_RESPONSE_MAX_BYTES = 512 * 1024;

      async function fetchGithubJson(url, options = {}) {
        const controller = new AbortController();
        const timeoutId = window.setTimeout(() => controller.abort(), GITHUB_REQUEST_TIMEOUT_MS);
        try {
          const response = await fetch(url, { ...options, signal: controller.signal });
          if (!response.ok) throw new Error(`GitHub request failed: ${response.status}`);
          return JSON.parse(await readResponseTextLimited(response, GITHUB_RESPONSE_MAX_BYTES));
        } finally {
          window.clearTimeout(timeoutId);
        }
      }

      function normalizeGithubStarCount(value) {
        const count = Number(value);
        return Number.isFinite(count) && count >= 0 ? Math.floor(count) : null;
      }

      function normalizeDonationTotal(data) {
        const contributors = Array.isArray(data?.contributors) ? data.contributors : [];
        const total = contributors.reduce((sum, contributor) => {
          const amount = Number(contributor?.amount_cny);
          return Number.isFinite(amount) && amount >= 0 && amount <= 100_000_000 ? sum + amount : sum;
        }, 0);
        return Math.round(total * 100) / 100;
      }

      function formatDonationTotal(value) {
        const total = Number.isFinite(value) && value >= 0 ? value : DEFAULT_DONATION_TOTAL;
        return total.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      }

      function getCachedGithubStats() {
        try {
          const cached = JSON.parse(localStorage.getItem(GITHUB_STATS_CACHE_KEY) || 'null');
          if (!cached || typeof cached !== 'object' || !cached.data) return null;
          return {
            stars: normalizeGithubStarCount(cached.data.stars) ?? DEFAULT_GITHUB_STAR_COUNT,
            donationTotal: Number.isFinite(Number(cached.data.donationTotal))
              ? Math.max(0, Number(cached.data.donationTotal))
              : DEFAULT_DONATION_TOTAL
          };
        } catch {
          return null;
        }
      }

      function saveGithubStats(data) {
        try {
          localStorage.setItem(GITHUB_STATS_CACHE_KEY, JSON.stringify({ timestamp: Date.now(), data }));
        } catch {
          // Homepage metrics remain functional when browser storage is unavailable.
        }
      }

      function renderGithubActivity(data, { repoSynced = false, donationsSynced = false } = {}) {
        const status = document.getElementById('githubActivityStatus');
        const starCount = document.getElementById('githubStarCount');
        const stars = document.getElementById('githubStars');
        const donationGithubStars = document.getElementById('donationGithubStars');
        const starStat = document.getElementById('githubStars')?.closest('.github-stat');
        const donationTotal = document.getElementById('githubDonationTotal');
        const chartLine = document.getElementById('githubActivityLine');

        const starsValue = data?.stars === null || data?.stars === undefined ? '--' : String(data.stars);

        if (starCount) starCount.textContent = starsValue;
        if (stars) stars.textContent = starsValue;
        if (donationGithubStars) donationGithubStars.textContent = starsValue === '--' ? '400+' : `${starsValue}+`;
        starStat?.classList.toggle('is-synced', Boolean(repoSynced && Number.isFinite(Number(data?.stars))));
        if (donationTotal) donationTotal.textContent = formatDonationTotal(Number(data?.donationTotal));
        if (chartLine) chartLine.setAttribute('points', GITHUB_FIXED_ACTIVITY_POINTS);
        if (status) {
          status.textContent = repoSynced && donationsSynced
            ? 'Star 与贡献名单已同步'
            : repoSynced
              ? 'Star 已同步，贡献名单使用本地数据'
              : '离线显示最近可用数据';
        }
      }

      async function loadDonationTotal() {
        const sources = [
          { url: GITHUB_LOCAL_CONTRIBUTORS_URL, isLive: false },
          { url: GITHUB_CONTRIBUTORS_URL, isLive: true }
        ];
        let lastError = null;
        for (const source of sources) {
          try {
            const data = await fetchGithubJson(source.url, {
              cache: 'no-store',
              headers: { Accept: 'application/json' }
            });
            const total = normalizeDonationTotal(data);
            return { total, isLive: source.isLive };
          } catch (error) {
            lastError = error;
          }
        }
        throw lastError || new Error('Contributor list request failed');
      }

      async function loadGithubActivity() {
        const cached = getCachedGithubStats();
        renderGithubActivity(cached || {
          stars: DEFAULT_GITHUB_STAR_COUNT,
          donationTotal: DEFAULT_DONATION_TOTAL
        });

        const headers = { Accept: 'application/vnd.github+json' };
        const [repoResult, donationResult] = await Promise.allSettled([
          fetchGithubJson(`https://api.github.com/repos/${GITHUB_REPOSITORY}`, { headers }),
          loadDonationTotal()
        ]);
        const repoSynced = repoResult.status === 'fulfilled';
        const donationsAvailable = donationResult.status === 'fulfilled';
        const donationsSynced = donationsAvailable && donationResult.value.isLive;
        const data = {
          stars: repoSynced
            ? normalizeGithubStarCount(repoResult.value?.stargazers_count)
            : cached?.stars ?? DEFAULT_GITHUB_STAR_COUNT,
          donationTotal: donationsAvailable
            ? donationResult.value.total
            : cached?.donationTotal ?? DEFAULT_DONATION_TOTAL
        };
        if (!repoSynced) console.warn('Unable to load GitHub stars:', repoResult.reason);
        if (!donationsAvailable) console.warn('Unable to load contributor donations:', donationResult.reason);
        saveGithubStats(data);
        renderGithubActivity(data, { repoSynced, donationsSynced });
      }

      loadGithubActivity();

      const homeScrollContainer = document.querySelector('.main-content');
      const homeToolSearch = document.getElementById('homeToolSearch');
      const homeToolGrid = document.getElementById('homeToolGrid');
      const homeToolLoadMore = document.getElementById('homeToolLoadMore');
      const homeToolLoadMoreSummary = document.getElementById('homeToolLoadMoreSummary');
      const homeToolLoadMoreButton = document.getElementById('homeToolLoadMoreButton');
      const backToTop = document.getElementById('backToTop');
      const homeCategoryChips = Array.from(document.querySelectorAll('[data-home-category]'));
      const HOME_TOOL_PAGE_SIZE = 12;
      let activeHomeCategory = 'all';
      let homeVisibleToolCount = HOME_TOOL_PAGE_SIZE;
      let homeScrollUiRaf = 0;
      const homeWaterCardState = new WeakMap();

      function getHomeWaterCard(target) {
        const card = target?.closest?.('.tool-result-card, .favorite-item');
        return card?.closest?.('.app.is-v2-home') ? card : null;
      }

      function updateHomeWaterCard(card, event) {
        if (!card || (event.pointerType && event.pointerType !== 'mouse')) return;
        const rect = card.getBoundingClientRect();
        if (!rect.width || !rect.height) return;
        const state = homeWaterCardState.get(card) || { x: 50, y: 50, raf: 0 };
        const x = Math.max(0, Math.min(100, ((event.clientX - rect.left) / rect.width) * 100));
        const y = Math.max(0, Math.min(100, ((event.clientY - rect.top) / rect.height) * 100));
        const dx = x - state.x;
        const dy = y - state.y;
        const distance = Math.min(1, Math.hypot(dx, dy) / 18);
        if (Math.abs(dx) + Math.abs(dy) > 0.01) {
          state.angle = Math.atan2(dy, dx) * (180 / Math.PI) + 90;
        }
        state.x = x;
        state.y = y;
        state.speed = distance;
        homeWaterCardState.set(card, state);
        if (state.raf) return;
        state.raf = requestAnimationFrame(() => {
          card.style.setProperty('--water-x', `${state.x}%`);
          card.style.setProperty('--water-y', `${state.y}%`);
          card.style.setProperty('--water-angle', `${state.angle || 0}deg`);
          card.style.setProperty('--water-stretch', `${(1 + (state.speed || 0) * 0.28).toFixed(3)}`);
          state.raf = 0;
        });
      }

      if (homeScrollContainer) {
        homeScrollContainer.addEventListener('pointerover', event => {
          const card = getHomeWaterCard(event.target);
          if (!card || (event.pointerType && event.pointerType !== 'mouse')) return;
          if (event.relatedTarget && card.contains(event.relatedTarget)) return;
          card.dataset.waterActive = 'true';
          updateHomeWaterCard(card, event);
        });
        homeScrollContainer.addEventListener('pointermove', event => {
          const card = getHomeWaterCard(event.target);
          if (card) updateHomeWaterCard(card, event);
        }, { passive: true });
        homeScrollContainer.addEventListener('pointerout', event => {
          const card = getHomeWaterCard(event.target);
          if (!card || (event.relatedTarget && card.contains(event.relatedTarget))) return;
          card.dataset.waterActive = 'false';
        });
      }

      function getHomeCategoryGroup(sectionCategory) {
        switch (sectionCategory) {
          case 'audio':
          case 'video':
            return 'media';
          case 'calculator':
            return 'calc';
          case 'cleanup':
            return 'clean';
          default:
            return sectionCategory || '';
        }
      }

      function getHomeCategoryLabel(sectionCategory) {
        switch (sectionCategory) {
          case 'pdf': return 'PDF / LOCAL';
          case 'ppt': return 'PPT / STUDIO';
          case 'image': return 'IMAGE / LOCAL';
          case 'audio': return 'AUDIO / LOCAL';
          case 'video': return 'VIDEO / LOCAL';
          case 'text': return 'TEXT / UTILITY';
          case 'calculator': return 'CALC / UTILITY';
          case 'creative': return 'CREATIVE / UTILITY';
          case 'ai': return 'AI / FORGE';
          case 'hardware': return 'HARDWARE / READONLY';
          case 'developer': return 'DEVELOPER / LOCAL';
          case 'cleanup': return 'CLEAN / AI';
          default: return String(sectionCategory || '').toUpperCase();
        }
      }

      function getHomeCategoryTag(sectionCategory) {
        const tagKeys = {
          pdf: 'home.toolNames.pdfCategoryTag',
          ppt: 'home.toolNames.pptCategoryTag',
          image: 'home.toolNames.imageCategoryTag',
          audio: 'home.toolNames.audioCategoryTag',
          video: 'home.toolNames.videoCategoryTag',
          text: 'home.toolNames.textCategoryTag',
          calculator: 'home.toolNames.calcCategoryTag',
          creative: 'home.toolNames.creativeCategoryTag',
          ai: 'home.toolNames.aiCategoryTag',
          hardware: 'home.toolNames.hardwareCategoryTag',
          developer: 'home.toolNames.developerCategoryTag',
          cleanup: 'home.toolNames.cleanupCategoryTag'
        };
        const key = tagKeys[sectionCategory];
        return key ? t(key) : getHomeCategoryLabel(sectionCategory);
      }

      function collectHomeTools() {
        return Array.from(document.querySelectorAll('.content-section:not([data-category="home"]) .audio-list-item'))
          .filter(item => item.dataset.availability !== 'planned')
          .map(item => {
            const sectionCategory = item.closest('.content-section')?.dataset.category || '';
            const title = item.querySelector('.audio-list-title')?.textContent?.trim() || item.dataset.tool || '';
            const desc = item.querySelector('.audio-list-desc')?.textContent?.trim()
              || item.querySelector('.audio-list-meta')?.textContent?.trim()
              || '';
            const tag = item.querySelector('.audio-tag')?.textContent?.trim() || getHomeCategoryLabel(sectionCategory);
            const iconHtml = item.querySelector('.audio-list-icon')?.innerHTML || '';
            return {
              toolId: item.dataset.tool || '',
              name: title,
              desc,
              tag,
              iconHtml,
              category: sectionCategory,
              homeCategory: getHomeCategoryGroup(sectionCategory),
              searchable: `${title} ${desc} ${tag} ${sectionCategory}`.toLowerCase()
            };
          });
      }

      function syncHomeBackToTop() {
        if (!backToTop || !homeScrollContainer) return;
        backToTop.classList.toggle('is-visible', homeScrollContainer.scrollTop > 320);
      }

      function scrollHomeToExplorer() {
        const toolExplorer = document.querySelector('.tool-explorer');
        if (!homeScrollContainer || !toolExplorer) return;
        homeScrollContainer.scrollTo({
          top: Math.max(0, toolExplorer.offsetTop - 44),
          behavior: 'smooth'
        });
      }

      function renderHomeTools({ resetPagination = false } = {}) {
        if (!homeToolSearch || !homeToolGrid) return;
        if (resetPagination) homeVisibleToolCount = HOME_TOOL_PAGE_SIZE;
        const query = homeToolSearch.value.trim().toLowerCase();
        const visibleTools = collectHomeTools().filter(tool => {
          const matchesCategory = activeHomeCategory === 'all' || tool.homeCategory === activeHomeCategory;
          return matchesCategory && (!query || tool.searchable.includes(query));
        });

        if (!visibleTools.length) {
          homeToolGrid.innerHTML = `<div class="tool-result-empty">${escapeHtml(t('home.noToolsFound'))}</div>`;
          if (homeToolLoadMore) homeToolLoadMore.hidden = true;
          if (typeof createIcons === 'function') createIcons({ icons });
          return;
        }

        const shownTools = visibleTools.slice(0, homeVisibleToolCount);
        homeToolGrid.innerHTML = shownTools.map(tool => `
          <button class="tool-result-card" type="button" data-home-tool="${escapeHtml(tool.toolId)}" data-tool-category="${escapeHtml(tool.homeCategory)}">
            <span class="card-water-layer" aria-hidden="true"><span class="card-water-ripple"></span></span>
            <span class="tool-result-top">
              <span class="tool-result-icon">${tool.iconHtml || '<i data-lucide="sparkles"></i>'}</span>
              <span class="tool-result-tag">${escapeHtml(tool.tag)}</span>
            </span>
            <span>
              <span class="tool-result-name">${escapeHtml(tool.name)}</span>
              <span class="tool-result-desc">${escapeHtml(tool.desc)}</span>
            </span>
          </button>
        `).join('');

        const remaining = Math.max(0, visibleTools.length - shownTools.length);
        if (homeToolLoadMore) homeToolLoadMore.hidden = remaining === 0;
        if (homeToolLoadMoreSummary) {
          const summary = t('home.loadMoreSummary', { shown: shownTools.length, total: visibleTools.length });
          homeToolLoadMoreSummary.textContent = remaining > 0
            ? `${summary} · ${t('home.loadMoreRemaining', { remaining })}`
            : summary;
        }
        if (homeToolLoadMoreButton) {
          homeToolLoadMoreButton.disabled = remaining === 0;
          const label = t('home.loadMore');
          homeToolLoadMoreButton.querySelector('[data-i18n="home.loadMore"]')?.replaceChildren(document.createTextNode(label));
        }

        if (typeof createIcons === 'function') createIcons({ icons });
        homeToolGrid.querySelectorAll('[data-home-tool]').forEach(card => {
          const tool = shownTools.find(item => item.toolId === card.dataset.homeTool);
          card.addEventListener('click', () => launchToolFromHome(card.dataset.homeTool));
          card.addEventListener('contextmenu', event => {
            event.preventDefault();
            if (!tool) return;
            favoriteToolFromInfo(tool);
            card.classList.toggle('is-favorited', isFavorited(tool.toolId));
          });
        });
      }

      document.querySelectorAll('[data-open-tools]').forEach(button => {
        button.addEventListener('click', scrollHomeToExplorer);
      });
      document.querySelectorAll('[data-open-support]').forEach(button => {
        button.addEventListener('click', openDonationOverlay);
      });

      function decorateHomeCategoryChip(chip) {
        const labelHost = chip.querySelector(':scope > span');
        const label = labelHost?.textContent?.trim();
        if (!labelHost || !label || labelHost.classList.contains('category-chip-label')) return;
        const createLayer = className => {
          const layer = document.createElement('span');
          layer.className = className;
          Array.from(label).forEach((character, index) => {
            const letter = document.createElement('span');
            letter.style.setProperty('--category-letter-duration', `${Math.min(660, 420 + index * 120)}ms`);
            letter.textContent = character === ' ' ? '\u00a0' : character;
            layer.appendChild(letter);
          });
          return layer;
        };
        chip.setAttribute('aria-label', label);
        labelHost.className = 'category-chip-label';
        labelHost.setAttribute('aria-hidden', 'true');
        labelHost.replaceChildren(
          createLayer('category-chip-text category-chip-text-outgoing'),
          createLayer('category-chip-text category-chip-text-incoming')
        );
      }

      homeCategoryChips.forEach(decorateHomeCategoryChip);
      homeCategoryChips.forEach(chip => chip.setAttribute('aria-pressed', String(chip.classList.contains('is-active'))));
      homeCategoryChips.forEach(chip => {
        chip.addEventListener('click', () => {
          activeHomeCategory = chip.dataset.homeCategory || 'all';
          homeCategoryChips.forEach(item => {
            const isActive = item === chip;
            item.classList.toggle('is-active', isActive);
            item.setAttribute('aria-pressed', String(isActive));
          });
          renderHomeTools({ resetPagination: true });
        });
      });

      homeToolSearch?.addEventListener('input', () => renderHomeTools({ resetPagination: true }));
      homeToolLoadMoreButton?.addEventListener('click', () => {
        homeVisibleToolCount += HOME_TOOL_PAGE_SIZE;
        renderHomeTools();
      });
      homeScrollContainer?.addEventListener('scroll', () => {
        if (homeScrollUiRaf) return;
        homeScrollUiRaf = window.requestAnimationFrame(() => {
          homeScrollUiRaf = 0;
          syncHomeBackToTop();
        });
      }, { passive: true });
      backToTop?.addEventListener('click', () => {
        homeScrollContainer?.scrollTo({ top: 0, behavior: 'smooth' });
      });
      syncHomeBackToTop();
      renderHomeTools();
      onLangChange(renderHomeTools);

      // ===== PDF Tool Template Overlay Background =====
      const pdfToolTemplateOverlay = document.getElementById('pdfToolTemplateOverlay');
      const pdfToolTemplatePlasmaBg = document.getElementById('pdfToolTemplatePlasmaBg');
      const pdfToolTemplateBack = document.getElementById('pdfToolTemplateBack');
      let pdfToolTemplatePlasmaInstance = null;

      function openPdfToolTemplateOverlay() {
        if (!pdfToolTemplateOverlay) return;
        pdfToolTemplateOverlay.classList.add('visible');
        if (pdfToolTemplatePlasmaBg && !pdfToolTemplatePlasmaInstance) {
          pdfToolTemplatePlasmaInstance = initStandardToolPlasma(pdfToolTemplatePlasmaBg);
        }
      }

      function closePdfToolTemplateOverlay() {
        if (!pdfToolTemplateOverlay) return;
        pdfToolTemplateOverlay.classList.remove('visible');
        pdfToolTemplatePlasmaInstance = disposeStandardToolPlasma(pdfToolTemplatePlasmaInstance);
      }

      window.openPdfToolTemplateOverlay = openPdfToolTemplateOverlay;
      pdfToolTemplateBack?.addEventListener('click', closePdfToolTemplateOverlay);

      // Robust JSON extraction: strip markdown code blocks and use balanced brace matching
      function extractJson(str) {
        if (!str || typeof str !== 'string') return null;

        // 0. Try direct JSON.parse first (in case the entire string is valid JSON)
        try {
          JSON.parse(str.trim());
          return str.trim();
        } catch (e) {}

        // 1. Try to extract content from markdown code blocks (```json ... ``` or ``` ... ```)
        const codeBlockRegex = /```(?:json|javascript|js)?\s*\n([\s\S]*?)\n```/g;
        let matches = [];
        let match;
        while ((match = codeBlockRegex.exec(str)) !== null) {
          matches.push(match[1]);
        }
        for (const blockContent of matches) {
          const trimmed = cleanJsonString(blockContent.trim());
          // Try direct parse
          try { JSON.parse(trimmed); return trimmed; } catch (e) {}
          const start = trimmed.indexOf('{');
          if (start !== -1) {
            const result = extractBalancedJson(trimmed, start);
            if (result) {
              try { JSON.parse(result); return result; } catch (e) {}
            }
          }
        }

        // 2. Remove any stray code fence markers and surrounding explanation text
        let cleaned = cleanJsonString(str
          .replace(/```(?:json|javascript|js)?\s*/g, '')
          .replace(/```\s*/g, '')
          .trim());

        // 3. Try direct parse on cleaned string
        try { JSON.parse(cleaned); return cleaned; } catch (e) {}

        // 4. Find the first '{' and extract balanced JSON
        const start = cleaned.indexOf('{');
        if (start === -1) return null;
        const balanced = extractBalancedJson(cleaned, start);
        if (balanced) {
          try { JSON.parse(balanced); return balanced; } catch (e) {}
        }

        // 5. Fallback: find first '{' and last '}' — try to parse the substring
        const lastClose = cleaned.lastIndexOf('}');
        if (start !== -1 && lastClose > start) {
          const candidate = cleaned.substring(start, lastClose + 1);
          try { JSON.parse(candidate); return candidate; } catch (e) {}
        }

        // 6. Repair truncated JSON (DeepSeek output hit the 8K token limit and got cut off)
        const repaired = repairTruncatedJson(cleaned);
        if (repaired) {
          try { JSON.parse(repaired); return repaired; } catch (e) {}
        }

        // 7. Last resort: return the balanced result even if JSON.parse fails (caller will handle)
        if (balanced) return balanced;

        return null;
      }

      // Repairs a truncated JSON object by discarding the incomplete trailing portion
      // and closing all open brackets. Used when the model output is cut off mid-region.
      function repairTruncatedJson(str) {
        const start = str.indexOf('{');
        if (start === -1) return null;
        const candidates = []; // each: { pos, stack: remaining open brackets after this close }
        let stack = [];
        let inString = false;
        let escape = false;
        for (let i = start; i < str.length; i++) {
          const ch = str[i];
          if (escape) { escape = false; continue; }
          if (ch === '\\') { if (inString) escape = true; continue; }
          if (ch === '"') { inString = !inString; continue; }
          if (inString) continue;
          if (ch === '{' || ch === '[') {
            stack.push(ch);
          } else if (ch === '}' || ch === ']') {
            stack.pop();
            candidates.push({ pos: i, stack: stack.slice() });
          }
        }
        // Try from the last complete closing bracket backwards, closing the remaining stack
        for (let k = candidates.length - 1; k >= 0; k--) {
          const { pos, stack: rem } = candidates[k];
          let closing = '';
          for (let j = rem.length - 1; j >= 0; j--) {
            closing += rem[j] === '{' ? '}' : ']';
          }
          const candidate = str.substring(start, pos + 1) + closing;
          try {
            JSON.parse(candidate);
            console.warn('[AI Doc] Repaired truncated JSON, discarded trailing incomplete content. Recovered length:', candidate.length);
            return candidate;
          } catch (e) {}
        }
        return null;
      }

      function cleanJsonString(str) {
        // Remove BOM and control characters that are invalid in JSON strings
        return str.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFEFF\uFFFD]/g, '');
      }

      function extractBalancedJson(str, start) {
        let depth = 0;
        let inString = false;
        let escape = false;
        for (let i = start; i < str.length; i++) {
          const ch = str[i];
          if (escape) { escape = false; continue; }
          if (ch === '\\' && inString) { escape = true; continue; }
          if (ch === '"') { inString = !inString; continue; }
          if (inString) continue;
          if (ch === '{') depth++;
          else if (ch === '}') {
            depth--;
            if (depth === 0) return str.substring(start, i + 1);
          }
        }
        return null;
      }

      async function callDeepSeek(messages, signal, maxTokens) {
        const apiKey = await getAiApiKey();
        if (!apiKey) {
          throw new Error(t('home.aiPolish.noApiKey'));
        }
        const { url: apiUrl, model, allowPrivateHttp } = getAiPlatformConfig();
        if (!apiUrl || !model) {
          throw new Error(t('home.aiPolish.noApiKey'));
        }
        try {
          return await requestAiCompletion({
            url: apiUrl,
            apiKey,
            model,
            messages,
            maxTokens,
            signal,
            allowPrivateHttp,
            nativeRequestImpl: async request => {
              const { invoke } = await tauriCorePromise;
              return invoke('request_private_ai_completion', { request });
            }
          });
        } catch (error) {
          if (error instanceof AiProviderError) {
            const suffix = error.code === 'http_error' && error.status !== null
              ? `: ${error.status}`
              : '';
            throw new Error(`${t('home.aiPolish.apiError')}${suffix}`);
          }
          throw error;
        }
      }




      // ===== Color Extractor Tool =====
      const colorExtractorOverlay = document.getElementById('colorExtractorOverlay');
      const colorExtractorBack = document.getElementById('colorExtractorBack');
      const colorExtractorBg = document.getElementById('colorExtractorBg');
      const colorExtractorUploadZone = document.getElementById('colorExtractorUploadZone');
      const colorExtractorFileInput = document.getElementById('colorExtractorFileInput');
      const colorExtractorResult = document.getElementById('colorExtractorResult');
      const colorExtractorDrawerHandle = document.getElementById('colorExtractorDrawerHandle');
      const colorExtractorCircles = document.getElementById('colorExtractorCircles');
      const colorExtractorImagePreview = document.getElementById('colorExtractorImagePreview');
      const colorExtractorImage = document.getElementById('colorExtractorImage');
      const colorExtractorDrawerImage = document.getElementById('colorExtractorDrawerImage');
      const colorExtractorCirclesView = document.getElementById('colorExtractorCirclesView');
      const colorExtractorReselectBtn = document.getElementById('colorExtractorReselectBtn');
      const colorExtractorFill = document.getElementById('colorExtractorFill');
      const colorExtractorDetailView = document.getElementById('colorExtractorDetailView');
      const colorExtractorDetailCols = document.getElementById('colorExtractorDetailCols');
      const colorExtractorBackDetailBtn = document.getElementById('colorExtractorBackDetailBtn');
      const colorExtractorImageModeBtn = document.getElementById('colorExtractorImageModeBtn');
      const colorExtractorScreenModeBtn = document.getElementById('colorExtractorScreenModeBtn');
      const colorExtractorImageMode = document.getElementById('colorExtractorImageMode');
      const colorExtractorScreenMode = document.getElementById('colorExtractorScreenMode');
      const colorExtractorScreenStartBtn = document.getElementById('colorExtractorScreenStartBtn');
      const colorExtractorStatus = document.getElementById('colorExtractorStatus');
      const colorExtractorScreenResult = document.getElementById('colorExtractorScreenResult');
      const colorExtractorScreenSwatch = document.getElementById('colorExtractorScreenSwatch');
      const colorExtractorScreenHex = document.getElementById('colorExtractorScreenHex');
      const colorExtractorScreenRgb = document.getElementById('colorExtractorScreenRgb');
      const colorExtractorScreenCopyBtn = document.getElementById('colorExtractorScreenCopyBtn');
      const colorExtractorPaletteEmpty = document.getElementById('colorExtractorPaletteEmpty');
      const colorExtractorPaletteGrid = document.getElementById('colorExtractorPaletteGrid');
      const colorExtractorImageName = document.getElementById('colorExtractorImageName');
      const colorExtractorImageMeta = document.getElementById('colorExtractorImageMeta');
      const colorExtractorReplaceBtn = document.getElementById('colorExtractorReplaceBtn');
      const colorExtractorDetailSwatch = document.getElementById('colorExtractorDetailSwatch');
      const colorExtractorDetailHex = document.getElementById('colorExtractorDetailHex');
      const colorExtractorDetailRgb = document.getElementById('colorExtractorDetailRgb');
      const colorExtractorDetailHsl = document.getElementById('colorExtractorDetailHsl');
      const colorExtractorDetailHint = document.getElementById('colorExtractorDetailHint');

      const screenPickerOverlay = document.getElementById('screenPickerOverlay');
      const screenPickerCanvas = document.getElementById('screenPickerCanvas');
      const screenPickerCrosshair = screenPickerOverlay?.querySelector('.screen-picker-crosshair');
      const screenPickerReadoutSwatch = document.getElementById('screenPickerReadoutSwatch');
      const screenPickerReadoutHex = document.getElementById('screenPickerReadoutHex');
      const screenPickerReadoutRgb = document.getElementById('screenPickerReadoutRgb');
      const screenPickerLocked = document.getElementById('screenPickerLocked');
      const screenPickerFinishBtn = document.getElementById('screenPickerFinishBtn');

      let colorExtractorPlasmaInstance = null;
      let colorExtractorCurrentImg = null;
      let colorExtractorColors = [];
      let colorExtractorRequestId = 0;
      let colorExtractorPreviewUrl = null;
      let colorExtractorDrawerClosing = false;
      let colorExtractorDrawerDrag = null;
      let colorExtractorMode = 'image';
      let screenPickerUnlisten = null;
      let screenPickerListening = false;
      let screenPickerWindowTimer = null;
      let screenPickerWindowRaf = null;
      let screenPickerWindowBounds = null;
      let screenPickerLatestSample = null;
      let screenPickerWindowLocked = false;
      let screenPickerOpenUnlisten = null;
      let colorExtractorSelectedIndex = -1;
      let screenPickerUnlistens = [];
      const COLOR_EXTRACTOR_FILL_MS = 480;
      const COLOR_EXTRACTOR_DETAIL_FADE_MS = 220;
      const COLOR_EXTRACTOR_FILL_START_DELAY_MS = 24;
      const COLOR_EXTRACTOR_DRAWER_CLOSE_MS = 280;

      function updateColorExtractorStatus(text) {
        if (colorExtractorStatus) colorExtractorStatus.textContent = text;
      }

      function hslFromRgb(r, g, b) {
        const rn = r / 255;
        const gn = g / 255;
        const bn = b / 255;
        const max = Math.max(rn, gn, bn);
        const min = Math.min(rn, gn, bn);
        const lightness = (max + min) / 2;
        if (max === min) return { h: 0, s: 0, l: Math.round(lightness * 100) };
        const delta = max - min;
        const saturation = lightness > 0.5 ? delta / (2 - max - min) : delta / (max + min);
        let hue;
        if (max === rn) hue = ((gn - bn) / delta + (gn < bn ? 6 : 0)) / 6;
        else if (max === gn) hue = ((bn - rn) / delta + 2) / 6;
        else hue = ((rn - gn) / delta + 4) / 6;
        return { h: Math.round(hue * 360), s: Math.round(saturation * 100), l: Math.round(lightness * 100) };
      }

      function colorFromScreenSample(sample) {
        const hex = String(sample?.hex || '').match(/^#[0-9a-fA-F]{6}$/)?.[0]?.toUpperCase() || '#000000';
        const rgbMatch = String(sample?.rgb || '').match(/^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/i);
        const r = rgbMatch ? Math.max(0, Math.min(255, Number(rgbMatch[1]))) : 0;
        const g = rgbMatch ? Math.max(0, Math.min(255, Number(rgbMatch[2]))) : 0;
        const b = rgbMatch ? Math.max(0, Math.min(255, Number(rgbMatch[3]))) : 0;
        return { hex, rgb: { r, g, b }, hsl: hslFromRgb(r, g, b) };
      }

      function resetScreenColorResult() {
        if (colorExtractorScreenResult) colorExtractorScreenResult.hidden = true;
        if (colorExtractorScreenSwatch) colorExtractorScreenSwatch.style.removeProperty('background-color');
        if (colorExtractorScreenHex) colorExtractorScreenHex.textContent = '#000000';
        if (colorExtractorScreenRgb) colorExtractorScreenRgb.textContent = 'rgb(0, 0, 0)';
      }

      function renderColorExtractorDetail(color) {
        const has = Boolean(color);
        if (colorExtractorDetailSwatch) colorExtractorDetailSwatch.style.backgroundColor = has ? color.hex : 'rgba(255,255,255,0.04)';
        if (colorExtractorDetailHex) colorExtractorDetailHex.textContent = has ? color.hex : '—';
        if (colorExtractorDetailRgb) colorExtractorDetailRgb.textContent = has ? `rgb(${color.rgb.r}, ${color.rgb.g}, ${color.rgb.b})` : '—';
        if (colorExtractorDetailHsl) colorExtractorDetailHsl.textContent = has ? `hsl(${color.hsl.h}, ${color.hsl.s}%, ${color.hsl.l}%)` : '—';
        if (colorExtractorDetailHint) colorExtractorDetailHint.hidden = has;
      }

      function selectColor(index) {
        const color = colorExtractorColors[index];
        if (!color) return;
        colorExtractorSelectedIndex = index;
        colorExtractorPaletteGrid?.querySelectorAll('.color-extractor-palette-card').forEach(card => {
          card.classList.toggle('is-selected', Number(card.dataset.colorIndex) === index);
        });
        renderColorExtractorDetail(color);
      }

      function addScreenColor(color) {
        const existing = colorExtractorColors.findIndex(item => item.hex === color.hex);
        if (existing >= 0) {
          colorExtractorSelectedIndex = existing;
        } else {
          colorExtractorColors.unshift(color);
          colorExtractorSelectedIndex = 0;
        }
        renderColorExtractorPalette();
        renderColorExtractorDetail(colorExtractorColors[colorExtractorSelectedIndex]);
      }

      function extractPaletteFromImage(img) {
        if (!img?.naturalWidth || !img?.naturalHeight) return;
        const canvas = document.createElement('canvas');
        const maxDim = 200;
        const scale = Math.min(maxDim / img.naturalWidth, maxDim / img.naturalHeight, 1);
        canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
        canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) return;
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        let data;
        try {
          data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        } catch (error) {
          console.error('[Color Extractor] Pixel read error:', error);
          showToast(t('home.colorExtractor.extractFailed'));
          return;
        }
        const colors = paletteFromRgba(data, 9);
        if (!colors.length) {
          showToast(t('home.colorExtractor.extractFailed'));
          return;
        }
        colorExtractorColors = colors;
        colorExtractorSelectedIndex = 0;
        renderColorExtractorPalette();
        renderColorExtractorDetail(colors[0]);
        updateColorExtractorStatus(getLang() === 'zh' ? `已提取 ${colors.length} 种颜色` : `${colors.length} colors extracted`);
      }

      function releaseColorExtractorPreviewUrl() {
        if (colorExtractorPreviewUrl) URL.revokeObjectURL(colorExtractorPreviewUrl);
        colorExtractorPreviewUrl = null;
      }

      function setColorExtractorMode(mode = 'image') {
        colorExtractorMode = mode === 'screen' ? 'screen' : 'image';
        const isScreen = colorExtractorMode === 'screen';
        colorExtractorImageModeBtn?.classList.toggle('is-active', !isScreen);
        colorExtractorScreenModeBtn?.classList.toggle('is-active', isScreen);
        colorExtractorImageModeBtn?.setAttribute('aria-selected', String(!isScreen));
        colorExtractorScreenModeBtn?.setAttribute('aria-selected', String(isScreen));
        if (colorExtractorImageMode) colorExtractorImageMode.hidden = isScreen;
        if (colorExtractorScreenMode) colorExtractorScreenMode.hidden = !isScreen;
        updateColorExtractorStatus(isScreen
          ? t('home.colorExtractor.screenMode')
          : (colorExtractorColors.length
            ? (getLang() === 'zh' ? '已提取配色' : 'Palette ready')
            : t('home.colorExtractor.waiting')));
      }

      function renderScreenColorResult(sample) {
        const color = colorFromScreenSample(sample);
        if (colorExtractorScreenSwatch) colorExtractorScreenSwatch.style.backgroundColor = color.hex;
        if (colorExtractorScreenHex) colorExtractorScreenHex.textContent = color.hex;
        if (colorExtractorScreenRgb) colorExtractorScreenRgb.textContent = `rgb(${color.rgb.r}, ${color.rgb.g}, ${color.rgb.b})`;
        if (colorExtractorScreenResult) colorExtractorScreenResult.hidden = false;
        addScreenColor(color);
        updateColorExtractorStatus(t('home.colorExtractor.screenPicked'));
      }

      function openColorExtractorForShortcutResult(sample) {
        if (!colorExtractorOverlay) return;
        // A global shortcut can fire from the home screen or another tool.
        // Bring the color extractor page to the front and switch it to screen
        // mode before rendering the sampled color so the result is visible.
        if (!colorExtractorOverlay.classList.contains('visible')) {
          colorExtractorOverlay.classList.add('visible');
          resetColorExtractorState();
          if (colorExtractorBg && !colorExtractorPlasmaInstance) {
            colorExtractorPlasmaInstance = initStandardToolPlasma(colorExtractorBg);
          }
        }
        setColorExtractorMode('screen');
        renderScreenColorResult(sample);
      }

      async function listenForScreenColorResults() {
        if (!isTauri || isScreenPickerWindow || screenPickerListening) return;
        screenPickerListening = true;
        const pendingUnlistens = [];
        try {
          const { listen } = await tauriEventPromise;
          pendingUnlistens.push(await listen('screen-color-picked', event => {
            openColorExtractorForShortcutResult(event?.payload);
          }));
          pendingUnlistens.push(await listen('screen-picker-ready', () => {
            updateColorExtractorStatus(t('home.colorExtractor.screenReady'));
            if (colorExtractorScreenStartBtn) colorExtractorScreenStartBtn.disabled = false;
          }));
          pendingUnlistens.push(await listen('screen-picker-cancelled', () => {
            updateColorExtractorStatus(getLang() === 'zh' ? '已取消取色' : 'Sampling cancelled');
            if (colorExtractorScreenStartBtn) colorExtractorScreenStartBtn.disabled = false;
          }));
          pendingUnlistens.push(await listen('screen-picker-closed', () => {
            if (colorExtractorScreenStartBtn) colorExtractorScreenStartBtn.disabled = false;
          }));
          screenPickerUnlistens.push(...pendingUnlistens);
        } catch (error) {
          await Promise.all(pendingUnlistens.map(unlisten => {
            try { return unlisten?.(); } catch { return null; }
          }));
          screenPickerListening = false;
          console.error('[Color Extractor] Cannot listen for screen color:', error);
        }
      }

      async function openNativeScreenPicker() {
        if (!isTauri) {
          if (typeof window.EyeDropper === 'function') {
            try {
              const result = await new window.EyeDropper().open();
              const hex = String(result?.sRGBHex || '').toUpperCase();
              const value = hex.match(/^#[0-9A-F]{6}$/) ? hex : '#000000';
              const numeric = [1, 3, 5].map(index => parseInt(value.slice(index, index + 2), 16));
              renderScreenColorResult({ hex: value, rgb: `rgb(${numeric[0]}, ${numeric[1]}, ${numeric[2]})` });
              return;
            } catch (error) {
              if (error?.name !== 'AbortError') showToast('浏览器暂不支持屏幕取色。');
              return;
            }
          }
          showToast('桌面屏幕取色仅支持桌面版。');
          return;
        }
        if (colorExtractorScreenStartBtn) colorExtractorScreenStartBtn.disabled = true;
        updateColorExtractorStatus(getLang() === 'zh' ? '正在启动取色器…' : 'Starting picker…');
        try {
          await listenForScreenColorResults();
          const { invoke } = await tauriCorePromise;
          await invoke('open_screen_color_picker');
          // The overlay window emits `screen-picker-ready` when it is ready.
          // Keep a fallback so the UI is never left permanently on "starting…"
          // even if that handshake is delayed or lost.
          window.setTimeout(() => {
            if (colorExtractorScreenStartBtn?.disabled) {
              updateColorExtractorStatus(getLang() === 'zh' ? '取色器已就绪' : 'Picker ready');
            }
          }, 1200);
        } catch (error) {
          console.error('[Color Extractor] Cannot open native screen picker:', error);
          if (colorExtractorScreenStartBtn) colorExtractorScreenStartBtn.disabled = false;
          updateColorExtractorStatus(getLang() === 'zh' ? '取色器启动失败' : 'Picker failed to start');
          showToast(error?.toString?.() || '屏幕取色器启动失败。');
        }
      }

      async function closeNativeScreenPicker() {
        if (!isTauri) return;
        try {
          const { invoke } = await tauriCorePromise;
          await invoke('close_screen_color_picker');
        } catch (error) {
          console.warn('[Color Extractor] Cannot close native screen picker:', error);
        }
      }

      function screenPickerClamp(value, min, max) {
        return Math.max(min, Math.min(max, value));
      }

      function drawScreenPickerSample(sample) {
        if (!screenPickerCanvas || !sample?.pixels?.length) return;
        const gridWidth = Number(sample.width) || 21;
        const gridHeight = Number(sample.height) || 21;
        const ctx = screenPickerCanvas.getContext('2d');
        if (!ctx) return;
        const canvasSize = 252;
        if (screenPickerCanvas.width !== canvasSize || screenPickerCanvas.height !== canvasSize) {
          screenPickerCanvas.width = canvasSize;
          screenPickerCanvas.height = canvasSize;
        }
        ctx.clearRect(0, 0, canvasSize, canvasSize);
        ctx.imageSmoothingEnabled = false;
        const cellW = canvasSize / gridWidth;
        const cellH = canvasSize / gridHeight;
        for (let row = 0; row < gridHeight; row++) {
          for (let col = 0; col < gridWidth; col++) {
            const offset = (row * gridWidth + col) * 3;
            const r = Number(sample.pixels[offset]) || 0;
            const g = Number(sample.pixels[offset + 1]) || 0;
            const b = Number(sample.pixels[offset + 2]) || 0;
            ctx.fillStyle = `rgb(${r}, ${g}, ${b})`;
            ctx.fillRect(Math.floor(col * cellW), Math.floor(row * cellH), Math.ceil(cellW) + 1, Math.ceil(cellH) + 1);
          }
        }
        ctx.strokeStyle = 'rgba(255,255,255,.13)';
        ctx.lineWidth = 1;
        for (let i = 1; i < gridWidth; i++) {
          const x = Math.round(i * cellW) + 0.5;
          ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, canvasSize); ctx.stroke();
        }
        for (let i = 1; i < gridHeight; i++) {
          const y = Math.round(i * cellH) + 0.5;
          ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(canvasSize, y); ctx.stroke();
        }
      }

      function positionScreenPickerLens(sample) {
        if (!screenPickerCanvas || !sample || !screenPickerWindowBounds) return;
        const viewportWidth = window.innerWidth || screenPickerWindowBounds.width;
        const viewportHeight = window.innerHeight || screenPickerWindowBounds.height;
        const scaleX = viewportWidth / Math.max(1, Number(screenPickerWindowBounds.width) || viewportWidth);
        const scaleY = viewportHeight / Math.max(1, Number(screenPickerWindowBounds.height) || viewportHeight);
        const localX = (Number(sample.x) - Number(screenPickerWindowBounds.x)) * scaleX;
        const localY = (Number(sample.y) - Number(screenPickerWindowBounds.y)) * scaleY;
        const lensSize = 252;
        const left = screenPickerClamp(localX + 34, 16, Math.max(16, viewportWidth - lensSize - 16));
        const top = screenPickerClamp(localY - lensSize - 46, 16, Math.max(16, viewportHeight - lensSize - 16));
        screenPickerCanvas.style.left = `${left}px`;
        screenPickerCanvas.style.top = `${top}px`;
        if (screenPickerCrosshair) {
          screenPickerCrosshair.style.left = `${left}px`;
          screenPickerCrosshair.style.top = `${top}px`;
        }
        const readout = screenPickerOverlay?.querySelector('.screen-picker-readout');
        if (readout) {
          readout.style.left = `${left}px`;
          readout.style.top = `${screenPickerClamp(top + lensSize + 12, 16, Math.max(16, viewportHeight - 76))}px`;
        }
      }

      async function emitScreenPickerEvent(name, payload) {
        try {
          const { emitTo } = await tauriEventPromise;
          await emitTo('main', name, payload);
        } catch (error) {
          console.error('[Color Extractor] Cannot emit screen picker event:', error);
        }
      }

      function stopScreenPickerSampling() {
        if (screenPickerWindowTimer !== null) {
          clearTimeout(screenPickerWindowTimer);
          screenPickerWindowTimer = null;
        }
        if (screenPickerWindowRaf !== null) {
          cancelAnimationFrame(screenPickerWindowRaf);
          screenPickerWindowRaf = null;
        }
      }

      async function runScreenPickerSample() {
        if (!isScreenPickerWindow || screenPickerWindowLocked) return;
        try {
          const { invoke } = await tauriCorePromise;
          const sample = await invoke('screen_color_sample');
          if (screenPickerWindowLocked) return;
          screenPickerLatestSample = sample;
          drawScreenPickerSample(sample);
          positionScreenPickerLens(sample);
          const hex = String(sample?.hex || '#000000').toUpperCase();
          const rgb = String(sample?.rgb || 'rgb(0, 0, 0)');
          if (screenPickerReadoutSwatch) screenPickerReadoutSwatch.style.backgroundColor = hex;
          if (screenPickerReadoutHex) screenPickerReadoutHex.textContent = hex;
          if (screenPickerReadoutRgb) screenPickerReadoutRgb.textContent = rgb;
        } catch (error) {
          console.warn('[Color Extractor] Screen pixel sample failed:', error);
        }
        if (!screenPickerWindowLocked) {
          screenPickerWindowTimer = setTimeout(() => {
            screenPickerWindowRaf = requestAnimationFrame(() => {
              screenPickerWindowRaf = null;
              void runScreenPickerSample();
            });
          }, 30);
        }
      }

      async function closeScreenPickerWindow(eventName = 'screen-picker-closed') {
        stopScreenPickerSampling();
        screenPickerWindowLocked = false;
        screenPickerLatestSample = null;
        if (screenPickerLocked) screenPickerLocked.hidden = true;
        await emitScreenPickerEvent(eventName);
        await closeNativeScreenPicker();
      }

      function restartScreenPickerSampling(bounds = null) {
        if (!isScreenPickerWindow) return;
        if (bounds && typeof bounds === 'object') screenPickerWindowBounds = bounds;
        stopScreenPickerSampling();
        screenPickerWindowLocked = false;
        screenPickerLatestSample = null;
        if (screenPickerLocked) screenPickerLocked.hidden = true;
        void emitScreenPickerEvent('screen-picker-ready');
        void runScreenPickerSample();
      }

      function initScreenPickerWindow() {
        if (window.__toolknitScreenPickerBootstrapped) return;
        if (!isScreenPickerWindow || !screenPickerOverlay) return;
        window.__toolknitScreenPickerBootstrapped = true;
        document.documentElement.dataset.screenPicker = '1';
        screenPickerOverlay.classList.add('visible');
        screenPickerOverlay.addEventListener('click', async event => {
          if (event.target.closest('#screenPickerFinishBtn')) return;
          if (screenPickerWindowLocked || !screenPickerLatestSample) return;
          screenPickerWindowLocked = true;
          stopScreenPickerSampling();
          if (screenPickerLocked) screenPickerLocked.hidden = false;
          const sample = screenPickerLatestSample;
          await emitScreenPickerEvent('screen-color-picked', sample);
          try { await copyColorExtractorText(sample.hex); } catch {}
        });
        screenPickerFinishBtn?.addEventListener('click', event => {
          event.preventDefault();
          event.stopPropagation();
          void closeScreenPickerWindow('screen-picker-closed');
        });
        window.addEventListener('keydown', event => {
          if (event.key === 'Escape') {
            event.preventDefault();
            void closeScreenPickerWindow('screen-picker-cancelled');
          }
        }, { capture: true });
        (async () => {
          try {
            const [{ invoke }, { listen }] = await Promise.all([
              tauriCorePromise,
              tauriEventPromise
            ]);
            screenPickerOpenUnlisten = await listen('screen-picker-opened', event => {
              restartScreenPickerSampling(event?.payload);
            });
            screenPickerWindowBounds = await invoke('screen_picker_bounds');
          } catch (error) {
            console.warn('[Color Extractor] Cannot read virtual desktop bounds:', error);
          }
          restartScreenPickerSampling(screenPickerWindowBounds);
        })();
        // A focus/visibility change is a fallback for older desktop builds
        // that do not emit the reopen event when reusing the overlay window.
        window.addEventListener('focus', () => restartScreenPickerSampling(), { passive: true });
        document.addEventListener('visibilitychange', () => {
          if (document.visibilityState === 'visible') restartScreenPickerSampling();
        }, { passive: true });
      }

      function openColorExtractorOverlay() {
        if (!colorExtractorOverlay) return;
        colorExtractorOverlay.classList.add('visible');
        resetColorExtractorState();
        setColorExtractorMode('image');
        if (colorExtractorBg && !colorExtractorPlasmaInstance) {
          colorExtractorPlasmaInstance = initStandardToolPlasma(colorExtractorBg);
        }
      }
      function closeColorExtractorOverlay() {
        if (!colorExtractorOverlay) return;
        colorExtractorOverlay.classList.remove('visible');
        resetColorExtractorState();
        void closeNativeScreenPicker();
        colorExtractorPlasmaInstance = disposeStandardToolPlasma(colorExtractorPlasmaInstance);
      }
      function resetColorExtractorState() {
        colorExtractorRequestId += 1;
        colorExtractorCurrentImg = null;
        colorExtractorColors = [];
        colorExtractorSelectedIndex = -1;
        setColorExtractorMode('image');
        if (colorExtractorUploadZone) {
          colorExtractorUploadZone.hidden = false;
          colorExtractorUploadZone.classList.remove('dragover');
        }
        if (colorExtractorFileInput) colorExtractorFileInput.value = '';
        if (colorExtractorImagePreview) colorExtractorImagePreview.hidden = true;
        if (colorExtractorImage) colorExtractorImage.removeAttribute('src');
        if (colorExtractorImageName) colorExtractorImageName.textContent = '';
        if (colorExtractorImageMeta) colorExtractorImageMeta.textContent = '';
        releaseColorExtractorPreviewUrl();
        resetScreenColorResult();
        renderColorExtractorPalette();
        renderColorExtractorDetail(null);
      }

      function closeColorExtractorDrawer() {
        if (!colorExtractorResult || colorExtractorDrawerClosing) return;
        if (!colorExtractorResult.classList.contains('visible')) {
          resetColorExtractorState();
          return;
        }
        colorExtractorAnimationTimers.forEach(timer => clearTimeout(timer));
        colorExtractorAnimationTimers = [];
        colorExtractorIsAnimating = false;
        colorExtractorDrawerClosing = true;
        colorExtractorDrawerDrag = null;
        if (colorExtractorDetailView) colorExtractorDetailView.classList.remove('visible');
        if (colorExtractorDetailCols) colorExtractorDetailCols.innerHTML = '';
        if (colorExtractorCirclesView) colorExtractorCirclesView.classList.remove('hidden');
        if (colorExtractorFill) {
          colorExtractorFill.classList.remove('expanded');
          colorExtractorFill.style.removeProperty('--fill-color');
          colorExtractorFill.style.removeProperty('--fill-x');
          colorExtractorFill.style.removeProperty('--fill-y');
          colorExtractorFill.style.removeProperty('--fill-scale');
        }
        colorExtractorResult.classList.remove('is-dragging');
        colorExtractorResult.style.transition = `transform ${COLOR_EXTRACTOR_DRAWER_CLOSE_MS}ms cubic-bezier(0.22, 1, 0.36, 1), opacity 220ms ease`;
        colorExtractorResult.style.transform = 'translateY(100%)';
        colorExtractorResult.style.opacity = '0';
        colorExtractorResult.style.pointerEvents = 'none';
        colorExtractorResult.classList.remove('visible');
        const timer = setTimeout(() => {
          resetColorExtractorState();
        }, COLOR_EXTRACTOR_DRAWER_CLOSE_MS + 40);
        colorExtractorAnimationTimers.push(timer);
      }

      function restoreColorExtractorDrawerFromDrag() {
        if (!colorExtractorResult) return;
        colorExtractorResult.classList.remove('is-dragging');
        colorExtractorResult.style.transition = 'transform 0.24s cubic-bezier(0.22, 1, 0.36, 1), opacity 0.2s ease';
        colorExtractorResult.style.transform = 'translateY(0)';
        colorExtractorResult.style.opacity = '1';
        const timer = setTimeout(() => {
          if (!colorExtractorResult.classList.contains('visible')) return;
          colorExtractorResult.style.removeProperty('transform');
          colorExtractorResult.style.removeProperty('opacity');
          colorExtractorResult.style.removeProperty('transition');
        }, 260);
        colorExtractorAnimationTimers.push(timer);
      }

      function beginColorExtractorDrawerDrag(event) {
        if (!colorExtractorResult?.classList.contains('visible') || colorExtractorDrawerClosing) return;
        event.preventDefault();
        event.stopPropagation();
        colorExtractorDrawerDrag = {
          pointerId: event.pointerId,
          startY: event.clientY,
          lastY: event.clientY,
          startedAt: performance.now(),
          moved: false
        };
        colorExtractorResult.classList.add('is-dragging');
        colorExtractorResult.style.transition = 'none';
        colorExtractorDrawerHandle?.setPointerCapture?.(event.pointerId);
      }

      function moveColorExtractorDrawerDrag(event) {
        if (!colorExtractorDrawerDrag || event.pointerId !== colorExtractorDrawerDrag.pointerId || !colorExtractorResult) return;
        event.preventDefault();
        const deltaY = Math.max(0, event.clientY - colorExtractorDrawerDrag.startY);
        colorExtractorDrawerDrag.lastY = event.clientY;
        colorExtractorDrawerDrag.moved = colorExtractorDrawerDrag.moved || deltaY > 3;
        colorExtractorResult.style.transform = `translateY(${deltaY}px)`;
        colorExtractorResult.style.opacity = String(Math.max(0.58, 1 - deltaY / 520));
      }

      function finishColorExtractorDrawerDrag(event) {
        if (!colorExtractorDrawerDrag || event.pointerId !== colorExtractorDrawerDrag.pointerId) return;
        event.preventDefault();
        const deltaY = Math.max(0, event.clientY - colorExtractorDrawerDrag.startY);
        const elapsed = Math.max(1, performance.now() - colorExtractorDrawerDrag.startedAt);
        const velocity = deltaY / elapsed;
        colorExtractorDrawerHandle?.releasePointerCapture?.(event.pointerId);
        colorExtractorDrawerDrag = null;
        if (deltaY >= 86 || velocity > 0.65) {
          closeColorExtractorDrawer();
        } else {
          restoreColorExtractorDrawerFromDrag();
        }
      }

      // Color conversion helpers
      function rgbToHex(r, g, b) {
        return '#' + [r, g, b].map(v => {
          const h = Math.round(v).toString(16);
          return h.length === 1 ? '0' + h : h;
        }).join('').toUpperCase();
      }
      function rgbToHsl(r, g, b) {
        r /= 255; g /= 255; b /= 255;
        const max = Math.max(r, g, b), min = Math.min(r, g, b);
        let h = 0, s = 0, l = (max + min) / 2;
        if (max !== min) {
          const d = max - min;
          s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
          switch (max) {
            case r: h = ((g - b) / d + (g < b ? 6 : 0)); break;
            case g: h = ((b - r) / d + 2); break;
            case b: h = ((r - g) / d + 4); break;
          }
          h /= 6;
        }
        return [Math.round(h * 360), Math.round(s * 100), Math.round(l * 100)];
      }

      function copyColorExtractorText(text) {
        return new Promise((resolve, reject) => {
          const fallbackCopy = () => {
            let handled = false;
            const onCopy = (event) => {
              if (!event.clipboardData) return;
              event.clipboardData.setData('text/plain', text);
              event.preventDefault();
              event.stopImmediatePropagation();
              handled = true;
            };
            try {
              const ta = document.createElement('textarea');
              ta.value = text;
              ta.style.position = 'fixed';
              ta.style.left = '-9999px';
              ta.style.top = '0';
              ta.style.opacity = '0';
              document.body.appendChild(ta);
              ta.select();
              document.addEventListener('copy', onCopy, { capture: true, once: true });
              const copied = document.execCommand?.('copy');
              document.removeEventListener('copy', onCopy, { capture: true });
              document.body.removeChild(ta);
              if (copied || handled) resolve();
              else reject(new Error('clipboard-unavailable'));
            } catch (error) {
              document.removeEventListener('copy', onCopy, { capture: true });
              reject(error);
            }
          };
          if (navigator.clipboard?.writeText) {
            navigator.clipboard.writeText(text).then(resolve).catch(fallbackCopy);
          } else {
            fallbackCopy();
          }
        });
      }

      // K-means color quantization
      function extractColors(img, numColors) {
        if (!img.naturalWidth || !img.naturalHeight) return [];
        numColors = Math.max(2, Math.min(numColors, 9));
        const canvas = document.createElement('canvas');
        const maxDim = 200; // Downsample for speed
        const scale = Math.min(maxDim / img.naturalWidth, maxDim / img.naturalHeight, 1);
        canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
        canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
        const ctx = canvas.getContext('2d');
        if (!ctx) return [];
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        let data;
        try {
          data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        } catch (error) {
          console.error('[Color Extractor] Pixel read error:', error);
          return [];
        }

        // Sample pixels (skip alpha=0)
        const pixels = [];
        for (let i = 0; i < data.length; i += 4) {
          if (data[i + 3] < 128) continue;
          pixels.push([data[i], data[i + 1], data[i + 2]]);
        }
        if (pixels.length === 0) return [];

        // Init centroids: pick evenly spaced pixels
        let centroids = [];
        const step = Math.max(1, Math.floor(pixels.length / numColors));
        for (let i = 0; i < numColors && i * step < pixels.length; i++) {
          centroids.push([...pixels[i * step]]);
        }
        if (centroids.length === 0) return [];

        const maxIter = 12;
        let sums = centroids.map(() => [0, 0, 0, 0]); // r,g,b,count — outside loop for later access
        for (let iter = 0; iter < maxIter; iter++) {
          sums = centroids.map(() => [0, 0, 0, 0]); // reset each iteration
          for (const p of pixels) {
            let bestDist = Infinity, bestIdx = 0;
            for (let ci = 0; ci < centroids.length; ci++) {
              const c = centroids[ci];
              const d = (p[0]-c[0])**2 + (p[1]-c[1])**2 + (p[2]-c[2])**2;
              if (d < bestDist) { bestDist = d; bestIdx = ci; }
            }
            sums[bestIdx][0] += p[0];
            sums[bestIdx][1] += p[1];
            sums[bestIdx][2] += p[2];
            sums[bestIdx][3]++;
          }
          let changed = false;
          for (let ci = 0; ci < centroids.length; ci++) {
            if (sums[ci][3] === 0) continue;
            const nr = sums[ci][0] / sums[ci][3];
            const ng = sums[ci][1] / sums[ci][3];
            const nb = sums[ci][2] / sums[ci][3];
            if (Math.abs(nr - centroids[ci][0]) > 1 || Math.abs(ng - centroids[ci][1]) > 1 || Math.abs(nb - centroids[ci][2]) > 1) {
              changed = true;
              centroids[ci] = [nr, ng, nb];
            }
          }
          if (!changed) break;
        }

        // Sort by population (most frequent first)
        const result = centroids.map((c, ci) => ({
          r: Math.round(c[0]), g: Math.round(c[1]), b: Math.round(c[2]),
          count: sums[ci] ? sums[ci][3] : 0,
        })).sort((a, b) => b.count - a.count);

        return result;
      }

      // File handling
      let colorExtractorAnimationTimers = []; // Track animation timers for cleanup
      let colorExtractorIsAnimating = false; // Prevent multiple simultaneous animations

      async function handleColorExtractorFile(file) {
        resetColorExtractorState();
        const requestId = colorExtractorRequestId;
        try {
          assertColorExtractorFile(file);
        } catch (error) {
          showToast(error instanceof RangeError
            ? t('home.colorExtractor.fileTooLarge', { max: 20 })
            : t('home.colorExtractor.unsupportedFormat'));
          return;
        }

        const mimeType = file.type === 'image/png' || /\.png$/i.test(file.name || '')
          ? 'image/png'
          : (file.type === 'image/webp' || /\.webp$/i.test(file.name || '') ? 'image/webp' : 'image/jpeg');
        const useLoadedImage = (img, imageUrl) => {
          if (requestId !== colorExtractorRequestId) {
            URL.revokeObjectURL(imageUrl);
            if (colorExtractorPreviewUrl === imageUrl) colorExtractorPreviewUrl = null;
            return;
          }
          try {
            assertColorExtractorDimensions(img.naturalWidth, img.naturalHeight);
          } catch (error) {
            URL.revokeObjectURL(imageUrl);
            if (colorExtractorPreviewUrl === imageUrl) colorExtractorPreviewUrl = null;
            showToast(t('home.colorExtractor.dimensionsTooLarge'));
            return;
          }
          colorExtractorCurrentImg = img;
          if (colorExtractorUploadZone) colorExtractorUploadZone.hidden = true;
          if (colorExtractorImage) colorExtractorImage.src = imageUrl;
          if (colorExtractorImagePreview) colorExtractorImagePreview.hidden = false;
          if (colorExtractorImageName) colorExtractorImageName.textContent = file.name || (getLang() === 'zh' ? '图片' : 'Image');
          if (colorExtractorImageMeta) colorExtractorImageMeta.textContent = `${img.naturalWidth} × ${img.naturalHeight}`;
          extractPaletteFromImage(img);
        };
        const loadImage = (blob) => {
          const imageUrl = URL.createObjectURL(blob);
          const img = new Image();
          img.onload = () => useLoadedImage(img, imageUrl);
          img.onerror = () => {
            URL.revokeObjectURL(imageUrl);
            if (colorExtractorPreviewUrl === imageUrl) colorExtractorPreviewUrl = null;
            if (requestId === colorExtractorRequestId) showToast(t('home.colorExtractor.extractFailed'));
          };
          colorExtractorPreviewUrl = imageUrl;
          img.src = imageUrl;
        };
        // In Tauri mode, read file bytes via backend to ensure data accessibility
        if (isTauri && file.path) {
          try {
            const { invoke } = await tauriCorePromise;
            const fileSize = Number(await invoke('get_file_size', { path: file.path }));
            assertColorExtractorFile(file, fileSize);
            const rawBytes = await invoke('read_file_bytes', { path: file.path });
            const bytes = Array.isArray(rawBytes) ? Uint8Array.from(rawBytes) : new Uint8Array(rawBytes);
            assertColorExtractorFile(file, bytes.byteLength);
            assertColorExtractorImageBytes(bytes);
            const blob = new Blob([bytes], { type: mimeType });
            loadImage(blob);
            return;
          } catch (e) {
            console.error('[Color Extractor] Tauri file read error:', e);
            if (requestId === colorExtractorRequestId) {
              showToast(e instanceof RangeError
                ? t('home.colorExtractor.fileTooLarge', { max: 20 })
                : t('home.colorExtractor.extractFailed'));
            }
            return;
          }
        }
        try {
          const bytes = new Uint8Array(await file.arrayBuffer());
          if (requestId !== colorExtractorRequestId) return;
          assertColorExtractorImageBytes(bytes);
          loadImage(file);
        } catch (error) {
          if (requestId !== colorExtractorRequestId) return;
          showToast(error instanceof RangeError
            ? t('home.colorExtractor.dimensionsTooLarge')
            : t('home.colorExtractor.extractFailed'));
        }
      }

      function renderColorExtractorPalette() {
        if (!colorExtractorPaletteEmpty || !colorExtractorPaletteGrid) return;
        const hasColors = colorExtractorColors.length > 0;
        colorExtractorPaletteEmpty.hidden = hasColors;
        colorExtractorPaletteGrid.hidden = !hasColors;
        if (!hasColors) {
          colorExtractorPaletteGrid.innerHTML = '';
          return;
        }
        colorExtractorPaletteGrid.innerHTML = colorExtractorColors.map((color, index) => {
          const rgb = `rgb(${color.rgb.r}, ${color.rgb.g}, ${color.rgb.b})`;
          const share = color.percentage === undefined ? '' : `${Math.round(color.percentage)}%`;
          const cardTitle = getLang() === 'zh' ? `查看 ${color.hex}` : `View ${color.hex}`;
          const selectedClass = index === colorExtractorSelectedIndex ? ' is-selected' : '';
          return `<div role="button" tabindex="0" class="color-extractor-palette-card${selectedClass}" data-color-index="${index}" title="${cardTitle}">
            <span class="color-extractor-palette-swatch" style="background-color:${color.hex}"></span>
            <span class="color-extractor-palette-copy"><strong>${color.hex}</strong><small>${rgb}</small></span>
            <span class="color-extractor-palette-share">${share}</span>
          </div>`;
        }).join('');
        colorExtractorPaletteGrid.querySelectorAll('.color-extractor-palette-card').forEach(card => {
          const index = Number(card.dataset.colorIndex);
          const swatch = card.querySelector('.color-extractor-palette-swatch');
          if (swatch && colorExtractorColors[index]) {
            swatch.style.backgroundColor = colorExtractorColors[index].hex;
          }
          card.addEventListener('click', () => selectColor(index));
          card.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              selectColor(index);
            }
          });
          card.addEventListener('contextmenu', async event => {
            event.preventDefault();
            const color = colorExtractorColors[index];
            if (!color) return;
            try {
              await copyColorExtractorText(color.hex);
              showToast(t('home.colorExtractor.copySuccess'));
            } catch {
              showToast(t('home.colorExtractor.copyFailed'));
            }
          });
        });
      }

      function renderColorCircles(colors, openDrawer = true) {
        if (!colorExtractorCircles) return;
        colorExtractorCircles.innerHTML = '';
        const top5 = colors.slice(0, 5);
        top5.forEach((color, idx) => {
          const hex = rgbToHex(color.r, color.g, color.b);
          const item = document.createElement('div');
          item.className = 'color-extractor-circle-item';
          item.style.animationDelay = (idx * 0.08) + 's';

          const circle = document.createElement('div');
          circle.className = 'color-extractor-circle';
          circle.style.background = hex;
          circle.addEventListener('click', () => {
            expandColorToDetail(color, circle);
          });

          const hexLabel = document.createElement('span');
          hexLabel.className = 'color-extractor-circle-hex';
          hexLabel.textContent = hex;
          hexLabel.title = getLang() === 'zh' ? '点击复制 HEX' : 'Click to copy HEX';
          hexLabel.addEventListener('click', async (event) => {
            event.stopPropagation();
            try {
              await copyColorExtractorText(hex);
              hexLabel.classList.remove('copied');
              void hexLabel.offsetWidth;
              hexLabel.classList.add('copied');
              showToast(t('home.colorExtractor.copySuccess'));
            } catch (error) {
              console.error('[Color Extractor] Copy failed:', error);
              showToast(t('home.colorExtractor.copyFailed'));
            }
          });

          item.appendChild(circle);
          item.appendChild(hexLabel);
          colorExtractorCircles.appendChild(item);
        });
        if (colorExtractorResult && openDrawer) {
          requestAnimationFrame(() => {
            colorExtractorResult.style.removeProperty('transform');
            colorExtractorResult.style.removeProperty('opacity');
            colorExtractorResult.style.removeProperty('transition');
            colorExtractorResult.style.removeProperty('pointer-events');
            colorExtractorResult.classList.add('visible');
          });
        }
      }

      function resetColorExtractor() {
        closeColorExtractorDrawer();
      }

      function expandColorToDetail(color, circleEl) {
        if (!colorExtractorFill || !colorExtractorResult) return;
        if (colorExtractorIsAnimating) return; // Prevent multiple simultaneous animations
        colorExtractorIsAnimating = true;
        
        const hex = rgbToHex(color.r, color.g, color.b);
        const rgbStr = `rgb(${color.r}, ${color.g}, ${color.b})`;
        const [h, s, l] = rgbToHsl(color.r, color.g, color.b);
        const hslStr = `hsl(${h}, ${s}%, ${l}%)`;

        // Calculate circle center relative to result container
        const rect = circleEl.getBoundingClientRect();
        const containerRect = colorExtractorResult.getBoundingClientRect();
        
        // Validate container dimensions
        if (containerRect.width === 0 || containerRect.height === 0) {
          console.error('[Color Extractor] Invalid container dimensions');
          colorExtractorIsAnimating = false;
          return;
        }
        
        const cx = rect.left + rect.width / 2 - containerRect.left;
        const cy = rect.top + rect.height / 2 - containerRect.top;
        const xPct = (cx / containerRect.width) * 100;
        const yPct = (cy / containerRect.height) * 100;

        // Calculate scale needed to cover the entire container from the clicked point
        const w = containerRect.width;
        const containerH = containerRect.height;
        const radius = 39; // half of 78px fill circle
        const corners = [
          Math.sqrt(cx * cx + cy * cy),
          Math.sqrt((w - cx) * (w - cx) + cy * cy),
          Math.sqrt(cx * cx + (containerH - cy) * (containerH - cy)),
          Math.sqrt((w - cx) * (w - cx) + (containerH - cy) * (containerH - cy)),
        ];
        const farthest = Math.max(...corners);
        const coverScale = (farthest / radius) + 0.5; // small margin

        // Hide circles view
        if (colorExtractorCirclesView) colorExtractorCirclesView.classList.add('hidden');

        // Set fill color, position, and scale, then expand after list starts hiding
        colorExtractorFill.style.setProperty('--fill-color', hex);
        colorExtractorFill.style.setProperty('--fill-x', xPct + '%');
        colorExtractorFill.style.setProperty('--fill-y', yPct + '%');
        colorExtractorFill.style.setProperty('--fill-scale', coverScale);
        colorExtractorFill.classList.remove('expanded');
        // Force reflow to ensure the browser registers the initial scale state
        void colorExtractorFill.offsetWidth;
        // Start fill animation after list starts hiding.
        const timer1 = setTimeout(() => {
          colorExtractorFill.classList.add('expanded');
          // Clean up will-change after animation completes
          const cleanupWillChange = () => {
            colorExtractorFill.style.removeProperty('will-change');
            colorExtractorFill.removeEventListener('transitionend', cleanupWillChange);
          };
          colorExtractorFill.addEventListener('transitionend', cleanupWillChange);
        }, COLOR_EXTRACTOR_FILL_START_DELAY_MS);
        colorExtractorAnimationTimers.push(timer1);

        // After fill animation, show detail view quickly.
        const timer2 = setTimeout(() => {
          renderDetailView(hex, rgbStr, hslStr, color);
          colorExtractorIsAnimating = false;
        }, COLOR_EXTRACTOR_FILL_START_DELAY_MS + COLOR_EXTRACTOR_FILL_MS + 60);
        colorExtractorAnimationTimers.push(timer2);
      }

      function renderDetailView(hex, rgbStr, hslStr, color) {
        if (!colorExtractorDetailCols || !colorExtractorDetailView || !colorExtractorBackDetailBtn) return;
        colorExtractorDetailCols.innerHTML = '';

        // Determine text color based on brightness
        const brightness = (color.r * 299 + color.g * 587 + color.b * 114) / 1000;
        const isLight = brightness > 200;
        const textColor = isLight ? '#1a1a1a' : '#ffffff';

        // Back button color
        colorExtractorBackDetailBtn.classList.toggle('dark-text', isLight);

        const codes = [
          { label: 'HEX', value: hex, desc: t('home.colorExtractor.hexLabel')},
          { label: 'RGB', value: rgbStr, desc: t('home.colorExtractor.rgbLabel')},
          { label: 'HSL', value: hslStr, desc: t('home.colorExtractor.hslLabel')},
        ];

        codes.forEach((code) => {
          const col = document.createElement('div');
          col.className = 'color-extractor-detail-col';
          col.setAttribute('role', 'button');
          col.setAttribute('tabindex', '0');
          col.title = getLang() === 'zh' ? `点击复制 ${code.label}` : `Click to copy ${code.label}`;

          const codeEl = document.createElement('div');
          codeEl.className = 'color-extractor-detail-col-code';
          codeEl.style.color = textColor;
          codeEl.textContent = code.value;
          const copyDetailCode = async () => {
            try {
              await copyColorExtractorText(code.value);
              codeEl.classList.remove('copied');
              void codeEl.offsetWidth;
              codeEl.classList.add('copied');
              showToast(t('home.colorExtractor.copySuccess'));
            } catch (e) {
              console.error('[Color Extractor] Copy failed:', e);
              showToast(t('home.colorExtractor.copyFailed'));
            }
          };
          col.addEventListener('click', copyDetailCode);
          col.addEventListener('keydown', (event) => {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            event.preventDefault();
            copyDetailCode();
          });

          const labelEl = document.createElement('div');
          labelEl.className = 'color-extractor-detail-col-label';
          labelEl.style.color = textColor;
          labelEl.textContent = code.desc;

          col.appendChild(codeEl);
          col.appendChild(labelEl);
          colorExtractorDetailCols.appendChild(col);
        });

        colorExtractorDetailView.classList.add('visible');
      }

      function collapseDetailToCircles() {
        if (colorExtractorIsAnimating) return;
        colorExtractorIsAnimating = true;
        if (colorExtractorDetailView) colorExtractorDetailView.classList.remove('visible');
        if (colorExtractorDetailCols) colorExtractorDetailCols.innerHTML = '';
        // After detail fades, shrink fill, then show circles.
        const timer1 = setTimeout(() => {
          if (colorExtractorFill) colorExtractorFill.classList.remove('expanded');
          // After fill shrinks, show circles with animation.
          const timer2 = setTimeout(() => {
            if (colorExtractorCirclesView) colorExtractorCirclesView.classList.remove('hidden');
            colorExtractorIsAnimating = false;
          }, COLOR_EXTRACTOR_FILL_MS + 80);
          colorExtractorAnimationTimers.push(timer2);
        }, COLOR_EXTRACTOR_DETAIL_FADE_MS);
        colorExtractorAnimationTimers.push(timer1);
      }

      // Event listeners
      if (colorExtractorBack) colorExtractorBack.addEventListener('click', closeColorExtractorOverlay);
      colorExtractorImageModeBtn?.addEventListener('click', () => setColorExtractorMode('image'));
      colorExtractorScreenModeBtn?.addEventListener('click', () => setColorExtractorMode('screen'));
      colorExtractorScreenStartBtn?.addEventListener('click', () => { void openNativeScreenPicker(); });
      colorExtractorScreenCopyBtn?.addEventListener('click', async () => {
        const value = colorExtractorScreenHex?.textContent || '';
        try {
          await copyColorExtractorText(value);
          showToast(t('home.colorExtractor.copySuccess'));
        } catch {
          showToast(t('home.colorExtractor.copyFailed'));
        }
      });
      colorExtractorReplaceBtn?.addEventListener('click', () => colorExtractorFileInput?.click());
      document.querySelectorAll('.color-extractor-v2-detail-code').forEach(button => {
        button.addEventListener('click', async () => {
          const value = button.querySelector('strong')?.textContent?.trim();
          if (!value || value === '—') return;
          try {
            await copyColorExtractorText(value);
            showToast(t('home.colorExtractor.copySuccess'));
          } catch {
            showToast(t('home.colorExtractor.copyFailed'));
          }
        });
      });
      if (!isScreenPickerWindow) void listenForScreenColorResults();

      if (colorExtractorUploadZone) {
        colorExtractorUploadZone.addEventListener('click', () => colorExtractorFileInput?.click());
        colorExtractorUploadZone.addEventListener('dragover', (e) => {
          e.preventDefault();
          colorExtractorUploadZone.classList.add('dragover');
        });
        let dragCounter = 0;
        colorExtractorUploadZone.addEventListener('dragenter', (e) => {
          e.preventDefault();
          dragCounter++;
          colorExtractorUploadZone.classList.add('dragover');
        });
        colorExtractorUploadZone.addEventListener('dragleave', () => {
          dragCounter--;
          if (dragCounter <= 0) {
            dragCounter = 0;
            colorExtractorUploadZone.classList.remove('dragover');
          }
        });
        colorExtractorUploadZone.addEventListener('drop', (e) => {
          e.preventDefault();
          colorExtractorUploadZone.classList.remove('dragover');
          dragCounter = 0;
          const file = e.dataTransfer?.files?.[0];
          if (file) handleColorExtractorFile(file);
        });
      }

      if (isTauri && colorExtractorOverlay) {
        (async () => {
          const { getCurrentWebview } = await import('@tauri-apps/api/webview');
          const webview = getCurrentWebview();
          await webview.onDragDropEvent((event) => {
            if (!colorExtractorOverlay.classList.contains('visible')) return;
            const payload = event.payload;
            if (payload.type === 'enter' || payload.type === 'over') {
              colorExtractorUploadZone?.classList.add('dragover');
            } else if (payload.type === 'leave') {
              colorExtractorUploadZone?.classList.remove('dragover');
            } else if (payload.type === 'drop') {
              colorExtractorUploadZone?.classList.remove('dragover');
              const paths = payload.paths || [];
              const imagePath = paths.find(path => /\.(png|jpe?g|webp)$/i.test(path));
              if (!imagePath) {
                showToast(t('home.colorExtractor.unsupportedFormat'));
                return;
              }
              handleColorExtractorFile({
                name: imagePath.split(/[\\/]/).pop() || imagePath,
                path: imagePath,
                size: 0,
                type: /\.(png)$/i.test(imagePath)
                  ? 'image/png'
                  : (/\.(webp)$/i.test(imagePath) ? 'image/webp' : 'image/jpeg')
              });
            }
          });
        })().catch(error => console.error('Cannot register color extractor drag and drop:', error));
      }

      if (colorExtractorFileInput) {
        colorExtractorFileInput.addEventListener('change', (e) => {
          const file = e.target.files?.[0];
          if (file) handleColorExtractorFile(file);
        });
      }

      // ===== End Color Extractor Tool =====

      // The full-screen picker is bootstrapped by bootstrapScreenPickerOverlay()
      // (scheduled earlier), which owns the drag-to-pick interaction now.

      // Tool list entry
      document.querySelectorAll('.audio-list-item[data-tool="color-extractor"]').forEach(item => {
        item.addEventListener('click', openColorExtractorOverlay);
        item.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openColorExtractorOverlay(); }
        });
      });


      // ===== Favorites System =====
      const FAV_KEY = 'toolknit_favorites';
      const MAX_FAVORITES = 6;
      const toastEl = document.getElementById('favToast');
      const toastText = document.getElementById('favToastText');
      const manageFavoritesBtn = document.getElementById('manageFavorites');
      let toastTimer = null;
      let favoritesManageMode = false;

      function showFavoriteToast(msg) {
        if (!toastEl || !toastText) return;
        toastText.textContent = msg;
        toastEl.classList.add('visible');
        if (toastTimer) clearTimeout(toastTimer);
        toastTimer = setTimeout(() => {
          toastEl.classList.remove('visible');
        }, 3600);
      }

      function getFavorites() {
        try {
          const favorites = JSON.parse(localStorage.getItem(FAV_KEY) || '[]');
          return Array.isArray(favorites) ? favorites.slice(0, MAX_FAVORITES) : [];
        } catch { return []; }
      }

      function saveFavorites(favs) {
        localStorage.setItem(FAV_KEY, JSON.stringify(favs.slice(0, MAX_FAVORITES)));
      }

      function isFavorited(toolId) {
        return getFavorites().some(f => f.tool === toolId);
      }

      function addFavorite(toolId, name, iconHtml, category, desc = '') {
        if (isFavorited(toolId)) return false;
        const favs = getFavorites();
        if (favs.length >= MAX_FAVORITES) {
          showFavoriteToast(t('home.favLimit'));
          return false;
        }
        favs.push({ tool: toolId, name, desc, iconHtml, category, ts: Date.now() });
        saveFavorites(favs);
        renderFavorites();
        return true;
      }

      function removeFavorite(toolId) {
        const favs = getFavorites().filter(f => f.tool !== toolId);
        saveFavorites(favs);
        renderFavorites();
      }

      function favoriteToolFromInfo(info) {
        if (!info?.toolId) return false;
        if (isFavorited(info.toolId)) {
          showFavoriteToast(t('home.favAlready'));
          return false;
        }
        if (addFavorite(info.toolId, info.name, info.iconHtml, info.category, info.desc)) {
          showFavoriteToast(t('home.favAdded'));
          return true;
        }
        return false;
      }

      function getToolInfo(item) {
        const toolId = item.dataset.tool || '';
        const titleEl = item.querySelector('.audio-list-title');
        const name = titleEl ? titleEl.textContent : (item.dataset.tool || 'Tool');
        const descEl = item.querySelector('.audio-list-desc');
        const desc = descEl ? descEl.textContent : '';
        const iconEl = item.querySelector('.audio-list-icon');
        let iconHtml = '';
        if (iconEl) {
          iconHtml = iconEl.innerHTML;
        }
        const section = item.closest('.content-section');
        const category = section ? section.dataset.category : '';
        return { toolId, name, desc, iconHtml, category };
      }

      function currentToolCategory(toolId, fallback = '') {
        const item = Array.from(document.querySelectorAll('.content-section:not([data-category="home"]) .audio-list-item'))
          .find(candidate => candidate.dataset.tool === toolId);
        return item?.closest('.content-section')?.dataset.category || fallback;
      }

      function resolveHomeToolInfo(record) {
        const toolId = record?.tool || '';
        const item = Array.from(document.querySelectorAll('.content-section:not([data-category="home"]) .audio-list-item'))
          .find(candidate => candidate.dataset.tool === toolId);
        if (item) return getToolInfo(item);
        return {
          toolId,
          name: record?.name || toolId || t('common.tool'),
          desc: record?.desc || '',
          iconHtml: '',
          category: record?.category || ''
        };
      }

      function seedDefaultFavorites() {
        if (localStorage.getItem(FAV_KEY) !== null) return;

        const candidates = Array.from(document.querySelectorAll('.content-section:not([data-category="home"]) .audio-list-item'))
          .filter(item => item.dataset.availability !== 'planned');
        const preferredIds = ['pdf-enhance', 'ppt-draft', 'video-gif', 'ai-doc', 'hardware-cpu-memory', 'pdf-merge'];
        const preferred = preferredIds
          .map(toolId => candidates.find(item => item.dataset.tool === toolId))
          .filter(Boolean);
        const defaults = [...preferred, ...candidates.filter(item => !preferred.includes(item))]
          .slice(0, MAX_FAVORITES)
          .map(item => {
            const info = getToolInfo(item);
            return { tool: info.toolId, name: info.name, desc: info.desc, iconHtml: info.iconHtml, category: info.category, ts: Date.now() };
          });

        if (defaults.length > 0) saveFavorites(defaults);
      }

      document.querySelectorAll('.audio-list-item').forEach(item => {
        item.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          if (item.dataset.availability === 'planned') return;
          const info = getToolInfo(item);
          favoriteToolFromInfo(info);
        });
      });

      function syncFavoritesManageState() {
        const container = document.getElementById('favoritesContent');
        container?.classList.toggle('is-managing', favoritesManageMode);
        container?.querySelectorAll('[data-remove-favorite]').forEach(button => {
          button.tabIndex = favoritesManageMode ? 0 : -1;
          button.setAttribute('aria-hidden', String(!favoritesManageMode));
        });
        manageFavoritesBtn?.classList.toggle('is-active', favoritesManageMode);
        manageFavoritesBtn?.setAttribute('aria-pressed', String(favoritesManageMode));
      }

      function setFavoritesManageMode(enabled) {
        favoritesManageMode = Boolean(enabled);
        syncFavoritesManageState();
      }

      // Render favorites card on home
      function renderFavorites() {
        const container = document.getElementById('favoritesContent');
        if (!container) return;
        syncFavoritesManageState();

        const favs = getFavorites();
        if (favs.length === 0) {
          container.innerHTML = `
            <div class="fav-empty-guide">
              <div class="fav-empty-icon"><i data-lucide="mouse-pointer-click"></i></div>
              <div class="fav-empty-text">${escapeHtml(t('home.favEmptyGuide'))}</div>
            </div>
          `;
          if (typeof createIcons === 'function') createIcons({ icons });
          return;
        }

        container.innerHTML = favs.map(f => {
          const info = resolveHomeToolInfo(f);
          const removeLabel = t('home.favRemove');
          return `
           <article class="favorite-item" role="button" tabindex="0" data-tool="${escapeHtml(info.toolId)}" data-category="${escapeHtml(info.category || '')}">
            <span class="card-water-layer" aria-hidden="true"><span class="card-water-ripple"></span></span>
            <span class="favorite-top">
              <span class="favorite-icon">${info.iconHtml}</span>
              <span class="favorite-category">${escapeHtml(getHomeCategoryTag(info.category))}</span>
            </span>
            <span class="favorite-copy">
              <span class="favorite-name">${escapeHtml(info.name)}</span>
              <span class="favorite-desc">${escapeHtml(info.desc || '')}</span>
            </span>
            <button class="favorite-remove-btn" type="button" data-remove-favorite="${escapeHtml(info.toolId)}" aria-label="${escapeHtml(removeLabel)}" title="${escapeHtml(removeLabel)}">
              <i data-lucide="x"></i>
            </button>
          </article>
        `;
        }).join('');

        if (typeof createIcons === 'function') createIcons({ icons });
        syncFavoritesManageState();

        container.querySelectorAll('.favorite-item').forEach(el => {
          el.addEventListener('click', (e) => {
            const toolId = el.dataset.tool;
            launchToolFromHome(toolId);
          });
          el.addEventListener('keydown', event => {
            if (event.target.closest?.('[data-remove-favorite]')) return;
            if (event.key !== 'Enter' && event.key !== ' ') return;
            event.preventDefault();
            launchToolFromHome(el.dataset.tool);
          });
        });

        container.querySelectorAll('[data-remove-favorite]').forEach(button => {
          button.addEventListener('click', event => {
            event.preventDefault();
            event.stopPropagation();
            const toolId = button.dataset.removeFavorite;
            removeFavorite(toolId);
            showFavoriteToast(t('home.favRemoved'));
            document.querySelectorAll('[data-home-tool]').forEach(card => {
              if (card.dataset.homeTool === toolId) card.classList.remove('is-favorited');
            });
          });
        });
      }

      manageFavoritesBtn?.addEventListener('click', () => {
        setFavoritesManageMode(!favoritesManageMode);
        if (!getFavorites().length) showFavoriteToast(t('home.favEmptyGuide'));
      });

      // Initial render
      seedDefaultFavorites();
      renderFavorites();

      // Re-render on language change
      onLangChange(() => {
        renderFavorites();
      });

      // ===== Lazy feature tools (2.1) =====
      let mattingManagerRenderQueued = false;
      let mattingDownloadSource = 'auto';
      const mattingManagerDownloads = new Map();
      let mattingDownloadPromise = null;
      if (isTauri) {
        void tauriEventPromise
          .then(({ listen }) => listen('matting-model-progress', event => {
            const payload = event?.payload || {};
            if (payload.model_id) {
              mattingManagerDownloads.set(payload.model_id, payload.total_bytes ? Math.round(payload.downloaded_bytes / payload.total_bytes * 100) : 0);
              queueMattingManagerRender();
            }
          }))
          .catch(error => console.error('Cannot listen for matting model progress:', error));
      }

      function settingsOverlayVisible() {
        return Boolean(settingsOverlay?.classList.contains('visible'));
      }

      function queueMattingManagerRender() {
        if (mattingManagerRenderQueued) return;
        mattingManagerRenderQueued = true;
        requestAnimationFrame(() => {
          mattingManagerRenderQueued = false;
          void renderMattingModelManager();
        });
      }

      async function installMattingModel(source = 'auto') {
        if (mattingDownloadPromise) return mattingDownloadPromise;
        const operation = (async () => {
          const { invoke } = await tauriCorePromise;
          await invoke('download_matting_model', { modelId: 'modnet', source });
          await invoke('set_current_matting_model', { modelId: 'modnet' });
        })();
        mattingDownloadPromise = operation;
        mattingManagerDownloads.set('modnet', 0);
        queueMattingManagerRender();
        try {
          await operation;
        } finally {
          if (mattingDownloadPromise === operation) mattingDownloadPromise = null;
          mattingManagerDownloads.delete('modnet');
          document.dispatchEvent(new CustomEvent('toolknit:matting-models-changed'));
          queueMattingManagerRender();
        }
      }

      function openMattingModelManager() {
        openSettingsOverlay();
        const overlayEl = document.getElementById('mattingModelOverlay');
        overlayEl?.classList.add('visible');
        overlayEl?.setAttribute('aria-hidden', 'false');
        queueMattingManagerRender();
        if (window.lucide) window.lucide.createIcons();
      }

      function closeMattingModelManager() {
        const overlayEl = document.getElementById('mattingModelOverlay');
        overlayEl?.classList.remove('visible');
        overlayEl?.setAttribute('aria-hidden', 'true');
      }

      function wireMattingModelManager() {
        const manageButton = document.getElementById('manageMattingModelsBtn');
        manageButton?.addEventListener('click', () => openMattingModelManager());
        document.getElementById('mattingModelClose')?.addEventListener('click', () => closeMattingModelManager());
        const overlayEl = document.getElementById('mattingModelOverlay');
        overlayEl?.addEventListener('click', event => {
          if (event.target === overlayEl) closeMattingModelManager();
        });
        document.getElementById('mattingModelOverlay')?.addEventListener('keydown', event => {
          if (event.key === 'Escape') closeMattingModelManager();
        });
        document.querySelectorAll('#mattingSourceOptions .audio-convert-format-option').forEach(option => {
          option.addEventListener('click', () => {
            document.querySelectorAll('#mattingSourceOptions .audio-convert-format-option').forEach(item => item.classList.remove('active'));
            option.classList.add('active');
            mattingDownloadSource = option.dataset.source || 'auto';
          });
        });
        manageButton && renderMattingModelStatus();
      }
      wireMattingModelManager();

      async function renderMattingModelStatus() {
        const status = document.getElementById('mattingModelStatus');
        if (!status || !isTauri) return;
        try {
          const { invoke } = await tauriCorePromise;
          const models = await invoke('list_matting_models');
          const current = models.find(model => model.current && model.installed);
          status.textContent = current
            ? t('settings.mattingStatusCurrent', { name: current.display_name })
            : t('settings.mattingStatusNone');
        } catch (error) {
          status.textContent = t('settings.mattingStatusNone');
        }
      }

      async function renderMattingModelManager() {
        const list = document.getElementById('mattingModelList');
        if (!list) return;
        try {
          const { invoke } = await tauriCorePromise;
          const models = await invoke('list_matting_models');
          list.replaceChildren();
          models.forEach(model => {
            const row = document.createElement('div');
            row.className = 'transcription-model-row';
            const info = document.createElement('div');
            const name = document.createElement('div');
            name.className = 'transcription-model-name';
            name.textContent = model.display_name;
            const meta = document.createElement('div');
            meta.className = 'transcription-model-meta';
            const progress = mattingManagerDownloads.get(model.id);
            meta.textContent = progress !== undefined
              ? progress + '%'
              : Math.round(model.bytes / 1024 / 1024) + ' MB';
            info.append(name, meta);
            const actions = document.createElement('div');
            actions.className = 'transcription-model-actions';
            const makeButton = (label, handler) => {
              const button = document.createElement('button');
              button.type = 'button';
              button.className = 'settings-btn';
              button.textContent = label;
              button.addEventListener('click', async () => {
                if (button.disabled) return;
                button.disabled = true;
                try {
                  await handler();
                } catch (error) {
                  console.error('[BgRemoval] matting model action failed:', error);
                  window.showToast?.(t('settings.mattingActionFailed'));
                } finally {
                  button.disabled = false;
                  queueMattingManagerRender();
                }
              });
              return button;
            };
            const done = () => {
              document.dispatchEvent(new CustomEvent('toolknit:matting-models-changed'));
              void renderMattingModelManager();
            };
            if (progress !== undefined) {
              const status = document.createElement('span');
              status.className = 'transcription-model-current';
              status.textContent = progress + '%';
              actions.append(status);
            } else if (model.installed) {
              if (!model.current) {
                actions.append(makeButton(t('home.transcription.useModel'), async () => {
                  await invoke('set_current_matting_model', { modelId: model.id });
                  done();
                }));
              }
              actions.append(makeButton(t('home.transcription.deleteModel'), async () => {
                await invoke('delete_matting_model', { modelId: model.id });
                done();
              }));
            } else {
              actions.append(makeButton(t('settings.mattingDownload'), async () => {
                await installMattingModel(mattingDownloadSource);
                done();
              }));
            }
            row.append(info, actions);
            list.append(row);
          });
          await renderMattingModelStatus();
        } catch (error) {
          console.error('[BgRemoval] matting manager render failed:', error);
        }
      }

      async function requestMattingModelGate(onReady) {
        if (!isTauri) return true;
        let installed = false;
        try {
          const { invoke } = await tauriCorePromise;
          const models = await invoke('list_matting_models');
          installed = Array.isArray(models) && models.some(model => model.installed);
        } catch (error) {
          console.error('[BgRemoval] model check failed:', error);
        }
        if (installed) {
          return true;
        }
        showDependencyGate({
          openFn: async () => {
            try {
              const { invoke } = await tauriCorePromise;
              const models = await invoke('list_matting_models');
              if (Array.isArray(models) && models.some(model => model.installed)) await onReady?.();
            } catch (error) {
              console.error('[BgRemoval] gate reopen failed:', error);
            }
          },
          needsFfmpeg: false,
          needsModel: true,
          modelKind: 'matting',
          modelLabel: 'MODNet 人像精修',
          modelSizeText: '24.7 MB'
        });
        if (mattingDownloadPromise) void installDependencyGateRequirements();
        return false;
      }

      async function requestTeleprompterOfflineModel(onReady) {
        if (!isTauri) {
          window.showToast?.(t('home.teleprompter.desktopOnly'));
          return false;
        }
        await refreshTranscriptionModels();
        if (activeTranscriptionModel()) return true;
        showDependencyGate({
          openFn: async () => {
            await refreshTranscriptionModels();
            await onReady?.();
          },
          needsFfmpeg: false,
          needsModel: true,
          needsLibreOffice: false
        });
        return false;
      }

      const isAiDocEditorDemoEntry = import.meta.env.DEV
        && new URLSearchParams(window.location.search).get('ai-doc-editor-demo') === '1';
      const isAiTableDemoEntry = import.meta.env.DEV
        && new URLSearchParams(window.location.search).get('ai-table-demo') === '1';
      const lazyFeatureRegistry = createLazyToolRegistry({
        specs: LAZY_TOOL_SPECS,
        root: document,
        beforeOpen: async (toolId, retryOpen) => {
          if (toolId === 'ai-polish' || toolId === 'ai-translate'
            || toolId === 'ai-doc' || toolId === 'ai-table') {
            if ((toolId === 'ai-doc' && isAiDocEditorDemoEntry)
              || (toolId === 'ai-table' && isAiTableDemoEntry)) return true;
            await aiApiKeyReady;
            if (!hasAiApiKey()) {
              showAiKeyRequiredOverlay();
              return false;
            }
          }
          if ((toolId === 'teleprompter' || toolId === 'bg-removal') && isTauri) {
            // AI tools that depend on on-demand models gate at the home card:
            // no model, no tool page (dependencies install, then entry resumes).
            const ready = toolId === 'teleprompter'
              ? await requestTeleprompterOfflineModel(() => {
                  void retryOpen();
                })
              : await requestMattingModelGate(() => {
                  void retryOpen();
                });
            return ready;
          }
          return true;
        },
        createContext: () => ({
          notify: (message, options) => window.showToast?.(message, options),
          isTauri,
          t,
          onLangChange,
          pdfWorkerUrl,
          readTextDocument: readTextStatsDocument,
          formatFileSize,
          displayFilesystemPath,
           requestOfflineModel: requestTeleprompterOfflineModel,
           requestAi: callDeepSeek,
           getAiApiKey,
           extractJson,
          refreshIcons: () => createIcons({ icons }),
          openHelp: openHelpOverlay,
          initStandardToolPlasma,
          disposeStandardToolPlasma,
          getOutputDir,
          ensureFfmpegAvailable,
          openOutputFolder,
          ensureLibreOfficeAvailable: ensurePptRuntimeAvailable,
          checkLibreOfficeAvailable: checkLibreOfficeRuntimeAvailable,
          requestLibreOfficeRuntime: openFn => showDependencyGate({ openFn, needsFfmpeg: false, needsModel: false, needsLibreOffice: true }),
          openLazyTool: toolId => lazyFeatureRegistry.open(toolId),
          openSettings: openSettingsOverlay,
          openMattingModelManager,
          openSupport: openDonationOverlay,
          openExternalUrl,
          handleWindowAction: handleWindowControlAction
        }),
        onError: (error, toolId) => {
          console.error(`Cannot open ${toolId}:`, error);
          window.showToast?.(getLang() === 'zh' ? `工具加载失败：${String(error?.message || error)}` : `Failed to load tool: ${String(error?.message || error)}`);
        }
      });
      lazyFeatureRegistry.bind();
      if (isAiDocEditorDemoEntry) void lazyFeatureRegistry.open('ai-doc');
      if (isAiTableDemoEntry) void lazyFeatureRegistry.open('ai-table');

      updatePreviewController = initUpdatePreview({
        openExternalUrl,
        notify: message => window.showToast?.(message),
        refreshBackgroundRendering: syncHomeV2Background,
        refreshIcons: () => createIcons({ icons }),
        onUpdate: async release => {
          // The updater public key is not configured yet. Keep the current
          // release action honest: it opens the verified GitHub Release where
          // the installer and its SHA-256 checksum are published together.
          await openExternalUrl(release.htmlUrl || UPDATE_RELEASES_PAGE);
        },
        onDefer: release => updateService.defer(release.version)
      });

      function scheduleAutomaticUpdateCheck() {
        if (!isTauri) return;
        const checkWhenIdle = () => {
          if (document.hidden || !appRoot?.classList.contains('is-v2-home')) return;
          void runVersionUpdateCheck({ force: false, showUpdate: false }).then(result => {
            if (!result) return;
            void getLocalAppVersion().then(localVersion => {
              if (updateService.shouldPrompt(result, localVersion)) {
                updatePreviewController?.open({ ...result.release, currentVersion: localVersion });
              }
            });
          });
        };
        window.setTimeout(() => {
          if ('requestIdleCallback' in window) {
            window.requestIdleCallback(checkWhenIdle, { timeout: 3_000 });
          } else {
            checkWhenIdle();
          }
        }, 5_000);
      }

scheduleAutomaticUpdateCheck();
