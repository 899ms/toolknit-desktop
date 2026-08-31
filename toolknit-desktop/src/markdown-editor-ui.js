import DOMPurify from 'dompurify';
import mermaid from 'mermaid';
import { EditorState } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, undo, redo } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { syntaxHighlighting, defaultHighlightStyle, bracketMatching } from '@codemirror/language';
import { createIcons, icons } from 'lucide';
import { open } from '@tauri-apps/plugin-dialog';
import { invoke } from '@tauri-apps/api/core';
import {
  DEFAULT_MARKDOWN, MARKDOWN_DRAFT_KEY, applyMarkdownAction, buildStandaloneMarkdownHtml, createMarkdownRenderer,
  extractMarkdownHeadings, extractMarkdownHeadingsFromTokens, rewriteMarkdownImages, sanitizeExportBaseName
} from './markdown-editor-core.js';
import { bindToolPageChrome, mountToolPageBackground, toolTopbarMarkup } from './shared/tool-page-shell.js';

const ASSET_KEY = 'toolknit.markdown.assets.v1';
const encoder = new TextEncoder();
const MAX_MARKDOWN_ASSETS = 20;
const MAX_MARKDOWN_ASSET_BYTES = 15 * 1024 * 1024;
const MAX_MARKDOWN_ASSET_TOTAL_BYTES = 40 * 1024 * 1024;
const MAX_MARKDOWN_LIVE_CHARS = 500_000;
const MAX_MARKDOWN_OUTLINE_HEADINGS = 500;
const MARKDOWN_PREVIEW_ASSET_ROOT = 'https://toolknit.local/markdown-asset/';
const SAFE_INLINE_IMAGE_PATTERN = /^data:image\/(?:png|jpeg|gif|webp|bmp);base64,/i;

function safeLivePreviewFragment(cleanHtml, assets) {
  const template = document.createElement('template');
  template.innerHTML = cleanHtml;
  const localImages = new Map(
    assets
      .filter(asset => asset?.id && asset?.previewDataUrl)
      .map(asset => [`${MARKDOWN_PREVIEW_ASSET_ROOT}${encodeURIComponent(asset.id)}`, asset.previewDataUrl])
  );
  template.content.querySelectorAll('img').forEach(image => {
    const source = image.getAttribute('src') || '';
    const localSource = localImages.get(source);
    if (localSource) {
      image.setAttribute('src', localSource);
      return;
    }
    if (SAFE_INLINE_IMAGE_PATTERN.test(source)) return;
    const blocked = document.createElement('span');
    blocked.className = 'md-render-error';
    blocked.textContent = image.getAttribute('alt') || '远程图片预览已阻止';
    image.replaceWith(blocked);
  });
  template.content.querySelectorAll('a').forEach(link => {
    link.removeAttribute('target');
    link.setAttribute('rel', 'noopener noreferrer');
    const href = link.getAttribute('href') || '';
    if (href.startsWith('#')) return;
    try {
      const parsed = new URL(href);
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
        link.removeAttribute('href');
      } else {
        link.setAttribute('href', parsed.href);
      }
    } catch {
      link.removeAttribute('href');
    }
  });
  return template.content;
}

