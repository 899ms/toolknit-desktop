export function formatDependencyBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 1) return '--';
  const units = ['B', 'KB', 'MB', 'GB'];
  const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / (1024 ** index)).toFixed(index < 2 ? 0 : 1)} ${units[index]}`;
}

export function isManagedRuntime(status) {
  return status?.source === 'managed';
}

export function normalizeLibreOfficeAvailability(value) {
  if (typeof value === 'boolean') return value;
  if (value && typeof value === 'object') {
    if (typeof value.available === 'boolean') return value.available;
    if (typeof value.installed === 'boolean') return value.installed;
  }
  return Boolean(value);
}

export function dependencyProgressPercent(progress) {
  if (!progress) return 0;
  if (['installing', 'verifying', 'complete'].includes(progress.phase)) return 100;
  return Math.max(0, Math.min(100, Math.round(
    (Number(progress.downloaded_bytes) || 0) / Math.max(1, Number(progress.total_bytes) || 0) * 100
  )));
}

export function createDependencyHelpers({ translate = key => key, getLanguage = () => 'zh', displayPath = value => value } = {}) {
  const detectedRuntimeLabel = status => {
    if (!status?.installed) return '';
    if (!isManagedRuntime(status)) return getLanguage() === 'en' ? 'Detected system dependency' : '已检测到系统依赖';
    const size = formatDependencyBytes(status.bytes);
    return size === '--'
      ? (getLanguage() === 'en' ? 'Installed' : '已安装')
      : (getLanguage() === 'en' ? `Installed (${size})` : `已安装 (${size})`);
  };
  const runtimeMetadata = status => status?.installed
    ? [status.version, displayPath(status.path)].filter(Boolean).join(' · ')
    : '';
  const dependencyStatusText = (type, progress, complete) => {
    if (complete || progress?.phase === 'complete') return translate('home.dependencies.ready');
    if (!progress) return translate('home.dependencies.waiting');
    if (progress.phase === 'installing') return translate('home.dependencies.installing');
    if (progress.phase === 'verifying') return translate('home.dependencies.verifying');
    return `${translate('home.dependencies.downloading')} ${dependencyProgressPercent(progress)}%`;
  };
  return Object.freeze({ detectedRuntimeLabel, dependencyStatusText, runtimeMetadata });
}
