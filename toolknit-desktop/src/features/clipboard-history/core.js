export const DEFAULT_SETTINGS = Object.freeze({ text: true, images: true, files: true, resumeOnLaunch: false, retentionDays: 7, maxRecords: 2000, maxMegabytes: 256, excludedApps: [] });
export function dateRange(value, now = new Date()) {
  if (!value) return {};
  const start = new Date(now); start.setHours(0, 0, 0, 0);
  if (value === 'week') start.setDate(start.getDate() - 6);
  return { from: start.getTime(), to: now.getTime() };
}
export function timeLabel(timestamp, lang = 'zh', detailed = false, offsetMinutes = null) {
  const locale = lang === 'zh' ? 'zh-CN' : 'en-GB';
  const offset = detailed && Number.isFinite(offsetMinutes) ? offsetMinutes : null;
  const date = new Date(timestamp + (offset === null ? 0 : offset * 60000));
  const options = { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', ...(offset === null ? {} : { timeZone: 'UTC' }) };
  if (!detailed) return date.toLocaleTimeString(locale, options);
  const sign = offset >= 0 ? '+' : '-';
  const zone = offset === null ? '' : ` UTC${sign}${String(Math.floor(Math.abs(offset) / 60)).padStart(2, '0')}:${String(Math.abs(offset) % 60).padStart(2, '0')}`;
  return `${date.toLocaleString(locale, { ...options, year: 'numeric', month: '2-digit', day: '2-digit', fractionalSecondDigits: 3 })}${zone}`;
}
export function dayLabel(timestamp, lang = 'zh') { return new Date(timestamp).toLocaleDateString(lang === 'zh' ? 'zh-CN' : 'en-GB', { year: 'numeric', month: 'long', day: 'numeric' }); }
export function sizeLabel(bytes) { return bytes < 1024 ? `${bytes} B` : bytes < 1048576 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1048576).toFixed(1)} MB`; }
export function normalizeExcludedApps(value) { return [...new Set(String(value).split(/[\n,;，；]+/).map(s => s.trim().toLowerCase()).filter(Boolean))]; }
export function validateSettings(settings) {
  return ['retentionDays', 'maxRecords', 'maxMegabytes'].every(key => Number.isInteger(settings[key]))
    && settings.retentionDays >= 1 && settings.retentionDays <= 365 && settings.maxRecords >= 100 && settings.maxRecords <= 10000
    && settings.maxMegabytes >= 32 && settings.maxMegabytes <= 2048 && settings.excludedApps.length <= 100
    && settings.excludedApps.every(value => value.length <= 128 && !/[\\/\x00-\x1f\x7f]/.test(value));
}
export function errorKey(error) {
  const code = String(error?.message || error).replace(/^clipboard:/, '');
  return ({ 'desktop-only': 'desktopOnly', busy: 'busy', capacity: 'capacity', 'too-large': 'tooLarge', 'files-missing': 'filesMissing', 'key-failed': 'keyFailed', 'record-damaged': 'recordDamaged', 'not-found': 'notFound', 'invalid-settings': 'invalidSettings', changed: 'changed', 'image-invalid': 'imageInvalid' })[code] || 'operationFailed';
}
