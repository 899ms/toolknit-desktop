/** Shared chrome for tool pages. The host application owns navigation actions. */
export function toolTopbarMarkup({ tag, title, closeAttr }) {
  const close = closeAttr || 'data-tool-close';
  return `<header class="tool-page-v2-topbar pdf-merge-v2-topbar" data-tauri-drag-region>
    <div class="tool-page-v2-topbar-left pdf-merge-v2-topbar-left">
      <button class="tool-page-v2-back settings-v2-back settings-back pdf-merge-v2-back" type="button" ${close} data-tool-close><i data-lucide="arrow-left"></i><span>返回首页</span></button>
      <span class="tool-page-v2-tag pdf-merge-v2-top-tag">${tag}</span>
    </div>
    <div class="tool-page-v2-top-actions home-v2-top-actions pdf-merge-v2-top-actions">
      <button class="tool-page-v2-nav-link home-v2-nav-link" type="button" data-tool-website><i data-lucide="globe-2"></i><span>网页版本</span></button>
      <button class="tool-page-v2-support home-v2-support-top" type="button" data-tool-support><i data-lucide="heart"></i><span>支持作者</span></button>
      <div class="home-v2-window-cluster" aria-label="窗口与设置">
        <button class="tool-page-v2-icon home-v2-icon-button" type="button" data-tool-settings title="设置" aria-label="设置"><i data-lucide="settings"></i></button>
        <div class="tool-page-v2-window-controls home-v2-window-controls" aria-label="窗口控制">
          <button class="tool-page-v2-icon home-v2-window-button" type="button" data-tool-window="minimize" title="最小化" aria-label="最小化"><i data-lucide="minus"></i></button>
          <button class="tool-page-v2-icon home-v2-window-button" type="button" data-tool-window="maximize" title="最大化" aria-label="最大化"><i data-lucide="square"></i></button>
          <button class="tool-page-v2-icon home-v2-window-button" type="button" data-tool-window="close" title="关闭" aria-label="关闭"><i data-lucide="x"></i></button>
        </div>
      </div>
    </div>
    <span class="tool-page-v2-title" aria-hidden="true">${title}</span>
  </header>`;
}
function clickHost(selector, excludeRoot = null) {
  const candidates = document.querySelectorAll?.(selector) || [];
  const button = Array.from(candidates).find(node => !excludeRoot?.contains?.(node));
  if (button) button.click();
}

/**
 * Move focus out of a region before it is hidden from assistive technology.
 * `blur()` is intentionally the final fallback: the host page may be hidden
 * behind a native window or another modal, so choosing an arbitrary fallback
 * element could move focus into a different inaccessible surface.
 */
export function moveFocusOutOfHiddenRegion(region, fallback = null) {
  const active = region?.ownerDocument?.activeElement || globalThis.document?.activeElement;
  if (!region?.contains?.(active)) return false;
  const next = fallback && !region.contains(fallback) ? fallback : null;
  if (next?.focus) {
    try { next.focus({ preventScroll: true }); } catch { next.focus(); }
  }
  if (region.contains(region.ownerDocument?.activeElement || globalThis.document?.activeElement)) {
    active?.blur?.();
  }
  return true;
}

/**
 * Install the one document-level owner for tool-page top chrome. Lazy tools
 * are mounted after startup and several legacy templates still use the old
 * data attributes, so delegation must live above individual feature roots.
 */
