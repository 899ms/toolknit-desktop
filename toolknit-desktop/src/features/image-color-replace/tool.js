import { createIcons, icons } from 'lucide';
import { bindToolPageChrome, mountToolPageBackground } from '../../shared/tool-page-shell.js';
import { createImageColorReplaceController } from './controller.js';
import { imageColorReplaceTemplate } from './template.js';
import './image-color-replace.css';

export function initImageColorReplaceTool({
  overlay,
  isTauri = false,
  notify = (message, options) => window.showToast?.(message, options)
} = {}) {
  if (!overlay) throw new Error('color-replace:missing-overlay');

  overlay.innerHTML = imageColorReplaceTemplate();
  createIcons({ icons });
  const shell = overlay.querySelector('.tool-page-v2-shell');
  const controller = createImageColorReplaceController({ overlay, isTauri, notify });
  let backgroundDispose = null;
  let isOpen = false;
  let disposed = false;

  const api = {
    open() {
      if (disposed || isOpen) return;
      isOpen = true;
      backgroundDispose?.();
      backgroundDispose = mountToolPageBackground(shell);
      overlay.classList.add('visible');
      overlay.setAttribute('aria-hidden', 'false');
      controller.open();
    },
    close() {
      if (!isOpen) return;
      isOpen = false;
      controller.close();
      backgroundDispose?.();
      backgroundDispose = null;
      overlay.classList.remove('visible');
      overlay.setAttribute('aria-hidden', 'true');
    },
    dispose() {
      if (disposed) return;
      api.close();
      disposed = true;
      controller.dispose();
      disposeChrome();
      overlay.replaceChildren();
    }
  };

  const disposeChrome = bindToolPageChrome(shell, api.close);
  return api;
}
