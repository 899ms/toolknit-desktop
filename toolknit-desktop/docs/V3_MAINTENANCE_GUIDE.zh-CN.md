# ToolKnit Desktop V3.0 维护规范

## 发布源码与产物检查

`scripts/lib/source-inventory.mjs` 从工作区清单枚举实际存在的源码，包含未提交的新文件，
跳过已删除文件和 Git 忽略的生成物。安全检查不能只读取 Git 索引，否则会遗漏新代码，
并在历史字体删除后因读取不存在的文件而中断。

构建后运行 `npm run test:release-artifacts`；完整 `test:release` 已在末尾接入此检查。
检查生产 DevTools 配置、静态资源重复、旧字体/解码器残留、开发演示数据、调试文件、
PDF.js 资源版本路径及原生依赖完整性，报告写入 `tmp/v3-release-artifact-audit.json`。
依赖名称引用仅用于发现候选项，不足以证明可删除；兼容转发、字体授权和原生库需追踪实际消费者。

AI 文档与表格的开发演示常量保留供开发预览和测试使用，纯初始化标注允许构建器剔除生产未使用数据。
提词器的 QA 标志读取保留，由原生 `qa-devtools` feature 控制启用；正式配置不注入该标志或 F12 钩子。
双主题页面过渡回归可设置 `TOOLKNIT_TEST_THEME=light` 或 `dark`，截图按主题分别保存。

## 首页启动遮罩

`index.html` 在首屏绘制前读取已有主题，并提供不依赖字体或图标库的全屏圆环加载器。
白天白底黑环，深色黑底浅色环；屏幕取色窗口不参与。`app/startup-runtime.js` 负责等待
`fontSettingsRuntime.ready`、`backgroundRuntime.whenHomeReady()`、CSS 字体和可见首页图片解码，
再经两帧布局稳定后按共享页面过渡的 `DEFAULT_REVEAL_MS`（350ms）淡出。
更新检查、AI 服务和工具依赖下载不纳入启动等待。加载时首页 inert，退出后释放输入监听和定时器。

新增 DOM ID `appStartupMask`、根节点 `data-tk-startup` 状态和中英文 `app.loading` 文案；
不新增持久化配置、native command 或 CLI/MCP 协议。入口脚本未能执行时，内联 15 秒 watchdog
负责解除遮罩；运行时接管后清除该 watchdog，并以 12 秒资源等待上限防止字体/原生请求卡死。
这是异常兜底上限，不是固定启动延时。启动遮罩不复用页面导航的活动 DOM，不会在返回首页时重播。

验证入口：`npm run test:startup`、`npm run test:startup-browser`、`npm run test:theme`。
浏览器专项实际延迟入口脚本、字体和壁纸，检查第一帧覆盖、居中、渐隐中间帧、字体失败、
低高度/窄窗口、减少动画设置、键盘锁定与释放、返回首页和缓存重载；结果在 `tmp/startup-browser/`。

## 新增工具的标准结构

每个工具必须放在 `src/features/<tool-id>/`，至少包含：

```text
tool.js          懒加载入口和依赖注入
template.js      工具页面模板或模板导出
controller.js    DOM、交互、异步流程和生命周期组合
core.js          纯计算、解析和校验，不依赖 DOM/Tauri
<tool>.css       工具专属样式
```

简单工具可以合并文件，但必须保持下面的依赖方向和可测试边界，不得把新工具逻辑追加到 `src/application-runtime.js`。

当前 V3.0 基线：桌面工具 65 项、12 个分类；Tauri command 133 个实现、
132 个唯一名称；CLI/MCP 能力 46 项；`src/application-runtime.js` 为 1,975
行；native runtime 共 38 个 Rust 文件，最大文件为 1,872 行。行数只是风险
信号，不得为了数字进行无意义拆分；超过 2,000 行的业务文件必须拆分或在
架构报告中记录保留原因。

## 生命周期要求

工具 initializer 必须返回：

```js
{ open(), close(), dispose() }
```

