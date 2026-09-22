import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { analyzePptxText } from '../src/ppt-text-extract-core.js';
import {
  buildPptDraftPptx,
  createPptDraftManifest,
  inferPptDraftTheme,
  normalizePptDraftOutline,
  normalizePptDraftRequest,
  normalizePptDraftAssets,
  resolvePptDraftSubjectCopy,
  resolvePptDraftSubjectProfile,
  sanitizePptDraftBaseName
} from '../src/ppt-draft-core.js';

function outlinePayload(slides = 5) {
  return {
    ready: true,
    title: 'ToolKnit PPTX 草稿测试',
    subtitle: '可编辑演示文件',
    audience: '开源用户',
    purpose: '验证 PPTX 本地生成',
    narrative: {
      communication_job: 'By the end, users should trust local PPTX generation.',
      arc: 'Context -> proof -> action',
      central_takeaway: 'ToolKnit can generate editable PPTX drafts locally.'
    },
    design: {
      style: '极简科技',
      visual_system: '大标题、少文字、固定视觉建议区',
      color_hint: '黑白蓝',
      font_hint: 'Microsoft YaHei'
    },
    slides: Array.from({ length: slides }, (_, index) => ({
      page: index + 1,
      type: index === 0 ? 'title' : (index + 1 === slides ? 'closing' : 'content'),
      title: `第 ${index + 1} 页标题`,
      claim: `第 ${index + 1} 页主张`,
      body: [`要点 ${index + 1}-1`, `要点 ${index + 1}-2`, `要点 ${index + 1}-3`],
      visual_suggestion: '放置产品截图或流程示意',
      speaker_note: '讲述时聚焦本页主张',
      transition: '自然进入下一页',
      data_needed: []
    })),
    quality_check: {
      missing_info: ['真实截图待补充'],
      risks: ['避免编造指标'],
      next_steps: ['进入人工美化']
    }
  };
}

function assertImagePlaceholderAspectRatios(placeholders, label) {
  assert.ok(Array.isArray(placeholders), `${label} must expose image placeholders`);
  assert.ok(placeholders.length > 0, `${label} should contain at least one image placeholder`);
  for (const placeholder of placeholders) {
    assert.ok(['16:9', '9:16'].includes(placeholder.aspect_ratio), `${label} placeholder ${placeholder.name} must declare 16:9 or 9:16`);
    const [ratioWidth, ratioHeight] = placeholder.aspect_ratio.split(':').map(Number);
    const actualRatio = Number(placeholder.width) / Number(placeholder.height);
    const expectedRatio = ratioWidth / ratioHeight;
    const relativeError = Math.abs(actualRatio - expectedRatio) / expectedRatio;
    assert.ok(Number.isFinite(actualRatio), `${label} placeholder ${placeholder.name} must have a finite aspect ratio`);
    assert.ok(relativeError <= 0.015, `${label} placeholder ${placeholder.name} dimensions must match ${placeholder.aspect_ratio}`);
  }
}

assert.equal(sanitizePptDraftBaseName('..\\demo:name.pptx'), 'demo_name');
assert.equal(normalizePptDraftRequest({ prompt: '测试', slide_count: 4, theme: 'tech-blue', deck_type: 'product-launch' }).theme, 'tech-blue');
assert.equal(normalizePptDraftRequest({ prompt: '测试', slide_count: 4, theme: 'tech-blue', deck_type: 'product-launch' }).deck_type, 'product-launch');
assert.equal(inferPptDraftTheme({ style: '极简风 白色 留白 暖灰' }), 'minimal-mono');
assert.equal(normalizePptDraftRequest({ prompt: '测试', slide_count: 4, style: '黑白极简' }).theme, 'minimal-mono');
assert.equal(normalizePptDraftRequest({ prompt: '测试', slide_count: 4, style: '浅色白色空间留白' }).theme, 'minimal-light');
assert.equal(normalizePptDraftRequest({ prompt: '测试', slide_count: 4, theme: 'purple' }).theme, 'minimal-mono');

