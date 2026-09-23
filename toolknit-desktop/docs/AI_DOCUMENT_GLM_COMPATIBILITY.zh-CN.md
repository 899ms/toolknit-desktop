# AI 文档与 GLM-5.3-Flash 兼容性

## 已确认的原因

使用用户指定的官方端点和模型、项目内置的模拟租房合同需求对照，未发送用户文件：

| 请求 | HTTP | 耗时 | 正文字符 | 完成令牌 | 结束原因 |
| --- | --- | --- | --- | --- | --- |
| 短翻译 | 200 | 约 2.1 秒 | 71 | 135 | stop |
| 原文档参数，max_tokens=8192 | 200 | 约 93.9 秒 | 0 | 8192 | length |
| 同一文档，reasoning_effort=low | 200 | 约 29.6 秒 | 3182 | 1352 | stop |

原网络层统一 45 秒截止，AI 文档页面自身 90 秒截止。即使越过超时，原文档请求也会把输出预算用在思考上，未返回正文。另验证了该模型拒绝 `thinking: {type: "disabled"}`，必须使用其支持的 low/high/max 思考档位；没有采用关闭思考的错误兼容方式。

## 修改边界

- AI 文档通过既有 requestAi 的可选第四参数请求 `timeoutMs: 180000` 与 `reasoningEffort: low`，页面期限和网络期限一致。翻译等既有调用不变；未指定原生期限时仍为 45 秒。
- JavaScript 与 Rust 只在官方 `open.bigmodel.cn` 端点、`glm-5.3-flash` 模型组合下发送 `reasoning_effort`，不把专属参数强加给其他服务。
- `request_private_ai_completion` 的 request 对象新增两个可选字段，旧请求兼容；命令名、密钥处理、URL 校验、禁用重定向、2MB 响应上限均保留。
- 超时、长度截断和空正文使用独立的安全错误码，中间适配器保留 code/status，AI 文档显示具体错误，不再一律叫作网络失败。不记录服务商错误正文或密钥。
- 原有关闭/取消与过期结果隔离保留。前端取消会停止等待和页面更新；本轮没有新增取消原生 HTTP 请求的命令，原生请求仍受所选期限约束。

## 验证

- `test-ai-provider-core.mjs`：参数适配、旧参数兼容、浏览器期限、取消、截断/空正文及安全边界。
- Rust `ai_provider`：实际回环服务器超时分类、参数边界、响应识别及旧请求兼容。
- `test-ai-document-provider-browser.mjs`：完整文档界面的参数转发、截断/空正文/429 提示、重试、预览和打开编辑器；使用本地响应夹具，不发送外部请求。
- 真实低档响应通过版式校验，包含 1 个逻辑页、23 个区域；本地 PDF 渲染器输出可打开的 50,333 字节 PDF，因自动分页形成 2 个物理页。未将模型逻辑页数当作最终 PDF 页数。

密钥仅在本轮诊断进程内临时使用，未写入仓库、夹具或测试日志。本轮不打包、不发布、不改版本。

## AI 表格接续修复

AI 表格仍使用旧的 90 秒页面期限、未传输 timeoutMs/reasoningEffort 的 8192 令牌请求，并把适配器错误统一显示为网络失败。已与 AI 文档对齐到 180 秒期限、low 思考档位及安全的具体错误反馈；复用现有共享请求适配器，不修改表格计算、编辑和导出协议。

端到端回归还发现单元格的 Escape 处理会继续触发 lazy registry 的工具页返回。单元格结束编辑时现在阻止该默认事件，避免误关整个页面；原有失焦提交数据行为不变。

`test-ai-table-provider-browser.mjs` 使用本地响应夹具验证截断、空正文、429、重试成功、单元格编辑、非空图表、CSV/XLSX/PDF 导出，以及关闭后旧响应不写入重开的页面；不额外调用真实账户。用户已授权本轮验证后生成保留 F12 的测试安装包，使用 `npm run build:test-package`，不发布、不改版本。

## 翻译与润色接续修复

翻译、润色方向分析和执行润色三个请求均已传入共享的 180 秒期限及 low 思考档位。仍不指定 maxTokens，保留服务商原有输出额度，不照搬文档的 8192 上限。low 参数继续只对已验证的官方 GLM-5.3-Flash 组合发送，其他模型的请求体不额外添加该字段。

两个工具均保留 AiProviderError 的具体安全提示，原生超时正确显示超时提示，不再将截断、空正文、鉴权或限流全部显示为网络失败。原有逐句翻译、三方向分析、正文润色、大小校验、取消和会话隔离逻辑不变。本轮仅修复和验证，不打包、不使用真实密钥。

