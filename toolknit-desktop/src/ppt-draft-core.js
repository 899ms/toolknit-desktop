import { buildPptDraftPptx as buildPptDraftPptxExport } from './ppt-draft-export.js';
import {
  PPT_OUTLINE_LIMITS,
  createPptOutlineMarkdown,
  getPptOutlineDeckTypeLabel,
  normalizePptOutlineResult,
  normalizePptOutlineRequest,
  sanitizePptOutlineBaseName
} from './ppt-outline-core.js';

export const PPT_DRAFT_LIMITS = Object.freeze({
  minSlides: PPT_OUTLINE_LIMITS.minSlides,
  maxSlides: PPT_OUTLINE_LIMITS.maxSlides,
  maxTitleChars: 120,
  maxBulletChars: 110,
  maxSpeakerNoteChars: 220
});

export const PPT_DRAFT_THEMES = Object.freeze(['minimal-mono']);

const EMU_PER_INCH = 914400;
const SLIDE_WIDTH = 13.333333;
const SLIDE_HEIGHT = 7.5;
const SLIDE_CX = Math.round(SLIDE_WIDTH * EMU_PER_INCH);
const SLIDE_CY = Math.round(SLIDE_HEIGHT * EMU_PER_INCH);

// Media frames are a hard layout contract. Keeping the source SVG and the
// PowerPoint frame on the same ratio prevents user screenshots from being
// stretched when they are replaced in PowerPoint.
const POSTER_MEDIA_FORMATS = Object.freeze({
  landscape: Object.freeze({
    id: 'landscape',
    orientation: 'landscape',
    aspectRatio: 16 / 9,
    aspectRatioLabel: '16:9',
    svgWidth: 1600,
    svgHeight: 900
  }),
  portrait: Object.freeze({
    id: 'portrait',
    orientation: 'portrait',
    aspectRatio: 9 / 16,
    aspectRatioLabel: '9:16',
    svgWidth: 900,
    svgHeight: 1600
  })
});

function getPosterMediaFormat(value = 'landscape') {
  return POSTER_MEDIA_FORMATS[String(value || 'landscape').toLowerCase()] || POSTER_MEDIA_FORMATS.landscape;
}

function derivePosterMediaHeight(width, format) {
  const numericWidth = Number(width);
  if (!Number.isFinite(numericWidth) || numericWidth <= 0) return 0;
  return Number((numericWidth / format.aspectRatio).toFixed(4));
}

const THEME_TOKENS = Object.freeze({
  // Single-template product decision: every deck is generated in a strict
  // black/white minimal system. The palette is a grayscale ramp where pure
  // white dominates the canvas and near-black is reserved for accents and
  // primary text. Secondary accents are deliberately neutral grays rather
  // than hue-based so the result stays cohesive regardless of subject.
  'minimal-mono': {
    id: 'minimal-mono',
    name: 'Minimal Monochrome',
    background: 'FFFFFF',
    panel: 'F7F7F7',
    panelAlt: 'EFEFEF',
    text: '111111',
    muted: '6B6B6B',
    accent: '111111',
    accentSoft: '3A3A3A',
    warm: '8A8A8A',
    success: '3A3A3A',
    danger: '111111',
    violet: '111111',
    line: 'D8D8D8',
    grid: 'ECECEC',
    surface: 'F5F5F5'
  }
});

const INTERIOR_SPACE_KEYWORDS = Object.freeze([
  '玄关',
  '客厅',
  '餐厅',
  '厨房',
  '主卧',
  '南次卧',
  '北次卧',
  '次卧',
  '卧室',
  '书房',
  '儿童房',
  '老人房',
  '卫生间',
  '卫浴',
  '阳台',
  '露台',
  '衣帽间',
  '储物间'
]);

export class PptDraftError extends Error {
  constructor(code, message) {
    super(`ppt-draft:${code}:${message}`);
    this.name = 'PptDraftError';
    this.code = code;
    this.userMessage = message;
  }
}

function fail(code, message) {
  throw new PptDraftError(code, message);
}

function cleanInline(value, { maxChars = 240, fallback = '' } = {}) {
  return String(value || '')
    .replace(/\u00A0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxChars) || fallback;
}

function cleanTheme() {
  // Legacy and user-provided theme hints are intentionally ignored. The
  // product exposes a single black/white minimal template, so any incoming
  // theme value is normalized to that canonical token rather than rejected.
  return 'minimal-mono';
}

export function inferPptDraftTheme() {
  return 'minimal-mono';
}

