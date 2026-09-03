/** Update status, version lookup, and release-check concurrency boundary. */
export function createUpdateRuntime({
  isTauri = false,
  fallbackVersion = '0.0.0',
  updateService,
  compareVersions,
  translate = key => key,
  statusElement = null,
  checkButton = null,
  releaseButton = null,
  getPreviewController = () => null,
  openExternalUrl = async () => {},
  loadAppVersion = async () => fallbackVersion
} = {}) {
  let running = false;
  let lastResult = null;
  let state = { kind: 'neutral', version: fallbackVersion };

  const getLocalAppVersion = async () => {
    if (!isTauri) return fallbackVersion;
    try {
      const version = await loadAppVersion();
      if (version && String(version).trim()) return String(version).trim();
    } catch (error) {
      console.error('Failed to read app version:', error);
    }
    return fallbackVersion;
  };

  const render = () => {
    if (!statusElement) return;
    const { kind, version } = state;
    const text = kind === 'checking'
      ? translate('settings.versionChecking')
      : kind === 'available'
        ? translate('settings.versionAvailable', { version })
        : kind === 'up-to-date'
          ? translate('settings.versionUpToDate', { version })
          : kind === 'error'
            ? translate('settings.versionUpdateFailed')
            : translate('settings.versionCurrent', { version });
    statusElement.textContent = text;
    statusElement.dataset.kind = kind;
    if (releaseButton) releaseButton.hidden = kind !== 'available';
  };

  const setState = (kind, version = fallbackVersion) => {
    state = { kind, version };
    render();
  };

  const runCheck = async ({ force = true, showUpdate = true } = {}) => {
    if (running) return null;
    running = true;
    if (checkButton) checkButton.disabled = true;
    setState('checking');
    try {
      const localVersion = await getLocalAppVersion();
      const result = await updateService.check({ force });
      lastResult = result;
      if (compareVersions(result.release.version, localVersion) > 0) {
        setState('available', result.release.version);
        if (showUpdate) getPreviewController()?.open({ ...result.release, currentVersion: localVersion });
      } else setState('up-to-date', localVersion);
      return result;
    } catch (error) {
      if (showUpdate) console.error('Version update check failed:', error);
      setState('error');
      return null;
    } finally {
      running = false;
      if (checkButton) checkButton.disabled = false;
    }
  };

  return Object.freeze({
    getLastResult: () => lastResult,
    getLocalAppVersion,
    getState: () => ({ ...state }),
    openReleasePage: () => openExternalUrl(lastResult?.release?.htmlUrl),
    render,
    runCheck,
    service: updateService,
    setState
  });
}
