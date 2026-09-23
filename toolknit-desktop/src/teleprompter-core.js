import { simplifyChineseText } from './core/chinese-text.js';
export { simplifyChineseText } from './core/chinese-text.js';

// Bounded local edit alignment, anchored at the transcript's newest character.
// Inputs are normalized text; this module has no DOM or platform dependency.
function alignSpeechTail(query, target) {
  let previous = Array.from({ length: target.length + 1 }, () => ({ score: 0 }));
  for (let row = 1; row <= query.length; row += 1) {
    const current = [{ score: 0 }];
    for (let column = 1; column <= target.length; column += 1) {
      const exact = query[row - 1] === target[column - 1];
      const candidates = [
        [previous[column - 1], exact ? 3 : -2, exact ? 1 : 0],
        [previous[column], -2, 0],
        [current[column - 1], -2, 0]
      ];
      let best = { score: 0 };
      for (const [cell, delta, match] of candidates) {
        if (cell.score + delta <= best.score) continue;
        best = {
          score: cell.score + delta,
          queryStart: cell.score ? cell.queryStart : row - 1,
          start: cell.score ? cell.start : column - 1,
          matches: (cell.matches || 0) + match
        };
      }
      current.push(best);
    }
    previous = current;
  }
  return previous.flatMap((cell, end) => {
    if (!cell.score) return [];
    const querySpan = query.length - cell.queryStart;
    const span = end - cell.start;
    return [{
      ...cell, end,
      coverage: querySpan / query.length,
      accuracy: cell.matches / Math.max(querySpan, span),
      endAnchor: query.at(-1) === target[end - 1]
    }];
  });
}

export const TELEPROMPTER_LIMITS = Object.freeze({
  maxInputChars: 160_000,
  maxSentences: 4_000,
  minFontSize: 28,
  maxFontSize: 96,
  minSpeed: 10,
  maxSpeed: 120
});

