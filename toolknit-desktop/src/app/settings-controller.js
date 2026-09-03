/** Settings state facade. Feature controllers receive this instead of touching storage ad hoc. */
export function createSettingsController({ storage = globalThis.localStorage, prefix = 'toolknit.' } = {}) {
  const key = name => `${prefix}${name}`;
  const read = (name, fallback = null) => {
    try { return storage?.getItem(key(name)) ?? fallback; } catch { return fallback; }
  };
  const write = (name, value) => {
    try { storage?.setItem(key(name), String(value)); } catch { /* storage is optional */ }
  };
  return Object.freeze({ read, write, remove: name => { try { storage?.removeItem(key(name)); } catch {} } });
}
