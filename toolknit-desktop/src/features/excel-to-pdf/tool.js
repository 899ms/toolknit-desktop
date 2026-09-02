import { createIcons, icons } from 'lucide';
import { createExcelToPdfController } from './controller.js';
import { excelToPdfTemplate } from './template.js';
import './excel-to-pdf.css';

export function initExcelToPdfTool(context = {}) {
  const { overlay } = context;
  if (!overlay) return { open() {}, close() {}, dispose() {} };

  overlay.innerHTML = excelToPdfTemplate();
  const refreshIcons = () => createIcons({ icons, attrs: { 'aria-hidden': 'true' } });
  refreshIcons();

  return createExcelToPdfController({ ...context, refreshIcons });
}
