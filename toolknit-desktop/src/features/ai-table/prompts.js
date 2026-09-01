export const AI_TABLE_PRESET_PROMPTS = Object.freeze([
  Object.freeze({
    labelKey: 'home.aiTable.presetSales',
    prompt: '生成一份 2026 年 Q2 新媒体投放复盘表，请模拟合理但真实感强的数据。字段包含：月份、平台、投放预算、曝光量、点击量、CTR、CPC、线索数、成交数、成交金额、ROI、主要问题、优化建议。请至少生成 18 行数据，覆盖抖音、小红书、B站、微信公众号、知乎、搜索广告等平台；突出 ROI 低于 1.2 的项目。请生成 2 个图表：1）各平台成交金额柱状图；2）按月份 ROI 趋势图。标题和摘要要适合老板汇报，最终适合导出 Excel、PNG 和 PDF。'
  }),
  Object.freeze({
    labelKey: 'home.aiTable.presetSchedule',
    prompt: '生成一份“ToolKnit v2.0 发布排期表”，请模拟详细项目数据。字段包含：模块、任务名称、负责人、开始日期、结束日期、当前状态、优先级、完成度、风险说明、验收标准。至少 14 行，覆盖 AI 文档、AI 表格、视频转 GIF、硬件工具、清理工具、帮助中心、打包发布等模块。状态包含未开始、进行中、待验证、已完成。请生成 1 个进度分布图和 1 个模块风险对比图，表格要适合项目复盘和 Agent 后续按任务修改。'
  }),
  Object.freeze({
    labelKey: 'home.aiTable.presetCompare',
    prompt: '生成一份 2026 年轻量办公笔记本选型对比表，请模拟 8 款产品数据。字段包含：品牌型号、CPU、内存、硬盘、屏幕、重量、续航、接口、参考价、适合人群、优势、短板、综合评分。数据要看起来合理，不要空泛。请生成 2 个图表：1）价格与综合评分对比柱状图；2）不同品牌平均续航对比图。表格摘要要给出“最值得买、性能优先、轻薄优先、预算优先”的建议。'
  }),
  Object.freeze({
    labelKey: 'home.aiTable.presetPerformance',
    prompt: '生成一份研发团队月度绩效复盘表，请模拟 12 名员工的合理数据。字段包含：姓名、岗位、负责模块、需求完成数、Bug 修复数、代码评审数、准时率、协作评分、质量评分、综合得分、绩效等级、主管建议。请让数据有差异和层次，不要每个人都很平均。生成 2 个图表：1）绩效等级分布图；2）各岗位平均综合得分对比图。摘要要指出高绩效特征、风险成员和下月提升建议，适合导出给管理层。'
  })
]);

export const AI_TABLE_SYSTEM_PROMPT = `你是一位数据分析专家，擅长根据用户需求生成结构化数据表和可视化图表。
用户会描述他们需要的表格类型和内容，你的任务是通过对话收集足够信息后生成一份包含数据表和图表的 JSON。

## 输出长度硬性限制
- JSON 总字符数不超过 12000，否则会被截断
- 表格行数控制在 5-50 行，列数 3-12 列
- 图表数量 0-4 个；没有数值列时不要生成图表

## JSON 格式（必须直接返回，不要 markdown 代码块）
{"ready": true, "title": "表格标题", "summary": "简短描述", "columns": [{"key": "name", "label": "姓名", "type": "text"}, {"key": "score", "label": "得分", "type": "number"}, {"key": "date", "label": "日期", "type": "date"}], "rows": [["张三", 95, "2026-01-01"], ["李四", 88, "2026-01-02"]], "charts": [{"type": "bar", "title": "得分对比", "labelColumn": 0, "valueColumns": [1]}]}

## 字段说明
- columns: 列定义，key 是英文标识，label 是列名，type 是 "text"、"number" 或 "date"
- rows: 二维数组，每个子数组是一行数据，顺序与 columns 对应
- charts: 可选，图表数组
  - type: "bar"（柱状图）、"line"（折线图）、"pie"（饼图）
  - title: 图表标题
  - labelColumn: 用作 X 轴标签的列索引（pie 图用作标签）
  - valueColumns: 用作数值的列索引数组（pie 图只取第一个）

## 对话规则
1. 信息不完整时追问（最多 2 轮），返回 {"ready": false, "question": "你的问题"}
2. 信息完整时返回完整 JSON，不要任何 markdown 代码块或解释文字
3. 数据要真实合理，不要用占位符；用户明确要求模拟、示例、演示数据时，可以生成有业务逻辑的假数据，但标题或摘要应体现“模拟/示例”语境
4. 不得编造用户未提供的真实事实、版本、日期、测试通过、验收完成、上线状态或来源引用；缺失事实写“待确认”
5. 图表必须基于 number 类型列；没有数值列时不要生成 charts；饼图只使用一个数值列
6. 如果用户要求图表，必须包含 charts 字段
7. 优先生成能直接用于复盘、汇报、排期、预算、清单、对比、统计的结构：列名清晰、行数据有差异、有层次，不要每行都机械平均`;

export const AI_TABLE_DEMO_DATA = Object.freeze({
  ready: true,
  title: 'ToolKnit V3 迁移进度示例',
  summary: 'AI Table development fixture',
  columns: Object.freeze([
    Object.freeze({ key: 'module', label: '模块', type: 'text' }),
    Object.freeze({ key: 'progress', label: '完成度', type: 'number' }),
    Object.freeze({ key: 'status', label: '状态', type: 'text' })
  ]),
  rows: Object.freeze([
    Object.freeze(['架构基础', 100, '已完成']),
    Object.freeze(['AI 文档', 100, '已完成']),
    Object.freeze(['AI 表格', 65, '进行中'])
  ]),
  charts: Object.freeze([
    Object.freeze({ type: 'bar', title: '模块完成度', labelColumn: 0, valueColumns: Object.freeze([1]) })
  ])
});
