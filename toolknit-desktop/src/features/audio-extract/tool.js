import { createIcons, icons } from 'lucide';
import { audioExtractTemplate } from './template.js';
import { createAudioExtractController } from './controller.js';
import './audio-extract.css';

export function initAudioExtractTool(context = {}) {
  const { overlay } = context;
  if (!overlay) throw new Error('audio-extract:missing-overlay');
  overlay.innerHTML = audioExtractTemplate();
  const refreshIcons = () => createIcons({ icons, attrs: { 'aria-hidden': 'true' } });
  refreshIcons();
  return createAudioExtractController({ ...context, overlay, refreshIcons });
}
