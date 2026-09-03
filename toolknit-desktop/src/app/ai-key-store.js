/** Protected AI key storage with one-time legacy localStorage migration. */
export function createAiKeyStore({ isTauri = false, tauriCorePromise, storage = globalThis.localStorage } = {}) {
  const legacyNames = ['ai_api_key', 'deepseek_api_key'];
  const readLegacy = () => {
    try {
      for (const name of legacyNames) {
        const value = storage?.getItem(name)?.trim();
        if (value) return value;
      }
    } catch { /* storage may be unavailable */ }
    return '';
  };
  const clearLegacy = () => {
    try { legacyNames.forEach(name => storage?.removeItem(name)); } catch { /* best effort */ }
  };
  let cache = readLegacy();
  const ready = (async () => {
    if (!isTauri) return cache;
    try {
      const { invoke } = await tauriCorePromise;
      const protectedKey = await invoke('load_ai_api_key');
      if (typeof protectedKey === 'string' && protectedKey) {
        cache = protectedKey;
        clearLegacy();
      } else if (cache) {
        await invoke('store_ai_api_key', { apiKey: cache });
        clearLegacy();
      }
    } catch { /* retry on a later launch without losing the legacy key */ }
    return cache;
  })();
  const get = async () => { await ready; return cache; };
  const set = async apiKey => {
    await ready;
    if (isTauri) {
      const { invoke } = await tauriCorePromise;
      await invoke('store_ai_api_key', { apiKey });
    }
    cache = apiKey;
    clearLegacy();
  };
  const remove = async () => {
    await ready;
    if (isTauri) {
      const { invoke } = await tauriCorePromise;
      await invoke('clear_ai_api_key');
    }
    cache = '';
    clearLegacy();
  };
  return Object.freeze({ ready, get, set, remove, hasKey: () => Boolean(cache), clearLegacy });
}
