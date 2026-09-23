import { applyTranslations } from '../../i18n.js';
import { createIcons, icons } from 'lucide';
import { createPdfAiMarkdownController } from './controller.js';
import '../../styles/components/pdf-markdown-workspace.css';
import './pdf-ai-markdown.css';

export function initPdfAiMarkdownTool(context = {}) {
  const { overlay } = context;
  if (!overlay) throw new Error('pdf-ai-markdown:missing-overlay');
  applyTranslations(overlay);
  createIcons({ icons, attrs: { 'aria-hidden': 'true' } });
  return createPdfAiMarkdownController(context);
}
