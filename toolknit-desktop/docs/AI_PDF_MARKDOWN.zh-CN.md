# AI PDF 转 Markdown

## 入口和复用

- 桌面工具 ID：`pdf-ai-markdown`，归入 AI 分类；overlay 为 `pdfAiMarkdownOverlay`，初始化器为 `initPdfAiMarkdownTool`。
- 实现位于 `src/features/pdf-ai-markdown/`，由 lazy registry 按需挂载。没有新增 CLI/MCP 能力或 storage key。
- 普通 PDF 文本提取的样式提升为 `src/styles/components/pdf-markdown-workspace.css`，普通版原 CSS 路径保留为 import 兼容入口。两种工具共用布局、主题变量、按钮、文件卡、状态、页码预览和导航代理。
- 结果经 `openLazyTool('markdown-editor')` 与现有 `importMarkdown(markdown, sourceName)` 契约传递，先保存本次结果快照再切换工具，避免关闭过程清空数据。完整结果使用现有编辑器的预览、复制和导出功能。

## 处理与边界

1. 单个 PDF 最大 150 MB、120 页。文件选择和页数检查全部本地完成，密码保护文件提示先解密，损坏文件可重新选择。
2. 用户核对模型与服务地址，点击开始后才发送页面截图。使用全局 AI 配置；必须是支持图片输入的 OpenAI 兼容模型。页面与识别内容会发往该服务，可能计费。
   每次转换固定服务配置快照；处理中更改地址、模型或私网开关会停止后续请求，等待用户重新开始。
3. PDF.js 在 Worker 中处理 PDF。逐页渲染，最大宽度 1600、像素数 450 万，JPEG 截图 data URL 最大 7 MiB。每页结束释放 Canvas 和页资源。
4. 逐页请求 JSON 结构：标题、段落、列表、表格、图片说明、公式、识别警告；正文保留原语言，模型不应翻译或概括原文。空白页必须显式声明，非法响应不会算作成功。
5. 已识别原文以 source-page 注释保留，图片和图表保存为说明，不包含自动下载的外链图片。Markdown 序列化将模型文本中的 HTML 和图片语法转义。
6. 全书内容分批处理为独立导读，再递归汇总；每批控制在共享请求的文本限制内。原文序列化不依赖导读成功，也不被导读覆盖。
7. 失败页可重试，成功页不重复请求；导读失败可单独重试。认证、费用、用量、图片不支持等明确服务错误立即停止队列，连续三页失败也停止，避免大量无效请求。

## 生命周期与取消

- controller 拥有当前 session、operation scope、PDF handle、页结果、进度和预览。
- 所有异步完成点检查 operation 与 session；重新打开的页面不会接收旧任务结果。
- 取消保留当前会话的已识别页；关闭、返回、切换工具、pagehide 和重新选择清空会话并释放资源。
- AbortSignal 同时控制 PDF.js 渲染、fetch 与原生请求。Native 请求增加可选 `requestId`，旧调用保持兼容；新增 `cancel_private_ai_completion({ requestId })`。
- Rust `ai_provider_cancellation.rs` 使用有界请求注册表和 oneshot，兼容取消早于请求调度的竞态。guard 结束时移除登记，取消会丢弃本机 HTTP future。已经送达服务商的请求不能保证撤回或免计费。

## 共享 AI 契约

- `request_private_ai_completion` 的 content 继续兼容字符串，新增 user 消息的 text/image_url 数组；最多 8 段。
- 图片只接受 JPEG、PNG、WebP 的 base64 data URL，禁止外链和 SVG。多模态部分全请求总计不超过 8 MiB；文本限制、响应限制、URL 校验、密钥存储和原生网络路径保留。
- 输出诊断不记录图片或正文；页面模型响应均为不可信数据，系统提示词在逐页和汇总两阶段均明确数据边界。

## 验证

- `npm run test:pdf-ai-markdown`：结构验证、完整序列化、数字表格、页码、全文分批、失败重试、取消、模板和语言契约。
- `npm run test:ai-provider`：文本兼容、多模态边界和桌面取消桥接；Rust tests 覆盖图片校验和取消登记。
- `scripts/test-pdf-ai-markdown-browser.mjs`：实际生成文本页与旋转扫描页，检查渲染图片像素；使用模拟模型响应验证白天/深色、中英文、空状态/已选择/部分成功/成功、窄窗/低高度、编辑器完整导入、损坏/超页数、取消和关闭重开。
- 普通工具回归：`npm run test:pdf-text-markdown` 与 `scripts/test-pdf-text-layout-browser.mjs`。
- 未使用真实 API Key、未发送用户文件；实际视觉模型的识别质量、计费和兼容性仍需针对用户选用的服务验收。此任务不包含安装包发布。

2026-09-20 验证结果：focused suites、architecture、help、build、91 项发布脚本、980 项安全检查、CLI/MCP、git diff --check 均通过。完整 Rust 测试为 150 passed、3 ignored；随后补充取消预调度测试，AI 原生 focused suite 为 14 passed。Edge 浏览器两套主题回归通过，并验证了真实加密 PDF 拒绝、损坏/超页数、缺少 Key 不发送请求、旋转扫描页的非空截图和普通版回归。构建仅有既有大 chunk 与 crypto externalization 提示。
