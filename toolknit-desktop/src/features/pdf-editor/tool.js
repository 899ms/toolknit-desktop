import { createIcons, icons } from 'lucide';
import { initPdfEditorTool as createPdfEditorTool } from './controller.js';

// The editor markup is mounted lazily, after the application's initial Lucide
// scan. Refresh the mounted subtree immediately so its static chrome is never
// dependent on another feature having rendered icons first.
const refreshIcons = () => createIcons({ icons, attrs: { 'aria-hidden': 'true' } });

export function initPdfEditorTool(context = {}) {
  refreshIcons();
  return createPdfEditorTool({ ...context, refreshIcons });
}