`test-ai-text-provider-browser.mjs` 覆盖三个阶段的截断、空正文、401、429、模拟时钟下的 180 秒截止、错误后重试、正常输出和关闭重开隔离，并断言请求不携带新增的 max_tokens 上限。focused core/contract、共享 provider、架构和前端构建检查通过。

## AI 文档错误诊断

- 用户测试仍报告 HTTP 404 与无状态码的通用失败。本轮只补充诊断，不据此擅自更改端点、模型或请求参数，也不认定 404 的具体原因已经修复。
- AI 文档通过既有请求选项显式传入 `diagnostics: true`。Tauri request 同名可选字段默认 false；只有 debug 或 `qa-devtools` 构建接受诊断，普通 release 仍不读取非成功响应正文。命令名、原有错误码及旧调用保持兼容，诊断字段不会发给 API。
- 原生错误保留 `ai-provider:<code>[:status]` 前缀，调试时追加本地 IPC 诊断信封。错误正文最多 32 KiB，读取最多等待 2 秒；读取失败不覆盖原始 HTTP 状态。网络连接失败没有 API 正文，单独标明阶段及原因，不序列化含私有 URL 的 reqwest 错误。
- 共享纯逻辑只提取服务端错误码、类型、消息等白名单字段，脱敏密钥、请求正文、授权信息与路径；不记录 choices、推理内容或生成文档。HTML、超限字段以及非错误的成功响应正文不输出。原始信封不得直接记录日志或写入文件。
- 前端本地化错误时保留脱敏诊断。F12 筛选 `[AI Doc] API diagnostics` 可得到可复制的 JSON，包含请求主机、去查询参数的路径、模型、HTTP 状态及服务端错误信息。浏览器仅开发环境启用该输出；生产浏览器和未启用 F12 的普通原生包均关闭。
- CLI 的默认错误行为不变；诊断逻辑留在既有 provider core，资源暂存清单补齐其复用的有界响应读取模块，防止安装后的 CLI 丢失依赖。本轮不使用真实密钥，不打包、不发布。

验证结果：provider core/文档契约、开发浏览器的 6 种错误与成功重试、生产浏览器日志关闭、88 项发布脚本（包含 security/architecture/CLI/build）通过。完整 Rust 为 104 passed、1 ignored；普通 release 的 8 项 provider 单测通过，确认生产开关关闭。

本机带 `qa-devtools` 的优化单测初次出现 CRT 缺失的 LNK1120。仅在测试进程中临时设置 `LINK`，补充 libcmt/libcpmt/libvcruntime/libucrt/oldnames/legacy_stdio_definitions 后，8 项单测通过，确认测试包开关启用。仍有该缓存库的 LNK4003/LNK4098 提示，未修改项目构建或发布配置；下一次实际打包需另行核对，不能把本轮单测视为安装包验收。

## GLM-5.3 适配遗漏修复

用户的新日志使用 `glm-5.3`，返回 `response_truncated`，不同于此前的 Flash 和 HTTP 404。源码确认：文档虽然请求 `reasoningEffort: low`，但 JavaScript 与 Rust 都仅对 `glm-5.3-flash` 发送该字段，导致完整型号的设置被丢弃。

