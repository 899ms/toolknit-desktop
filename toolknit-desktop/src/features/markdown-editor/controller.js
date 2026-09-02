import DOMPurify from 'dompurify';
import mermaid from 'mermaid';
import { EditorState } from '@codemirror/state';
import {
  EditorView,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, redo, undo } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { bracketMatching, defaultHighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { createLifecycleScope } from '../../app/tool-lifecycle.js';
import { loadTauriDialog, tauriCorePromise } from '../../platform/tauri-runtime.js';
import { bindToolPageChrome, mountToolPageBackground } from '../../shared/tool-page-shell.js';
import {
  DEFAULT_MARKDOWN,
  MARKDOWN_DRAFT_KEY,
  applyMarkdownAction,
  buildStandaloneMarkdownHtml,
  createMarkdownRenderer,
  extractMarkdownHeadings,
  extractMarkdownHeadingsFromTokens,
  rewriteMarkdownImages,
  sanitizeExportBaseName
} from './core.js';
import {
  markdownPreviewAssetUrl,
  safeLivePreviewFragment
} from './preview-security.js';

export const MARKDOWN_ASSET_KEY = 'toolknit.markdown.assets.v1';
export const MAX_MARKDOWN_ASSETS = 20;
export const MAX_MARKDOWN_ASSET_BYTES = 15 * 1024 * 1024;
export const MAX_MARKDOWN_ASSET_TOTAL_BYTES = 40 * 1024 * 1024;
export const MAX_MARKDOWN_LIVE_CHARS = 500_000;
export const MAX_MARKDOWN_OUTLINE_HEADINGS = 500;

const encoder = new TextEncoder();

function bytesToDataUrl(bytes, mime) {
  const binary = Uint8Array.from(bytes || []);
  let raw = '';
  for (let index = 0; index < binary.length; index += 0x8000) {
    raw += String.fromCharCode(...binary.subarray(index, index + 0x8000));
  }
  return `data:${mime};base64,${btoa(raw)}`;
}

function readStoredAssets() {
  let stored = [];
  try {
    stored = JSON.parse(localStorage.getItem(MARKDOWN_ASSET_KEY) || '[]');
  } catch {
    stored = [];
  }
  if (!Array.isArray(stored)) return [];
  return stored
    .filter(item => item?.sourcePath && item?.token)
    .slice(0, MAX_MARKDOWN_ASSETS)
    .map(item => ({ ...item, previewDataUrl: '' }));
}

function imageMetadata(path) {
  const extension = (String(path).split('.').pop() || 'png').toLowerCase();
  const mime = {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    svg: 'image/svg+xml'
  }[extension] || `image/${extension}`;
  return { extension, mime };
}

export function createMarkdownEditorController({
  overlay,
  notify = message => window.showToast?.(message),
  isTauri = Boolean(window.__TAURI_INTERNALS__)
} = {}) {
  if (!overlay) throw new Error('markdown-editor:missing-overlay');

  const lifecycle = createLifecycleScope();
  const shell = overlay.querySelector('.tool-page-v2-shell');
  const preview = overlay.querySelector('[data-md-preview]');
  const outline = overlay.querySelector('[data-md-outline]');
  const workspace = overlay.querySelector('[data-md-workspace]');
  const workbench = overlay.querySelector('.md-workbench');
  const helpPage = overlay.querySelector('[data-md-help-page]');
  const helpAction = overlay.querySelector('[data-md-help]');
  const draftState = overlay.querySelector('[data-md-draft-state]');
  const count = overlay.querySelector('[data-md-count]');
  const renderer = createMarkdownRenderer();
  const exportRenderer = createMarkdownRenderer('mathml');
  let assets = readStoredAssets();
  let editor = null;
  let session = null;
  let renderTimer = 0;
  let renderRevision = 0;
  let hydrateRevision = 0;
  let activeOutlineTargetId = '';
  let currentView = 'split';
  let exporting = false;
  let disposed = false;
  const highlightTimers = new Set();

  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    theme: 'neutral',
    fontFamily: 'system-ui, sans-serif',
    htmlLabels: false
  });

  const invoke = async (command, args) => {
    const api = await tauriCorePromise;
    return api.invoke(command, args);
  };
  const isOpenSession = owner => owner && owner === session && !owner.disposed
    && overlay.classList.contains('visible') && !disposed;

  function currentText() {
    const text = editor?.state.doc.toString() || '';
    assets = assets.filter(asset => asset?.token && text.includes(asset.token));
    return text;
  }

  function activeAssets() {
    currentText();
    return assets;
  }

  function persistableAssets() {
    return activeAssets().map(({ id, token, sourcePath, fileName, mime }) => ({
      id,
      token,
      sourcePath,
      fileName,
      mime
    }));
  }

  function saveDraft() {
    if (!editor) return;
    try {
      localStorage.setItem(MARKDOWN_DRAFT_KEY, currentText());
      localStorage.setItem(MARKDOWN_ASSET_KEY, JSON.stringify(persistableAssets()));
      draftState.textContent = '草稿已保存在本机';
    } catch {
      draftState.textContent = '草稿空间不足，请及时导出';
    }
  }

  function sourceForRender(text) {
    let result = text;
    for (const asset of assets) {
      if (asset.previewDataUrl) result = result.split(asset.token).join(asset.previewDataUrl);
    }
    return result;
  }

  function sourceForLivePreview(text) {
    let result = text;
    for (const asset of assets) {
      if (asset.previewDataUrl) {
        result = result.split(asset.token).join(markdownPreviewAssetUrl(asset.id));
      }
    }
    return result;
  }

  function updateOutlineActive(targetId) {
    outline.querySelectorAll('[data-md-target]').forEach(button => {
      const active = button.dataset.mdTarget === targetId;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-current', active ? 'location' : 'false');
    });
  }

  function renderOutline(headings) {
    const fragment = document.createDocumentFragment();
    if (headings.length === 0) {
      const empty = document.createElement('p');
      empty.textContent = '添加标题后，这里会形成可跳转的目录。';
      fragment.append(empty);
    } else {
      for (const item of headings.slice(0, MAX_MARKDOWN_OUTLINE_HEADINGS)) {
        const button = document.createElement('button');
        button.type = 'button';
        button.style.setProperty('--level', String(item.level));
        button.dataset.mdLine = String(item.line);
        button.dataset.mdTarget = item.id;
        button.title = item.text;
        const label = document.createElement('span');
        label.textContent = item.text;
        button.append(label);
        fragment.append(button);
      }
      if (headings.length > MAX_MARKDOWN_OUTLINE_HEADINGS) {
        const capped = document.createElement('p');
        capped.textContent = `目录仅显示前 ${MAX_MARKDOWN_OUTLINE_HEADINGS} 个标题。`;
        fragment.append(capped);
      }
    }
    outline.replaceChildren(fragment);
  }

  async function hydrateAssets(owner) {
    const revision = ++hydrateRevision;
    assets = assets.map(({ id, token, sourcePath, fileName, mime }) => ({
      id,
      token,
      sourcePath,
      fileName,
      mime,
      previewDataUrl: ''
    }));
    const pending = assets.filter(asset => asset.sourcePath);
    let totalBytes = 0;

    for (const asset of pending) {
      if (!isOpenSession(owner) || revision !== hydrateRevision
        || totalBytes >= MAX_MARKDOWN_ASSET_TOTAL_BYTES) break;
      try {
        const bytes = await invoke('read_file_bytes_limited', {
          path: asset.sourcePath,
          maxBytes: Math.min(
            MAX_MARKDOWN_ASSET_BYTES,
            MAX_MARKDOWN_ASSET_TOTAL_BYTES - totalBytes
          )
        });
        if (!isOpenSession(owner) || revision !== hydrateRevision) break;
        totalBytes += bytes.length;
        asset.previewDataUrl = bytesToDataUrl(bytes, asset.mime || 'application/octet-stream');
      } catch {
        asset.previewDataUrl = '';
      }
    }
    if (isOpenSession(owner) && revision === hydrateRevision && editor) {
      void renderDocument(owner);
    }
  }

  async function renderDocument(owner) {
    if (!isOpenSession(owner) || !editor) return;
    const revision = ++renderRevision;
    const text = currentText();
    count.textContent = `${text.length.toLocaleString()} 字符`;
    if (text.length > MAX_MARKDOWN_LIVE_CHARS) {
      const warning = document.createElement('div');
      warning.className = 'md-render-error';
      warning.textContent = '文档超过 50 万字符，实时预览已暂停；内容仍会自动保存并可正常导出。';
      preview.replaceChildren(warning);
      const outlineWarning = document.createElement('p');
      outlineWarning.textContent = '文档较长，目录预览已暂停。';
      outline.replaceChildren(outlineWarning);
      return;
    }

    const env = {};
    const tokens = renderer.parse(sourceForLivePreview(text), env);
    const headings = extractMarkdownHeadingsFromTokens(tokens);
    const html = renderer.renderer.render(tokens, renderer.options, env);
    const clean = DOMPurify.sanitize(html, {
      USE_PROFILES: { html: true, svg: true, svgFilters: true },
      ADD_ATTR: ['aria-hidden']
    });
    if (!isOpenSession(owner) || revision !== renderRevision) return;

    preview.replaceChildren(safeLivePreviewFragment(clean, assets));
    preview.querySelectorAll('h1,h2,h3,h4,h5,h6').forEach((node, index) => {
      if (!headings[index]) return;
      node.id = headings[index].id;
      node.dataset.line = String(headings[index].line);
    });

    const diagrams = Array.from(preview.querySelectorAll('pre > code.language-mermaid'));
    for (let index = 0; index < diagrams.length; index += 1) {
      if (!isOpenSession(owner) || revision !== renderRevision) return;
      const code = diagrams[index];
      try {
        const { svg } = await mermaid.render(
          `tk-mermaid-${owner.token()}-${revision}-${index}`,
          code.textContent
        );
        if (!isOpenSession(owner) || revision !== renderRevision || !code.parentElement) return;
        const wrap = document.createElement('div');
        wrap.className = 'mermaid';
        wrap.innerHTML = DOMPurify.sanitize(svg, {
          USE_PROFILES: { svg: true, svgFilters: true }
        });
        code.parentElement.replaceWith(wrap);
      } catch (error) {
        if (!isOpenSession(owner) || revision !== renderRevision || !code.parentElement) return;
        code.parentElement.classList.add('md-render-error');
        code.parentElement.title = String(error?.message || error);
      }
    }

    if (!isOpenSession(owner) || revision !== renderRevision) return;
    renderOutline(headings);
    if (!headings.some(item => item.id === activeOutlineTargetId)) {
      activeOutlineTargetId = headings[0]?.id || '';
    }
    updateOutlineActive(activeOutlineTargetId);
  }

  function scheduleRender() {
    const owner = session;
    if (!isOpenSession(owner)) return;
    clearTimeout(renderTimer);
    draftState.textContent = '正在保存草稿...';
    renderTimer = setTimeout(() => {
      renderTimer = 0;
      if (!isOpenSession(owner)) return;
      saveDraft();
      void renderDocument(owner);
    }, 180);
  }

  function buildEditor(owner) {
    if (editor || !isOpenSession(owner)) return;
    const draft = localStorage.getItem(MARKDOWN_DRAFT_KEY);
    editor = new EditorView({
      parent: overlay.querySelector('[data-md-editor]'),
      state: EditorState.create({
        doc: draft === null ? DEFAULT_MARKDOWN : draft,
        extensions: [
          lineNumbers(),
          highlightActiveLineGutter(),
          history(),
          drawSelection(),
          bracketMatching(),
          highlightActiveLine(),
          syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
          markdown({ base: markdownLanguage }),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          EditorView.lineWrapping,
          EditorView.updateListener.of(update => {
            if (update.docChanged) scheduleRender();
          })
        ]
      })
    });
    void renderDocument(owner);
    void hydrateAssets(owner);
  }

  function replaceDocument(text) {
    if (!editor) return;
    editor.dispatch({
      changes: { from: 0, to: editor.state.doc.length, insert: text },
      selection: { anchor: 0 }
    });
  }

  async function insertImage() {
    const owner = session;
    if (!isOpenSession(owner) || !editor) return;
    if (activeAssets().length >= MAX_MARKDOWN_ASSETS) {
      notify(`最多插入 ${MAX_MARKDOWN_ASSETS} 张本地图片`);
      return;
    }
    try {
      const { open } = await loadTauriDialog();
      const selected = await open({
        multiple: false,
        filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'svg'] }]
      });
      if (!isOpenSession(owner) || !editor || typeof selected !== 'string') return;
      const bytes = await invoke('read_file_bytes_limited', {
        path: selected,
        maxBytes: MAX_MARKDOWN_ASSET_BYTES
      });
      if (!isOpenSession(owner) || !editor) return;
      const { extension, mime } = imageMetadata(selected);
      const id = crypto.randomUUID();
      const token = `toolknit-asset://${id}`;
      const usedNames = new Set(assets.map(asset => asset.fileName));
      let sequence = 1;
      while (usedNames.has(`image-${sequence}.${extension}`)) sequence += 1;
      const fileName = `image-${sequence}.${extension}`;
      assets.push({
        id,
        token,
        sourcePath: selected,
        fileName,
        mime,
        previewDataUrl: bytesToDataUrl(bytes, mime)
      });
      const selection = editor.state.selection.main;
      const insertion = `![${fileName}](${token})`;
      editor.dispatch({
        changes: { from: selection.from, to: selection.to, insert: insertion },
        selection: { anchor: selection.from + insertion.length }
      });
    } catch (error) {
      if (isOpenSession(owner)) notify(`插入图片失败：${String(error?.message || error)}`);
    }
  }

  async function renderedForExport(owner) {
    let html = exportRenderer.render(sourceForRender(currentText()));
    html = DOMPurify.sanitize(html, {
      USE_PROFILES: { html: true, svg: true, svgFilters: true }
    });
    const host = document.createElement('div');
    host.replaceChildren(safeLivePreviewFragment(html, []));
    const diagrams = Array.from(host.querySelectorAll('pre > code.language-mermaid'));
    for (let index = 0; index < diagrams.length; index += 1) {
      if (!isOpenSession(owner)) return null;
      const code = diagrams[index];
      try {
        const { svg } = await mermaid.render(
          `tk-export-mermaid-${owner.token()}-${Date.now()}-${index}`,
          code.textContent
        );
        if (!isOpenSession(owner) || !code.parentElement) return null;
        const wrap = document.createElement('div');
        wrap.className = 'mermaid';
        wrap.innerHTML = DOMPurify.sanitize(svg, {
          USE_PROFILES: { svg: true, svgFilters: true }
        });
        code.parentElement.replaceWith(wrap);
      } catch {
        // Keep the original code block when a diagram cannot render.
      }
    }
    return isOpenSession(owner) ? host.innerHTML : null;
  }

  async function outputRoot() {
    return (await invoke('get_output_root')) || (await invoke('get_default_output_root'));
  }

  async function exportDocument(format) {
    const owner = session;
    if (exporting || !editor || !isOpenSession(owner)) return;
    exporting = true;
    overlay.querySelectorAll('[data-md-export]').forEach(button => { button.disabled = true; });
    try {
      const firstHeading = extractMarkdownHeadings(currentText())[0]?.text || 'toolknit-document';
      const baseName = sanitizeExportBaseName(firstHeading);
      const root = await outputRoot();
      if (!isOpenSession(owner)) return;
      if (format === 'md') {
        const exportAssets = [];
        for (const asset of activeAssets()) {
          const bytes = await invoke('read_file_bytes_limited', {
            path: asset.sourcePath,
            maxBytes: MAX_MARKDOWN_ASSET_BYTES
          });
          if (!isOpenSession(owner)) return;
          exportAssets.push({ fileName: asset.fileName, bytes });
        }
        const markdownText = rewriteMarkdownImages(
          currentText(),
          assets.map(asset => ({ source: asset.token, fileName: asset.fileName }))
        );
        const result = await invoke('export_markdown_bundle', {
          outputRoot: root,
          baseName,
          markdownBytes: Array.from(encoder.encode(markdownText)),
          assets: exportAssets
        });
        if (isOpenSession(owner)) {
          notify(`Markdown 已导出：${result.directory || result.output_directory || ''}`);
        }
      } else {
        const renderedHtml = await renderedForExport(owner);
        if (!isOpenSession(owner) || renderedHtml === null) return;
        const html = buildStandaloneMarkdownHtml({ title: firstHeading, renderedHtml });
        const path = await invoke('write_unique_file_bytes', {
          directory: `${root}\\Markdown`,
          fileName: `${baseName}.html`,
          bytes: Array.from(encoder.encode(html))
        });
        if (isOpenSession(owner)) notify(`HTML 已导出：${path}`);
      }
    } catch (error) {
      if (isOpenSession(owner)) notify(`导出失败：${String(error?.message || error)}`);
    } finally {
      if (isOpenSession(owner)) {
        exporting = false;
        overlay.querySelectorAll('[data-md-export]').forEach(button => { button.disabled = false; });
      }
    }
  }

  function showHelp(show = true, focusEditor = true) {
    const shouldShow = Boolean(show);
    helpPage.hidden = !shouldShow;
    workspace.hidden = shouldShow;
    workbench.classList.toggle('is-help-open', shouldShow);
    helpAction.classList.toggle('is-active', shouldShow);
    helpAction.setAttribute('aria-expanded', String(shouldShow));
    helpAction.title = shouldShow ? '返回编辑器' : '打开语法手册';
    helpAction.querySelector('span').textContent = shouldShow ? '返回编辑' : '语法手册';
    if (shouldShow) {
      helpPage.scrollTop = 0;
      helpPage.focus({ preventScroll: true });
    } else if (focusEditor) {
      editor?.focus();
    }
  }

  function focusLine(lineNumber, targetId, hover = false) {
    const owner = session;
    if (!editor || !isOpenSession(owner)) return;
    activeOutlineTargetId = targetId;
    updateOutlineActive(targetId);
    const line = editor.state.doc.line(
      Math.max(1, Math.min(editor.state.doc.lines, lineNumber))
    );
    editor.dispatch({
      selection: { anchor: line.from },
      effects: EditorView.scrollIntoView(line.from, { y: 'center' })
    });
    const positionNode = editor.domAtPos(line.from).node;
    const lineDom = positionNode?.parentElement?.closest?.('.cm-line')
      || positionNode?.closest?.('.cm-line');
    lineDom?.classList.add('is-outline-highlight');
    const target = preview.querySelector(`#${CSS.escape(targetId)}`);
    target?.classList.add('is-outline-highlight');
    target?.scrollIntoView({ behavior: hover ? 'auto' : 'smooth', block: 'center' });
    const timer = setTimeout(() => {
      highlightTimers.delete(timer);
      lineDom?.classList.remove('is-outline-highlight');
      target?.classList.remove('is-outline-highlight');
    }, hover ? 500 : 1200);
    highlightTimers.add(timer);
  }

  function handleClick(event) {
    const previewLink = event.target.closest('[data-md-preview] a[href]');
    if (previewLink) {
      event.preventDefault();
      const href = previewLink.getAttribute('href') || '';
      if (href.length > 1 && href.startsWith('#')) {
        preview.querySelector(`#${CSS.escape(href.slice(1))}`)
          ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      } else if (/^https?:\/\//i.test(href)) {
        if (isTauri) {
          void invoke('open_url', { url: href }).catch(() => notify('无法打开该链接'));
        } else {
          window.open(href, '_blank', 'noopener,noreferrer');
        }
      }
      return;
    }

    const action = event.target.closest('[data-md-action]')?.dataset.mdAction;
    if (action && editor) {
      const selection = editor.state.selection.main;
      const result = applyMarkdownAction(currentText(), selection.from, selection.to, action);
      editor.dispatch({
        changes: { from: 0, to: editor.state.doc.length, insert: result.text },
        selection: { anchor: result.start, head: result.end }
      });
      editor.focus();
      return;
    }

    const command = event.target.closest('[data-md-command]')?.dataset.mdCommand;
    if (command === 'undo') undo(editor);
    else if (command === 'redo') redo(editor);
    else if (command === 'image') void insertImage();
    else if (command === 'reset'
      && confirm('恢复默认模板？当前内容会被替换，但仍可立即撤销。')) {
      replaceDocument(DEFAULT_MARKDOWN);
    } else if (command === 'clear'
      && confirm('清空整份文档？该操作仍可立即撤销。')) {
      replaceDocument('');
    }

    const view = event.target.closest('[data-md-view]')?.dataset.mdView;
    if (view) {
      currentView = view;
      workspace.dataset.view = view;
      overlay.querySelectorAll('[data-md-view]').forEach(button => {
        button.classList.toggle('is-active', button.dataset.mdView === view);
      });
    }
    if (event.target.closest('[data-md-help], [data-md-help-close]')) {
      showHelp(helpPage.hidden);
    }
    const exportFormat = event.target.closest('[data-md-export]')?.dataset.mdExport;
    if (exportFormat) void exportDocument(exportFormat);
    const outlineButton = event.target.closest('[data-md-line]');
    if (outlineButton) {
      focusLine(Number(outlineButton.dataset.mdLine), outlineButton.dataset.mdTarget);
    }
  }

  function open() {
    if (disposed || session) return;
    const owner = createLifecycleScope();
    session = owner;
    owner.use(mountToolPageBackground(shell));
    owner.use(() => {
      clearTimeout(renderTimer);
      renderTimer = 0;
      highlightTimers.forEach(timer => clearTimeout(timer));
      highlightTimers.clear();
    });
    overlay.classList.add('visible');
    overlay.setAttribute('aria-hidden', 'false');
    workspace.dataset.view = currentView;
    buildEditor(owner);
    editor?.requestMeasure();
  }

  function close() {
    if (!session) return;
    const owner = session;
    session = null;
    renderRevision += 1;
    hydrateRevision += 1;
    exporting = false;
    clearTimeout(renderTimer);
    renderTimer = 0;
    highlightTimers.forEach(timer => clearTimeout(timer));
    highlightTimers.clear();
    saveDraft();
    editor?.destroy();
    editor = null;
    owner.dispose();
    assets = assets.map(({ id, token, sourcePath, fileName, mime }) => ({
      id,
      token,
      sourcePath,
      fileName,
      mime,
      previewDataUrl: ''
    }));
    preview.replaceChildren();
    outline.replaceChildren();
    overlay.querySelectorAll('[data-md-export]').forEach(button => { button.disabled = false; });
    overlay.classList.remove('visible');
    overlay.setAttribute('aria-hidden', 'true');
    showHelp(false, false);
  }

  function dispose() {
    if (disposed) return;
    close();
    disposed = true;
    lifecycle.dispose();
    overlay.replaceChildren();
  }

  lifecycle.use(bindToolPageChrome(shell, close));
  lifecycle.event(overlay, 'click', handleClick);
  lifecycle.event(overlay, 'keydown', event => {
    if (event.key === 'Escape' && !helpPage.hidden) {
      event.preventDefault();
      showHelp(false);
    }
  });
  lifecycle.event(outline, 'pointerover', event => {
    const button = event.target.closest('[data-md-line]');
    if (button) {
      focusLine(Number(button.dataset.mdLine), button.dataset.mdTarget, true);
    }
  });

  return { open, close, dispose };
}
