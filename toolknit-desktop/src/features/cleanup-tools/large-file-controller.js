import { createLifecycleScope } from '../../app/tool-lifecycle.js';
import { onLangChange as defaultOnLangChange, t as defaultTranslate } from '../../i18n.js';
import { loadTauriDialog, tauriCorePromise } from '../../platform/tauri-runtime.js';
import { formatFileSize } from '../../shared/file-size.js';
import { escapeAttr, escapeHtml } from '../../shared/html.js';
import {
  classifyCleanupRecycleError,
  cleanupFileNameFromPath,
  cleanupDriveLabel as largeFileCleanupDriveLabel,
  cleanupDriveLetter as largeFileCleanupDriveLetter,
  extractCleanupJson as largeFileCleanupExtractJson,
  formatCleanupDate,
  isCleanupDriveRoot as isLargeFileCleanupDriveRoot,
  isCleanupSystemDriveRoot as isLargeFileCleanupSystemDriveRoot,
  normalizeCleanupDriveSpace
} from './large-file-core.js';

export function createLargeFileCleanupController({
  overlay,
  isTauri = false,
  t = defaultTranslate,
  getLang = () => 'zh',
  onLangChange: registerLanguageChange = defaultOnLangChange,
  displayFilesystemPath = value => String(value || ''),
  requestAi = async () => { throw new Error('cleanup-large-files:ai-unavailable'); },
  getAiApiKey = () => '',
  requestAiKeyConfiguration = () => {},
  initStandardToolPlasma = () => null,
  disposeStandardToolPlasma = instance => instance?.(),
  notify = (message, options) => globalThis.window?.showToast?.(message, options),
  documentRef = globalThis.document,
  windowRef = globalThis.window,
  storage = globalThis.localStorage,
  tauriCore = tauriCorePromise,
  loadDialog = loadTauriDialog
} = {}) {
if (!overlay) throw new Error('cleanup-large-files:missing-overlay');
if (!documentRef || !windowRef) throw new Error('cleanup-large-files:missing-dom');
const lifecycle = createLifecycleScope();
let renderScope = createLifecycleScope();
let hoverToastScope = createLifecycleScope();
const document = documentRef;
const window = windowRef;
const localStorage = storage;
const largeFileCleanupOverlay = overlay;
const bind = (target, type, listener, options) => {
  if (target) lifecycle.event(target, type, listener, options);
};
const largeFileCleanupBody = largeFileCleanupOverlay?.querySelector('.cleanup-large-files-body');
const largeFileCleanupPlasmaBg = document.getElementById('largeFileCleanupPlasmaBg');
const largeFileCleanupBack = document.getElementById('largeFileCleanupBack');
const largeFileCleanupFolder = document.getElementById('largeFileCleanupFolder');
const largeFileCleanupChooseFolder = document.getElementById('largeFileCleanupChooseFolder');
const largeFileCleanupThreshold = document.getElementById('largeFileCleanupThreshold');
const largeFileCleanupModeGroup = document.getElementById('largeFileCleanupModeGroup');
const largeFileCleanupScanBtn = document.getElementById('largeFileCleanupScanBtn');
const largeFileCleanupAiCard = document.getElementById('largeFileCleanupAiCard');
const largeFileCleanupAiTitle = document.getElementById('largeFileCleanupAiTitle');
const largeFileCleanupAiDesc = document.getElementById('largeFileCleanupAiDesc');
const largeFileCleanupAiBtn = document.getElementById('largeFileCleanupAiBtn');
const largeFileCleanupAiProgress = document.getElementById('largeFileCleanupAiProgress');
const largeFileCleanupAiProgressFill = document.getElementById('largeFileCleanupAiProgressFill');
const largeFileCleanupAiProgressText = document.getElementById('largeFileCleanupAiProgressText');
const largeFileCleanupSelectAllBtn = document.getElementById('largeFileCleanupSelectAllBtn');
const largeFileCleanupClearBtn = document.getElementById('largeFileCleanupClearBtn');
const largeFileCleanupDeleteBtn = document.getElementById('largeFileCleanupDeleteBtn');
const largeFileCleanupSelectAllCheckbox = document.getElementById('largeFileCleanupSelectAllCheckbox');
const largeFileCleanupSummary = document.getElementById('largeFileCleanupSummary');
const largeFileCleanupTableBody = document.getElementById('largeFileCleanupTableBody');
const largeFileCleanupSizeSort = document.getElementById('largeFileCleanupSizeSort');
const largeFileCleanupSizeSortTrigger = document.getElementById('largeFileCleanupSizeSortTrigger');
const largeFileCleanupSizeSortMenu = document.getElementById('largeFileCleanupSizeSortMenu');
const largeFileCleanupSuccessOverlay = document.getElementById('largeFileCleanupSuccessOverlay');
const largeFileCleanupSuccessMeta = document.getElementById('largeFileCleanupSuccessMeta');
const largeFileCleanupSuccessAnalyzed = document.getElementById('largeFileCleanupSuccessAnalyzed');
const largeFileCleanupSuccessMoved = document.getElementById('largeFileCleanupSuccessMoved');
const largeFileCleanupSuccessSize = document.getElementById('largeFileCleanupSuccessSize');
const largeFileCleanupSuccessFolder = document.getElementById('largeFileCleanupSuccessFolder');
const largeFileCleanupSuccessFailures = document.getElementById('largeFileCleanupSuccessFailures');
const largeFileCleanupSuccessOpenFolder = document.getElementById('largeFileCleanupSuccessOpenFolder');
const largeFileCleanupSuccessOk = document.getElementById('largeFileCleanupSuccessOk');
const largeFileCleanupDriveRootOverlay = document.getElementById('largeFileCleanupDriveRootOverlay');
const largeFileCleanupDriveRootTitle = document.getElementById('largeFileCleanupDriveRootTitle');
const largeFileCleanupDriveRootDesc = document.getElementById('largeFileCleanupDriveRootDesc');
const largeFileCleanupDriveRootCancel = document.getElementById('largeFileCleanupDriveRootCancel');
const largeFileCleanupDriveRootConfirm = document.getElementById('largeFileCleanupDriveRootConfirm');
let largeFileCleanupPlasmaInstance = null;
let largeFileCleanupRootPath = '';
let largeFileCleanupMode = 'video';
let largeFileCleanupCandidates = [];
let largeFileCleanupSkippedDirs = 0;
let largeFileCleanupScanRunId = 0;
let largeFileCleanupAiRunId = 0;
let largeFileCleanupDeleteRunId = 0;
let largeFileCleanupBusy = false;
let largeFileCleanupBusyKind = '';
let largeFileCleanupSelectedPaths = new Set();
let largeFileCleanupEmptyMessage = '';
let largeFileCleanupSummaryStatus = '';
let largeFileCleanupAiProgressDone = 0;
let largeFileCleanupAiProgressTotal = 0;
let largeFileCleanupDriveRootResolver = null;
let largeFileCleanupHoverToast = null;
let largeFileCleanupHoverToastTimer = null;
let largeFileCleanupContextCandidate = null;
let largeFileCleanupContextMenu = null;
let largeFileCleanupSortMode = 'default';
let largeFileCleanupSizeSortCloseTimer = null;
let largeFileCleanupDriveSpace = null;
let largeFileCleanupDriveSpaceRunId = 0;
let openRevision = 0;
let disposed = false;
const LARGE_FILE_CLEANUP_FOLDER_KEY = 'toolknit.cleanup.large-file.folder.v1';

function isCurrentOpen(owner) {
  return !disposed && owner === openRevision && largeFileCleanupOverlay.classList.contains('visible');
}

function loadLargeFileCleanupFolder() {
  try {
    return localStorage.getItem(LARGE_FILE_CLEANUP_FOLDER_KEY)?.trim() || '';
  } catch {
    return '';
  }
}
function saveLargeFileCleanupFolder(path) {
  try {
    if (path) localStorage.setItem(LARGE_FILE_CLEANUP_FOLDER_KEY, path);
    else localStorage.removeItem(LARGE_FILE_CLEANUP_FOLDER_KEY);
  } catch {}
}

function largeFileCleanupBusyState() {
  return largeFileCleanupBusy;
}

function largeFileCleanupSetBusy(nextBusy, kind = '') {
  largeFileCleanupBusy = !!nextBusy;
  largeFileCleanupBusyKind = largeFileCleanupBusy ? kind : '';
  [largeFileCleanupChooseFolder, largeFileCleanupThreshold, largeFileCleanupScanBtn, largeFileCleanupAiBtn, largeFileCleanupSelectAllBtn, largeFileCleanupClearBtn, largeFileCleanupDeleteBtn, largeFileCleanupSelectAllCheckbox]
    .forEach(el => {
      if (!el) return;
      el.disabled = largeFileCleanupBusy;
    });
  if (largeFileCleanupScanBtn) {
    largeFileCleanupScanBtn.textContent = largeFileCleanupBusyKind === 'scan'
      ? t('home.cleanupLargeFilesPage.scanning')
      : t('home.cleanupLargeFilesPage.scan');
  }
  if (largeFileCleanupAiBtn) {
    largeFileCleanupAiBtn.textContent = largeFileCleanupBusyKind === 'ai'
      ? t('home.cleanupLargeFilesPage.analysisRunning')
      : t('home.cleanupLargeFilesPage.aiAnalyze');
  }
  if (largeFileCleanupDeleteBtn && largeFileCleanupBusyKind === 'delete') {
    largeFileCleanupDeleteBtn.textContent = getLang() === 'zh' ? '正在移入回收站...' : 'Moving to Recycle Bin...';
  }
  largeFileCleanupRenderAiCard();
}

function largeFileCleanupSetMode(mode) {
  largeFileCleanupMode = mode || 'video';
  largeFileCleanupModeGroup?.querySelectorAll('[data-mode]').forEach(button => {
    button.classList.toggle('is-active', button.dataset.mode === largeFileCleanupMode);
  });
}

function largeFileCleanupDriveSpaceText(space = largeFileCleanupDriveSpace) {
  const normalized = normalizeCleanupDriveSpace(space, largeFileCleanupDriveLabel(largeFileCleanupRootPath));
  if (!normalized) return '';
  return t('home.cleanupLargeFilesPage.driveSpaceLabel', {
    free: formatFileSize(normalized.freeBytes),
    total: formatFileSize(normalized.totalBytes)
  });
}

function largeFileCleanupSetDriveSpace(space) {
  largeFileCleanupDriveSpace = normalizeCleanupDriveSpace(space, largeFileCleanupDriveLabel(largeFileCleanupRootPath));
  largeFileCleanupSetFolderLabel(largeFileCleanupRootPath);
}

async function refreshLargeFileCleanupDriveSpace(path) {
  const rootPath = String(path || '').trim();
  const runId = ++largeFileCleanupDriveSpaceRunId;
  if (!isTauri || !isLargeFileCleanupDriveRoot(rootPath)) {
    largeFileCleanupSetDriveSpace(null);
    largeFileCleanupUpdateSummary();
    return;
  }
  largeFileCleanupSetDriveSpace(null);
  largeFileCleanupUpdateSummary();
  try {
    const { invoke } = await tauriCore;
    const space = await invoke('get_cleanup_drive_space', { rootPath });
    if (runId !== largeFileCleanupDriveSpaceRunId) return;
    largeFileCleanupSetDriveSpace(space);
    largeFileCleanupUpdateSummary();
  } catch (error) {
    if (runId !== largeFileCleanupDriveSpaceRunId) return;
    console.warn('Read cleanup drive space failed:', error);
    largeFileCleanupSetDriveSpace(null);
    largeFileCleanupUpdateSummary();
  }
}

function largeFileCleanupSetFolderLabel(path) {
  if (!largeFileCleanupFolder) return;
  const value = String(path || '').trim();
  if (!value) {
    largeFileCleanupFolder.textContent = t('home.cleanupLargeFilesPage.folderPlaceholder');
    largeFileCleanupFolder.removeAttribute('title');
    return;
  }
  const driveSpaceText = isLargeFileCleanupDriveRoot(value) ? largeFileCleanupDriveSpaceText() : '';
  const displayPath = displayFilesystemPath(value);
  const label = driveSpaceText ? `${largeFileCleanupDriveLabel(value)} · ${driveSpaceText}` : displayPath;
  largeFileCleanupFolder.textContent = label;
  largeFileCleanupFolder.title = label;
}

function largeFileCleanupSetThreshold(value) {
  if (!largeFileCleanupThreshold) return;
  largeFileCleanupThreshold.value = String(Math.max(10, Math.min(102400, Number(value) || 50)));
}

function largeFileCleanupSelectedCount() {
  return largeFileCleanupSelectedPaths.size;
}

function largeFileCleanupTotalBytes() {
  return largeFileCleanupCandidates.reduce((sum, item) => sum + (Number(item.size_bytes) || 0), 0);
}

function largeFileCleanupSelectedBytes() {
  return largeFileCleanupCandidates.reduce((sum, item) => (
    largeFileCleanupSelectedPaths.has(item.path) ? sum + (Number(item.size_bytes) || 0) : sum
  ), 0);
}

function largeFileCleanupAnalyzeCount() {
  return largeFileCleanupCandidates.filter(item => item.ai_decision || item.aiDecision).length;
}

function largeFileCleanupSortedCandidates() {
  const items = largeFileCleanupCandidates.map((item, index) => ({ item, index: Number.isFinite(Number(item.__default_index)) ? Number(item.__default_index) : index }));
  if (largeFileCleanupSortMode === 'desc') {
    items.sort((a, b) => (Number(b.item.size_bytes) || 0) - (Number(a.item.size_bytes) || 0) || a.index - b.index);
  } else if (largeFileCleanupSortMode === 'asc') {
    items.sort((a, b) => (Number(a.item.size_bytes) || 0) - (Number(b.item.size_bytes) || 0) || a.index - b.index);
  } else {
    items.sort((a, b) => a.index - b.index);
  }
  return items.map(entry => entry.item);
}

function syncLargeFileCleanupSizeSortUi() {
  if (largeFileCleanupSizeSort) {
    largeFileCleanupSizeSort.dataset.sort = largeFileCleanupSortMode;
  }
  if (largeFileCleanupSizeSortTrigger) {
    largeFileCleanupSizeSortTrigger.setAttribute('aria-expanded', largeFileCleanupSizeSort?.classList.contains('is-open') ? 'true' : 'false');
  }
  largeFileCleanupSizeSortMenu?.querySelectorAll('[data-sort]').forEach(button => {
    button.classList.toggle('active', button.dataset.sort === largeFileCleanupSortMode);
  });
}

function openLargeFileCleanupSizeSortMenu() {
  if (largeFileCleanupSizeSortCloseTimer) {
    clearTimeout(largeFileCleanupSizeSortCloseTimer);
    largeFileCleanupSizeSortCloseTimer = null;
  }
  largeFileCleanupSizeSort?.classList.add('is-open');
  largeFileCleanupSizeSortMenu?.classList.add('is-open');
  if (largeFileCleanupSizeSortMenu && largeFileCleanupSizeSortTrigger) {
    const triggerRect = largeFileCleanupSizeSortTrigger.getBoundingClientRect();
    const menuWidth = largeFileCleanupSizeSortMenu.offsetWidth;
    const menuHeight = largeFileCleanupSizeSortMenu.offsetHeight;
    const padding = 10;
    let left = triggerRect.right - menuWidth;
    left = Math.min(left, window.innerWidth - menuWidth - padding);
    left = Math.max(padding, left);
    const belowTop = triggerRect.bottom + 8;
    const aboveTop = triggerRect.top - menuHeight - 8;
    let top = belowTop;
    if (belowTop + menuHeight > window.innerHeight - padding) {
      top = aboveTop;
    }
    top = Math.max(padding, Math.min(top, window.innerHeight - menuHeight - padding));
    largeFileCleanupSizeSortMenu.style.left = `${left}px`;
    largeFileCleanupSizeSortMenu.style.top = `${top}px`;
  }
  syncLargeFileCleanupSizeSortUi();
}

function closeLargeFileCleanupSizeSortMenu(delay = 320) {
  if (largeFileCleanupSizeSortCloseTimer) clearTimeout(largeFileCleanupSizeSortCloseTimer);
  largeFileCleanupSizeSortCloseTimer = setTimeout(() => {
    largeFileCleanupSizeSort?.classList.remove('is-open');
    largeFileCleanupSizeSortMenu?.classList.remove('is-open');
    syncLargeFileCleanupSizeSortUi();
    largeFileCleanupSizeSortCloseTimer = null;
  }, Math.max(0, delay));
}

function setLargeFileCleanupSortMode(mode) {
  largeFileCleanupSortMode = ['default', 'desc', 'asc'].includes(mode) ? mode : 'default';
  closeLargeFileCleanupSizeSortMenu(120);
  syncLargeFileCleanupSizeSortUi();
  largeFileCleanupRenderTable();
}

function largeFileCleanupHasAiKey() {
  return Boolean(getAiApiKey());
}

function largeFileCleanupRenderAiCard() {
  if (!largeFileCleanupAiCard) return;
  const total = largeFileCleanupCandidates.length;
  const analyzed = largeFileCleanupAnalyzeCount();
  const hasKey = largeFileCleanupHasAiKey();
  const isAiBusy = largeFileCleanupBusy && largeFileCleanupBusyKind === 'ai';
  let state = 'idle';
  let titleKey = 'aiIdleTitle';
  let descKey = 'aiIdleDesc';
  let buttonText = t('home.cleanupLargeFilesPage.aiWaitingScan');
  let buttonDisabled = largeFileCleanupBusy || total === 0;

  if (isAiBusy) {
    state = 'running';
    titleKey = 'aiRunningTitle';
    descKey = 'aiRunningDesc';
    buttonText = t('home.cleanupLargeFilesPage.analysisRunning');
    buttonDisabled = true;
  } else if (total > 0 && !hasKey) {
    state = 'need-key';
    titleKey = 'aiNeedKeyTitle';
    descKey = 'aiNeedKeyDesc';
    buttonText = t('home.cleanupLargeFilesPage.aiConfigureAndAnalyze');
    buttonDisabled = false;
  } else if (total > 0 && analyzed >= total) {
    state = 'done';
    titleKey = 'aiDoneTitle';
    descKey = 'aiDoneDesc';
    buttonText = t('home.cleanupLargeFilesPage.aiReanalyze');
    buttonDisabled = largeFileCleanupBusy;
  } else if (total > 0) {
    state = analyzed > 0 ? 'partial' : 'ready';
    titleKey = analyzed > 0 ? 'aiPartialTitle' : 'aiReadyTitle';
    descKey = analyzed > 0 ? 'aiPartialDesc' : 'aiReadyDesc';
    buttonText = analyzed > 0
      ? t('home.cleanupLargeFilesPage.aiContinueAnalyzeCount', { count: total })
      : t('home.cleanupLargeFilesPage.aiAnalyzeCount', { count: total });
    buttonDisabled = largeFileCleanupBusy;
  }

  largeFileCleanupAiCard.dataset.state = state;
  if (largeFileCleanupAiTitle) largeFileCleanupAiTitle.textContent = t(`home.cleanupLargeFilesPage.${titleKey}`);
  if (largeFileCleanupAiDesc) largeFileCleanupAiDesc.textContent = t(`home.cleanupLargeFilesPage.${descKey}`);
  if (largeFileCleanupAiBtn) {
    largeFileCleanupAiBtn.textContent = buttonText;
    largeFileCleanupAiBtn.disabled = buttonDisabled;
  }
  if (largeFileCleanupAiProgress) {
    const progressTotal = largeFileCleanupAiProgressTotal || total || 1;
    const progressDone = Math.min(progressTotal, Math.max(0, largeFileCleanupAiProgressDone));
    const percent = isAiBusy ? Math.max(8, Math.round((progressDone / progressTotal) * 100)) : 0;
    if (largeFileCleanupAiProgressFill) largeFileCleanupAiProgressFill.style.width = `${percent}%`;
    if (largeFileCleanupAiProgressText) {
      largeFileCleanupAiProgressText.textContent = isAiBusy
        ? t('home.cleanupLargeFilesPage.aiProgress', { done: progressDone, total: progressTotal })
        : '';
    }
    largeFileCleanupAiProgress.setAttribute('aria-hidden', isAiBusy ? 'false' : 'true');
  }
}

function largeFileCleanupUpdateSummary(extraText = '') {
  if (!largeFileCleanupSummary) return;
  const folderText = largeFileCleanupRootPath || t('home.cleanupLargeFilesPage.folderPlaceholder');
  const statusText = extraText || largeFileCleanupSummaryStatus || '';
  const labelMap = getLang() === 'zh'
    ? { folder: '目录', driveSpace: '盘空间', files: '候选', size: '合计', selected: '已选', selectedSize: '已选大小', skipped: '保护目录', analyzed: 'AI' }
    : { folder: 'Folder', driveSpace: 'Drive', files: 'Candidates', size: 'Total', selected: 'Selected', selectedSize: 'Selected size', skipped: 'Protected', analyzed: 'AI' };
  const driveSpaceText = isLargeFileCleanupDriveRoot(largeFileCleanupRootPath) ? largeFileCleanupDriveSpaceText() : '';
  const chips = [
    { key: 'folder', label: folderText, strong: labelMap.folder },
    ...(driveSpaceText ? [{ key: 'drive-space', label: driveSpaceText, strong: labelMap.driveSpace }] : []),
    { key: 'files', label: t('home.cleanupLargeFilesPage.summaryFiles', { count: largeFileCleanupCandidates.length }), strong: labelMap.files },
    { key: 'size', label: t('home.cleanupLargeFilesPage.summarySize', { size: formatFileSize(largeFileCleanupTotalBytes()) }), strong: labelMap.size },
    { key: 'selected', label: `${largeFileCleanupSelectedCount()} / ${largeFileCleanupCandidates.length}`, strong: labelMap.selected },
    { key: 'skipped', label: t('home.cleanupLargeFilesPage.summarySkipped', { count: largeFileCleanupSkippedDirs }), strong: labelMap.skipped },
    { key: 'analyzed', label: t('home.cleanupLargeFilesPage.summaryAnalyzed', { count: largeFileCleanupAnalyzeCount() }), strong: labelMap.analyzed },
    { key: 'selected-size', label: formatFileSize(largeFileCleanupSelectedBytes()), strong: labelMap.selectedSize }
  ];
  const statusChip = statusText ? `<span class="cleanup-large-files-summary-item cleanup-large-files-summary-status"><strong>${escapeHtml(statusText)}</strong></span>` : '';
  largeFileCleanupSummary.innerHTML = `${statusChip}${chips.map(({ key, label, strong }) => `<span class="cleanup-large-files-summary-item" data-kind="${escapeAttr(key)}"><strong>${escapeHtml(strong)}</strong><span>${escapeHtml(label)}</span></span>`).join('')}`;
  largeFileCleanupRenderAiCard();
}

function largeFileCleanupSyncSelectionUi() {
  if (!largeFileCleanupSelectAllCheckbox) return;
  const total = largeFileCleanupCandidates.length;
  const selected = largeFileCleanupSelectedCount();
  largeFileCleanupSelectAllCheckbox.checked = total > 0 && selected === total;
  largeFileCleanupSelectAllCheckbox.indeterminate = selected > 0 && selected < total;
  if (largeFileCleanupSelectAllBtn) {
    largeFileCleanupSelectAllBtn.textContent = `${t('home.cleanupLargeFilesPage.selectAll')} (${selected}/${total})`;
  }
  if (largeFileCleanupClearBtn) {
    largeFileCleanupClearBtn.textContent = `${t('home.cleanupLargeFilesPage.clearSelection')} (${selected})`;
  }
  if (largeFileCleanupDeleteBtn) {
    largeFileCleanupDeleteBtn.textContent = `${t('home.cleanupLargeFilesPage.deleteSelected')} (${selected})`;
    largeFileCleanupDeleteBtn.disabled = largeFileCleanupBusy || selected === 0;
  }
  largeFileCleanupRenderAiCard();
}

function largeFileCleanupDecisionLabel(decision) {
  const normalized = String(decision || '').toLowerCase();
  if (normalized === 'delete') return getLang() === 'zh' ? '建议删除' : 'Suggested delete';
  if (normalized === 'keep') return getLang() === 'zh' ? '建议保留' : 'Suggested keep';
  if (normalized === 'review') return getLang() === 'zh' ? '建议复核' : 'Suggested review';
  return '';
}

function largeFileCleanupReasonDisplay(candidate) {
  const decision = candidate.ai_decision || candidate.aiDecision || '';
  const localReason = String(candidate.local_reason || '').trim();
  const aiIdentity = String(candidate.ai_identity || candidate.aiIdentity || '').trim();
  const aiReason = String(candidate.ai_reason || candidate.aiReason || '').trim();
  const aiLabel = largeFileCleanupDecisionLabel(decision);
  const pairSeparator = getLang() === 'zh' ? '：' : ': ';
  const textParts = [];
  const htmlParts = [];
  if (localReason) {
    const label = getLang() === 'zh' ? '本地规则' : 'Local rule';
    textParts.push(`${label}${pairSeparator}${localReason}`);
    htmlParts.push(`<span class="cleanup-large-files-reason-line"><b>${escapeHtml(label)}</b>${pairSeparator}${escapeHtml(localReason)}</span>`);
  }
  if (aiIdentity) {
    const label = getLang() === 'zh' ? '文件识别' : 'File identity';
    textParts.push(`${label}${pairSeparator}${aiIdentity}`);
    htmlParts.push(`<span class="cleanup-large-files-reason-line"><b>${escapeHtml(label)}</b>${pairSeparator}${escapeHtml(aiIdentity)}</span>`);
  }
  if (aiLabel || aiReason) {
    const label = getLang() === 'zh' ? 'AI 建议' : 'AI suggestion';
    const valueSeparator = getLang() === 'zh' ? '：' : ': ';
    const value = [aiLabel, aiReason].filter(Boolean).join(aiReason && aiLabel ? valueSeparator : '');
    textParts.push(`${label}${pairSeparator}${value || '--'}`);
    htmlParts.push(`<span class="cleanup-large-files-reason-line"><b>${escapeHtml(label)}</b>${pairSeparator}${aiLabel ? `<strong class="cleanup-large-files-ai-label">${escapeHtml(aiLabel)}</strong>` : ''}${aiReason ? `${aiLabel ? valueSeparator : ''}${escapeHtml(aiReason)}` : ''}</span>`);
  }
  if (!textParts.length && !htmlParts.length) {
    textParts.push('--');
    htmlParts.push('<span class="cleanup-large-files-reason-line">--</span>');
  }
  return {
    text: textParts.join('\n'),
    html: htmlParts.join('')
  };
}

function closeLargeFileCleanupHoverToast(delay = 0) {
  if (largeFileCleanupHoverToastTimer) clearTimeout(largeFileCleanupHoverToastTimer);
  largeFileCleanupHoverToastTimer = setTimeout(() => {
    hoverToastScope.dispose();
    hoverToastScope = createLifecycleScope();
    largeFileCleanupHoverToast?.close?.();
    largeFileCleanupHoverToast = null;
    largeFileCleanupHoverToastTimer = null;
  }, Math.max(0, delay));
}

function showLargeFileCleanupReasonToast(text) {
  const message = String(text || '').trim();
  if (!message || message === '--') return;
  if (largeFileCleanupHoverToastTimer) {
    clearTimeout(largeFileCleanupHoverToastTimer);
    largeFileCleanupHoverToastTimer = null;
  }
  hoverToastScope.dispose();
  hoverToastScope = createLifecycleScope();
  largeFileCleanupHoverToast?.close?.();
  largeFileCleanupHoverToast = notify(message, {
    duration: 600000,
    className: 'cleanup-reason-toast'
  }) || null;
  const toastEl = largeFileCleanupHoverToast?.el;
  if (toastEl) {
    hoverToastScope.event(toastEl, 'mouseenter', () => {
      if (largeFileCleanupHoverToastTimer) {
        clearTimeout(largeFileCleanupHoverToastTimer);
        largeFileCleanupHoverToastTimer = null;
      }
    });
    hoverToastScope.event(toastEl, 'mouseleave', () => closeLargeFileCleanupHoverToast(900));
  }
}

function ensureLargeFileCleanupContextMenu() {
  if (largeFileCleanupContextMenu) return largeFileCleanupContextMenu;
  const menu = document.createElement('div');
  menu.className = 'cleanup-large-files-context-menu';
  menu.innerHTML = `
    <div class="cleanup-large-files-context-title"></div>
    <button type="button" class="cleanup-large-files-context-item" data-action="open-folder">
      <span class="cleanup-large-files-context-icon" aria-hidden="true">↗</span>
      <span>${escapeHtml(t('home.cleanupLargeFilesPage.contextOpenFolder'))}</span>
    </button>
  `;
  document.body.appendChild(menu);
  lifecycle.event(menu, 'click', async event => {
    const action = event.target.closest('[data-action]')?.dataset.action || '';
    if (action === 'open-folder' && largeFileCleanupContextCandidate) {
      await openLargeFileCleanupCandidateFolder(largeFileCleanupContextCandidate);
    }
    hideLargeFileCleanupContextMenu();
  });
  lifecycle.use(() => menu.remove());
  largeFileCleanupContextMenu = menu;
  return menu;
}

function hideLargeFileCleanupContextMenu() {
  if (!largeFileCleanupContextMenu) return;
  largeFileCleanupContextMenu.classList.remove('visible');
  largeFileCleanupContextCandidate = null;
}

function showLargeFileCleanupContextMenu(event, candidate) {
  if (!candidate) return;
  hideLargeFileCleanupContextMenu();
  largeFileCleanupContextCandidate = candidate;
  const menu = ensureLargeFileCleanupContextMenu();
  const title = menu.querySelector('.cleanup-large-files-context-title');
  if (title) title.textContent = candidate.name || displayFilesystemPath(candidate.path) || '';
  const openFolderLabel = menu.querySelector('[data-action="open-folder"] span:last-child');
  if (openFolderLabel) openFolderLabel.textContent = t('home.cleanupLargeFilesPage.contextOpenFolder');
  menu.classList.add('visible');
  const rect = menu.getBoundingClientRect();
  const padding = 10;
  const left = Math.min(window.innerWidth - rect.width - padding, Math.max(padding, event.clientX));
  const top = Math.min(window.innerHeight - rect.height - padding, Math.max(padding, event.clientY));
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
}

async function openLargeFileCleanupCandidateFolder(candidate) {
  if (!candidate?.path) return;
  try {
    const { invoke } = await tauriCore;
    await invoke('open_path', { path: candidate.path });
  } catch (error) {
    console.error('Open cleanup candidate folder failed:', error);
    notify(error?.message || (getLang() === 'zh' ? '打开所在文件夹失败。' : 'Failed to open containing folder.'));
  }
}

function largeFileCleanupRenderTable() {
  if (!largeFileCleanupTableBody) return;
  renderScope.dispose();
  renderScope = createLifecycleScope();
  syncLargeFileCleanupSizeSortUi();
  largeFileCleanupTableBody.innerHTML = '';
  if (!largeFileCleanupCandidates.length) {
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = 7;
    cell.className = 'cleanup-large-files-summary-empty';
    cell.textContent = largeFileCleanupBusy
      ? t('home.cleanupLargeFilesPage.scanning')
      : (largeFileCleanupEmptyMessage || t('home.cleanupLargeFilesPage.noResults'));
    row.appendChild(cell);
    largeFileCleanupTableBody.appendChild(row);
    largeFileCleanupUpdateSummary();
    largeFileCleanupSyncSelectionUi();
    return;
  }

  for (const candidate of largeFileCleanupSortedCandidates()) {
    const selected = largeFileCleanupSelectedPaths.has(candidate.path);
    const reasonDisplay = largeFileCleanupReasonDisplay(candidate);
    const mainRow = document.createElement('tr');
    mainRow.dataset.path = candidate.path;
    if (selected) mainRow.classList.add('is-selected');
    mainRow.innerHTML = `
      <td><input class="cleanup-large-files-check" type="checkbox" data-path="${escapeAttr(candidate.path)}"${selected ? ' checked' : ''}></td>
      <td>
        <span class="cleanup-large-files-item-main">${escapeHtml(candidate.name)}</span>
        <span class="cleanup-large-files-item-sub">${escapeHtml(displayFilesystemPath(candidate.path))}</span>
      </td>
      <td>${escapeHtml(formatFileSize(Number(candidate.size_bytes) || 0))}</td>
      <td>${escapeHtml(candidate.category || '--')}</td>
      <td>${escapeHtml(formatCleanupDate(candidate.modified_at, getLang()))}</td>
      <td>${escapeHtml(candidate.folder_hint || '--')}</td>
      <td><span class="cleanup-large-files-risk cleanup-large-files-risk-${escapeHtml(candidate.risk || 'medium')}">${escapeHtml(candidate.risk || 'medium')}</span></td>
    `;
    largeFileCleanupTableBody.appendChild(mainRow);

    const reasonRow = document.createElement('tr');
    reasonRow.dataset.path = candidate.path;
    reasonRow.className = 'cleanup-large-files-reason-row';
    if (selected) reasonRow.classList.add('is-selected');
    reasonRow.innerHTML = `
      <td colspan="7" class="cleanup-large-files-reason">
        <div class="cleanup-large-files-reason-preview" data-full-reason="${escapeAttr(reasonDisplay.text)}">${reasonDisplay.html}</div>
      </td>
    `;
    largeFileCleanupTableBody.appendChild(reasonRow);
  }

  largeFileCleanupTableBody.querySelectorAll('.cleanup-large-files-check').forEach(checkbox => {
    renderScope.event(checkbox, 'change', () => {
      const path = checkbox.dataset.path || '';
      if (!path) return;
      if (checkbox.checked) largeFileCleanupSelectedPaths.add(path);
      else largeFileCleanupSelectedPaths.delete(path);
      const row = checkbox.closest('tr');
      row?.classList.toggle('is-selected', checkbox.checked);
      const reasonRow = row?.nextElementSibling;
      if (reasonRow?.classList.contains('cleanup-large-files-reason-row')) {
        reasonRow.classList.toggle('is-selected', checkbox.checked);
      }
      largeFileCleanupSyncSelectionUi();
      largeFileCleanupUpdateSummary();
    });
  });
  largeFileCleanupTableBody.querySelectorAll('tr[data-path]').forEach(row => {
    renderScope.event(row, 'contextmenu', event => {
      event.preventDefault();
      event.stopPropagation();
      const candidate = largeFileCleanupCandidates.find(item => item.path === row.dataset.path);
      showLargeFileCleanupContextMenu(event, candidate);
    });
  });

  largeFileCleanupUpdateSummary();
  largeFileCleanupSyncSelectionUi();
}

function largeFileCleanupResetSelection() {
  largeFileCleanupSelectedPaths = new Set();
  largeFileCleanupRenderTable();
}

function largeFileCleanupSetCandidates(candidates, skippedDirs) {
  largeFileCleanupCandidates = Array.isArray(candidates) ? candidates.map((item, index) => ({ ...item, __default_index: index })) : [];
  largeFileCleanupSkippedDirs = Number(skippedDirs) || 0;
  largeFileCleanupSelectedPaths = new Set();
  largeFileCleanupAiProgressDone = 0;
  largeFileCleanupAiProgressTotal = 0;
  if (largeFileCleanupCandidates.length) {
    largeFileCleanupEmptyMessage = '';
    largeFileCleanupSummaryStatus = '';
  }
  largeFileCleanupRenderTable();
}

function largeFileCleanupOpen() {
  if (disposed || !largeFileCleanupOverlay || largeFileCleanupOverlay.classList.contains('visible')) return;
  openRevision += 1;
  largeFileCleanupOverlay.classList.add('visible');
  largeFileCleanupOverlay.setAttribute('aria-hidden', 'false');
  if (largeFileCleanupPlasmaBg && !largeFileCleanupPlasmaInstance) {
    largeFileCleanupPlasmaInstance = initStandardToolPlasma(largeFileCleanupPlasmaBg);
  }
  if (!largeFileCleanupRootPath) {
    const savedFolder = loadLargeFileCleanupFolder();
    if (savedFolder) largeFileCleanupRootPath = savedFolder;
  }
  largeFileCleanupSetFolderLabel(largeFileCleanupRootPath);
  refreshLargeFileCleanupDriveSpace(largeFileCleanupRootPath);
  largeFileCleanupSetThreshold(largeFileCleanupThreshold?.value || 50);
  largeFileCleanupSetMode(largeFileCleanupMode || 'video');
  largeFileCleanupUpdateSummary();
  largeFileCleanupRenderTable();
}

function largeFileCleanupClose() {
  if (largeFileCleanupBusyState()) {
    notify(getLang() === 'zh' ? '正在处理，请稍后再关闭。' : 'Please wait until the current cleanup task finishes.');
    return;
  }
  if (!largeFileCleanupOverlay) return;
  openRevision += 1;
  largeFileCleanupScanRunId += 1;
  largeFileCleanupAiRunId += 1;
  largeFileCleanupDeleteRunId += 1;
  largeFileCleanupDriveSpaceRunId += 1;
  closeLargeFileCleanupDriveRootOverlay(false);
  closeLargeFileCleanupSizeSortMenu(0);
  hideLargeFileCleanupContextMenu();
  closeLargeFileCleanupHoverToast(0);
  largeFileCleanupOverlay.classList.remove('visible');
  largeFileCleanupOverlay.setAttribute('aria-hidden', 'true');
  if (largeFileCleanupPlasmaInstance) {
    disposeStandardToolPlasma(largeFileCleanupPlasmaInstance);
    largeFileCleanupPlasmaInstance = null;
  }
}

async function chooseLargeFileCleanupFolder() {
  if (!isTauri) {
    notify(getLang() === 'zh' ? '仅支持桌面端选择清理目录。' : 'Folder selection is only available in the desktop app.');
    return;
  }
  const owner = openRevision;
  try {
    const { open } = await loadDialog();
    const selected = await open({ directory: true, multiple: false, title: getLang() === 'zh' ? '选择大文件扫描目录' : 'Choose a folder to scan' });
    if (!isCurrentOpen(owner)) return;
    if (typeof selected !== 'string' || !selected.trim()) return;
    largeFileCleanupRootPath = selected.trim();
    largeFileCleanupSetDriveSpace(null);
    saveLargeFileCleanupFolder(largeFileCleanupRootPath);
    largeFileCleanupSetFolderLabel(largeFileCleanupRootPath);
    largeFileCleanupUpdateSummary(getLang() === 'zh' ? '已选择目录' : 'Folder selected');
    notify(t('home.cleanupLargeFilesPage.folderSelected', { path: displayFilesystemPath(largeFileCleanupRootPath) }));
    refreshLargeFileCleanupDriveSpace(largeFileCleanupRootPath);
  } catch (error) {
    if (!isCurrentOpen(owner)) return;
    console.error('Choose cleanup folder failed:', error);
    notify(error?.message || (getLang() === 'zh' ? '选择目录失败。' : 'Failed to choose folder.'));
  }
}

function largeFileCleanupModeChipHandler(event) {
  const button = event.target.closest('[data-mode]');
  if (!button || largeFileCleanupBusyState()) return;
  largeFileCleanupSetMode(button.dataset.mode || 'video');
}

function largeFileCleanupCollectScanArgs() {
  const minSizeMb = Math.max(10, Math.min(102400, Number(largeFileCleanupThreshold?.value || 50) || 50));
  return {
    rootPath: largeFileCleanupRootPath,
    minSizeMb,
    mode: largeFileCleanupMode || 'video'
  };
}

function largeFileCleanupRootBlockedMessage(path) {
  const drive = largeFileCleanupDriveLetter(path) || 'C';
  return t('home.cleanupLargeFilesPage.rootBlockedDesc', { drive });
}

function closeLargeFileCleanupDriveRootOverlay(result = false) {
  if (largeFileCleanupDriveRootOverlay) {
    largeFileCleanupDriveRootOverlay.classList.remove('visible');
    largeFileCleanupDriveRootOverlay.setAttribute('aria-hidden', 'true');
  }
  const resolver = largeFileCleanupDriveRootResolver;
  largeFileCleanupDriveRootResolver = null;
  if (resolver) resolver(!!result);
}

function confirmLargeFileCleanupDataDriveRoot(path) {
  const drive = largeFileCleanupDriveLetter(path);
  if (!drive) return Promise.resolve(true);
  const driveLabel = largeFileCleanupDriveLabel(path);
  const title = t('home.cleanupLargeFilesPage.dataRootConfirmTitle', { drive });
  const desc = t('home.cleanupLargeFilesPage.dataRootConfirmDesc', { drive: driveLabel });
  if (largeFileCleanupDriveRootOverlay && largeFileCleanupDriveRootTitle && largeFileCleanupDriveRootDesc) {
    largeFileCleanupDriveRootTitle.textContent = title;
    largeFileCleanupDriveRootDesc.textContent = desc;
    largeFileCleanupDriveRootOverlay.classList.add('visible');
    largeFileCleanupDriveRootOverlay.setAttribute('aria-hidden', 'false');
    return new Promise(resolve => {
      largeFileCleanupDriveRootResolver = resolve;
    });
  }
  return Promise.resolve(window.confirm(`${title}\n\n${desc}`));
}

function largeFileCleanupFriendlyError(error) {
  const message = String(error?.message || error || '').trim();
  if (message.includes('System drive root is blocked') || message.includes('Please choose a user folder')) {
    return largeFileCleanupRootBlockedMessage(largeFileCleanupRootPath);
  }
  return message || t('home.cleanupLargeFilesPage.scanFailedDesc');
}

async function largeFileCleanupScan() {
  if (!isTauri) {
    notify(getLang() === 'zh' ? '仅支持桌面端扫描。' : 'Scanning is only available in the desktop app.');
    return;
  }
  if (largeFileCleanupBusyState()) return;
  const owner = openRevision;
  if (!largeFileCleanupRootPath) {
    await chooseLargeFileCleanupFolder();
    if (!isCurrentOpen(owner)) return;
    if (!largeFileCleanupRootPath) return;
  }
  const args = largeFileCleanupCollectScanArgs();
  if (!args.rootPath) {
    notify(t('home.cleanupLargeFilesPage.noFolderChosen'));
    return;
  }
  if (isLargeFileCleanupSystemDriveRoot(args.rootPath)) {
    refreshLargeFileCleanupDriveSpace(args.rootPath);
    largeFileCleanupCandidates = [];
    largeFileCleanupSkippedDirs = 0;
    largeFileCleanupSelectedPaths = new Set();
    largeFileCleanupEmptyMessage = largeFileCleanupRootBlockedMessage(args.rootPath);
    largeFileCleanupSummaryStatus = t('home.cleanupLargeFilesPage.rootBlockedTitle');
    largeFileCleanupRenderTable();
    notify(largeFileCleanupRootBlockedMessage(args.rootPath));
    return;
  }
  if (isLargeFileCleanupDriveRoot(args.rootPath)) {
    const confirmed = await confirmLargeFileCleanupDataDriveRoot(args.rootPath);
    if (!isCurrentOpen(owner)) return;
    if (!confirmed) {
      largeFileCleanupSummaryStatus = t('home.cleanupLargeFilesPage.dataRootCancelled');
      largeFileCleanupUpdateSummary();
      return;
    }
  }
  const runId = ++largeFileCleanupScanRunId;
  largeFileCleanupSetBusy(true, 'scan');
  largeFileCleanupSetDriveSpace(null);
  largeFileCleanupSetFolderLabel(args.rootPath);
  largeFileCleanupEmptyMessage = '';
  largeFileCleanupSummaryStatus = '';
  largeFileCleanupUpdateSummary(t('home.cleanupLargeFilesPage.scanning'));
  largeFileCleanupCandidates = [];
  largeFileCleanupSelectedPaths = new Set();
  largeFileCleanupAiProgressDone = 0;
  largeFileCleanupAiProgressTotal = 0;
  largeFileCleanupRenderTable();
  try {
    const { invoke } = await tauriCore;
    const result = await invoke('scan_large_files', {
      rootPath: args.rootPath,
      minSizeMb: args.minSizeMb,
      mode: args.mode
    });
    if (runId !== largeFileCleanupScanRunId) return;
    largeFileCleanupRootPath = result?.root_path || args.rootPath;
    saveLargeFileCleanupFolder(largeFileCleanupRootPath);
    largeFileCleanupMode = result?.mode || args.mode;
    largeFileCleanupSetDriveSpace(result?.drive_space || null);
    if (isLargeFileCleanupDriveRoot(largeFileCleanupRootPath) && !largeFileCleanupDriveSpace) {
      refreshLargeFileCleanupDriveSpace(largeFileCleanupRootPath);
    }
    largeFileCleanupSetFolderLabel(largeFileCleanupRootPath);
    largeFileCleanupThreshold && (largeFileCleanupThreshold.value = String(args.minSizeMb));
    largeFileCleanupSetCandidates(result?.candidates || [], result?.skipped_dirs || 0);
    if (!largeFileCleanupCandidates.length) {
      largeFileCleanupEmptyMessage = t('home.cleanupLargeFilesPage.noResults');
      notify(t('home.cleanupLargeFilesPage.noResults'));
      largeFileCleanupRenderTable();
    } else {
      notify(t('home.cleanupLargeFilesPage.scanComplete', {
        count: largeFileCleanupCandidates.length,
        size: formatFileSize(largeFileCleanupTotalBytes())
      }));
    }
  } catch (error) {
    if (runId !== largeFileCleanupScanRunId) return;
    console.error('Cleanup scan failed:', error);
    const friendlyMessage = largeFileCleanupFriendlyError(error);
    largeFileCleanupEmptyMessage = friendlyMessage;
    largeFileCleanupSummaryStatus = t('home.cleanupLargeFilesPage.scanFailedTitle');
    largeFileCleanupSetCandidates([], 0);
    notify(friendlyMessage);
  } finally {
    if (runId === largeFileCleanupScanRunId) {
      largeFileCleanupSetBusy(false);
      largeFileCleanupRenderTable();
      largeFileCleanupUpdateSummary();
      largeFileCleanupSyncSelectionUi();
    }
  }
}

function largeFileCleanupApplyAiDecisions(payload) {
  const items = Array.isArray(payload?.items) ? payload.items : Array.isArray(payload) ? payload : [];
  const byId = new Map(items.map(item => [String(item?.id || ''), item]));
  largeFileCleanupCandidates = largeFileCleanupCandidates.map(candidate => {
    const entry = byId.get(String(candidate.id || ''));
    if (!entry) return candidate;
    const decision = String(entry.decision || entry.action || entry.recommendation || '').toLowerCase();
    const aiDecision = decision === 'delete' || decision === 'remove' ? 'delete'
      : decision === 'keep' ? 'keep'
        : decision === 'review' || decision === 'check' || decision === 'uncertain' ? 'review'
          : '';
    const safeDecision = candidate.risk === 'high' && aiDecision === 'delete' ? 'review' : aiDecision;
    const rawAiIdentity = String(entry.identity || entry.file_identity || entry.what_is_file || entry.summary || entry.purpose || '').trim();
    const rawAiReason = String(entry.reason || entry.note || entry.explanation || '').trim();
    const aiReason = candidate.risk === 'high' && aiDecision === 'delete'
      ? `${getLang() === 'zh' ? '本地保护策略：高风险文件不会自动建议删除，已改为人工复核。AI 原因：' : 'Local safety policy: high-risk files are never auto-suggested for deletion, changed to review. AI reason: '}${rawAiReason}`
      : rawAiReason;
    return {
      ...candidate,
      ai_decision: safeDecision || candidate.ai_decision || '',
      ai_identity: rawAiIdentity || candidate.ai_identity || '',
      ai_reason: aiReason || candidate.ai_reason || ''
    };
  });
  largeFileCleanupSelectedPaths = new Set(
    largeFileCleanupCandidates
      .filter(candidate => (candidate.ai_decision || candidate.aiDecision) === 'delete')
      .map(candidate => candidate.path)
  );
  largeFileCleanupRenderTable();
}

async function largeFileCleanupAnalyze() {
  if (!largeFileCleanupCandidates.length) {
    notify(t('home.cleanupLargeFilesPage.noResults'));
    return;
  }
  if (!largeFileCleanupHasAiKey()) {
    requestAiKeyConfiguration();
    return;
  }
  if (largeFileCleanupBusyState()) return;
  const runId = ++largeFileCleanupAiRunId;
  largeFileCleanupAiProgressDone = 0;
  largeFileCleanupAiProgressTotal = largeFileCleanupCandidates.length;
  largeFileCleanupSetBusy(true, 'ai');
  largeFileCleanupUpdateSummary(t('home.cleanupLargeFilesPage.analysisRunning'));
  const batches = [];
  const batchSize = 16;
  for (let i = 0; i < largeFileCleanupCandidates.length; i += batchSize) {
    batches.push(largeFileCleanupCandidates.slice(i, i + batchSize));
  }
  const responseLanguage = getLang() === 'en' ? 'English' : '中文';
  const decisionHelp = getLang() === 'en'
    ? 'Use delete only for clearly redundant installers, archives, cache-like videos, or obvious downloads. Never return delete for high-risk items, chat folders, project/source folders, or model/development packages; return keep or review. Review anything uncertain. Explain what the file probably belongs to from its name and folder hint, but do not overclaim.'
    : '只对明显冗余的安装包、压缩包、缓存类视频、下载目录中的临时文件给出 delete。严禁对 high 风险项、聊天文件目录、项目源码目录、模型/开发包返回 delete；这类只能返回 keep 或 review。无法判断的给 review。需要根据文件名和目录线索解释文件大概属于什么软件/用途，但不要过度确定。';
  try {
    for (const batch of batches) {
      if (runId !== largeFileCleanupAiRunId) return;
      const prompt = [
        {
          role: 'system',
          content: `You are a careful local cleanup assistant. Only inspect file metadata, never ask for or infer file contents. Reply in ${responseLanguage} with strict JSON only. The JSON must be: {"items":[{"id":"...","identity":"...","decision":"delete|keep|review","reason":"..."}]}. "identity" explains what this file probably is or which app/component it likely belongs to, based on file name and folder hint. "reason" explains why the decision is safe or why human review is needed. Keep identity under 28 Chinese chars or 8 English words; keep reason under 90 Chinese chars or 35 English words. If file names or folder hints mention Devin, language_server, resources/app/extensions, identify them as Devin AI IDE main program or extension/runtime components when appropriate.`
        },
        {
          role: 'user',
          content: JSON.stringify({
            privacy_note: 'Only relative folder hints are provided. Absolute local paths and file contents are intentionally withheld.',
            mode: largeFileCleanupMode,
            threshold_mb: Number(largeFileCleanupThreshold?.value || 50) || 50,
            guidance: decisionHelp,
            items: batch.map(item => ({
              id: item.id,
              name: item.name,
              size_bytes: item.size_bytes,
              category: item.category,
              modified_at: item.modified_at,
              folder_hint: item.folder_hint,
              risk: item.risk,
              local_reason: item.local_reason
            }))
          }, null, 2)
        }
      ];
      const content = await requestAi(prompt, undefined, 1800);
      const parsed = largeFileCleanupExtractJson(content);
      if (parsed) {
        largeFileCleanupApplyAiDecisions(parsed);
      }
      largeFileCleanupAiProgressDone = Math.min(largeFileCleanupAiProgressTotal, largeFileCleanupAiProgressDone + batch.length);
      largeFileCleanupRenderAiCard();
    }
    if (runId === largeFileCleanupAiRunId) {
      notify(t('home.cleanupLargeFilesPage.analysisReady'));
    }
  } catch (error) {
    if (runId !== largeFileCleanupAiRunId) return;
    console.error('Cleanup AI analysis failed:', error);
    notify(error?.message || t('home.cleanupLargeFilesPage.aiNeedKey'));
  } finally {
    if (runId === largeFileCleanupAiRunId) {
      largeFileCleanupSetBusy(false);
      largeFileCleanupUpdateSummary();
      largeFileCleanupSyncSelectionUi();
    }
  }
}

function largeFileCleanupSelectAll(nextSelected) {
  largeFileCleanupSelectedPaths = new Set(
    nextSelected
      ? largeFileCleanupCandidates.map(item => item.path)
      : []
  );
  largeFileCleanupRenderTable();
}

function largeFileCleanupFriendlyRecycleError(error) {
  const result = classifyCleanupRecycleError(error);
  return result.key ? t(`home.cleanupLargeFilesPage.${result.key}`) : result.message;
}

function largeFileCleanupRenderFailureDetails(result) {
  if (!largeFileCleanupSuccessFailures) return;
  const failedItems = (Array.isArray(result?.items) ? result.items : []).filter(item => !item?.ok);
  if (!failedItems.length) {
    largeFileCleanupSuccessFailures.hidden = true;
    largeFileCleanupSuccessFailures.innerHTML = '';
    return;
  }
  const previewItems = failedItems.slice(0, 3);
  const rows = previewItems.map(item => {
    const name = cleanupFileNameFromPath(item?.path);
    const reason = largeFileCleanupFriendlyRecycleError(item?.error);
    return `<span title="${escapeAttr(`${name}：${reason}`)}">${escapeHtml(name)}：${escapeHtml(reason)}</span>`;
  });
  const remaining = failedItems.length - previewItems.length;
  if (remaining > 0) {
    rows.push(`<span>${escapeHtml(t('home.cleanupLargeFilesPage.deleteFailureMore', { count: remaining }))}</span>`);
  }
  rows.push(`<span>${escapeHtml(t('home.cleanupLargeFilesPage.deleteFailureHint'))}</span>`);
  largeFileCleanupSuccessFailures.innerHTML = `<strong>${escapeHtml(t('home.cleanupLargeFilesPage.deleteFailureTitle'))}</strong>${rows.join('')}`;
  largeFileCleanupSuccessFailures.hidden = false;
}

async function largeFileCleanupDeleteSelected() {
  if (!isTauri) {
    notify(getLang() === 'zh' ? '仅支持桌面端清理。' : 'Cleanup is only available in the desktop app.');
    return;
  }
  if (largeFileCleanupBusyState()) return;
  const selected = largeFileCleanupCandidates.filter(item => largeFileCleanupSelectedPaths.has(item.path));
  if (!selected.length) {
    notify(getLang() === 'zh' ? '请先勾选要移入回收站的文件。' : 'Please select files before moving them to the Recycle Bin.');
    return;
  }
  const selectedBytes = selected.reduce((sum, item) => sum + Number(item?.size_bytes || 0), 0);
  const confirmMessage = getLang() === 'zh'
    ? `确定将 ${selected.length} 个文件移入回收站吗？\n\n待释放约 ${formatFileSize(selectedBytes)}，清空回收站后才会真正释放磁盘空间。`
    : `Move ${selected.length} selected file(s) to the Recycle Bin?\n\nPending release about ${formatFileSize(selectedBytes)}. Disk space is freed only after emptying the Recycle Bin.`;
  if (!window.confirm(confirmMessage)) return;
  const owner = openRevision;
  const runId = ++largeFileCleanupDeleteRunId;
  largeFileCleanupSetBusy(true, 'delete');
  try {
    const { invoke } = await tauriCore;
    if (runId !== largeFileCleanupDeleteRunId || !isCurrentOpen(owner)) return;
    const result = await invoke('move_files_to_recycle_bin', {
      paths: selected.map(item => item.path)
    });
    if (runId !== largeFileCleanupDeleteRunId || !isCurrentOpen(owner)) return;
    const movedPaths = new Set((result?.items || []).filter(item => item?.ok).map(item => item.path));
    const failedPaths = new Set((result?.items || []).filter(item => !item?.ok).map(item => item.path));
    largeFileCleanupCandidates = largeFileCleanupCandidates.filter(item => !movedPaths.has(item.path));
    largeFileCleanupSelectedPaths = failedPaths;
    largeFileCleanupRenderTable();
    if (largeFileCleanupSuccessMeta) {
      largeFileCleanupSuccessMeta.textContent = t('home.cleanupLargeFilesPage.deleteSummary', {
        moved: Number(result?.moved || 0),
        failed: Number(result?.failed || 0),
        size: formatFileSize(Number(result?.freed_bytes || 0))
      });
    }
    largeFileCleanupRenderFailureDetails(result);
    if (largeFileCleanupSuccessAnalyzed) largeFileCleanupSuccessAnalyzed.textContent = String(largeFileCleanupAnalyzeCount());
    if (largeFileCleanupSuccessMoved) largeFileCleanupSuccessMoved.textContent = String(Number(result?.moved || 0));
    if (largeFileCleanupSuccessSize) largeFileCleanupSuccessSize.textContent = formatFileSize(Number(result?.freed_bytes || 0));
    if (largeFileCleanupSuccessFolder) largeFileCleanupSuccessFolder.textContent = t('home.cleanupLargeFilesPage.recycleNextStepValue');
    if (largeFileCleanupSuccessOverlay) largeFileCleanupSuccessOverlay.classList.add('visible');
  } catch (error) {
    if (runId !== largeFileCleanupDeleteRunId || !isCurrentOpen(owner)) return;
    console.error('Cleanup delete failed:', error);
    notify(error?.message || (getLang() === 'zh' ? '移入回收站失败。' : 'Failed to move files to the Recycle Bin.'));
  } finally {
    if (runId !== largeFileCleanupDeleteRunId || !isCurrentOpen(owner)) return;
    largeFileCleanupSetBusy(false);
    largeFileCleanupUpdateSummary();
    largeFileCleanupSyncSelectionUi();
  }
}

if (!largeFileCleanupRootPath) {
  const savedFolder = loadLargeFileCleanupFolder();
  if (savedFolder) {
    largeFileCleanupRootPath = savedFolder;
    largeFileCleanupSetFolderLabel(savedFolder);
  }
}

bind(largeFileCleanupBack, 'click', largeFileCleanupClose);
bind(largeFileCleanupChooseFolder, 'click', () => { void chooseLargeFileCleanupFolder(); });
bind(largeFileCleanupScanBtn, 'click', () => { void largeFileCleanupScan(); });
bind(largeFileCleanupAiBtn, 'click', () => { void largeFileCleanupAnalyze(); });
bind(largeFileCleanupSelectAllBtn, 'click', () => largeFileCleanupSelectAll(true));
bind(largeFileCleanupClearBtn, 'click', () => largeFileCleanupSelectAll(false));
bind(largeFileCleanupDeleteBtn, 'click', () => { void largeFileCleanupDeleteSelected(); });
bind(largeFileCleanupSelectAllCheckbox, 'change', () => largeFileCleanupSelectAll(!!largeFileCleanupSelectAllCheckbox.checked));
bind(largeFileCleanupModeGroup, 'click', largeFileCleanupModeChipHandler);
bind(largeFileCleanupSuccessOpenFolder, 'click', async () => {
  try {
    const { invoke } = await tauriCore;
    await invoke('open_recycle_bin');
  } catch (error) {
    console.error('Open recycle bin failed:', error);
    notify(getLang() === 'zh' ? '打开回收站失败，请手动从桌面或资源管理器打开。' : 'Failed to open Recycle Bin. Please open it manually.');
  }
});
bind(largeFileCleanupSuccessOk, 'click', () => {
  largeFileCleanupSuccessOverlay?.classList.remove('visible');
});
bind(largeFileCleanupDriveRootCancel, 'click', () => closeLargeFileCleanupDriveRootOverlay(false));
bind(largeFileCleanupDriveRootConfirm, 'click', () => closeLargeFileCleanupDriveRootOverlay(true));
bind(largeFileCleanupDriveRootOverlay?.querySelector('.ffmpeg-overlay-bg'), 'click', () => closeLargeFileCleanupDriveRootOverlay(false));
const sizeSortOriginalParent = largeFileCleanupSizeSortMenu?.parentNode || null;
const sizeSortOriginalNextSibling = largeFileCleanupSizeSortMenu?.nextSibling || null;
if (largeFileCleanupSizeSortMenu && largeFileCleanupSizeSortMenu.parentElement !== document.body) {
  document.body.appendChild(largeFileCleanupSizeSortMenu);
  lifecycle.use(() => {
    if (sizeSortOriginalParent) sizeSortOriginalParent.insertBefore(largeFileCleanupSizeSortMenu, sizeSortOriginalNextSibling);
  });
}
bind(largeFileCleanupSizeSort, 'mouseenter', () => {
  openLargeFileCleanupSizeSortMenu();
});
bind(largeFileCleanupSizeSort, 'mouseleave', () => {
  closeLargeFileCleanupSizeSortMenu(420);
});
bind(largeFileCleanupSizeSortMenu, 'mouseenter', () => {
  if (largeFileCleanupSizeSortCloseTimer) {
    clearTimeout(largeFileCleanupSizeSortCloseTimer);
    largeFileCleanupSizeSortCloseTimer = null;
  }
});
bind(largeFileCleanupSizeSortMenu, 'mouseleave', () => {
  closeLargeFileCleanupSizeSortMenu(420);
});
bind(largeFileCleanupSizeSortTrigger, 'click', event => {
  event.stopPropagation();
  if (largeFileCleanupSizeSort?.classList.contains('is-open')) {
    closeLargeFileCleanupSizeSortMenu(160);
  } else {
    openLargeFileCleanupSizeSortMenu();
  }
});
bind(largeFileCleanupSizeSortMenu, 'click', event => {
  const button = event.target.closest('[data-sort]');
  if (!button) return;
  event.stopPropagation();
  setLargeFileCleanupSortMode(button.dataset.sort || 'default');
});
bind(document, 'click', event => {
  if (largeFileCleanupContextMenu?.contains(event.target)) return;
  if (largeFileCleanupSizeSortMenu?.contains(event.target)) return;
  if (largeFileCleanupSizeSort?.contains(event.target)) return;
  closeLargeFileCleanupSizeSortMenu(0);
  hideLargeFileCleanupContextMenu();
});
bind(document, 'keydown', event => {
  if (event.key === 'Escape') {
    closeLargeFileCleanupSizeSortMenu(0);
    hideLargeFileCleanupContextMenu();
    closeLargeFileCleanupHoverToast(0);
  }
});
bind(largeFileCleanupOverlay, 'scroll', hideLargeFileCleanupContextMenu, { passive: true });
bind(largeFileCleanupBody, 'scroll', hideLargeFileCleanupContextMenu, { passive: true });
bind(document, 'toolknit:ai-key-change', () => {
  if (largeFileCleanupOverlay.classList.contains('visible')) largeFileCleanupRenderAiCard();
});

const unregisterLanguage = registerLanguageChange(() => {
  if (!largeFileCleanupOverlay?.classList.contains('visible')) return;
  largeFileCleanupSetFolderLabel(largeFileCleanupRootPath);
  largeFileCleanupRenderTable();
  syncLargeFileCleanupSizeSortUi();
  largeFileCleanupRenderAiCard();
});
lifecycle.use(unregisterLanguage);

return {
  open: largeFileCleanupOpen,
  close: largeFileCleanupClose,
  dispose() {
    if (disposed) return;
    disposed = true;
    largeFileCleanupBusy = false;
    largeFileCleanupClose();
    if (largeFileCleanupSizeSortCloseTimer) clearTimeout(largeFileCleanupSizeSortCloseTimer);
    if (largeFileCleanupHoverToastTimer) clearTimeout(largeFileCleanupHoverToastTimer);
    hoverToastScope.dispose();
    largeFileCleanupHoverToast?.close?.();
    renderScope.dispose();
    lifecycle.dispose();
  }
};
}
