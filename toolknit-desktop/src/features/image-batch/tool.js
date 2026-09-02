import { applyTranslations } from '../../i18n.js';
import { createImageBatchController } from './controller.js';
import { imageBatchPageTemplate, imageBatchPortalTemplate } from './template.js';
import './image-batch.css';

function createPortal(mode) {
  const template = document.createElement('template');
  template.innerHTML = imageBatchPortalTemplate(mode);
  const portal = template.content.firstElementChild;
  if (!portal) throw new Error(`image-batch:missing-portal:${mode}`);
  document.body.append(portal);
  return portal;
}

function initImageBatchTool(context, mode) {
  const { overlay, refreshIcons = () => {} } = context || {};
  if (!overlay) throw new Error(`image-batch:missing-overlay:${mode}`);
  overlay.innerHTML = imageBatchPageTemplate(mode);
  const portal = createPortal(mode);
  applyTranslations();
  refreshIcons();
  const controller = createImageBatchController({ ...context, overlay, portal, mode });
  return {
    open: (...args) => controller.open(...args),
    close: (...args) => controller.close(...args),
    dispose() {
      controller.dispose();
      portal.remove();
      overlay.replaceChildren();
    }
  };
}

export function initImageConvertTool(context) {
  return initImageBatchTool(context, 'convert');
}

export function initImageCompressTool(context) {
  return initImageBatchTool(context, 'compress');
}
