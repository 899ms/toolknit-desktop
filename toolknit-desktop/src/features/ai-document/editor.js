import { createLifecycleScope } from '../../app/tool-lifecycle.js';
import {
  AI_DOC_LIMITS,
  AiDocLayoutError,
  assertAiDocImageBudget,
  cloneAiDocLayout,
  ensureAiDocEditorIds,
  isSupportedAiDocImage,
  moveAiDocRegionInFlow
} from '../../ai-doc-core.js';
import { getLang, t } from '../../i18n.js';
import { tauriCorePromise } from '../../platform/tauri-runtime.js';
import { renderAiDocTableCells } from './preview.js';

const A4_WIDTH = 794;
const A4_HEIGHT = 1123;
const HISTORY_LIMIT = 50;
const LOCKED_TYPES = new Set(['page-header', 'page-footer']);
const REGION_LABELS = Object.freeze({
  zh: {
    title: '标题', subtitle: '副标题', 'section-heading': '章节标题', 'sub-heading': '小标题',
    body: '正文', 'body-indent': '缩进正文', 'list-item': '列表项', image: '图片',
    signature: '签名', date: '日期', divider: '分隔线', 'page-header': '页眉',
    'page-footer': '页脚', 'table-row': '表格行', note: '注释', emphasis: '重点摘要'
  },
  en: {
    title: 'Title', subtitle: 'Subtitle', 'section-heading': 'Section', 'sub-heading': 'Subheading',
    body: 'Body', 'body-indent': 'Indented body', 'list-item': 'List item', image: 'Image',
    signature: 'Signature', date: 'Date', divider: 'Divider', 'page-header': 'Header',
    'page-footer': 'Footer', 'table-row': 'Table row', note: 'Note', emphasis: 'Emphasis'
  }
});

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

