import { createIcons, icons } from 'lucide';
import { t } from '../../i18n.js';
import { createImageCropController } from './controller.js';
import { imageCropSuccessTemplate, imageCropTemplate } from './template.js';
import './image-crop.css';

function createSuccessOverlay(overlay) {
  const existing = document.getElementById('imageCropSuccessOverlay');
  if (existing) return { element: existing, created: false };
  const template = document.createElement('template');
  template.innerHTML = imageCropSuccessTemplate();
  const element = template.content.firstElementChild;
  if (!element) throw new Error('image-crop:missing-success-template');
  overlay.insertAdjacentElement('afterend', element);
  return { element, created: true };
}

export function initImageCropTool(context = {}) {
  const { overlay } = context;
  if (!overlay) return { open() {}, close() {}, dispose() {} };

  overlay.innerHTML = imageCropTemplate();
  const success = createSuccessOverlay(overlay);
  overlay.querySelectorAll('[data-i18n]').forEach(element => {
    element.textContent = t(element.dataset.i18n);
  });
  const refreshIcons = () => createIcons({ icons, attrs: { 'aria-hidden': 'true' } });
  refreshIcons();
  const controller = createImageCropController({
    ...context,
    successOverlay: success.element,
    refreshIcons
  });

  return {
    open: (...args) => controller.open(...args),
    close: (...args) => controller.close(...args),
    dispose() {
      controller.dispose();
      if (success.created) success.element.remove();
      overlay.replaceChildren();
    }
  };
}