const outline = normalizePptDraftOutline(outlinePayload(5), { prompt: '测试', slide_count: 5, theme: 'minimal-dark', deck_type: 'product-launch' });
assert.equal(outline.slides.length, 5);
assert.equal(outline.request.theme, 'minimal-dark');
assert.equal(outline.request.deck_type, 'product-launch');

const importedLightOutline = normalizePptDraftOutline({
  ...outlinePayload(5),
  request: {
    prompt: '导入大纲主题继承测试',
    slide_count: 5,
    deck_type: 'product-launch',
    theme: 'minimal-light',
    style: '浅色白色空间留白'
  }
}, { slide_count: 5 });
assert.equal(importedLightOutline.request.prompt, '导入大纲主题继承测试');
assert.equal(importedLightOutline.request.theme, 'minimal-light');
const importedLightDraft = await buildPptDraftPptx(importedLightOutline);
assert.equal(importedLightDraft.theme, 'minimal-light');

const warmInteriorOutline = normalizePptDraftOutline({
  ...outlinePayload(5),
  title: '室内装修设计案例',
  design: {
    style: '浅色奶油风、木色、暖灰、空间留白',
    visual_system: '家居空间感，温暖柔和，少量线条装饰',
    color_hint: '奶油白、木色、暖灰'
  }
}, { prompt: '装修案例', slide_count: 5 });
assert.equal(warmInteriorOutline.request.theme, 'minimal-light');
const warmInteriorDraft = await buildPptDraftPptx(warmInteriorOutline);
assert.equal(warmInteriorDraft.theme, 'minimal-light');
const warmInteriorZip = await JSZip.loadAsync(warmInteriorDraft.bytes);
const warmInteriorThemeXml = await warmInteriorZip.file('ppt/theme/theme1.xml').async('string');
assert.match(warmInteriorThemeXml, /Minimal Light/);
assert.doesNotMatch(warmInteriorThemeXml, /A9784B/, 'interior subject must not leak hue into the monochrome template');
assert.equal(resolvePptDraftSubjectProfile(warmInteriorOutline), 'interior');
assert.equal(resolvePptDraftSubjectCopy(warmInteriorOutline).matrixMetricValue, '全屋');

