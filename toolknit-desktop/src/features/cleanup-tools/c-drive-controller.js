import { createLifecycleScope } from '../../app/tool-lifecycle.js';
import { createModalSession } from '../../app/modal-runtime.js';
import { onLangChange as defaultOnLangChange, t as defaultTranslate } from '../../i18n.js';
import { tauriCorePromise } from '../../platform/tauri-runtime.js';
import { formatFileSize } from '../../shared/file-size.js';
import { escapeHtml } from '../../shared/html.js';

export function createCDriveCleanupController({
  overlay,
  isTauri = false,
  t = defaultTranslate,
  getLang = () => 'zh',
  onLangChange: registerLanguageChange = defaultOnLangChange,
  initStandardToolPlasma = () => null,
  disposeStandardToolPlasma = instance => instance?.(),
  notify = message => globalThis.window?.showToast?.(message),
  documentRef = globalThis.document,
  tauriCore = tauriCorePromise
} = {}) {
if (!overlay) throw new Error('c-drive-cleanup:missing-overlay');
if (!documentRef) throw new Error('c-drive-cleanup:missing-document');

const lifecycle = createLifecycleScope();
const document = documentRef;
const bind = (target, type, listener, options) => {
  if (target) lifecycle.event(target, type, listener, options);
};
const cDriveCleanupOverlay = overlay;
const cDriveCleanupPlasmaBg = document.getElementById('cDriveCleanupPlasmaBg');
const cDriveCleanupBack = document.getElementById('cDriveCleanupBack');
const cDriveCleanupOptions = cDriveCleanupOverlay ? Array.from(cDriveCleanupOverlay.querySelectorAll('.c-drive-cleanup-option')) : [];
const cDriveCleanupExplain = document.getElementById('cDriveCleanupExplain');
const cDriveCleanupFooterBtn = document.getElementById('cDriveCleanupConfirmBtn');
const cDriveCleanupAdminMask = document.getElementById('cDriveCleanupAdminMask');
const cDriveCleanupAdminRelaunch = document.getElementById('cDriveCleanupAdminRelaunch');
const cDriveCleanupConfirmMask = document.getElementById('cDriveCleanupConfirmMask');
const cDriveCleanupConfirmTier = document.getElementById('cDriveCleanupConfirmTier');
const cDriveCleanupConfirmList = document.getElementById('cDriveCleanupConfirmList');
const cDriveCleanupConfirmConsequences = document.getElementById('cDriveCleanupConfirmConsequences');
const cDriveCleanupConfirmRun = document.getElementById('cDriveCleanupConfirmRun');
const cDriveCleanupConfirmCancel = document.getElementById('cDriveCleanupConfirmCancel');

let cDriveCleanupPlasmaInstance = null;
let cDriveCleanupSelectedTier = 'low';
let cDriveCleanupScanData = null;
let cDriveCleanupScanRunId = 0;
let cDriveCleanupRunning = false;
let cDriveCleanupRelaunching = false;
let cDriveCleanupCountdownTimer = null;
let cDriveCleanupCountdownRemaining = null;
let cDriveCleanupRunId = 0;
let openRevision = 0;
let disposed = false;

const CDRIVE_TIER_CONFIG = {
  low: {
    riskKey: 'home.cDriveCleanupPage.tierLow',
    nameKey: 'home.cDriveCleanupPage.tierLowName',
    titleKey: 'home.cDriveCleanupPage.explainLowTitle',
    bodyKey: 'home.cDriveCleanupPage.explainLowBody',
    itemsKey: 'home.cDriveCleanupPage.explainLowItems',
    warnKey: null
  },
  medium: {
    riskKey: 'home.cDriveCleanupPage.tierMedium',
    nameKey: 'home.cDriveCleanupPage.tierMediumName',
    titleKey: 'home.cDriveCleanupPage.explainMediumTitle',
    bodyKey: 'home.cDriveCleanupPage.explainMediumBody',
    itemsKey: 'home.cDriveCleanupPage.explainMediumItems',
    warnKey: null
  },
  high: {
    riskKey: 'home.cDriveCleanupPage.tierHigh',
    nameKey: 'home.cDriveCleanupPage.tierHighName',
    titleKey: 'home.cDriveCleanupPage.explainHighTitle',
    bodyKey: 'home.cDriveCleanupPage.explainHighBody',
    itemsKey: 'home.cDriveCleanupPage.explainHighItems',
    warnKey: 'home.cDriveCleanupPage.explainHighWarn'
  }
};

const adminModal = createModalSession({
  root: cDriveCleanupAdminMask,
  background: cDriveCleanupOverlay,
  initialFocus: cDriveCleanupAdminRelaunch,
  onClose: () => cDriveCleanupHideAdminMask()
});
const confirmModal = createModalSession({
  root: cDriveCleanupConfirmMask,
  background: cDriveCleanupOverlay,
  initialFocus: cDriveCleanupConfirmCancel,
  onClose: () => cDriveCleanupCloseConfirm()
});
lifecycle.use(() => adminModal.dispose());
lifecycle.use(() => confirmModal.dispose());

function isCurrentOpen(owner) {
  return !disposed && owner === openRevision && cDriveCleanupOverlay.classList.contains('visible');
}

async function cDriveCleanupInvoke(name, args) {
  if (!isTauri) throw new Error('desktop-only');
  const { invoke } = await tauriCore;
  return args === undefined ? invoke(name) : invoke(name, args);
}

function cDriveCleanupTierSummary(tier) {
  if (!cDriveCleanupScanData || !Array.isArray(cDriveCleanupScanData.tiers)) return null;
  return cDriveCleanupScanData.tiers.find(item => item.tier === tier) || null;
}

function cDriveCleanupSplitItems(text) {
  return String(text || '').split(/[、,，]/).map(item => item.trim()).filter(Boolean);
}

function cDriveCleanupRenderSizes() {
  cDriveCleanupOptions.forEach(button => {
    const summary = cDriveCleanupTierSummary(button.dataset.tier);
    const sizeEl = button.querySelector('.c-drive-cleanup-option-size');
    if (!sizeEl) return;
    if (summary) {
      button.classList.add('is-scanned');
      sizeEl.innerHTML = `<b>${escapeHtml(t('home.cDriveCleanupPage.estimate', { size: formatFileSize(summary.bytes || 0) }))}</b>`;
    } else {
      button.classList.remove('is-scanned');
      sizeEl.innerHTML = `<i class="c-drive-cleanup-spinner" aria-hidden="true"></i><span>${escapeHtml(t('home.cDriveCleanupPage.scanning'))}</span>`;
    }
  });
}

function cDriveCleanupRenderExplain() {
  if (!cDriveCleanupExplain) return;
  const config = CDRIVE_TIER_CONFIG[cDriveCleanupSelectedTier] || CDRIVE_TIER_CONFIG.low;
  const items = cDriveCleanupSplitItems(t(config.itemsKey));
  const chips = items.map(item => `<span class="c-drive-cleanup-explain-item">${escapeHtml(item)}</span>`).join('');
  const warn = config.warnKey
    ? `<div class="c-drive-cleanup-explain-warn"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg><span>${escapeHtml(t(config.warnKey))}</span></div>`
    : '';
  cDriveCleanupExplain.innerHTML = `
    <div class="c-drive-cleanup-explain-head">
      <span class="c-drive-cleanup-option-risk c-drive-cleanup-risk-${cDriveCleanupSelectedTier}">${escapeHtml(t(config.riskKey))}</span>
      <h2 class="c-drive-cleanup-explain-title">${escapeHtml(t(config.titleKey))}</h2>
    </div>
    <p class="c-drive-cleanup-explain-body">${escapeHtml(t(config.bodyKey))}</p>
    <div class="c-drive-cleanup-explain-items">${chips}</div>
    ${warn}`;
}

function cDriveCleanupSelect(tier) {
  cDriveCleanupSelectedTier = tier;
  cDriveCleanupOptions.forEach(button => {
    const active = button.dataset.tier === tier;
    button.setAttribute('aria-checked', active ? 'true' : 'false');
  });
  cDriveCleanupRenderExplain();
  if (cDriveCleanupFooterBtn) {
    cDriveCleanupFooterBtn.disabled = cDriveCleanupRunning || !cDriveCleanupTierSummary(tier);
  }
}

function cDriveCleanupShowAdminMask() {
  adminModal.open();
}

function cDriveCleanupHideAdminMask() {
  adminModal.close();
}

function cDriveCleanupSetRelaunching(value) {
  cDriveCleanupRelaunching = Boolean(value);
  if (!cDriveCleanupAdminRelaunch) return;
  cDriveCleanupAdminRelaunch.disabled = cDriveCleanupRelaunching;
  cDriveCleanupAdminRelaunch.textContent = t(cDriveCleanupRelaunching
    ? 'home.cDriveCleanupPage.adminRelaunching'
    : 'home.cDriveCleanupPage.adminRelaunch');
}

function cDriveCleanupErrorCode(error) {
  return String(error?.message || error || '');
}

function cDriveCleanupAdminErrorMessage(error, fallbackKey) {
  const code = cDriveCleanupErrorCode(error);
  if (code.includes('system-cleanup:uac-cancelled')) {
    return t('home.cDriveCleanupPage.adminUacCancelled');
  }
  if (code.includes('system-cleanup:admin-check-failed')) {
    return t('home.cDriveCleanupPage.adminCheckFailed');
  }
  return t(fallbackKey);
}

function cDriveCleanupClearCountdown() {
  if (cDriveCleanupCountdownTimer) {
    clearTimeout(cDriveCleanupCountdownTimer);
    cDriveCleanupCountdownTimer = null;
  }
  cDriveCleanupCountdownRemaining = null;
}

function cDriveCleanupCloseConfirm() {
  cDriveCleanupClearCountdown();
  if (cDriveCleanupConfirmRun) {
    cDriveCleanupConfirmRun.disabled = true;
    cDriveCleanupConfirmRun.textContent = t('home.cDriveCleanupPage.confirmCountdown', { n: 5 });
  }
  confirmModal.close();
}

function cDriveCleanupRenderCountdown() {
  if (!cDriveCleanupConfirmRun || cDriveCleanupCountdownRemaining === null) return;
  if (cDriveCleanupCountdownRemaining <= 0) {
    cDriveCleanupConfirmRun.disabled = false;
    cDriveCleanupConfirmRun.textContent = t('home.cDriveCleanupPage.confirmReady');
    return;
  }
  cDriveCleanupConfirmRun.disabled = true;
  cDriveCleanupConfirmRun.textContent = t('home.cDriveCleanupPage.confirmCountdown', {
    n: cDriveCleanupCountdownRemaining
  });
}

function cDriveCleanupStartCountdown() {
  cDriveCleanupClearCountdown();
  cDriveCleanupCountdownRemaining = 5;
  const update = () => {
    if (cDriveCleanupCountdownRemaining === null) return;
    cDriveCleanupRenderCountdown();
    if (cDriveCleanupCountdownRemaining <= 0) {
      cDriveCleanupCountdownTimer = null;
      return;
    }
    cDriveCleanupCountdownRemaining -= 1;
    cDriveCleanupCountdownTimer = setTimeout(update, 1000);
  };
  update();
}

function cDriveCleanupOpenConfirm() {
  const config = CDRIVE_TIER_CONFIG[cDriveCleanupSelectedTier] || CDRIVE_TIER_CONFIG.low;
  const items = cDriveCleanupSplitItems(t(config.itemsKey));
  if (cDriveCleanupConfirmTier) cDriveCleanupConfirmTier.textContent = t(config.nameKey);
  if (cDriveCleanupConfirmList) {
    cDriveCleanupConfirmList.innerHTML = items.map(item => `<span>${escapeHtml(item)}</span>`).join('');
  }
  if (cDriveCleanupConfirmConsequences) {
    if (config.warnKey) {
      cDriveCleanupConfirmConsequences.textContent = t(config.warnKey);
      cDriveCleanupConfirmConsequences.hidden = false;
    } else {
      cDriveCleanupConfirmConsequences.hidden = true;
    }
  }
  confirmModal.open();
  cDriveCleanupStartCountdown();
}

async function cDriveCleanupStartScan() {
  const owner = openRevision;
  const runId = ++cDriveCleanupScanRunId;
  cDriveCleanupScanData = null;
  cDriveCleanupRenderSizes();
  if (cDriveCleanupFooterBtn) cDriveCleanupFooterBtn.disabled = true;
  try {
    const isAdmin = await cDriveCleanupInvoke('system_cleanup_is_admin');
    if (runId !== cDriveCleanupScanRunId || !isCurrentOpen(owner)) return;
    if (isAdmin === false) {
      cDriveCleanupShowAdminMask();
      return;
    }
    if (isAdmin !== true) {
      throw new Error('system-cleanup:admin-check-failed:invalid-response');
    }
    cDriveCleanupHideAdminMask();

    const data = await cDriveCleanupInvoke('system_cleanup_scan');
    if (runId !== cDriveCleanupScanRunId || !isCurrentOpen(owner)) return;
    cDriveCleanupScanData = data || null;
    if (data && data.is_admin === false) {
      cDriveCleanupShowAdminMask();
      return;
    }
    if (!data || data.is_admin !== true) {
      throw new Error('system-cleanup:admin-check-failed:invalid-scan-response');
    }
    cDriveCleanupRenderSizes();
    cDriveCleanupSelect(cDriveCleanupSelectedTier);
  } catch (error) {
    if (runId !== cDriveCleanupScanRunId || !isCurrentOpen(owner)) return;
    console.error('C-drive cleanup scan failed:', error);
    notify(cDriveCleanupAdminErrorMessage(error, 'home.cDriveCleanupPage.scanFailed'));
  }
}

async function cDriveCleanupRunSelected() {
  if (cDriveCleanupRunning) return;
  const owner = openRevision;
  const runId = ++cDriveCleanupRunId;
  const tier = cDriveCleanupSelectedTier;
  cDriveCleanupRunning = true;
  if (cDriveCleanupFooterBtn) cDriveCleanupFooterBtn.disabled = true;
  if (cDriveCleanupConfirmRun) {
    cDriveCleanupConfirmRun.disabled = true;
    cDriveCleanupConfirmRun.textContent = t('home.cDriveCleanupPage.cleaning');
  }
  try {
    const result = await cDriveCleanupInvoke('system_cleanup_run', { tier });
    if (runId !== cDriveCleanupRunId || !isCurrentOpen(owner)) return;
    cDriveCleanupCloseConfirm();
    notify(t('home.cDriveCleanupPage.cleaningDone', { size: formatFileSize(result?.freed_bytes || 0) }));
    await cDriveCleanupStartScan();
  } catch (error) {
    if (runId !== cDriveCleanupRunId || !isCurrentOpen(owner)) return;
    console.error('C-drive cleanup run failed:', error);
    cDriveCleanupCloseConfirm();
    const code = cDriveCleanupErrorCode(error);
    if (code.includes('system-cleanup:admin-required')) {
      cDriveCleanupShowAdminMask();
      notify(t('home.cDriveCleanupPage.adminRequiredAgain'));
    } else {
      notify(cDriveCleanupAdminErrorMessage(error, 'home.cDriveCleanupPage.cleaningFailed'));
    }
  } finally {
    if (runId !== cDriveCleanupRunId || !isCurrentOpen(owner)) return;
    cDriveCleanupRunning = false;
    if (cDriveCleanupFooterBtn) {
      cDriveCleanupFooterBtn.disabled = !cDriveCleanupTierSummary(cDriveCleanupSelectedTier);
    }
  }
}

function cDriveCleanupOpen() {
  if (disposed || !cDriveCleanupOverlay || cDriveCleanupOverlay.classList.contains('visible')) return;
  openRevision += 1;
  cDriveCleanupSetRelaunching(false);
  cDriveCleanupHideAdminMask();
  cDriveCleanupOverlay.classList.add('visible');
  cDriveCleanupOverlay.setAttribute('aria-hidden', 'false');
  if (cDriveCleanupPlasmaBg && !cDriveCleanupPlasmaInstance) {
    cDriveCleanupPlasmaInstance = initStandardToolPlasma(cDriveCleanupPlasmaBg);
  }
  cDriveCleanupSelectedTier = 'low';
  cDriveCleanupSelect('low');
  if (isTauri) void cDriveCleanupStartScan();
}

function cDriveCleanupClose() {
  if (cDriveCleanupRunning) {
    notify(getLang() === 'zh' ? '正在清理，请稍后再关闭。' : 'Please wait until cleanup finishes.');
    return;
  }
  cDriveCleanupCloseConfirm();
  cDriveCleanupHideAdminMask();
  if (!cDriveCleanupOverlay) return;
  openRevision += 1;
  cDriveCleanupScanRunId += 1;
  cDriveCleanupRunId += 1;
  cDriveCleanupSetRelaunching(false);
  cDriveCleanupOverlay.classList.remove('visible');
  cDriveCleanupOverlay.setAttribute('aria-hidden', 'true');
  if (cDriveCleanupPlasmaInstance) {
    disposeStandardToolPlasma(cDriveCleanupPlasmaInstance);
    cDriveCleanupPlasmaInstance = null;
  }
}

bind(cDriveCleanupBack, 'click', cDriveCleanupClose);
cDriveCleanupOptions.forEach(button => {
  bind(button, 'click', () => cDriveCleanupSelect(button.dataset.tier));
});
bind(cDriveCleanupFooterBtn, 'click', cDriveCleanupOpenConfirm);
bind(cDriveCleanupConfirmCancel, 'click', cDriveCleanupCloseConfirm);
bind(cDriveCleanupConfirmRun, 'click', () => { void cDriveCleanupRunSelected(); });
bind(cDriveCleanupAdminRelaunch, 'click', async () => {
  if (cDriveCleanupRelaunching) return;
  const owner = openRevision;
  cDriveCleanupSetRelaunching(true);
  try {
    const relaunchStarted = await cDriveCleanupInvoke('system_cleanup_relaunch_as_admin');
    if (!isCurrentOpen(owner)) return;
    if (relaunchStarted === false) {
      cDriveCleanupSetRelaunching(false);
      cDriveCleanupHideAdminMask();
      await cDriveCleanupStartScan();
    }
  } catch (error) {
    if (!isCurrentOpen(owner)) return;
    cDriveCleanupSetRelaunching(false);
    console.error('Relaunch as admin failed:', error);
    notify(cDriveCleanupAdminErrorMessage(error, 'home.cDriveCleanupPage.adminRelaunchFailed'));
  }
});

const unregisterLanguage = registerLanguageChange(() => {
  if (!cDriveCleanupOverlay?.classList.contains('visible')) return;
  cDriveCleanupRenderSizes();
  cDriveCleanupRenderExplain();
  cDriveCleanupSetRelaunching(cDriveCleanupRelaunching);
  if (cDriveCleanupConfirmMask?.classList.contains('visible')) {
    cDriveCleanupRenderCountdown();
  }
});
lifecycle.use(unregisterLanguage);

return {
  open: cDriveCleanupOpen,
  close: cDriveCleanupClose,
  dispose() {
    if (disposed) return;
    disposed = true;
    cDriveCleanupRunning = false;
    cDriveCleanupClose();
    cDriveCleanupClearCountdown();
    lifecycle.dispose();
  }
};
}
