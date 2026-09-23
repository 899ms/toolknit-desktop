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
  const value = String(path || '').trim().replace(/^\\\\\?\\/, '');
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
  if (/protected|reparse|outside|changed|session|scope|not in this scan/.test(lower)) return { key: 'recycleFailureProtected' };
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

export function applyCleanupAiBatch(candidates, payload, batchIds) {
  const allowed = new Set(batchIds.map(String));
  const entries = Array.isArray(payload?.items) ? payload.items : [];
  const counts = new Map();
  for (const entry of entries) counts.set(entry?.id, (counts.get(entry?.id) || 0) + 1);
  const valid = new Map(entries.filter(entry => entry && typeof entry.id === 'string'
    && allowed.has(entry.id) && counts.get(entry.id) === 1
    && ['delete', 'keep', 'review'].includes(entry.decision)
    && typeof entry.reason === 'string' && entry.reason.trim()
    && typeof entry.identity === 'string').map(entry => [entry.id, entry]));
  return candidates.map(candidate => {
    const entry = valid.get(candidate.id);
    if (!entry) return candidate;
    const sensitive = candidate.risk === 'high' || candidate.protected || candidate.category === 'models'
      || /(?:wechat|xwechat|wxid_|projects?|source|repos?|src)(?:[\\/]|$)/i.test(candidate.folder_hint || '');
    return { ...candidate, ai_decision: sensitive && entry.decision === 'delete' ? 'review' : entry.decision,
      ai_identity: entry.identity.trim().slice(0, 120), ai_reason: entry.reason.trim().slice(0, 500) };
  });
}

export function filterCleanupCandidates(candidates, query = '', risk = 'all', category = 'all') {
  const needle = query.trim().toLocaleLowerCase();
  return candidates.filter(item => (risk === 'all' || item.risk === risk)
    && (category === 'all' || item.category === category)
    && (!needle || [item.name, item.path, item.folder_hint].some(value => String(value || '').toLocaleLowerCase().includes(needle))));
}

export function cleanupBatchSelection(candidates) {
  return candidates.filter(item => item.risk !== 'high' && !item.protected).slice(0, 200).map(item => item.path);
}
