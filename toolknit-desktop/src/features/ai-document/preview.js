function appendImagePlaceholder(element, label) {
  const placeholder = document.createElement('div');
  placeholder.className = 'ai-doc-img-placeholder';
  const icon = document.createElement('i');
  icon.dataset.lucide = 'image';
  const text = document.createElement('span');
  text.textContent = label;
  placeholder.append(icon, text);
  element.appendChild(placeholder);
}

export function renderAiDocTableCells(element, text) {
  const cells = String(text || '').split('|').map(cell => cell.trim()).filter(Boolean);
  if (cells.length < 2) {
    element.textContent = text || '';
    return;
  }
  element.replaceChildren(...cells.map(cellText => {
    const cell = document.createElement('span');
    cell.className = 'ai-doc-table-cell';
    cell.textContent = cellText;
    return cell;
  }));
}

function applyRegionBoxStyle(element, region) {
  const style = region.style || {};
  element.style.left = `${region.x || 0}px`;
  element.style.top = `${region.y || 0}px`;
  element.style.width = `${region.w || 200}px`;
  element.style.minHeight = `${region.h || 40}px`;
  element.style.height = 'auto';
  if (style.backgroundColor) element.style.backgroundColor = style.backgroundColor;
  if (style.borderColor) element.style.borderColor = style.borderColor;
  if (style.borderWidth !== undefined) {
    element.style.borderStyle = 'solid';
    element.style.borderWidth = `${style.borderWidth}px`;
  }
  if (style.opacity !== undefined) element.style.opacity = String(style.opacity);
}

export function createAiDocRegionReadOnly(region, imagePlaceholder) {
  const element = document.createElement('div');
  element.className = 'ai-doc-region';
  element.dataset.regionType = region.type;
  if (region.type === 'table-row' && region.bold) element.dataset.tableHeader = 'true';
  applyRegionBoxStyle(element, region);
  element.style.cursor = 'default';
  element.style.outline = 'none';

  if (region.type === 'image') {
    element.classList.add('ai-doc-region-image');
    if (region.imageData) {
      const image = document.createElement('img');
      image.src = region.imageData;
      element.appendChild(image);
    } else {
      appendImagePlaceholder(element, region.label || imagePlaceholder);
    }
    return element;
  }

  if (region.type === 'divider') {
    const divider = document.createElement('div');
    divider.style.cssText = 'width:100%;height:1px;background:#ccc;margin-top:4px';
    element.appendChild(divider);
    return element;
  }

  const text = document.createElement('div');
  text.className = 'ai-doc-region-text';
  text.textContent = region.text || '';
  text.style.fontWeight = region.bold ? 'bold' : 'normal';
  text.style.textAlign = region.align || 'left';
  text.style.fontSize = `${region.fontSize || 12}px`;
  const style = region.style || {};
  if (style.textColor) text.style.color = style.textColor;
  if (style.padding !== undefined) text.style.padding = `${style.padding}px`;
  if (style.lineHeight !== undefined) text.style.lineHeight = String(style.lineHeight);

  switch (region.type) {
    case 'title':
      text.style.fontWeight = 'bold';
      text.style.fontSize = `${region.fontSize || 24}px`;
      break;
    case 'subtitle':
      text.style.color = style.textColor || '#666';
      text.style.fontSize = `${region.fontSize || 13}px`;
      break;
    case 'section-heading':
      text.style.fontWeight = 'bold';
      text.style.fontSize = `${region.fontSize || 14}px`;
      text.style.borderBottom = '1px solid #ddd';
      text.style.paddingBottom = '4px';
      break;
    case 'sub-heading':
      text.style.fontWeight = 'bold';
      text.style.fontSize = `${region.fontSize || 12}px`;
      break;
    case 'page-header':
    case 'page-footer':
      text.style.color = style.textColor || '#999';
      text.style.fontSize = `${region.fontSize || 9}px`;
      break;
    case 'table-row':
      text.style.fontSize = `${region.fontSize || 13}px`;
      renderAiDocTableCells(text, region.text);
      break;
    case 'note':
      text.style.fontSize = `${region.fontSize || 10.5}px`;
      text.style.color = style.textColor || '#888';
      text.style.fontStyle = 'italic';
      break;
    case 'emphasis':
      text.style.fontWeight = 'bold';
      text.style.fontSize = `${region.fontSize || 12}px`;
      break;
    default:
      text.style.fontSize = `${region.fontSize || 14}px`;
  }
  element.appendChild(text);
  return element;
}

export function createAiDocumentPreview({
  empty,
  scroll,
  toolbar,
  meta,
  t,
  openEditor,
  refreshIcons = () => {}
}) {
  function clear() {
    if (empty) empty.style.display = '';
    if (scroll) {
      scroll.style.display = 'none';
      scroll.replaceChildren();
    }
    if (toolbar) toolbar.style.display = 'none';
    if (meta) meta.textContent = t('home.aiDoc.previewWaiting');
  }

  function render(data) {
    if (!scroll || !data?.pages) return;
    if (empty) empty.style.display = 'none';
    scroll.style.display = '';
    if (toolbar) toolbar.style.display = '';
    if (meta) meta.textContent = t('home.aiDoc.previewReady', { count: data.pages.length });
    scroll.replaceChildren();

    data.pages.forEach((page, pageIndex) => {
      const thumb = document.createElement('div');
      thumb.className = 'ai-doc-thumb';
      const content = document.createElement('div');
      content.className = 'ai-doc-thumb-content';
      for (const region of page.regions || []) {
        content.appendChild(createAiDocRegionReadOnly(region, t('home.aiDoc.imgPlaceholder')));
      }
      const hover = document.createElement('div');
      hover.className = 'ai-doc-thumb-overlay';
      const hoverText = document.createElement('div');
      hoverText.className = 'ai-doc-thumb-overlay-text';
      hoverText.textContent = t('home.aiDoc.clickToEdit');
      hover.appendChild(hoverText);
      const pageNumber = document.createElement('div');
      pageNumber.className = 'ai-doc-thumb-num';
      pageNumber.textContent = `${pageIndex + 1} / ${data.pages.length}`;
      thumb.append(content, hover, pageNumber);
      thumb.addEventListener('click', openEditor);
      scroll.appendChild(thumb);
    });
    refreshIcons();
  }

  return { clear, render };
}
