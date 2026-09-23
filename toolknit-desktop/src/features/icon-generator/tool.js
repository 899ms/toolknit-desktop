import { applyTranslations } from '../../i18n.js';
import { createIconGeneratorController } from './controller.js';
import { iconGeneratorPageTemplate, iconGeneratorPortalTemplate } from './template.js';
import './icon-generator.css';

export function initIconGeneratorTool(context = {}) {
  const { overlay, refreshIcons = () => {} } = context;
  if (!overlay) throw new Error('icon-generator:missing-overlay');
  overlay.innerHTML = iconGeneratorPageTemplate();
  const template = document.createElement('template');
  template.innerHTML = iconGeneratorPortalTemplate();
  const portal = template.content.firstElementChild;
  if (!portal) throw new Error('icon-generator:missing-portal');
  document.body.append(portal);
  applyTranslations();
  refreshIcons();
  const controller = createIconGeneratorController({ ...context, overlay, portal });
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
