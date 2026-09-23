export const TYPING_TEST_EXTRA_WORDS = Object.freeze({
  en: Object.freeze({
    easy: Object.freeze(['apple', 'cloud', 'smile', 'green', 'light', 'music', 'paper', 'chair', 'phone', 'fresh', 'clean', 'dream']),
    medium: Object.freeze(['algorithm', 'database', 'clipboard', 'render', 'command', 'vector', 'payload', 'context', 'session', 'shortcut', 'timeline', 'routing']),
    hard: Object.freeze(['interoperability', 'standardization', 'synchronization', 'abstraction', 'architecture', 'concurrency', 'maintainability', 'verification', 'distribution', 'resilience', 'customization', 'integration']),
    master: Object.freeze(['async await', 'tree shaking', 'code review', 'hot reload', 'design system', 'source map', 'edge case', 'feature flag', 'memory leak', 'race condition', 'live preview', 'release candidate'])
  }),
  zh: Object.freeze({
    easy: Object.freeze(['星光', '绿叶', '小溪', '风铃', '书页', '阳光', '蓝天', '白云', '微风', '清香', '细雨', '田野']),
    medium: Object.freeze(['选择决定方向', '思考带来进步', '规划提高效率', '复盘促进成长', '耐心解决问题', '记录灵感很重要', '专注会带来结果', '沟通让合作更顺畅', '目标清晰才能前进', '经验需要不断积累', '每一次练习都算数', '认真打磨作品']),
    hard: Object.freeze(['不忘初心方得始终', '行稳致远静待花开', '路虽远行则将至', '事虽难做则必成', '纸上得来终觉浅', '绝知此事要躬行', '博观而约取厚积而薄发', '天行健君子以自强不息', '地势坤君子以厚德载物', '少年辛苦终身事', '莫向光阴惰寸功', '学无止境知行合一']),
    master: Object.freeze(['大鹏一日同风起扶摇直上九万里', '安得广厦千万间大庇天下寒士俱欢颜', '朱门酒肉臭路有冻死骨', '苟利国家生死以岂因祸福避趋之', '路漫漫其修远兮吾将上下而求索', '业精于勤荒于嬉行成于思毁于随', '少壮不努力老大徒伤悲', '青春须早为岂能长少年', '车到山前必有路', '船到桥头自然直', '功夫不负有心人', '只争朝夕不负韶华'])
  })
});

const TYPING_TEST_COUNTS = Object.freeze({ easy: 24, medium: 18, hard: 14, master: 12 });
const TYPING_TEST_NOISE_RE = /[\s\u3000，。！？、；：\u201c\u201d\u2018\u2019（）【】《》…—·,.!?;:"'()\[\]{}]/g;

export function normalizeTypingValue(text) {
  return String(text || '').replace(TYPING_TEST_NOISE_RE, '');
}

export function createTypingWordPools(baseWords, extras = TYPING_TEST_EXTRA_WORDS) {
  const pools = {};
  for (const lang of ['en', 'zh']) {
    pools[lang] = {};
    for (const difficulty of ['easy', 'medium', 'hard', 'master']) {
      pools[lang][difficulty] = [
        ...(baseWords?.[lang]?.[difficulty] || []),
        ...(extras?.[lang]?.[difficulty] || [])
      ];
    }
  }
  return pools;
}

export function sampleTypingWords(pool, count, random = Math.random) {
  const uniquePool = Array.from(new Set((pool || []).filter(Boolean)));
  if (!uniquePool.length || count <= 0) return [];
  const bag = [...uniquePool];
  const result = [];
  while (result.length < count) {
    if (!bag.length) bag.push(...uniquePool);
    const index = Math.floor(random() * bag.length);
    result.push(bag.splice(Math.min(Math.max(index, 0), bag.length - 1), 1)[0]);
  }
  return result;
}

export function generateTypingText(wordPools, lang, difficulty, random = Math.random) {
  const language = wordPools?.[lang] ? lang : 'zh';
  const level = TYPING_TEST_COUNTS[difficulty] ? difficulty : 'easy';
  const pool = wordPools?.[language]?.[level] || [];
  return sampleTypingWords(pool, TYPING_TEST_COUNTS[level], random).join(' ');
}

export function compareTypingInput(target, input) {
  const normalizedTarget = normalizeTypingValue(target);
  const normalizedInput = normalizeTypingValue(input);
  const compareLength = Math.min(normalizedTarget.length, normalizedInput.length);
  let correctCount = 0;
  for (let index = 0; index < compareLength; index += 1) {
    if (normalizedTarget[index] === normalizedInput[index]) correctCount += 1;
  }
  return {
    normalizedTarget,
    normalizedInput,
    correctCount,
    wrongCount: Math.max(normalizedInput.length - correctCount, 0),
    totalCharCount: normalizedInput.length,
    complete: normalizedInput.length > 0 && normalizedInput.length >= normalizedTarget.length && normalizedInput.length - correctCount === 0
  };
}

export function calculateTypingStats({ correctCount = 0, totalCharCount = 0, startTime = 0, now = Date.now() } = {}) {
  const elapsedMinutes = startTime > 0 ? (now - startTime) / 1000 / 60 : 0;
  const cpm = elapsedMinutes > 0 ? Math.round(correctCount / elapsedMinutes) : 0;
  return {
    cpm,
    wpm: elapsedMinutes > 0 ? Math.round((correctCount / 5) / elapsedMinutes) : 0,
    accuracy: totalCharCount > 0 ? Math.round((correctCount / totalCharCount) * 100) : 100
  };
}

export function getTypingRating(wpm, lang) {
  const thresholds = lang === 'zh' ? [120, 100, 80, 60] : [80, 60, 40, 20];
  if (wpm >= thresholds[0]) return 'S';
  if (wpm >= thresholds[1]) return 'A';
  if (wpm >= thresholds[2]) return 'B';
  if (wpm >= thresholds[3]) return 'C';
  return 'D';
}
