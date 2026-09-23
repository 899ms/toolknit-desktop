import { convertPdfPagesToMarkdown } from './core.js';

export function createPdfTextResultPreview({ root, lifecycle, localize }) {
  const tabs = root.querySelector('.pdf-text-extract-page-tabs');
  const preview = root.querySelector('.pdf-text-extract-preview');
  let currentResult = null;
  let selectedIndex = 0;

  function showPage() {
    const page = currentResult?.pages?.[selectedIndex];
    if (!page) return;
    for (const [index, button] of [...tabs.children].entries()) {
      button.setAttribute('aria-pressed', String(index === selectedIndex));
      button.textContent = localize('previewPage', { page: currentResult.pages[index].pageNumber });
    }
    const markdown = page.error ? localize('previewFailed')
      : !page.hasText ? localize('previewEmpty')
      : convertPdfPagesToMarkdown([page], { includeTitle: false }).markdown
        .replace(/^<!-- generated-by:[^\n]*-->\s*/, '');
    preview.textContent = markdown.slice(0, 2000) + (markdown.length > 2000 ? '\n…' : '');
    preview.scrollTop = 0;
  }

  lifecycle.event(tabs, 'click', event => {
    const button = event.target.closest('button[data-preview-page]');
    if (!button || !tabs.contains(button)) return;
    selectedIndex = Number(button.dataset.previewPage);
    showPage();
  });

  function render(result) {
    if (result !== currentResult) {
      currentResult = result;
      selectedIndex = 0;
      tabs.replaceChildren();
      preview.textContent = '';
      for (const [index] of (result?.pages || []).entries()) {
        const button = document.createElement('button');
        button.type = 'button';
        button.dataset.previewPage = String(index);
        tabs.append(button);
      }
    }
    if (result) showPage();
  }

  return { render };
}
