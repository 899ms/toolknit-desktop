import { applyTranslations } from '../../i18n.js';
import { createIcons, icons } from 'lucide';
import { createPdfTextMarkdownController } from './controller.js';
import './pdf-text-extract.css';

export function initPdfTextMarkdownTool(context = {}) {
  const { overlay } = context;
  if (!overlay) throw new Error('pdf-text-extract:missing-overlay');
  applyTranslations(overlay);
  createIcons({ icons, attrs: { 'aria-hidden': 'true' } });
  return createPdfTextMarkdownController(context);
}
