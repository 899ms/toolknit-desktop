import { createLifecycleScope } from '../../app/tool-lifecycle.js';
import { getLang, onLangChange, t } from '../../i18n.js';
import { tauriCorePromise } from '../../platform/tauri-runtime.js';
import { bindTextDocumentDrop } from '../../shared/text-document-drop.js';
import {
  readTextDocument,
  TEXT_DOCUMENT_EXTENSIONS,
  textDocumentErrorKey
} from '../../shared/text-document-reader.js';
import { TEXT_STATS_LIMITS, calculateTextStats } from '../../text-stats-core.js';
import './text-stats.css';

const EMPTY_SOURCE = Object.freeze({ type: 'manual', name: '', bytes: 0, kind: '' });
const STAT_FIELDS = Object.freeze({
  textStatsChars: 'chars',
  textStatsCharsNoSpace: 'charsNoSpace',
  textStatsSpaces: 'spaces',
  textStatsWords: 'words',
  textStatsEnglishWords: 'englishWords',
  textStatsLines: 'lines',
  textStatsParagraphs: 'paragraphs',
  textStatsSentences: 'sentences',
  textStatsChineseChars: 'chineseChars',
  textStatsLetters: 'letters',
  textStatsUppercase: 'uppercase',
  textStatsLowercase: 'lowercase',
  textStatsDigits: 'digits',
  textStatsNumbers: 'numbers',
  textStatsPunctuation: 'punctuation',
  textStatsLongestLine: 'longestLine',
  textStatsNonEmptyLines: 'nonEmptyLines',
  textStatsUniqueWords: 'uniqueWords',
  textStatsRepeatedWords: 'repeatedWords'
});

function labels(isZh) {
  return isZh ? {
    chars: '总字符数', charsNoSpace: '不含空格字符', spaces: '空格数',
    words: '单词总数', englishWords: '英文单词数', chineseChars: '中文字符',
    letters: '英文字母', uppercase: '大写字母', lowercase: '小写字母',
    digits: '数字字符', numbers: '数字片段', punctuation: '标点符号', lines: '行数',
    paragraphs: '段落数', sentences: '句子数', longestLine: '最长行字符',
    avgLineLength: '平均行长', nonEmptyLines: '有效行数', uniqueWords: '唯一词/字',
    repeatedWords: '重复词/字', avgWordLength: '平均词长', avgSentenceLength: '平均句长',
    readingTime: '预计阅读(分钟)', speakingTime: '预计朗读(分钟)', lexicalDensity: '词汇密度',
    topWords: '英文高频词', topChineseChars: '中文高频字'
  } : {
    chars: 'Characters', charsNoSpace: 'Chars (no space)', spaces: 'Spaces',
    words: 'Total Words', englishWords: 'English Words', chineseChars: 'Chinese Chars',
    letters: 'Letters', uppercase: 'Uppercase', lowercase: 'Lowercase',
    digits: 'Digit chars', numbers: 'Numbers', punctuation: 'Punctuation', lines: 'Lines',
    paragraphs: 'Paragraphs', sentences: 'Sentences', longestLine: 'Longest Line',
    avgLineLength: 'Avg Line Length', nonEmptyLines: 'Non-empty Lines', uniqueWords: 'Unique Words/Chars',
    repeatedWords: 'Repeated Words/Chars', avgWordLength: 'Avg Word Length', avgSentenceLength: 'Avg Sentence Length',
    readingTime: 'Reading (min)', speakingTime: 'Speaking (min)', lexicalDensity: 'Lexical Density',
    topWords: 'Top English Words', topChineseChars: 'Top Chinese Chars'
  };
}

function frequencyMarkdown(items, emptyText) {
  if (!items?.length) return `- ${emptyText}`;
  return items
    .map((item, index) => `| ${index + 1} | ${String(item.text).replace(/\|/g, '\\|')} | ${item.count} |`)
    .join('\n');
}

