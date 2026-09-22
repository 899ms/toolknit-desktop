import { createLifecycleScope } from './tool-lifecycle.js';

const CUSTOM_FONT_DEFAULTS = Object.freeze({
  'cn-medium': Object.freeze({ family: 'ToolKnitRuntimeCn', weight: '100 500', path: '/assets/fonts/Alibaba-PuHuiTi-Medium.ttf', name: 'Alibaba PuHuiTi Medium' }),
  'cn-bold': Object.freeze({ family: 'ToolKnitRuntimeCn', weight: '600 900', path: '/assets/fonts/Alibaba-PuHuiTi-Bold.ttf', name: 'Alibaba PuHuiTi Bold' }),
  'en-regular': Object.freeze({ family: 'ToolKnitRuntimeEn', weight: '100 500', path: '/assets/fonts/Montserrat-Regular.otf', name: 'Montserrat Regular' }),
  'en-bold': Object.freeze({ family: 'ToolKnitRuntimeEn', weight: '600 900', path: '/assets/fonts/Montserrat-Bold.otf', name: 'Montserrat Bold' })
});

/** Owns local interface font assets and FontFace lifecycle. */
export function createFontSettingsRuntime({
  root = globalThis.document,
  windowRef = globalThis.window,
  isTauri = false,
  tauriCorePromise,
  normalizeDesktopBytes,
  translate = key => key,
  onError = error => console.warn('Font settings runtime:', error)
} = {}) {
  const scope = createLifecycleScope({ onError });
  const bindEvent = (target, type, listener, options) => target?.addEventListener
    ? scope.event(target, type, listener, options)
    : () => {};
  const customFontSlots = [...(root?.querySelectorAll?.('[data-font-slot]') || [])];
  const customFontAssets = new Map();
  let customFontMetadataParserPromise = null;
  let activeRuntimeFontFaces = [];
  let customFontBusySlot = '';

  const setInterfaceFontFamilies = useRuntimeFonts => {
    const html = root?.documentElement;
    if (!html?.style?.setProperty) return;
    html.style.setProperty('--tk-font-ui-cn', useRuntimeFonts ? "'ToolKnitRuntimeCn'" : "'ToolKnitBuiltinCn'");
    html.style.setProperty('--tk-font-display-cn', useRuntimeFonts ? "'ToolKnitRuntimeCnHeading'" : "'ToolKnitBuiltinCnHeading'");
    html.style.setProperty('--tk-font-ui-en', useRuntimeFonts ? "'ToolKnitRuntimeEn'" : "'ToolKnitBuiltinEn'");
    html.style.setProperty('--tk-font-display-en', useRuntimeFonts
      ? "'ToolKnitRuntimeEnHeading', 'ToolKnitRuntimeCnHeading'"
      : "'ToolKnitBuiltinEnHeading', 'ToolKnitBuiltinCnHeading'");
  };

  const renderCustomFontSlots = () => {
    customFontSlots.forEach(slotElement => {
      const slot = slotElement.dataset.fontSlot;
      const asset = customFontAssets.get(slot);
      const summary = slotElement.querySelector?.('[data-font-slot-summary]');
      const upload = slotElement.querySelector?.('[data-font-upload]');
      const reset = slotElement.querySelector?.('[data-font-reset]');
      const busy = customFontBusySlot === slot;
      if (summary) summary.textContent = asset?.displayName || asset?.fileName || CUSTOM_FONT_DEFAULTS[slot]?.name || '';
      slotElement.classList?.toggle('is-custom', Boolean(asset));
      slotElement.classList?.toggle('is-busy', busy);
      if (upload) upload.disabled = Boolean(customFontBusySlot);
      if (reset) reset.disabled = Boolean(customFontBusySlot) || !asset;
    });
  };

  const removeRuntimeFontFaces = () => {
    activeRuntimeFontFaces.forEach(face => {
      try { root?.fonts?.delete?.(face); } catch {}
    });
    activeRuntimeFontFaces = [];
  };

  const resolveCustomFontSource = async asset => {
    if (!asset?.path) return '';
    const { convertFileSrc } = await tauriCorePromise;
    return convertFileSrc(asset.path);
  };

  const enrichCustomFontAsset = async (asset, invoke) => {
    if (!asset?.path || typeof invoke !== 'function') return asset;
    try {
      if (!customFontMetadataParserPromise) {
        customFontMetadataParserPromise = import('../font-metadata.js').then(module => module.default || module.parseFontMetadata);
      }
      const parseFontMetadata = await customFontMetadataParserPromise;
      if (typeof parseFontMetadata !== 'function') return asset;
      const rawBytes = await invoke('read_file_bytes_limited', { path: asset.path, maxBytes: 40 * 1024 * 1024 });
      const metadata = await parseFontMetadata(normalizeDesktopBytes(rawBytes));
      return metadata?.displayName ? { ...asset, ...metadata } : asset;
    } catch (error) {
      onError(error);
      return asset;
    }
  };

  const applyCustomInterfaceFonts = async (fontAssets = customFontAssets) => {
    if (!fontAssets.size) {
      removeRuntimeFontFaces();
      setInterfaceFontFamilies(false);
      windowRef?.dispatchEvent?.(new Event('toolknit-interface-font-change'));
      return;
    }
    if (typeof FontFace === 'undefined') throw new Error('FontFace is unavailable');
    const loadedFaces = [];
    for (const [slot, defaults] of Object.entries(CUSTOM_FONT_DEFAULTS)) {
      const source = fontAssets.has(slot) ? await resolveCustomFontSource(fontAssets.get(slot)) : defaults.path;
      if (!source) throw new Error('Custom font source is unavailable');
      const face = new FontFace(defaults.family, `url(${JSON.stringify(source)})`, { style: 'normal', weight: defaults.weight, display: 'swap' });
      await face.load();
      loadedFaces.push(face);
    }
    for (const slot of ['cn-bold', 'en-bold']) {
      const defaults = CUSTOM_FONT_DEFAULTS[slot];
      const source = fontAssets.has(slot) ? await resolveCustomFontSource(fontAssets.get(slot)) : defaults.path;
      const face = new FontFace(slot === 'cn-bold' ? 'ToolKnitRuntimeCnHeading' : 'ToolKnitRuntimeEnHeading', `url(${JSON.stringify(source)})`, { style: 'normal', weight: '100 900', display: 'swap' });
      await face.load();
      loadedFaces.push(face);
    }
    removeRuntimeFontFaces();
    loadedFaces.forEach(face => root?.fonts?.add?.(face));
    activeRuntimeFontFaces = loadedFaces;
    setInterfaceFontFamilies(true);
    await (root?.fonts?.ready || Promise.resolve());
    windowRef?.dispatchEvent?.(new Event('toolknit-interface-font-change'));
  };

  const refreshCustomFonts = async () => {
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
  };

  const chooseCustomFont = async slot => {
    if (!CUSTOM_FONT_DEFAULTS[slot] || customFontBusySlot) return;
    if (!isTauri) { windowRef?.showToast?.(translate('settings.fontDesktopOnly')); return; }
    customFontBusySlot = slot;
    renderCustomFontSlots();
    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const selected = await open({ multiple: false, directory: false, title: translate('settings.fontUpload'), filters: [{ name: 'Font', extensions: ['ttf', 'otf', 'woff', 'woff2'] }] });
      if (!selected || Array.isArray(selected)) return;
      const { invoke } = await tauriCorePromise;
      await invoke('import_custom_font', { slot, sourcePath: selected });
      await refreshCustomFonts();
      windowRef?.showToast?.(translate('settings.fontUploadSuccess'));
    } catch (error) {
      onError(error);
      windowRef?.showToast?.(translate('settings.fontUploadFailed'));
    } finally { customFontBusySlot = ''; renderCustomFontSlots(); }
  };

  const restoreDefaultFont = async slot => {
    if (!customFontAssets.has(slot) || customFontBusySlot) return;
    customFontBusySlot = slot;
    renderCustomFontSlots();
    try {
      const { invoke } = await tauriCorePromise;
      await invoke('reset_custom_font', { slot });
      await refreshCustomFonts();
      windowRef?.showToast?.(translate('settings.fontRestoreSuccess'));
    } catch (error) {
      onError(error);
      windowRef?.showToast?.(translate('settings.fontUploadFailed'));
    } finally { customFontBusySlot = ''; renderCustomFontSlots(); }
  };

  customFontSlots.forEach(slotElement => {
    const slot = slotElement.dataset.fontSlot;
    bindEvent(slotElement.querySelector?.('[data-font-upload]'), 'click', () => void chooseCustomFont(slot));
    bindEvent(slotElement.querySelector?.('[data-font-reset]'), 'click', () => void restoreDefaultFont(slot));
  });
  const ready = refreshCustomFonts().catch(error => {
    onError(error);
    setInterfaceFontFamilies(false);
    renderCustomFontSlots();
  });

  return Object.freeze({
    ready,
    applyCustomInterfaceFonts,
    chooseCustomFont,
    dispose: scope.dispose,
    refreshCustomFonts,
    renderCustomFontSlots,
    restoreDefaultFont
  });
}
