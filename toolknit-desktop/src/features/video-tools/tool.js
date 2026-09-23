import { applyTranslations } from '../../i18n.js';
import { enhanceToolSelects } from '../../tool-custom-select.js';
import { createVideoConvertController } from './convert-controller.js';
import { createVideoFrameController } from './frame-controller.js';
import { createVideoGifController } from './gif-controller.js';
import './video-tools.css';

function initialize(context, createController) {
  const { overlay, refreshIcons = () => {} } = context || {};
  if (!overlay) throw new Error('video-tools:missing-overlay');
  applyTranslations();
  refreshIcons();
  return createController({ ...context, overlay, refreshIcons });
}

export function initVideoConvertTool(context) {
  const { overlay } = context || {};
  const customSelects = enhanceToolSelects([overlay?.querySelector('#videoConvertFormatOptions')]);
  const controller = initialize(context, createVideoConvertController);
  return {
    open: (...args) => controller.open(...args),
    close: (...args) => {
      customSelects.forEach(select => select.close());
      return controller.close?.(...args);
    },
    dispose() {
      customSelects.forEach(select => select.close());
      controller.dispose?.();
      customSelects.forEach(select => select.dispose());
    }
  };
}

export function initVideoFrameTool(context) {
  return initialize(context, createVideoFrameController);
}

export function initVideoGifTool(context) {
  return initialize(context, createVideoGifController);
}
