import { createIcons, icons } from 'lucide';
import { createLifecycleScope } from '../../app/tool-lifecycle.js';
import { tauriCorePromise, tauriEventPromise, loadTauriDialog, loadTauriWebview } from '../../platform/tauri-runtime.js';
import { escapeHtml } from '../../shared/html.js';
import { parseRefinedTranscriptionResponse, parseTranscriptionSrt } from './core.js';

function createNoopTool() {
  return { open() {}, close() {}, dispose() {} };
}

export function initTranscriptionTool({
  overlay,
  isTauri = false,
  notify = message => window.showToast?.(message),
  t,
  getOutputDir,
  displayFilesystemPath,
  requestAi,
  refreshIcons = () => createIcons({ icons }),
  initStandardToolPlasma,
  disposeStandardToolPlasma,
  ensureFfmpegAvailable = async () => true,
  refreshTranscriptionModels = async () => {},
  activeTranscriptionModel = () => null,
  showDependencyGate = () => {},
  openSettings,
  openSupport,
  openExternalUrl,
  handleWindowAction,
  onLangChange
} = {}) {
  if (!overlay) return createNoopTool();
  const lifecycle = createLifecycleScope();
  const byId = id => document.getElementById(id);
  const transcriptionOverlay = overlay;
  const transcriptionBack = byId('transcriptionBack');
  const transcriptionCta = byId('transcriptionCta');
  const transcriptionCtaText = byId('transcriptionCtaText');
  const transcriptionInput = byId('transcriptionInput');
  const transcriptionFiles = byId('transcriptionFiles');
  const transcriptionPreview = byId('transcriptionPreview');
  const transcriptionCopyTextBtn = byId('transcriptionCopyTextBtn');
  const transcriptionOpenFolderBtn = byId('transcriptionOpenFolderBtn');
  const transcriptionSelectedFile = byId('transcriptionSelectedFile');
  const transcriptionSelectedFileName = byId('transcriptionSelectedFileName');
  const transcriptionProcessBtn = byId('transcriptionProcessBtn');
  const transcriptionProcessMask = byId('transcriptionProcessMask');
  const transcriptionProcessText = byId('transcriptionProcessText');
  const transcriptionProcessBarFill = byId('transcriptionProcessBarFill');
  const transcriptionLanguageOptions = byId('transcriptionLanguageOptions');
  const transcriptionRefine = byId('transcriptionRefine');
  const transcriptionDropZone = byId('transcriptionDropZone');
  const transcriptionPlasmaBg = byId('transcriptionPlasmaBg');
  const transcriptionSuccessOverlay = byId('transcriptionSuccessOverlay');
  const transcriptionSuccessMeta = byId('transcriptionSuccessMeta');
  const transcriptionSuccessCount = byId('transcriptionSuccessCount');
  const transcriptionSuccessPath = byId('transcriptionSuccessPath');
  const transcriptionSuccessOpenFolder = byId('transcriptionSuccessOpenFolder');
  const transcriptionSuccessOk = byId('transcriptionSuccessOk');
  let transcriptionFile = null;
  let transcriptionLanguage = 'auto';
  let transcriptionProcessing = false;
  let transcriptionPlasmaDispose = null;
  let transcriptionOutputDir = '';
  let transcriptionPreviewText = '';
  let nativeDragUnlisten = null;

  function setTranscriptionOutputDir(outputDir = '') {
    transcriptionOutputDir = String(outputDir || '');
    const enabled = Boolean(transcriptionOutputDir);
    if (transcriptionOpenFolderBtn) transcriptionOpenFolderBtn.disabled = !enabled;
    if (transcriptionSuccessOpenFolder) transcriptionSuccessOpenFolder.disabled = !enabled;
  }

  function setTranscriptionCopyButtonState(copied = false) {
    if (!transcriptionCopyTextBtn) return;
    const label = transcriptionCopyTextBtn.querySelector('span');
    if (label) label.textContent = copied ? t('home.transcription.copiedText') : t('home.transcription.copyText');
    transcriptionCopyTextBtn.disabled = !transcriptionPreviewText;
  }

  function syncTranscriptionInlineLabels() {
    if (transcriptionFiles) transcriptionFiles.dataset.empty = t('home.transcription.emptyOutputs');
    setTranscriptionCopyButtonState(false);
  }

  function setTranscriptionProgress(progress, message) {
    if (transcriptionProcessBarFill) {
      const numericProgress = Number.isFinite(Number(progress)) ? Number(progress) : 0;
      transcriptionProcessBarFill.style.width = `${Math.max(0, Math.min(100, numericProgress))}%`;
    }
    if (message && transcriptionProcessText) transcriptionProcessText.textContent = message;
  }

  function setTranscriptionSuccessVisible(visible) {
    if (!transcriptionSuccessOverlay) return;
    transcriptionSuccessOverlay.classList.toggle('visible', visible);
    transcriptionSuccessOverlay.setAttribute('aria-hidden', visible ? 'false' : 'true');
    if (visible) transcriptionSuccessOverlay.removeAttribute('inert');
    else transcriptionSuccessOverlay.setAttribute('inert', '');
  }

  function updateTranscriptionUploadState() {
        const hasFile = Boolean(transcriptionFile?.name);
        const ctaLabel = hasFile ? t('home.transcription.reupload') : t('home.transcription.cta');
        if (transcriptionCtaText) transcriptionCtaText.textContent = ctaLabel;
        if (transcriptionCta) transcriptionCta.setAttribute('aria-label', ctaLabel);
        if (transcriptionSelectedFile) transcriptionSelectedFile.hidden = !hasFile;
        if (transcriptionSelectedFileName) {
          transcriptionSelectedFileName.textContent = hasFile ? transcriptionFile.name : '';
          transcriptionSelectedFileName.title = hasFile ? transcriptionFile.name : '';
        }
      }

      function renderTranscriptionFile() {
        transcriptionOverlay?.classList.remove('has-result');
        if (transcriptionFiles) {
          transcriptionFiles.replaceChildren();
          transcriptionFiles.classList.remove('has-files');
        }
        setTranscriptionOutputDir('');
        renderTranscriptionPreviewEmpty();
        updateTranscriptionUploadState();
      }

      function renderTranscriptionPreviewEmpty() {
        transcriptionPreviewText = '';
        setTranscriptionCopyButtonState(false);
        if (!transcriptionPreview) return;
        transcriptionPreview.classList.add('is-empty');
        transcriptionPreview.replaceChildren();
        const empty = document.createElement('div');
        empty.className = 'transcription-v2-preview-empty';
        empty.innerHTML = `
          <i data-lucide="subtitles"></i>
          <strong>${escapeHtml(t('home.transcription.previewEmptyTitle'))}</strong>
          <span>${escapeHtml(t('home.transcription.previewEmptyDesc'))}</span>
        `;
        transcriptionPreview.append(empty);
        refreshIcons?.();
      }

      function updateTranscriptionProcessButton() {
        if (!transcriptionProcessBtn) return;
        transcriptionProcessBtn.style.display = transcriptionFile ? '' : 'none';
        transcriptionProcessBtn.classList.toggle('visible', Boolean(transcriptionFile));
        transcriptionProcessBtn.disabled = transcriptionProcessing;
      }

      function addTranscriptionFile(file) {
        if (!file || transcriptionProcessing) return;
        transcriptionFile = file;
        renderTranscriptionFile();
        updateTranscriptionProcessButton();
      }

      function showTranscriptionTool() {
        if (lifecycle.disposed) return;
        transcriptionOverlay?.classList.add('visible');
        if (transcriptionPlasmaBg && !transcriptionPlasmaDispose) transcriptionPlasmaDispose = initStandardToolPlasma(transcriptionPlasmaBg);
      }

      async function openTranscriptionTool() {
        if (!isTauri) { notify?.(t('home.transcription.desktopOnly')); return; }
        const openToken = lifecycle.token();
        const { invoke } = await tauriCorePromise;
        const [engineReady, ffmpegReady] = await Promise.all([invoke('check_transcription_engine'), ensureFfmpegAvailable()]);
        if (!lifecycle.isCurrent(openToken)) return;
        if (!engineReady) { notify?.(t('home.transcription.engineUnavailable')); return; }
        await refreshTranscriptionModels();
        if (!lifecycle.isCurrent(openToken)) return;
        const modelReady = Boolean(activeTranscriptionModel());
        if (!ffmpegReady || !modelReady) {
          showDependencyGate({ openFn: showTranscriptionTool, needsFfmpeg: !ffmpegReady, needsModel: !modelReady });
          return;
        }
        showTranscriptionTool();
      }

  function closeTranscriptionTool() {
    lifecycle.invalidate();
    transcriptionProcessing = false;
    transcriptionOverlay?.classList.remove('visible');
    setTranscriptionSuccessVisible(false);
    transcriptionFile = null;
        renderTranscriptionFile();
        updateTranscriptionProcessButton();
        if (transcriptionPlasmaDispose) { transcriptionPlasmaDispose(); transcriptionPlasmaDispose = null; }
      }

      lifecycle.event(transcriptionBack, 'click', closeTranscriptionTool);
      lifecycle.event(transcriptionCta, 'click', async () => {
        if (isTauri) {
          const { open } = await loadTauriDialog();
          const selected = await open({ multiple: false, filters: [{ name: 'Audio and video', extensions: ['mp3', 'aac', 'm4a', 'wav', 'flac', 'alac', 'ogg', 'wma', 'mp4', 'mkv', 'avi', 'mov', 'webm', 'flv', 'wmv', 'ts'] }] });
          if (typeof selected === 'string') addTranscriptionFile({ path: selected, name: selected.split(/[\\/]/).pop() || selected });
        } else transcriptionInput?.click();
      });
      lifecycle.event(transcriptionInput, 'change', () => { const file = transcriptionInput.files?.[0]; if (file) addTranscriptionFile(file); transcriptionInput.value = ''; });
      transcriptionLanguageOptions?.querySelectorAll('[data-language]').forEach(button => lifecycle.event(button, 'click', () => {
        transcriptionLanguage = button.dataset.language || 'auto';
        transcriptionLanguageOptions.querySelectorAll('[data-language]').forEach(item => item.classList.toggle('active', item === button));
      }));
      updateTranscriptionUploadState();
      syncTranscriptionInlineLabels();
      setTranscriptionSuccessVisible(false);

      if (isTauri && transcriptionOverlay) {
        (async () => {
          const { getCurrentWebview } = await loadTauriWebview();
          const webview = getCurrentWebview();
          nativeDragUnlisten = await webview.onDragDropEvent(event => {
            if (!transcriptionOverlay.classList.contains('visible') || transcriptionProcessing) return;
            const payload = event.payload;
            if (payload.type === 'enter' || payload.type === 'over') transcriptionDropZone?.classList.add('visible');
            else if (payload.type === 'leave') transcriptionDropZone?.classList.remove('visible');
            else if (payload.type === 'drop') {
              transcriptionDropZone?.classList.remove('visible');
              const path = payload.paths?.[0];
              if (path) addTranscriptionFile({ path, name: path.split(/[\\/]/).pop() || path });
            }
          });
          lifecycle.use(() => { try { nativeDragUnlisten?.(); } catch {} nativeDragUnlisten = null; });
        })().catch(error => console.error('Cannot register transcription drag and drop:', error));
      }

      function transcriptionProgressLabel(phase) {
        const labels = {
          preparing: 'home.transcription.preparing',
          transcribing: 'home.transcription.transcribing',
          publishing: 'home.transcription.publishing',
          refining: 'home.transcription.refining',
          complete: 'home.transcription.complete'
        };
        return t(labels[phase] || 'home.transcription.preparing');
      }

      async function readTranscriptionText(path) {
        const { invoke } = await tauriCorePromise;
        const bytes = await invoke('read_file_bytes_limited', { path, maxBytes: 10 * 1024 * 1024 });
        return new TextDecoder('utf-8').decode(Uint8Array.from(bytes));
      }

      function renderTranscriptionPreview(segments, textValue = '') {
        const normalizedText = String(textValue || '').trim();
        transcriptionPreviewText = normalizedText || segments.map(segment => segment.text.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n');
        setTranscriptionCopyButtonState(false);
        if (!transcriptionPreview) return;
        transcriptionPreview.replaceChildren();
        transcriptionPreview.classList.remove('is-empty');
        if (!segments.length && !transcriptionPreviewText) {
          renderTranscriptionPreviewEmpty();
          return;
        }
        if (segments.length) {
          const fragment = document.createDocumentFragment();
          segments.slice(0, 500).forEach(segment => {
            const row = document.createElement('div');
            row.className = 'transcription-v2-segment';
            row.innerHTML = `
              <span class="transcription-v2-segment-time">${escapeHtml(segment.start)} → ${escapeHtml(segment.end)}</span>
              <p>${escapeHtml(segment.text)}</p>
            `;
            fragment.append(row);
          });
          if (segments.length > 500) {
            const more = document.createElement('div');
            more.className = 'transcription-v2-preview-more';
            more.textContent = t('home.transcription.previewLimit', { count: 500 });
            fragment.append(more);
          }
          transcriptionPreview.append(fragment);
          return;
        }
        const textBlock = document.createElement('div');
        textBlock.className = 'transcription-v2-text-preview';
        textBlock.textContent = transcriptionPreviewText;
        transcriptionPreview.append(textBlock);
      }

      async function refineTranscriptionSegments(segments) {
        const updated = new Map();
        const chunkSize = 42;
        for (let offset = 0; offset < segments.length; offset += chunkSize) {
          const chunk = segments.slice(offset, offset + chunkSize);
          const payload = chunk.map(({ id, text }) => ({ id, text }));
          const response = await requestAi([
            {
              role: 'system',
              content: 'You proofread speech-recognition subtitles. Return JSON only: {"segments":[{"id":number,"text":string}]}. Keep exactly the supplied IDs, one item per ID, in the same order. Do not add, remove, merge, or split segments. Do not invent names, numbers, facts, or missing speech. Correct punctuation, obvious grammar, and clearly contextual recognition errors only. Preserve the language of each segment.'
            },
            { role: 'user', content: JSON.stringify({ segments: payload }) }
          ], undefined, 4000);
          const edits = parseRefinedTranscriptionResponse(response, new Set(chunk.map(segment => segment.id)));
          edits.forEach((text, id) => updated.set(id, text));
        }
        return updated;
      }

      async function writeRefinedTranscription(result) {
        const rawSrt = await readTranscriptionText(result.raw_srt_path);
        const segments = parseTranscriptionSrt(rawSrt);
        if (segments.length === 0) throw new Error('No subtitle segments were produced');
        setTranscriptionProgress(97, transcriptionProgressLabel('refining'));
        const refined = await refineTranscriptionSegments(segments);
        const finalSegments = segments.map(segment => ({ ...segment, text: refined.get(segment.id) || segment.text }));
        const srt = finalSegments.map((segment, index) => `${index + 1}\n${segment.start} --> ${segment.end}\n${segment.text}`).join('\n\n') + '\n';
        const txt = finalSegments.map(segment => segment.text.replace(/\n/g, ' ')).join('\n') + '\n';
        const outputDir = result.raw_srt_path.replace(/[/\\][^/\\]+$/, '');
        const rawSrtName = result.raw_srt_path.split(/[\\/]/).pop() || 'transcript.srt';
        const rawTxtName = result.raw_txt_path.split(/[\\/]/).pop() || 'transcript.txt';
        const srtName = rawSrtName.replace(/\.srt$/i, '_refined.srt');
        const txtName = rawTxtName.replace(/\.txt$/i, '_refined.txt');
        const { invoke } = await tauriCorePromise;
        const written = await invoke('write_unique_file_pair', {
          directory: outputDir,
          firstFileName: srtName,
          firstBytes: Array.from(new TextEncoder().encode(srt)),
          secondFileName: txtName,
          secondBytes: Array.from(new TextEncoder().encode(txt))
        });
        return { srtPath: written.first_path, txtPath: written.second_path };
      }

      async function showTranscriptionResult(result, refined = null) {
        transcriptionOverlay?.classList.add('has-result');
        if (transcriptionFiles) {
          transcriptionFiles.replaceChildren();
          transcriptionFiles.classList.add('has-files');
        }
        const outputDir = String(result?.raw_srt_path || result?.raw_txt_path || '').replace(/[/\\][^/\\]+$/, '');
        setTranscriptionOutputDir(outputDir);
        const previewSrtPath = refined?.srtPath || result.raw_srt_path;
        const previewTxtPath = refined?.txtPath || result.raw_txt_path;
        try {
          const [srtValue, txtValue] = await Promise.all([
            previewSrtPath ? readTranscriptionText(previewSrtPath) : Promise.resolve(''),
            previewTxtPath ? readTranscriptionText(previewTxtPath) : Promise.resolve('')
          ]);
          renderTranscriptionPreview(parseTranscriptionSrt(srtValue), txtValue);
        } catch (error) {
          console.error('Cannot preview transcription result:', error);
          renderTranscriptionPreview([], '');
        }
        const paths = [
          [t('home.transcription.rawJson'), result.raw_json_path],
          [t('home.transcription.rawSrt'), result.raw_srt_path],
          [t('home.transcription.rawTxt'), result.raw_txt_path],
          ...(refined ? [[t('home.transcription.refinedSrt'), refined.srtPath], [t('home.transcription.refinedTxt'), refined.txtPath]] : [])
        ];
        paths.forEach(([label, path], index) => {
          if (!transcriptionFiles) return;
          const filePath = String(path || '');
          const item = document.createElement('div');
          item.className = 'audio-convert-file-item';
          item.title = displayFilesystemPath(filePath);
          item.innerHTML = `
            <span class="audio-convert-file-index">${index + 1}</span>
            <span class="audio-convert-file-name">${escapeHtml(filePath.split(/[\\/]/).pop() || label)}</span>
            <span class="transcription-result-type">${escapeHtml(label)}</span>
          `;
          lifecycle.event(item, 'dblclick', async () => {
            if (!isTauri || !filePath) return;
            try {
              const { invoke } = await tauriCorePromise;
              await invoke('open_path', { path: filePath });
            } catch (error) {
              console.error('Cannot open transcription output file:', error);
            }
          });
          transcriptionFiles.append(item);
        });
      }

      lifecycle.event(transcriptionCopyTextBtn, 'click', async () => {
        if (!transcriptionPreviewText || !navigator.clipboard?.writeText) return;
        try {
          await navigator.clipboard.writeText(transcriptionPreviewText);
          setTranscriptionCopyButtonState(true);
          notify?.(t('home.transcription.copyDone'));
          setTimeout(() => setTranscriptionCopyButtonState(false), 1200);
        } catch (error) {
          console.error('Cannot copy transcription text:', error);
        }
      });

      lifecycle.event(transcriptionOpenFolderBtn, 'click', async () => {
        if (!isTauri || !transcriptionOutputDir) return;
        try {
          const { invoke } = await tauriCorePromise;
          await invoke('open_path', { path: transcriptionOutputDir });
        } catch (error) {
          console.error('Cannot open transcription output folder:', error);
        }
      });

  function showTranscriptionSuccess(result, refined = null, refineFailed = false) {
        const outputDir = String(result.raw_srt_path || '').replace(/[/\\][^/\\]+$/, '');
        setTranscriptionOutputDir(outputDir);
        if (transcriptionSuccessMeta) {
          transcriptionSuccessMeta.textContent = refineFailed
            ? t('home.transcription.refineFailed')
            : t('home.transcription.success');
        }
    if (transcriptionSuccessCount) transcriptionSuccessCount.textContent = String(refined ? 5 : 3);
    if (transcriptionSuccessPath) transcriptionSuccessPath.textContent = displayFilesystemPath(outputDir);
    setTranscriptionSuccessVisible(true);
    notify?.(refineFailed ? t('home.transcription.refineFailed') : t('home.transcription.doneInline'));
  }

      lifecycle.event(transcriptionSuccessOk, 'click', () => setTranscriptionSuccessVisible(false));
      lifecycle.event(transcriptionSuccessOpenFolder, 'click', async () => {
        if (!isTauri || !transcriptionOutputDir) return;
        try {
          const { invoke } = await tauriCorePromise;
          await invoke('open_path', { path: transcriptionOutputDir });
        } catch (error) {
          console.error('Cannot open transcription output folder:', error);
        }
      });

      lifecycle.event(transcriptionProcessBtn, 'click', async () => {
        if (!transcriptionFile || transcriptionProcessing || !isTauri) return;
        if (!transcriptionFile.path) { notify?.(t('home.transcription.desktopOnly')); return; }
        const operationToken = lifecycle.invalidate();
        transcriptionProcessing = true;
        updateTranscriptionProcessButton();
        transcriptionProcessMask?.classList.add('visible');
        setTranscriptionProgress(2, transcriptionProgressLabel('preparing'));
        let unlisten = null;
        let completion = null;
        try {
          const { invoke } = await tauriCorePromise;
          const { listen } = await tauriEventPromise;
          unlisten = await listen('transcription-progress', event => {
            if (!lifecycle.isCurrent(operationToken)) return;
            const progress = event.payload;
            if (!progress) return;
            setTranscriptionProgress(progress.progress || 0, transcriptionProgressLabel(progress.phase));
          });
          const result = await invoke('transcribe_media', {
            inputPath: transcriptionFile.path,
            outputDir: await getOutputDir('Transcripts'),
            language: transcriptionLanguage
          });
          if (!lifecycle.isCurrent(operationToken)) return;
          let refined = null;
          let refineFailed = false;
          if (transcriptionRefine?.checked) {
            try {
              refined = await writeRefinedTranscription(result);
            } catch (error) {
              console.error('Transcription refinement failed:', error);
              refineFailed = true;
            }
          }
          if (!lifecycle.isCurrent(operationToken)) return;
          await showTranscriptionResult(result, refined);
          if (!lifecycle.isCurrent(operationToken)) return;
          completion = { result, refined, refineFailed };
          setTranscriptionProgress(100, transcriptionProgressLabel('complete'));
        } catch (error) {
          console.error('Transcription failed:', error);
          notify?.(t('common.errorOccurred', { error: String(error?.message || error) }));
        } finally {
          unlisten?.();
          if (!lifecycle.isCurrent(operationToken)) return;
          transcriptionProcessing = false;
          transcriptionProcessMask?.classList.remove('visible');
          updateTranscriptionProcessButton();
          setTranscriptionProgress(0, transcriptionProgressLabel('preparing'));
          if (completion) showTranscriptionSuccess(completion.result, completion.refined, completion.refineFailed);
        }
      });



  const languageUnsubscribe = onLangChange?.(() => {
    updateTranscriptionUploadState();
    syncTranscriptionInlineLabels();
  }) || (() => {});
  lifecycle.use(languageUnsubscribe);

  function dispose() {
    if (lifecycle.disposed) return;
    closeTranscriptionTool();
    try { nativeDragUnlisten?.(); } catch {}
    nativeDragUnlisten = null;
    lifecycle.dispose();
    overlay.replaceChildren();
  }

  return { open: openTranscriptionTool, close: closeTranscriptionTool, dispose };
}
