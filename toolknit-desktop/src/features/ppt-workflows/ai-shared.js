import { getLang, t } from '../../i18n.js';

export function pptOutlineDeckTypeLabel(value) {
  const keyMap = {
    auto: 'deckTypeAuto',
    'product-launch': 'deckTypeProductLaunch',
    'investor-pitch': 'deckTypeInvestorPitch',
    'work-report': 'deckTypeWorkReport',
    training: 'deckTypeTraining',
    'industry-research': 'deckTypeIndustryResearch',
    'competitive-analysis': 'deckTypeCompetitiveAnalysis',
    'short-video-demo': 'deckTypeShortVideoDemo',
    'project-review': 'deckTypeProjectReview'
  };
  return t(`home.pptOutlinePage.${keyMap[String(value || 'auto')] || 'deckTypeAuto'}`);
}

export function pptAiGenerationErrorMessage(error, text) {
  const message = String(error?.userMessage || error?.message || error || '').trim();
  if (!message) return t('common.errorOccurred', { error: 'unknown error' });
  if (message === text('needApiKey') || /api[_ -]?key|密钥|no api key|missing.*key/i.test(message)) {
    return text('needApiKey');
  }
  if (/abort|cancel|timeout|timed out|超时/i.test(message)) return text('requestTimeout');
  if (/prompt\s+is\s+required|prompt.*required|missing.*prompt|主题或资料|请输入.*主题/i.test(message)) {
    return text('promptRequired');
  }
  if (/valid PPT outline JSON|invalid_ai_response|invalid json|JSON/i.test(message)) {
    return text('invalidAiResponse');
  }
  if (/provider|api|http|接口|请求失败/i.test(message)) return text('providerError');
  return t('common.errorOccurred', { error: message });
}