- `open()` 只创建当前会话资源，并重置 transient state。
- `close()` 失效旧异步请求、停止任务、撤销 object URL 并隐藏 overlay。
- `dispose()` 额外移除工具生命周期 listener，并保证幂等。
- 所有事件和定时器优先通过 `createLifecycleScope()` 注册。
- Tauri `listen()` 返回的 unlisten 必须注册到 lifecycle scope。
- 动态 import 完成后必须检查工具实例仍然有效，禁止旧工具结果写入新工具。

## 平台边界

- 浏览器/Tauri 判断和 `invoke`、`listen`、`convertFileSrc` 统一经过 `src/platform/tauri-runtime.js` 或注入 adapter。
- 工具不得直接读取 Tauri 内部全局，不得在 feature 中复制路径、URL、下载大小或密钥校验。
- 文件输出必须使用 `output-runtime.js` 或 feature 注入的 `getOutputDir`，禁止静默覆盖已有文件。
- 外部 URL 只允许经白名单校验的 HTTP(S) 地址，禁止携带用户名、密码或控制字符。

## 模板与安全渲染

- 固定模板可使用 trusted template registry 挂载。
- 用户文件名、路径、模型返回文本和网络内容必须使用 `textContent` 或 `escapeHtml`。
- 只有经过严格校验的固定 HTML 才允许 `innerHTML`，并应在契约测试中说明来源。
- 新增 DOM ID、`data-tool`、事件名、storage key 或 Tauri command 前，先更新对应契约测试和架构报告。

## 样式复用

硬件工具与剪贴板历史共用 `src/styles/components/hardware-workbench.css` 和
`hardware-workbench-light.css`，原 `features/hardware-inspector/` 样式路径保留 import
兼容入口。剪贴板的时间线与详情布局归其 feature CSS，导航不另建一套。
后台监控是应用级资源，工具页关闭只清理前端会话；退出软件异步收尾，不能在 UI 线程
join 可能更新托盘的工作线程。完整契约与测试边界见 `CLIPBOARD_HISTORY.zh-CN.md`。

- 通用按钮、弹层、导航、进度、窗口控制放在 `src/styles/components/`。
- 页面布局放在 `src/styles/pages/`；工具专属状态和控件放在 feature CSS。
- 不把工具样式重新塞回全局入口，不通过新增无理由 `!important` 或竞争性 `z-index` 修补布局。
- 关闭态 overlay 必须脱离布局，返回按钮、分类标签和窗口圆角要复用既有组件规则。

AI 文档和 AI 表格的白天聊天控件统一使用 `src/styles/components/ai-workbench-light.css`，
由两个工具的懒加载入口在基础样式之后引入。气泡、示例按钮、输入、发送和主次按钮在此维护；
文档编辑器与表格单元格、图表外围样式仍归各自 feature 的 light CSS。
图表画布及文件导出保留独立内容配色；宽表格和图表各自承担横向滚动，不能撑宽整个预览区。
改动共享主题后运行 `scripts/test-ai-document-theme-browser.mjs` 和
`scripts/test-ai-table-theme-browser.mjs`，覆盖两种主题、窗口尺寸、编辑与导出状态。

开发者工具的五合一工作台与 Hash & Crypto 共用
`src/styles/components/developer-workbench-light.css`，由各自懒加载入口引入。
返回按钮通过 `tool-page-v2-light` 复用公共主题，其静态轮廓和悬停描边由共享导航维护，不能只覆盖普通 `border-color`。
工作区外壳、输入输出、模块导航和按钮状态在此维护；JWT/UUID 与文件加密、密钥、警告、日志
分别归 `developer-toolbox` 和 `crypto` 的 feature CSS。高度与滚动修复适用于两种主题，
浅色规则仅在 `html[data-theme="light"]` 下生效。回归需覆盖五种工具模式、17 个算法模块、
AES 文本/文件切换和 File Hash 条件密钥，并检查低高度及窄窗口的操作栏与日志分隔。

