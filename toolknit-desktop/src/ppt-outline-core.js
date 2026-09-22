export const PPT_OUTLINE_LIMITS = Object.freeze({
  maxPromptChars: 20000,
  maxAudienceChars: 500,
  maxPurposeChars: 500,
  maxToneChars: 500,
  maxStyleChars: 800,
  minSlides: 3,
  maxSlides: 30,
  maxResponseChars: 800000,
  maxSlideBodyItems: 6,
  maxSlideDataItems: 6,
  maxFactItems: 14,
  maxSelfCheckItems: 10
});

export const PPT_OUTLINE_LOCALES = Object.freeze(['zh-CN', 'en']);

export const PPT_OUTLINE_DECK_TYPES = Object.freeze([
  'auto',
  'product-launch',
  'investor-pitch',
  'work-report',
  'training',
  'industry-research',
  'competitive-analysis',
  'short-video-demo',
  'project-review'
]);

export const PPT_OUTLINE_SLIDE_ROLES = Object.freeze([
  'cover',
  'agenda',
  'context',
  'problem',
  'insight',
  'evidence',
  'comparison',
  'workflow',
  'roadmap',
  'risk',
  'recommendation',
  'closing',
  'content'
]);

export const PPT_OUTLINE_LAYOUT_KINDS = Object.freeze([
  'title',
  'section',
  'big-number',
  'text-focus',
  'image-text',
  'comparison',
  'timeline',
  'process',
  'matrix',
  'chart',
  'quote',
  'closing'
]);

const PPT_OUTLINE_DENSITIES = Object.freeze(['low', 'medium', 'high']);
const PPT_OUTLINE_CHART_TYPES = Object.freeze(['none', 'bar', 'line', 'pie', 'matrix', 'timeline', 'process', 'comparison', 'custom']);

const DECK_TYPE_ALIASES = Object.freeze({
  auto: 'auto',
  product: 'product-launch',
  launch: 'product-launch',
  'product-launch': 'product-launch',
  'product_launch': 'product-launch',
  investor: 'investor-pitch',
  pitch: 'investor-pitch',
  financing: 'investor-pitch',
  roadshow: 'investor-pitch',
  'investor-pitch': 'investor-pitch',
  'investor_pitch': 'investor-pitch',
  report: 'work-report',
  work: 'work-report',
  'work-report': 'work-report',
  'work_report': 'work-report',
  training: 'training',
  course: 'training',
  tutorial: 'training',
  research: 'industry-research',
  industry: 'industry-research',
  'industry-research': 'industry-research',
  'industry_research': 'industry-research',
  competitor: 'competitive-analysis',
  competition: 'competitive-analysis',
  competitive: 'competitive-analysis',
  'competitive-analysis': 'competitive-analysis',
  'competitive_analysis': 'competitive-analysis',
  demo: 'short-video-demo',
  'short-video': 'short-video-demo',
  'short_video': 'short-video-demo',
  'short-video-demo': 'short-video-demo',
  'short_video_demo': 'short-video-demo',
  review: 'project-review',
  retrospective: 'project-review',
  'project-review': 'project-review',
  'project_review': 'project-review'
});

const ROLE_ALIASES = Object.freeze({
  title: 'cover',
  cover: 'cover',
  opening: 'cover',
  agenda: 'agenda',
  toc: 'agenda',
  context: 'context',
  background: 'context',
  situation: 'context',
  problem: 'problem',
  pain: 'problem',
  challenge: 'problem',
  analysis: 'insight',
  insight: 'insight',
  finding: 'insight',
  evidence: 'evidence',
  proof: 'evidence',
  data: 'evidence',
  case: 'evidence',
  comparison: 'comparison',
  compare: 'comparison',
  competitor: 'comparison',
  competitive: 'comparison',
  process: 'workflow',
  workflow: 'workflow',
  method: 'workflow',
  roadmap: 'roadmap',
  timeline: 'roadmap',
  plan: 'roadmap',
  risk: 'risk',
  risks: 'risk',
  recommendation: 'recommendation',
  solution: 'recommendation',
  action: 'recommendation',
  closing: 'closing',
  close: 'closing',
  ending: 'closing',
  summary: 'closing',
  content: 'content',
  section: 'content'
});

const LAYOUT_ALIASES = Object.freeze({
  title: 'title',
  cover: 'title',
  section: 'section',
  divider: 'section',
  'big-number': 'big-number',
  'big_number': 'big-number',
  metric: 'big-number',
  number: 'big-number',
  'text-focus': 'text-focus',
  'text_focus': 'text-focus',
  text: 'text-focus',
  'image-text': 'image-text',
  'image_text': 'image-text',
  image: 'image-text',
  comparison: 'comparison',
  compare: 'comparison',
  timeline: 'timeline',
  process: 'process',
  workflow: 'process',
  matrix: 'matrix',
  chart: 'chart',
  graph: 'chart',
  quote: 'quote',
  closing: 'closing',
  close: 'closing'
});

const ROLE_LAYOUT_DEFAULTS = Object.freeze({
  cover: 'title',
  agenda: 'section',
  context: 'text-focus',
  problem: 'text-focus',
  insight: 'text-focus',
  evidence: 'chart',
  comparison: 'comparison',
  workflow: 'process',
  roadmap: 'timeline',
  risk: 'matrix',
  recommendation: 'text-focus',
  closing: 'closing',
  content: 'text-focus'
});

const DECK_TYPE_LABELS = Object.freeze({
  'zh-CN': {
    auto: '自动判断',
    'product-launch': '产品发布 / 功能发布',
    'investor-pitch': '融资路演 / 投资人沟通',
    'work-report': '工作汇报 / 项目汇报',
    training: '培训课件 / 教学演示',
    'industry-research': '行业研究 / 趋势报告',
    'competitive-analysis': '竞品分析 / 对比研究',
    'short-video-demo': '短视频脚本 / 演示拆解',
    'project-review': '项目复盘 / 迭代总结'
  },
  en: {
    auto: 'Auto detect',
    'product-launch': 'Product / feature launch',
    'investor-pitch': 'Investor pitch',
    'work-report': 'Work / project report',
    training: 'Training / course deck',
    'industry-research': 'Industry research',
    'competitive-analysis': 'Competitive analysis',
    'short-video-demo': 'Short-video demo',
    'project-review': 'Project review'
  }
});

