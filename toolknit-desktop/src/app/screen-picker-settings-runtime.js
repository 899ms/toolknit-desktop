import { createLifecycleScope } from './tool-lifecycle.js';

const DEFAULT_SHORTCUT = 'Ctrl+Shift+C';

function keyToken(event) {
  const code = event?.code || '';
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code;
  return '';
}

function shortcutFromEvent(event) {
  const modifiers = [];
  if (event?.ctrlKey) modifiers.push('Ctrl');
  if (event?.altKey) modifiers.push('Alt');
  if (event?.shiftKey) modifiers.push('Shift');
  if (event?.metaKey) modifiers.push('Super');
  const key = keyToken(event);
  if (!key || key === 'Escape') return '';
  return [...modifiers, key].join('+');
}

/** Owns the settings UI and native shortcut recording lifecycle. */
export function createScreenPickerSettingsRuntime({
  root = globalThis.document,
  windowRef = globalThis.window,
  isTauri = false,
  tauriCorePromise,
  translate = key => key,
  getLanguage = () => 'zh',
  showToast = () => {},
  onLanguageChange = () => () => {}
} = {}) {
  const button = root?.getElementById?.('screenPickerShortcutBtn');
  const label = root?.getElementById?.('screenPickerShortcutLabel');
  const resetButton = root?.getElementById?.('screenPickerShortcutReset');
  const scope = createLifecycleScope({ onError: error => console.error('[screen-picker-settings] dispose failed:', error) });
  let recording = false;
  let keyHandler = null;
  let keyHandlerRelease = null;

  function setLabel(value) {
    if (label) label.textContent = value || DEFAULT_SHORTCUT;
  }

  async function refresh() {
    if (!label) return;
    if (!isTauri) {
      setLabel(DEFAULT_SHORTCUT);
      return;
    }
    try {
      const { invoke } = await tauriCorePromise;
      const info = await invoke('get_screen_picker_shortcut');
      setLabel(info?.value || info?.default || DEFAULT_SHORTCUT);
    } catch (error) {
      console.error('Cannot read screen picker shortcut:', error);
      setLabel(DEFAULT_SHORTCUT);
    }
  }

  function stopRecording() {
    recording = false;
    keyHandlerRelease?.();
    keyHandlerRelease = null;
    if (keyHandler) {
      windowRef?.removeEventListener?.('keydown', keyHandler, true);
      keyHandler = null;
    }
    button?.classList.remove('is-recording');
  }

  async function handleRecordedKey(event) {
    if (event.key === 'Escape') {
      event.preventDefault();
      stopRecording();
      await refresh();
      return;
    }
    const next = shortcutFromEvent(event);
    if (!next) return;
    event.preventDefault();
    event.stopPropagation();
    stopRecording();
    try {
      const { invoke } = await tauriCorePromise;
      await invoke('set_screen_picker_shortcut', { shortcut: next });
      await refresh();
      showToast(translate('settings.screenPickerShortcutSaved'));
    } catch (error) {
      await refresh();
      showToast(String(error?.message || error) || translate('settings.screenPickerShortcutInvalid'));
    }
  }

  function startRecording() {
    recording = true;
    button?.classList.add('is-recording');
    if (label) label.textContent = translate('settings.screenPickerShortcutRecording');
    keyHandler = event => { void handleRecordedKey(event); };
    keyHandlerRelease = scope.event(windowRef, 'keydown', keyHandler, true);
  }

  if (button) {
    scope.event(button, 'click', async () => {
      if (!isTauri) {
        showToast(getLanguage() === 'zh' ? '屏幕取色快捷键仅支持桌面版。' : 'Screen picker shortcut is desktop-only.');
        return;
      }
      if (recording) {
        stopRecording();
        await refresh();
        return;
      }
      startRecording();
    });
  }

  if (resetButton) {
    scope.event(resetButton, 'click', async () => {
      if (!isTauri) return;
      try {
        const { invoke } = await tauriCorePromise;
        const info = await invoke('get_screen_picker_shortcut');
        await invoke('set_screen_picker_shortcut', { shortcut: info?.default || DEFAULT_SHORTCUT });
        stopRecording();
        await refresh();
        showToast(translate('settings.screenPickerShortcutResetDone'));
      } catch (error) {
        showToast(String(error?.message || error));
      }
    });
  }

  scope.use(onLanguageChange(() => {
    if (!recording) void refresh();
  }));
  if (windowRef) {
    scope.event(windowRef, 'pagehide', () => {
      stopRecording();
      scope.dispose();
    }, { once: true });
  }
  void refresh();

  return Object.freeze({
    refresh,
    stopRecording,
    dispose() {
      stopRecording();
      scope.dispose();
    }
  });
}
