import { applyTranslations } from '../../i18n.js';
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
  return initialize(context, createVideoConvertController);
}

export function initVideoFrameTool(context) {
  return initialize(context, createVideoFrameController);
}

export function initVideoGifTool(context) {
  return initialize(context, createVideoGifController);
}