PPT 图片提取、转 PDF、转图片、文本提取与压缩共用
`src/styles/components/ppt-workbench.css` 的 `ppt-file-workspace/upload/panel/cta` 布局。
上传栏、文件名、内容区固定为三行；空状态填满内容行，小窗口由工作区或外层正文滚动。
白天模式的白色空状态背景通过 `ppt-tools-light.css` 中的 `--ppt-empty-background` 统一设置，
不要再为单个空状态添加 ID 覆盖。各工具保留既有 DOM ID、选择文件、处理和导出契约。
修改后运行 `scripts/test-ppt-file-layout-browser.mjs`，检查深浅主题、中英文、窄窗口和上传后状态；
转图片交接与拼图导出另由 `scripts/test-ppt-render-workspace-browser.mjs` 验证。

## 性能与主题边界

- 以 60Hz 设备稳定交互为目标，以 16.7ms 帧预算检查长任务；高刷新率设备不得被代码锁定为 60FPS。
- 页面隐藏或工具切换时暂停背景 RAF；连续动画使用共享 animation policy，并合理限制 DPR。
- 滚动、resize、wheel 和 pointermove 使用单帧合并；优先 transform/opacity，避免读写布局交错。
- PDF.js、Canvas、媒体、Object URL、Worker 和预览任务必须在 close/dispose 释放。
- 颜色、间距、阴影、圆角和背景使用 tokens，为后续白天模式预留变量；维护任务不直接实现白天模式。

## 测试门槛

窗口表层改动必须增加实际四角像素回归，不能只检查圆角设置值与原生调用。
运行 `node scripts/test-window-radius-browser.mjs`；根因、范围和隔离原生验证方法见
[窗口圆角刷新与滚动修复](WINDOW_RADIUS_REPAIR.zh-CN.md)。先完成构建，再执行浏览器检查，
避免并发构建清空测试正在读取的 dist。

Office 托管依赖需保留 MSI 中的 `System64` 来源和部署到 `program` 的 app-local VC++ DLL。
不得把开发机预装的微软运行库视为跨机器验证证据。安装、重试和错误码专项见
[LibreOffice 运行时安装修复](LIBREOFFICE_RUNTIME_REPAIR.zh-CN.md)。

首页双主题共用的织网视觉由 `src/app/home-weaving.js`、`src/app/assets/home-weaving.svg`
和 `src/styles/themes/home-weaving-light.css` 管理，生命周期归 `home-controller`。
SVG 以仓库内可信静态模板挂载；动画离开视口、隐藏文档或被工具/弹层覆盖时暂停，
低功耗及减少动态效果模式显示静态完整图案。胶囊按钮复用 `data-home-link="website"`
及现有中英文文案；蜘蛛双主题均为石墨色主体，深色使用银灰腿部与边缘，白天使用深灰线条。
蛛网使用细线层次，文字周围用 SVG 透明遮罩渐隐，不绘制背景色块或粗描边。
`homeWeavingTypeClearance` / `homeWeavingTypeFade` 是内联 SVG 专用 ID，只挂载一份，主题切换不重新挂载。
旧截图模块及其资源已移除，导航栏入口保留。运行
`node scripts/test-home-weaving-browser.mjs` 验证构建产物的主题、导航、动画及窄窗口布局。

`src/app/custom-background-default.js` 管理首次安装的内置山景壁纸。
启动时仅在壁纸与 V3 主题偏好均不存在时写入既有 `toolknit.customBackground.v1`，
并写入一次性标记 `toolknit.customBackground.defaultInitialized.v1`；已有偏好不被覆盖。
首次主题仍是白天，切到深色才加载图片。用户清除后不再次初始化；设置页继续负责预览、更换、清除。
`public/assets/backgrounds/default-dark-mountain.jpg` 随包发布，背景运行时仅额外允许该固定本地资源路径，
不放开其他相对路径或外部 URL。新旧配置、清除持久化和主题切换运行 `npm run test:theme`。

每个新工具至少需要：

1. `core` 纯逻辑测试。
2. tool contract 测试：模板、入口、生命周期和平台注入。
3. 失败、取消、重复打开/关闭和异步过期场景测试。
4. `npm run test:architecture`、`npm run build` 和 `git diff --check`。
5. 影响共享边界时追加 `npm run test:security-release`、CLI/MCP 或 Rust 对应测试。