const interiorCaseOutline = normalizePptDraftOutline({
  ready: true,
  title: '河南乙梵装饰 商水县晴园6-1-503 装修设计案例',
  subtitle: '客厅、餐厅、厨房、主卧、南次卧、北次卧、阳台的整体设计沟通',
  audience: '装修业主、设计客户、短视频观众',
  purpose: '展示装修设计案例，突出设计审美、空间规划能力和落地价值',
  narrative: {
    communication_job: 'By the end, 业主 should understand the case because each space has a clear design role.',
    arc: '项目背景 -> 空间问题 -> 设计策略 -> 分区呈现 -> 沟通行动',
    central_takeaway: '全屋空间通过动线、收纳和材质形成统一居住体验。'
  },
  design: {
    style: '浅色简洁、奶油风、木色、暖灰、空间留白',
    visual_system: '每页一个主视觉占位，搭配细线、留白和空间编号',
    color_hint: '奶油白、木色、暖灰',
    font_hint: '干净无衬线'
  },
  slides: [
    { page: 1, role: 'cover', title: '河南乙梵装饰：晴园 6-1-503 设计案例', claim: '以温暖克制的空间语言完成全屋表达。', body: ['案例定位', '空间清单'], visual_suggestion: '客厅效果图，9:16 竖版封面主视觉', layout_intent: { kind: 'title', density: 'low', media_slots: 1 } },
    { page: 2, role: 'problem', title: '空间需要先被重新梳理', claim: '动线、收纳和采光决定业主的第一体验。', body: ['动线要顺', '收纳要隐形', '光线要柔和'], visual_suggestion: '户型图或现场痛点图，16:9 横版', layout_intent: { kind: 'image-text', density: 'low', media_slots: 1 } },
    { page: 3, role: 'evidence', title: '七个区域各有重点', claim: '每个空间都承担不同生活场景。', body: ['客厅会客', '餐厨联动', '主卧休息', '南次卧弹性', '北次卧收纳', '阳台休闲'], visual_suggestion: '空间分区图标墙', layout_intent: { kind: 'matrix', density: 'medium', media_slots: 0 } },
    { page: 4, role: 'workflow', title: '从风格到落地保持同一条线', claim: '先定空间主线，再细化材质与施工沟通。', body: ['需求沟通', '空间规划', '材质定调', '深化落地'], visual_suggestion: '设计流程或材质板，16:9 横版', layout_intent: { kind: 'process', density: 'medium', media_slots: 1 } },
    { page: 5, role: 'closing', title: '进入下一轮深化沟通', claim: '把方向确认、素材替换和预算深化放到下一步。', body: ['确认设计方向', '替换真实素材', '进入深化沟通'], visual_suggestion: '联系二维码或案例合集，16:9 横版', layout_intent: { kind: 'closing', density: 'low', media_slots: 1 } }
  ]
}, { prompt: '河南乙梵装饰 商水县晴园6-1-503 装修设计案例 客厅 餐厅 厨房 主卧 南次卧 北次卧 阳台', slide_count: 5, style: '浅色简洁 白色 奶油风 木色 暖灰 空间留白' });
assert.equal(resolvePptDraftSubjectProfile(interiorCaseOutline), 'interior');
assert.equal(resolvePptDraftSubjectCopy(interiorCaseOutline).matrixMetricValue, '7区');
const interiorCaseDraft = await buildPptDraftPptx(interiorCaseOutline);
const interiorCaseZip = await JSZip.loadAsync(interiorCaseDraft.bytes);
const interiorCoverXml = await interiorCaseZip.file('ppt/slides/slide1.xml').async('string');
const interiorProblemXml = await interiorCaseZip.file('ppt/slides/slide2.xml').async('string');
const interiorMatrixXml = await interiorCaseZip.file('ppt/slides/slide3.xml').async('string');
assert.match(interiorCoverXml, /INTERIOR CASE/);
assert.match(interiorCoverXml, /替换为空间效果图或实景图/);
assert.match(interiorProblemXml, /SPACE PAIN POINT/);
assert.match(interiorMatrixXml, /7区/);
assert.doesNotMatch(interiorCoverXml, /TOOLKNIT\s+\/\s+OPEN SOURCE RELEASE|LOCAL \/ EDITABLE|20\+ 工具|替换为产品首屏截图/);