function syntaxHelpMarkup() {
  return `<article class="md-help-document">
    <header class="md-help-hero"><div><span>MARKDOWN REFERENCE</span><h1>Markdown 语法手册</h1><p>基础排版、GFM、流程图和数学公式都在这里。所有示例都可以直接放进编辑器。</p></div><button class="md-help-return" type="button" data-md-help-close><i data-lucide="arrow-left"></i><span>返回编辑</span></button></header>
    <div class="md-help-overview" aria-label="语法手册内容"><div><b>基础排版</b><span>标题、强调、引用与列表</span></div><div><b>扩展语法</b><span>任务、表格、Mermaid 与公式</span></div><div><b>本地导出</b><span>图片资源与离线 HTML</span></div></div>
    <section><div class="md-help-section-title"><span>01</span><h2>标题与段落</h2><p>使用井号定义层级，普通段落之间留一个空行。</p></div><pre><code># 一级标题\n## 二级标题\n### 三级标题\n\n普通段落之间留一个空行。</code></pre></section>
    <section><div class="md-help-section-title"><span>02</span><h2>强调与引用</h2><p>可组合使用粗体、斜体、删除线、行内代码和引用。</p></div><pre><code>**粗体**  *斜体*  ~~删除线~~  \`行内代码\`\n\n&gt; 引用内容</code></pre></section>
    <section><div class="md-help-section-title"><span>03</span><h2>列表与任务</h2><p>任务列表是 GFM 语法，预览中可直接查看完成状态。</p></div><pre><code>- 无序项目\n1. 有序项目\n- [x] 已完成\n- [ ] 待完成</code></pre></section>
    <section><div class="md-help-section-title"><span>04</span><h2>链接与图片</h2><p>通过工具栏插入的本地图片，会在导出时自动整理资源路径。</p></div><pre><code>[ToolKnit](https://toolknit.com)\n![替代文字](assets/image.png)</code></pre></section>
    <section><div class="md-help-section-title"><span>05</span><h2>表格</h2><p>使用竖线分隔单元格；冒号可以指定列的对齐方式。</p></div><pre><code>| 名称 | 状态 |\n| --- | :---: |\n| ToolKnit | 可用 |</code></pre></section>
    <section><div class="md-help-section-title"><span>06</span><h2>代码块</h2><p>在首行标记语言，可以保留代码结构并方便阅读。</p></div><pre><code>\`\`\`js\nconsole.log('ToolKnit')\n\`\`\`</code></pre></section>
    <section><div class="md-help-section-title"><span>07</span><h2>Mermaid 图表</h2><p>使用 mermaid 代码块生成流程图，预览和 HTML 导出都会渲染为图形。</p></div><pre><code>\`\`\`mermaid\nflowchart LR\n  A[输入] --&gt; B[处理]\n  B --&gt; C[输出]\n\`\`\`</code></pre></section>
    <section><div class="md-help-section-title"><span>08</span><h2>数学公式</h2><p>单个美元符号用于行内公式，双美元符号用于独立公式块。</p></div><pre><code>行内：$E = mc^2$\n\n块级：\n$$\nf(x)=\\int_{-\\infty}^{\\infty} e^{-x^2} dx\n$$</code></pre></section>
    <section><div class="md-help-section-title"><span>09</span><h2>导出说明</h2><p>Markdown 导出会创建同级 <code>assets</code> 目录并重写图片相对路径。HTML 导出会嵌入图片、图表和公式，可离线阅读。</p></div></section>
  </article>`;
}