export function bindGlobalToolPageChrome({
  root = globalThis.document,
  onWebsite = () => {},
  onSupport = () => {},
  onSettings = () => {},
  onToolBack = () => {},
  onWindowAction = () => {}
} = {}) {
  if (!root?.addEventListener) return () => {};

  const visibleToolOverlay = target => {
    // Subpages may keep legacy Dialog/Workspace IDs while opting into the
    // same chrome. Their Back action stays with the owning feature.
    const overlay = target?.closest?.('[data-tool-page-chrome], [id$="Overlay"]');
    const visible = overlay?.classList?.contains('visible')
      || overlay?.getAttribute?.('aria-hidden') === 'false';
    return visible ? overlay : null;
  };
  const actionButton = target => target?.closest?.([
    '[data-tool-website]', '[data-home-link="website"]', '[data-ppt-host-action="website"]',
    '[data-excel-action="website"]', '[data-tele-action="website"]',
    '[data-audio-convert-action="website"]', '[data-audio-extract-action="website"]',
    '[data-bgr-action="website"]',
    '[data-tool-support]', '[data-open-support]', '[data-ppt-host-action="support"]',
    '[data-excel-action="support"]', '[data-tele-action="support"]',
    '[data-audio-convert-action="support"]', '[data-audio-extract-action="support"]',
    '[data-bgr-action="support"]',
    '[data-tool-settings]', '[data-ppt-host-action="settings"]', '[id$="V2Settings"]',
    '[data-excel-action="settings"]', '[data-tele-action="settings"]',
    '[data-audio-convert-action="settings"]', '[data-audio-extract-action="settings"]',
    '[data-bgr-action="settings"]',
    '[data-tool-window]', '[data-ppt-window-action]', '[data-window-action]',
    '.home-v2-window-controls [data-action]'
  ].join(', '));
  const isWindowButton = button => Boolean(button?.matches?.([
    '[data-tool-window]', '[data-ppt-window-action]', '[data-window-action]',
    '.home-v2-window-controls [data-action]'
  ].join(', ')));
  const isWindowCloseButton = target => Boolean(target?.closest?.([
    '[data-ppt-window-action="close"]', '[data-tool-window="close"]',
    '[data-window-action="close"]', '.home-v2-window-controls [data-action="close"]'
  ].join(', ')));
  const isToolBackButton = target => Boolean(target?.closest?.([
    '[data-tool-close]', '[data-excel-action="back"]', '[data-tele-action="back"]',
    '[data-audio-convert-action="back"]', '[data-audio-extract-action="back"]',
    '[data-bgr-action="back"]', '.tool-page-v2-back', '.pdf-merge-v2-back'
  ].join(', ')));

  const handleClick = event => {
    const target = event.target;
    const overlay = visibleToolOverlay(target);
    if (!overlay) return;
    if (isWindowCloseButton(target)) {
      // Run in capture phase before a feature listener can hide the overlay.
      // Closing is owned here so legacy and lazy templates share one native
      // window-control path and never leave focus inside an aria-hidden node.
      const button = actionButton(target);
      event.preventDefault?.();
      event.stopPropagation?.();
      moveFocusOutOfHiddenRegion(overlay);
      onWindowAction('close', { event, button, overlay });
      return;
    }
    if (isToolBackButton(target)) {
      moveFocusOutOfHiddenRegion(overlay);
      // When the registry owns this page, suppress the feature click listener
      // so it cannot hide the page before the shared curtain has closed.
      if (onToolBack({ event, button: actionButton(target), overlay }) === true) {
        event.preventDefault?.();
        event.stopPropagation?.();
      }
      return;
    }
    const button = actionButton(target);
    if (!button) return;
    const isWindow = isWindowButton(button);
    const settings = button.matches([
      '[data-tool-settings]', '[data-ppt-host-action="settings"]', '[id$="V2Settings"]',
      '[data-excel-action="settings"]', '[data-tele-action="settings"]',
      '[data-audio-convert-action="settings"]', '[data-audio-extract-action="settings"]',
      '[data-bgr-action="settings"]'
    ].join(', '));
    const support = button.matches([
      '[data-tool-support]', '[data-open-support]', '[data-ppt-host-action="support"]',
      '[data-excel-action="support"]', '[data-tele-action="support"]',
      '[data-audio-convert-action="support"]', '[data-audio-extract-action="support"]',
      '[data-bgr-action="support"]'
    ].join(', '));
    const website = button.matches([
      '[data-tool-website]', '[data-home-link="website"]', '[data-ppt-host-action="website"]',
      '[data-excel-action="website"]', '[data-tele-action="website"]',
      '[data-audio-convert-action="website"]', '[data-audio-extract-action="website"]',
      '[data-bgr-action="website"]'
    ].join(', '));
    if (!isWindow && !settings && !support && !website) return;
    event.preventDefault?.();
    event.stopPropagation?.();
    if (isWindow) {
      const action = button.dataset.toolWindow
        || button.dataset.pptWindowAction
        || button.dataset.windowAction
        || button.dataset.action;
      if (action) onWindowAction(action, { event, button, overlay });
    } else if (settings) {
      moveFocusOutOfHiddenRegion(overlay);
      onSettings({ event, button, overlay });
    } else if (support) {
      onSupport({ event, button, overlay });
    } else if (website) {
      onWebsite({ event, button, overlay });
    }
  };
  root.addEventListener('click', handleClick, true);
  return () => root.removeEventListener('click', handleClick, true);
}

export function bindToolPageChrome(root, onClose) {
  const handleClick = event => {
    if (event.target.closest('[data-tool-close]')) {
      event.preventDefault();
      onClose?.();
      return;
    }
    if (event.target.closest('[data-tool-website]')) {
      event.preventDefault();
      clickHost('[data-home-link="website"]');
      return;
    }
    if (event.target.closest('[data-tool-support]')) {
      event.preventDefault();
      clickHost('[data-open-support]');
      return;
    }
    if (event.target.closest('[data-tool-settings]')) {
      event.preventDefault();
      clickHost('#settingsBtn');
      return;
    }
    const windowButton = event.target.closest('[data-tool-window]');
    if (windowButton) {
      event.preventDefault();
      clickHost(`.global-window-controls [data-action="${windowButton.dataset.toolWindow}"]`);
    }
  };
  root.addEventListener('click', handleClick);
  return () => root.removeEventListener('click', handleClick);
}

export function mountToolPageBackground(shell) {
  if (!shell) return () => {};
  const background = document.createElement('div');
  background.className = 'tool-page-v2-bg';
  background.setAttribute('aria-hidden', 'true');
  shell.prepend(background);
  const disposeHost = window.toolknitToolBackground?.mount?.(background);
  return () => {
    try { disposeHost?.(); } catch { /* background cleanup is best effort */ }
    background.remove();
  };
}
