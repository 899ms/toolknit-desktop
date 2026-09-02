import { createIcons, icons } from 'lucide';
import { createMarkdownEditorController } from './controller.js';
import { markdownEditorTemplate } from './template.js';
import './markdown-editor.css';

export function initMarkdownEditorTool(context = {}) {
  const { overlay } = context;
  if (!overlay) throw new Error('markdown-editor:missing-overlay');

  overlay.innerHTML = markdownEditorTemplate();
  createIcons({ icons, attrs: { 'aria-hidden': 'true' } });
  return createMarkdownEditorController(context);
}