浏览器回归至少检查：首次打开、重复打开、返回、Escape、语言切换、控制台、焦点、残留遮罩和输出目录按钮。

## Rust 维护

- `lib.rs` 只做 builder、插件、状态和 command 汇总。
- 新 command 放入对应 `native_runtime`/`commands` 领域，保留原名称、参数和返回结构。
- 路径、URL、密钥、下载大小和输出发布逻辑必须复用现有 helper，禁止复制一份“相似校验”。
- 跨领域 helper 通过明确的 `pub(super)` 或平台模块暴露；避免把 Tauri 状态泄漏到纯 core 逻辑。
- 修改 native command 后必须跑对应 Rust 单测，并重新核对 133 实现、132 唯一名称和前端 invoke 清单。大文件清理安全策略与扫描会话契约见 `AI_LARGE_FILE_CLEANUP.zh-CN.md`。

PDF 压缩的保结构/图像化、目标字节、写入和共享核心边界见 `PDF_COMPRESSION_V3.zh-CN.md`。
不允许用未达标输出、原文件副本或估计大小代替严格目标验证。

## CLI / MCP 维护

- CLI 只能依赖明确导出的 core/runtime，不得导入页面或 Tauri 模块。
- 保持 8 MB 消息限制、最多 4 个并发、重复 request id 拒绝和结构化错误。
- 新增能力必须同时补 CLI package、MCP registry、clean-worktree 安装和调用契约。
- 发布前必须从干净临时 worktree stage 资源并安装测试，避免依赖本机未跟踪文件。

## 安全与生产门禁

- 用户文件名、路径、网络内容和模型返回值使用 `textContent` 或安全转义；禁止未经审计的动态 HTML。
- 外部 URL、文件路径、输出目录、下载大小和密钥必须复用现有校验 helper；密钥只能进入受保护存储，不得写日志。
- 生产构建必须关闭 F12/DevTools、调试面板和调试日志，并检查未捕获 Promise 与敏感字符串。
- 大 chunk 和 crypto externalization 警告可暂不阻断，但必须记录依赖来源、启动影响和后续计划，且不得新增同类 warning。

## 提交与发布

- 每个独立阶段使用一个语义明确的本地 Git checkpoint。
- 提交前检查 `git status`、`git diff --check`、测试结果和生成物是否被忽略。
- V3.0 架构阶段不得自动推送 GitHub、发布 npm、创建 Release 或修改版本号；这些动作必须由用户单独确认。
- 大 chunk 和浏览器 crypto externalization 警告目前非阻断，但不得新增同类 warning；来源和后续优化方向必须记录在架构进度文档。

## PDF 工作台白天主题基准（2026-09-12）

- PDF 裁剪是用户已验收的预览型 PDF 工作台标杆。PDF 加页码沿用其配色和控件状态，保留自己的三栏布局、位置九宫格、样式示例和颜色设置。
- `src/styles/themes/pdf-workbench-light.css` 是裁剪、加页码、编辑器共用的白天样式入口，负责面板、预览底色、主按钮、导出底栏、自定义下拉菜单、禁用状态和处理/成功弹框。各工具只接入实际存在的控件，修改共同视觉必须在这里维护，不能再复制到单页覆盖文件。
- `pdf-crop-light.css` 只负责裁剪特有控件；`pdf-page-number-light.css` 负责页码队列、位置/样式选择、滑块、颜色输入等特有控件；`pdf-editor-light.css` 负责页面缩略图状态、对象工具条、选中手柄、形状属性和文字编辑弹框。专属布局尺寸仍由各 feature CSS 管理。公共样式明确限定这三个工具，避免影响其他工具。
- 禁用状态优先于选中和悬停：背景 `#e2e3e6`、文字和图标 `#92959b`，不叠加整体透明度。透明的原生 radio 保持隐藏，只给可见选项面板着色；颜色和滑块控件需保留自身语义。
- 界面主题不得覆盖 `pdf-page-number-live-text` / `pdf-page-number-live-background` 的实际页码样式，也不得修改颜色输入的值或导出设置。
- 编辑器的透明文字命中层、原文覆盖层、插入文字和图片、SVG 形状填充/描边属于文档内容，不得通过主题统一改色；主题仅改变对象选择轮廓和手柄。保持浮层的 `hidden` / `visible` / `inert` 生命周期，不通过主题规则强制显示浮层。
- 修改公共主题后，必须同时回归三页的空状态、上传、禁用/选中/悬停、下拉、低高度滚动、深色模式和输出；编辑器额外检查文字/形状编辑、颜色隔离、撤销重做、旋转和关闭重开。浏览器检查入口为 `node scripts/test-pdf-workbench-theme-browser.mjs`，使用已构建的 `dist`，测试产物写入忽略目录 `tmp/pdf-workbench-theme/`。

