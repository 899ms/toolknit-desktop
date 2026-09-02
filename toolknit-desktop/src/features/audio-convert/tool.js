import { createIcons, icons } from 'lucide';
import { applyTranslations } from '../../i18n.js';
import { audioConvertTemplate } from './template.js';
import { createAudioConvertController } from './controller.js';
import './audio-convert.css';

export function initAudioConvertTool(context = {}) {
  const { overlay } = context;
  if (!overlay) throw new Error('audio-convert:missing-overlay');
  overlay.innerHTML = audioConvertTemplate();
  applyTranslations();
  const refreshIcons = () => createIcons({ icons, attrs: { 'aria-hidden': 'true' } });
  refreshIcons();
  return createAudioConvertController({ ...context, overlay, refreshIcons });
}
