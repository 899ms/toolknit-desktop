import { createLifecycleScope } from '../../app/tool-lifecycle.js';
import { applyTranslations, getLang } from '../../i18n.js';
import { tauriCorePromise } from '../../platform/tauri-runtime.js';
import {
  buildPptOutlineMessages,
  createPptOutlineManifest,
  createPptOutlineMarkdown,
  extractPptOutlineJson,
  normalizePptOutlineRequest,
  normalizePptOutlineResult,
  sanitizePptOutlineBaseName
} from '../../ppt-outline-core.js';
import { bindPptChrome, createOperationGuard, setInteractiveLayer, uniqueOutputDirectory, writeUniqueFile } from './shared.js';
import { getPptAiPreset, pptAiGenerationErrorMessage, pptOutlineDeckTypeLabel, setPptAiPresetActive, setPptAiPresetDisabled } from './ai-shared.js';

function createElement(documentRef, tag, className, text) {
  const element = documentRef.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

export function createPptOutlineController({
  overlay,
  isTauri = false,
  t = key => key,
  onLangChange = () => () => {},
  notify = () => {},
  getOutputDir,
  displayFilesystemPath = value => String(value || ''),
  openOutputFolder = async () => false,
  initStandardToolPlasma = () => null,
  disposeStandardToolPlasma = value => value,
  requestAi = async () => { throw new Error('AI request unavailable'); },
  refreshIcons = () => {},
  openSettings = () => {},
  openSupport = () => {},
  openExternalUrl = () => {},
  handleWindowAction = () => {},
  continueToDraft = () => false
} = {}) {
  if (!overlay) throw new Error('ppt-outline:missing-overlay');
  if (typeof getOutputDir !== 'function') throw new Error('ppt-outline:missing-output-directory');
  const documentRef = overlay.ownerDocument || document;
  const byId = id => documentRef.getElementById(id);
  const prompt = byId('pptOutlinePrompt');
  const slideCount = byId('pptOutlineSlideCount');
  const locale = byId('pptOutlineLocale');
  const deckType = byId('pptOutlineDeckType');
  const audience = byId('pptOutlineAudience');
  const purpose = byId('pptOutlinePurpose');
  const tone = byId('pptOutlineTone');
  const style = byId('pptOutlineStyle');
  const generateButton = byId('pptOutlineGenerateBtn');
  const presetButtons = Array.from(overlay.querySelectorAll('[data-ppt-outline-preset]'));
  const empty = byId('pptOutlineEmpty');
  const resultPanel = byId('pptOutlineResult');
  const summary = byId('pptOutlineSummary');
  const meta = byId('pptOutlineMeta');
  const factBank = byId('pptOutlineFactBank');
  const quality = byId('pptOutlineQuality');
  const slideList = byId('pptOutlineSlideList');
  const workspace = byId('pptOutlineScrollArea');
  const scrollTop = byId('pptOutlineScrollTop');
  const processMask = byId('pptOutlineProcessMask');
  const progressFill = byId('pptOutlineProcessBarFill');
  const processText = byId('pptOutlineProcessText');
  const successOverlay = byId('pptOutlineSuccessOverlay');
  const successMeta = byId('pptOutlineSuccessMeta');
  const successSlides = byId('pptOutlineSuccessSlides');
  const successFiles = byId('pptOutlineSuccessFiles');
  const successPath = byId('pptOutlineSuccessPath');
  const successOpenFolder = byId('pptOutlineSuccessOpenFolder');
  const successToDraft = byId('pptOutlineSuccessToDraft');
  const successOk = byId('pptOutlineSuccessOk');
  const lifecycle = createLifecycleScope({ onError: error => console.error('[PPT Outline] dispose error:', error) });
  let session = null;
  const guard = createOperationGuard(() => session);
  let plasma = null;
  let busy = false;
  let lastResult = null;
  let lastOutputPath = '';
  let lastPresetPrompt = '';

  const text = (key, params) => t(`home.pptOutlinePage.${key}`, params);
  const isOpen = owner => owner && owner === session && !owner.disposed && overlay.classList.contains('visible');
  const setProgress = (percent, message, visible = true) => { if (progressFill) progressFill.style.width = `${Math.max(0, Math.min(100, percent))}%`; if (processText) processText.textContent = message || text('processing'); setInteractiveLayer(processMask, visible); };

  function collectRequest() {
    const value = String(prompt?.value || '').trim();
    if (!value) { notify(text('promptRequired')); prompt?.focus(); return null; }
    const count = Number(slideCount?.value || 8);
    if (!Number.isSafeInteger(count) || count < 3 || count > 30) { notify(text('slideCountInvalid')); slideCount?.focus(); return null; }
    try { return normalizePptOutlineRequest({ prompt: value, slide_count: count, locale: locale?.value || (getLang() === 'en' ? 'en' : 'zh-CN'), deck_type: deckType?.value || 'auto', audience: audience?.value || '', purpose: purpose?.value || '', tone: tone?.value || '', style: style?.value || '' }); }
    catch (error) { notify(String(error?.userMessage || error?.message || error)); return null; }
  }

  function applyPreset(key) {
    if (busy) { notify(text('processing')); return; }
    const preset = getPptAiPreset(key); if (!preset) return;
    const current = String(prompt?.value || '').trim(); const replacePrompt = !current || current === lastPresetPrompt;
    if (prompt && replacePrompt) { prompt.value = preset.prompt; lastPresetPrompt = preset.prompt; } else lastPresetPrompt = '';
    if (slideCount) slideCount.value = String(preset.slideCount); if (deckType) deckType.value = preset.deckType; if (audience) audience.value = preset.audience; if (purpose) purpose.value = preset.purpose; if (tone) tone.value = preset.tone; if (style) style.value = preset.style;
    setPptAiPresetActive(presetButtons, 'pptOutlinePreset', key); notify(text(replacePrompt ? 'presetAppliedToast' : 'presetAppliedKeepPromptToast', { name: preset.name }));
  }

  function renderResult(result) {
    if (!result || !isOpen(session)) return;
    lastResult = result; empty.hidden = true; resultPanel.hidden = false;
    summary?.replaceChildren(createElement(documentRef, 'span', '', text('summary', { slides: result.slides.length, title: result.title })), createElement(documentRef, 'strong', '', `${text('centralTakeaway')}：${result.narrative?.central_takeaway || text('missingInfo')}`));
    meta?.replaceChildren(createElement(documentRef, 'span', 'ppt-outline-pill', `${text('deckType')}：${pptOutlineDeckTypeLabel(result.deck_type || result.request?.deck_type || 'auto')}`), createElement(documentRef, 'span', 'ppt-outline-pill', `${text('qualityScore')}：${String(result.quality_check?.self_check?.score ?? 0)}/100`));
    factBank?.replaceChildren();
    const facts = result.fact_bank || {};
    [['factsKnown', facts.known_facts], ['factsEvidence', facts.evidence], ['factsMissing', facts.missing_facts]].forEach(([labelKey, values]) => { const section = createElement(documentRef, 'section', 'ppt-outline-fact-group'); section.append(createElement(documentRef, 'strong', '', text(labelKey))); const list = createElement(documentRef, 'div'); const items = Array.isArray(values) && values.length ? values : [text('missingInfo')]; items.forEach(value => list.append(createElement(documentRef, 'span', '', value))); section.append(list); factBank?.append(section); });
    const selfCheck = result.quality_check?.self_check || {}; const passed = selfCheck.passed ? 'PASS' : 'CHECK'; quality?.replaceChildren(); if (quality) { quality.append(createElement(documentRef, 'div', 'ppt-outline-quality-score', `${text('qualityScore')} ${String(selfCheck.score ?? 0)}/100 · ${passed}`)); const qualityList = createElement(documentRef, 'div', 'ppt-outline-quality-list'); [['qualityStrengths', selfCheck.strengths], ['qualityIssues', selfCheck.issues]].forEach(([labelKey, values]) => { const row = createElement(documentRef, 'div'); row.append(createElement(documentRef, 'strong', '', text(labelKey)), createElement(documentRef, 'span', '', (values || []).join(' / ') || text('missingInfo'))); qualityList.append(row); }); quality.append(qualityList); }
    slideList?.replaceChildren();
    (result.slides || []).forEach(slide => { const article = createElement(documentRef, 'article', 'ppt-outline-slide'); article.append(createElement(documentRef, 'div', 'ppt-outline-slide-number', String(slide.page))); const content = createElement(documentRef, 'div', 'ppt-outline-slide-content'); content.append(createElement(documentRef, 'strong', '', slide.title || ''), createElement(documentRef, 'p', '', slide.claim || (slide.body || []).join(' / ')), createElement(documentRef, 'em', '', slide.visual_suggestion || slide.type || '')); const tags = createElement(documentRef, 'div', 'ppt-outline-slide-tags'); [slide.role || slide.type || '', slide.layout_intent?.kind || '', slide.layout_intent?.density || '', slide.layout_intent?.visual_focus ? String(slide.layout_intent.visual_focus).slice(0, 40) : ''].filter(Boolean).forEach(value => tags.append(createElement(documentRef, 'span', '', value))); content.append(tags); article.append(content); slideList?.append(article); });
    refreshIcons();
  }

  function resetState(clearPrompt = false) {
    guard.cancel(); busy = false; lastResult = null; lastOutputPath = '';
    if (clearPrompt) { if (prompt) prompt.value = ''; lastPresetPrompt = ''; setPptAiPresetActive(presetButtons, 'pptOutlinePreset', ''); if (audience) audience.value = ''; if (purpose) purpose.value = ''; if (tone) tone.value = ''; if (style) style.value = ''; if (slideCount) slideCount.value = '8'; if (deckType) deckType.value = 'auto'; }
    if (locale) locale.value = getLang() === 'en' ? 'en' : 'zh-CN'; empty.hidden = false; resultPanel.hidden = true; summary?.replaceChildren(); meta?.replaceChildren(); factBank?.replaceChildren(); quality?.replaceChildren(); slideList?.replaceChildren(); if (generateButton) generateButton.disabled = false; setPptAiPresetDisabled(presetButtons, false); scrollTop?.classList.remove('visible'); setProgress(0, text('processing'), false);
  }

  function open() {
    session?.dispose(); session = createLifecycleScope({ onError: error => console.error('[PPT Outline] session cleanup:', error) }); resetState(false); overlay.classList.add('visible'); overlay.setAttribute('aria-hidden', 'false'); if (workspace) workspace.scrollTop = 0; if (byId('pptOutlinePlasmaBg')) plasma = initStandardToolPlasma(byId('pptOutlinePlasmaBg')); session.timeout(() => prompt?.focus(), 80);
  }

  function close() { guard.cancel(); session?.dispose(); session = null; busy = false; setInteractiveLayer(successOverlay, false); setInteractiveLayer(processMask, false); overlay.classList.remove('visible'); overlay.setAttribute('aria-hidden', 'true'); plasma = disposeStandardToolPlasma(plasma); resetState(false); }

  async function exportResult(outline, operation) {
    const encoder = new TextEncoder(); const baseName = sanitizePptOutlineBaseName(outline?.title || text('title') || 'ppt-outline'); const outputDir = await uniqueOutputDirectory({ getOutputDir, isTauri, category: 'PPT_Outline', baseName: `${baseName}_ppt_outline` }); const runId = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`; const publicResult = { tool: 'ppt.outline', dry_run: false, output_dir: outputDir, run_id: runId, generated_at: new Date().toISOString(), outline, outputs: [], manifest_path: `${String(outputDir).replace(/[\\/]+$/, '')}${String(outputDir).includes('\\') ? '\\' : '/'}manifest.json` }; const markdown = createPptOutlineMarkdown(outline); const outlineJson = `${JSON.stringify(outline, null, 2)}\n`; const manifest = { ...createPptOutlineManifest(outline), tool: publicResult.tool, dry_run: false, output_dir: outputDir, run_id: runId, generated_at: publicResult.generated_at };
    if (isTauri) { const { invoke } = await tauriCorePromise; for (const [name, content, kind] of [['outline.md', markdown, 'markdown'], ['outline.json', outlineJson, 'json']]) { guard.assertCurrent(operation); const bytes = encoder.encode(content); const path = await writeUniqueFile(invoke, outputDir, name, bytes); publicResult.outputs.push({ path, relative_path: name, kind, bytes: bytes.byteLength }); } guard.assertCurrent(operation); const manifestPath = await writeUniqueFile(invoke, outputDir, 'manifest.json', encoder.encode(`${JSON.stringify({ ...manifest, outputs: publicResult.outputs }, null, 2)}\n`)); publicResult.manifest_path = manifestPath; return publicResult; }
    const JSZip = (await import('jszip')).default; const zip = new JSZip(); zip.file('outline.md', markdown); zip.file('outline.json', outlineJson); publicResult.outputs = [{ path: `${outputDir}/outline.md`, relative_path: 'outline.md', kind: 'markdown', bytes: encoder.encode(markdown).byteLength }, { path: `${outputDir}/outline.json`, relative_path: 'outline.json', kind: 'json', bytes: encoder.encode(outlineJson).byteLength }]; zip.file('manifest.json', JSON.stringify({ ...manifest, outputs: publicResult.outputs }, null, 2)); const blob = await zip.generateAsync({ type: 'blob' }); guard.assertCurrent(operation); const url = URL.createObjectURL(blob); const anchor = createElement(documentRef, 'a'); anchor.href = url; anchor.download = `${baseName}_ppt_outline.zip`; anchor.hidden = true; documentRef.body.append(anchor); anchor.click(); anchor.remove(); session.timeout(() => URL.revokeObjectURL(url), 1000); return publicResult;
  }

  async function generate() {
    if (busy) return; const request = collectRequest(); if (!request) return; const operation = guard.begin(); if (!operation) return; operation.scope = createLifecycleScope(); operation.signal = operation.scope.abortController().signal; busy = true; generateButton.disabled = true; setPptAiPresetDisabled(presetButtons, true); setProgress(10, text('validating'));
    try { setProgress(38, text('generating')); const content = await requestAi(buildPptOutlineMessages(request), operation.signal, 8192); guard.assertCurrent(operation); const parsed = extractPptOutlineJson(content); if (!parsed) throw new Error('AI provider did not return valid PPT outline JSON.'); const outline = normalizePptOutlineResult(parsed, request); renderResult(outline); setProgress(76, text('writing')); const exported = await exportResult(outline, operation); guard.assertCurrent(operation); lastOutputPath = exported.output_dir; if (successMeta) successMeta.textContent = text('successMeta'); if (successSlides) successSlides.textContent = String(outline.slides.length); if (successFiles) successFiles.textContent = String(exported.outputs.length + 1); if (successPath) successPath.textContent = displayFilesystemPath(exported.output_dir); setInteractiveLayer(successOverlay, true); setProgress(100, text('writing')); notify(text('generatedToast', { slides: outline.slides.length })); }
    catch (error) { if (guard.isCurrent(operation)) { console.error('[PPT Outline] generation failed:', error); notify(pptAiGenerationErrorMessage(error, text)); } }
    finally { if (!guard.isCurrent(operation)) return; busy = false; guard.finish(operation); generateButton.disabled = false; setPptAiPresetDisabled(presetButtons, false); setProgress(0, text('processing'), false); }
  }

  lifecycle.event(overlay.querySelector('[id$="Back"]'), 'click', close);
  lifecycle.event(generateButton, 'click', () => { void generate(); });
  presetButtons.forEach(button => lifecycle.event(button, 'click', () => applyPreset(button.dataset.pptOutlinePreset)));
  lifecycle.event(workspace, 'scroll', () => scrollTop?.classList.toggle('visible', workspace.scrollTop > 160), { passive: true }); lifecycle.event(scrollTop, 'click', () => workspace?.scrollTo({ top: 0, behavior: 'smooth' })); lifecycle.event(successOk, 'click', () => setInteractiveLayer(successOverlay, false));
  lifecycle.event(successOpenFolder, 'click', async () => { if (isTauri && lastOutputPath) await openOutputFolder(lastOutputPath); });
  lifecycle.event(successToDraft, 'click', () => { if (!lastResult) { notify(text('missingInfo')); return; } if (continueToDraft(lastResult, text('outlineImportedFromOutlinePage'))) setInteractiveLayer(successOverlay, false); });
  bindPptChrome(lifecycle, overlay, { onClose: close, openSettings, openSupport, openExternalUrl, handleWindowAction });
  lifecycle.use(onLangChange(() => { if (!isOpen(session)) return; applyTranslations(); if (lastResult) renderResult(lastResult); }));

  return { open, close, dispose() { close(); lifecycle.dispose(); }, get busy() { return busy; } };
}