export function getPptAiPreset(key) {
  const zh = getLang() !== 'en';
  const presets = {
    'product-launch': {
      name: zh ? '产品发布' : 'Product launch',
      slideCount: 8,
      deckType: 'product-launch',
      theme: 'minimal-mono',
      audience: zh ? '潜在用户、社区读者、短视频观众、产品团队' : 'Potential users, community readers, short-video viewers, and product teams',
      purpose: zh ? '讲清产品价值、版本亮点和使用场景，引导下载、试用或关注' : 'Explain product value, release highlights, and use cases; drive downloads, trials, or follows',
      tone: zh ? '清晰、有冲击力、发布感强，适合公开展示' : 'Clear, punchy, launch-ready, and suitable for public presentation',
      style: zh ? '少文字、大标题、强视觉焦点；每页给出产品截图、流程图或对比图占位；黑白/科技风' : 'Concise copy, large headlines, strong visual focus; include product screenshot, workflow, or comparison placeholders on each slide; dark tech style',
      prompt: zh
        ? '请为「我的产品 / 项目」生成一份产品发布演示。重点说明：它解决了什么问题、核心能力、与传统方案的差异、本地/隐私/效率价值、适合人群、演示亮点、下载/试用引导。若我没有提供具体数据，请把未确认数据放入待补充清单，不要编造。'
        : 'Create a product launch presentation for “my product / project”. Cover the problem, core capabilities, differentiation from existing workflows, privacy/local/efficiency value, target users, demo highlights, and download/trial CTA. If specific metrics are not provided, list them as missing facts instead of inventing them.'
    },
    'work-report': {
      name: zh ? '工作汇报' : 'Work report',
      slideCount: 8,
      deckType: 'work-report',
      theme: 'minimal-light',
      audience: zh ? '主管、项目成员、跨部门协作方' : 'Managers, project members, and cross-functional partners',
      purpose: zh ? '清楚汇报阶段成果、关键问题、资源需求和下一步计划' : 'Report progress, key issues, resource needs, and next-step plans clearly',
      tone: zh ? '专业、克制、结论先行，适合会议汇报' : 'Professional, concise, conclusion-first, and meeting-ready',
      style: zh ? '白底极简、信息分层明确；多用进度、里程碑、风险和计划模块；避免堆字' : 'Clean light theme with clear hierarchy; use progress, milestone, risk, and plan modules; avoid dense text',
      prompt: zh
        ? '请为「本阶段项目进展」生成一份工作汇报。内容包括：目标背景、已完成事项、关键成果、问题风险、资源需求、下一阶段计划、需要领导/团队决策的事项。请把缺少的数据列为待补充，不要编造。'
        : 'Create a work report for “this project phase”. Include background goals, completed work, key results, issues and risks, resource needs, next-step plan, and decisions needed from leaders or the team. Mark missing data as to-be-filled instead of inventing it.'
    },
    'investor-pitch': {
      name: zh ? '路演融资' : 'Investor pitch',
      slideCount: 10,
      deckType: 'investor-pitch',
      theme: 'tech-blue',
      audience: zh ? '投资人、潜在合作伙伴、创业评审' : 'Investors, potential partners, and startup judges',
      purpose: zh ? '建立问题严重性、方案可信度和商业潜力，推动进一步沟通' : 'Establish the problem, solution credibility, and business potential; drive follow-up conversations',
      tone: zh ? '有野心但可信，逻辑紧凑，突出证据和增长空间' : 'Ambitious but credible, tightly structured, evidence-driven, and growth-oriented',
      style: zh ? '科技蓝、强对比、数据占位明确；包含市场、竞品、产品演示、进展和融资诉求模块' : 'Tech-blue, high contrast, clear metric placeholders; include market, competitors, product demo, traction, and ask sections',
      prompt: zh
        ? '请为「创业项目 / 产品方案」生成一份融资路演 PPT。包括：问题、目标用户、解决方案、产品演示、市场机会、商业模式、竞争优势、进展数据、团队与融资/合作诉求。未知数字必须标为待补充。'
        : 'Create an investor pitch deck for “a startup project / product solution”. Include problem, target users, solution, product demo, market opportunity, business model, competitive edge, traction metrics, team, and fundraising/partnership ask. Unknown numbers must be marked as missing facts.'
    },
    training: {
      name: zh ? '培训课件' : 'Training deck',
      slideCount: 12,
      deckType: 'training',
      theme: 'minimal-light',
      audience: zh ? '新手用户、学生、内部培训对象' : 'Beginners, students, and internal trainees',
      purpose: zh ? '把复杂内容拆成可理解、可跟学、可复习的课程结构' : 'Turn complex material into a learnable, followable, reviewable course structure',
      tone: zh ? '耐心、清晰、循序渐进，像优秀讲师一样讲解' : 'Patient, clear, step-by-step, like a strong instructor',
      style: zh ? '浅色简洁、步骤化、案例化；每个概念配一个示例或练习；重点突出易错点' : 'Clean light style with steps and examples; pair each concept with an example or exercise; highlight common mistakes',
      prompt: zh
        ? '请为「课程 / 培训主题」生成一份培训课件。包括：学习目标、概念解释、步骤拆解、案例演示、常见错误、练习任务、总结回顾。语言要清楚，适合新手跟学。'
        : 'Create a training deck for “a course / training topic”. Include learning goals, concept explanations, step-by-step breakdown, examples, common mistakes, practice tasks, and recap. Make it clear enough for beginners to follow.'
    },
    'industry-research': {
      name: zh ? '行业研究' : 'Industry research',
      slideCount: 10,
      deckType: 'industry-research',
      theme: 'minimal-mono',
      audience: zh ? '管理层、研究团队、产品策略人员、内容读者' : 'Executives, research teams, product strategists, and content readers',
      purpose: zh ? '沉淀趋势判断、机会风险和可执行建议' : 'Summarize trends, opportunities, risks, and actionable recommendations',
      tone: zh ? '冷静、客观、有洞察，避免营销腔' : 'Calm, objective, insight-driven, and non-promotional',
      style: zh ? '黑白极简、报告感；使用趋势线、矩阵、案例卡片、机会风险对照；数据未知处明确标注' : 'Minimal monochrome report style; use trend lines, matrices, case cards, and opportunity/risk comparisons; mark missing data clearly',
      prompt: zh
        ? '请为「行业 / 趋势主题」生成一份研究报告。包括：背景变化、关键趋势、代表案例、机会风险、对用户/企业的影响、行动建议。没有来源的数据必须列为待补充，不要编造成事实。'
        : 'Create an industry research deck for “an industry / trend topic”. Include background shifts, key trends, representative cases, opportunities and risks, impact on users/businesses, and action recommendations. Data without sources must be marked as missing instead of invented.'
    },
    'short-video-demo': {
      name: zh ? '短视频演示' : 'Short-video demo',
      slideCount: 6,
      deckType: 'short-video-demo',
      theme: 'minimal-mono',
      audience: zh ? '短视频观众、路人用户、社交平台读者' : 'Short-video viewers, casual users, and social-platform readers',
      purpose: zh ? '快速抓住注意力，展示反差和卖点，引导点赞、关注或下载' : 'Grab attention fast, show contrast and value, and drive likes, follows, or downloads',
      tone: zh ? '直接、有梗、有反差，节奏快但不浮夸' : 'Direct, witty, contrast-driven, fast-paced but not overhyped',
      style: zh ? '大字报式标题、强反差画面、每页一个镜头；明确 3 秒钩子、演示画面和结尾 CTA' : 'Poster-like big headlines, strong visual contrast, one shot per slide; include a 3-second hook, demo visuals, and final CTA',
      prompt: zh
        ? '请把「视频主题 / 产品亮点」生成适合短视频展示的 PPT 脚本 / 分镜。包括：3 秒钩子、痛点、反差、功能演示、证据画面、结尾行动引导；每页都要有明确视觉画面。'
        : 'Turn “a video topic / product highlight” into a PPT-based short-video script/storyboard. Include a 3-second hook, pain point, contrast, feature demo, proof shot, and final CTA; every slide needs a concrete visual scene.'
    }
  };
  return presets[key] || null;
}

export function setPptAiPresetActive(buttons, attrName, key) {
  buttons.forEach(button => button.classList.toggle('active', button.dataset[attrName] === key));
}

export function setPptAiPresetDisabled(buttons, disabled) {
  buttons.forEach(button => { button.disabled = Boolean(disabled); });
}
