import { createIcons, icons } from 'lucide';
import { applyTranslations } from '../../i18n.js';
import { createBpmDetectController } from './bpm-controller.js';
import { createAudioClipController } from './clip-controller.js';
import './bpm.css';
import './audio-clip.css';

function initialize(context, createController) {
  const { overlay } = context || {};
  if (!overlay) throw new Error('audio-tools:missing-overlay');
  applyTranslations();
  const refreshIcons = () => createIcons({ icons, attrs: { 'aria-hidden': 'true' } });
  refreshIcons();
  return createController({ ...context, overlay, refreshIcons });
}

export function initBpmDetectTool(context) {
  return initialize(context, createBpmDetectController);
}

export function initAudioClipTool(context) {
  return initialize(context, createAudioClipController);
}
