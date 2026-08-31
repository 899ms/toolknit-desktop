/** Shared chrome for tool pages. The host application owns navigation actions. */
export function toolTopbarMarkup({ tag, title, closeAttr }) {
  const close = closeAttr || 'data-tool-close';
  return `<header class="pdf-merge-v2-topbar tool-page-v2-topbar" data-tauri-drag-region>
    <div class="pdf-merge-v2-topbar-left tool-page-v2-topbar-left">
      <button class="settings-v2-back settings-back pdf-merge-v2-back tool-page-v2-back" type="button" ${close} data-tool-close><i data-lucide="arrow-left"></i><span>返回</span></button>
      <span class="pdf-merge-v2-top-tag tool-page-v2-tag">${tag}</span>
    </div>
    <div class="home-v2-top-actions pdf-merge-v2-top-actions tool-page-v2-top-actions">
      <button class="home-v2-nav-link tool-page-v2-nav-link" type="button" data-tool-website><i data-lucide="globe-2"></i><span>网页版本</span></button>
      <button class="home-v2-support-top tool-page-v2-support" type="button" data-tool-support><i data-lucide="heart"></i><span>支持作者</span></button>
      <div class="home-v2-window-cluster" aria-label="窗口与设置">
        <button class="home-v2-icon-button tool-page-v2-icon" type="button" data-tool-settings title="设置" aria-label="设置"><i data-lucide="settings"></i></button>
        <div class="home-v2-window-controls tool-page-v2-window-controls" aria-label="窗口控制">
          <button class="home-v2-window-button tool-page-v2-icon" type="button" data-tool-window="minimize" title="最小化" aria-label="最小化"><i data-lucide="minus"></i></button>
          <button class="home-v2-window-button tool-page-v2-icon" type="button" data-tool-window="maximize" title="最大化" aria-label="最大化"><i data-lucide="square"></i></button>
          <button class="home-v2-window-button tool-page-v2-icon" type="button" data-tool-window="close" title="关闭" aria-label="关闭"><i data-lucide="x"></i></button>
        </div>
      </div>
    </div>
    <span class="tool-page-v2-title" aria-hidden="true">${title}</span>
  </header>`;
}
function clickHost(selector) {
  const button = document.querySelector(selector);
  if (button) button.click();
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