const CJK_RE = /[\u3400-\u9fff\uf900-\ufaff]/g;
const WORD_RE = /[a-z0-9]+(?:['’-][a-z0-9]+)*/gi;
// A period only ends a sentence when digits do not surround it, so versions
// like "GLM-5.3" and "2.3.0" stay inside one sentence.
const TERMINAL_RE = /(?:(?<=\d)\.(?=\d)|[^。！？!?；;.\n])+(?:[。！？!?；;]+|\.|$)/g;
const SOFT_BREAK_RE = /(?<=[，,：:、])\s*/g;
const FILLER_TOKENS = new Set(['uh', 'um', 'erm', 'hmm', 'ah', 'eh']);

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function trimWithOffset(value, baseOffset) {
  const leading = value.length - value.trimStart().length;
  const text = value.trim();
  return { text, start: baseOffset + leading, end: baseOffset + leading + text.length };
}

function splitLongSentence(entry) {
  const cjkCount = (entry.text.match(CJK_RE) || []).length;
  const cjkDense = cjkCount / Math.max(1, entry.text.length) >= 0.28;
  const maxChars = cjkDense ? 18 : 84;
  const hardChunkSize = cjkDense ? 12 : 68;
  const minBreakDistance = cjkDense ? 6 : 28;
  if (entry.text.length <= maxChars) return [entry];
  const pieces = [];
  let cursor = 0;
  let chunkStart = 0;
  const softBreaks = Array.from(entry.text.matchAll(SOFT_BREAK_RE), match => match.index + match[0].length);
  const wordBreaks = Array.from(entry.text.matchAll(/\s+/g), match => match.index + match[0].length);
  while (entry.text.length - chunkStart > maxChars) {
    const preferred = softBreaks.filter(index => index > chunkStart + minBreakDistance && index <= chunkStart + maxChars).at(-1);
    const wordBreak = wordBreaks.filter(index => index > chunkStart + minBreakDistance && index <= chunkStart + maxChars).at(-1);
    const end = preferred || wordBreak || Math.min(entry.text.length, chunkStart + hardChunkSize);
    const part = trimWithOffset(entry.text.slice(chunkStart, end), entry.start + chunkStart);
    if (part.text) pieces.push({ ...entry, ...part });
    cursor = end;
    chunkStart = end;
  }
  const tail = trimWithOffset(entry.text.slice(cursor), entry.start + cursor);
  if (tail.text) pieces.push({ ...entry, ...tail });
  return pieces;
}

export function normalizeSpeechText(value) {
  const normalized = simplifyChineseText(String(value || ''))
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[嗯呃额啊唔哦]+/g, '')
    .replace(/[^\p{L}\p{N}\u3400-\u9fff]+/gu, ' ')
    .trim();
  if (!normalized) return '';
  return normalized
    .split(/\s+/)
    .filter(token => !FILLER_TOKENS.has(token))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function segmentTeleprompterScript(input) {
  const text = String(input || '').replace(/\r\n?/g, '\n').slice(0, TELEPROMPTER_LIMITS.maxInputChars);
  const sentences = [];
  const paragraphs = [];
  let paragraphIndex = 0;
  const paragraphPattern = /[^\n]+(?:\n(?!\n)[^\n]+)*/g;

  for (const paragraphMatch of text.matchAll(paragraphPattern)) {
    const rawParagraph = paragraphMatch[0];
    const paragraphBase = paragraphMatch.index || 0;
    const trimmedParagraph = trimWithOffset(rawParagraph, paragraphBase);
    if (!trimmedParagraph.text) continue;
    const sentenceIds = [];

    for (const sentenceMatch of trimmedParagraph.text.matchAll(TERMINAL_RE)) {
      const rawSentence = sentenceMatch[0];
      const sentenceBase = trimmedParagraph.start + (sentenceMatch.index || 0);
      const trimmedSentence = trimWithOffset(rawSentence, sentenceBase);
      if (!trimmedSentence.text) continue;
      const parts = splitLongSentence({
        ...trimmedSentence,
        paragraphIndex
      });
      for (const part of parts) {
        if (sentences.length >= TELEPROMPTER_LIMITS.maxSentences) break;
        const sentence = {
          id: sentences.length,
          paragraphIndex,
          text: part.text,
          start: part.start,
          end: part.end,
          normalized: normalizeSpeechText(part.text)
        };
        sentences.push(sentence);
        sentenceIds.push(sentence.id);
      }
      if (sentences.length >= TELEPROMPTER_LIMITS.maxSentences) break;
    }

    if (sentenceIds.length) {
      paragraphs.push({
        id: paragraphIndex,
        text: trimmedParagraph.text,
        start: trimmedParagraph.start,
        end: trimmedParagraph.end,
        sentenceIds
      });
      paragraphIndex += 1;
    }
    if (sentences.length >= TELEPROMPTER_LIMITS.maxSentences) break;
  }

  return { text, paragraphs, sentences, truncated: String(input || '').length > text.length };
}

function levenshteinSimilarity(left, right) {
  if (left === right) return 1;
  if (!left || !right) return 0;
  const a = Array.from(left);
  const b = Array.from(right);
  if (Math.abs(a.length - b.length) > Math.max(a.length, b.length) * 0.72) return 0;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let row = 1; row <= a.length; row += 1) {
    const current = [row];
    for (let column = 1; column <= b.length; column += 1) {
      const cost = a[row - 1] === b[column - 1] ? 0 : 1;
      current[column] = Math.min(
        current[column - 1] + 1,
        previous[column] + 1,
        previous[column - 1] + cost
      );
    }
    previous = current;
  }
  return 1 - previous[b.length] / Math.max(a.length, b.length);
}

function grams(value) {
  const compact = value.replace(/\s+/g, '');
  if (compact.length <= 1) return compact ? [compact] : [];
  const size = compact.length < 8 ? 1 : 2;
  const result = [];
  for (let index = 0; index <= compact.length - size; index += 1) result.push(compact.slice(index, index + size));
  return result;
}

function diceSimilarity(left, right) {
  const leftGrams = grams(left);
  const rightGrams = grams(right);
  if (!leftGrams.length || !rightGrams.length) return 0;
  const counts = new Map();
  leftGrams.forEach(value => counts.set(value, (counts.get(value) || 0) + 1));
  let overlap = 0;
  rightGrams.forEach(value => {
    const count = counts.get(value) || 0;
    if (!count) return;
    overlap += 1;
    counts.set(value, count - 1);
  });
  return (2 * overlap) / (leftGrams.length + rightGrams.length);
}

export function speechMatchScore(transcript, scriptText) {
  const query = normalizeSpeechText(transcript).slice(-220);
  const candidate = normalizeSpeechText(scriptText);
  if (!query || !candidate) return 0;
  const compactQuery = query.replace(/\s+/g, '');
  const compactCandidate = candidate.replace(/\s+/g, '');
  const shorter = Math.min(compactQuery.length, compactCandidate.length);
  const longer = Math.max(compactQuery.length, compactCandidate.length);
  const contained = compactQuery.includes(compactCandidate) || compactCandidate.includes(compactQuery);
  const containment = contained ? clamp(shorter / Math.max(1, longer), 0.35, 1) : 0;
  const dice = diceSimilarity(query, candidate);
  const edit = longer <= 100 ? levenshteinSimilarity(compactQuery, compactCandidate) : 0;
  return clamp(Math.max(containment * 0.92, dice * 0.72 + edit * 0.28), 0, 1);
}

export function findSpeechMatch(sentences, transcript, currentIndex = 0, options = {}) {
  const list = Array.isArray(sentences) ? sentences : [];
  if (!list.length) return null;
  const current = clamp(Math.trunc(Number(currentIndex) || 0), 0, list.length - 1);
  const lookBehind = clamp(Math.trunc(options.lookBehind ?? 0), 0, 2);
  const lookAhead = clamp(Math.trunc(options.lookAhead ?? 10), 1, 24);
  const start = Math.max(0, current - lookBehind);
  const end = Math.min(list.length - 1, current + lookAhead);
  let best = null;

  for (let index = start; index <= end; index += 1) {
    const singleScore = speechMatchScore(transcript, list[index]?.normalized || list[index]?.text || '');
    const pairText = index < end
      ? `${list[index]?.text || ''} ${list[index + 1]?.text || ''}`
      : '';
    const pairScore = pairText ? speechMatchScore(transcript, pairText) * 0.96 : 0;
    const score = Math.max(singleScore, pairScore);
    const distancePenalty = Math.max(0, index - current - 4) * 0.018;
    const adjusted = score - distancePenalty;
    if (!best || adjusted > best.adjusted) best = { index, score, adjusted };
  }

  const queryLength = normalizeSpeechText(transcript).replace(/\s+/g, '').length;
  const threshold = queryLength < 5 ? 0.82 : (queryLength < 10 ? 0.63 : 0.5);
  if (!best || best.score < (options.threshold ?? threshold)) return null;
  return { index: best.index, score: Number(best.score.toFixed(4)) };
}

function compactSpeech(value) {
  return normalizeSpeechText(value).replace(/\s+/g, '');
}

export function findSpeechPosition(sentences, transcript, currentIndex = 0, { rolling = false, floorIndex = 0 } = {}) {
  const query = compactSpeech(transcript).slice(-80);
  if (query.length === 2 && query === compactSpeech(sentences[currentIndex]?.text)) {
    return { index: currentIndex, progress: 1, score: 1, endAnchor: true };
  }
  if (query.length < 3) return null;
  const start = Math.max(0, floorIndex, currentIndex - (rolling ? 3 : 0));
  const end = Math.min(sentences.length, currentIndex + 7);
  const positions = [];
  let target = '';
  for (let index = start; index < end; index += 1) {
    const text = compactSpeech(sentences[index]?.normalized || sentences[index]?.text);
    for (let offset = 0; offset < text.length; offset += 1) {
      positions.push({ index, progress: (offset + 1) / text.length });
    }
    target += text;
  }
  let best = null;
  for (const match of alignSpeechTail(query, target)) {
    const position = positions[match.end - 1];
    if (!position || match.coverage < 0.65 || match.matches < Math.max(3, Math.ceil(Math.min(query.length, 24) * 0.6))) continue;
    const distance = position.index - currentIndex;
    if (match.accuracy < (query.length < 6 ? 0.9 : 0.72)) continue;
    if (distance > 1 && (match.matches < 6 || match.accuracy < 0.8)) continue;
    const rank = match.score - Math.max(0, distance - 1) * 1.5;
    if (!best || rank > best.rank) best = { ...position, score: match.accuracy, rank, endAnchor: match.endAnchor };
  }
  return best;
}

// Fraction (0..1) covered by an ordered transcript-tail alignment.
export function speechReadingProgress(transcript, sentenceText) {
  return findSpeechPosition([{ text: sentenceText }], transcript)?.progress || 0;
}

function appendSpeechContext(previous, next, maxChars = 440) {
  const joined = `${String(previous || '').trim()} ${String(next || '').trim()}`.trim();
  return joined.length > maxChars ? joined.slice(-maxChars) : joined;
}

// Web Speech results are cumulative only inside one recognition session. The
// browser regularly ends and restarts that session, so preserve committed
// finals across restarts and expose only the newly changed result as evidence.
export function createSystemSpeechTranscriptState(maxChars = 700) {
  let committed = '';
  let sessionFinal = '';
  let finalCount = 0;

  return {
    push(results, resultIndex = 0) {
      const list = Array.from(results || []);
      const finals = [];
      const interim = [];
      const latest = [];
      list.forEach((result, index) => {
        const text = String(result?.[0]?.transcript || '').trim();
        if (!text) return;
        if (result.isFinal) finals.push(text);
        else interim.push(text);
        if (index >= Math.max(0, Number(resultIndex) || 0)) latest.push(text);
      });
      const nextSessionFinal = finals.join(' ').trim();
      const nextFinalCount = finals.length;
      const hasNewFinal = nextFinalCount > finalCount
        || (nextFinalCount === finalCount && nextSessionFinal !== sessionFinal && nextFinalCount > 0);
      sessionFinal = nextSessionFinal;
      finalCount = nextFinalCount;
      return {
        transcript: appendSpeechContext(appendSpeechContext(committed, sessionFinal, maxChars), interim.join(' '), maxChars),
        latest: latest.join(' ').trim(),
        final: hasNewFinal
      };
    },
    endSession() {
      committed = appendSpeechContext(committed, sessionFinal, maxChars);
      sessionFinal = '';
      finalCount = 0;
      return committed;
    },
    reset() {
      committed = '';
      sessionFinal = '';
      finalCount = 0;
    }
  };
}

export function createSpeechFollower(sentences, startIndex = 0) {
  const list = Array.isArray(sentences) ? sentences : [];
  let currentIndex = clamp(Math.trunc(startIndex || 0), 0, Math.max(0, list.length - 1));
  let pendingIndex = -1;
  let pendingCount = 0;
  let finalEvidence = '';
  let pendingEvidence = '';
  let lastRolling = null;
  let rollingFloor = currentIndex;

  return {
    get index() { return currentIndex; },
    reset(index = 0) {
      currentIndex = clamp(Math.trunc(index || 0), 0, Math.max(0, list.length - 1));
      pendingIndex = -1;
      pendingCount = 0;
      finalEvidence = '';
      pendingEvidence = '';
      lastRolling = null;
      rollingFloor = currentIndex;
      return currentIndex;
    },
    push(transcript, { final = false, context = transcript, cumulative = false,
      rolling = false, windowStart = 0, windowEnd = 0, utterance = 0, recognitionSession = 0 } = {}) {
      if (!list.length) return null;
      const latest = String(transcript || '').trim();
      const normalized = compactSpeech(latest);
      if (rolling) {
        if (lastRolling && (lastRolling.recognitionSession !== recognitionSession || lastRolling.utterance !== utterance)) {
          lastRolling = null;
          rollingFloor = currentIndex;
          pendingCount = 0;
          pendingIndex = -1;
        }
        if (lastRolling && windowEnd <= lastRolling.windowEnd) return null;
        const duplicate = lastRolling?.text === normalized && lastRolling.utterance === utterance
          && windowStart < lastRolling.windowEnd;
        lastRolling = { text: normalized, windowEnd, utterance, recognitionSession };
        if (duplicate) return null;
      }
      if (final) finalEvidence = cumulative ? latest : appendSpeechContext(finalEvidence, latest);
      const evidence = final ? finalEvidence : latest;
      const position = findSpeechPosition(list, evidence, currentIndex, { rolling, floorIndex: rollingFloor });
      const evidenceMatch = position || (!rolling && findSpeechMatch(list, evidence, currentIndex, { lookBehind: 0, lookAhead: 6 }));
      const match = evidenceMatch || (!rolling && findSpeechMatch(list, context, currentIndex, { lookBehind: 0, lookAhead: 6 }));
      if (!match || match.index < currentIndex) {
        pendingIndex = -1;
        pendingCount = 0;
        return null;
      }
      if (match.index === currentIndex) {
        pendingIndex = -1;
        pendingCount = 0;
        const sentence = list[currentIndex]?.normalized || list[currentIndex]?.text || '';
        const progress = position?.progress ?? speechReadingProgress(evidence, sentence);
        const completed = (final || rolling) && Boolean(evidenceMatch) && progress >= 0.99
          && match.score >= 0.85 && (position?.endAnchor ?? true);
        if (completed && currentIndex < list.length - 1) {
          currentIndex += 1;
          finalEvidence = '';
          return { ...match, index: currentIndex, moved: true, completed: true, progress: 0 };
        }
        if (completed) finalEvidence = '';
        return { ...match, moved: false, completed, progress };
      }
      if (pendingIndex === match.index) {
        if (pendingEvidence !== normalized) pendingCount += 1;
      }
      else {
        pendingIndex = match.index;
        pendingCount = 1;
      }
      pendingEvidence = normalized;
      const isLargeJump = match.index - currentIndex > 3;
      const confirmed = (!isLargeJump && (match.score >= 0.82 || (final && match.score >= 0.6))) || pendingCount >= 2;
      if (!confirmed) return { ...match, moved: false, pending: true };
      currentIndex = match.index;
      pendingIndex = -1;
      pendingCount = 0;
      finalEvidence = '';
      return { ...match, moved: true, progress: position?.progress ?? 0 };
    }
  };
}

export function estimateTeleprompterDuration(text, speedMultiplier = 1) {
  const value = String(text || '');
  const chineseCharacters = (value.match(CJK_RE) || []).length;
  const latinWords = (value.match(WORD_RE) || []).length;
  const punctuationPauses = (value.match(/[。！？!?；;，,：:\n]/g) || []).length;
  const baseSeconds = chineseCharacters / 4.1 + latinWords / 2.45 + punctuationPauses * 0.22;
  return Math.max(0, baseSeconds / clamp(Number(speedMultiplier) || 1, 0.25, 4));
}

export function formatTeleprompterTime(seconds) {
  const safe = Math.max(0, Math.round(Number(seconds) || 0));
  const minutes = Math.floor(safe / 60);
  const rest = safe % 60;
  return `${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`;
}
