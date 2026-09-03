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
      import { escapeHtml, escapeAttr } from './shared/html.js';
      import { HELP_CONTENT, getHelpContent } from './help-data.js';
      import { SUPPORT_JOURNAL_ENTRIES } from './support-journal-data.js';
      import { getLegalContent } from './legal-data.js';
      import { AiProviderError, normalizeAiProviderConfig, requestAiCompletion } from './ai-provider-core.js';
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
        setTimeout(() => {
          import('./features/color-extractor/screen-picker.js')
            .then(({ bootstrapScreenPickerOverlay }) => bootstrapScreenPickerOverlay())
            .catch(error => console.error('[screen-picker] bootstrap failed:', error));
        }, 0);
      }
      let nativeWindowRadiusQueue = Promise.resolve();
      let nativeWindowChromeRepairQueue = Promise.resolve();

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
        // Lazy tools own their lifecycle in the registry. Calling it directly
        // avoids relying on a hidden category item to replay a click event.
        if (LAZY_TOOL_SPECS[toolId]) {
          void lazyFeatureRegistry.open(toolId);
          return;
        }
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

      // PPT image extraction is mounted by the lazy feature registry.



      // Cleanup tools are mounted by the lazy feature registry.

      // Audio Convert is mounted by the lazy feature registry.


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
            document.dispatchEvent(new Event('toolknit:ai-key-change'));
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
            document.dispatchEvent(new Event('toolknit:ai-key-change'));
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
          if ((toolId === 'audio-extract' || toolId === 'convert' || toolId === 'audio-clip'
            || toolId === 'video-convert' || toolId === 'video-frame' || toolId === 'video-gif') && isTauri) {
            const ready = await ensureFfmpegAvailable();
            if (!ready) {
              showDependencyGate({
                openFn: retryOpen,
                needsFfmpeg: true,
                needsModel: false,
                needsLibreOffice: false
              });
              return false;
            }
          }
          return true;
        },
        createContext: () => ({
          notify: (message, options) => window.showToast?.(message, options),
          isTauri,
          t,
          getLang,
          onLangChange,
          pdfWorkerUrl,
          readTextDocument: readTextStatsDocument,
          formatFileSize,
          displayFilesystemPath,
           requestOfflineModel: requestTeleprompterOfflineModel,
           requestAi: callDeepSeek,
           getAiApiKey,
           requestAiKeyConfiguration: showAiKeyRequiredOverlay,
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
          syncWindowFrameAfterLayoutChange,
          handleWindowAction: handleWindowControlAction
        }),
        onError: (error, toolId) => {
          console.error(`Cannot open ${toolId}:`, error);
          window.showToast?.(getLang() === 'zh' ? `工具加载失败：${String(error?.message || error)}` : `Failed to load tool: ${String(error?.message || error)}`);
        }
      });
      lazyFeatureRegistry.bind();
      // Keep the global screen-picker shortcut available before the color
      // feature is opened for the first time. The heavy picker UI remains
      // lazy, while the sampled payload is replayed after the feature mounts.
      if (isTauri && !isScreenPickerWindow) {
        void tauriEventPromise.then(({ listen }) => listen('screen-color-picked', event => {
          if (lazyFeatureRegistry.activeToolId === 'color-extractor') return;
          const payload = event?.payload;
          void lazyFeatureRegistry.open('color-extractor').then(() => {
            window.dispatchEvent(new CustomEvent('toolknit:screen-color-picked', { detail: payload }));
          });
        })).then(unlisten => {
          window.addEventListener('pagehide', () => unlisten?.(), { once: true });
        }).catch(error => console.warn('[screen-picker] bridge listener failed:', error));
      }
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