## PDF 专用工作台首个模板：拆分（2026-09-12）

- `src/shared/pdf-workbench.js` 只管理共享导航、三栏视图、当前页/勾选状态、缩放、可见缩略图队列和画布清理。沿用编辑器 CSS 类与公共主题，不导入编辑器 feature 或编辑业务；工具通过页面模型、加载回调、文案 key 和右侧 actions 接入。
- `features/pdf-split/preview.js` 拥有 PDF.js 文档和工作台 modal 会话。回到上传页保留输入文件，关闭工作台释放画布与文档；重开重新加载，旧异步结果不得覆盖新会话。
- `workbench-export.js` 构建当前页 PDF、所选页合成 PDF、独立页 ZIP；`export-runtime.js` / `export-worker.js` 负责任务隔离、取消、五分钟超时及 Worker 销毁；`exporter.js` 仍走原有输出目录与 `write_unique_file_bytes` 发布结果。CLI/MCP 的 `splitPdfPages` 语义不变。
- 当前页导出独立于勾选状态；全部页按钮在选择子集时改名为“导出所选页”。ZIP 同样以勾选页为范围，条目带顺序前缀以避免不同源文件的同名页覆盖。没有勾选时仅禁用合成/ZIP，当前预览页仍可导出。
- 新增 DOM 契约：`pdfSplitWorkbenchActions`、`pdfSplitDownloadCurrentBtn`、`pdfSplitDownloadZipBtn`、`pdfSplitProcessCancel`；旧 Workspace/PageStrip/PageStage、返回和主导出 ID 保留。没有新增原生命令、storage 或 CLI/MCP 参数。
- 测试入口：`npm run test:pdf-split`、`npm run test:pdf-split-tool-contract`、`node scripts/test-pdf-split-workbench-browser.mjs`。浏览器产物在忽略目录 `tmp/pdf-split-workbench/`。仅拆分迁移，旋转、转图像、合并须逐个验收后再接入，不自动批量改动。

## PPT 图片预览与压缩等级控件（2026-09-18）

- `features/ppt-images/controller.js` 分别管理素材勾选与缩略图按钮。保留 `.ppt-images-check` 和原有导出选择语义；圆形勾选只改变呈现，白天黑底白勾、深色白底黑勾。点击缩略图不改变勾选集合。
- 图片放大复用已加载的预览 Object URL，使用 `createModalSession` 管理背景 inert、Tab、Escape 与返回焦点。新增 `pptImagesPreviewOverlay`、`pptImagesPreviewImage`、`pptImagesPreviewTitle`、`pptImagesPreviewMeta`、`pptImagesPreviewClose`；对话框为 840×600 上限的固定尺寸，小窗口按视口收缩，图片使用 contain，关闭按钮位于图片下方。关闭移除大图 src；重新上传、重绘列表和退出时销毁缩略图监听并释放 URL。
- `features/ppt-workflows/compress-controller.js` 复用 `enhanceToolSelect`。保留 `pptCompressLevel`、low/medium/high 与 change 契约，原生 select 作为隐藏状态源；分析期间禁用，重置和语言切换后刷新，关闭工具收起菜单，dispose 销毁组件。Escape 优先关闭菜单。
- 样式留在对应 feature，不更改共享下拉、共享弹层、压缩算法、原生命令、storage 或 CLI/MCP。中英文新增键位于 `home.pptImagesPage`。
- 回归入口：`test:ppt-images-tool-contract`、`test:ppt-workflows-tool-contract`、`test:ppt-image-extract`、`test:ppt-compress`。构建后运行 `node scripts/test-ppt-image-controls-browser.mjs`，验证两种主题、中英文、选择集合、不同纵横比预览、小窗口、关闭焦点、URL 清理及真实压缩档位重算；报告和截图输出到忽略目录 `tmp/ppt-image-controls/`。