const DECK_TYPE_GUIDANCE = Object.freeze({
  auto: 'Infer the deck type from the brief and explain the chosen structure through narrative.arc.',
  'product-launch': 'Use a launch arc: audience tension -> product promise -> proof/features -> adoption path -> action.',
  'investor-pitch': 'Use a pitch arc: problem -> market/user pain -> solution -> traction/proof -> model/roadmap -> ask, without inventing metrics.',
  'work-report': 'Use a report arc: objective -> progress -> evidence -> blockers/risks -> decisions/next actions.',
  training: 'Use a learning arc: why it matters -> concept model -> guided steps -> examples/practice -> recap/application.',
  'industry-research': 'Use a research arc: question -> landscape -> drivers -> evidence -> implications -> watchpoints.',
  'competitive-analysis': 'Use a comparison arc: criteria -> alternatives -> evidence -> trade-offs -> recommendation.',
  'short-video-demo': 'Use a high-retention demo arc: hook -> visible pain -> satisfying workflow -> result contrast -> call to action.',
  'project-review': 'Use a review arc: original goal -> what happened -> why -> lessons -> changes for next iteration.'
});

export class PptOutlineError extends Error {
  constructor(code, message) {
    super(`ppt-outline:${code}:${message}`);
    this.name = 'PptOutlineError';
    this.code = code;
    this.userMessage = message;
  }
}

function fail(code, message) {
  throw new PptOutlineError(code, message);
}

function cleanText(value, { maxChars, label, required = false } = {}) {
  if (value === undefined || value === null) {
    if (required) fail('invalid_request', `${label} is required.`);
    return '';
  }
  if (typeof value !== 'string') fail('invalid_request', `${label} must be a string.`);
  const text = value
    .replace(/\u00A0/g, ' ')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
  if (required && !text) fail('invalid_request', `${label} is required.`);
  if (maxChars && text.length > maxChars) fail('input_too_large', `${label} exceeds ${maxChars} characters.`);
  return text;
}

function cleanInline(value, { maxChars = 240, fallback = '' } = {}) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxChars) || fallback;
}

function normalizeSlideCount(value) {
  const count = value === undefined || value === null || value === '' ? 8 : Number(value);
  if (!Number.isSafeInteger(count) || count < PPT_OUTLINE_LIMITS.minSlides || count > PPT_OUTLINE_LIMITS.maxSlides) {
    fail('invalid_slide_count', `slide_count must be an integer from ${PPT_OUTLINE_LIMITS.minSlides} to ${PPT_OUTLINE_LIMITS.maxSlides}.`);
  }
  return count;
}

function normalizeLocale(value = 'zh-CN') {
  const locale = String(value || 'zh-CN').trim();
  if (locale === 'zh' || locale === 'zh_CN' || locale === 'zh-CN') return 'zh-CN';
  if (locale === 'en' || locale === 'en-US' || locale === 'en_US') return 'en';
  fail('invalid_locale', 'locale must be zh-CN or en.');
}

function normalizeDeckType(value = 'auto') {
  const key = String(value || 'auto').trim().toLowerCase().replace(/\s+/g, '-');
  const normalized = DECK_TYPE_ALIASES[key];
  if (normalized && PPT_OUTLINE_DECK_TYPES.includes(normalized)) return normalized;
  fail('invalid_deck_type', `deck_type must be one of: ${PPT_OUTLINE_DECK_TYPES.join(', ')}.`);
}

function normalizeDeckTypeSafe(value, fallback = 'auto') {
  try {
    return normalizeDeckType(value || fallback);
  } catch {
    return normalizeDeckType(fallback);
  }
}

export function getPptOutlineDeckTypeLabel(value, locale = 'zh-CN') {
  const deckType = normalizeDeckTypeSafe(value, 'auto');
  const labels = DECK_TYPE_LABELS[normalizeLocaleSafe(locale)] || DECK_TYPE_LABELS['zh-CN'];
  return labels[deckType] || deckType;
}

function normalizeLocaleSafe(value) {
  try {
    return normalizeLocale(value);
  } catch {
    return 'zh-CN';
  }
}

function deckTypeGuidance(deckType) {
  return DECK_TYPE_GUIDANCE[deckType] || DECK_TYPE_GUIDANCE.auto;
}

function clampInteger(value, { min = 0, max = 10, fallback = 0 } = {}) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.round(number)));
}

function uniqueStrings(items, maxItems) {
  const seen = new Set();
  const result = [];
  for (const item of items || []) {
    const key = item.toLowerCase();
    if (!item || seen.has(key)) continue;
    seen.add(key);
    result.push(item);
    if (maxItems && result.length >= maxItems) break;
  }
  return result;
}

export function sanitizePptOutlineBaseName(value) {
  const pathBaseName = String(value || 'ppt-outline').split(/[\\/]/).pop() || 'ppt-outline';
  const base = pathBaseName
    .replace(/\.[A-Za-z0-9]+$/, '')
    .replace(/[\\/:*?"<>|\u0000-\u001F]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^[._]+|[._]+$/g, '')
    .slice(0, 80);
  if (!base || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(base)) return 'ppt_outline';
  return base;
}

export function normalizePptOutlineRequest(args = {}) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    fail('invalid_request', 'PPT outline request must be an object.');
  }
  const prompt = cleanText(args.prompt, {
    label: 'prompt',
    maxChars: PPT_OUTLINE_LIMITS.maxPromptChars,
    required: true
  });
  const slideCount = normalizeSlideCount(args.slide_count ?? args.slideCount);
  const locale = normalizeLocale(args.locale || 'zh-CN');
  return {
    prompt,
    slide_count: slideCount,
    locale,
    deck_type: normalizeDeckType(args.deck_type || args.deckType || 'auto'),
    audience: cleanText(args.audience || '', { label: 'audience', maxChars: PPT_OUTLINE_LIMITS.maxAudienceChars }),
    purpose: cleanText(args.purpose || '', { label: 'purpose', maxChars: PPT_OUTLINE_LIMITS.maxPurposeChars }),
    tone: cleanText(args.tone || '', { label: 'tone', maxChars: PPT_OUTLINE_LIMITS.maxToneChars }),
    style: cleanText(args.style || '', { label: 'style', maxChars: PPT_OUTLINE_LIMITS.maxStyleChars })
  };
}

function outputLanguage(locale) {
  return locale === 'en' ? 'English' : 'Simplified Chinese';
}

