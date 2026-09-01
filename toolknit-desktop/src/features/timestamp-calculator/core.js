const MAX_TIMESTAMP = 1e14;

export function pad2(value) {
  return value < 10 ? `0${value}` : String(value);
}

export function formatLocalDate(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
}

export function formatUtcDate(date) {
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())} ${pad2(date.getUTCHours())}:${pad2(date.getUTCMinutes())}:${pad2(date.getUTCSeconds())}`;
}

export function parseTimestamp(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  const timestamp = Number.parseFloat(text);
  if (!Number.isFinite(timestamp) || timestamp <= 0 || timestamp > MAX_TIMESTAMP) return null;
  const isMs = text.length >= 13 || timestamp > 1e11;
  return { ts: isMs ? timestamp / 1000 : timestamp, isMs };
}

export function getRelativeTime(timestamp, now, labels = {}) {
  const diff = timestamp - now;
  const absolute = Math.abs(diff);
  if (absolute < 1) return labels.now ?? 'now';
  const suffix = (ago, later, fallback) => diff < 0 ? ago ?? fallback : later ?? fallback;
  if (absolute < 60) return `${Math.round(absolute)}${suffix(labels.secondAgo, labels.secondLater, 's ago')}`;
  if (absolute < 3600) return `${Math.round(absolute / 60)}${suffix(labels.minuteAgo, labels.minuteLater, 'm ago')}`;
  if (absolute < 86400) return `${Math.round(absolute / 3600)}${suffix(labels.hourAgo, labels.hourLater, 'h ago')}`;
  return `${Math.round(absolute / 86400)}${suffix(labels.dayAgo, labels.dayLater, 'd ago')}`;
}