const partyOutline = normalizePptDraftOutline({
  ready: true,
  title: '党组织会议汇报',
  subtitle: '围绕理论学习、问题查摆和整改闭环展开',
  audience: '支部党员与会议参会人员',
  purpose: '用于会议汇报和整改推进',
  narrative: {
    communication_job: 'By the end, 支部党员 should understand the meeting focus because the issues and actions are clearly connected.',
    arc: '会议背景 -> 问题查摆 -> 整改闭环 -> 下一步安排',
    central_takeaway: '把查摆问题、责任分工和整改措施连成闭环。'
  },
  design: {
    style: '红色政务风 白底 金色点缀 会议纪要感',
    visual_system: '红金抽象纹理、会议笔记、责任清单与闭环流程',
    color_hint: '红色、金色、白底',
    font_hint: '清晰无衬线'
  },
  slides: [
    { page: 1, role: 'cover', title: '党组织会议汇报', claim: '围绕会议主题、问题查摆和整改闭环展开。', body: ['理论学习', '整改推进'], visual_suggestion: '会议现场或学习笔记图，9:16 竖版主视觉', layout_intent: { kind: 'title', density: 'low', media_slots: 1 } },
    { page: 2, role: 'problem', title: '先把问题摆清楚', claim: '围绕学习、联系群众和作风建设进行查摆。', body: ['理论学习还需更紧', '联系群众还需更深', '整改措施需要落细'], visual_suggestion: '问题清单或会议纪要图，16:9 横版', layout_intent: { kind: 'image-text', density: 'low', media_slots: 1 } },
    { page: 3, role: 'evidence', title: '把责任和措施连成闭环', claim: '每个问题都对应责任人、时间表和复盘节点。', body: ['责任分工', '整改台账', '跟踪复盘'], visual_suggestion: '责任矩阵或整改台账图，16:9 横版', layout_intent: { kind: 'matrix', density: 'medium', media_slots: 0 } },
    { page: 4, role: 'workflow', title: '整改按步骤推进', claim: '会前准备、理论学习、问题查摆、整改落实。', body: ['会前准备', '理论学习', '问题查摆', '整改落实'], visual_suggestion: '整改流程图，16:9 横版', layout_intent: { kind: 'process', density: 'medium', media_slots: 1 } },
    { page: 5, role: 'closing', title: '确认下一步安排', claim: '把行动清单落到时间表里。', body: ['确认整改清单', '压实责任分工', '跟踪复盘成效'], visual_suggestion: '会议纪要或责任清单图，16:9 横版', layout_intent: { kind: 'closing', density: 'low', media_slots: 1 } }
  ]
}, { prompt: '党组织会议汇报', slide_count: 5, style: '红色政务风 白底 金色点缀 会议纪要感' });
assert.equal(resolvePptDraftSubjectProfile(partyOutline), 'party-government');
assert.equal(resolvePptDraftSubjectCopy(partyOutline).matrixMetricValue, '闭环');
const partyDraft = await buildPptDraftPptx(partyOutline);
const partyZip = await JSZip.loadAsync(partyDraft.bytes);
const partyThemeXml = await partyZip.file('ppt/theme/theme1.xml').async('string');
const partyCoverXml = await partyZip.file('ppt/slides/slide1.xml').async('string');
const partyMatrixXml = await partyZip.file('ppt/slides/slide3.xml').async('string');
assert.match(partyThemeXml, /Minimal Light/);
assert.doesNotMatch(partyThemeXml, /B11F24/, 'party-government subject must not leak red into the monochrome template');
assert.match(partyCoverXml, /专题会议/);
assert.match(partyCoverXml, /PARTY MEETING/);
assert.match(partyMatrixXml, /理论学习|问题查摆|整改措施/);