## PPT AI 表单白天主题（2026-09-18）

- 大纲与草稿的预设标题、说明、图标、悬停和选中配色统一归属 `styles/themes/ppt-tools-light.css`，不再各自维护重复规则。选中态使用 `setPptAiPresetActive` 实际设置的 `.active`；说明文字显式使用 muted token，避免继承历史白色。
- 两页 `.ppt-outline-field` 中的控件聚焦仅将现有边框改为黑色，移除叠加阴影与偏移 outline，尺寸和间距保持不变；按钮的键盘焦点提示保留。
- 两页空状态的提示标签由 `ppt-workbench.css` 统一放入底部行，图标和说明保持居中；白天主题额外为现有 kicker 保留一行。底部行按内容高度分配空间，英文换行不覆盖说明，较矮窗口可滚动查看，原有 DOM 与隐藏状态不变。
- 大纲页空状态提示使用模板真实类名 `.ppt-outline-v2-empty-hints`。其窄窗口布局由 `ppt-workflows.css` 按内容高度排列表单与预览，解除桌面裁切 containment，防止预览覆盖输入框。深色配色、AI 请求与 DOM 契约不变。
- 本轮双主题、中英文、1400×920 与 720×480 共 16 组浏览器检查通过，覆盖预设填充/选中、鼠标和 Tab 聚焦、返回/重开/Escape，截图与报告位于忽略目录 `tmp/ppt-ai-theme/`。focused、architecture、build、security、CLI 与 Rust 检查通过；完整 release 仍因已有 `common.remove` 中文翻译缺失停止。

## 新功能提交前命令

### PDF 旋转工作台接入（2026-09-12）

- 旋转与拆分共用 `shared/pdf-workbench.js`、工具导航与两套主题。新增可选 `getRotation(page)` 和 `refreshPages(indices)`；默认旋转为零，现有拆分调用不变。主预览叠加 PDF 原始方向，缩略图复用原像素进行变换，不重新渲染整份文档。
- `features/pdf-rotate/preview.js` 拥有原始文档、每页相对旋转、勾选与操作范围。当前页、所选页、全部页决定下次旋转的范围；切换范围本身不修改页面。恢复原方向将相对旋转归零，保留源 PDF 自带方向。
- 导出当前页不受勾选影响；全部/所选 PDF 与独立页 ZIP 按勾选范围输出。旋转核心仍为 `pdf-rotate-core.js`；ZIP 复用已旋转文档拆页，避免每页重新打开完整源文件。
- `shared/pdf-export-job.js` 统一拆分和旋转 Worker 的取消、五分钟超时、消息失败与销毁；各 feature 继续拥有自己的 Worker 工厂、输入校验与文件格式逻辑。
- 保留旋转 Workspace、PageStrip、PageStage、RotateAllBtn、DownloadAllBtn 等旧 ID；新增 `data-rotate-actions/scope/turn/select/export/cancel/angle/label` 私有 UI 契约，契约测试已覆盖。未改原生命令、storage、CLI/MCP 或版本。
- 测试入口：`npm run test:pdf-rotate`、`npm run test:pdf-rotate-tool-contract`、`node scripts/test-pdf-rotate-workbench-browser.mjs`；截图与结果在忽略目录 `tmp/pdf-rotate-workbench/`。转图像和合并仍等待单独迁移与验收。

至少执行 `npm run test:architecture`、`npm run build` 和 `git diff --check`。
涉及共享边界、Rust、CLI、MCP 或安全逻辑时，追加
`npm run test:release`、`npm run test:security-release`、`npm run test:cli`
和 `cargo test --manifest-path src-tauri/Cargo.toml`，并完成首次打开、关闭、
重开、Escape、语言切换、控制台和资源释放回归。
