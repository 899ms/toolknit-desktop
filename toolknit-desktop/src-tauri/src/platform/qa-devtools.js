(() => {
  const installed = Symbol.for('toolknit.qa-devtools');
  if (window[installed]) return;
  window[installed] = true;
  let pending = false;
  document.addEventListener('keydown', event => {
    if (event.code !== 'F12' && event.key !== 'F12') return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (event.repeat || pending) return;
    pending = true;
    window.__TAURI_INTERNALS__.invoke('plugin:webview|internal_toggle_devtools')
      .catch(() => console.error('Could not toggle test-package DevTools.'))
      .finally(() => { pending = false; });
  }, true);
})();