const literaryOutline = normalizePptDraftOutline({
  ready: true,
  title: '朱自清人物介绍',
  subtitle: '从生平脉络到作品风格的阅读理解',
  audience: '语文教师与学生',
  purpose: '用于课堂讲解和人物品读',
  narrative: {
    communication_job: 'By the end, students should understand Zhu Ziqing because his life, works and character can be read together.',
    arc: '生平脉络 -> 代表作品 -> 文本风格 -> 阅读启发',
    central_takeaway: '把生平、作品和精神气质放在同一条阅读线索里。'
  },
  design: {
    style: '浅色文艺风 米白纸张 淡墨绿 暖灰',
    visual_system: '纸张纹理、书页、书写笔迹、月色与树影',
    color_hint: '米白、淡墨绿、暖灰',
    font_hint: '清晰、克制、适合阅读'
  },
  slides: [
    { page: 1, role: 'cover', title: '朱自清人物介绍', claim: '从生平、作品和精神气质理解这位作家。', body: ['人物生平', '代表作品'], visual_suggestion: '人物照片或书页意象图，9:16 竖版主视觉', layout_intent: { kind: 'title', density: 'low', media_slots: 1 } },
    { page: 2, role: 'problem', title: '先读懂他的时代背景', claim: '生平经历和时代环境决定了作品气质。', body: ['时代背景需要理解', '作品情感需要细读', '人格气节需要联系文本'], visual_suggestion: '时代背景或课堂提问图，16:9 横版', layout_intent: { kind: 'image-text', density: 'low', media_slots: 1 } },
    { page: 3, role: 'evidence', title: '代表作品构成了他的文学坐标', claim: '背影、荷塘月色和春都适合做课堂入口。', body: ['背影', '荷塘月色', '春'], visual_suggestion: '作品书页或作品名墙，16:9 横版', layout_intent: { kind: 'matrix', density: 'medium', media_slots: 0 } },
    { page: 4, role: 'workflow', title: '按阅读路径梳理人物理解', claim: '生平脉络、代表作品、文本风格、阅读启发。', body: ['生平脉络', '代表作品', '文本风格', '阅读启发'], visual_suggestion: '阅读路径或时间线图，16:9 横版', layout_intent: { kind: 'process', density: 'medium', media_slots: 1 } },
    { page: 5, role: 'closing', title: '把理解带回文本细读', claim: '最终让学生回到文章里读出人物精神。', body: ['回到文本细读', '补充作品片段', '开展课堂讨论'], visual_suggestion: '书页、阅读清单或课堂讨论图，16:9 横版', layout_intent: { kind: 'closing', density: 'low', media_slots: 1 } }
  ]
}, { prompt: '朱自清人物介绍', slide_count: 5, style: '浅色文艺风 米白纸张 淡墨绿 暖灰' });
assert.equal(resolvePptDraftSubjectProfile(literaryOutline), 'literary-biography');
assert.equal(resolvePptDraftSubjectCopy(literaryOutline).matrixMetricValue, '作品');
const literaryDraft = await buildPptDraftPptx(literaryOutline);
const literaryZip = await JSZip.loadAsync(literaryDraft.bytes);
const literaryThemeXml = await literaryZip.file('ppt/theme/theme1.xml').async('string');
const literaryCoverXml = await literaryZip.file('ppt/slides/slide1.xml').async('string');
const literaryMatrixXml = await literaryZip.file('ppt/slides/slide3.xml').async('string');
assert.match(literaryThemeXml, /Minimal Light/);
assert.doesNotMatch(literaryThemeXml, /4F5B53/, 'literary subject must stay within the monochrome template');
assert.match(literaryCoverXml, /人物介绍/);
assert.match(literaryCoverXml, /LITERARY PORTRAIT/);
assert.match(literaryMatrixXml, /人物生平|代表作品|散文风格/);

const draft = await buildPptDraftPptx(outline, { theme: 'tech-blue' });
assert.equal(draft.slide_count, 5);
assert.equal(draft.theme, 'tech-blue');
assert.ok(draft.bytes.byteLength > 8000);
assertImagePlaceholderAspectRatios(draft.image_placeholders, 'default draft');
const coverPlaceholder = draft.image_placeholders.find(item => item.slide === 1);
assert.ok(coverPlaceholder, 'default draft must expose a cover image placeholder');
assert.equal(coverPlaceholder.aspect_ratio, '9:16', 'cover image placeholder must use portrait 9:16');

const lightDraft = await buildPptDraftPptx(outline, { theme: 'minimal-light' });
assert.equal(lightDraft.theme, 'minimal-light');
const lightZip = await JSZip.loadAsync(lightDraft.bytes);
const lightThemeXml = await lightZip.file('ppt/theme/theme1.xml').async('string');
assert.match(lightThemeXml, /Minimal Light/);
for (const slideName of Object.keys(lightZip.files).filter(name => /^ppt\/slides\/slide\d+\.xml$/.test(name))) {
  const xml = await lightZip.file(slideName).async('string');
  assert.doesNotMatch(xml, /NaN|undefined|null/, `${slideName} light theme must be valid XML`);
}

