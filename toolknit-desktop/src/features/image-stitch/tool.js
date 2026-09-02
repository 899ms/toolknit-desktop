import { applyTranslations } from '../../i18n.js';
import { createImageStitchController } from './controller.js';
import { imageStitchPageTemplate } from './template.js';
import './image-stitch.css';

export function initImageStitchTool(context = {}) {
  const { overlay, refreshIcons = () => {} } = context;
  if (!overlay) throw new Error('image-stitch:missing-overlay');
  overlay.innerHTML = imageStitchPageTemplate();
  overlay.setAttribute('aria-hidden', 'true');
  applyTranslations();
  refreshIcons();
  const controller = createImageStitchController({
    ...context,
    openHelpOverlay: context.openHelp,
    overlay
  });
  return {
    open: (...args) => controller.open(...args),
    close: (...args) => controller.close(...args),
    dispose() {
      controller.dispose();
      overlay.replaceChildren();
    },
    get busy() { return controller.busy; },
    openWithFile: (...args) => controller.openWithFile?.(...args)
  };
}