export function buildPptOutlineMessages(requestValue, options = {}) {
  const request = normalizePptOutlineRequest(requestValue);
  const retry = Boolean(options.retry);
  const language = outputLanguage(request.locale);
  const deckTypeLabel = getPptOutlineDeckTypeLabel(request.deck_type, request.locale);
  const roleEnum = PPT_OUTLINE_SLIDE_ROLES.join('|');
  const layoutEnum = PPT_OUTLINE_LAYOUT_KINDS.join('|');
  const chartEnum = PPT_OUTLINE_CHART_TYPES.join('|');
  const userFacts = [
    `主题/资料：${request.prompt}`,
    `PPT 类型预设：${request.deck_type}（${deckTypeLabel}）`,
    request.audience ? `目标受众：${request.audience}` : '',
    request.purpose ? `演示目标：${request.purpose}` : '',
    request.tone ? `语气：${request.tone}` : '',
    request.style ? `视觉/风格偏好：${request.style}` : '',
    `页数：${request.slide_count}`,
    `输出语言：${language}`
  ].filter(Boolean).join('\n');
  return [
    {
      role: 'system',
      content: `You are ToolKnit's senior presentation strategist and outline architect.
Create a production-ready slide outline in ${language}. Work only from the user's supplied facts.

Deck type:
- Requested deck_type: ${request.deck_type} (${deckTypeLabel})
- Structural guidance: ${deckTypeGuidance(request.deck_type)}
- If deck_type is auto, infer the best type from the brief and set deck_type in JSON to one of: ${PPT_OUTLINE_DECK_TYPES.filter(item => item !== 'auto').join(', ')}.

Hard requirements:
- Return one raw JSON object only. Do not use markdown fences or explanatory text.
- The object must include schema, version, ready, deck_type, title, subtitle, audience, purpose, fact_bank, narrative, design, slides, and quality_check.
- slides must contain exactly ${request.slide_count} items.
- Every slide must advance the story with one clear narrative job and one primary claim.
- Prefer takeaway-style titles, not vague topic labels. A title should sound like a human conclusion, not a topic tab.
- Keep visible slide body concise: 2-5 bullets per slide, each bullet short and audience-facing.
- Design for a poster-like 16:9 PPTX renderer: keep Chinese titles within roughly 24 characters (or 46 Latin characters), claims within roughly 42 Chinese characters, and each bullet within roughly 18 Chinese characters whenever possible. Shorten copy before adding density.
- Use slide roles deliberately to create visual rhythm. A strong product deck normally alternates cover, problem/context, recommendation, evidence (matrix), workflow/process, comparison or ecosystem, proof/open-source, and closing where the brief supports it. Do not force every page into the same "text plus screenshot" composition.
- Make the design system subject-aware. If the brief is not about ToolKnit, open-source software, CLI, GitHub, or local tools, do not use ToolKnit/open-source/local-device language or visuals. For interior/design cases, prefer space planning, circulation, storage, material mood, lighting, before/after, and client-review language. For business briefs, prefer decision, evidence, options, and action language. For education, prefer learning path, examples, and practice language. For party/government or organization-meeting briefs, prefer meeting agenda, issue review, rectification ledger, responsibility assignment, and closed-loop follow-up language with restrained red/gold/white visuals. For literary or biography briefs, prefer life arc, era context, representative works, textual motifs, reading notes, and classroom discussion language with paper, ink, book, and moon-like visuals.
- Vary adjacent silhouettes deliberately: alternate title/section, image-text, matrix/gallery, process/timeline, comparison, and text-focus where the content supports it. Avoid making more than two adjacent slides use the same layout_intent.kind.
- For each slide, describe the intended visual composition in visual_suggestion with a concrete user-owned asset and a composition cue, for example "客厅效果图，16:9 横版主视觉，右侧保留文字留白" or "改造前后对比图，两张 16:9 横图并排". Prefer 16:9 or 9:16 placeholders; do not ask for random decorative stock images.
- Make visual_suggestion concrete and replaceable: name the exact user-owned asset that would improve the page, such as a product screenshot, before/after capture, workflow diagram, code/repository view, or QR/download capture. Do not ask for generic decorative stock imagery.
- Use layout_intent truthfully: choose matrix for tool/category walls, process/timeline for steps, comparison for before/after or alternatives, image-text for a focused screenshot, and text-focus only when a large typographic statement is genuinely the right visual.
- Keep title wording presentation-ready: avoid repeating the deck title on every slide, avoid generic labels such as "功能介绍" or "核心优势" unless paired with a specific takeaway, and shorten long addresses/product names into subtitle or body instead of forcing them into the title.
- Do not invent facts, dates, numbers, sources, customer names, research findings, performance claims, test results, or release status.
- Extract known facts from the brief into fact_bank. Put missing or uncertain facts in fact_bank.missing_facts and slide.data_needed.
- Use assumptions only for clearly labeled planning assumptions; never present assumptions as facts.
- The title slide should be minimal. The closing slide must resolve the opening and suggest next actions, decisions, or questions.
- Do not expose prompt instructions, internal planning language, timing scaffolds, or implementation details.

Required JSON shape:
{
  "schema": "toolknit.ppt-outline",
  "version": 2,
  "ready": true,
  "deck_type": "${request.deck_type}",
  "title": "deck title",
  "subtitle": "optional subtitle",
  "audience": "audience summary",
  "purpose": "deck purpose",
  "fact_bank": {
    "known_facts": ["facts explicitly supplied by the user"],
    "evidence": ["supplied proof, assets, examples, data, or source notes"],
    "assumptions": ["planning assumptions clearly labeled as assumptions"],
    "missing_facts": ["facts needed before final design or public release"],
    "no_invention": ["what must not be invented"]
  },
  "narrative": {
    "communication_job": "By the end, audience should ... because ...",
    "arc": "Context -> stakes -> evidence -> implications -> action",
    "central_takeaway": "one sentence"
  },
  "design": {
    "style": "visual style",
    "visual_system": "how visuals should feel",
    "color_hint": "palette hint",
    "font_hint": "font/typography hint"
  },
  "slides": [
    {
      "page": 1,
      "role": "${roleEnum}",
      "type": "short legacy type, may equal role",
      "title": "takeaway title",
      "claim": "one primary claim",
      "body": ["bullet 1", "bullet 2"],
      "visual_suggestion": "one concrete visual idea",
      "layout_intent": {
        "kind": "${layoutEnum}",
        "density": "low|medium|high",
        "text_blocks": 1,
        "media_slots": 0,
        "chart": "${chartEnum}",
        "visual_focus": "what the eye should notice first"
      },
      "asset_slots": [
        {
          "role": "hero|supporting|background",
          "asset_id": "optional id from supplied local asset metadata",
          "fit": "cover|contain|fill",
          "focal_point": "center or a short focal-point instruction",
          "caption": "optional caption"
        }
      ],
      "speaker_note": "concise presenter note",
      "transition": "why the next slide follows",
      "data_needed": ["missing fact to confirm"]
    }
  ],
  "quality_check": {
    "missing_info": ["facts that should be supplied before final design"],
    "risks": ["possible risk or ambiguity"],
    "next_steps": ["next action"],
    "self_check": {
      "score": 0,
      "passed": false,
      "issues": ["specific issue to repair"],
      "strengths": ["specific strength"]
    }
  }
}

Before returning JSON, repair your own outline:
- exact slide count,
- one claim per slide,
- no repeated generic slide titles,
- cover and closing are deliberate,
- every slide has role and layout_intent,
- transitions are logical,
- all uncertain facts are isolated in fact_bank or data_needed.
${retry ? 'This is a correction attempt: the previous response failed validation. Return valid JSON, exact slide count, required fields, and no unsupported factual claims.' : ''}`
    },
    {
      role: 'user',
      content: userFacts
    }
  ];
}

