export function formatCleanupDate(time, lang = 'zh') {
  if (!time) return '--';
  const date = new Date(time);
  if (Number.isNaN(date.getTime())) return '--';
  return new Intl.DateTimeFormat(lang === 'zh' ? 'zh-CN' : 'en-US', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).format(date);
}

export function cleanupDriveLetter(path) {
  const value = String(path || '').trim();
  const match = value.match(/^([a-zA-Z]):[\\/]*$/);
  return match ? match[1].toUpperCase() : '';
}

export function isCleanupDriveRoot(path) {
  return Boolean(cleanupDriveLetter(path));
}

export function isCleanupSystemDriveRoot(path) {
  const value = String(path || '').trim();
  return cleanupDriveLetter(value) === 'C' || value === '\\' || value === '/';
}

export function cleanupDriveLabel(path) {
  const drive = cleanupDriveLetter(path);
  return drive ? `${drive}:\\` : String(path || '').trim();
}

export function normalizeCleanupDriveSpace(space, fallbackDrive = '') {
  if (!space) return null;
  const freeBytes = Number(space.free_bytes ?? space.freeBytes);
  const totalBytes = Number(space.total_bytes ?? space.totalBytes);
  if (!Number.isFinite(totalBytes) || totalBytes <= 0) return null;
  return {
    drive: String(space.drive || fallbackDrive || '').trim(),
    freeBytes: Math.max(0, Number.isFinite(freeBytes) ? freeBytes : 0),
    totalBytes
  };
}

export function extractCleanupJson(text) {
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

export function cleanupFileNameFromPath(path) {
  const value = String(path || '').trim();
  if (!value) return '--';
  return value.split(/[\\/]/).filter(Boolean).pop() || value;
}

export function classifyCleanupRecycleError(error) {
  const message = String(error || '').trim();
  const lower = message.toLowerCase();
  if (!message) return { key: 'recycleFailureUnknown' };
  if (lower.includes('access') || lower.includes('permission') || message.includes('拒绝访问') || message.includes('权限')) {
    return { key: 'recycleFailureAccessDenied' };
  }
  if (lower.includes('being used') || lower.includes('another process') || lower.includes('in use') || message.includes('另一个程序') || message.includes('进程') || message.includes('占用')) {
    return { key: 'recycleFailureInUse' };
  }
  if (lower.includes('no longer exists') || lower.includes('cannot find') || message.includes('找不到') || message.includes('不存在')) {
    return { key: 'recycleFailureMissing' };
  }
  if (lower.includes('recycle') || message.includes('回收站')) {
    return { key: 'recycleFailureRecycleUnavailable' };
  }
  return { message: message.length > 140 ? `${message.slice(0, 140)}...` : message };
}