export function initMarkdownEditorTool({ overlay, notify = message => window.showToast?.(message) }) {
  if (!overlay) throw new Error('markdown-editor:missing-overlay');
  let editor = null; let renderTimer = 0; let renderRevision = 0; let hydrateRevision = 0; let lifecycleId = 0; let currentView = 'split'; let assets = [];
  let destroyed = false; let exporting = false; const highlightTimers = new Set();
  const renderer = createMarkdownRenderer(); const exportRenderer = createMarkdownRenderer('mathml');
  mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'neutral', fontFamily: 'system-ui, sans-serif' });

  overlay.innerHTML = `<div class="tool-page-v2-shell md-tool-shell">
    ${toolTopbarMarkup({ tag: 'MARKDOWN EDITOR · TOOL PAGE 2.3', title: 'Markdown 文档编辑器', closeAttr: 'data-md-close' })}
    <main class="tool-page-v2-body md-tool-main">
      <aside class="tool-page-v2-rail md-outline-panel">
        <div class="tool-page-v2-rail-kicker">MARKDOWN STUDIO</div><h1>Markdown<br>文档编辑器</h1><p>实时编辑、预览和导出 Markdown 文档，支持 GFM、Mermaid 与数学公式。</p>
        <div class="tool-page-v2-rail-note"><span>LOCAL ONLY</span><strong>文档和图片只在本机处理，关闭页面后清除编辑器实例。</strong></div>
        <div class="tool-page-v2-steps"><div class="is-active"><b>01</b><span><strong>编辑文档</strong><small>使用右侧工具栏快速插入语法。</small></span></div><div><b>02</b><span><strong>实时预览</strong><small>分屏查看渲染结果和目录。</small></span></div><div><b>03</b><span><strong>导出文件</strong><small>导出 Markdown 或离线 HTML。</small></span></div></div>
        <div class="md-outline-block"><div class="md-panel-label"><span>DOCUMENT MAP</span><strong>文档目录</strong></div><nav class="md-outline" data-md-outline></nav><div class="md-draft-state"><i data-lucide="save"></i><span data-md-draft-state>草稿已保存在本机</span></div></div>
      </aside>
      <section class="md-workbench">
        <div class="md-toolbar" role="toolbar" aria-label="Markdown 编辑工具栏">
          <div class="md-toolbar-scroll"><div class="md-toolbar-content">
            <div class="md-toolbar-group"><button title="撤销" data-md-command="undo"><i data-lucide="undo-2"></i></button><button title="重做" data-md-command="redo"><i data-lucide="redo-2"></i></button><button title="重置模板" data-md-command="reset"><i data-lucide="rotate-ccw"></i></button><button title="清空文档" data-md-command="clear"><i data-lucide="eraser"></i></button></div>
            <div class="md-toolbar-group"><button title="一级标题" data-md-action="h1">H1</button><button title="二级标题" data-md-action="h2">H2</button><button title="三级标题" data-md-action="h3">H3</button><button title="粗体" data-md-action="bold"><b>B</b></button><button title="斜体" data-md-action="italic"><i>I</i></button><button title="删除线" data-md-action="strike"><s>S</s></button><button title="引用" data-md-action="quote"><i data-lucide="quote"></i></button><button title="行内代码" data-md-action="code"><i data-lucide="code"></i></button><button title="代码块" data-md-action="codeblock"><i data-lucide="square-code"></i></button></div>
            <div class="md-toolbar-group"><button title="无序列表" data-md-action="ul"><i data-lucide="list"></i></button><button title="有序列表" data-md-action="ol"><i data-lucide="list-ordered"></i></button><button title="任务列表" data-md-action="task"><i data-lucide="list-checks"></i></button><button title="表格" data-md-action="table"><i data-lucide="table-2"></i></button><button title="链接" data-md-action="link"><i data-lucide="link"></i></button><button title="插入图片" data-md-command="image"><i data-lucide="image-plus"></i></button><button title="分割线" data-md-action="divider"><i data-lucide="minus"></i></button></div>
            <div class="md-toolbar-actions"><button class="md-help-action" type="button" data-md-help title="打开语法手册" aria-expanded="false"><i data-lucide="book-open"></i><span>语法手册</span></button><div class="md-view-switch" role="group" aria-label="编辑器视图"><button data-md-view="preview">预览</button><button class="is-active" data-md-view="split">分屏</button><button data-md-view="editor">编辑</button></div></div>
          </div></div>
        </div>
        <div class="md-editor-view" data-md-workspace><section class="md-preview-pane"><div class="md-pane-head"><span>PREVIEW</span><small data-md-count>0 字</small></div><div class="md-preview markdown-body" data-md-preview></div></section><section class="md-input-pane"><div class="md-pane-head"><span>EDITOR</span><small>Markdown / UTF-8</small></div><div class="md-codemirror" data-md-editor></div></section></div>
        <div class="md-help-page" data-md-help-page role="region" aria-label="Markdown 语法手册" tabindex="-1" hidden>${syntaxHelpMarkup()}</div>
      </section>
    </main>
  </div>`;
  createIcons({ icons });
  const shell = overlay.querySelector('.tool-page-v2-shell');
  let backgroundDispose = null;
  bindToolPageChrome(shell, () => api.close());
  const preview = overlay.querySelector('[data-md-preview]'); const outline = overlay.querySelector('[data-md-outline]');
  const workspace = overlay.querySelector('[data-md-workspace]'); const workbench = overlay.querySelector('.md-workbench'); const helpPage = overlay.querySelector('[data-md-help-page]'); const helpAction = overlay.querySelector('[data-md-help]');
  let activeOutlineTargetId = '';
  let savedAssets = []; try { savedAssets = JSON.parse(localStorage.getItem(ASSET_KEY) || '[]'); } catch { savedAssets = []; }
  assets = Array.isArray(savedAssets) ? savedAssets.filter(item => item?.sourcePath && item?.token).slice(0, MAX_MARKDOWN_ASSETS).map(item => ({ ...item, previewDataUrl: '' })) : [];
  async function outputRoot() { return (await invoke('get_output_root')) || (await invoke('get_default_output_root')); }

  function currentText() { const text = editor?.state.doc.toString() || ''; assets = assets.filter(asset => asset?.token && text.includes(asset.token)); return text; }
  function activeAssets() { currentText(); return assets; }
  function persistableAssets() { return activeAssets().map(({ id, token, sourcePath, fileName, mime }) => ({ id, token, sourcePath, fileName, mime })); }
  async function hydrateAssets() {
    const revision = ++hydrateRevision;
    assets = assets.map(({ id, token, sourcePath, fileName, mime }) => ({ id, token, sourcePath, fileName, mime, previewDataUrl: '' }));
    const pending = assets.filter(asset => asset.sourcePath && !asset.previewDataUrl);
    let totalBytes = 0;
    for (const asset of pending) {
      if (revision !== hydrateRevision || destroyed || totalBytes >= MAX_MARKDOWN_ASSET_TOTAL_BYTES) break;
      try {
        const bytes = await invoke('read_file_bytes_limited', { path: asset.sourcePath, maxBytes: Math.min(MAX_MARKDOWN_ASSET_BYTES, MAX_MARKDOWN_ASSET_TOTAL_BYTES - totalBytes) });
        if (revision !== hydrateRevision || destroyed) break;
        totalBytes += bytes.length;
        const binary = Uint8Array.from(bytes); let raw = '';
        for (let index = 0; index < binary.length; index += 0x8000) raw += String.fromCharCode(...binary.subarray(index, index + 0x8000));
        asset.previewDataUrl = `data:${asset.mime || 'application/octet-stream'};base64,${btoa(raw)}`;
      } catch { asset.previewDataUrl = ''; }
    }
    if (revision === hydrateRevision && !destroyed && editor) void renderDocument();
  }
  function saveDraft() {
    assets = activeAssets();
    try {
      localStorage.setItem(MARKDOWN_DRAFT_KEY, currentText());
      localStorage.setItem(ASSET_KEY, JSON.stringify(persistableAssets()));
      overlay.querySelector('[data-md-draft-state]').textContent = '草稿已保存在本机';
    } catch {
      overlay.querySelector('[data-md-draft-state]').textContent = '草稿空间不足，请及时导出';
    }
  }
  function sourceForRender(text) { let result=text; for(const asset of assets) if(asset.previewDataUrl) result=result.split(asset.token).join(asset.previewDataUrl); return result; }
  function sourceForLivePreview(text) { let result=text; for(const asset of assets) if(asset.previewDataUrl) result=result.split(asset.token).join(`${MARKDOWN_PREVIEW_ASSET_ROOT}${encodeURIComponent(asset.id)}`); return result; }
  async function renderDocument() {
    const revision=++renderRevision; const text=currentText();
    overlay.querySelector('[data-md-count]').textContent=`${text.length.toLocaleString()} 字符`;
    if(text.length>MAX_MARKDOWN_LIVE_CHARS){preview.innerHTML='<div class="md-render-error">文档超过 50 万字符，实时预览已暂停；内容仍会自动保存并可正常导出。</div>';outline.innerHTML='<p>文档较长，目录预览已暂停。</p>';return;}
    const env={};const tokens=renderer.parse(sourceForLivePreview(text),env);const headings=extractMarkdownHeadingsFromTokens(tokens);const html=renderer.renderer.render(tokens,renderer.options,env);
    const clean=DOMPurify.sanitize(html,{USE_PROFILES:{html:true,svg:true,svgFilters:true},ADD_ATTR:['aria-hidden']});
    if(revision!==renderRevision||destroyed)return;
    preview.replaceChildren(safeLivePreviewFragment(clean, assets));
    preview.querySelectorAll('h1,h2,h3,h4,h5,h6').forEach((node,index)=>{if(headings[index]){node.id=headings[index].id;node.dataset.line=String(headings[index].line);}});
    const diagrams=Array.from(preview.querySelectorAll('pre > code.language-mermaid'));
    for(let index=0;index<diagrams.length;index+=1){if(revision!==renderRevision)return;const code=diagrams[index];try{const {svg}=await mermaid.render(`tk-mermaid-${revision}-${index}`,code.textContent);const wrap=document.createElement('div');wrap.className='mermaid';wrap.innerHTML=DOMPurify.sanitize(svg,{USE_PROFILES:{svg:true,svgFilters:true}});code.parentElement.replaceWith(wrap);}catch(error){code.parentElement.classList.add('md-render-error');code.parentElement.title=String(error?.message||error);}}
    const visibleHeadings=headings.slice(0,MAX_MARKDOWN_OUTLINE_HEADINGS);outline.innerHTML=headings.length?`${visibleHeadings.map(item=>`<button type="button" style="--level:${item.level}" data-md-line="${item.line}" data-md-target="${item.id}" title="${item.text.replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'})[c])}"><span>${item.text.replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'})[c])}</span></button>`).join('')}${headings.length>visibleHeadings.length?`<p>目录仅显示前 ${MAX_MARKDOWN_OUTLINE_HEADINGS} 个标题。</p>`:''}`:'<p>添加标题后，这里会形成可跳转的目录。</p>';
    if (!headings.some(item => item.id === activeOutlineTargetId)) activeOutlineTargetId = headings[0]?.id || '';
    updateOutlineActive(activeOutlineTargetId);
  }
  function scheduleRender(){clearTimeout(renderTimer);overlay.querySelector('[data-md-draft-state]').textContent='正在保存草稿...';renderTimer=setTimeout(()=>{saveDraft();void renderDocument();},180);}
  function buildEditor(){if(editor)return;destroyed=false;const draft=localStorage.getItem(MARKDOWN_DRAFT_KEY);editor=new EditorView({parent:overlay.querySelector('[data-md-editor]'),state:EditorState.create({doc:draft===null?DEFAULT_MARKDOWN:draft,extensions:[lineNumbers(),highlightActiveLineGutter(),history(),drawSelection(),bracketMatching(),highlightActiveLine(),syntaxHighlighting(defaultHighlightStyle,{fallback:true}),markdown({base:markdownLanguage}),keymap.of([...defaultKeymap,...historyKeymap]),EditorView.lineWrapping,EditorView.updateListener.of(update=>{if(update.docChanged)scheduleRender();})]})});void renderDocument();void hydrateAssets();}
  function replaceDocument(text){editor.dispatch({changes:{from:0,to:editor.state.doc.length,insert:text},selection:{anchor:0}});}
  async function insertImage(){const requestLifecycle=lifecycleId;if(activeAssets().length>=MAX_MARKDOWN_ASSETS){notify(`最多插入 ${MAX_MARKDOWN_ASSETS} 张本地图片`);return;}try{const selected=await open({multiple:false,filters:[{name:'Images',extensions:['png','jpg','jpeg','webp','gif','bmp','svg']} ]});if(requestLifecycle!==lifecycleId||!editor||typeof selected!=='string')return;const bytes=await invoke('read_file_bytes_limited',{path:selected,maxBytes:MAX_MARKDOWN_ASSET_BYTES});if(requestLifecycle!==lifecycleId||!editor)return;const extension=(selected.split('.').pop()||'png').toLowerCase();const mime={jpg:'image/jpeg',jpeg:'image/jpeg',svg:'image/svg+xml'}[extension]||`image/${extension}`;const binary=Uint8Array.from(bytes);let raw='';for(let i=0;i<binary.length;i+=0x8000)raw+=String.fromCharCode(...binary.subarray(i,i+0x8000));const id=crypto.randomUUID();const token=`toolknit-asset://${id}`;const usedNames=new Set(assets.map(asset=>asset.fileName));let sequence=1;while(usedNames.has(`image-${sequence}.${extension}`))sequence+=1;const fileName=`image-${sequence}.${extension}`;assets.push({id,token,sourcePath:selected,fileName,mime,previewDataUrl:`data:${mime};base64,${btoa(raw)}`});const selection=editor.state.selection.main;const insertion=`![${fileName}](${token})`;editor.dispatch({changes:{from:selection.from,to:selection.to,insert:insertion},selection:{anchor:selection.from+insertion.length}});}catch(error){if(requestLifecycle===lifecycleId)notify(`插入图片失败：${String(error?.message||error)}`);}}
  async function renderedForExport(){let html=exportRenderer.render(sourceForRender(currentText()));html=DOMPurify.sanitize(html,{USE_PROFILES:{html:true,svg:true,svgFilters:true}});const host=document.createElement('div');host.replaceChildren(safeLivePreviewFragment(html, []));for(const [index,code] of Array.from(host.querySelectorAll('pre > code.language-mermaid')).entries()){try{const {svg}=await mermaid.render(`tk-export-mermaid-${Date.now()}-${index}`,code.textContent);const wrap=document.createElement('div');wrap.className='mermaid';wrap.innerHTML=DOMPurify.sanitize(svg,{USE_PROFILES:{svg:true,svgFilters:true}});code.parentElement.replaceWith(wrap);}catch{}}return host.innerHTML;}
  async function exportDocument(format){if(exporting||!editor)return;const requestLifecycle=lifecycleId;exporting=true;overlay.querySelectorAll('[data-md-export]').forEach(button=>button.disabled=true);try{const firstHeading=extractMarkdownHeadings(currentText())[0]?.text||'toolknit-document';const baseName=sanitizeExportBaseName(firstHeading);const root=await outputRoot();if(requestLifecycle!==lifecycleId)return;if(format==='md'){const exportAssets=[];for(const asset of activeAssets()){const bytes=await invoke('read_file_bytes_limited',{path:asset.sourcePath,maxBytes:MAX_MARKDOWN_ASSET_BYTES});if(requestLifecycle!==lifecycleId)return;exportAssets.push({fileName:asset.fileName,bytes});}const markdownText=rewriteMarkdownImages(currentText(),assets.map(asset=>({source:asset.token,fileName:asset.fileName})));const result=await invoke('export_markdown_bundle',{outputRoot:root,baseName,markdownBytes:Array.from(encoder.encode(markdownText)),assets:exportAssets});if(requestLifecycle===lifecycleId)notify(`Markdown 已导出：${result.directory||result.output_directory||''}`);}else{const html=buildStandaloneMarkdownHtml({title:firstHeading,renderedHtml:await renderedForExport()});if(requestLifecycle!==lifecycleId)return;const path=await invoke('write_unique_file_bytes',{directory:`${root}\\Markdown`,fileName:`${baseName}.html`,bytes:Array.from(encoder.encode(html))});if(requestLifecycle===lifecycleId)notify(`HTML 已导出：${path}`);}}catch(error){if(requestLifecycle===lifecycleId)notify(`导出失败：${String(error?.message||error)}`);}finally{if(requestLifecycle===lifecycleId){exporting=false;overlay.querySelectorAll('[data-md-export]').forEach(button=>button.disabled=false);}}}
  function showHelp(show=true){const shouldShow=Boolean(show);helpPage.hidden=!shouldShow;workspace.hidden=shouldShow;workbench.classList.toggle('is-help-open',shouldShow);helpAction.classList.toggle('is-active',shouldShow);helpAction.setAttribute('aria-expanded',String(shouldShow));helpAction.title=shouldShow?'返回编辑器':'打开语法手册';helpAction.querySelector('span').textContent=shouldShow?'返回编辑':'语法手册';if(shouldShow){helpPage.scrollTop=0;helpPage.focus({preventScroll:true});}else editor?.focus();}
  function updateOutlineActive(targetId){outline.querySelectorAll('[data-md-target]').forEach(button=>{const active=button.dataset.mdTarget===targetId;button.classList.toggle('is-active',active);button.setAttribute('aria-current',active?'location':'false');});}
  function focusLine(lineNumber,targetId,hover=false){if(!editor)return;activeOutlineTargetId=targetId;updateOutlineActive(targetId);const line=editor.state.doc.line(Math.max(1,Math.min(editor.state.doc.lines,lineNumber)));editor.dispatch({selection:{anchor:line.from},effects:EditorView.scrollIntoView(line.from,{y:'center'})});const lineDom=editor.domAtPos(line.from).node?.parentElement?.closest?.('.cm-line')||editor.domAtPos(line.from).node?.closest?.('.cm-line');lineDom?.classList.add('is-outline-highlight');const target=preview.querySelector(`#${CSS.escape(targetId)}`);target?.classList.add('is-outline-highlight');target?.scrollIntoView({behavior:hover?'auto':'smooth',block:'center'});const timer=setTimeout(()=>{highlightTimers.delete(timer);lineDom?.classList.remove('is-outline-highlight');target?.classList.remove('is-outline-highlight');},hover?500:1200);highlightTimers.add(timer);}
  overlay.addEventListener('click',event=>{const previewLink=event.target.closest('[data-md-preview] a[href]');if(previewLink){event.preventDefault();const href=previewLink.getAttribute('href')||'';if(href.length>1&&href.startsWith('#')){preview.querySelector(`#${CSS.escape(href.slice(1))}`)?.scrollIntoView({behavior:'smooth',block:'start'});}else if(/^https?:\/\//i.test(href)){if(window.__TAURI_INTERNALS__){void invoke('open_url',{url:href}).catch(()=>notify('无法打开该链接'));}else{window.open(href,'_blank','noopener,noreferrer');}}return;}const action=event.target.closest('[data-md-action]')?.dataset.mdAction;if(action&&editor){const selection=editor.state.selection.main;const result=applyMarkdownAction(currentText(),selection.from,selection.to,action);editor.dispatch({changes:{from:0,to:editor.state.doc.length,insert:result.text},selection:{anchor:result.start,head:result.end}});editor.focus();return;}const command=event.target.closest('[data-md-command]')?.dataset.mdCommand;if(command==='undo')undo(editor);else if(command==='redo')redo(editor);else if(command==='image')void insertImage();else if(command==='reset'&&confirm('恢复默认模板？当前内容会被替换，但仍可立即撤销。'))replaceDocument(DEFAULT_MARKDOWN);else if(command==='clear'&&confirm('清空整份文档？该操作仍可立即撤销。'))replaceDocument('');const view=event.target.closest('[data-md-view]')?.dataset.mdView;if(view){currentView=view;workspace.dataset.view=view;overlay.querySelectorAll('[data-md-view]').forEach(button=>button.classList.toggle('is-active',button.dataset.mdView===view));}if(event.target.closest('[data-md-help], [data-md-help-close]'))showHelp(helpPage.hidden);const exportFormat=event.target.closest('[data-md-export]')?.dataset.mdExport;if(exportFormat)void exportDocument(exportFormat);const outlineButton=event.target.closest('[data-md-line]');if(outlineButton)focusLine(Number(outlineButton.dataset.mdLine),outlineButton.dataset.mdTarget);});
  overlay.addEventListener('keydown',event=>{if(event.key==='Escape'&&!helpPage.hidden){event.preventDefault();showHelp(false);}});
  outline.addEventListener('pointerover',event=>{const button=event.target.closest('[data-md-line]');if(button)focusLine(Number(button.dataset.mdLine),button.dataset.mdTarget,true);});
  const api={open(){lifecycleId+=1;backgroundDispose?.();backgroundDispose=mountToolPageBackground(shell);overlay.classList.add('visible');overlay.setAttribute('aria-hidden','false');buildEditor();editor.requestMeasure();},close(){lifecycleId+=1;hydrateRevision+=1;backgroundDispose?.();backgroundDispose=null;clearTimeout(renderTimer);renderTimer=0;renderRevision+=1;destroyed=true;exporting=false;highlightTimers.forEach(timer=>clearTimeout(timer));highlightTimers.clear();if(editor){saveDraft();editor.destroy();editor=null;}assets=assets.map(({id,token,sourcePath,fileName,mime})=>({id,token,sourcePath,fileName,mime,previewDataUrl:''}));preview.innerHTML='';outline.innerHTML='';overlay.querySelectorAll('[data-md-export]').forEach(button=>button.disabled=false);overlay.classList.remove('visible');overlay.setAttribute('aria-hidden','true');showHelp(false);}};
  return api;
}