function pptDraftVisualStyleText(outline = {}) {
  return [
    outline?.request?.style,
    outline?.draft_request?.style,
    outline?.design?.style,
    outline?.design?.visual_system,
    outline?.design?.color_hint,
    outline?.design?.font_hint,
    outline?.narrative?.central_takeaway,
    outline?.purpose
  ]
    .map(value => String(value || '').trim())
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

function pptDraftSubjectText(outline = {}) {
  const slideText = (Array.isArray(outline?.slides) ? outline.slides : []).flatMap(slide => [
    slide?.title,
    slide?.claim,
    ...(Array.isArray(slide?.body) ? slide.body : []),
    slide?.visual_suggestion,
    slide?.layout_intent?.visual_focus,
    slide?.layoutIntent?.visualFocus
  ]);
  return [
    outline?.title,
    outline?.subtitle,
    outline?.audience,
    outline?.purpose,
    outline?.request?.prompt,
    outline?.request?.audience,
    outline?.request?.purpose,
    outline?.request?.style,
    outline?.draft_request?.prompt,
    outline?.draft_request?.style,
    outline?.narrative?.central_takeaway,
    outline?.design?.style,
    outline?.design?.visual_system,
    outline?.design?.color_hint,
    outline?.design?.font_hint,
    ...slideText
  ]
    .map(value => String(value || '').trim())
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

export function resolvePptDraftSubjectProfile(outline = {}) {
  const text = pptDraftSubjectText(outline);
  if (!text) return 'generic';
  if (/装修|装饰|室内|空间|全屋|户型|家装|工装|软装|硬装|客厅|餐厅|厨房|主卧|次卧|卧室|阳台|玄关|卫浴|衣帽间|材质|动线|收纳|interior|renovation|home\s*design/i.test(text)) return 'interior';
  if (/toolknit|工具编织|工具箱|本地优先|桌面端|开源项目|github|mit|mcp|ai\s*agent|cli|效率工具|pdf\s*工具/i.test(text)) return 'toolknit';
  if (/党组织|党建|党支部|支部委员|组织生活会|党员|理论学习|问题查摆|原因剖析|整改措施|责任分工|政务|机关|基层党|专题会|红色政务|government|party\s*committee/i.test(text)) return 'party-government';
  if (/人物介绍|人物生平|生平|传记|朱自清|鲁迅|老舍|巴金|文学|散文|诗人|作家|作品|背影|荷塘月色|春|人格气节|语文|biography|literature|writer|poet/i.test(text)) return 'literary-biography';
  if (/课程|培训|教学|知识|学习|课堂|教案|考试|教育|training|lesson|course|workshop/i.test(text)) return 'education';
  if (/香烟|吸烟|戒烟|烟草|尼古丁|肺癌|慢阻肺|心脑血管|健康科普|医学|医疗|疾病|癌症|养生|卫生|预防|health|medical|smoking|cancer|disease|nicotine/i.test(text)) return 'health';
  if (/商业|增长|融资|品牌|营销|客户|市场|竞品|战略|运营|复盘|销售|business|marketing|sales|strategy|growth/i.test(text)) return 'business';
  if (/产品|软件|平台|系统|技术|工程|开发|代码|api|saas|应用|科技|智能|ai|product|software|tech|engineering/i.test(text)) return 'tech-product';
  return 'generic';
}

function countInteriorSpaces(outline = {}) {
  const text = pptDraftSubjectText(outline);
  const matches = new Set();
  INTERIOR_SPACE_KEYWORDS.forEach(keyword => {
    if (text.includes(keyword.toLowerCase())) matches.add(keyword);
  });
  if (matches.has('卧室') && (matches.has('主卧') || matches.has('次卧') || matches.has('南次卧') || matches.has('北次卧'))) matches.delete('卧室');
  if (matches.has('次卧') && (matches.has('南次卧') || matches.has('北次卧'))) matches.delete('次卧');
  return matches.size;
}

function splitPptDraftDeckTitle(titleValue, outline = {}, profile = resolvePptDraftSubjectProfile(outline)) {
  const title = cleanInline(titleValue || outline?.title, { maxChars: 96, fallback: 'PPTX 草稿' });
  const split = title.split(/[:：]/).map(part => part.trim()).filter(Boolean);
  if (split.length > 1) {
    return {
      brand: cleanInline(split[0], { maxChars: 28, fallback: 'PPTX' }),
      main: cleanInline(split.slice(1).join('：'), { maxChars: 68, fallback: title })
    };
  }
  if (profile === 'interior') {
    const match = title.match(/^(.{2,18}?(?:装饰|设计|空间|家居|建筑|软装|硬装))[\s·｜|:：-]*(.+)$/);
    if (match && cleanInline(match[2], { maxChars: 68 })) {
      return {
        brand: cleanInline(match[1], { maxChars: 28, fallback: '空间案例' }),
        main: cleanInline(match[2], { maxChars: 68, fallback: title })
      };
    }
    return {
      brand: '空间案例',
      main: title
    };
  }
  if (profile === 'business') return { brand: '商业简报', main: title };
  if (profile === 'party-government') return { brand: '专题会议', main: title };
  if (profile === 'literary-biography') return { brand: '人物介绍', main: title };
  if (profile === 'education') return { brand: '课程讲义', main: title };
  if (profile === 'health') return { brand: '健康科普', main: title };
  if (profile === 'tech-product') return { brand: '产品方案', main: title };
  if (profile === 'toolknit' && /toolknit/i.test(title)) {
    return { brand: 'ToolKnit Desktop', main: title };
  }
  return {
    brand: 'PPTX 草稿',
    main: title
  };
}

export function resolvePptDraftSubjectCopy(outline = {}) {
  const profile = resolvePptDraftSubjectProfile(outline);
  const locale = outline?.request?.locale || outline?.draft_request?.locale || 'zh-CN';
  const zh = locale !== 'en';
  const deckType = getPptOutlineDeckTypeLabel(outline.deck_type || outline.request?.deck_type || 'auto', locale);
  const interiorCount = countInteriorSpaces(outline);
  const shared = {
    profile,
    deckType,
    footerFallback: zh ? 'PPTX 草稿' : 'PPTX Draft',
    generatedLabel: zh ? 'ToolKnit 生成' : 'Generated by ToolKnit',
    matrixMetricValue: zh ? '重点' : 'KEY',
    matrixMetricLabel: zh ? 'STRUCTURE / STORY / ACTION' : 'STRUCTURE / STORY / ACTION',
    matrixPrinciple: zh ? '把信息重新编排成一条清晰的故事线。' : 'Turn information into a clear story line.',
    matrixNote: zh ? '重点、证据与行动保持同一条表达链路。' : 'Keep claims, proof and actions in one line.',
    coverMetaItems: [deckType, zh ? '结构清晰' : 'Clear structure', zh ? '可编辑' : 'Editable', zh ? '可交付' : 'Ready'],
    coverEyebrow: zh ? 'PRESENTATION / EDITABLE DRAFT' : 'PRESENTATION / EDITABLE DRAFT',
    coverVisualTag: zh ? 'VISUAL / EDITABLE' : 'VISUAL / EDITABLE',
    coverImageLabel: zh ? '替换为主题主视觉' : 'Replace with hero visual',
    statementImageLabel: zh ? '替换为关键画面或截图' : 'Replace with key visual',
    problemImageLabel: zh ? '替换为问题现场或证据图' : 'Replace with problem evidence',
    processImageLabel: zh ? '替换为流程或关键节点图' : 'Replace with process visual',
    comparisonBeforeLabel: zh ? '替换为对比前画面' : 'Replace with before visual',
    comparisonAfterLabel: zh ? '替换为对比后画面' : 'Replace with after visual',
    closingImageLabel: zh ? '替换为联系二维码或行动截图' : 'Replace with CTA visual',
    coverIcons: ['document', 'image', 'spark'],
    statementIcon: 'spark',
    problemIcon: 'spark',
    recommendationIcon: 'check',
    sectionIcon: 'layers',
    problemEyebrow: zh ? 'KEY QUESTION / CONTEXT' : 'KEY QUESTION / CONTEXT',
    problemAlertLabel: zh ? 'PAIN POINT / STAKES / CONTEXT' : 'PAIN POINT / STAKES / CONTEXT',
    recommendationEyebrow: zh ? 'RECOMMENDATION / NEXT MOVE' : 'RECOMMENDATION / NEXT MOVE',
    closingEyebrow: zh ? 'NEXT STEP / DECISION READY' : 'NEXT STEP / DECISION READY',
    closingVisualLabel: zh ? 'ACTION / EDIT / SHARE' : 'ACTION / EDIT / SHARE',
    comparisonLeftLabel: zh ? '现状 / 问题' : 'Before',
    comparisonRightLabel: zh ? '方案 / 结果' : 'After',
    visualCaption: zh ? 'VISUAL / REPLACEABLE' : 'VISUAL / REPLACEABLE',
    defaultProblemBullets: zh ? ['现状尚不清晰', '关键证据待补充', '行动路径需要收束'] : ['Unclear current state', 'Proof to confirm', 'Action path to align'],
    defaultRecommendationBullets: zh ? ['明确重点', '降低理解成本', '推动下一步行动'] : ['Clarify the point', 'Lower effort', 'Drive action'],
    defaultClosingActions: zh ? ['确认关键信息', '替换真实素材', '导出并继续编辑'] : ['Confirm key facts', 'Replace visuals', 'Export and edit']
  };
  if (profile === 'toolknit') {
    return {
      ...shared,
      footerFallback: 'ToolKnit Desktop',
      coverMetaItems: [deckType, zh ? '本地运行' : 'Local build', '20+ 工具', 'MIT'],
      coverEyebrow: 'TOOLKNIT  /  OPEN SOURCE RELEASE',
      coverVisualTag: 'LOCAL / EDITABLE',
      coverImageLabel: zh ? '替换为产品首屏截图' : 'Replace with product screenshot',
      statementImageLabel: zh ? '替换为产品截图' : 'Replace with product screenshot',
      problemImageLabel: zh ? '替换为上传流程或风险截图' : 'Replace with risk screenshot',
      processImageLabel: zh ? '替换为流程或产品截图' : 'Replace with workflow screenshot',
      comparisonBeforeLabel: zh ? '替换为对比前截图' : 'Replace with before screenshot',
      comparisonAfterLabel: zh ? '替换为对比后截图' : 'Replace with after screenshot',
      closingImageLabel: zh ? '替换为二维码或下载截图' : 'Replace with download QR',
      coverIcons: ['lock', 'toolbox', 'agent'],
      statementIcon: 'spark',
      problemIcon: 'cloudOff',
      recommendationIcon: 'desktop',
      sectionIcon: 'toolbox',
      problemEyebrow: 'THE HIDDEN COST OF CLOUD WORKFLOWS',
      problemAlertLabel: 'PRIVACY / NETWORK / CONTROL',
      recommendationEyebrow: 'LOCAL FIRST / NO CLOUD REQUIRED',
      closingEyebrow: 'KEEP BUILDING  /  TOOLKNIT',
      closingVisualLabel: 'OPEN / EDIT / SHIP',
      comparisonLeftLabel: zh ? '传统方式' : 'Traditional workflow',
      comparisonRightLabel: 'ToolKnit Desktop',
      visualCaption: 'VISUAL / REPLACEABLE',
      matrixMetricValue: '20+',
      matrixMetricLabel: 'LOCAL TOOLS / ONE WORKSPACE',
      matrixPrinciple: zh ? '文件留在设备里，工具彼此协同。' : 'Keep files local and tools connected.',
      matrixNote: zh ? '从 PDF 到 AI，保持同一条本地工作流。' : 'One local workflow from PDF to AI.',
      defaultProblemBullets: zh ? ['文件上传服务器', '离线无法继续', '工具彼此割裂'] : ['Server uploads', 'Network lock-in', 'Fragmented tools'],
      defaultRecommendationBullets: zh ? ['本地处理', '离线可用', '逻辑可审查'] : ['Local processing', 'Offline capable', 'Auditable logic'],
      defaultClosingActions: zh ? ['打开 GitHub 仓库', '下载桌面端', '加入共建'] : ['Open GitHub', 'Download desktop', 'Contribute']
    };
  }
  if (profile === 'interior') {
    return {
      ...shared,
      footerFallback: zh ? '空间设计案例' : 'Interior Case',
      coverMetaItems: [deckType, zh ? '空间规划' : 'Space planning', zh ? '材质氛围' : 'Material mood', zh ? '交付沟通' : 'Client review'],
      coverEyebrow: 'INTERIOR CASE  /  DESIGN PRESENTATION',
      coverVisualTag: 'SPACE / EDITABLE',
      coverImageLabel: zh ? '替换为空间效果图或实景图' : 'Replace with interior render',
      statementImageLabel: zh ? '替换为空间主视觉或细节图' : 'Replace with room hero image',
      problemImageLabel: zh ? '替换为户型、现场痛点或改造前图' : 'Replace with floorplan or before photo',
      processImageLabel: zh ? '替换为设计流程、材质板或施工节点图' : 'Replace with design process or material board',
      comparisonBeforeLabel: zh ? '替换为改造前现场图' : 'Replace with before photo',
      comparisonAfterLabel: zh ? '替换为设计后效果图' : 'Replace with after render',
      closingImageLabel: zh ? '替换为联系二维码或案例合集' : 'Replace with contact QR or case gallery',
      coverIcons: ['home', 'palette', 'ruler'],
      statementIcon: 'home',
      problemIcon: 'ruler',
      recommendationIcon: 'palette',
      sectionIcon: 'layers',
      problemEyebrow: 'SPACE PAIN POINT  /  DESIGN VALUE',
      problemAlertLabel: 'LIGHT / STORAGE / CIRCULATION',
      recommendationEyebrow: 'DESIGN METHOD  /  LIVING EXPERIENCE',
      closingEyebrow: 'NEXT STEP  /  DESIGN REVIEW',
      closingVisualLabel: 'CONTACT / CASE / PLAN',
      comparisonLeftLabel: zh ? '改造前 / 痛点' : 'Before / Pain point',
      comparisonRightLabel: zh ? '设计后 / 价值' : 'After / Value',
      visualCaption: 'SPACE / MATERIAL / DETAIL',
      matrixMetricValue: interiorCount >= 3 ? `${interiorCount}区` : (zh ? '全屋' : 'HOME'),
      matrixMetricLabel: zh ? 'SPACE ZONES / DESIGN DETAILS' : 'SPACE ZONES / DESIGN DETAILS',
      matrixPrinciple: zh ? '用动线、收纳与材质把空间串成整体。' : 'Unify circulation, storage and material mood.',
      matrixNote: zh ? '每个空间保留独立重点，也服务同一套居住体验。' : 'Each zone keeps one focus inside a shared living experience.',
      defaultProblemBullets: zh ? ['动线需要更顺', '收纳需要更隐形', '材质氛围需统一'] : ['Improve circulation', 'Hide storage', 'Unify materials'],
      defaultRecommendationBullets: zh ? ['先定空间主线', '再做材质层次', '最后落到生活细节'] : ['Define the spatial thread', 'Layer materials', 'Land in daily details'],
      defaultClosingActions: zh ? ['确认设计方向', '补充真实素材', '进入深化沟通'] : ['Confirm direction', 'Add real visuals', 'Move to design review']
    };
  }
  if (profile === 'business') {
    return {
      ...shared,
      coverMetaItems: [deckType, zh ? '关键判断' : 'Key judgment', zh ? '证据链路' : 'Evidence chain', zh ? '行动方案' : 'Action plan'],
      coverEyebrow: 'BUSINESS BRIEF  /  DECISION READY',
      coverVisualTag: 'INSIGHT / EDITABLE',
      coverIcons: ['table', 'document', 'layers'],
      problemEyebrow: 'BUSINESS TENSION  /  DECISION CONTEXT',
      recommendationEyebrow: 'RECOMMENDATION  /  ACTION PLAN',
      matrixMetricLabel: 'SIGNALS / OPTIONS / ACTIONS'
    };
  }
  if (profile === 'party-government') {
    return {
      ...shared,
      footerFallback: zh ? '党组织会议汇报' : 'Party Meeting Brief',
      coverMetaItems: [deckType, zh ? '组织规范' : 'Organization', zh ? '问题导向' : 'Problem focus', zh ? '整改闭环' : 'Action loop'],
      coverEyebrow: 'PARTY MEETING  /  WORK REPORT',
      coverVisualTag: 'MEETING / EDITABLE',
      coverImageLabel: zh ? '替换为会议现场或学习笔记图' : 'Replace with meeting or notes photo',
      statementImageLabel: zh ? '替换为会议现场、学习笔记或材料截图' : 'Replace with meeting or material visual',
      problemImageLabel: zh ? '替换为问题清单、谈心谈话或查摆材料图' : 'Replace with issue list or review material',
      processImageLabel: zh ? '替换为整改闭环、责任清单或流程图' : 'Replace with rectification workflow',
      comparisonBeforeLabel: zh ? '整改前 / 问题表现' : 'Before / Issues',
      comparisonAfterLabel: zh ? '整改后 / 工作成效' : 'After / Outcomes',
      closingImageLabel: zh ? '替换为责任清单、会议纪要或下一步安排' : 'Replace with responsibility list',
      coverIcons: ['flag', 'checklist', 'meeting'],
      statementIcon: 'flag',
      problemIcon: 'checklist',
      recommendationIcon: 'shield',
      sectionIcon: 'meeting',
      problemEyebrow: 'ISSUE REVIEW  /  RECTIFICATION FOCUS',
      problemAlertLabel: 'LEARNING / REVIEW / ACTION',
      recommendationEyebrow: 'RECTIFICATION METHOD  /  CLOSED LOOP',
      closingEyebrow: 'NEXT STEP  /  RESPONSIBILITY LIST',
      closingVisualLabel: 'RESPONSIBILITY / TIMELINE / REVIEW',
      comparisonLeftLabel: zh ? '问题表现 / 差距' : 'Issues / Gap',
      comparisonRightLabel: zh ? '整改方向 / 闭环' : 'Action / Loop',
      visualCaption: 'MEETING / REVIEW / ACTION',
      matrixMetricValue: zh ? '闭环' : 'LOOP',
      matrixMetricLabel: 'ISSUES / RESPONSIBILITY / ACTION',
      matrixPrinciple: zh ? '把查摆问题、责任分工和整改措施连成闭环。' : 'Connect issues, responsibility and actions into a closed loop.',
      matrixNote: zh ? '每个问题都要对应措施、责任人和复盘节点。' : 'Every issue maps to action, owner and review.',
      defaultProblemBullets: zh ? ['理论学习还需更紧', '联系群众还需更深', '创新意识还需加强'] : ['Learning can be tighter', 'Mass connection deeper', 'Innovation stronger'],
      defaultRecommendationBullets: zh ? ['建立整改台账', '明确责任分工', '定期复盘销号'] : ['Create action ledger', 'Assign ownership', 'Review and close'],
      defaultClosingActions: zh ? ['确认整改清单', '压实责任分工', '跟踪复盘成效'] : ['Confirm action list', 'Assign owners', 'Review outcomes']
    };
  }
  if (profile === 'literary-biography') {
    return {
      ...shared,
      footerFallback: zh ? '人物介绍课件' : 'Biography Deck',
      coverMetaItems: [deckType, zh ? '生平脉络' : 'Life arc', zh ? '代表作品' : 'Works', zh ? '精神气质' : 'Character'],
      coverEyebrow: 'LITERARY PORTRAIT  /  BIOGRAPHY DECK',
      coverVisualTag: 'BOOK / EDITABLE',
      coverImageLabel: zh ? '替换为人物照片、书页或作品意象图' : 'Replace with portrait or book visual',
      statementImageLabel: zh ? '替换为人物照片、书页、荷叶或月色意象图' : 'Replace with portrait or literary visual',
      problemImageLabel: zh ? '替换为时代背景、作品片段或课堂提问图' : 'Replace with context or reading prompt',
      processImageLabel: zh ? '替换为生平时间线、作品脉络或阅读路径图' : 'Replace with life timeline or reading path',
      comparisonBeforeLabel: zh ? '时代背景 / 生活经历' : 'Context / Life',
      comparisonAfterLabel: zh ? '作品表达 / 文学影响' : 'Works / Influence',
      closingImageLabel: zh ? '替换为书页、阅读清单或课堂讨论图' : 'Replace with reading list',
      coverIcons: ['book', 'leaf', 'pen'],
      statementIcon: 'book',
      problemIcon: 'moon',
      recommendationIcon: 'leaf',
      sectionIcon: 'book',
      problemEyebrow: 'READING QUESTION  /  LITERARY CONTEXT',
      problemAlertLabel: 'LIFE / WORKS / CHARACTER',
      recommendationEyebrow: 'READING METHOD  /  TEXT APPRECIATION',
      closingEyebrow: 'READ NEXT  /  CLASS DISCUSSION',
      closingVisualLabel: 'READING / NOTES / DISCUSSION',
      comparisonLeftLabel: zh ? '生平经历 / 时代背景' : 'Life / Context',
      comparisonRightLabel: zh ? '作品风格 / 精神气质' : 'Works / Spirit',
      visualCaption: 'BOOK / MOOD / MEMORY',
      matrixMetricValue: zh ? '作品' : 'WORKS',
      matrixMetricLabel: 'LIFE / WORKS / STYLE',
      matrixPrinciple: zh ? '把生平、作品和精神气质放在同一条阅读线索里。' : 'Connect life, works and character in one reading path.',
      matrixNote: zh ? '每个作品意象都服务于人物理解和课堂讨论。' : 'Every motif supports the portrait and discussion.',
      defaultProblemBullets: zh ? ['时代背景需要理解', '作品情感需要细读', '人格气节需要联系文本'] : ['Read the context', 'Close-read emotion', 'Connect character'],
      defaultRecommendationBullets: zh ? ['先看生平脉络', '再读代表作品', '最后理解精神气质'] : ['Trace life arc', 'Read key works', 'Understand character'],
      defaultClosingActions: zh ? ['回到文本细读', '补充作品片段', '开展课堂讨论'] : ['Return to text', 'Add excerpts', 'Discuss in class']
    };
  }
  if (profile === 'education') {
    return {
      ...shared,
      coverMetaItems: [deckType, zh ? '学习路径' : 'Learning path', zh ? '重点拆解' : 'Key points', zh ? '练习应用' : 'Practice'],
      coverEyebrow: 'LEARNING DECK  /  CLEAR STRUCTURE',
      coverVisualTag: 'LESSON / EDITABLE',
      coverIcons: ['document', 'layers', 'spark'],
      problemEyebrow: 'LEARNING QUESTION  /  CONTEXT',
      recommendationEyebrow: 'METHOD  /  PRACTICE',
      matrixMetricLabel: 'CONCEPTS / EXAMPLES / PRACTICE'
    };
  }
  if (profile === 'health') {
    return {
      ...shared,
      coverMetaItems: [deckType, zh ? '危害机制' : 'Harm mechanism', zh ? '健康证据' : 'Health evidence', zh ? '行动建议' : 'Action plan'],
      coverEyebrow: 'HEALTH AWARENESS  /  EVIDENCE & ACTION',
      coverVisualTag: 'HEALTH / EDITABLE',
      coverIcons: ['activity', 'heart', 'spark'],
      statementIcon: 'activity',
      problemIcon: 'alert',
      recommendationIcon: 'heart',
      sectionIcon: 'layers',
      problemEyebrow: 'WHY IT MATTERS  /  CONTEXT',
      problemAlertLabel: 'RISK / MECHANISM / EVIDENCE',
      recommendationEyebrow: 'ACTION  /  PREVENTION',
      closingEyebrow: 'NEXT STEP  /  TAKE ACTION',
      closingVisualLabel: 'HEALTH / HABIT / SUPPORT',
      comparisonLeftLabel: zh ? '吸烟 / 暴露' : 'Smoking / Exposure',
      comparisonRightLabel: zh ? '戒烟 / 健康' : 'Quitting / Health',
      visualCaption: 'VISUAL / REPLACEABLE',
      matrixMetricLabel: 'RISK / EVIDENCE / ACTION',
      defaultProblemBullets: zh ? ['伤害是持续累积的', '关键机制需要被看见', '行动比焦虑更重要'] : ['Harm accumulates', 'Mechanism must be seen', 'Action beats worry'],
      defaultRecommendationBullets: zh ? ['先理解危害', '再建立替代习惯', '必要时寻求专业支持'] : ['Understand harm', 'Build alternatives', 'Seek support'],
      defaultClosingActions: zh ? ['记住危害是累积的', '把行动落到日常', '必要时寻求帮助'] : ['Remember harm accumulates', 'Act daily', 'Seek help when needed']
    };
  }
  if (profile === 'tech-product') {
    return {
      ...shared,
      coverMetaItems: [deckType, zh ? '产品逻辑' : 'Product logic', zh ? '场景价值' : 'Use case value', zh ? '落地路径' : 'Delivery path'],
      coverEyebrow: 'PRODUCT STORY  /  BUILD READY',
      coverVisualTag: 'PRODUCT / EDITABLE',
      coverIcons: ['desktop', 'layers', 'agent'],
      problemEyebrow: 'USER PAIN  /  PRODUCT VALUE',
      recommendationEyebrow: 'PRODUCT METHOD  /  WORKFLOW',
      matrixMetricLabel: 'FEATURES / VALUE / WORKFLOW'
    };
  }
  return shared;
}

function applyPptDraftVisualStyle(theme) {
  return theme;
}

export function resolvePptDraftThemeTokens(themeValue = 'minimal-mono', outline = {}) {
  return THEME_TOKENS[cleanTheme(themeValue || outline?.request?.theme)] || THEME_TOKENS['minimal-mono'];
}

export function sanitizePptDraftBaseName(value) {
  return sanitizePptOutlineBaseName(value || 'ppt-draft').replace(/_outline$/i, '_draft') || 'ppt_draft';
}

export function normalizePptDraftRequest(args = {}) {
  const request = normalizePptOutlineRequest(args);
  return {
    ...request,
    theme: cleanTheme(args.theme || inferPptDraftTheme(args) || 'minimal-mono')
  };
}

export function normalizePptDraftOutline(payload, requestValue = {}) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    fail('invalid_outline', 'PPT draft requires a structured outline object.');
  }
  const prompt = payload.request?.prompt || requestValue.prompt || payload.title || 'PPT draft';
  const style = requestValue.style || payload.request?.style || payload.design?.style || payload.design?.visual_system || payload.design?.color_hint || '';
  const request = normalizePptDraftRequest({
    prompt,
    slide_count: requestValue.slide_count || payload.request?.slide_count || payload.slides?.length || 8,
    locale: requestValue.locale || payload.request?.locale || 'zh-CN',
    deck_type: requestValue.deck_type || payload.request?.deck_type || 'auto',
    audience: requestValue.audience || payload.request?.audience || payload.audience || '',
    purpose: requestValue.purpose || payload.request?.purpose || payload.purpose || '',
    tone: requestValue.tone || payload.request?.tone || '',
    style,
    theme: requestValue.theme || payload.request?.theme || inferPptDraftTheme({
      prompt,
      style,
      theme_hint: `${payload.design?.visual_system || ''} ${payload.design?.color_hint || ''}`
    }) || 'minimal-mono'
  });
  const normalized = payload.schema === 'toolknit.ppt-outline'
    ? normalizePptOutlineResult({
      ready: true,
      title: payload.title,
      subtitle: payload.subtitle,
      audience: payload.audience,
      purpose: payload.purpose,
      narrative: payload.narrative,
      design: payload.design,
      slides: payload.slides,
      quality_check: payload.quality_check
    }, request)
    : normalizePptOutlineResult(payload, request);
  return {
    ...normalized,
    schema: 'toolknit.ppt-draft-outline',
    draft_request: request,
    request: {
      ...normalized.request,
      theme: request.theme
    }
  };
}