const samplePng = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'));
const normalizedAssets = normalizePptDraftAssets([{
  id: 'hero-image',
  name: 'hero.png',
  mime: 'image/png',
  bytes: samplePng,
  width: 1,
  height: 1
}]);
assert.equal(normalizedAssets.length, 1);
const assetOutline = normalizePptDraftOutline({
  ...outlinePayload(5),
  slides: outlinePayload(5).slides.map((slide, index) => index === 0
    ? { ...slide, asset_slots: [{ role: 'cover', asset_id: 'hero-image', fit: 'cover' }] }
    : slide)
}, { prompt: '真实图片素材测试', slide_count: 5, theme: 'tech-blue' });
const assetDraft = await buildPptDraftPptx(assetOutline, { theme: 'tech-blue', assets: normalizedAssets });
assert.equal(assetDraft.asset_manifest.find(item => item.slide === 1)?.status, 'embedded');
assert.equal(assetDraft.asset_manifest.find(item => item.slide === 1)?.asset_id, 'hero-image');
const assetZip = await JSZip.loadAsync(assetDraft.bytes);
const assetContentTypes = await assetZip.file('[Content_Types].xml').async('string');
const assetRels = await assetZip.file('ppt/slides/_rels/slide1.xml.rels').async('string');
const assetSlide = await assetZip.file('ppt/slides/slide1.xml').async('string');
assert.match(assetContentTypes, /Extension="png" ContentType="image\/png"/);
assert.ok(assetZip.file('ppt/media/asset-hero-image.png'));
assert.match(assetRels, /\.png/);
assert.match(assetSlide, /Embedded image asset/);

const zip = await JSZip.loadAsync(draft.bytes);
for (const required of [
  '[Content_Types].xml',
  '_rels/.rels',
  'ppt/presentation.xml',
  'ppt/slideMasters/slideMaster1.xml',
  'ppt/slideLayouts/slideLayout1.xml',
  'ppt/slides/slide1.xml',
  'ppt/slides/slide5.xml',
  'ppt/theme/theme1.xml'
]) {
  assert.ok(zip.file(required), `PPTX package must include ${required}`);
}

const contentTypes = await zip.file('[Content_Types].xml').async('string');
const coverXml = await zip.file('ppt/slides/slide1.xml').async('string');
const contentXml = await zip.file('ppt/slides/slide2.xml').async('string');
const closingXml = await zip.file('ppt/slides/slide5.xml').async('string');
const coverRels = await zip.file('ppt/slides/_rels/slide1.xml.rels').async('string');
assert.match(contentTypes, /Extension="svg" ContentType="image\/svg\+xml"/);
assert.ok(Object.keys(zip.files).some(name => name.startsWith('ppt/media/') && name.endsWith('.svg')), 'PPTX should embed poster SVG assets');
assert.match(coverXml, /Editable image placeholder/);
assert.match(coverXml, /<p:ph type="pic" idx="1"\/>/);
assert.match(coverRels, /relationships\/image/);
assert.match(contentXml, /放置产品截图或流程示意/, 'visual suggestion should appear as the image placeholder label');
assert.match(closingXml, /Closing action panel/);
assert.match(closingXml, /要点 5-1/);

// Keep every generated shape inside the 16:9 canvas and reject malformed XML
// tokens before a renderer or PowerPoint has to recover from them.
for (const slideName of Object.keys(zip.files).filter(name => /^ppt\/slides\/slide\d+\.xml$/.test(name))) {
  const xml = await zip.file(slideName).async('string');
  assert.doesNotMatch(xml, /NaN|undefined|null/, `${slideName} must not contain invalid numeric tokens`);
  const shapeIds = [...xml.matchAll(/<p:cNvPr\s+id="(\d+)"/g)].map(match => match[1]);
  assert.equal(new Set(shapeIds).size, shapeIds.length, `${slideName} must not reuse shape IDs`);
  for (const [, x, y, cx, cy] of xml.matchAll(/<a:off x="([^"]+)" y="([^"]+)"\/><a:ext cx="([^"]+)" cy="([^"]+)"\/>/g)) {
    const values = [x, y, cx, cy].map(value => Number(value) / 914400);
    assert.ok(values.every(Number.isFinite), `${slideName} contains non-finite geometry`);
    assert.ok(values[0] >= -0.01 && values[1] >= -0.01, `${slideName} starts outside the slide`);
    assert.ok(values[0] + values[2] <= 13.353333 && values[1] + values[3] <= 7.52, `${slideName} shape exceeds the slide canvas`);
  }
}