export function initTextStatsTool({
  overlay,
  isTauri = false,
  notify = () => {},
  formatFileSize = value => `${Number(value) || 0} B`,
  getOutputDir,
  displayFilesystemPath = value => String(value || ''),
  initStandardToolPlasma = () => null,
  disposeStandardToolPlasma = instance => instance
} = {}) {
  if (!overlay) throw new Error('text-stats:missing-overlay');
  const lifecycle = createLifecycleScope();
  const byId = id => overlay.querySelector(`#${id}`);
  const back = byId('textStatsBack');
  const background = byId('textStatsBg');
  const dropZone = byId('textStatsDropZone');
  const dropCard = byId('textStatsDropCard');
  const cta = byId('textStatsCta');
  const selectFileButton = byId('textStatsSelectFileBtn');
  const fileInput = byId('textStatsFileInput');
  const fileInfo = byId('textStatsFileInfo');
  const fileName = byId('textStatsFileName');
  const fileMeta = byId('textStatsFileMeta');
  const input = byId('textStatsInput');
  const clearButton = byId('textStatsClearBtn');
  const copyButton = byId('textStatsCopyBtn');
  const exportButton = byId('textStatsExportMdBtn');
  const valueElements = Object.fromEntries(Object.entries(STAT_FIELDS).map(([id, key]) => [key, byId(id)]));
  const avgLineLength = byId('textStatsAvgLineLength');
  const avgWordLength = byId('textStatsAvgWordLength');
  const avgSentenceLength = byId('textStatsAvgSentenceLength');
  const readingTime = byId('textStatsReadingTime');
  const speakingTime = byId('textStatsSpeakingTime');
  const lexicalDensity = byId('textStatsLexicalDensity');

  let source = { ...EMPTY_SOURCE };
  let plasma = null;
  let frameId = 0;
  let debounceTimer = 0;
  let focusTimer = 0;
  let copyTimer = 0;
  let copyButtonLabel = '';
  let readRunId = 0;

  const copy = (key, params) => t(`home.textStats.${key}`, params);
  const formatNumber = value => {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric.toLocaleString() : '0';
  };

  function clearScheduledWork() {
    if (frameId) cancelAnimationFrame(frameId);
    if (debounceTimer) clearTimeout(debounceTimer);
    if (focusTimer) clearTimeout(focusTimer);
    if (copyTimer) clearTimeout(copyTimer);
    frameId = 0;
    debounceTimer = 0;
    focusTimer = 0;
    copyTimer = 0;
    if (copyButton && copyButtonLabel) copyButton.textContent = copyButtonLabel;
    copyButtonLabel = '';
  }

  function updateSource(next = EMPTY_SOURCE) {
    source = { ...EMPTY_SOURCE, ...next };
    const manual = source.type === 'manual';
    fileInfo?.classList.toggle('has-file', !manual);
    if (fileName) fileName.textContent = manual ? copy('manualInput') : source.name;
    if (fileMeta) {
      fileMeta.textContent = manual
        ? copy('manualMeta')
        : copy('fileMeta', {
            type: source.kind || copy('document'),
            size: formatFileSize(source.bytes || 0)
          });
    }
  }

  function currentStats() {
    const text = input?.value || '';
    return { stats: calculateTextStats(text), isEmpty: text.trim() === '' };
  }

  function renderStats() {
    const { stats, isEmpty } = currentStats();
    for (const [key, element] of Object.entries(valueElements)) {
      if (element) element.textContent = formatNumber(stats[key]);
    }
    if (avgLineLength) avgLineLength.textContent = formatNumber(isEmpty ? 0 : stats.avgLineLength);
    if (avgWordLength) avgWordLength.textContent = isEmpty ? '0' : String(stats.avgWordLength);
    if (avgSentenceLength) avgSentenceLength.textContent = isEmpty ? '0' : String(stats.avgSentenceLength);
    if (readingTime) readingTime.textContent = formatNumber(isEmpty ? 0 : stats.readingTime);
    if (speakingTime) speakingTime.textContent = formatNumber(isEmpty ? 0 : stats.speakingTime);
    if (lexicalDensity) lexicalDensity.textContent = `${isEmpty ? 0 : stats.lexicalDensity}%`;
  }

  function scheduleRender() {
    const scheduleFrame = () => {
      if (frameId) return;
      frameId = requestAnimationFrame(() => {
        frameId = 0;
        renderStats();
      });
    };
    if ((input?.value.length || 0) > 20_000) {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        debounceTimer = 0;
        scheduleFrame();
      }, 120);
    } else scheduleFrame();
  }

  function sourceLabel(isZh) {
    return source.type === 'file'
      ? `${source.name || (isZh ? '文档' : 'Document')} · ${source.kind || copy('document')}${source.bytes ? ` · ${formatFileSize(source.bytes)}` : ''}`
      : (isZh ? '手动输入' : 'Manual input');
  }

  function createMarkdown(stats, isEmpty) {
    const isZh = getLang() === 'zh';
    const text = labels(isZh);
    const rows = items => items.map(([label, value]) => `| ${label} | ${value} |`).join('\n');
    const topWords = frequencyMarkdown(stats.topWords, copy('noTopWords'));
    const topChinese = frequencyMarkdown(stats.topChineseChars, copy('noTopChineseChars'));
    return [
      `# ${isZh ? '文本统计报告' : 'Text Statistics Report'}`,
      '',
      `- ${isZh ? '来源' : 'Source'}: ${sourceLabel(isZh)}`,
      `- ${isZh ? '生成时间' : 'Generated At'}: ${new Date().toLocaleString(isZh ? 'zh-CN' : 'en-US')}`,
      '',
      `## ${isZh ? '核心统计' : 'Overview'}`,
      '', '| 指标 | 数值 |', '| --- | ---: |',
      rows([[text.chars, stats.chars], [text.charsNoSpace, stats.charsNoSpace], [text.words, stats.words], [text.englishWords, stats.englishWords], [text.chineseChars, stats.chineseChars], [text.spaces, stats.spaces]]),
      '',
      `## ${isZh ? '文本结构' : 'Structure'}`,
      '', '| 指标 | 数值 |', '| --- | ---: |',
      rows([[text.lines, stats.lines], [text.nonEmptyLines, stats.nonEmptyLines], [text.paragraphs, stats.paragraphs], [text.sentences, stats.sentences], [text.longestLine, stats.longestLine], [text.avgLineLength, isEmpty ? 0 : stats.avgLineLength]]),
      '',
      `## ${isZh ? '阅读与词汇' : 'Reading & Lexical'}`,
      '', '| 指标 | 数值 |', '| --- | ---: |',
      rows([[text.uniqueWords, stats.uniqueWords], [text.repeatedWords, stats.repeatedWords], [text.avgWordLength, isEmpty ? 0 : stats.avgWordLength], [text.avgSentenceLength, isEmpty ? 0 : stats.avgSentenceLength], [text.readingTime, isEmpty ? 0 : stats.readingTime], [text.speakingTime, isEmpty ? 0 : stats.speakingTime], [text.lexicalDensity, `${isEmpty ? 0 : stats.lexicalDensity}%`]]),
      '',
      `## ${isZh ? '词频分析' : 'Frequency'}`,
      '', `### ${text.topWords}`, '',
      stats.topWords?.length ? `| 排名 | 词 | 次数 |\n| ---: | --- | ---: |\n${topWords}` : topWords,
      '', `### ${text.topChineseChars}`, '',
      stats.topChineseChars?.length ? `| 排名 | 字 | 次数 |\n| ---: | --- | ---: |\n${topChinese}` : topChinese,
      ''
    ].join('\n');
  }

  function errorMessage(error) {
    const key = textDocumentErrorKey(error);
    if (key === 'fileTooLarge') return copy(key, { max: Math.round(TEXT_STATS_LIMITS.maxDocumentBytes / 1024 / 1024) });
    if (key === 'tooManyPdfPages') return copy(key, { max: TEXT_STATS_LIMITS.maxPdfPages });
    return copy(key);
  }

  async function loadDocument(file) {
    if (!file) return;
    const runId = ++readRunId;
    const token = lifecycle.token();
    overlay.classList.add('is-reading-file');
    try {
      const result = await readTextDocument(file, {
        isTauri,
        fallbackName: copy('document'),
        onTrim: max => {
          if (runId === readRunId && lifecycle.isCurrent(token)) notify(copy('documentTrimmed', { max }));
        }
      });
      if (runId !== readRunId || !lifecycle.isCurrent(token) || !overlay.classList.contains('visible')) return;
      if (input) {
        input.value = result.text;
        input.focus();
      }
      updateSource({ type: 'file', name: result.name, bytes: result.bytes, kind: result.kind });
      renderStats();
      notify(copy('fileLoaded', { name: result.name }));
    } catch (error) {
      if (runId === readRunId && lifecycle.isCurrent(token)) notify(errorMessage(error));
    } finally {
      if (runId === readRunId) overlay.classList.remove('is-reading-file');
      if (fileInput) fileInput.value = '';
    }
  }

  async function chooseDocument() {
    if (overlay.classList.contains('is-reading-file')) return;
    if (!isTauri) {
      fileInput?.click();
      return;
    }
    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const selected = await open({
        multiple: false,
        filters: [{ name: 'Documents', extensions: [...TEXT_DOCUMENT_EXTENSIONS] }]
      });
      if (selected) await loadDocument({ path: selected, name: String(selected).split(/[/\\]/).pop() });
    } catch (error) {
      console.error('Text stats file picker failed:', error);
      notify(copy('readFailed'));
    }
  }

  async function exportMarkdown() {
    const { stats, isEmpty } = currentStats();
    const markdown = createMarkdown(stats, isEmpty);
    const safeBase = (source.type === 'file' ? source.name : 'text-stats')
      .replace(/\.[^.]+$/, '')
      .replace(/[<>:"/\\|?*\x00-\x1F]+/g, '-')
      .replace(/\s+/g, '-')
      .slice(0, 80) || 'text-stats';
    const outputName = `${safeBase}-统计报告.md`;
    try {
      if (isTauri) {
        const { invoke } = await tauriCorePromise;
        const outputDir = await getOutputDir('Text_Stats');
        const outputPath = await invoke('write_unique_file_bytes', {
          directory: outputDir,
          fileName: outputName,
          bytes: Array.from(new TextEncoder().encode(markdown))
        });
        notify(copy('exportMdDone', { path: displayFilesystemPath(outputPath) }));
      } else {
        const url = URL.createObjectURL(new Blob([markdown], { type: 'text/markdown;charset=utf-8' }));
        try {
          const link = document.createElement('a');
          link.href = url;
          link.download = outputName;
          document.body.appendChild(link);
          link.click();
          link.remove();
        } finally {
          URL.revokeObjectURL(url);
        }
        notify(copy('exportMdDone'));
      }
    } catch (error) {
      console.error('Text stats markdown export failed:', error);
      notify(copy('exportMdFailed'));
    }
  }

  function copyStats() {
    if (!input) return;
    const { stats, isEmpty } = currentStats();
    const isZh = getLang() === 'zh';
    const text = labels(isZh);
    const lines = [
      `${isZh ? '来源' : 'Source'}: ${sourceLabel(isZh)}`,
      ...[
        ['chars', stats.chars], ['charsNoSpace', stats.charsNoSpace], ['spaces', stats.spaces],
        ['words', stats.words], ['englishWords', stats.englishWords], ['chineseChars', stats.chineseChars],
        ['letters', stats.letters], ['uppercase', stats.uppercase], ['lowercase', stats.lowercase],
        ['digits', stats.digits], ['numbers', stats.numbers], ['punctuation', stats.punctuation],
        ['lines', stats.lines], ['nonEmptyLines', stats.nonEmptyLines], ['paragraphs', stats.paragraphs],
        ['sentences', stats.sentences], ['longestLine', stats.longestLine],
        ['avgLineLength', isEmpty ? 0 : stats.avgLineLength], ['uniqueWords', stats.uniqueWords],
        ['repeatedWords', stats.repeatedWords], ['avgWordLength', isEmpty ? 0 : stats.avgWordLength],
        ['avgSentenceLength', isEmpty ? 0 : stats.avgSentenceLength], ['readingTime', isEmpty ? 0 : stats.readingTime],
        ['speakingTime', isEmpty ? 0 : stats.speakingTime]
      ].map(([key, value]) => `${text[key]}: ${value}`),
      `${text.lexicalDensity}: ${isEmpty ? 0 : stats.lexicalDensity}%`
    ];
    if (!navigator.clipboard?.writeText) {
      notify(copy('copyFailed'));
      return;
    }
    navigator.clipboard.writeText(lines.join('\n')).then(() => {
      if (!copyButton) return;
      if (copyTimer) clearTimeout(copyTimer);
      copyButtonLabel = copyButton.textContent;
      copyButton.textContent = '✓';
      copyTimer = setTimeout(() => {
        copyTimer = 0;
        if (copyButtonLabel) copyButton.textContent = copyButtonLabel;
        copyButtonLabel = '';
      }, 1500);
    }).catch(() => notify(copy('copyFailed')));
  }

  lifecycle.event(back, 'click', () => { void api.close(); });
  lifecycle.event(cta, 'click', () => { void chooseDocument(); });
  lifecycle.event(selectFileButton, 'click', () => { void chooseDocument(); });
  lifecycle.event(fileInput, 'change', event => {
    const file = event.target.files?.[0];
    if (file) void loadDocument(file);
  });
  lifecycle.event(input, 'input', () => {
    if (input.value.length > TEXT_STATS_LIMITS.maxInputChars) {
      input.value = input.value.slice(0, TEXT_STATS_LIMITS.maxInputChars);
      notify(copy('inputTooLong', { max: TEXT_STATS_LIMITS.maxInputChars }));
    }
    updateSource();
    scheduleRender();
  });
  lifecycle.event(clearButton, 'click', () => {
    if (!input) return;
    input.value = '';
    input.focus();
    updateSource();
    renderStats();
  });
  lifecycle.event(copyButton, 'click', copyStats);
  lifecycle.event(exportButton, 'click', () => { void exportMarkdown(); });
  lifecycle.use(onLangChange(() => {
    if (copyTimer) clearTimeout(copyTimer);
    copyTimer = 0;
    copyButtonLabel = '';
    updateSource(source);
  }));
  bindTextDocumentDrop({
    lifecycle,
    overlay,
    dropZone,
    dropCard,
    isTauri,
    onFile: loadDocument,
    onError: error => console.error('Text stats drag registration failed:', error)
  });

  const api = {
    open() {
      lifecycle.invalidate();
      clearScheduledWork();
      overlay.classList.add('visible');
      overlay.setAttribute('aria-hidden', 'false');
      updateSource(source);
      renderStats();
      if (background && !plasma) plasma = initStandardToolPlasma(background);
      focusTimer = setTimeout(() => {
        focusTimer = 0;
        if (overlay.classList.contains('visible')) input?.focus();
      }, 300);
    },
    close() {
      lifecycle.invalidate();
      readRunId += 1;
      clearScheduledWork();
      overlay.classList.remove('visible', 'drag-over', 'is-reading-file');
      overlay.setAttribute('aria-hidden', 'true');
      dropZone?.classList.remove('visible');
      dropCard?.classList.remove('is-dragging');
      if (fileInput) fileInput.value = '';
      plasma = disposeStandardToolPlasma(plasma);
    },
    dispose() {
      api.close();
      lifecycle.dispose();
    }
  };

  return api;
}