function xmlEscape(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function clampFont(size) {
  const value = Number(size);
  if (!Number.isFinite(value)) return 18;
  return Math.max(8, Math.min(72, value));
}

function pct(value) {
  return Math.round(value * EMU_PER_INCH);
}

function color(value) {
  return String(value || 'FFFFFF').replace(/^#/, '').slice(0, 6).padEnd(6, '0').toUpperCase();
}

function textRun(value, { size = 18, bold = false, italic = false, colorValue = 'FFFFFF', fontFace = 'Microsoft YaHei' } = {}) {
  const face = xmlEscape(fontFace || 'Microsoft YaHei');
  return `<a:r><a:rPr lang="zh-CN" sz="${Math.round(clampFont(size) * 100)}"${bold ? ' b="1"' : ''}${italic ? ' i="1"' : ''}><a:solidFill><a:srgbClr val="${color(colorValue)}"/></a:solidFill><a:latin typeface="${face}"/><a:ea typeface="${face}"/><a:cs typeface="${face}"/></a:rPr><a:t>${xmlEscape(value)}</a:t></a:r>`;
}

function paragraph(value, options = {}) {
  const align = options.align || 'l';
  const level = Number.isInteger(options.level) ? Math.max(0, Math.min(4, options.level)) : 0;
  const margin = level > 0 ? ` marL="${285750 * level}" indent="-171450"` : '';
  const spacing = Number.isFinite(Number(options.spaceAfter)) ? ` spcAft="${Math.round(Number(options.spaceAfter) * 100)}"` : '';
  return `<a:p><a:pPr algn="${align}"${margin}${spacing}/>${textRun(value, options)}<a:endParaRPr lang="zh-CN" sz="${Math.round(clampFont(options.size || 18) * 100)}"/></a:p>`;
}

function textBox(id, name, x, y, w, h, paragraphs, options = {}) {
  const bodyPr = `${options.anchor ? ` anchor="${options.anchor}"` : ''}${options.inset ? ` lIns="${pct(options.inset)}" rIns="${pct(options.inset)}" tIns="${pct(options.inset)}" bIns="${pct(options.inset)}"` : ''}`;
  const safeParagraphs = Array.isArray(paragraphs) && paragraphs.length
    ? paragraphs
    : [paragraph('', { size: 12, colorValue: options.colorValue || 'FFFFFF' })];
  const fit = options.autoFit === 'shape'
    ? '<a:spAutoFit/>'
    : (options.autoFit === 'normal'
      ? `<a:normAutofit fontScale="${Math.round(Math.max(70000, Math.min(100000, Number(options.fontScale || 92000))))}" lnSpcReduction="12000"/>`
      : '<a:noAutofit/>');
  return `<p:sp>
    <p:nvSpPr><p:cNvPr id="${id}" name="${xmlEscape(name)}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>
    <p:spPr><a:xfrm><a:off x="${pct(x)}" y="${pct(y)}"/><a:ext cx="${pct(w)}" cy="${pct(h)}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/><a:ln><a:noFill/></a:ln></p:spPr>
    <p:txBody><a:bodyPr wrap="square"${bodyPr}>${fit}</a:bodyPr><a:lstStyle/>${safeParagraphs.join('')}</p:txBody>
  </p:sp>`;
}

function rectShape(id, name, x, y, w, h, fill, line = fill, alpha = '') {
  const fillAlpha = alpha ? `<a:alpha val="${alpha}"/>` : '';
  return `<p:sp>
    <p:nvSpPr><p:cNvPr id="${id}" name="${xmlEscape(name)}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
    <p:spPr><a:xfrm><a:off x="${pct(x)}" y="${pct(y)}"/><a:ext cx="${pct(w)}" cy="${pct(h)}"/></a:xfrm><a:prstGeom prst="roundRect"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="${color(fill)}">${fillAlpha}</a:srgbClr></a:solidFill><a:ln w="9525"><a:solidFill><a:srgbClr val="${color(line)}"/></a:solidFill></a:ln></p:spPr>
  </p:sp>`;
}

function lineShape(id, name, x1, y1, x2, y2, line, width = 1, dash = '') {
  const left = Math.min(x1, x2);
  const top = Math.min(y1, y2);
  const w = Math.max(Math.abs(x2 - x1), 0.001);
  const h = Math.max(Math.abs(y2 - y1), 0.001);
  const flip = `${x2 < x1 ? ' flipH="1"' : ''}${y2 < y1 ? ' flipV="1"' : ''}`;
  const dashXml = dash ? `<a:prstDash val="${xmlEscape(dash)}"/>` : '';
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${xmlEscape(name)}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm${flip}><a:off x="${pct(left)}" y="${pct(top)}"/><a:ext cx="${pct(w)}" cy="${pct(h)}"/></a:xfrm><a:prstGeom prst="line"><a:avLst/></a:prstGeom><a:noFill/><a:ln w="${Math.max(9525, Math.round(Number(width) * 9525))}"><a:solidFill><a:srgbClr val="${color(line)}"/></a:solidFill>${dashXml}</a:ln></p:spPr></p:sp>`;
}

function ellipseShape(id, name, x, y, w, h, fill = 'none', line = 'FFFFFF', width = 1, alpha = '') {
  const fillXml = fill === 'none' ? '<a:noFill/>' : `<a:solidFill><a:srgbClr val="${color(fill)}">${alpha ? `<a:alpha val="${alpha}"/>` : ''}</a:srgbClr></a:solidFill>`;
  const lineXml = line === 'none' ? '<a:ln><a:noFill/></a:ln>' : `<a:ln w="${Math.max(9525, Math.round(Number(width) * 9525))}"><a:solidFill><a:srgbClr val="${color(line)}"/></a:solidFill></a:ln>`;
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${xmlEscape(name)}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${pct(x)}" y="${pct(y)}"/><a:ext cx="${pct(w)}" cy="${pct(h)}"/></a:xfrm><a:prstGeom prst="ellipse"><a:avLst/></a:prstGeom>${fillXml}${lineXml}</p:spPr></p:sp>`;
}

function polygonShape(id, name, geometry, x, y, w, h, fill, line = fill, alpha = '') {
  const fillXml = fill === 'none' ? '<a:noFill/>' : `<a:solidFill><a:srgbClr val="${color(fill)}">${alpha ? `<a:alpha val="${alpha}"/>` : ''}</a:srgbClr></a:solidFill>`;
  const lineXml = line === 'none' ? '<a:ln><a:noFill/></a:ln>' : `<a:ln w="9525"><a:solidFill><a:srgbClr val="${color(line)}"/></a:solidFill></a:ln>`;
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${xmlEscape(name)}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${pct(x)}" y="${pct(y)}"/><a:ext cx="${pct(w)}" cy="${pct(h)}"/></a:xfrm><a:prstGeom prst="${xmlEscape(geometry)}"><a:avLst/></a:prstGeom>${fillXml}${lineXml}</p:spPr></p:sp>`;
}

function visualLength(value) {
  return [...String(value || '')].reduce((sum, char) => sum + (/[A-Za-z0-9@+./_-]/.test(char) ? 0.58 : 1), 0);
}

function visualTokens(value) {
  // Keep Latin/number runs together so labels such as "AI" and "PPTX"
  // never get split across lines. CJK characters remain individually
  // breakable, while whitespace is retained only between visible tokens.
  return String(value || '').match(/[A-Za-z0-9@+./_-]+|\s+|[^\sA-Za-z0-9@+./_-]/gu) || [];
}

function wrapVisualText(value, maxUnits = 20, maxLines = 2) {
  const source = cleanInline(value);
  if (!source) return [''];
  const lines = [];
  let line = '';
  const appendToken = token => {
    if (!token) return;
    const isWhitespace = /^\s+$/u.test(token);
    if (isWhitespace) {
      if (line && !/\s$/u.test(line)) line += ' ';
      return;
    }
    const next = line + token;
    if (!line || visualLength(next) <= maxUnits) {
      line = next;
      return;
    }
    lines.push(line.trim());
    line = token;
    // A single unbreakable token can be wider than the box (for example a
    // long URL). Fall back to character-level splitting only for that token.
    if (visualLength(line) > maxUnits) {
      line = '';
      for (const char of [...token]) {
        const charNext = line + char;
        if (line && visualLength(charNext) > maxUnits) {
          lines.push(line.trim());
          line = char;
        } else {
          line = charNext;
        }
      }
    }
  };
  for (const token of visualTokens(source)) appendToken(token);
  if (line.trim()) lines.push(line.trim());
  if (lines.length <= maxLines) return lines;
  const clipped = lines.slice(0, maxLines);
  let last = clipped[maxLines - 1].replace(/[，。；：,:;\s]+$/g, '');
  while (visualLength(`${last}…`) > maxUnits && last.length > 1) last = [...last].slice(0, -1).join('');
  clipped[maxLines - 1] = `${last}…`;
  return clipped;
}

function titleParagraphs(value, { size = 34, colorValue = 'FFFFFF', maxUnits = 22, maxLines = 2, align = 'l' } = {}) {
  return wrapVisualText(value, maxUnits, maxLines).map(line => paragraph(line, { size, bold: true, colorValue, align, spaceAfter: 3 }));
}

// Estimate a stable text fit before PowerPoint/LibreOffice gets involved. The
// generated file still keeps a small normal-autofit fallback, but the primary
// line break and font-size decision is deterministic across renderers.
function fitTextParagraphs(value, {
  width = 4,
  height = 0.8,
  size = 18,
  minSize = 11,
  maxLines = 2,
  maxChars = 220,
  bold = false,
  colorValue = 'FFFFFF',
  align = 'l',
  spaceAfter = 2,
  prefix = ''
} = {}) {
  const source = cleanInline(value, { maxChars });
  if (!source) return [];
  let fontSize = Math.max(minSize, Math.min(size, 72));
  let lines = [];
  for (let attempt = 0; attempt < 12; attempt++) {
    // 3.8 is deliberately conservative for Microsoft YaHei/CJK glyph widths;
    // it prevents a second renderer from wrapping a line we already measured.
    const units = Math.max(6, width * 3.8 * (18 / fontSize));
    const lineCapacity = Math.max(1, Math.floor(height / Math.max(0.16, (fontSize / 72) * 1.25)));
    const allowedLines = Math.max(1, Math.min(maxLines, lineCapacity));
    lines = wrapVisualText(source, units, allowedLines);
    if (lines.length <= allowedLines && lines.every(line => visualLength(line) <= units + 0.2)) break;
    if (fontSize <= minSize) break;
    fontSize = Math.max(minSize, fontSize - 1.5);
  }
  return lines.map((line, lineIndex) => paragraph(`${prefix}${line}`, {
    size: fontSize,
    bold,
    colorValue,
    align,
    spaceAfter: lineIndex === lines.length - 1 ? 0 : spaceAfter
  }));
}

function fitBulletParagraphs(items, theme, {
  width = 5.4,
  height = 1.8,
  size = 17,
  minSize = 12,
  maxItems = 3,
  maxLines = 1
} = {}) {
  const safeItems = (Array.isArray(items) ? items : []).filter(Boolean).slice(0, maxItems);
  if (!safeItems.length) return fitTextParagraphs('待补充更多素材', { width, height, size: minSize, minSize, maxLines: 1, colorValue: theme.muted, prefix: '· ' });
  const rowHeight = Math.max(0.28, height / safeItems.length);
  return safeItems.flatMap(item => fitTextParagraphs(item, {
    width: width - 0.2,
    height: rowHeight,
    size,
    minSize,
    maxLines,
    colorValue: theme.text,
    prefix: '· '
  }));
}

function semanticTitleParagraphs(value, options = {}) {
  const { size = 34, colorValue = 'FFFFFF', maxUnits = 22, maxLines = 2, align = 'l' } = options;
  const source = cleanInline(value);
  const chunks = source.split(/(?<=[：:，,；;])\s*/).filter(Boolean);
  if (chunks.length > 1 && chunks.length <= maxLines) {
    return chunks.flatMap(line => wrapVisualText(line, maxUnits, 1).map(part => paragraph(part, { size, bold: true, colorValue, align, spaceAfter: 3 })));
  }
  if (chunks.length > maxLines) {
    const head = chunks.slice(0, maxLines - 1);
    const tail = chunks.slice(maxLines - 1).join('');
    return [...head, ...wrapVisualText(tail, maxUnits, 1)].map(line => paragraph(line, { size, bold: true, colorValue, align, spaceAfter: 3 }));
  }
  return titleParagraphs(source, options);
}

function bodyParagraphs(items, theme, { maxItems = 4, maxUnits = 34, size = 16, bullet = true } = {}) {
  const list = (Array.isArray(items) ? items : []).filter(Boolean).slice(0, maxItems);
  const safe = list.length ? list : ['待补充更多素材'];
  return safe.flatMap(item => wrapVisualText(item, maxUnits, 2).map((line, lineIndex) => paragraph(`${bullet && lineIndex === 0 ? '• ' : '  '}${line}`, { size, colorValue: theme.text, spaceAfter: 7 })));
}

const ICON_SHAPES = Object.freeze({
  lock: '<rect x="58" y="104" width="140" height="112" rx="18"/><path d="M84 105V78c0-25 19-44 44-44s44 19 44 44v27"/><circle cx="128" cy="156" r="12"/><path d="M128 168v22"/>',
  toolbox: '<rect x="34" y="78" width="188" height="118" rx="18"/><path d="M82 78V57c0-10 8-18 18-18h56c10 0 18 8 18 18v21M34 124h188M102 124v18h52v-18"/>',
  terminal: '<rect x="34" y="48" width="188" height="154" rx="18"/><path d="m70 98 26 24-26 24M116 152h54"/><circle cx="68" cy="74" r="5" fill="currentColor" stroke="none"/><circle cx="88" cy="74" r="5" fill="currentColor" stroke="none"/>',
  agent: '<circle cx="128" cy="128" r="76"/><path d="M128 52V32M98 110h60M96 150h64M82 94h-20M176 94h20M94 188l-14 18M162 188l14 18"/><circle cx="103" cy="119" r="9" fill="currentColor" stroke="none"/><circle cx="153" cy="119" r="9" fill="currentColor" stroke="none"/>',
  image: '<rect x="36" y="50" width="184" height="156" rx="16"/><circle cx="92" cy="100" r="16"/><path d="m54 178 48-48 34 32 22-22 42 38"/>',
  pdf: '<path d="M64 28h88l40 40v160H64z"/><path d="M152 28v44h40M88 128h80M88 162h64M88 96h44"/>',
  video: '<rect x="30" y="58" width="160" height="140" rx="18"/><path d="m190 102 42-28v108l-42-28z"/><path d="m96 98 44 30-44 30z" fill="currentColor" stroke="none"/>',
  document: '<path d="M62 28h94l38 38v164H62z"/><path d="M156 28v42h38M90 112h76M90 148h76M90 184h54"/>',
  table: '<rect x="36" y="42" width="184" height="172" rx="12"/><path d="M36 94h184M36 146h184M96 42v172M158 42v172"/>',
  palette: '<path d="M126 34c-53 0-94 37-94 84 0 40 31 74 70 74h17c12 0 20-15 11-24-10-10-2-28 13-28h18c37 0 59-23 59-53 0-30-39-53-94-53z"/><circle cx="80" cy="92" r="8" fill="currentColor" stroke="none"/><circle cx="112" cy="70" r="8" fill="currentColor" stroke="none"/><circle cx="149" cy="70" r="8" fill="currentColor" stroke="none"/><circle cx="176" cy="94" r="8" fill="currentColor" stroke="none"/>',
  home: '<path d="M34 118 128 42l94 76"/><path d="M58 112v104h140V112"/><path d="M102 216v-62h52v62"/><path d="M82 138h28M146 138h28"/>',
  ruler: '<path d="M48 174 174 48l34 34L82 208z"/><path d="M88 166l-16-16M112 142l-16-16M136 118l-16-16M160 94l-16-16"/>',
  brush: '<path d="M156 48c16-12 38-9 50 6s9 36-7 49l-72 56-28-34z"/><path d="M98 126c-30 8-45 28-48 62 28-3 51-13 76-30"/><path d="M54 194c18 3 35-2 50-15"/>',
  flag: '<path d="M66 224V34"/><path d="M70 42h126l-18 38 18 38H70"/><path d="M66 224h72"/>',
  meeting: '<rect x="38" y="58" width="180" height="118" rx="14"/><path d="M66 176h124M84 214h88M128 176v38"/><circle cx="92" cy="110" r="16"/><circle cx="128" cy="102" r="18"/><circle cx="164" cy="110" r="16"/><path d="M74 148c8-18 28-24 54-16 26-8 46-2 54 16"/>',
  checklist: '<rect x="52" y="36" width="152" height="188" rx="16"/><path d="M86 84l14 14 28-34M86 130l14 14 28-34M86 176l14 14 28-34M146 94h28M146 140h28M146 186h28"/>',
  shield: '<path d="M128 28 206 58v58c0 52-32 88-78 112-46-24-78-60-78-112V58z"/><path d="m92 128 26 26 52-62"/>',
  book: '<path d="M52 48h70c24 0 36 12 36 36v124c-10-10-22-14-36-14H52z"/><path d="M204 48h-70c-24 0-36 12-36 36v124c10-10 22-14 36-14h70z"/><path d="M128 70v132M72 86h34M72 124h34M150 86h34M150 124h34"/>',
  pen: '<path d="M176 36c14-14 34-14 48 0s14 34 0 48L104 204 58 216l12-46z"/><path d="m152 60 44 44M70 170l34 34"/>',
  leaf: '<path d="M214 44c-76 4-134 34-164 92-16 32-10 62 12 78 22 16 55 10 78-14 42-44 48-98 74-156z"/><path d="M62 210c34-58 82-94 142-132"/>',
  moon: '<path d="M176 38c-34 12-58 44-58 82 0 48 38 86 86 86 7 0 14-1 20-3-22 23-53 37-88 37-64 0-116-52-116-116 0-44 25-82 62-102 23-12 62-10 94 16z"/>',
  portrait: '<circle cx="128" cy="86" r="42"/><path d="M54 220c10-54 45-82 74-82s64 28 74 82"/><path d="M78 220h100"/>',
  key: '<circle cx="92" cy="128" r="52"/><path d="m130 164 84-84M176 118l22 22M154 140l22 22"/><circle cx="92" cy="128" r="18"/>',
  desktop: '<rect x="30" y="38" width="196" height="138" rx="14"/><path d="M92 218h72M128 176v42"/>',
  layers: '<path d="m128 30 94 50-94 50-94-50zM34 128l94 50 94-50M34 176l94 50 94-50"/>',
  cloudOff: '<path d="M72 186h118c27 0 44-17 44-40 0-24-20-43-45-43-6-36-36-61-72-61-34 0-63 22-72 53M44 44l168 168"/>',
  check: '<circle cx="128" cy="128" r="88"/><path d="m82 130 30 30 64-70"/>',
  arrow: '<path d="M34 128h158M142 78l50 50-50 50"/>',
  openSource: '<path d="M128 28 204 56v54c0 52-31 91-76 112-45-21-76-60-76-112V56z"/><path d="m91 126 24 24 49-54"/>',
  spark: '<path d="m128 26 18 74 74 28-74 20-18 76-18-76-74-20 74-28z"/><path d="m202 36 6 24 24 6-24 6-6 24-6-24-24-6 24-6z"/>',
  download: '<path d="M128 32v112M82 102l46 46 46-46M50 190h156"/>'
});

function iconSvg(name, theme, { secondary = theme.warm, size = 256 } = {}) {
  const body = ICON_SHAPES[name] || ICON_SHAPES.spark;
  const primary = color(theme.accent);
  const secondaryColor = color(secondary || theme.warm);
  const normalizedBody = body.replace(/currentColor/g, `#${primary}`);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 256 256" fill="none"><g stroke="#${primary}" stroke-width="12" stroke-linecap="round" stroke-linejoin="round">${normalizedBody}</g><path d="M196 42l18 18" stroke="#${secondaryColor}" stroke-width="9" stroke-linecap="round" opacity=".9"/></svg>`;
}

function textureSvg(theme, variant = 'grid') {
  const bg = color(theme.background);
  const grid = color(theme.grid || theme.line);
  const accent = color(theme.accent);
  const warm = color(theme.warm || theme.accentSoft);
  const common = `<defs><pattern id="g" width="58" height="58" patternUnits="userSpaceOnUse"><path d="M58 0H0V58" fill="none" stroke="#${grid}" stroke-width="1" opacity=".30"/><circle cx="4" cy="4" r="1.2" fill="#${accent}" opacity=".32"/></pattern><linearGradient id="s" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#${accent}" stop-opacity=".18"/><stop offset="1" stop-color="#${warm}" stop-opacity="0"/></linearGradient></defs>`;
  if (variant === 'orbit') {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900" viewBox="0 0 1600 900">${common}<rect width="1600" height="900" fill="#${bg}"/><rect width="1600" height="900" fill="url(#g)"/><ellipse cx="1190" cy="430" rx="430" ry="210" fill="none" stroke="#${accent}" stroke-width="2" opacity=".20" transform="rotate(-17 1190 430)"/><ellipse cx="1190" cy="430" rx="340" ry="160" fill="none" stroke="#${warm}" stroke-width="1.5" opacity=".26" transform="rotate(-17 1190 430)"/><path d="M870 720 1510 110" stroke="#${accent}" stroke-width="2" opacity=".17"/><path d="M760 780 1450 180" stroke="#${warm}" stroke-width="1" opacity=".15"/></svg>`;
  }
  if (variant === 'weave') {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900" viewBox="0 0 1600 900">${common}<rect width="1600" height="900" fill="#${bg}"/><rect width="1600" height="900" fill="url(#g)"/><path d="M-80 730C210 550 360 870 650 690S1080 500 1690 690" fill="none" stroke="#${accent}" stroke-width="3" opacity=".22"/><path d="M-120 780C180 600 390 900 680 720S1100 530 1710 730" fill="none" stroke="#${warm}" stroke-width="2" opacity=".16"/><path d="M-20 120 580 0M360 900 1140 0M930 900 1600 120" stroke="#${grid}" stroke-width="2" opacity=".15"/></svg>`;
  }
  if (variant === 'party') {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900" viewBox="0 0 1600 900">${common}<rect width="1600" height="900" fill="#${bg}"/><rect width="1600" height="900" fill="url(#g)" opacity=".66"/><path d="M-40 178H620M-40 246H610M-40 314H580" stroke="#${accent}" stroke-width="4" opacity=".22"/><path d="M1040 88h420v420h-420z" fill="none" stroke="#${warm}" stroke-width="3" opacity=".20" transform="rotate(10 1040 88)"/><path d="M1060 120c68 18 118 60 146 126 24 56 42 108 54 156" fill="none" stroke="#${accent}" stroke-width="2.4" opacity=".20"/><path d="M1128 234h220M1128 306h188M1128 378h142" stroke="#${grid}" stroke-width="3" opacity=".18"/><circle cx="1218" cy="660" r="156" fill="#${accent}" opacity=".05"/><circle cx="1286" cy="622" r="106" fill="none" stroke="#${warm}" stroke-width="2" opacity=".14"/><path d="M188 814C388 642 626 616 894 676s454 58 590-30" fill="none" stroke="#${warm}" stroke-width="4" opacity=".14"/><path d="M1320 38 1512 230" stroke="#${accent}" stroke-width="2.5" opacity=".18"/><path d="M1292 72 1498 278" stroke="#${warm}" stroke-width="1.8" opacity=".14"/></svg>`;
  }
  if (variant === 'literary') {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900" viewBox="0 0 1600 900">${common}<rect width="1600" height="900" fill="#${bg}"/><rect width="1600" height="900" fill="url(#g)" opacity=".52"/><path d="M90 160h520M90 224h450M90 288h390M90 352h470" stroke="#${grid}" stroke-width="2" opacity=".22"/><path d="M1120 86c124 26 210 118 238 236 16 72 6 148-24 216-16-72-42-126-86-176-50-56-112-92-176-108 26-56 28-114 48-168z" fill="none" stroke="#${accent}" stroke-width="3" opacity=".18"/><path d="M1148 218c-92 22-168 74-228 154-46 62-76 116-90 164" fill="none" stroke="#${warm}" stroke-width="2.4" opacity=".18"/><path d="M210 756C420 644 620 648 830 710s386 76 606-6" fill="none" stroke="#${accent}" stroke-width="3" opacity=".15"/><path d="M104 740c90-62 176-88 268-80 80 8 142 28 190 58" fill="none" stroke="#${warm}" stroke-width="2" opacity=".12"/><circle cx="1304" cy="178" r="56" fill="none" stroke="#${warm}" stroke-width="2" opacity=".18"/><path d="M1268 220h72" stroke="#${grid}" stroke-width="2" opacity=".16"/></svg>`;
  }
  if (variant === 'interior') {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900" viewBox="0 0 1600 900">${common}<rect width="1600" height="900" fill="#${bg}"/><rect width="1600" height="900" fill="url(#g)" opacity=".58"/><path d="M146 752V248c0-92 74-166 166-166h92" fill="none" stroke="#${accent}" stroke-width="4" opacity=".18"/><path d="M1240 118h172v326h-172zM1052 310h188M1052 444h360M1052 578h258" fill="none" stroke="#${grid}" stroke-width="3" opacity=".22"/><path d="M-60 692C190 560 420 612 626 492s384-198 664-94 360 42 446-46" fill="none" stroke="#${warm}" stroke-width="4" opacity=".18"/><circle cx="1274" cy="710" r="180" fill="#${accent}" opacity=".045"/><circle cx="1320" cy="710" r="118" fill="none" stroke="#${warm}" stroke-width="2" opacity=".16"/></svg>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900" viewBox="0 0 1600 900">${common}<rect width="1600" height="900" fill="#${bg}"/><rect width="1600" height="900" fill="url(#g)"/><path d="M0 160 380 0M0 420 810 0M0 700 1400 0M560 900 1600 230" stroke="#${accent}" stroke-width="2" opacity=".13"/><path d="M0 210 300 80M760 900 1600 300" stroke="#${warm}" stroke-width="2" opacity=".16"/><rect x="1080" y="-120" width="700" height="700" fill="url(#s)" transform="rotate(18 1080 -120)" opacity=".7"/></svg>`;
}

export function placeholderSvg(theme, label = '替换为你的图片', format = 'landscape') {
  const mediaFormat = getPosterMediaFormat(format);
  const { svgWidth: width, svgHeight: height, aspectRatioLabel } = mediaFormat;
  const portrait = mediaFormat.orientation === 'portrait';
  const display = cleanInline(label) || '替换为你的图片';
  const labelLines = wrapVisualText(display, portrait ? 12 : 16, 2);
  const fontSize = portrait ? 32 : 36;
  const lineHeight = Math.round(fontSize * 1.3);
  const blockHeight = labelLines.length * lineHeight;
  const startY = Math.round(height * 0.5) - Math.round(blockHeight / 2) + Math.round(fontSize * 0.92);
  const labelXml = labelLines.map((line, i) => `<text x="${Math.round(width / 2)}" y="${startY + i * lineHeight}" fill="#8E8E8E" font-family="Microsoft YaHei,Arial" font-size="${fontSize}" text-anchor="middle">${xmlEscape(line)}</text>`).join('');
  const ratioY = Math.round(height - (portrait ? 40 : 32));
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" data-format="${mediaFormat.id}"><rect width="${width}" height="${height}" fill="#ECECEC"/>${labelXml}<text x="${Math.round(width / 2)}" y="${ratioY}" fill="#B6B6B6" font-family="Microsoft YaHei,Arial" font-size="${portrait ? 19 : 21}" letter-spacing="2" text-anchor="middle">${aspectRatioLabel}</text></svg>`;
}

function createSlideAssetContext(assetRegistry, slideIndex = 1) {
  const refs = [];
  const refMap = new Map();
  const placeholders = [];
  return {
    slideIndex,
    useSvg(key, data) {
      const safeKey = String(key).replace(/[^a-z0-9_-]+/gi, '-').toLowerCase();
      if (!assetRegistry.has(safeKey)) assetRegistry.set(safeKey, { path: `ppt/media/${safeKey}.svg`, data });
      if (!refMap.has(safeKey)) refMap.set(safeKey, `rId${refs.length + 2}`), refs.push({ id: refMap.get(safeKey), target: `../media/${safeKey}.svg` });
      return refMap.get(safeKey);
    },
    registerPlaceholder(meta) {
      placeholders.push({ ...meta });
    },
    placeholderManifest() {
      return placeholders.map(item => ({ ...item }));
    },
    relationships() {
      const images = refs.map(ref => `<Relationship Id="${ref.id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="${ref.target}"/>`).join('');
      return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>${images}</Relationships>`;
    }
  };
}

function svgPicture(ctx, id, name, x, y, w, h, key, svg, { placeholder = false, alt = '', placeholderIndex = 1, slideIndex = 1, aspectRatio = null, orientation = null } = {}) {
  const relId = ctx.useSvg(key, svg);
  const ph = placeholder ? `<p:ph type="pic" idx="${Math.max(1, Number(placeholderIndex) || 1)}"/>` : '';
  if (placeholder) {
    ctx.registerPlaceholder({
      slide: Math.max(1, Number(slideIndex) || 1),
      name: String(name),
      label: String(alt || name),
      x: Number(x.toFixed?.(3) || x),
      y: Number(y.toFixed?.(3) || y),
      width: Number(w.toFixed?.(3) || w),
      height: Number(h.toFixed?.(3) || h),
      ...(aspectRatio ? { aspect_ratio: String(aspectRatio) } : {}),
      ...(orientation ? { orientation: String(orientation) } : {}),
      replaceable: true,
      instruction: '在 PowerPoint 中右键图片选择“更改图片”，或直接替换此图片。'
    });
  }
  return `<p:pic><p:nvPicPr><p:cNvPr id="${id}" name="${xmlEscape(name)}" descr="${xmlEscape(alt || name)}"/><p:cNvPicPr preferRelativeResize="0"><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr>${ph}</p:nvPr></p:nvPicPr><p:blipFill><a:blip r:embed="${relId}"/><a:srcRect/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr><a:xfrm><a:off x="${pct(x)}" y="${pct(y)}"/><a:ext cx="${pct(w)}" cy="${pct(h)}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`;
}

function imagePlaceholder(ctx, id, name, x, y, w, h, theme, label = '替换为你的图片', slideIndex = null, placeholderIndex = 1, format = 'landscape') {
  const mediaFormat = getPosterMediaFormat(format);
  return svgPicture(ctx, id, name, x, y, w, h, `placeholder-${theme.id}-${mediaFormat.id}`, placeholderSvg(theme, label, mediaFormat.id), {
    placeholder: true,
    alt: `${label}，可在 PowerPoint 中更改图片`,
    slideIndex: slideIndex || ctx.slideIndex || 1,
    placeholderIndex,
    aspectRatio: mediaFormat.aspectRatioLabel,
    orientation: mediaFormat.orientation
  });
}

function iconPicture(ctx, id, name, x, y, w, h, icon, theme, secondary = theme.warm) {
  return svgPicture(ctx, id, name, x, y, w, h, `icon-${icon}-${theme.id}`, iconSvg(icon, theme, { secondary }), { alt: `${icon} icon` });
}

function texturePicture(ctx, id, theme, variant = 'grid') {
  return svgPicture(ctx, id, `Texture ${variant}`, 0, 0, SLIDE_WIDTH, SLIDE_HEIGHT, `texture-${variant}-${theme.id}`, textureSvg(theme, variant), { alt: 'abstract background texture' });
}

function normalizeSlideText(slide) {
  const body = Array.isArray(slide.body) ? slide.body : [];
  const layoutIntent = slide.layout_intent && typeof slide.layout_intent === 'object' && !Array.isArray(slide.layout_intent)
    ? slide.layout_intent
    : (slide.layoutIntent && typeof slide.layoutIntent === 'object' && !Array.isArray(slide.layoutIntent) ? slide.layoutIntent : {});
  const role = cleanInline(slide.role || slide.type, { maxChars: 40, fallback: 'content' });
  return {
    title: cleanInline(slide.title, { maxChars: PPT_DRAFT_LIMITS.maxTitleChars, fallback: `Slide ${slide.page || ''}` }),
    claim: cleanInline(slide.claim, { maxChars: 160 }),
    bullets: body.map(item => cleanInline(item, { maxChars: PPT_DRAFT_LIMITS.maxBulletChars })).filter(Boolean).slice(0, 6),
    visual: cleanInline(slide.visual_suggestion, { maxChars: 160 }),
    note: cleanInline(slide.speaker_note, { maxChars: PPT_DRAFT_LIMITS.maxSpeakerNoteChars }),
    type: cleanInline(slide.type, { maxChars: 40, fallback: role }),
    role,
    layoutKind: cleanInline(layoutIntent.kind || layoutIntent.layout || slide.type, { maxChars: 40, fallback: role }),
    layoutDensity: cleanInline(layoutIntent.density, { maxChars: 16 }),
    layoutChart: cleanInline(layoutIntent.chart, { maxChars: 24 }),
    layoutFocus: cleanInline(layoutIntent.visual_focus || layoutIntent.visualFocus, { maxChars: 180 }),
    mediaSlots: Number.isFinite(Number(layoutIntent.media_slots || layoutIntent.mediaSlots))
      ? Math.max(0, Math.min(3, Number(layoutIntent.media_slots || layoutIntent.mediaSlots)))
      : 0
  };
}

function splitBullets(items) {
  const source = Array.isArray(items) ? items.filter(Boolean) : [];
  const midpoint = Math.ceil(source.length / 2);
  return [source.slice(0, midpoint), source.slice(midpoint)];
}

function roleLabel(role, locale = 'zh-CN') {
  const zh = locale !== 'en';
  const labels = {
    cover: { zh: '封面', en: 'Cover' },
    agenda: { zh: '目录', en: 'Agenda' },
    section: { zh: '分节', en: 'Section' },
    context: { zh: '背景', en: 'Context' },
    problem: { zh: '问题', en: 'Problem' },
    insight: { zh: '洞察', en: 'Insight' },
    evidence: { zh: '证据', en: 'Evidence' },
    comparison: { zh: '对比', en: 'Comparison' },
    workflow: { zh: '流程', en: 'Workflow' },
    roadmap: { zh: '路线图', en: 'Roadmap' },
    risk: { zh: '风险', en: 'Risk' },
    recommendation: { zh: '建议', en: 'Recommendation' },
    closing: { zh: '收尾', en: 'Closing' },
    content: { zh: '内容', en: 'Content' }
  };
  return (labels[role] || labels.content)[zh ? 'zh' : 'en'];
}

function preferredVisualIdea(slideText, outline, fallback) {
  return slideText.layoutFocus || slideText.visual || outline.design?.visual_system || fallback;
}

function posterTextureVariant(outline, fallback = 'grid') {
  const profile = resolvePptDraftSubjectProfile(outline);
  if (profile === 'interior') return 'interior';
  if (profile === 'party-government') return 'party';
  if (profile === 'literary-biography') return 'literary';
  return fallback;
}

function posterCopy(outline) {
  return resolvePptDraftSubjectCopy(outline);
}

function posterSlideIcon(slideText, outline) {
  const copy = posterCopy(outline);
  if (slideText.role === 'problem') return copy.problemIcon;
  if (slideText.role === 'recommendation') return copy.recommendationIcon;
  if (slideText.role === 'agenda' || slideText.role === 'section') return copy.sectionIcon;
  if (slideText.role === 'closing') return 'download';
  if (slideText.layoutKind === 'matrix') return 'layers';
  if (slideText.layoutKind === 'comparison') return 'arrow';
  return copy.statementIcon;
}

function posterVisualCaption(slideText, outline) {
  const copy = posterCopy(outline);
  const role = String(slideText?.role || '').toLowerCase();
  if (copy.profile === 'party-government') {
    if (role === 'problem') return 'LEARNING / REVIEW / ACTION';
    if (role === 'recommendation') return 'RECTIFICATION / OWNER / LOOP';
    if (role === 'comparison') return 'ISSUE / ACTION';
    if (role === 'closing') return 'RESPONSIBILITY / TIMELINE / REVIEW';
    if (role === 'workflow' || role === 'roadmap' || role === 'process') return 'REVIEW / ACTION / CLOSE';
    if (role === 'evidence') return 'ISSUES / RESPONSIBILITY / ACTION';
    return 'MEETING / REVIEW / ACTION';
  }
  if (copy.profile === 'literary-biography') {
    if (role === 'problem') return 'LIFE / WORKS / CHARACTER';
    if (role === 'recommendation') return 'READING / TEXT / MEMORY';
    if (role === 'comparison') return 'CONTEXT / WORKS';
    if (role === 'closing') return 'READING / NOTES / DISCUSSION';
    if (role === 'workflow' || role === 'roadmap' || role === 'process') return 'LIFE / WORKS / READING';
    if (role === 'evidence') return 'LIFE / WORKS / STYLE';
    return 'BOOK / MOOD / MEMORY';
  }
  if (copy.profile === 'interior') {
    if (role === 'problem') return 'LIGHT / STORAGE / CIRCULATION';
    if (role === 'recommendation') return 'MATERIAL / MOOD / DETAIL';
    if (role === 'comparison') return 'BEFORE / AFTER';
    if (role === 'closing') return 'CONTACT / CASE / PLAN';
    if (role === 'workflow' || role === 'roadmap' || role === 'process') return 'BRIEF / PLAN / BUILD';
    if (role === 'evidence') return 'SPACE / MATERIAL / DETAIL';
    return copy.visualCaption;
  }
  if (role === 'problem') return 'PRIVACY / RISK';
  if (role === 'recommendation') return copy.profile === 'toolknit' ? 'LOCAL FIRST / CONTROL' : copy.visualCaption;
  if (role === 'comparison') return 'BEFORE / AFTER';
  if (role === 'closing') return copy.profile === 'toolknit' ? 'DOWNLOAD / COMMUNITY' : copy.closingVisualLabel;
  if (role === 'workflow' || role === 'roadmap' || role === 'process') return 'FLOW / HANDOFF';
  if (role === 'evidence') return 'PROOF / COVERAGE';
  return copy.visualCaption;
}

function buildPill(id, text, x, y, w, theme, { colorValue = theme.accentSoft, background = theme.panel, line = theme.line, size = 11 } = {}) {
  return [
    rectShape(id, `${text} pill`, x, y, w, 0.42, background, line),
    textBox(id + 1, `${text} pill text`, x + 0.12, y + 0.08, w - 0.24, 0.18, [
      paragraph(text, { size, bold: true, colorValue, align: 'ctr' })
    ])
  ];
}

function buildTitleSlide(outline, theme) {
  const title = cleanInline(outline.title, { maxChars: 92, fallback: 'Presentation Draft' });
  const subtitle = cleanInline(outline.subtitle || outline.narrative?.central_takeaway || outline.purpose, { maxChars: 150 });
  const audience = cleanInline(outline.audience, { maxChars: 120 });
  const deckType = getPptOutlineDeckTypeLabel(outline.deck_type || outline.request?.deck_type || 'auto', outline.request?.locale || 'zh-CN');
  let id = 2;
  const shapes = [
    rectShape(id++, 'Top accent', 0.68, 0.6, 1.25, 0.08, theme.accent, theme.accent),
    textBox(id++, 'Deck title', 0.72, 1.55, 11.8, 1.8, [
      paragraph(title, { size: title.length > 28 ? 34 : 44, bold: true, colorValue: theme.text })
    ]),
    subtitle ? textBox(id++, 'Deck subtitle', 0.78, 3.08, 10.8, 0.72, [
      paragraph(subtitle, { size: 18, colorValue: theme.muted })
    ]) : '',
    ...buildPill(id++, deckType, 0.78, 5.92, 3.2, theme, { colorValue: theme.accentSoft, background: theme.panel }),
    ...buildPill(id + 1, audience || 'ToolKnit AI Draft', 4.1, 5.92, 3.2, theme, { colorValue: theme.text, background: theme.panelAlt }),
    textBox(id += 3, 'Footer', 9.6, 6.88, 2.9, 0.22, [
      paragraph('Generated by ToolKnit', { size: 8.5, colorValue: theme.muted, align: 'r' })
    ]),
  ].filter(Boolean);
  return shapes.join('');
}

function buildStandardSlide(slide, outline, theme, index, total, text) {
  const slideText = text || normalizeSlideText(slide);
  const titleSize = slideText.title.length > 36 ? 26 : 30;
  let id = 2;
  const bulletParagraphs = (slideText.bullets.length ? slideText.bullets : ['待补充更多素材']).map(item => paragraph(`• ${item}`, { size: 17, colorValue: theme.text }));
  const visualText = preferredVisualIdea(slideText, outline, '建议补充一张产品截图、流程图或关键数据图。');
  const noteText = slideText.note || slideText.claim || '讲述时围绕本页主张展开，避免补充未验证事实。';
  const roleText = `${roleLabel(slideText.role, outline.request?.locale || 'zh-CN')} · ${slideText.layoutKind || slideText.type || 'content'}`;
  const shapes = [
    textBox(id++, 'Slide number', 0.72, 0.46, 0.9, 0.28, [
      paragraph(String(index + 1).padStart(2, '0'), { size: 10.5, bold: true, colorValue: theme.accent })
    ]),
    textBox(id++, 'Slide role', 1.8, 0.5, 2.2, 0.26, [
      paragraph(roleText, { size: 9.5, colorValue: theme.accentSoft })
    ]),
    textBox(id++, 'Slide title', 0.72, 0.78, 8.1, 0.76, [
      paragraph(slideText.title, { size: titleSize, bold: true, colorValue: theme.text })
    ]),
    slideText.claim ? textBox(id++, 'Claim', 0.74, 1.62, 7.7, 0.56, [
      paragraph(slideText.claim, { size: 15, bold: true, colorValue: theme.accentSoft })
    ]) : '',
    rectShape(id++, 'Visual panel', 8.95, 0.82, 3.55, 4.35, theme.panel, theme.line),
    textBox(id++, 'Visual label', 9.2, 1.15, 3.05, 0.36, [
      paragraph('VISUAL IDEA', { size: 8.5, bold: true, colorValue: theme.accent, align: 'ctr' })
    ]),
    textBox(id++, 'Visual suggestion', 9.28, 1.72, 2.9, 1.55, [
      paragraph(visualText, { size: 14, colorValue: theme.text, align: 'ctr' })
    ], { anchor: 'ctr' }),
    rectShape(id++, 'Body panel', 0.72, 2.45, 7.8, 3.25, theme.panel, theme.line),
    textBox(id++, 'Bullets', 1.02, 2.78, 7.1, 2.6, bulletParagraphs),
    rectShape(id++, 'Speaker note panel', 8.95, 5.38, 3.55, 0.96, theme.panelAlt, theme.line),
    textBox(id++, 'Speaker note', 9.2, 5.55, 3.08, 0.55, [
      paragraph(noteText, { size: 11, colorValue: theme.text })
    ]),
    textBox(id++, 'Footer', 0.72, 6.84, 11.78, 0.24, [
      paragraph(`${cleanInline(outline.title, { maxChars: 60 })}  ·  ${index + 1}/${total}`, { size: 8.5, colorValue: theme.muted, align: 'r' })
    ])
  ].filter(Boolean);
  return shapes.join('');
}

function buildProcessSlide(slide, outline, theme, index, total, text) {
  const slideText = text || normalizeSlideText(slide);
  const titleSize = slideText.title.length > 36 ? 26 : 30;
  const steps = (slideText.bullets.length ? slideText.bullets : ['待补充更多素材']).slice(0, 5);
  const visualText = preferredVisualIdea(slideText, outline, '建议用步骤图、流程箭头或操作截图。');
  let id = 2;
  const stepPanel = rectShape(id++, 'Process panel', 0.72, 2.35, 7.9, 3.45, theme.panel, theme.line);
  const stepParagraphs = steps.map((item, stepIndex) => paragraph(`${String(stepIndex + 1).padStart(2, '0')}  ${item}`, {
    size: 16,
    bold: stepIndex === 0,
    colorValue: theme.text
  }));
  const shapes = [
    textBox(id++, 'Slide number', 0.72, 0.46, 0.9, 0.28, [
      paragraph(String(index + 1).padStart(2, '0'), { size: 10.5, bold: true, colorValue: theme.accent })
    ]),
    textBox(id++, 'Slide role', 1.8, 0.5, 2.6, 0.26, [
      paragraph(`${roleLabel(slideText.role, outline.request?.locale || 'zh-CN')} / ${slideText.layoutKind || 'process'}`, { size: 9.5, colorValue: theme.accentSoft })
    ]),
    textBox(id++, 'Slide title', 0.72, 0.78, 8.1, 0.76, [
      paragraph(slideText.title, { size: titleSize, bold: true, colorValue: theme.text })
    ]),
    slideText.claim ? textBox(id++, 'Claim', 0.74, 1.62, 7.7, 0.56, [
      paragraph(slideText.claim, { size: 15, bold: true, colorValue: theme.accentSoft })
    ]) : '',
    stepPanel,
    textBox(id++, 'Step list', 1.02, 2.74, 7.1, 2.55, stepParagraphs),
    rectShape(id++, 'Visual panel', 8.95, 0.82, 3.55, 4.35, theme.panelAlt, theme.line),
    textBox(id++, 'Visual label', 9.2, 1.15, 3.05, 0.36, [
      paragraph('PROCESS FOCUS', { size: 8.5, bold: true, colorValue: theme.accent, align: 'ctr' })
    ]),
    textBox(id++, 'Visual suggestion', 9.28, 1.72, 2.9, 1.55, [
      paragraph(visualText, { size: 14, colorValue: theme.text, align: 'ctr' })
    ], { anchor: 'ctr' }),
    rectShape(id++, 'Speaker note panel', 8.95, 5.38, 3.55, 0.96, theme.panel, theme.line),
    textBox(id++, 'Speaker note', 9.2, 5.55, 3.08, 0.55, [
      paragraph(slideText.note || '按步骤讲清楚每一步在解决什么问题。', { size: 11, colorValue: theme.text })
    ]),
    textBox(id++, 'Footer', 0.72, 6.84, 11.78, 0.24, [
      paragraph(`${cleanInline(outline.title, { maxChars: 60 })}  ·  ${index + 1}/${total}`, { size: 8.5, colorValue: theme.muted, align: 'r' })
    ])
  ].filter(Boolean);
  return shapes.join('');
}

function buildComparisonSlide(slide, outline, theme, index, total, text) {
  const slideText = text || normalizeSlideText(slide);
  const titleSize = slideText.title.length > 36 ? 26 : 30;
  const [leftBullets, rightBullets] = splitBullets(slideText.bullets.length ? slideText.bullets : ['待补充更多素材']);
  const visualText = preferredVisualIdea(slideText, outline, '建议用对比表、左右对照图或前后效果图。');
  let id = 2;
  const leftPanel = rectShape(id++, 'Comparison left', 0.72, 2.38, 3.72, 3.35, theme.panel, theme.line);
  const rightPanel = rectShape(id++, 'Comparison right', 4.58, 2.38, 3.72, 3.35, theme.panelAlt, theme.line);
  const shapes = [
    textBox(id++, 'Slide number', 0.72, 0.46, 0.9, 0.28, [
      paragraph(String(index + 1).padStart(2, '0'), { size: 10.5, bold: true, colorValue: theme.accent })
    ]),
    textBox(id++, 'Slide role', 1.8, 0.5, 2.6, 0.26, [
      paragraph(`${roleLabel(slideText.role, outline.request?.locale || 'zh-CN')} / ${slideText.layoutKind || 'comparison'}`, { size: 9.5, colorValue: theme.accentSoft })
    ]),
    textBox(id++, 'Slide title', 0.72, 0.78, 8.1, 0.76, [
      paragraph(slideText.title, { size: titleSize, bold: true, colorValue: theme.text })
    ]),
    slideText.claim ? textBox(id++, 'Claim', 0.74, 1.62, 7.7, 0.56, [
      paragraph(slideText.claim, { size: 15, bold: true, colorValue: theme.accentSoft })
    ]) : '',
    leftPanel,
    rightPanel,
    textBox(id++, 'Left bullets', 1.0, 2.72, 3.24, 2.55, (leftBullets.length ? leftBullets : ['待补充更多素材']).map(item => paragraph(`• ${item}`, { size: 16, colorValue: theme.text }))),
    textBox(id++, 'Right bullets', 4.86, 2.72, 3.24, 2.55, (rightBullets.length ? rightBullets : ['待补充更多素材']).map(item => paragraph(`• ${item}`, { size: 16, colorValue: theme.text }))),
    rectShape(id++, 'Visual panel', 8.95, 0.82, 3.55, 4.35, theme.panel, theme.line),
    textBox(id++, 'Visual label', 9.2, 1.15, 3.05, 0.36, [
      paragraph('COMPARISON FOCUS', { size: 8.5, bold: true, colorValue: theme.accent, align: 'ctr' })
    ]),
    textBox(id++, 'Visual suggestion', 9.28, 1.72, 2.9, 1.55, [
      paragraph(visualText, { size: 14, colorValue: theme.text, align: 'ctr' })
    ], { anchor: 'ctr' }),
    rectShape(id++, 'Speaker note panel', 8.95, 5.38, 3.55, 0.96, theme.panelAlt, theme.line),
    textBox(id++, 'Speaker note', 9.2, 5.55, 3.08, 0.55, [
      paragraph(slideText.note || '对比页讲清楚取舍与结论。', { size: 11, colorValue: theme.text })
    ]),
    textBox(id++, 'Footer', 0.72, 6.84, 11.78, 0.24, [
      paragraph(`${cleanInline(outline.title, { maxChars: 60 })}  ·  ${index + 1}/${total}`, { size: 8.5, colorValue: theme.muted, align: 'r' })
    ])
  ].filter(Boolean);
  return shapes.join('');
}

function buildClosingSlide(slide, outline, theme, index, total, text) {
  const slideText = text || normalizeSlideText(slide);
  const titleSize = slideText.title.length > 36 ? 26 : 30;
  const takeaway = slideText.claim || slideText.title;
  const ctaBullets = (slideText.bullets.length ? slideText.bullets : ['下一步行动', '待确认项', '联系信息']).slice(0, 3);
  const visualText = preferredVisualIdea(slideText, outline, '感谢阅读 · 可继续优化为最终 PPTX');
  let id = 2;
  const shapes = [
    rectShape(id++, 'Top accent', 0.68, 0.6, 1.25, 0.08, theme.accent, theme.accent),
    textBox(id++, 'Slide number', 0.72, 0.46, 0.9, 0.28, [
      paragraph(String(index + 1).padStart(2, '0'), { size: 10.5, bold: true, colorValue: theme.accent })
    ]),
    textBox(id++, 'Slide role', 1.8, 0.5, 2.6, 0.26, [
      paragraph(`${roleLabel(slideText.role, outline.request?.locale || 'zh-CN')} / ${slideText.layoutKind || 'closing'}`, { size: 9.5, colorValue: theme.accentSoft })
    ]),
    textBox(id++, 'Slide title', 0.72, 1.15, 11.5, 0.84, [
      paragraph(slideText.title, { size: titleSize, bold: true, colorValue: theme.text, align: 'ctr' })
    ]),
    textBox(id++, 'Claim', 0.92, 2.42, 11.1, 0.72, [
      paragraph(takeaway, { size: 18, bold: true, colorValue: theme.accentSoft, align: 'ctr' })
    ]),
    rectShape(id++, 'CTA panel', 2.0, 3.6, 9.35, 1.72, theme.panel, theme.line),
    textBox(id++, 'CTA bullets', 2.32, 3.92, 8.7, 1.05, ctaBullets.map(item => paragraph(`• ${item}`, { size: 16, colorValue: theme.text, align: 'ctr' }))),
    rectShape(id++, 'Footer pill', 4.45, 5.72, 4.45, 0.42, theme.panelAlt, theme.line),
    textBox(id++, 'Footer note', 4.68, 5.82, 4.0, 0.18, [
      paragraph(visualText, { size: 11, bold: true, colorValue: theme.accentSoft, align: 'ctr' })
    ]),
    textBox(id++, 'Footer', 0.72, 6.84, 11.78, 0.24, [
      paragraph(`${cleanInline(outline.title, { maxChars: 60 })}  ·  ${index + 1}/${total}`, { size: 8.5, colorValue: theme.muted, align: 'r' })
    ])
  ].filter(Boolean);
  return shapes.join('');
}

function buildContentSlide(slide, outline, theme, index, total) {
  const text = normalizeSlideText(slide);
  if (text.role === 'agenda' || text.role === 'section') return buildSectionSlide(slide, outline, theme, index, total, text);
  if (text.role === 'closing') return buildClosingSlide(slide, outline, theme, index, total, text);
  if (['workflow', 'roadmap', 'process'].includes(text.role) || ['process', 'timeline'].includes(text.layoutKind)) return buildProcessSlide(slide, outline, theme, index, total, text);
  if (text.role === 'comparison' || text.layoutKind === 'comparison') return buildComparisonSlide(slide, outline, theme, index, total, text);
  return buildStandardSlide(slide, outline, theme, index, total, text);
}

function buildSectionSlide(slide, outline, theme, index, total, text) {
  const slideText = text || normalizeSlideText(slide);
  const titleSize = slideText.title.length > 36 ? 26 : 30;
  const bullets = slideText.bullets.length ? slideText.bullets : ['待补充更多素材'];
  const visualText = preferredVisualIdea(slideText, outline, '这一页可以作为章节分隔或目录页。');
  let id = 2;
  const shapes = [
    rectShape(id++, 'Top accent', 0.68, 0.6, 1.25, 0.08, theme.accent, theme.accent),
    textBox(id++, 'Slide number', 0.72, 0.46, 0.9, 0.28, [
      paragraph(String(index + 1).padStart(2, '0'), { size: 10.5, bold: true, colorValue: theme.accent })
    ]),
    textBox(id++, 'Slide role', 1.8, 0.5, 3.2, 0.26, [
      paragraph(`${roleLabel(slideText.role, outline.request?.locale || 'zh-CN')} / ${slideText.layoutKind || 'section'}`, { size: 9.5, colorValue: theme.accentSoft })
    ]),
    textBox(id++, 'Slide title', 0.72, 1.18, 6.6, 1.22, [
      paragraph(slideText.title, { size: titleSize, bold: true, colorValue: theme.text })
    ]),
    slideText.claim ? textBox(id++, 'Claim', 0.76, 2.7, 5.9, 0.66, [
      paragraph(slideText.claim, { size: 16, colorValue: theme.accentSoft })
    ]) : '',
    rectShape(id++, 'Agenda panel', 8.05, 1.08, 4.4, 4.45, theme.panel, theme.line),
    textBox(id++, 'Agenda bullets', 8.34, 1.42, 3.8, 3.55, bullets.slice(0, 4).map((item, bulletIndex) => paragraph(`${String(bulletIndex + 1).padStart(2, '0')}  ${item}`, { size: 16, colorValue: theme.text }))),
    textBox(id++, 'Visual note', 8.38, 5.16, 3.72, 0.3, [
      paragraph(visualText, { size: 10.5, colorValue: theme.muted, align: 'ctr' })
    ]),
    textBox(id++, 'Footer', 0.72, 6.84, 11.78, 0.24, [
      paragraph(`${cleanInline(outline.title, { maxChars: 60 })}  ·  ${index + 1}/${total}`, { size: 8.5, colorValue: theme.muted, align: 'r' })
    ])
  ].filter(Boolean);
  return shapes.join('');
}

// Poster-oriented rendering layer. The outline contract stays unchanged; only
// the composition changes. Every builder draws texture first, then geometry,
// media, and finally text so decorative elements never cover content.
function posterFooter(id, outline, theme, index, total) {
  const copy = posterCopy(outline);
  const brand = cleanInline(outline.title, { maxChars: 34, fallback: copy.footerFallback }).split(/[：:]/)[0].trim();
  return [
    lineShape(id++, 'Footer rule', 0.72, 6.72, 12.58, 6.72, theme.line, 0.7),
    textBox(id++, 'Footer brand', 0.72, 6.82, 4.4, 0.22, [paragraph(brand || copy.footerFallback, { size: 8.5, colorValue: theme.muted })]),
    textBox(id++, 'Footer page', 11.55, 6.82, 1.05, 0.22, [paragraph(`${String(index + 1).padStart(2, '0')} / ${String(total).padStart(2, '0')}`, { size: 8.5, colorValue: theme.muted, align: 'r' })])
  ];
}

function posterRoleLine(id, slideText, outline, theme, x = 0.78, y = 0.48) {
  const role = roleLabel(slideText.role, outline.request?.locale || 'zh-CN').toUpperCase();
  const kind = slideText.layoutKind || slideText.type || 'content';
  return [
    textBox(id++, 'Slide number', x, y, 0.54, 0.24, [paragraph(String(slideText.page || '').padStart(2, '0'), { size: 10, bold: true, colorValue: theme.accent })]),
    textBox(id++, 'Slide role', x + 0.78, y + 0.01, 3.5, 0.22, [paragraph(`${role}  /  ${kind}`, { size: 8.8, bold: true, colorValue: theme.accentSoft })])
  ];
}

function posterMediaWanted(slideText, { always = false } = {}) {
  if (always || slideText.mediaSlots > 0) return true;
  return /image|screenshot|photo|visual|图像|截图|照片|素材|二维码/i.test(`${slideText.visual} ${slideText.layoutFocus}`);
}

// Keep the full claim in the outline, but use a compact display line in the
// dense matrix layout. This prevents a Latin acronym from being split across
// lines by PowerPoint while keeping the visible message scannable.
function posterMatrixClaim(value) {
  const source = cleanInline(value);
  if (/一个工具箱.*PDF.*图片.*音视频.*AI/i.test(source)) {
    return 'PDF、图片、音视频与 AI，全部本地处理。';
  }
  return source;
}

// Process nodes are intentionally short labels. The source wording remains in
// the outline/notes, while the slide gets one clear phrase per node.
function posterProcessStep(value) {
  const source = cleanInline(value);
  const normalized = source.replace(/\s+/g, '');
  if (/图片提取.*文本提取.*压缩/i.test(normalized)) return '图文提取 / 压缩';
  if (/大纲.*草稿.*PPTX/i.test(normalized)) return '生成大纲 / PPTX';
  if (/转PDF.*转图片/i.test(normalized)) return '导出 PDF / 图片';
  return source;
}

function posterMediaSlot(ctx, id, {
  x,
  y,
  w,
  format = 'landscape',
  theme,
  label = '替换为你的图片',
  caption = '',
  slideIndex = ctx.slideIndex || 1,
  placeholderIndex = 1,
  accent = theme.accent
} = {}) {
  const mediaFormat = getPosterMediaFormat(format);
  const frame = {
    x: Number(x),
    y: Number(y),
    w: Number(w),
    h: derivePosterMediaHeight(w, mediaFormat),
    format: mediaFormat.id,
    aspectRatio: mediaFormat.aspectRatio,
    aspectRatioLabel: mediaFormat.aspectRatioLabel
  };
  const parts = [
    imagePlaceholder(ctx, id++, 'Editable image placeholder', frame.x, frame.y, frame.w, frame.h, theme, label, slideIndex, placeholderIndex, mediaFormat.id),
    lineShape(id++, 'Media top rule', frame.x + 0.18, frame.y + 0.18, frame.x + 1.15, frame.y + 0.18, accent, 1.7),
    lineShape(id++, 'Media corner rule', frame.x + frame.w - 0.78, frame.y + frame.h - 0.18, frame.x + frame.w - 0.18, frame.y + frame.h - 0.18, theme.warm, 1.2)
  ];
  if (caption) {
    parts.push(textBox(id++, 'Media caption', frame.x, frame.y + frame.h + 0.12, frame.w, 0.3, fitTextParagraphs(caption, {
      width: frame.w,
      height: 0.3,
      size: 10,
      minSize: 8.5,
      maxLines: 1,
      colorValue: theme.muted,
      align: 'r'
    })));
  }
  return { parts, nextId: id, frame };
}

function posterMetric(id, value, label, x, y, w, theme, { colorValue = theme.accent } = {}) {
  return [
    textBox(id++, 'Metric value', x, y, w, 0.78, fitTextParagraphs(value, {
      width: w,
      height: 0.78,
      size: 48,
      minSize: 32,
      maxLines: 1,
      bold: true,
      colorValue
    })),
    textBox(id++, 'Metric label', x + 0.04, y + 0.78, w - 0.08, 0.3, fitTextParagraphs(label, {
      width: w - 0.08,
      height: 0.3,
      size: 11,
      minSize: 9,
      maxLines: 1,
      bold: true,
      colorValue: theme.accentSoft
    }))
  ];
}

function posterCornerBrackets(id, x, y, w, h, theme, { length = 0.32, colorValue = theme.warm } = {}) {
  return [
    lineShape(id++, 'Corner TL horizontal', x, y, x + length, y, colorValue, 1.4),
    lineShape(id++, 'Corner TL vertical', x, y, x, y + length, colorValue, 1.4),
    lineShape(id++, 'Corner TR horizontal', x + w - length, y, x + w, y, colorValue, 1.4),
    lineShape(id++, 'Corner TR vertical', x + w, y, x + w, y + length, colorValue, 1.4),
    lineShape(id++, 'Corner BL horizontal', x, y + h, x + length, y + h, colorValue, 1.4),
    lineShape(id++, 'Corner BL vertical', x, y + h - length, x, y + h, colorValue, 1.4),
    lineShape(id++, 'Corner BR horizontal', x + w - length, y + h, x + w, y + h, colorValue, 1.4),
    lineShape(id++, 'Corner BR vertical', x + w, y + h - length, x + w, y + h, colorValue, 1.4)
  ];
}

function buildPosterCover(outline, theme, ctx) {
  const copy = posterCopy(outline);
  const title = cleanInline(outline.title, { maxChars: 96, fallback: copy.footerFallback });
  const { brand, main } = splitPptDraftDeckTitle(title, outline, copy.profile);
  const subtitle = cleanInline(outline.subtitle || outline.narrative?.central_takeaway || outline.purpose, { maxChars: 128 });
  let id = 2;
  const parts = [texturePicture(ctx, id++, theme, posterTextureVariant(outline, 'orbit'))];
  parts.push(
    polygonShape(id++, 'Cover accent block', 'parallelogram', 10.05, 0, 3.283333, 7.5, theme.accent, theme.accent, '16000'),
    lineShape(id++, 'Cover diagonal line', 8.2, 6.95, 12.85, 0.3, theme.warm, 1.35),
    ellipseShape(id++, 'Cover orbit outer', 8.05, 0.95, 4.7, 4.7, 'none', theme.accent, 1.05),
    ellipseShape(id++, 'Cover orbit inner', 8.55, 1.45, 3.7, 3.7, 'none', theme.warm, 0.75),
    ellipseShape(id++, 'Cover orbit node', 11.52, 2.38, 0.12, 0.12, theme.warm, theme.warm)
  );
  const media = posterMediaSlot(ctx, id, {
    x: 9.78,
    y: 1.2,
    w: 2.2,
    format: 'portrait',
    theme,
    label: copy.coverImageLabel,
    caption: '',
    slideIndex: 1,
    placeholderIndex: 1,
    accent: theme.accent
  });
  parts.push(...media.parts);
  id = media.nextId;
  parts.push(...posterCornerBrackets(id, media.frame.x, media.frame.y, media.frame.w, media.frame.h, theme, { colorValue: theme.warm }));
  id += 8;
  const coverIcons = Array.isArray(copy.coverIcons) && copy.coverIcons.length ? copy.coverIcons.slice(0, 3) : ['document', 'image', 'spark'];
  parts.push(
    iconPicture(ctx, id++, 'Cover icon 1', 8.58, 5.34, 0.52, 0.52, coverIcons[0], theme, theme.accent),
    iconPicture(ctx, id++, 'Cover icon 2', 9.4, 5.34, 0.52, 0.52, coverIcons[1], theme, theme.accent),
    iconPicture(ctx, id++, 'Cover icon 3', 10.22, 5.34, 0.52, 0.52, coverIcons[2], theme, theme.warm),
    textBox(id++, 'Cover visual tag', 10.94, 5.43, 1.45, 0.24, fitTextParagraphs(copy.coverVisualTag, { width: 1.45, height: 0.24, size: 8.5, minSize: 7.5, maxLines: 1, bold: true, colorValue: theme.text, align: 'r' }))
  );
  parts.push(
    textBox(id++, 'Cover eyebrow', 0.78, 0.72, 6.3, 0.26, [paragraph(copy.coverEyebrow, { size: 10, bold: true, colorValue: theme.accentSoft })]),
    textBox(id++, 'Cover brand', 0.78, 1.34, 6.6, 0.52, fitTextParagraphs(brand, { width: 6.6, height: 0.52, size: 24, minSize: 18, maxLines: 1, bold: true, colorValue: theme.accent })),
    textBox(id++, 'Deck title', 0.78, 1.98, 6.95, 1.75, fitTextParagraphs(main, { width: 6.95, height: 1.75, size: main.length > 34 ? 37 : 43, minSize: 28, maxLines: 2, bold: true, colorValue: theme.text })),
    subtitle ? textBox(id++, 'Deck subtitle', 0.82, 4.02, 6.45, 0.78, fitTextParagraphs(subtitle, { width: 6.45, height: 0.78, size: 16, minSize: 12, maxLines: 2, colorValue: theme.muted })) : '',
    lineShape(id++, 'Cover meta rule', 0.82, 5.18, 4.2, 5.18, theme.accent, 1.8),
    textBox(id++, 'Cover meta', 0.82, 5.36, 6.85, 0.32, fitTextParagraphs(copy.coverMetaItems.filter(Boolean).join('  ·  '), { width: 6.85, height: 0.32, size: 11.5, minSize: 9, maxLines: 1, bold: true, colorValue: theme.text })),
    textBox(id++, 'Cover audience', 0.82, 5.82, 6.85, 0.32, fitTextParagraphs(cleanInline(outline.audience, { maxChars: 72 }), { width: 6.85, height: 0.32, size: 10.5, minSize: 8.5, maxLines: 1, colorValue: theme.muted }))
  );
  parts.push(
    ...posterFooter(id, outline, theme, 0, outline.slides?.length || 1)
  );
  return parts.join('');
}

function buildPosterStatement(slide, outline, theme, index, total, text, ctx) {
  const slideText = text || normalizeSlideText(slide);
  const copy = posterCopy(outline);
  const visualText = preferredVisualIdea(slideText, outline, copy.visualCaption);
  const icon = posterSlideIcon(slideText, outline);
  const wantImage = posterMediaWanted(slideText, { always: slideText.mediaSlots > 0 });
  let id = 2;
  const parts = [texturePicture(ctx, id++, theme, posterTextureVariant(outline, 'grid'))];
  parts.push(
    textBox(id++, 'Giant page mark', 10.85, 0.35, 1.75, 0.8, [paragraph(String(index + 1).padStart(2, '0'), { size: 50, bold: true, colorValue: theme.panelAlt, align: 'r' })]),
    lineShape(id++, 'Statement rail', 0.82, 1.14, 0.82, 6.12, theme.accent, 1.8),
    ...posterRoleLine(id, { ...slideText, page: index + 1 }, outline, theme, 1.1, 0.5)
  );
  id += 2;
  parts.push(
    textBox(id++, 'Statement title', 1.12, 1.36, 6.45, 1.45, fitTextParagraphs(slideText.title, { width: 6.45, height: 1.45, size: slideText.title.length > 28 ? 34 : 39, minSize: 26, maxLines: 2, bold: true, colorValue: theme.text })),
    slideText.claim ? textBox(id++, 'Statement claim', 1.14, 3.02, 6.2, 0.72, fitTextParagraphs(slideText.claim, { width: 6.2, height: 0.72, size: 18, minSize: 13, maxLines: 2, bold: true, colorValue: theme.accentSoft })) : '',
    lineShape(id++, 'Statement underline', 1.14, 4.02, 4.4, 4.02, theme.warm, 1.8)
  );
  const bullets = slideText.bullets.length ? slideText.bullets.slice(0, 3) : ['本地处理', '离线可用', '可审查、可掌控'];
  parts.push(rectShape(id++, 'Statement bullet panel', 0.82, 4.18, 6.75, 1.68, theme.surface, theme.line, '76000'));
  parts.push(...fitBulletParagraphs(bullets, theme, { width: 6.25, height: 1.5, size: 15.5, minSize: 12, maxItems: 3, maxLines: 1 }).map((xml, idx) => {
    const y = 4.42 + idx * 0.44;
    return `${rectShape(id++, `Statement bullet ${idx + 1}`, 1.12, y + 0.04, 0.12, 0.12, theme.accent, theme.accent)}${textBox(id++, `Statement bullet text ${idx + 1}`, 1.38, y, 6.08, 0.32, [xml])}`;
  }));
  if (wantImage) {
    const media = posterMediaSlot(ctx, id, { x: 7.98, y: 1.6, w: 4.32, format: 'landscape', theme, label: slideText.visual || slideText.layoutFocus || copy.statementImageLabel, caption: '', slideIndex: index + 1, placeholderIndex: 1, accent: theme.accent });
    parts.push(...media.parts);
    id = media.nextId;
    parts.push(...posterCornerBrackets(id, media.frame.x, media.frame.y, media.frame.w, media.frame.h, theme, { colorValue: theme.warm }));
    id += 8;
    parts.push(iconPicture(ctx, id++, 'Statement overlay icon', 11.1, 1.68, 0.62, 0.62, icon, theme, theme.warm));
  } else {
    parts.push(
      ellipseShape(id++, 'Statement icon halo', 8.2, 1.38, 3.7, 3.7, 'none', theme.line, 1),
      ellipseShape(id++, 'Statement icon ring', 8.68, 1.86, 2.74, 2.74, 'none', theme.accent, 1.4),
      iconPicture(ctx, id++, 'Statement icon', 9.48, 2.66, 1.15, 1.15, icon, theme, theme.warm),
      textBox(id++, 'Statement visual caption', 8.12, 5.12, 3.9, 0.4, fitTextParagraphs(visualText, { width: 3.9, height: 0.4, size: 11, minSize: 8.5, maxLines: 1, bold: true, colorValue: theme.muted, align: 'ctr' }))
    );
  }
  parts.push(...posterFooter(id, outline, theme, index, total));
  return parts.join('');
}

function buildPosterProblem(slide, outline, theme, index, total, text, ctx) {
  const slideText = text || normalizeSlideText(slide);
  const copy = posterCopy(outline);
  const bullets = slideText.bullets.length ? slideText.bullets.slice(0, 3) : copy.defaultProblemBullets;
  let id = 2;
  const parts = [texturePicture(ctx, id++, theme, posterTextureVariant(outline, 'grid'))];
  parts.push(
    polygonShape(id++, 'Problem danger field', 'parallelogram', 10.1, 0, 3.233333, 7.5, theme.danger, theme.danger, '11000'),
    textBox(id++, 'Problem page mark', 10.92, 0.35, 1.58, 0.78, [paragraph(String(index + 1).padStart(2, '0'), { size: 50, bold: true, colorValue: theme.panelAlt, align: 'r' })]),
    ...posterRoleLine(id, { ...slideText, page: index + 1 }, outline, theme, 0.82, 0.5)
  );
  id += 2;
  parts.push(
    textBox(id++, 'Problem eyebrow', 0.82, 1.08, 5.8, 0.24, [paragraph(copy.problemEyebrow, { size: 9.5, bold: true, colorValue: theme.danger })]),
    textBox(id++, 'Problem title', 0.82, 1.46, 6.5, 1.42, fitTextParagraphs(slideText.title, { width: 6.5, height: 1.42, size: slideText.title.length > 28 ? 34 : 39, minSize: 26, maxLines: 2, bold: true, colorValue: theme.text })),
    slideText.claim ? textBox(id++, 'Problem claim', 0.86, 3.1, 6.05, 0.64, fitTextParagraphs(slideText.claim, { width: 6.05, height: 0.64, size: 18, minSize: 13, maxLines: 2, bold: true, colorValue: theme.accentSoft })) : '',
    lineShape(id++, 'Problem divider', 0.86, 4.0, 4.45, 4.0, theme.danger, 1.8),
    ellipseShape(id++, 'Problem halo outer', 7.85, 0.98, 4.3, 4.3, 'none', theme.danger, 1.15),
    ellipseShape(id++, 'Problem halo inner', 8.6, 1.73, 2.8, 2.8, 'none', theme.warm, 0.85),
    iconPicture(ctx, id++, 'Problem icon', 9.36, 2.49, 1.25, 1.25, copy.problemIcon, theme, theme.danger),
    lineShape(id++, 'Problem alert rule', 8.42, 4.02, 11.54, 4.02, theme.danger, 1.25),
    textBox(id++, 'Problem alert label', 8.43, 4.1, 3.0, 0.18, [paragraph(copy.problemAlertLabel, { size: 8.2, bold: true, colorValue: theme.danger, align: 'ctr' })])
  );
  bullets.forEach((item, bulletIndex) => {
    const y = 4.34 + bulletIndex * 0.45;
    parts.push(
      ellipseShape(id++, `Problem bullet ${bulletIndex + 1}`, 0.88, y + 0.06, 0.1, 0.1, theme.danger, theme.danger),
      textBox(id++, `Problem bullet text ${bulletIndex + 1}`, 1.16, y, 6.05, 0.34, fitTextParagraphs(item, { width: 6.05, height: 0.34, size: 15.5, minSize: 11.5, maxLines: 1, colorValue: theme.text }))
    );
  });
  const media = posterMediaSlot(ctx, id, {
    x: 8.55,
    y: 4.35,
    w: 3.5,
    format: 'landscape',
    theme,
    label: slideText.visual || slideText.layoutFocus || copy.problemImageLabel,
    caption: '',
    slideIndex: index + 1,
    placeholderIndex: 1,
    accent: theme.danger
  });
  parts.push(...media.parts);
  id = media.nextId;
  parts.push(...posterCornerBrackets(id, media.frame.x, media.frame.y, media.frame.w, media.frame.h, theme, { colorValue: theme.danger }));
  id += 8;
  parts.push(...posterFooter(id, outline, theme, index, total));
  return parts.join('');
}

function buildPosterLocalFirst(slide, outline, theme, index, total, text, ctx) {
  const slideText = text || normalizeSlideText(slide);
  const copy = posterCopy(outline);
  const bullets = slideText.bullets.length ? slideText.bullets.slice(0, 3) : copy.defaultRecommendationBullets;
  let id = 2;
  const parts = [texturePicture(ctx, id++, theme, posterTextureVariant(outline, 'weave'))];
  parts.push(
    textBox(id++, 'Local page mark', 10.9, 0.35, 1.62, 0.78, [paragraph(String(index + 1).padStart(2, '0'), { size: 50, bold: true, colorValue: theme.panelAlt, align: 'r' })]),
    ...posterRoleLine(id, { ...slideText, page: index + 1 }, outline, theme, 0.82, 0.5)
  );
  id += 2;
  parts.push(
    textBox(id++, 'Local eyebrow', 0.82, 1.08, 5.8, 0.24, [paragraph(copy.recommendationEyebrow, { size: 9.5, bold: true, colorValue: theme.success })]),
    textBox(id++, 'Local title', 0.82, 1.46, 6.5, 1.42, fitTextParagraphs(slideText.title, { width: 6.5, height: 1.42, size: slideText.title.length > 28 ? 34 : 39, minSize: 26, maxLines: 2, bold: true, colorValue: theme.text })),
    slideText.claim ? textBox(id++, 'Local claim', 0.86, 3.1, 6.05, 0.64, fitTextParagraphs(slideText.claim, { width: 6.05, height: 0.64, size: 18, minSize: 13, maxLines: 2, bold: true, colorValue: theme.accentSoft })) : '',
    lineShape(id++, 'Local divider', 0.86, 4.0, 4.45, 4.0, theme.success, 1.8),
    lineShape(id++, 'Local node link top-left', 8.65, 1.85, 9.95, 2.78, theme.line, 1.15),
    lineShape(id++, 'Local node link top-right', 11.5, 1.96, 10.5, 2.78, theme.line, 1.15),
    lineShape(id++, 'Local node link bottom-right', 11.28, 3.8, 10.48, 3.46, theme.line, 1.15),
    ellipseShape(id++, 'Local core halo outer', 9.24, 2.02, 2.02, 2.02, 'none', theme.success, 1.2),
    ellipseShape(id++, 'Local core halo inner', 9.63, 2.41, 1.24, 1.24, theme.surface, theme.accent, 1),
    iconPicture(ctx, id++, 'Local desktop icon', 9.92, 2.7, 0.66, 0.66, copy.recommendationIcon, theme, theme.success),
    iconPicture(ctx, id++, 'Local lock node', 8.33, 1.34, 0.68, 0.68, copy.coverIcons?.[0] || 'check', theme, theme.success),
    iconPicture(ctx, id++, 'Local layers node', 11.27, 1.46, 0.68, 0.68, copy.coverIcons?.[1] || 'layers', theme, theme.warm),
    iconPicture(ctx, id++, 'Local cloud node', 11.04, 3.54, 0.68, 0.68, copy.coverIcons?.[2] || 'spark', theme, theme.success),
    textBox(id++, 'Local core label', 9.22, 4.06, 2.05, 0.18, fitTextParagraphs(posterVisualCaption(slideText, outline), { width: 2.05, height: 0.18, size: 8.6, minSize: 7.2, maxLines: 1, bold: true, colorValue: theme.success, align: 'ctr' }))
  );
  bullets.forEach((item, bulletIndex) => {
    const y = 4.34 + bulletIndex * 0.45;
    parts.push(
      ellipseShape(id++, `Local bullet ${bulletIndex + 1}`, 0.88, y + 0.06, 0.1, 0.1, theme.success, theme.success),
      textBox(id++, `Local bullet text ${bulletIndex + 1}`, 1.16, y, 6.05, 0.34, fitTextParagraphs(item, { width: 6.05, height: 0.34, size: 15.5, minSize: 11.5, maxLines: 1, colorValue: theme.text }))
    );
  });
  const media = posterMediaSlot(ctx, id, {
    x: 8.55,
    y: 4.34,
    w: 3.5,
    format: 'landscape',
    theme,
    label: slideText.visual || slideText.layoutFocus || copy.statementImageLabel,
    caption: '',
    slideIndex: index + 1,
    placeholderIndex: 1,
    accent: theme.success
  });
  parts.push(...media.parts);
  id = media.nextId;
  parts.push(...posterCornerBrackets(id, media.frame.x, media.frame.y, media.frame.w, media.frame.h, theme, { colorValue: theme.success }));
  id += 8;
  parts.push(...posterFooter(id, outline, theme, index, total));
  return parts.join('');
}

function buildPosterOpenSource(slide, outline, theme, index, total, text, ctx) {
  const slideText = text || normalizeSlideText(slide);
  const bullets = slideText.bullets.length ? slideText.bullets.slice(0, 3) : ['免费使用，商业友好', '完全开源，可审查、可修改', '社区驱动，持续进化'];
  let id = 2;
  const parts = [texturePicture(ctx, id++, theme, 'orbit')];
  parts.push(
    polygonShape(id++, 'Open source accent field', 'parallelogram', 10.3, 0, 3.033333, 7.5, theme.accent, theme.accent, '9000'),
    textBox(id++, 'Open source page mark', 10.92, 0.35, 1.58, 0.78, [paragraph(String(index + 1).padStart(2, '0'), { size: 50, bold: true, colorValue: theme.panelAlt, align: 'r' })]),
    ...posterRoleLine(id, { ...slideText, page: index + 1 }, outline, theme, 0.82, 0.5)
  );
  id += 2;
  parts.push(
    textBox(id++, 'Open source eyebrow', 0.82, 1.08, 5.8, 0.24, [paragraph('OPEN LICENSE / SHIP WHAT YOU NEED', { size: 9.5, bold: true, colorValue: theme.accentSoft })]),
    textBox(id++, 'Open source title', 0.82, 1.46, 6.5, 1.42, fitTextParagraphs(slideText.title, { width: 6.5, height: 1.42, size: slideText.title.length > 28 ? 34 : 39, minSize: 26, maxLines: 2, bold: true, colorValue: theme.text })),
    slideText.claim ? textBox(id++, 'Open source claim', 0.86, 3.1, 6.05, 0.64, fitTextParagraphs(slideText.claim, { width: 6.05, height: 0.64, size: 18, minSize: 13, maxLines: 2, bold: true, colorValue: theme.accentSoft })) : '',
    lineShape(id++, 'Open source divider', 0.86, 4.0, 4.45, 4.0, theme.warm, 1.8),
    textBox(id++, 'Open source MIT mark', 8.15, 1.2, 3.85, 1.12, fitTextParagraphs('MIT', { width: 3.85, height: 1.12, size: 66, minSize: 46, maxLines: 1, bold: true, colorValue: theme.accent, align: 'ctr' })),
    lineShape(id++, 'Open source MIT rule', 8.24, 2.5, 11.95, 2.5, theme.accent, 1.2),
    iconPicture(ctx, id++, 'Open source shield icon', 8.42, 2.8, 0.74, 0.74, 'openSource', theme, theme.success),
    iconPicture(ctx, id++, 'Open source check icon', 10.2, 2.8, 0.74, 0.74, 'check', theme, theme.warm),
    iconPicture(ctx, id++, 'Open source extend icon', 11.46, 2.8, 0.74, 0.74, 'layers', theme, theme.accent),
    textBox(id++, 'Open source free label', 8.06, 3.62, 1.45, 0.22, [paragraph('FREE TO USE', { size: 8.5, bold: true, colorValue: theme.text, align: 'ctr' })]),
    textBox(id++, 'Open source audit label', 9.84, 3.62, 1.45, 0.22, [paragraph('AUDITABLE', { size: 8.5, bold: true, colorValue: theme.text, align: 'ctr' })]),
    textBox(id++, 'Open source build label', 11.18, 3.62, 1.3, 0.22, [paragraph('EXTEND', { size: 8.5, bold: true, colorValue: theme.text, align: 'ctr' })])
  );
  bullets.forEach((item, bulletIndex) => {
    const y = 4.34 + bulletIndex * 0.45;
    parts.push(
      lineShape(id++, `Open source bullet rule ${bulletIndex + 1}`, 0.88, y + 0.18, 1.12, y + 0.18, bulletIndex === 0 ? theme.accent : theme.line, 1.1),
      textBox(id++, `Open source bullet text ${bulletIndex + 1}`, 1.38, y, 6.0, 0.34, fitTextParagraphs(item, { width: 6.0, height: 0.34, size: 15.5, minSize: 11.5, maxLines: 1, colorValue: theme.text }))
    );
  });
  const media = posterMediaSlot(ctx, id, {
    x: 8.1,
    y: 4.26,
    w: 4.08,
    format: 'landscape',
    theme,
    label: slideText.visual || slideText.layoutFocus || '替换为 GitHub 仓库或代码截图',
    caption: '',
    slideIndex: index + 1,
    placeholderIndex: 1,
    accent: theme.accent
  });
  parts.push(...media.parts);
  id = media.nextId;
  parts.push(...posterCornerBrackets(id, media.frame.x, media.frame.y, media.frame.w, media.frame.h, theme, { colorValue: theme.warm }));
  id += 8;
  parts.push(...posterFooter(id, outline, theme, index, total));
  return parts.join('');
}

function buildPosterMatrix(slide, outline, theme, index, total, text, ctx) {
  const slideText = text || normalizeSlideText(slide);
  const copy = posterCopy(outline);
  const labels = slideText.bullets.length
    ? slideText.bullets.slice(0, 6)
    : (
      copy.profile === 'interior'
        ? ['客厅动线', '餐厨关系', '主卧舒适度', '次卧弹性', '阳台利用', '材质统一']
        : copy.profile === 'party-government'
          ? ['理论学习', '问题查摆', '原因剖析', '整改措施', '责任分工', '跟踪复盘']
          : copy.profile === 'literary-biography'
            ? ['人物生平', '时代背景', '代表作品', '散文风格', '人格气节', '阅读启发']
            : ['PDF 与文档', '图片处理', '音视频', 'AI 文档', 'AI 表格', '开发者工具']
    );
  const icons = copy.profile === 'interior'
    ? ['home', 'palette', 'ruler', 'image', 'layers', 'brush']
    : copy.profile === 'party-government'
      ? ['flag', 'checklist', 'meeting', 'document', 'shield', 'table']
      : copy.profile === 'literary-biography'
        ? ['portrait', 'book', 'moon', 'leaf', 'pen', 'document']
        : ['pdf', 'image', 'video', 'document', 'table', 'palette'];
  let id = 2;
  const parts = [texturePicture(ctx, id++, theme, posterTextureVariant(outline, 'grid'))];
  parts.push(...posterRoleLine(id, { ...slideText, page: index + 1 }, outline, theme, 0.78, 0.5));
  id += 2;
  parts.push(
    textBox(id++, 'Matrix title', 0.8, 1.1, 5.7, 1.18, fitTextParagraphs(slideText.title, { width: 5.7, height: 1.18, size: 29, minSize: 22, maxLines: 2, bold: true, colorValue: theme.text })),
    textBox(id++, 'Matrix claim', 0.82, 2.18, 5.35, 0.72, fitTextParagraphs(posterMatrixClaim(slideText.claim || '一个入口，覆盖工作流的高频环节。'), { width: 5.35, height: 0.72, size: 16, minSize: 12, maxLines: 2, colorValue: theme.muted })),
    ...posterMetric(id, copy.matrixMetricValue, copy.matrixMetricLabel, 0.82, 3.08, 4.2, theme)
  );
  id += 2;
  parts.push(
    lineShape(id++, 'Matrix rule', 0.82, 4.64, 5.65, 4.64, theme.line, 1),
    textBox(id++, 'Matrix principle', 0.86, 4.86, 5.2, 0.52, fitTextParagraphs(copy.matrixPrinciple, { width: 5.2, height: 0.52, size: 14, minSize: 11, maxLines: 2, colorValue: theme.accentSoft }))
  );
  const gridX = [6.58, 8.56, 10.54];
  const gridY = [1.55, 3.82];
  labels.forEach((label, itemIndex) => {
    const x = gridX[itemIndex % 3];
    const y = gridY[Math.floor(itemIndex / 3)];
    parts.push(rectShape(id++, `Tool cell ${itemIndex + 1}`, x, y, 1.16, 1.16, theme.surface, theme.line));
    parts.push(iconPicture(ctx, id++, `Tool icon ${itemIndex + 1}`, x + 0.25, y + 0.25, 0.66, 0.66, icons[itemIndex], theme, itemIndex % 2 ? theme.warm : theme.accent));
    parts.push(textBox(id++, `Tool label ${itemIndex + 1}`, x - 0.32, y + 1.28, 1.8, 0.54, fitTextParagraphs(label, { width: 1.8, height: 0.54, size: 12.5, minSize: 9, maxLines: 2, bold: true, colorValue: theme.text, align: 'ctr' })));
  });
  parts.push(lineShape(id++, 'Matrix right rule', 6.58, 5.84, 12.08, 5.84, theme.accent, 0.8));
  parts.push(textBox(id++, 'Matrix note', 6.58, 6.0, 5.4, 0.3, fitTextParagraphs(copy.matrixNote, { width: 5.4, height: 0.3, size: 11, minSize: 8.5, maxLines: 1, colorValue: theme.muted, align: 'r' })));
  parts.push(...posterFooter(id, outline, theme, index, total));
  return parts.join('');
}

function buildPosterProcess(slide, outline, theme, index, total, text, ctx) {
  const slideText = text || normalizeSlideText(slide);
  const copy = posterCopy(outline);
  const steps = (slideText.bullets.length
    ? slideText.bullets
    : (
      copy.profile === 'interior'
        ? ['需求沟通', '空间规划', '材质定调', '深化落地']
        : copy.profile === 'party-government'
          ? ['会前准备', '理论学习', '问题查摆', '整改落实']
          : copy.profile === 'literary-biography'
            ? ['生平脉络', '代表作品', '文本风格', '阅读启发']
            : ['导入文件', '选择工具', '本地处理', '导出结果']
    ))
    .slice(0, 5)
    .map(posterProcessStep);
  let id = 2;
  const parts = [texturePicture(ctx, id++, theme, posterTextureVariant(outline, 'weave'))];
  parts.push(...posterRoleLine(id, { ...slideText, page: index + 1 }, outline, theme, 0.78, 0.5));
  id += 2;
  parts.push(
    textBox(id++, 'Process title', 0.8, 1.1, 9.6, 0.94, fitTextParagraphs(slideText.title, { width: 9.6, height: 0.94, size: 34, minSize: 25, maxLines: 2, bold: true, colorValue: theme.text })),
    slideText.claim ? textBox(id++, 'Process claim', 0.84, 2.02, 8.8, 0.46, fitTextParagraphs(slideText.claim, { width: 8.8, height: 0.46, size: 15.5, minSize: 11, maxLines: 1, bold: true, colorValue: theme.accentSoft })) : ''
  );
  const railY = 3.52;
  const startX = 1.05;
  const endX = 11.98;
  // Draw the connector first; nodes and labels stay on top in every renderer.
  parts.push(lineShape(id++, 'Process rail', startX, railY, endX, railY, theme.line, 1.8));
  const stepGap = steps.length > 1 ? (endX - startX) / (steps.length - 1) : 0;
  steps.forEach((step, stepIndex) => {
    const x = startX + stepGap * stepIndex;
    if (stepIndex < steps.length - 1) parts.push(iconPicture(ctx, id++, `Process arrow ${stepIndex + 1}`, x + 0.46, railY - 0.12, 0.34, 0.34, 'arrow', theme, theme.warm));
    parts.push(rectShape(id++, `Process node ${stepIndex + 1}`, x - 0.18, railY - 0.18, 0.36, 0.36, stepIndex === 0 ? theme.accent : theme.surface, stepIndex === 0 ? theme.accent : theme.accentSoft));
    parts.push(textBox(id++, `Process number ${stepIndex + 1}`, x - 0.3, railY - 0.8, 0.6, 0.25, [paragraph(String(stepIndex + 1).padStart(2, '0'), { size: 9.5, bold: true, colorValue: stepIndex === 0 ? theme.accent : theme.accentSoft, align: 'ctr' })]));
    // Keep the first label fully on-canvas while preserving the centered rail layout.
    const labelX = Math.max(0, x - 1.06);
    parts.push(textBox(id++, `Process step ${stepIndex + 1}`, labelX, railY + 0.38, 2.12, 0.82, fitTextParagraphs(step, { width: 2.12, height: 0.82, size: 12, minSize: 9, maxLines: 2, bold: stepIndex === 0, colorValue: theme.text, align: 'ctr' })));
  });
  parts.push(
    lineShape(id++, 'Process accent slash', 0.92, 5.34, 3.2, 5.34, theme.warm, 1.8),
    textBox(id++, 'Process note', 0.94, 5.56, 6.6, 0.58, fitTextParagraphs(slideText.claim || '从导入到导出，一条链路完成。', { width: 6.6, height: 0.58, size: 14, minSize: 10, maxLines: 2, colorValue: theme.muted }))
  );
  if (posterMediaWanted(slideText)) {
    const media = posterMediaSlot(ctx, id, { x: 8.38, y: 4.55, w: 3.5, format: 'landscape', theme, label: slideText.visual || slideText.layoutFocus || copy.processImageLabel, caption: '', slideIndex: index + 1, placeholderIndex: 1, accent: theme.accent });
    parts.push(...media.parts);
    id = media.nextId;
    parts.push(...posterCornerBrackets(id, media.frame.x, media.frame.y, media.frame.w, media.frame.h, theme, { colorValue: theme.warm }));
    id += 8;
  }
  parts.push(...posterFooter(id, outline, theme, index, total));
  return parts.join('');
}

function buildPosterComparison(slide, outline, theme, index, total, text, ctx) {
  const slideText = text || normalizeSlideText(slide);
  const copy = posterCopy(outline);
  const defaultBullets = copy.profile === 'interior'
    ? ['原始动线不顺', '收纳暴露', '材质关系松散', '动线更流畅', '收纳更隐形', '氛围更统一']
    : copy.profile === 'party-government'
      ? ['问题表现', '整改措施', '责任分工', '阶段成效', '持续复盘', '闭环推进']
      : copy.profile === 'literary-biography'
        ? ['生活经历', '时代背景', '情感表达', '作品影响', '文本细读', '阅读启发']
    : ['分散工具', '需要上传', '流程割裂', '本地统一', '文件不离开设备', '一步完成'];
  const [leftBullets, rightBullets] = splitBullets(slideText.bullets.length ? slideText.bullets : defaultBullets);
  let id = 2;
  const parts = [texturePicture(ctx, id++, theme, posterTextureVariant(outline, 'orbit'))];
  parts.push(...posterRoleLine(id, { ...slideText, page: index + 1 }, outline, theme, 0.78, 0.5));
  id += 2;
  parts.push(
    textBox(id++, 'Comparison title', 0.8, 1.08, 10.8, 0.88, fitTextParagraphs(slideText.title, { width: 10.8, height: 0.88, size: 33, minSize: 25, maxLines: 2, bold: true, colorValue: theme.text })),
    slideText.claim ? textBox(id++, 'Comparison claim', 0.84, 1.94, 10.4, 0.42, fitTextParagraphs(slideText.claim, { width: 10.4, height: 0.42, size: 14.5, minSize: 10, maxLines: 1, colorValue: theme.muted })) : '',
    lineShape(id++, 'Comparison axis', 6.66, 2.62, 6.66, 6.0, theme.line, 1),
    polygonShape(id++, 'Comparison left accent', 'parallelogram', 0.88, 2.48, 0.1, 0.5, theme.warm, theme.warm),
    polygonShape(id++, 'Comparison right accent', 'parallelogram', 6.92, 2.48, 0.1, 0.5, theme.accent, theme.accent),
    textBox(id++, 'Comparison left label', 1.12, 2.48, 4.8, 0.36, fitTextParagraphs(copy.comparisonLeftLabel, { width: 4.8, height: 0.36, size: 19, minSize: 14, maxLines: 1, bold: true, colorValue: theme.warm })),
    textBox(id++, 'Comparison right label', 7.18, 2.48, 4.8, 0.36, fitTextParagraphs(copy.comparisonRightLabel, { width: 4.8, height: 0.36, size: 19, minSize: 14, maxLines: 1, bold: true, colorValue: theme.accent })),
    iconPicture(ctx, id++, 'Comparison arrow', 6.28, 2.56, 0.74, 0.32, 'arrow', theme, theme.warm)
  );
  const comparisonMediaWidth = 4.56;
  const comparisonMediaHeight = derivePosterMediaHeight(comparisonMediaWidth, POSTER_MEDIA_FORMATS.landscape);
  if (posterMediaWanted(slideText)) {
    const leftMedia = posterMediaSlot(ctx, id, { x: 1.12, y: 2.98, w: comparisonMediaWidth, format: 'landscape', theme: { ...theme, accent: theme.warm }, label: copy.comparisonBeforeLabel, caption: '', slideIndex: index + 1, placeholderIndex: 1, accent: theme.warm });
    parts.push(...leftMedia.parts);
    id = leftMedia.nextId;
    parts.push(...posterCornerBrackets(id, leftMedia.frame.x, leftMedia.frame.y, leftMedia.frame.w, leftMedia.frame.h, theme, { colorValue: theme.warm }));
    id += 8;
    const rightMedia = posterMediaSlot(ctx, id, { x: 7.18, y: 2.98, w: comparisonMediaWidth, format: 'landscape', theme, label: copy.comparisonAfterLabel, caption: '', slideIndex: index + 1, placeholderIndex: 2, accent: theme.accent });
    parts.push(...rightMedia.parts);
    id = rightMedia.nextId;
    parts.push(...posterCornerBrackets(id, rightMedia.frame.x, rightMedia.frame.y, rightMedia.frame.w, rightMedia.frame.h, theme, { colorValue: theme.accent }));
    id += 8;
  } else {
    parts.push(rectShape(id++, 'Comparison left field', 1.12, 2.98, comparisonMediaWidth, comparisonMediaHeight, theme.surface, theme.line, '48000'));
    parts.push(rectShape(id++, 'Comparison right field', 7.18, 2.98, comparisonMediaWidth, comparisonMediaHeight, theme.surface, theme.line, '48000'));
  }
  leftBullets.slice(0, 3).forEach((item, bulletIndex) => {
    const y = 5.84 + bulletIndex * 0.32;
    parts.push(ellipseShape(id++, `Comparison left mark ${bulletIndex + 1}`, 1.16, y + 0.07, 0.11, 0.11, theme.warm, theme.warm));
    parts.push(textBox(id++, `Comparison left text ${bulletIndex + 1}`, 1.42, y, 4.42, 0.25, fitTextParagraphs(item, { width: 4.42, height: 0.25, size: 12, minSize: 9.5, maxLines: 1, colorValue: theme.text })));
  });
  rightBullets.slice(0, 3).forEach((item, bulletIndex) => {
    const y = 5.84 + bulletIndex * 0.32;
    parts.push(ellipseShape(id++, `Comparison right mark ${bulletIndex + 1}`, 7.22, y + 0.07, 0.11, 0.11, theme.accent, theme.accent));
    parts.push(textBox(id++, `Comparison right text ${bulletIndex + 1}`, 7.48, y, 4.42, 0.25, fitTextParagraphs(item, { width: 4.42, height: 0.25, size: 12, minSize: 9.5, maxLines: 1, colorValue: theme.text })));
  });
  parts.push(...posterFooter(id, outline, theme, index, total));
  return parts.join('');
}

function buildPosterTriad(slide, outline, theme, index, total, text, ctx) {
  const slideText = text || normalizeSlideText(slide);
  const labels = (slideText.bullets.length ? slideText.bullets : ['桌面端：图形化操作', 'CLI：脚本化自动化', 'Agent / MCP：AI 驱动集成']).slice(0, 3);
  const icons = ['toolbox', 'terminal', 'agent'];
  const xs = [1.05, 5.28, 9.5];
  let id = 2;
  const parts = [texturePicture(ctx, id++, theme, 'orbit')];
  parts.push(...posterRoleLine(id, { ...slideText, page: index + 1 }, outline, theme, 0.78, 0.5));
  id += 2;
  parts.push(
    textBox(id++, 'Triad title', 0.8, 1.08, 11.0, 1.14, fitTextParagraphs(slideText.title, { width: 11.0, height: 1.14, size: 34, minSize: 25, maxLines: 2, bold: true, colorValue: theme.text })),
    slideText.claim ? textBox(id++, 'Triad claim', 0.84, 2.35, 9.6, 0.44, fitTextParagraphs(slideText.claim, { width: 9.6, height: 0.44, size: 15, minSize: 11, maxLines: 1, colorValue: theme.muted })) : ''
  );
  // Connectors are emitted before nodes so they stay behind the icon rings.
  xs.forEach((x, nodeIndex) => {
    const centerX = x + 0.74;
    const nodeY = 4.32;
    parts.push(lineShape(id++, `Triad connector ${nodeIndex + 1}`, centerX, nodeY + 0.55, 6.65, 3.58, nodeIndex === 1 ? theme.warm : theme.line, 1.2));
  });
  parts.push(
    ellipseShape(id++, 'Triad core halo', 6.1, 3.08, 1.1, 1.1, theme.surface, theme.accent, 1.1),
    iconPicture(ctx, id++, 'Triad core icon', 6.36, 3.34, 0.58, 0.58, 'layers', theme, theme.warm),
    textBox(id++, 'Triad core label', 5.38, 4.28, 2.55, 0.22, fitTextParagraphs('ONE CORE', { width: 2.55, height: 0.22, size: 9.5, minSize: 8, maxLines: 1, bold: true, colorValue: theme.accentSoft, align: 'ctr' }))
  );
  xs.forEach((x, nodeIndex) => {
    const nodeY = 4.32;
    parts.push(ellipseShape(id++, `Triad node halo ${nodeIndex + 1}`, x, nodeY, 1.12, 1.12, theme.surface, theme.line, 0.8));
    parts.push(iconPicture(ctx, id++, `Triad node icon ${nodeIndex + 1}`, x + 0.22, nodeY + 0.22, 0.68, 0.68, icons[nodeIndex], theme, nodeIndex === 1 ? theme.warm : theme.accent));
    parts.push(textBox(id++, `Triad label ${nodeIndex + 1}`, x - 0.64, 5.58, 2.4, 0.66, fitTextParagraphs(labels[nodeIndex], { width: 2.4, height: 0.66, size: 13, minSize: 9.5, maxLines: 2, bold: true, colorValue: theme.text, align: 'ctr' })));
  });
  parts.push(
    lineShape(id++, 'Triad bottom rule', 1.05, 6.38, 12.1, 6.38, theme.warm, 1.2),
    ...posterFooter(id, outline, theme, index, total)
  );
  return parts.join('');
}

function buildPosterSection(slide, outline, theme, index, total, text, ctx) {
  const slideText = text || normalizeSlideText(slide);
  const copy = posterCopy(outline);
  const bullets = slideText.bullets.length
    ? slideText.bullets.slice(0, 4)
    : (copy.profile === 'interior' ? ['空间现状', '设计策略', '材质与细节', '落地沟通'] : ['先理解问题', '再看解决方案', '最后开始行动']);
  let id = 2;
  const parts = [texturePicture(ctx, id++, theme, posterTextureVariant(outline, 'orbit'))];
  parts.push(
    textBox(id++, 'Section number', 0.78, 0.82, 2.2, 0.95, [paragraph(String(index + 1).padStart(2, '0'), { size: 58, bold: true, colorValue: theme.accent })]),
    rectShape(id++, 'Section bar', 0.84, 2.04, 2.36, 0.1, theme.accent, theme.accent),
    textBox(id++, 'Section title', 0.8, 2.36, 6.65, 1.48, fitTextParagraphs(slideText.title, { width: 6.65, height: 1.48, size: 40, minSize: 28, maxLines: 2, bold: true, colorValue: theme.text })),
    slideText.claim ? textBox(id++, 'Section claim', 0.84, 4.08, 5.9, 0.7, fitTextParagraphs(slideText.claim, { width: 5.9, height: 0.7, size: 17, minSize: 12, maxLines: 2, colorValue: theme.muted })) : '',
    ellipseShape(id++, 'Section halo', 8.35, 1.22, 3.5, 3.5, 'none', theme.line, 1),
    ellipseShape(id++, 'Section inner halo', 8.82, 1.69, 2.56, 2.56, 'none', theme.accent, 1.1),
    iconPicture(ctx, id++, 'Section icon', 9.52, 2.42, 1.16, 1.16, slideText.role === 'agenda' ? copy.sectionIcon : posterSlideIcon(slideText, outline), theme, theme.warm),
    textBox(id++, 'Section visual label', 8.42, 4.94, 3.34, 0.34, fitTextParagraphs(posterVisualCaption(slideText, outline), { width: 3.34, height: 0.34, size: 10.5, minSize: 8.5, maxLines: 1, bold: true, colorValue: theme.accentSoft, align: 'ctr' }))
  );
  bullets.forEach((item, bulletIndex) => {
    const y = 1.18 + bulletIndex * 0.74;
    parts.push(lineShape(id++, `Section item rule ${bulletIndex + 1}`, 8.05, y + 0.23, 8.6, y + 0.23, bulletIndex === 0 ? theme.accent : theme.line, 1.1));
    parts.push(textBox(id++, `Section item ${bulletIndex + 1}`, 8.78, y, 3.42, 0.5, fitTextParagraphs(item, { width: 3.42, height: 0.5, size: 14, minSize: 10, maxLines: 2, colorValue: theme.text, prefix: `${String(bulletIndex + 1).padStart(2, '0')}  ` })));
  });
  parts.push(...posterFooter(id, outline, theme, index, total));
  return parts.join('');
}

function buildPosterClosing(slide, outline, theme, index, total, text, ctx) {
  const slideText = text || normalizeSlideText(slide);
  const copy = posterCopy(outline);
  const actions = (slideText.bullets.length ? slideText.bullets : copy.defaultClosingActions).slice(0, 3);
  const actionLabel = outline.request?.locale === 'en' ? 'ACTION POINTS' : '行动要点';
  let id = 2;
  const parts = [texturePicture(ctx, id++, theme, posterTextureVariant(outline, 'weave'))];
  parts.push(
    polygonShape(id++, 'Closing accent block', 'parallelogram', 10.1, 0, 3.233333, 7.5, theme.accent, theme.accent, '14000'),
    lineShape(id++, 'Closing slash', 8.55, 6.58, 12.78, 0.42, theme.warm, 1.7),
    textBox(id++, 'Closing eyebrow', 0.82, 0.78, 5.4, 0.26, [paragraph(copy.closingEyebrow, { size: 10, bold: true, colorValue: theme.accentSoft })]),
    textBox(id++, 'Closing title', 0.82, 1.42, 7.45, 1.62, fitTextParagraphs(slideText.title, { width: 7.45, height: 1.62, size: 40, minSize: 28, maxLines: 2, bold: true, colorValue: theme.text })),
    textBox(id++, 'Closing claim', 0.86, 3.3, 6.9, 0.72, fitTextParagraphs(slideText.claim || (copy.profile === 'interior' ? '把设计方向、空间体验与落地沟通收束到同一张图里。' : '把重点收束成下一步可执行的行动。'), { width: 6.9, height: 0.72, size: 18.5, minSize: 13, maxLines: 2, bold: true, colorValue: theme.accentSoft })),
    ellipseShape(id++, 'Closing ring outer', 9.05, 1.26, 3.15, 3.15, 'none', theme.accent, 1.3),
    ellipseShape(id++, 'Closing ring inner', 9.52, 1.73, 2.2, 2.2, 'none', theme.warm, 0.9),
    iconPicture(ctx, id++, 'Closing icon', 10.18, 2.4, 0.9, 0.9, copy.profile === 'interior' ? 'home' : 'download', theme, theme.warm),
    textBox(id++, 'Closing visual label', 9.14, 4.12, 3.0, 0.28, fitTextParagraphs(copy.closingVisualLabel, { width: 3.0, height: 0.28, size: 9.5, minSize: 8, maxLines: 1, bold: true, colorValue: theme.accentSoft, align: 'ctr' })),
    rectShape(id++, 'Closing action panel', 0.86, 4.26, 6.86, 1.66, theme.panel, theme.line, '76000'),
    textBox(id++, 'Closing action label', 1.18, 4.43, 2.6, 0.2, fitTextParagraphs(actionLabel, { width: 2.6, height: 0.2, size: 8.6, minSize: 7.5, maxLines: 1, bold: true, colorValue: theme.accentSoft }))
  );
  actions.forEach((action, actionIndex) => {
    const y = 4.72 + actionIndex * 0.34;
    parts.push(ellipseShape(id++, `Closing action mark ${actionIndex + 1}`, 1.18, y + 0.08, 0.1, 0.1, actionIndex === 0 ? theme.accent : theme.warm, actionIndex === 0 ? theme.accent : theme.warm));
    parts.push(textBox(id++, `Closing action ${actionIndex + 1}`, 1.44, y, 5.82, 0.28, fitTextParagraphs(action, { width: 5.82, height: 0.28, size: 13.3, minSize: 9.8, maxLines: 1, colorValue: theme.text })));
  });
  const media = posterMediaSlot(ctx, id, { x: 8.75, y: 4.52, w: 3.4, format: 'landscape', theme, label: slideText.visual || slideText.layoutFocus || copy.closingImageLabel, caption: '', slideIndex: index + 1, placeholderIndex: 1, accent: theme.accent });
  parts.push(...media.parts);
  id = media.nextId;
  parts.push(...posterCornerBrackets(id, media.frame.x, media.frame.y, media.frame.w, media.frame.h, theme, { colorValue: theme.warm }));
  id += 8;
  parts.push(...posterFooter(id, outline, theme, index, total));
  return parts.join('');
}

export async function buildPptDraftPptx(outlineValue, options = {}) {
  return buildPptDraftPptxExport(outlineValue, options, {
    PPT_DRAFT_LIMITS,
    normalizePptDraftOutline,
    resolvePptDraftThemeTokens,
    createSlideAssetContext,
    buildPosterCover,
    normalizeSlideText,
    posterCopy,
    buildPosterSection,
    buildPosterClosing,
    buildPosterProblem,
    buildPosterLocalFirst,
    buildPosterComparison,
    buildPosterProcess,
    buildPosterMatrix,
    buildPosterOpenSource,
    buildPosterTriad,
    buildPosterStatement,
    cleanInline,
    textBox,
    paragraph,
    fitTextParagraphs,
    fail
  });
}

export function createPptDraftMarkdown(outline) {
  return createPptOutlineMarkdown(outline).replace(/^# /, '# PPTX 草稿大纲 / ');
}

export function createPptDraftManifest({ outline, theme, outputFile, outputBytes, outputs = [] }) {
  return {
    schema: 'toolknit.ppt-draft',
    version: 1,
    deck_type: outline.deck_type || outline.request?.deck_type || 'auto',
    title: outline.title,
    slide_count: outline.slides?.length || 0,
    theme,
    output_file: outputFile || 'draft.pptx',
    output_bytes: outputBytes || 0,
    image_placeholders: outline.image_placeholders || [],
    outputs,
    request: {
      slide_count: outline.request?.slide_count,
      locale: outline.request?.locale,
      deck_type: outline.request?.deck_type,
      theme,
      prompt_characters: outline.request?.prompt?.length || 0,
      audience_characters: outline.request?.audience?.length || 0,
      purpose_characters: outline.request?.purpose?.length || 0
    },
    quality_check: outline.quality_check || {}
  };
}