export function extractPptOutlineJson(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const trimmed = value.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  try {
    const direct = JSON.parse(trimmed);
    return direct && typeof direct === 'object' ? direct : null;
  } catch {}
  const start = trimmed.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < trimmed.length; index++) {
    const character = trimmed[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === '\\' && inString) {
      escaped = true;
      continue;
    }
    if (character === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (character === '{') depth += 1;
    if (character === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(trimmed.slice(start, index + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function normalizeStringArray(value, { maxItems, itemMaxChars = 260 } = {}) {
  if (value === undefined || value === null || value === '') return [];
  const source = Array.isArray(value) ? value : [value];
  return uniqueStrings(source
    .map(item => cleanInline(item, { maxChars: itemMaxChars }))
    .filter(Boolean), maxItems);
}

function normalizeNarrative(value = {}) {
  const narrative = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    communication_job: cleanInline(narrative.communication_job, { maxChars: 600 }),
    arc: cleanInline(narrative.arc, { maxChars: 320 }),
    central_takeaway: cleanInline(narrative.central_takeaway, { maxChars: 500 })
  };
}

function normalizeDesign(value = {}) {
  const design = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    style: cleanInline(design.style, { maxChars: 300 }),
    visual_system: cleanInline(design.visual_system, { maxChars: 420 }),
    color_hint: cleanInline(design.color_hint, { maxChars: 240 }),
    font_hint: cleanInline(design.font_hint, { maxChars: 240 })
  };
}

function normalizeFactBank(value = {}, request = {}) {
  const bank = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const zh = (request.locale || 'zh-CN') !== 'en';
  const noInvention = normalizeStringArray(bank.no_invention || bank.noInvention || bank.boundaries, {
    maxItems: PPT_OUTLINE_LIMITS.maxFactItems,
    itemMaxChars: 260
  });
  return {
    known_facts: normalizeStringArray(bank.known_facts || bank.knownFacts || bank.facts, {
      maxItems: PPT_OUTLINE_LIMITS.maxFactItems,
      itemMaxChars: 260
    }),
    evidence: normalizeStringArray(bank.evidence || bank.sources || bank.proof, {
      maxItems: PPT_OUTLINE_LIMITS.maxFactItems,
      itemMaxChars: 260
    }),
    assumptions: normalizeStringArray(bank.assumptions || bank.planning_assumptions, {
      maxItems: PPT_OUTLINE_LIMITS.maxFactItems,
      itemMaxChars: 260
    }),
    missing_facts: normalizeStringArray(bank.missing_facts || bank.missingFacts || bank.missing_info, {
      maxItems: PPT_OUTLINE_LIMITS.maxFactItems,
      itemMaxChars: 260
    }),
    no_invention: noInvention.length ? noInvention : [
      zh
        ? '资料中没有出现的数字、案例、客户名、发布日期、测试结果，不写成确定事实。'
        : 'Do not state numbers, cases, customer names, release dates, or test results that were not supplied.'
    ]
  };
}

function normalizeQualityCheck(value = {}) {
  const quality = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    missing_info: normalizeStringArray(quality.missing_info || quality.missingInfo, { maxItems: 10, itemMaxChars: 240 }),
    risks: normalizeStringArray(quality.risks, { maxItems: 10, itemMaxChars: 260 }),
    next_steps: normalizeStringArray(quality.next_steps || quality.nextSteps, { maxItems: 10, itemMaxChars: 260 }),
    self_check: normalizeSelfCheck(quality.self_check || quality.selfCheck)
  };
}

function normalizeSelfCheck(value = {}) {
  const selfCheck = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const score = Number(selfCheck.score);
  const normalizedScore = Number.isFinite(score) ? Math.max(0, Math.min(100, Math.round(score))) : 0;
  return {
    score: normalizedScore,
    passed: Boolean(selfCheck.passed),
    issues: normalizeStringArray(selfCheck.issues, {
      maxItems: PPT_OUTLINE_LIMITS.maxSelfCheckItems,
      itemMaxChars: 260
    }),
    strengths: normalizeStringArray(selfCheck.strengths, {
      maxItems: PPT_OUTLINE_LIMITS.maxSelfCheckItems,
      itemMaxChars: 260
    })
  };
}

function normalizeSlideRole(value, index, total) {
  const raw = String(value || '').trim().toLowerCase().replace(/\s+/g, '-');
  const alias = ROLE_ALIASES[raw] || ROLE_ALIASES[raw.replace(/-/g, '_')];
  if (alias) return alias;
  if (index === 0) return 'cover';
  if (index === total - 1) return 'closing';
  return 'content';
}

function normalizeLayoutKind(value, role) {
  const raw = String(value || '').trim().toLowerCase().replace(/\s+/g, '-');
  const alias = LAYOUT_ALIASES[raw] || LAYOUT_ALIASES[raw.replace(/-/g, '_')];
  if (alias) return alias;
  return ROLE_LAYOUT_DEFAULTS[role] || 'text-focus';
}

function normalizeDensity(value, bodyLength) {
  const density = String(value || '').trim().toLowerCase();
  if (PPT_OUTLINE_DENSITIES.includes(density)) return density;
  if (bodyLength <= 2) return 'low';
  if (bodyLength >= 5) return 'high';
  return 'medium';
}

function normalizeChartType(value, layoutKind) {
  const chart = String(value || '').trim().toLowerCase().replace(/\s+/g, '-');
  if (PPT_OUTLINE_CHART_TYPES.includes(chart)) return chart;
  if (layoutKind === 'chart') return 'custom';
  if (layoutKind === 'timeline') return 'timeline';
  if (layoutKind === 'process') return 'process';
  if (layoutKind === 'matrix') return 'matrix';
  if (layoutKind === 'comparison') return 'comparison';
  return 'none';
}

function normalizeLayoutIntent(value = {}, { role, bodyLength, visualSuggestion } = {}) {
  const layout = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const kind = normalizeLayoutKind(layout.kind || layout.type || layout.layout, role);
  const density = normalizeDensity(layout.density, bodyLength);
  return {
    kind,
    density,
    text_blocks: clampInteger(layout.text_blocks ?? layout.textBlocks, {
      min: 1,
      max: 4,
      fallback: bodyLength > 3 ? 2 : 1
    }),
    media_slots: clampInteger(layout.media_slots ?? layout.mediaSlots, {
      min: 0,
      max: 3,
      fallback: ['image-text', 'chart', 'comparison', 'timeline', 'process', 'matrix'].includes(kind) ? 1 : 0
    }),
    chart: normalizeChartType(layout.chart || layout.chart_type || layout.chartType, kind),
    visual_focus: cleanInline(layout.visual_focus || layout.visualFocus || visualSuggestion, { maxChars: 300 })
  };
}

function normalizeSlide(slide, index, slides) {
  const item = slide && typeof slide === 'object' && !Array.isArray(slide) ? slide : {};
  const total = Array.isArray(slides) ? slides.length : index + 1;
  const page = Number.isSafeInteger(Number(item.page)) && Number(item.page) > 0 ? Number(item.page) : index + 1;
  const title = cleanInline(item.title, { maxChars: 180, fallback: `Slide ${index + 1}` });
  const body = normalizeStringArray(item.body, {
    maxItems: PPT_OUTLINE_LIMITS.maxSlideBodyItems,
    itemMaxChars: 240
  });
  const role = normalizeSlideRole(item.role || item.type, index, total);
  const visualSuggestion = cleanInline(item.visual_suggestion || item.visualSuggestion, { maxChars: 360 });
  const assetSlots = Array.isArray(item.asset_slots || item.assetSlots)
    ? (item.asset_slots || item.assetSlots).slice(0, 4).map((slot, slotIndex) => {
      const value = slot && typeof slot === 'object' && !Array.isArray(slot) ? slot : {};
      const role = cleanInline(value.role, { maxChars: 60 });
      const assetId = cleanInline(value.asset_id || value.assetId, { maxChars: 80 });
      const fit = ['cover', 'contain', 'fill'].includes(String(value.fit || '').toLowerCase())
        ? String(value.fit).toLowerCase()
        : 'cover';
      const focalPoint = cleanInline(value.focal_point || value.focalPoint, { maxChars: 40, fallback: 'center' });
      const caption = cleanInline(value.caption, { maxChars: 180 });
      if (!role && !assetId && !caption) return null;
      return {
        slot: slotIndex + 1,
        role,
        asset_id: assetId,
        fit,
        focal_point: focalPoint,
        caption
      };
    }).filter(Boolean)
    : [];
  return {
    page,
    role,
    type: cleanInline(item.type || role, { maxChars: 40, fallback: role }),
    title,
    claim: cleanInline(item.claim, { maxChars: 360 }),
    body,
    visual_suggestion: visualSuggestion,
    layout_intent: normalizeLayoutIntent(item.layout_intent || item.layoutIntent || item.layout, {
      role,
      bodyLength: body.length,
      visualSuggestion
    }),
    speaker_note: cleanInline(item.speaker_note || item.speakerNote, { maxChars: 500 }),
    transition: cleanInline(item.transition, { maxChars: 260 }),
    asset_slots: assetSlots,
    data_needed: normalizeStringArray(item.data_needed || item.dataNeeded, {
      maxItems: PPT_OUTLINE_LIMITS.maxSlideDataItems,
      itemMaxChars: 220
    })
  };
}

function addScore(condition, points, issues, strengths, issue, strength) {
  if (condition) {
    if (strength) strengths.push(strength);
    return points;
  }
  if (issue) issues.push(issue);
  return 0;
}

export function assessPptOutlineQuality(result, requestValue) {
  const request = normalizePptOutlineRequest(requestValue || result?.request || {});
  const zh = request.locale !== 'en';
  const slides = Array.isArray(result?.slides) ? result.slides : [];
  const issues = [];
  const strengths = [];
  let score = 0;

  score += addScore(
    slides.length === request.slide_count,
    15,
    issues,
    strengths,
    zh ? `页面数量为 ${slides.length}，与需求 ${request.slide_count} 不一致。` : `Slide count is ${slides.length}, expected ${request.slide_count}.`,
    zh ? '页面数量与需求一致。' : 'Slide count matches the request.'
  );

  const narrative = result?.narrative || {};
  score += addScore(
    Boolean(result?.title && narrative.communication_job && narrative.arc && narrative.central_takeaway),
    20,
    issues,
    strengths,
    zh ? '标题、沟通任务、叙事路径或核心结论不完整。' : 'Title, communication job, narrative arc, or central takeaway is incomplete.',
    zh ? '沟通任务、叙事路径和核心结论完整。' : 'Communication job, narrative arc, and central takeaway are complete.'
  );

  const completeSlides = slides.filter(slide => slide.title && slide.claim && Array.isArray(slide.body) && slide.body.length >= 2);
  score += addScore(
    completeSlides.length === slides.length,
    20,
    issues,
    strengths,
    zh ? '部分页面缺少标题、主张或至少 2 条正文要点。' : 'Some slides miss a title, claim, or at least two body bullets.',
    zh ? '每页都有标题、主张和正文要点。' : 'Every slide has a title, claim, and body bullets.'
  );

  const densityOk = slides.every(slide => slide.body.length >= 2 && slide.body.length <= 5);
  score += addScore(
    densityOk,
    15,
    issues,
    strengths,
    zh ? '部分页面正文密度不理想，建议保持 2-5 条要点。' : 'Some slides have poor body density; keep 2-5 bullets.',
    zh ? '正文密度适合后续排版。' : 'Body density is suitable for slide layout.'
  );

  const roles = slides.map(slide => slide.role);
  const roleOk = roles[0] === 'cover' && roles.at(-1) === 'closing' && slides.every(slide => PPT_OUTLINE_SLIDE_ROLES.includes(slide.role));
  score += addScore(
    roleOk,
    10,
    issues,
    strengths,
    zh ? '页面角色不完整，建议首屏 cover、末页 closing，并为中间页明确角色。' : 'Slide roles are incomplete; use cover first, closing last, and clear roles in between.',
    zh ? '页面角色结构清晰。' : 'Slide role structure is clear.'
  );

  const transitionCount = slides.filter((slide, index) => index === slides.length - 1 || slide.transition).length;
  score += addScore(
    transitionCount >= Math.max(1, slides.length - 1),
    10,
    issues,
    strengths,
    zh ? '部分页面缺少转场逻辑，叙事可能跳跃。' : 'Some slides lack transitions; the narrative may jump.',
    zh ? '页面之间有连续转场逻辑。' : 'Slides include logical transitions.'
  );

  const factBank = result?.fact_bank || {};
  const factSignalCount = (factBank.known_facts?.length || 0)
    + (factBank.evidence?.length || 0)
    + (factBank.assumptions?.length || 0)
    + (factBank.missing_facts?.length || 0);
  score += addScore(
    (factBank.no_invention?.length || 0) > 0,
    5,
    issues,
    strengths,
    zh ? '事实边界缺失，容易让模型编造未提供内容。' : 'No-invention boundaries are missing, increasing hallucination risk.',
    zh ? '已声明不可编造的事实边界。' : 'No-invention boundaries are stated.'
  );
  score += addScore(
    factSignalCount > 0,
    5,
    issues,
    strengths,
    zh ? '事实库过空，建议补充已知事实、证据或待确认信息。' : 'Fact bank is too empty; add known facts, evidence, or missing facts.',
    zh ? '事实库包含已知事实、证据、假设或待确认项。' : 'Fact bank contains facts, evidence, assumptions, or missing facts.'
  );

  return {
    score: Math.max(0, Math.min(100, score)),
    passed: score >= 80 && issues.length <= 2,
    issues: uniqueStrings(issues, PPT_OUTLINE_LIMITS.maxSelfCheckItems),
    strengths: uniqueStrings(strengths, PPT_OUTLINE_LIMITS.maxSelfCheckItems)
  };
}

function mergeSelfCheck(aiSelfCheck, assessedSelfCheck) {
  return {
    score: assessedSelfCheck.score,
    passed: assessedSelfCheck.passed,
    issues: uniqueStrings([
      ...(assessedSelfCheck.issues || []),
      ...(aiSelfCheck.issues || [])
    ], PPT_OUTLINE_LIMITS.maxSelfCheckItems),
    strengths: uniqueStrings([
      ...(assessedSelfCheck.strengths || []),
      ...(aiSelfCheck.strengths || [])
    ], PPT_OUTLINE_LIMITS.maxSelfCheckItems)
  };
}

export function normalizePptOutlineResult(payload, requestValue) {
  const request = normalizePptOutlineRequest(requestValue);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    fail('invalid_ai_response', 'The AI provider did not return a JSON object.');
  }
  if (payload.ready !== true) {
    fail('invalid_ai_response', 'The AI provider did not mark the PPT outline as ready.');
  }
  if (!Array.isArray(payload.slides)) {
    fail('invalid_ai_response', 'The AI provider did not return a slides array.');
  }
  if (payload.slides.length !== request.slide_count) {
    fail('invalid_ai_response', `The AI provider returned ${payload.slides.length} slides, expected ${request.slide_count}.`);
  }
  const slides = payload.slides.map(normalizeSlide).map((slide, index) => ({ ...slide, page: index + 1 }));
  const title = cleanInline(payload.title, {
    maxChars: 180,
    fallback: request.prompt.split('\n')[0].slice(0, 80) || (request.locale === 'en' ? 'Presentation Outline' : 'PPT 大纲')
  });
  const quality = normalizeQualityCheck(payload.quality_check);
  const factBank = normalizeFactBank(payload.fact_bank, request);
  if (!factBank.missing_facts.length && quality.missing_info.length) {
    factBank.missing_facts = quality.missing_info.slice(0, PPT_OUTLINE_LIMITS.maxFactItems);
  }
  const result = {
    schema: 'toolknit.ppt-outline',
    version: 2,
    ready: true,
    deck_type: normalizeDeckTypeSafe(payload.deck_type || payload.deckType, request.deck_type),
    title,
    subtitle: cleanInline(payload.subtitle, { maxChars: 240 }),
    audience: cleanInline(payload.audience, { maxChars: 360, fallback: request.audience || (request.locale === 'en' ? 'Not provided' : '待确认') }),
    purpose: cleanInline(payload.purpose, { maxChars: 360, fallback: request.purpose || (request.locale === 'en' ? 'Not provided' : '待确认') }),
    fact_bank: factBank,
    narrative: normalizeNarrative(payload.narrative),
    design: normalizeDesign(payload.design),
    slides,
    quality_check: quality,
    request
  };
  result.quality_check.self_check = mergeSelfCheck(quality.self_check, assessPptOutlineQuality(result, request));
  return result;
}

function markdownEscape(value) {
  return String(value || '').replace(/\|/g, '\\|');
}

function listOrFallback(items, fallback) {
  return Array.isArray(items) && items.length ? items : [fallback];
}

function layoutIntentLabel(layout, zh) {
  if (!layout) return zh ? '待确认' : 'Not provided';
  const parts = [
    layout.kind,
    layout.density,
    layout.chart && layout.chart !== 'none' ? layout.chart : ''
  ].filter(Boolean);
  return parts.join(' / ') || (zh ? '待确认' : 'Not provided');
}

export function createPptOutlineMarkdown(result) {
  const locale = result?.request?.locale || 'zh-CN';
  const zh = locale !== 'en';
  const quality = result.quality_check || {};
  const lines = [
    `# ${result.title || (zh ? 'PPT 大纲' : 'Presentation Outline')}`,
    '',
    result.subtitle ? `> ${result.subtitle}` : '',
    ''
  ].filter(line => line !== null);
  lines.push(
    zh ? '## 项目设定' : '## Deck brief',
    '',
    `- ${zh ? '类型预设' : 'Deck type'}：${getPptOutlineDeckTypeLabel(result.deck_type || result.request?.deck_type || 'auto', locale)}`,
    `- ${zh ? '目标受众' : 'Audience'}：${result.audience || (zh ? '待确认' : 'Not provided')}`,
    `- ${zh ? '演示目标' : 'Purpose'}：${result.purpose || (zh ? '待确认' : 'Not provided')}`,
    `- ${zh ? '页数' : 'Slides'}：${result.slides?.length || 0}`,
    `- ${zh ? '质量分' : 'Quality score'}：${quality.self_check?.score ?? 0}/100`,
    `- ${zh ? '核心结论' : 'Central takeaway'}：${result.narrative?.central_takeaway || (zh ? '待确认' : 'Not provided')}`,
    '',
    zh ? '## 事实边界' : '## Fact bank',
    ''
  );
  const factBank = result.fact_bank || {};
  for (const [label, items] of [
    [zh ? '已知事实' : 'Known facts', factBank.known_facts],
    [zh ? '证据 / 资料' : 'Evidence / source notes', factBank.evidence],
    [zh ? '规划假设' : 'Assumptions', factBank.assumptions],
    [zh ? '待确认事实' : 'Missing facts', factBank.missing_facts],
    [zh ? '不可编造边界' : 'No-invention boundaries', factBank.no_invention]
  ]) {
    lines.push(`### ${label}`, '');
    for (const item of listOrFallback(items, zh ? '暂无' : 'None')) lines.push(`- ${item}`);
    lines.push('');
  }
  lines.push(
    zh ? '## 叙事结构' : '## Narrative',
    '',
    `- ${zh ? '沟通任务' : 'Communication job'}：${result.narrative?.communication_job || (zh ? '待确认' : 'Not provided')}`,
    `- ${zh ? '叙事路径' : 'Arc'}：${result.narrative?.arc || (zh ? '待确认' : 'Not provided')}`,
    '',
    zh ? '## 视觉建议' : '## Visual direction',
    '',
    `- ${zh ? '风格' : 'Style'}：${result.design?.style || (zh ? '待确认' : 'Not provided')}`,
    `- ${zh ? '视觉系统' : 'Visual system'}：${result.design?.visual_system || (zh ? '待确认' : 'Not provided')}`,
    `- ${zh ? '色彩' : 'Color'}：${result.design?.color_hint || (zh ? '待确认' : 'Not provided')}`,
    `- ${zh ? '字体' : 'Typography'}：${result.design?.font_hint || (zh ? '待确认' : 'Not provided')}`,
    '',
    zh ? '## 页面大纲' : '## Slide outline',
    ''
  );
  lines.push(`| ${zh ? '页码' : 'Page'} | ${zh ? '角色' : 'Role'} | ${zh ? '布局意图' : 'Layout intent'} | ${zh ? '标题' : 'Title'} | ${zh ? '主张' : 'Claim'} |`);
  lines.push('| ---: | --- | --- | --- | --- |');
  for (const slide of result.slides || []) {
    lines.push(`| ${slide.page} | ${markdownEscape(slide.role || slide.type)} | ${markdownEscape(layoutIntentLabel(slide.layout_intent, zh))} | ${markdownEscape(slide.title)} | ${markdownEscape(slide.claim)} |`);
  }
  lines.push('');
  for (const slide of result.slides || []) {
    lines.push(`### ${zh ? `第 ${slide.page} 页` : `Slide ${slide.page}`}：${slide.title}`, '');
    lines.push(`**${zh ? '页面角色' : 'Role'}：** ${slide.role || slide.type || (zh ? '内容页' : 'content')}`, '');
    if (slide.claim) lines.push(`**${zh ? '本页主张' : 'Claim'}：** ${slide.claim}`, '');
    lines.push(`**${zh ? '页面内容' : 'Body'}**`, '');
    for (const item of listOrFallback(slide.body, zh ? '待补充' : 'To be added')) lines.push(`- ${item}`);
    lines.push('', `**${zh ? '视觉建议' : 'Visual'}：** ${slide.visual_suggestion || (zh ? '待确认' : 'Not provided')}`);
    if (slide.layout_intent) {
      lines.push('', `**${zh ? '布局意图' : 'Layout intent'}：** ${layoutIntentLabel(slide.layout_intent, zh)}；${zh ? '视觉焦点' : 'Visual focus'}：${slide.layout_intent.visual_focus || (zh ? '待确认' : 'Not provided')}`);
    }
    if (slide.speaker_note) lines.push('', `**${zh ? '讲述提示' : 'Speaker note'}：** ${slide.speaker_note}`);
    if (slide.transition) lines.push('', `**${zh ? '转场逻辑' : 'Transition'}：** ${slide.transition}`);
    if (slide.data_needed?.length) {
      lines.push('', `**${zh ? '待确认资料' : 'Data needed'}**`, '');
      for (const item of slide.data_needed) lines.push(`- ${item}`);
    }
    lines.push('');
  }
  lines.push(zh ? '## 大纲质量' : '## Outline quality', '');
  lines.push(`- ${zh ? '自检分数' : 'Self-check score'}：${quality.self_check?.score ?? 0}/100`);
  lines.push(`- ${zh ? '是否通过' : 'Passed'}：${quality.self_check?.passed ? (zh ? '是' : 'Yes') : (zh ? '否' : 'No')}`, '');
  for (const [label, items] of [
    [zh ? '缺失信息' : 'Missing info', quality.missing_info],
    [zh ? '风险与歧义' : 'Risks', quality.risks],
    [zh ? '下一步' : 'Next steps', quality.next_steps],
    [zh ? '自检问题' : 'Self-check issues', quality.self_check?.issues],
    [zh ? '自检优点' : 'Self-check strengths', quality.self_check?.strengths]
  ]) {
    lines.push(`### ${label}`, '');
    for (const item of listOrFallback(items, zh ? '暂无' : 'None')) lines.push(`- ${item}`);
    lines.push('');
  }
  return `${lines.join('\n').replace(/\n{4,}/g, '\n\n\n')}\n`;
}

function guideList(items, fallback) {
  const values = Array.isArray(items) ? items.map(item => String(item || '').trim()).filter(Boolean) : [];
  return values.length ? [...new Set(values)] : [fallback];
}

function guideSlideReason(role, zh) {
  const reasons = {
    cover: zh ? '先让观众知道这份 PPT 要讲什么，并建立第一印象。' : 'Establish what this deck is about and create the first impression.',
    context: zh ? '交代背景和问题，让后面的方案有明确的起点。' : 'Set the context and problem so the later solution has a clear starting point.',
    problem: zh ? '把用户真正需要解决的困难讲清楚，说明为什么现在要行动。' : 'Make the real problem clear and show why action is needed now.',
    recommendation: zh ? '给出核心方案，让观众知道应该采取什么方向。' : 'Present the central recommendation and the direction to take.',
    evidence: zh ? '用事实、案例或数据支撑前面的判断。' : 'Support the earlier judgment with facts, examples, or data.',
    workflow: zh ? '把复杂过程拆成可以理解和执行的步骤。' : 'Break the complex process into understandable and actionable steps.',
    comparison: zh ? '把不同方案或前后变化放在一起，帮助观众快速判断。' : 'Place alternatives or before-and-after states side by side for a quick judgment.',
    insight: zh ? '提炼前面信息背后的结论，帮助观众形成判断。' : 'Turn the earlier information into a clear conclusion.',
    closing: zh ? '收束全篇，并明确下一步行动、决策或讨论方向。' : 'Close the story and make the next action, decision, or discussion clear.'
  };
  return reasons[String(role || '').toLowerCase()] || (zh ? '推进整份 PPT 的叙事，并补充一个清晰的结论。' : 'Advance the story and add one clear conclusion.');
}

export function createPptOutlineGuideModel(result = {}) {
  const locale = result?.request?.locale || 'zh-CN';
  const zh = locale !== 'en';
  const factBank = result.fact_bank || {};
  const quality = result.quality_check || {};
  const narrative = result.narrative || {};
  const request = result.request || {};
  const missingFacts = [...new Set([
    ...(Array.isArray(factBank.missing_facts) ? factBank.missing_facts : []),
    ...(Array.isArray(quality.missing_info) ? quality.missing_info : [])
  ].map(item => String(item || '').trim()).filter(Boolean))];
  const nextSteps = guideList(
    [...(Array.isArray(quality.next_steps) ? quality.next_steps : []), ...missingFacts.slice(0, 3)],
    zh ? '确认待补资料后，再进入 PPTX 草稿生成。' : 'Confirm the missing details before moving to PPTX draft generation.'
  );
  const slides = (Array.isArray(result.slides) ? result.slides : []).map(slide => ({
    page: slide.page,
    title: slide.title || (zh ? '未命名页面' : 'Untitled slide'),
    role: slide.role || slide.type || 'content',
    purpose: guideSlideReason(slide.role || slide.type, zh),
    remember: slide.claim || slide.body?.[0] || (zh ? '本页结论待补充。' : 'The conclusion for this slide is still to be added.'),
    materials: slide.visual_suggestion || slide.layout_intent?.visual_focus || (zh ? '暂未指定素材。' : 'No specific asset has been requested.'),
    speaking: slide.speaker_note || slide.claim || (slide.body || []).join(zh ? '；' : '; ') || (zh ? '按页面标题展开说明。' : 'Explain the slide from its title.')
  }));
  const model = {
    title: result.title || (zh ? 'PPT 大纲说明' : 'Presentation outline guide'),
    locale,
    oneSentence: narrative.central_takeaway || result.purpose || request.prompt || (zh ? '这份 PPT 的主题待确认。' : 'The deck topic is still to be confirmed.'),
    audience: result.audience || request.audience || (zh ? '待确认' : 'Not provided'),
    purpose: result.purpose || request.purpose || (zh ? '待确认' : 'Not provided'),
    story: narrative.arc || narrative.communication_job || (zh ? '从背景出发，经过问题、证据和方案，最后落到行动。' : 'Move from context through problem, evidence, and solution to action.'),
    knownFacts: guideList(factBank.known_facts, zh ? '暂未标出明确事实。' : 'No explicit facts were marked.'),
    evidence: guideList(factBank.evidence, zh ? '暂未标出证据或资料。' : 'No evidence or source notes were marked.'),
    assumptions: guideList(factBank.assumptions, zh ? '暂无规划假设。' : 'No planning assumptions were marked.'),
    missingFacts: guideList(missingFacts, zh ? '暂无明确待确认项，但生成前仍建议人工复核。' : 'No explicit missing item was marked, but review before generation is still recommended.'),
    nextSteps,
    qualityScore: quality.self_check?.score ?? 0,
    slides
  };
  return model;
}

export function createPptOutlineGuide(result = {}) {
  const model = createPptOutlineGuideModel(result);
  const zh = model.locale !== 'en';
  const lines = [
    `# ${zh ? '大白话说明：' : 'Plain-language guide: '}${model.title}`,
    '',
    zh ? '## 先用一句话理解' : '## Understand it in one sentence',
    '',
    model.oneSentence,
    '',
    zh ? '## 这份 PPT 服务谁、要达成什么' : '## Audience and purpose',
    '',
    `- ${zh ? '目标受众' : 'Audience'}：${model.audience}`,
    `- ${zh ? '演示目标' : 'Purpose'}：${model.purpose}`,
    '',
    zh ? '## 故事怎么推进' : '## How the story moves',
    '',
    model.story,
    '',
    zh ? '## 哪些内容已经有依据' : '## What is supported',
    '',
    `### ${zh ? '已知事实' : 'Known facts'}`,
    '',
    ...model.knownFacts.map(item => `- ${item}`),
    '',
    `### ${zh ? '证据 / 资料' : 'Evidence / source notes'}`,
    '',
    ...model.evidence.map(item => `- ${item}`),
    '',
    `### ${zh ? '规划假设' : 'Planning assumptions'}`,
    '',
    ...model.assumptions.map(item => `- ${item}`),
    '',
    zh ? '## 生成前还要确认什么' : '## What to confirm before generation',
    '',
    ...model.missingFacts.map(item => `- ${item}`),
    '',
    zh ? '## 每一页的大白话说明' : '## Plain-language explanation for each slide',
    ''
  ];
  for (const slide of model.slides) {
    lines.push(
      `### ${zh ? `第 ${slide.page} 页：${slide.title}` : `Slide ${slide.page}: ${slide.title}`}`,
      '',
      `- **${zh ? '这一页讲什么' : 'What it says'}**：${slide.remember}`,
      `- **${zh ? '为什么放这一页' : 'Why it is here'}**：${slide.purpose}`,
      `- **${zh ? '需要准备什么' : 'What to prepare'}**：${slide.materials}`,
      `- **${zh ? '讲解时可以怎么说' : 'How to present it'}**：${slide.speaking}`,
      ''
    );
  }
  lines.push(
    zh ? '## 当前质量和下一步' : '## Quality and next steps',
    '',
    `- ${zh ? '质量分' : 'Quality score'}：${model.qualityScore}/100`,
    ...model.nextSteps.map(item => `- ${item}`),
    '',
    zh ? '建议先确认上面的待补资料，再继续生成 PPTX 草稿。导入 outline.json 后，PPTX 工具会沿用这份结构继续生成。' : 'Confirm the missing details above before generating the PPTX draft. Import outline.json to continue with the same structure.'
  );
  return `${lines.join('\n').replace(/\n{4,}/g, '\n\n\n')}\n`;
}

export function createPptOutlineManifest(result) {
  return {
    schema: result.schema,
    version: result.version,
    deck_type: result.deck_type || result.request?.deck_type || 'auto',
    title: result.title,
    slide_count: result.slides?.length || 0,
    audience: result.audience,
    purpose: result.purpose,
    request: {
      slide_count: result.request?.slide_count,
      locale: result.request?.locale,
      deck_type: result.request?.deck_type,
      prompt_characters: result.request?.prompt?.length || 0,
      audience_characters: result.request?.audience?.length || 0,
      purpose_characters: result.request?.purpose?.length || 0,
      tone_characters: result.request?.tone?.length || 0,
      style_characters: result.request?.style?.length || 0
    },
    quality_score: result.quality_check?.self_check?.score ?? 0,
    guide_file: 'outline-guide.md',
    fact_bank: result.fact_bank,
    quality_check: result.quality_check
  };
}