export function createAiDocumentEditor({
  isTauri = false,
  addChatMessage = () => {},
  refreshIcons = () => {},
  initStandardToolPlasma = () => null,
  disposeStandardToolPlasma = instance => instance,
  onExport = () => {},
  onClose = () => {}
} = {}) {
  const lifecycle = createLifecycleScope();
  const byId = id => document.getElementById(id);
  const overlay = byId('aiDocEditOverlay');
  const background = byId('aiDocEditBg');
  const scroll = byId('aiDocEditScroll');
  const back = byId('aiDocEditBack');
  const exportButton = byId('aiDocEditExportBtn');
  const undoButton = byId('aiDocUndoBtn');
  const redoButton = byId('aiDocRedoBtn');
  const moveUpButton = byId('aiDocMoveUpBtn');
  const moveDownButton = byId('aiDocMoveDownBtn');
  const deleteButton = byId('aiDocDeleteBtn');
  const selectionStatus = byId('aiDocSelectionStatus');
  const fontSizeInput = byId('aiDocFontSizeInput');
  const boldButton = byId('aiDocBoldBtn');
  const alignLeftButton = byId('aiDocAlignLeftBtn');
  const alignCenterButton = byId('aiDocAlignCenterBtn');
  const alignRightButton = byId('aiDocAlignRightBtn');
  const textColorInput = byId('aiDocTextColorInput');
  const backgroundColorInput = byId('aiDocBackgroundColorInput');
  const borderColorInput = byId('aiDocBorderColorInput');
  const moreStyleButton = byId('aiDocMoreStyleBtn');
  const styleInspector = byId('aiDocStyleInspector');
  const styleInspectorClose = byId('aiDocStyleInspectorClose');
  const lineHeightInput = byId('aiDocLineHeightInput');
  const paddingInput = byId('aiDocPaddingInput');
  const borderWidthInput = byId('aiDocBorderWidthInput');
  const opacityInput = byId('aiDocOpacityInput');
  const lineHeightValue = byId('aiDocLineHeightValue');
  const paddingValue = byId('aiDocPaddingValue');
  const borderWidthValue = byId('aiDocBorderWidthValue');
  const opacityValue = byId('aiDocOpacityValue');
  const globalAlignSelect = byId('aiDocGlobalAlignSelect');
  const applyGlobalStyleButton = byId('aiDocApplyGlobalStyleBtn');

  let layout = null;
  let selectedRegionId = null;
  let regionIdSeed = 0;
  let undoStack = [];
  let redoStack = [];
  let plasma = null;
  let session = null;
  let renderScope = null;

  const bind = (target, type, listener, options) => target && lifecycle.event(target, type, listener, options);
  const isOpenSession = candidate => candidate && candidate === session
    && !candidate.disposed && overlay?.classList.contains('visible');

  function createEditorId() {
    regionIdSeed += 1;
    return `ai-doc-${Date.now().toString(36)}-${regionIdSeed.toString(36)}`;
  }

  function initialFlowGap(previous, current) {
    if (!previous) return 0;
    if (previous.type === 'table-row' && current.type === 'table-row') return 0;
    if (previous.type === 'title' && current.type === 'subtitle') return 8;
    if (current.type === 'section-heading') return 10;
    return 4;
  }

  function prepareLayout(value) {
    const needsInitialOrder = (value?.pages || []).map(page => (
      !page.regions.every(region => typeof region.editorId === 'string' && region.editorId)
    ));
    const editable = ensureAiDocEditorIds(value, createEditorId);
    editable.pages.forEach((page, pageIndex) => {
      if (!needsInitialOrder[pageIndex]) return;
      page.regions.sort((left, right) => (left.y || 0) - (right.y || 0));
      let previous = null;
      page.regions.forEach(region => {
        if (LOCKED_TYPES.has(region.type)) return;
        if (!Number.isFinite(region.flowGap)) region.flowGap = initialFlowGap(previous, region);
        previous = region;
      });
    });
    return editable;
  }

  function findRegion(editorId) {
    if (!editorId || !layout?.pages) return null;
    for (let pageIndex = 0; pageIndex < layout.pages.length; pageIndex += 1) {
      const regionIndex = layout.pages[pageIndex].regions.findIndex(region => region.editorId === editorId);
      if (regionIndex >= 0) {
        return { pageIndex, regionIndex, region: layout.pages[pageIndex].regions[regionIndex] };
      }
    }
    return null;
  }

  function updateControls() {
    if (undoButton) undoButton.disabled = undoStack.length === 0;
    if (redoButton) redoButton.disabled = redoStack.length === 0;
    const selected = findRegion(selectedRegionId);
    const editable = Boolean(selected && !LOCKED_TYPES.has(selected.region.type));
    const editableText = Boolean(editable && !['image', 'divider'].includes(selected.region.type));
    const content = editable
      ? layout.pages[selected.pageIndex].regions.filter(region => !LOCKED_TYPES.has(region.type))
      : [];
    const position = content.findIndex(region => region.editorId === selectedRegionId);
    if (moveUpButton) moveUpButton.disabled = position <= 0;
    if (moveDownButton) moveDownButton.disabled = position < 0 || position >= content.length - 1;
    if (deleteButton) deleteButton.disabled = !editable;
    if (fontSizeInput) {
      fontSizeInput.disabled = !editableText;
      if (editableText) fontSizeInput.value = String(Math.round(selected.region.fontSize || 14));
    }
    if (boldButton) {
      boldButton.disabled = !editableText;
      boldButton.classList.toggle('active', Boolean(editableText && selected.region.bold));
      boldButton.setAttribute('aria-pressed', String(Boolean(editableText && selected.region.bold)));
    }
    const alignmentButtons = { left: alignLeftButton, center: alignCenterButton, right: alignRightButton };
    Object.entries(alignmentButtons).forEach(([alignment, button]) => {
      if (!button) return;
      button.disabled = !editableText;
      const active = Boolean(editableText && (selected.region.align || 'left') === alignment);
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    });

    const style = selected?.region?.style || {};
    const setColor = (input, value, fallback) => {
      if (!input) return;
      input.disabled = !editable;
      input.value = /^#[0-9a-f]{6}$/i.test(value || '') ? value : fallback;
      const swatch = input.previousElementSibling;
      if (!swatch?.style) return;
      if (input.parentElement?.classList.contains('ai-doc-color-control-text')) swatch.style.color = input.value;
      else swatch.style.backgroundColor = input.value;
    };
    setColor(textColorInput, style.textColor, selected?.region?.type === 'emphasis' ? '#ffffff' : '#242424');
    setColor(backgroundColorInput, style.backgroundColor, selected?.region?.type === 'emphasis' ? '#1b1b1b' : '#ffffff');
    setColor(borderColorInput, style.borderColor, '#d8d8d6');
    if (moreStyleButton) moreStyleButton.disabled = !editable;
    const syncRange = (input, output, value, fallback) => {
      if (!input) return;
      input.disabled = !editable;
      input.value = String(value ?? fallback);
      if (output) output.textContent = input.value;
    };
    syncRange(lineHeightInput, lineHeightValue, style.lineHeight, 1.58);
    syncRange(paddingInput, paddingValue, style.padding, 0);
    syncRange(borderWidthInput, borderWidthValue, style.borderWidth, 0);
    syncRange(opacityInput, opacityValue, style.opacity, 1);
    if (opacityValue) opacityValue.textContent = `${Math.round(Number(opacityInput?.value || 1) * 100)}%`;

    if (!selectionStatus) return;
    if (!selected) {
      selectionStatus.textContent = t('home.aiDoc.noLayerSelected');
      return;
    }
    const language = getLang() === 'en' ? 'en' : 'zh';
    selectionStatus.textContent = t('home.aiDoc.selectedLayer', {
      type: REGION_LABELS[language][selected.region.type] || selected.region.type,
      width: Math.round(selected.region.w || 0)
    });
  }

  function selectRegion(editorId) {
    selectedRegionId = editorId || null;
    scroll?.querySelectorAll('.ai-doc-region.selected').forEach(element => {
      element.classList.toggle('selected', element.dataset.editorId === selectedRegionId);
    });
    const selectedElement = selectedRegionId
      ? scroll?.querySelector(`.ai-doc-region[data-editor-id="${selectedRegionId}"]`)
      : null;
    selectedElement?.classList.add('selected');
    updateControls();
  }

  function recordEdit(previousLayout) {
    if (!previousLayout) return;
    undoStack.push(previousLayout);
    if (undoStack.length > HISTORY_LIMIT) undoStack.shift();
    redoStack = [];
    updateControls();
  }

  function applyHistory(value) {
    layout = prepareLayout(value);
    if (!findRegion(selectedRegionId)) selectedRegionId = null;
    render(layout);
  }

  function undo() {
    if (!undoStack.length || !layout) return;
    redoStack.push(cloneAiDocLayout(layout));
    applyHistory(undoStack.pop());
  }

  function redo() {
    if (!redoStack.length || !layout) return;
    undoStack.push(cloneAiDocLayout(layout));
    applyHistory(redoStack.pop());
  }

  function applySelectedStyle(patch) {
    const selected = findRegion(selectedRegionId);
    if (!selected || LOCKED_TYPES.has(selected.region.type)) return;
    const previous = cloneAiDocLayout(layout);
    for (const key of ['fontSize', 'bold', 'align']) {
      if (patch[key] !== undefined) selected.region[key] = patch[key];
    }
    const stylePatch = Object.fromEntries(
      Object.entries(patch).filter(([key]) => !['fontSize', 'bold', 'align'].includes(key))
    );
    if (Object.keys(stylePatch).length) selected.region.style = { ...(selected.region.style || {}), ...stylePatch };
    recordEdit(previous);
    render(layout);
  }

  function applyGlobalAlignment() {
    const alignment = globalAlignSelect?.value;
    if (!alignment || !layout?.pages) return;
    const previous = cloneAiDocLayout(layout);
    let changed = false;
    layout.pages.forEach(page => page.regions.forEach(region => {
      if (['image', 'divider', 'page-header', 'page-footer'].includes(region.type)) return;
      if (region.align !== alignment) {
        region.align = alignment;
        changed = true;
      }
    }));
    if (!changed) return;
    recordEdit(previous);
    render(layout);
  }

  function moveSelected(direction) {
    if (!layout || !selectedRegionId) return;
    const previous = cloneAiDocLayout(layout);
    const result = moveAiDocRegionInFlow(layout, selectedRegionId, direction);
    if (!result.moved) return;
    layout = result.layout;
    recordEdit(previous);
    render(layout);
  }

  function deleteSelected() {
    const selected = findRegion(selectedRegionId);
    if (!selected || LOCKED_TYPES.has(selected.region.type)) return;
    const previous = cloneAiDocLayout(layout);
    layout.pages[selected.pageIndex].regions.splice(selected.regionIndex, 1);
    selectedRegionId = null;
    recordEdit(previous);
    render(layout);
  }

  function bindDrag(element, editorId) {
    let dragging = false;
    let startX = 0;
    let startY = 0;
    let moved = false;
    let previous = null;
    renderScope.event(element, 'mousedown', event => {
      if (event.target.getAttribute('contenteditable') === 'true') return;
      if (event.target.classList.contains('ai-doc-resize-handle')) return;
      selectRegion(editorId);
      dragging = true;
      startX = event.clientX;
      startY = event.clientY;
      moved = false;
      previous = cloneAiDocLayout(layout);
      element.classList.add('dragging');
      event.preventDefault();
    });
    renderScope.event(document, 'mousemove', event => {
      if (!dragging) return;
      const deltaX = event.clientX - startX;
      const deltaY = event.clientY - startY;
      const image = findRegion(editorId)?.region.type === 'image';
      moved ||= Math.abs(deltaX) > 4 || Math.abs(deltaY) > 4;
      element.style.transform = image ? `translate(${deltaX}px, ${deltaY}px)` : `translateY(${deltaY}px)`;
    });
    renderScope.event(document, 'mouseup', event => {
      if (!dragging) return;
      dragging = false;
      element.classList.remove('dragging');
      element.style.transform = '';
      if (!moved) return;
      const selected = findRegion(editorId);
      if (!selected) return;
      const page = layout.pages[selected.pageIndex];
      const image = selected.region.type === 'image';
      let horizontalChanged = false;
      if (image) {
        const width = element.offsetWidth;
        const rawLeft = (parseFloat(element.style.left) || 0) + event.clientX - startX;
        const maxLeft = Math.max(0, A4_WIDTH - width);
        const targets = [0, 56, (A4_WIDTH - width) / 2, A4_WIDTH - 56 - width, maxLeft]
          .filter(value => value >= 0 && value <= maxLeft);
        const nearest = targets.reduce((best, target) => (
          Math.abs(target - rawLeft) < Math.abs(best - rawLeft) ? target : best
        ), Math.min(maxLeft, Math.max(0, rawLeft)));
        const nextLeft = Math.abs(nearest - rawLeft) <= 10 ? nearest : Math.min(maxLeft, Math.max(0, rawLeft));
        horizontalChanged = Math.round(nextLeft) !== Math.round(selected.region.x || 0);
        selected.region.x = Math.round(nextLeft);
      }
      const content = page.regions.filter(region => !LOCKED_TYPES.has(region.type));
      const others = content.filter(region => region.editorId !== editorId);
      const dropCenter = (parseFloat(element.style.top) || 0) + event.clientY - startY + element.offsetHeight / 2;
      let insertAt = 0;
      others.forEach(region => {
        const regionElement = scroll.querySelector(`[data-editor-id="${region.editorId}"]`);
        const center = (parseFloat(regionElement?.style.top) || region.y || 0)
          + (regionElement?.offsetHeight || region.h || 0) / 2;
        if (dropCenter > center) insertAt += 1;
      });
      const reordered = [...others];
      reordered.splice(insertAt, 0, selected.region);
      const sameOrder = content.map(region => region.editorId).join('|')
        === reordered.map(region => region.editorId).join('|');
      if (sameOrder && !horizontalChanged) return;
      if (!sameOrder) {
        const headers = page.regions.filter(region => region.type === 'page-header');
        const footers = page.regions.filter(region => region.type === 'page-footer');
        page.regions = [...headers, ...reordered, ...footers];
      }
      recordEdit(previous);
      render(layout);
    });
  }

  function bindResize(element, handle, editorId) {
    let resizing = false;
    let startX = 0;
    let startY = 0;
    let originalWidth = 0;
    let originalHeight = 0;
    let originalLeft = 0;
    let originalTop = 0;
    let anchor = 'right';
    let previous = null;
    renderScope.event(handle, 'mousedown', event => {
      event.stopPropagation();
      selectRegion(editorId);
      resizing = true;
      startX = event.clientX;
      startY = event.clientY;
      originalWidth = element.offsetWidth;
      originalHeight = element.offsetHeight;
      originalLeft = parseFloat(element.style.left) || 0;
      originalTop = parseFloat(element.style.top) || 0;
      anchor = handle.dataset.resizeAnchor || 'right';
      previous = cloneAiDocLayout(layout);
      event.preventDefault();
    });
    renderScope.event(document, 'mousemove', event => {
      if (!resizing) return;
      const selected = findRegion(editorId);
      if (!selected) return;
      const image = selected.region.type === 'image';
      const fromLeft = image && anchor === 'left';
      const minimumWidth = image ? 80 : 120;
      const deltaX = event.clientX - startX;
      const maxWidth = fromLeft ? originalLeft + originalWidth : A4_WIDTH - originalLeft;
      const width = Math.max(minimumWidth, Math.min(maxWidth, fromLeft
        ? originalWidth - deltaX
        : originalWidth + deltaX));
      const left = fromLeft ? originalLeft + originalWidth - width : originalLeft;
      element.style.width = `${width}px`;
      if (!image) {
        element.style.height = 'auto';
        element.style.minHeight = '0px';
        return;
      }
      const maxHeight = A4_HEIGHT - originalTop;
      const height = fromLeft
        ? Math.max(80, Math.min(maxHeight, Math.round(originalHeight * (width / Math.max(1, originalWidth)))))
        : Math.max(80, Math.min(maxHeight, originalHeight + event.clientY - startY));
      element.style.left = `${left}px`;
      element.style.height = `${height}px`;
      element.style.minHeight = `${height}px`;
    });
    renderScope.event(document, 'mouseup', () => {
      if (!resizing) return;
      resizing = false;
      const selected = findRegion(editorId);
      if (!selected) return;
      const width = Math.round(element.offsetWidth);
      const height = Math.round(element.offsetHeight);
      if (width === Math.round(selected.region.w || 0)
        && (selected.region.type !== 'image' || height === Math.round(selected.region.h || 0))) return;
      selected.region.w = width;
      selected.region.h = height;
      if (selected.region.type === 'image') {
        selected.region.x = Math.round(parseFloat(element.style.left) || 0);
        selected.region.imageHeight = height;
        selected.region.imageWidth = width;
      }
      recordEdit(previous);
      render(layout);
    });
  }

  function readAsDataUrl(source, owner) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      const release = owner.use(() => {
        reader.onload = null;
        reader.onerror = null;
        if (reader.readyState === FileReader.LOADING) reader.abort();
      });
      reader.onload = () => {
        const value = reader.result;
        release();
        resolve(value);
      };
      reader.onerror = () => {
        release();
        reject(new Error('FileReader error'));
      };
      reader.readAsDataURL(source);
    });
  }

  async function chooseImage(element, editorId) {
    const owner = session;
    if (!isOpenSession(owner)) return;
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.png,.jpg,.jpeg,image/png,image/jpeg';
    owner.event(input, 'change', async event => {
      const file = event.target.files?.[0];
      if (!file || !isOpenSession(owner)) return;
      const target = findRegion(editorId);
      if (!target || target.region.type !== 'image') return;
      if (!isSupportedAiDocImage(file)) {
        addChatMessage('ai', t('home.aiDoc.imageFormatError'));
        return;
      }
      if (Number.isFinite(file.size) && file.size > AI_DOC_LIMITS.maxImageBytes) {
        addChatMessage('ai', t('home.aiDoc.imageTooLarge', { max: 10 }));
        return;
      }
      const mime = file.type === 'image/png' || /\.png$/i.test(file.name || '') ? 'image/png' : 'image/jpeg';
      let byteLength = Number(file.size);
      if (!Number.isSafeInteger(byteLength) || byteLength < 0) {
        addChatMessage('ai', t('home.aiDoc.imageReadError'));
        return;
      }
      try {
        let dataUrl;
        if (isTauri && file.path) {
          const { invoke } = await tauriCorePromise;
          const fileSize = Number(await invoke('get_file_size', { path: file.path }));
          if (!isOpenSession(owner)) return;
          if (!Number.isSafeInteger(fileSize) || fileSize < 0 || fileSize > AI_DOC_LIMITS.maxImageBytes) {
            addChatMessage('ai', t('home.aiDoc.imageTooLarge', { max: 10 }));
            return;
          }
          byteLength = fileSize;
          const raw = await invoke('read_file_bytes', { path: file.path });
          if (!isOpenSession(owner)) return;
          const bytes = Array.isArray(raw) ? Uint8Array.from(raw) : new Uint8Array(raw);
          if (bytes.byteLength > AI_DOC_LIMITS.maxImageBytes) {
            addChatMessage('ai', t('home.aiDoc.imageTooLarge', { max: 10 }));
            return;
          }
          dataUrl = await readAsDataUrl(new Blob([bytes], { type: mime }), owner);
        } else {
          dataUrl = await readAsDataUrl(file, owner);
        }
        if (!isOpenSession(owner)) return;
        const existingBytes = layout?.pages?.reduce((total, page) => total + (page.regions || [])
          .reduce((pageTotal, region) => {
            const bytes = Number(region.imageByteLength);
            return region.editorId === editorId || !Number.isSafeInteger(bytes) || bytes <= 0
              ? pageTotal
              : pageTotal + bytes;
          }, 0), 0) || 0;
        assertAiDocImageBudget(existingBytes, byteLength);
        const image = new Image();
        owner.use(() => {
          image.onload = null;
          image.onerror = null;
          image.src = '';
        });
        image.onload = () => {
          if (!isOpenSession(owner)) return;
          const current = findRegion(editorId);
          if (!current || current.region.type !== 'image') return;
          if (!image.naturalWidth || !image.naturalHeight
            || image.naturalWidth * image.naturalHeight > AI_DOC_LIMITS.maxImagePixels) {
            addChatMessage('ai', t('home.aiDoc.imageDimensionsTooLarge'));
            return;
          }
          const previous = cloneAiDocLayout(layout);
          const width = current.region.w || parseInt(element.style.width, 10) || 200;
          const height = Math.min(Math.round(image.naturalHeight * (width / image.naturalWidth)), 500);
          const finalWidth = Math.round(image.naturalWidth * (height / image.naturalHeight));
          Object.assign(current.region, {
            imageData: dataUrl,
            imageWidth: finalWidth,
            imageHeight: height,
            imageByteLength: byteLength,
            w: finalWidth,
            h: height
          });
          recordEdit(previous);
          render(layout);
        };
        image.onerror = () => {
          if (isOpenSession(owner)) addChatMessage('ai', t('home.aiDoc.imageReadError'));
        };
        image.src = dataUrl;
      } catch (error) {
        if (!isOpenSession(owner)) return;
        if (error instanceof AiDocLayoutError && error.code === 'images_too_large') {
          addChatMessage('ai', t('home.aiDoc.imagesTooLarge', { max: 40 }));
        } else {
          console.error('[AI Doc] Image read failed:', error);
          addChatMessage('ai', t('home.aiDoc.imageReadError'));
        }
      }
    }, { once: true });
    input.click();
  }

  function createRegion(region, pageIndex, regionIndex) {
    const element = document.createElement('div');
    element.className = 'ai-doc-region';
    element.dataset.regionType = region.type;
    if (region.type === 'table-row' && region.bold) element.dataset.tableHeader = 'true';
    region.editorId ||= createEditorId();
    element.dataset.editorId = region.editorId;
    element.dataset.pageIdx = pageIndex;
    element.dataset.regionIdx = regionIndex;
    element.style.left = `${region.x || 0}px`;
    element.style.top = `${region.y || 0}px`;
    element.style.width = `${region.w || 200}px`;
    element.style.minHeight = `${region.h || 40}px`;
    element.style.height = 'auto';
    const style = region.style || {};
    if (style.backgroundColor) element.style.backgroundColor = style.backgroundColor;
    if (style.borderColor) element.style.borderColor = style.borderColor;
    if (style.borderWidth !== undefined) {
      element.style.borderStyle = 'solid';
      element.style.borderWidth = `${style.borderWidth}px`;
    }
    if (style.opacity !== undefined) element.style.opacity = String(style.opacity);
    const locked = LOCKED_TYPES.has(region.type);
    if (locked) element.classList.add('locked');

    if (region.type === 'image') {
      element.classList.add('ai-doc-region-image');
      const height = region.imageHeight || region.h || 120;
      element.style.height = `${height}px`;
      element.style.minHeight = `${height}px`;
      if (region.imageData) {
        const image = document.createElement('img');
        image.src = region.imageData;
        image.style.cssText = `width:100%;height:${region.imageHeight ? `${region.imageHeight}px` : 'auto'};display:block;object-fit:contain`;
        element.appendChild(image);
      } else {
        appendImagePlaceholder(element, region.label || t('home.aiDoc.imgUploadHint'));
      }
      renderScope.event(element, 'dblclick', () => { void chooseImage(element, region.editorId); });
    } else if (region.type === 'divider') {
      const divider = document.createElement('div');
      divider.style.cssText = 'width:100%;height:1px;background:#ccc;margin-top:4px';
      element.appendChild(divider);
    } else {
      const text = document.createElement('div');
      text.className = 'ai-doc-region-text';
      text.textContent = region.text || '';
      text.style.fontSize = `${region.fontSize || 12}px`;
      text.style.fontWeight = region.bold ? 'bold' : 'normal';
      text.style.textAlign = region.align || 'left';
      if (style.textColor) text.style.color = style.textColor;
      if (style.padding !== undefined) text.style.padding = `${style.padding}px`;
      if (style.lineHeight !== undefined) text.style.lineHeight = String(style.lineHeight);
      const sizeDefaults = {
        title: 24, subtitle: 13, 'section-heading': 14, 'sub-heading': 12,
        'page-header': 9, 'page-footer': 9, 'list-item': 11, 'body-indent': 12,
        signature: 12, date: 12, 'table-row': 13, note: 10.5, emphasis: 12, body: 14
      };
      text.style.fontSize = `${region.fontSize || sizeDefaults[region.type] || 14}px`;
      if (['title', 'section-heading', 'sub-heading', 'emphasis'].includes(region.type)) text.style.fontWeight = 'bold';
      if (region.type === 'subtitle') text.style.color = style.textColor || '#666';
      if (LOCKED_TYPES.has(region.type)) text.style.color = style.textColor || '#999';
      if (region.type === 'section-heading') {
        text.style.borderBottom = '1px solid #ddd';
        text.style.paddingBottom = '4px';
      }
      if (region.type === 'note') {
        text.style.color = style.textColor || '#777';
        text.style.fontStyle = 'italic';
      }
      if (region.type === 'emphasis') text.style.color = style.textColor || '#333';
      if (region.type === 'table-row') {
        renderAiDocTableCells(text, region.text);
        text.querySelectorAll('.ai-doc-table-cell').forEach(cell => {
          if (style.dividerColor || style.borderColor) cell.style.borderLeftColor = style.dividerColor || style.borderColor;
          if (style.dividerWidth !== undefined) cell.style.borderLeftWidth = `${style.dividerWidth}px`;
        });
      }
      element.appendChild(text);
      let editSnapshot = null;
      renderScope.event(element, 'dblclick', event => {
        if (locked) return;
        event.stopPropagation();
        selectRegion(region.editorId);
        editSnapshot = cloneAiDocLayout(layout);
        if (region.type === 'table-row') text.textContent = region.text || '';
        text.setAttribute('contenteditable', 'true');
        text.focus();
        const range = document.createRange();
        range.selectNodeContents(text);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
      });
      renderScope.event(text, 'blur', () => {
        text.removeAttribute('contenteditable');
        const selected = findRegion(region.editorId);
        if (!selected) return;
        const nextText = text.textContent;
        if (selected.region.text !== nextText) {
          selected.region.text = nextText;
          recordEdit(editSnapshot);
          editSnapshot = null;
          const frame = requestAnimationFrame(() => render(layout));
          renderScope?.use(() => cancelAnimationFrame(frame));
        } else if (region.type === 'table-row') {
          renderAiDocTableCells(text, selected.region.text);
        }
      });
      renderScope.event(text, 'keydown', event => {
        if (event.key === 'Escape') text.blur();
      });
    }

    if (!locked) {
      renderScope.event(element, 'click', event => {
        if (event.target.getAttribute('contenteditable') === 'true') return;
        event.stopPropagation();
        selectRegion(region.editorId);
      });
      bindDrag(element, region.editorId);
      for (const anchor of region.type === 'image' ? ['left', 'corner'] : ['right']) {
        const handle = document.createElement('div');
        handle.className = `ai-doc-resize-handle ai-doc-resize-handle-${anchor}`;
        handle.dataset.resizeAnchor = anchor;
        element.appendChild(handle);
        bindResize(element, handle, region.editorId);
      }
    }
    return element;
  }

  function render(source, { preserveScroll = true } = {}) {
    if (!scroll || !source?.pages || !isOpenSession(session)) return;
    const previousScroll = preserveScroll ? { top: scroll.scrollTop, left: scroll.scrollLeft } : null;
    const data = prepareLayout(source);
    renderScope?.dispose();
    renderScope = createLifecycleScope();
    scroll.replaceChildren();
    const PAGE_TOP = 60;
    const PAGE_BOTTOM = 1060;
    const FOOTER_Y = 1085;
    const newPages = [];
    const flowGap = (previous, current) => {
      if (!previous) return 0;
      if (Number.isFinite(current.flowGap)) return Math.max(0, Math.min(42, current.flowGap));
      if (previous.type === 'table-row' && current.type === 'table-row') return 0;
      if (previous.type === 'title' && current.type === 'subtitle') return 10;
      return current.type === 'section-heading' ? 20 : 12;
    };
    const createPage = () => {
      const page = document.createElement('div');
      page.className = 'ai-doc-page';
      page.style.width = `${A4_WIDTH}px`;
      page.style.minHeight = `${A4_HEIGHT}px`;
      renderScope.event(page, 'mousedown', event => {
        if (event.target === page) selectRegion(null);
      });
      scroll.appendChild(page);
      return page;
    };
    const balance = (page, regions) => {
      const content = regions.filter(region => !LOCKED_TYPES.has(region.type));
      if (content.length < 5) return;
      const last = content.at(-1);
      const usedBottom = (last.y || PAGE_TOP) + (last.h || 0);
      if (usedBottom >= 900) return;
      const indexes = content.map((region, index) => index > 0 && flowGap(content[index - 1], region) > 0 ? index : -1)
        .filter(index => index >= 0);
      if (!indexes.length) return;
      const extra = Math.min(28, Math.max(0, (920 - usedBottom) / indexes.length));
      if (extra < 1) return;
      let offset = 0;
      content.forEach((region, index) => {
        if (indexes.includes(index)) {
          region.flowGap = Math.round((flowGap(content[index - 1], region) + extra) * 100) / 100;
          offset += extra;
        }
        if (!offset) return;
        region.y += offset;
        const element = page.querySelector(`[data-editor-id="${region.editorId}"]`);
        if (element) element.style.top = `${region.y}px`;
      });
    };

    data.pages.forEach(sourcePage => {
      if (!sourcePage.regions?.length) return;
      const header = sourcePage.regions.find(region => region.type === 'page-header');
      const footer = sourcePage.regions.find(region => region.type === 'page-footer');
      const content = sourcePage.regions.filter(region => !LOCKED_TYPES.has(region.type));
      let pageIndex = newPages.length;
      let pageElement = createPage();
      let pageRegions = [];
      let currentY = PAGE_TOP;
      let previous = null;
      const appendHeader = () => {
        if (!header) return;
        const region = { ...header, y: 30 };
        pageElement.appendChild(createRegion(region, pageIndex, pageRegions.length));
        pageRegions.push(region);
      };
      const appendFooter = () => {
        const region = {
          ...(footer || { type: 'page-footer', x: 56, w: 682, h: 18, fontSize: 9, bold: false, align: 'center' }),
          editorId: createEditorId(), y: FOOTER_Y, text: ''
        };
        pageElement.appendChild(createRegion(region, pageIndex, pageRegions.length));
        pageRegions.push(region);
      };
      appendHeader();
      for (const region of content) {
        region.y = currentY + flowGap(previous, region);
        let element = createRegion(region, pageIndex, pageRegions.length);
        pageElement.appendChild(element);
        if (!['image', 'divider'].includes(region.type)) element.style.minHeight = '0px';
        const minimum = region.type === 'image' ? region.imageHeight || region.h || 100
          : region.type === 'divider' ? 2 : region.type === 'title' ? 32 : region.type === 'section-heading' ? 24 : 16;
        const actualHeight = Math.max(minimum, element.offsetHeight);
        if (region.y + actualHeight > PAGE_BOTTOM && pageRegions.some(item => !LOCKED_TYPES.has(item.type))) {
          element.remove();
          balance(pageElement, pageRegions);
          appendFooter();
          newPages.push({ regions: pageRegions });
          pageIndex = newPages.length;
          pageElement = createPage();
          pageRegions = [];
          currentY = PAGE_TOP;
          previous = null;
          appendHeader();
          region.y = currentY;
          element = createRegion(region, pageIndex, pageRegions.length);
          pageElement.appendChild(element);
          if (!['image', 'divider'].includes(region.type)) element.style.minHeight = '0px';
        }
        region.h = actualHeight;
        element.style.minHeight = `${actualHeight}px`;
        currentY = region.y + actualHeight;
        pageRegions.push(region);
        previous = region;
      }
      balance(pageElement, pageRegions);
      appendFooter();
      newPages.push({ regions: pageRegions });
    });
    data.pages = newPages;
    layout = data;
    const pages = scroll.querySelectorAll('.ai-doc-page');
    pages.forEach((page, pageIndex) => {
      const regions = data.pages[pageIndex]?.regions || [];
      const footerIndex = regions.findIndex(region => region.type === 'page-footer');
      if (footerIndex >= 0) {
        const text = t('home.aiDoc.pageOfTotal', { current: pageIndex + 1, total: pages.length });
        regions[footerIndex].text = text;
        const element = page.querySelector(`.ai-doc-region[data-page-idx="${pageIndex}"][data-region-idx="${footerIndex}"] .ai-doc-region-text`);
        if (element) element.textContent = text;
      }
      const pageNumber = document.createElement('div');
      pageNumber.className = 'ai-doc-page-num';
      pageNumber.textContent = `${pageIndex + 1} / ${pages.length}`;
      page.appendChild(pageNumber);
    });
    selectRegion(selectedRegionId);
    refreshIcons();
    if (previousScroll) {
      const frame = requestAnimationFrame(() => {
        if (!isOpenSession(session) || !scroll.isConnected) return;
        scroll.scrollTop = Math.min(previousScroll.top, Math.max(0, scroll.scrollHeight - scroll.clientHeight));
        scroll.scrollLeft = Math.min(previousScroll.left, Math.max(0, scroll.scrollWidth - scroll.clientWidth));
      });
      renderScope.use(() => cancelAnimationFrame(frame));
    }
  }

  function setLayout(value, { resetHistory = true } = {}) {
    layout = value ? prepareLayout(value) : null;
    if (resetHistory) {
      selectedRegionId = null;
      undoStack = [];
      redoStack = [];
    }
    updateControls();
    return layout;
  }

  function open() {
    if (!overlay || !layout) return false;
    session?.dispose();
    session = createLifecycleScope();
    overlay.classList.add('visible');
    scroll.scrollTop = 0;
    scroll.scrollLeft = 0;
    session.event(document, 'keydown', event => {
      if (!overlay.classList.contains('visible') || event.target?.getAttribute?.('contenteditable') === 'true') return;
      const modifier = event.ctrlKey || event.metaKey;
      if (modifier && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        if (event.shiftKey) redo(); else undo();
      } else if (modifier && event.key.toLowerCase() === 'y') {
        event.preventDefault();
        redo();
      } else if (event.key === 'Delete' || event.key === 'Backspace') {
        event.preventDefault();
        deleteSelected();
      }
    });
    render(layout, { preserveScroll: false });
    if (background && !plasma) plasma = initStandardToolPlasma(background);
    return true;
  }

  function close({ notify = true } = {}) {
    const wasVisible = overlay?.classList.contains('visible');
    overlay?.classList.remove('visible');
    session?.dispose();
    session = null;
    renderScope?.dispose();
    renderScope = null;
    scroll?.replaceChildren();
    plasma = disposeStandardToolPlasma(plasma);
    if (notify && wasVisible && layout) onClose(layout);
  }

  function reset() {
    close({ notify: false });
    layout = null;
    selectedRegionId = null;
    undoStack = [];
    redoStack = [];
    updateControls();
  }

  bind(back, 'click', () => close());
  bind(exportButton, 'click', () => { void onExport(); });
  bind(undoButton, 'click', undo);
  bind(redoButton, 'click', redo);
  bind(moveUpButton, 'click', () => moveSelected(-1));
  bind(moveDownButton, 'click', () => moveSelected(1));
  bind(deleteButton, 'click', deleteSelected);
  bind(fontSizeInput, 'change', () => {
    const size = Number(fontSizeInput.value);
    if (Number.isFinite(size)) applySelectedStyle({ fontSize: Math.max(6, Math.min(96, Math.round(size))) });
  });
  bind(boldButton, 'click', () => {
    const selected = findRegion(selectedRegionId);
    if (selected) applySelectedStyle({ bold: !selected.region.bold });
  });
  bind(alignLeftButton, 'click', () => applySelectedStyle({ align: 'left' }));
  bind(alignCenterButton, 'click', () => applySelectedStyle({ align: 'center' }));
  bind(alignRightButton, 'click', () => applySelectedStyle({ align: 'right' }));
  bind(textColorInput, 'change', () => applySelectedStyle({ textColor: textColorInput.value.toUpperCase() }));
  bind(backgroundColorInput, 'change', () => applySelectedStyle({ backgroundColor: backgroundColorInput.value.toUpperCase() }));
  bind(borderColorInput, 'change', () => applySelectedStyle({ borderColor: borderColorInput.value.toUpperCase(), borderWidth: 1 }));
  bind(moreStyleButton, 'click', () => {
    const visible = !styleInspector?.classList.contains('visible');
    styleInspector?.classList.toggle('visible', visible);
    styleInspector?.setAttribute('aria-hidden', String(!visible));
  });
  bind(styleInspectorClose, 'click', () => {
    styleInspector?.classList.remove('visible');
    styleInspector?.setAttribute('aria-hidden', 'true');
  });
  const bindRange = (input, output, key, format = value => value) => {
    bind(input, 'input', () => { if (output) output.textContent = format(input.value); });
    bind(input, 'change', () => {
      const value = Number(input.value);
      if (Number.isFinite(value)) applySelectedStyle({ [key]: value });
    });
  };
  bindRange(lineHeightInput, lineHeightValue, 'lineHeight');
  bindRange(paddingInput, paddingValue, 'padding');
  bindRange(borderWidthInput, borderWidthValue, 'borderWidth');
  bindRange(opacityInput, opacityValue, 'opacity', value => `${Math.round(Number(value) * 100)}%`);
  bind(applyGlobalStyleButton, 'click', applyGlobalAlignment);

  return {
    close,
    dispose() {
      reset();
      lifecycle.dispose();
    },
    getLayout: () => layout,
    open,
    reset,
    setLayout
  };
}