const monoDraft = await buildPptDraftPptx(outline, { theme: 'minimal-mono' });
assert.equal(monoDraft.theme, 'minimal-mono');
const monoZip = await JSZip.loadAsync(monoDraft.bytes);
const monoThemeXml = await monoZip.file('ppt/theme/theme1.xml').async('string');
assert.match(monoThemeXml, /Minimal Monochrome/);
for (const fileName of Object.keys(monoZip.files).filter(name => /^(ppt\/slides\/slide\d+\.xml|ppt\/media\/.*\.svg)$/.test(name))) {
  const content = await monoZip.file(fileName).async('string');
  for (const [, value] of content.matchAll(/#([0-9a-f]{6})/gi)) {
    assert.equal(value[0], value[2], `${fileName} must use grayscale SVG colors`);
    assert.equal(value[0], value[4], `${fileName} must use grayscale SVG colors`);
  }
}
for (const [, value] of monoThemeXml.matchAll(/val="([0-9A-F]{6})"/g)) {
  assert.equal(value[0], value[2], 'monochrome theme red channel must equal blue channel');
  assert.equal(value[0], value[4], 'monochrome theme must contain grayscale colors only');
}

const matrixOutline = normalizePptDraftOutline({
  ...outlinePayload(5),
  slides: outlinePayload(5).slides.map((slide, index) => index === 1
    ? {
      ...slide,
      role: 'evidence',
      claim: '一个工具箱，搞定 PDF、图片、音视频、文本、AI 文档、AI 表格等。',
      visual_suggestion: '网格状图标墙',
      layout_intent: { kind: 'matrix', density: 'medium', media_slots: 0 }
    }
    : slide)
}, { prompt: '矩阵排版测试', slide_count: 5, theme: 'minimal-dark' });
const matrixDraft = await buildPptDraftPptx(matrixOutline, { theme: 'minimal-dark' });
const matrixZip = await JSZip.loadAsync(matrixDraft.bytes);
const matrixXml = await matrixZip.file('ppt/slides/slide2.xml').async('string');
assert.match(matrixXml, /PDF、图片、音视频与 AI，全部本地处理。/, 'dense matrix claim should keep AI as a single token');

// Explicit layout metadata must take precedence over semantic keywords in
// the claim. AI Agent/MCP is common product copy and must not hijack the
// matrix, process, or comparison composition.
for (const [layoutKind, expectedMarker, role, claim] of [
  ['matrix', 'Matrix right rule', 'evidence', 'MIT 开源版本支持桌面端、CLI 与 AI Agent / MCP。'],
  ['process', 'Process rail', 'workflow', '从桌面端交付到 CLI 与 AI Agent / MCP。'],
  ['comparison', 'Comparison axis', 'comparison', '1.3 相比 1.2，新增 CLI 与 AI Agent / MCP。']
]) {
  const explicitOutline = normalizePptDraftOutline({
    ...outlinePayload(5),
    slides: outlinePayload(5).slides.map((slide, index) => index === 1
      ? {
        ...slide,
        role,
        title: `${layoutKind} contract`,
        claim,
        visual_suggestion: layoutKind === 'matrix' ? '网格状图标墙' : layoutKind === 'process' ? '流程图' : '版本对比',
        layout_intent: { kind: layoutKind, density: 'medium', media_slots: 0 }
      }
      : slide)
  }, { prompt: `${layoutKind} precedence`, slide_count: 5, theme: 'minimal-dark' });
  const explicitDraft = await buildPptDraftPptx(explicitOutline, { theme: 'minimal-dark' });
  const explicitZip = await JSZip.loadAsync(explicitDraft.bytes);
  const explicitXml = await explicitZip.file('ppt/slides/slide2.xml').async('string');
  assert.match(explicitXml, new RegExp(expectedMarker), `${layoutKind} must retain its explicit composition`);
  assert.doesNotMatch(explicitXml, /Triad node|Triad connector/, `${layoutKind} must not be hijacked by AI Agent/MCP text`);
}

const visualVariantPayload = outlinePayload(5);
visualVariantPayload.slides[1] = {
  ...visualVariantPayload.slides[1],
  role: 'problem',
  title: '文件上传后，控制权去了哪里？',
  claim: '云端工具会把隐私、网络和控制权拆开。',
  body: ['文件上传服务器', '离线无法继续', '工具彼此割裂'],
  visual_suggestion: '上传流程截图',
  layout_intent: { kind: 'text-focus', density: 'low', media_slots: 1 }
};
visualVariantPayload.slides[2] = {
  ...visualVariantPayload.slides[2],
  role: 'recommendation',
  title: '本地处理，让控制权回到设备',
  claim: '文件、处理和结果都留在你的电脑。',
  body: ['本地执行', '离线可用', '逻辑可审查'],
  visual_suggestion: '本地工作流截图',
  layout_intent: { kind: 'image-text', density: 'low', media_slots: 1 }
};
visualVariantPayload.slides[3] = {
  ...visualVariantPayload.slides[3],
  role: 'content',
  title: '开源 MIT：自由使用，自由扩展',
  claim: '源代码公开，适合审查、学习和二次开发。',
  body: ['免费使用', '可审查', '可扩展'],
  visual_suggestion: '仓库截图',
  layout_intent: { kind: 'text-focus', density: 'low', media_slots: 1 }
};
const visualVariantDraft = await buildPptDraftPptx(visualVariantPayload, { theme: 'tech-blue' });
assertImagePlaceholderAspectRatios(visualVariantDraft.image_placeholders, 'visual variant draft');
const visualVariantZip = await JSZip.loadAsync(visualVariantDraft.bytes);
const problemXml = await visualVariantZip.file('ppt/slides/slide2.xml').async('string');
const localXml = await visualVariantZip.file('ppt/slides/slide3.xml').async('string');
const openSourceXml = await visualVariantZip.file('ppt/slides/slide4.xml').async('string');
assert.match(problemXml, /Problem danger field/);
assert.match(localXml, /Local core halo outer/);
assert.match(openSourceXml, /Open source MIT mark/);
for (const slideName of Object.keys(visualVariantZip.files).filter(name => /^ppt\/slides\/slide\d+\.xml$/.test(name))) {
  const xml = await visualVariantZip.file(slideName).async('string');
  for (const [, x, y, cx, cy] of xml.matchAll(/<a:off x="([^"]+)" y="([^"]+)"\/><a:ext cx="([^"]+)" cy="([^"]+)"\/>/g)) {
    const values = [x, y, cx, cy].map(value => Number(value) / 914400);
    assert.ok(values[0] >= -0.01 && values[1] >= -0.01, `${slideName} visual variant starts outside the slide`);
    assert.ok(values[0] + values[2] <= 13.353333 && values[1] + values[3] <= 7.52, `${slideName} visual variant exceeds the slide canvas`);
  }
}

const extracted = await analyzePptxText(Buffer.from(draft.bytes), { sourceName: 'draft.pptx' });
assert.equal(extracted.slide_count, 5);
assert.equal(extracted.slides[0].title.replace(/\r?\n/g, ''), 'ToolKnit PPTX 草稿测试');
assert.equal(extracted.slides[1].title.replace(/\r?\n/g, ''), '第 2 页标题');
assert.equal(extracted.slides[1].body.some(text => text.includes('要点 2-1')), true);

const manifest = createPptDraftManifest({
  outline: draft.outline,
  theme: draft.theme,
  outputFile: 'demo.pptx',
  outputBytes: draft.bytes.byteLength,
  outputs: [{ relative_path: 'demo.pptx', kind: 'pptx', bytes: draft.bytes.byteLength }]
});
assert.equal(manifest.schema, 'toolknit.ppt-draft');
assert.equal(manifest.output_file, 'demo.pptx');
assert.equal(manifest.slide_count, 5);
assert.equal(manifest.deck_type, 'product-launch');
assert.equal(manifest.request.deck_type, 'product-launch');
assert.ok(Array.isArray(draft.outline.image_placeholders));
assert.ok(draft.outline.image_placeholders.some(item => item.slide === 1 && item.replaceable === true));
assertImagePlaceholderAspectRatios(manifest.image_placeholders, 'draft manifest');

console.log('PPT draft core regression checks passed');