2026-09-06 核对[官方模型说明](https://docs.bigmodel.cn/cn/guide/models/text/glm-5.3.md)与[思考参数说明](https://docs.bigmodel.cn/cn/guide/capabilities/thinking.md)：GLM-5.3 始终思考，支持 low/high/max，默认 max，不能传 thinking.type=disabled。遗漏 low 会使请求使用默认档位；旧日志缺少用量，不能据此断言全部额度都用于思考。

- 两条请求路径的官方主机精确匹配清单补齐 `glm-5.3`，保留 `glm-5.3-flash`。其他主机、相似域名、未知后缀型号不自动套用参数。
- 保持文档 8192 输出额度、180 秒期限和现有响应大小边界；不扩大所有模型额度，不新增自动付费重试，也不接受残缺文档为成功结果。
- 诊断记录实际生效的 reasoningEffort/maxTokens、HTTP 状态、finishReason、正文与思考文本的 UTF-8 字节数，以及服务商提供的 token 统计。没有提供的统计不臆造；字符串、负数、非整数和额外字段不进入统计日志。
- 原生完成阶段现在保留真实 HTTP 状态，因此成功 HTTP 响应被本地判定截断时日志不再显示 status=null。旧错误码和 AiProviderError.status 契约不变，只补充诊断字段。
- 统计在响应正文省略前提取，即使超过 32 KiB 诊断正文上限仍然保留；正文、思考内容、密钥及敏感字段继续不输出。
- 回归覆盖完整型号与 Flash、大小写和空白、未知型号/相似主机、超长思考响应、计数脱敏、文档错误反馈与成功重试。本轮不使用真实密钥或调用用户账户，不打包、不发布，真实输出仍需后续测试包验证。

### 本轮文件与兼容性

- `src/ai-provider-core.js`：补齐完整型号的参数适配，投影安全的完成状态和用量，保留原生诊断 HTTP 状态。
- `src-tauri/src/ai_provider.rs`：同步原生参数适配，在省略大响应正文前提取完成状态和用量，并补充原生回归用例。
- `scripts/test-ai-provider-core.mjs`：覆盖模型与主机边界、两条传输路径、超长响应、无效计数和日志脱敏。
- `scripts/test-ai-document-provider-browser.mjs`：默认验证 `glm-5.3`，也可指定 Flash，检查实际请求参数、错误诊断与成功恢复。
- 本文：记录原因、约束和验证结果。本次没有新增 DOM、storage、event、Tauri command 或 CLI/MCP 参数；原有错误码与状态契约兼容，诊断仅增加字段。

### 验证收尾（2026-09-07）

- 共享 provider 专项复跑通过；完整 Rust 测试为 106 passed、0 failed、1 ignored，其中 10 项为 AI provider 测试。忽略项为需显式配置 LibreOffice 样本的 Excel 原生测试。
- `npm run test:release` 的 88 项脚本全部通过，包含 security（968 项检查）、architecture、CLI 安装与 MCP 契约、前端 build。构建和安装仍报告大 chunk、crypto externalization、plugin timings 及旧间接依赖弃用提示；未为消除提示扩大本次改动。
- 上一轮两个型号的无窗口浏览器回归均已通过：6 种错误反馈、重试成功、预览及编辑器。使用本地模拟响应，不能替代真实模型生成质量和另一台电脑上的安装包验证。
- 未重新调用用户账户、未启动可见开发窗口、未改版本或生成新安装包；旧安装包不包含本轮修复。

### 测试包交付（2026-09-07）

用户随后明确要求打包，已使用 `npm run build:test-package` 成功生成 Windows x64 NSIS 测试安装包，包含上述 GLM-5.3 修复及诊断补充。版本保持 2.3.1，启用 `qa-devtools`，不发布、不签名、不调用真实 AI 账户，也未在本机启动安装或可见开发窗口。

- 文件：`src-tauri/target/release/bundle/nsis/toolknit-desktop_2.3.1_x64-glm53-f12-20260907-124855-setup.exe`。
- 大小：50,484,198 字节（48.15 MiB）；安装包生成时间为 2026-09-07 12:47:37（本机时间）。
- SHA256：`B82BCD9E007D2A665D788A290D5B63C9B0D9EB3534394622AC09CA0E159A0597`。日期副本与原始构建产物校验一致，签名状态为 NotSigned。
- F12 快捷键、权限和生产隔离契约通过；本次编译记录包含 `custom-protocol`、`default`、`qa-devtools`。版本契约与 diff 检查通过，完整发布/Rust 回归沿用本节前述结果。
- 另一台电脑的安装、实际 F12 操作及真实模型生成仍由用户测试；此包仅用于测试，不作为正式发布包。

## DeepSeek V4 与 GLM 真实接口复核（2026-09-07）

### 结论与修复

- 本轮用户明确授权使用 DeepSeek/智谱账户做小额测试。仅发送应用内置模拟需求或合成短文本，没有上传用户文件；密钥只在诊断进程内使用，不写入源码、报告、测试夹具或安装包。
- 已确认共享 JS 和 Rust 发包逻辑仅为官方 GLM-5.3/Flash 发送 `reasoning_effort`，忽略了 DeepSeek V4 的同名控制。页面虽然传入 low，DeepSeek 实际使用服务端默认的 high，思考内容与正文竞争输出额度。
- 修复位于 `src/ai-provider-core.js` 与 `src-tauri/src/ai_provider.rs`：官方 `api.deepseek.com` 的 `deepseek-v4-pro`/`deepseek-v4-flash`、官方 `open.bigmodel.cn` 的 `glm-5.3`/`glm-5.3-flash` 共用 low 默认值。显式 low/high/max 仍受尊重；旧签名未提供该参数时也生效，覆盖 PPT 等共用请求入口。
- 未知型号、相似域名、自定义代理不擅自套用参数；不更换模型、不禁用 GLM 思考、不改变输出上限/超时/响应大小限制、不添加自动收费重试。`finish_reason=length` 仍拒绝，避免把思考内容或残缺 JSON 当成成品。
- 官方依据：DeepSeek 的[思考模式](https://api-docs.deepseek.com/zh-cn/guides/thinking_mode/)与[计费说明](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/)，智谱的[思考说明](https://docs.bigmodel.cn/cn/guide/capabilities/thinking.md)与[GLM-5.3 模型说明](https://docs.bigmodel.cn/cn/guide/models/text/glm-5.3.md)。文档内容与真实返回相互对照，不按历史模型参数推断。

### 真实接口证据

同一短文档对照使用相同 4096 token 限额，限额只用于控制本次测试费用；应用原有文档 8192 限额未改动。以下仅记录用量和结构，不保存正文或思考原文。

| 模型/场景 | 实际 effort | 输出限额 | 耗时 | 输出 tokens / 思考 tokens | 结果 |
| --- | --- | --- | --- | --- | --- |
| V4 Flash，修复前短文档 | 未发送 | 4096 | 37.0s | 4096 / 3550 | HTTP 200、length，正文未完整 |
| V4 Flash，相同输入补发 low | low | 4096 | 5.9s | 895 / 143 | stop；1 页、14 regions，结构校验通过 |
| V4 Pro，短文档 | low | 4096 | 10.6s | 765 / 197 | stop；1 页、11 regions，结构校验通过 |
| GLM-5.3，短文档 | low | 4096 | 7.7s | 631 / 0 | stop；1 页、12 regions，结构校验通过 |
| GLM-5.3-Flash，表格 | low | 2048 | 2.6s | 187 / 0 | stop；5 行、3 列、1 图表，结构校验通过 |
| GLM-5.3，内置租房合同 | low | 2900 | 15.9s | 1445 / 11 | stop；1 个逻辑页、23 regions，结构校验通过 |
| V4 Flash，内置三页商业计划书复核 | low | 8192 | 21.5s | 3534 / 321 | stop；实际 extractJson + normalize 得到 3 页、54 regions |
| V4 Pro，表格 | low | 1024 | 3.1s | 184 / 36 | stop；5 行、3 列、1 图表，结构校验通过 |
| V4 Pro，逐句翻译 | low | 512 | 2.8s | 131 / 84 | stop；2 组句子对照，结构校验通过 |
| V4 Flash，润色方向 | low | 512 | 1.9s | 139 / 58 | stop；3 个方向，结构校验通过 |
| GLM-5.3-Flash，润色正文 | low | 512 | 1.8s | 27 / 0 | stop；正文校验通过 |

说明：共取得 12 次完整 HTTP 调用结果，1 次为修复前的预期截断。另一次三页请求返回 stop，但诊断脚本直接 JSON.parse 失败且未保留原文，不能判定是包裹文本还是 JSON 语法问题，不计入结构通过样本；随后同输入按应用真实提取流程复核通过，见表格。最初还有一次诊断会话中断的请求，没有收到可核验结果，也不计为通过。没有把中断请求视为免费，测试账本保留了预留费用；账本只是保守估计，不冒充服务商实际账单。

### 验证边界

- `scripts/test-ai-provider-core.mjs` 覆盖四个官方型号、默认及显式档位、大小写/空白、两种 DeepSeek 路径、相似主机/未知型号隔离、fetch/native 一致性及诊断实际档位。
- Rust AI provider 专项 11/11 通过；完整 Rust 为 107 passed、0 failed、1 ignored。
- 三个 provider 浏览器脚本增加 `TOOLKNIT_TEST_AI_URL`/`TOOLKNIT_TEST_AI_MODEL` 参数，保留无真实密钥的网络夹具，用于验证文档、表格、翻译和润色界面。
- 浏览器六组运行全部通过：文档（V4 Pro、GLM-5.3）、表格（V4 Flash、GLM-5.3-Flash）、翻译/润色三阶段（V4 Pro、GLM-5.3-Flash）。覆盖实际发包字段、错误提示、180 秒期限、重试、编辑/预览、表格 CSV/XLSX/PDF 导出及关闭重开后的过期结果隔离；全部使用本地夹具，不产生账户费用。
- `npm run test:release` 的 88 个脚本通过，包含 architecture、security-release（968 项）、CLI/MCP 和 build；保留既有大 chunk、crypto externalization、Windows linker 提示。源码及生成前端的凭据模式扫描、`git diff --check` 通过。
- 本轮智谱短文档、合同、表格和润色没有复现长度错误，不能据此宣称所有长输入都会成功；未验证的用户原始失败提示词、超长内容和其他型号仍需具体样本。
- 实际付费请求经过应用共享 JS 请求构造和解析；Windows 原生请求体、超时及错误处理通过 Rust 契约/回环测试，未启动可见 Tauri 窗口做真实账户操作。未打包、未提交、未发布、未改版本。
