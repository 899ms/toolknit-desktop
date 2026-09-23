# V3 PDF/PPT 回归修复进度

更新：2026-09-06。目标仍在执行，未完成、未发布。

## 范围与基线

- 分支 `codex/v3.0`，起点 HEAD `3f8f095`，package 仍为 `2.3.1`。
- 对照 `v2.3.1` 的 `src/styles.css`、`src/pdf-editor-ui.js`，只恢复行为，不回退模块化。
- 开始时工作区已存在 AI、导航、Toast、编辑器和配置等改动；全部保留，不将这些历史改动计为本轮产出。
- 范围包括目标列出的 PDF 编辑器/拆分/转图像/旋转/压缩，以及 PPT 注册表的全部 7 个工具。其余 PDF 工具还需最终入口和共享行为回归。
- 当前前端计数：65 工具、1315 DOM ID（无重复）、126 唯一 Tauri command、46 MCP 能力。本轮仅新增 PDF 转图像内部按钮 ID。

## 进度口径

以下 20 个工作包等权计数；只有具有代码/测试/运行证据的完成项才计入。不是工时预测。
 当前完成 10/20，进度 50%。部分完成不计入百分比。

| 编号 | 工作包与完成条件 | 状态 |
| --- | --- | --- |
| W01 | 当前状态、旧版对照、初始问题与验证矩阵记录 | 完成 |
| W02 | 三个 PDF 选择区共享滚轮、边界、RAF 和关闭释放 | 完成 |
| W03 | 三个选择遮罩覆盖导航，背景禁用，关闭/Escape 恢复交互 | 完成 |
| W04 | 全部 7 个 PPT 根布局、低高度/窄窗口及访问顺序无关性 | 完成：7 个 PPT 工具均通过低高度浏览器回归；入口、空态、上传后布局、滚动 owner、导出可见性和访问顺序通过 |
| W05 | PDF 编辑器禁用问题定位与所有相关状态修复 | 完成：加载时序稳定，普通/90° 旋转 PDF 状态与插入按钮真实回归通过 |
| W06 | 编辑器文字/形状插入、选择、修改、撤销重做、有效 PDF 导出 | 完成：普通 PDF 插入、撤销/重做/下载及旋转页形状插入通过；桌面输出仍列入 W19 |
| W07 | 横向长图、4 至 9 页田型布局的纯逻辑与资源上限 | 完成：JS core 覆盖横向/2x2/3x2/3x3/越界 |
| W08 | 原生/浏览器新拼接模式、唯一文件名、原子输出、取消 | 完成：当前构建再次通过 Windows Tauri 原生 IPC 横向 PNG/JPG/WebP、4–9 页田型、唯一命名、原子发布、单调进度、取消和会话/临时文件清理；另有 21 页 WebView UI 门禁报告 |
| W09 | 新导出按钮、选中数量门禁、无跳动出现/消失动画、中英文 | 完成：动态门禁、过渡样式和双语 key 已接入；修复 disabled 规则覆盖退场 opacity 的小回归并完成 1–21 页 UI 复测 |
| W10 | PDF 压缩算法与文本/扫描/图片/大文件效果基线 | 完成：样本矩阵覆盖文本、扫描型、图片型、约 5.7MB 不可达目标、80 页大文本和已优化无收益样本；各输出通过 qpdf 检查、页数一致和结构打开验证 |
| W11 | 目标大小压缩引擎、路径/并发/进度/取消/临时文件契约 | 完成：真实 Tauri IPC 覆盖 5/10/15/20/50MB、目标不可达、无收益、取消、唯一命名和临时文件清理；目标请求始终发布有效结果 |
| W12 | 5/10/15/20/50 MB 选项、已小于目标/不可达到/无收益反馈 | 完成：五档选项、auto、目标时最高流压缩和中英文结果语义已完成 |
| W13 | 压缩输出非空、可打开、页数一致、内容可读、体积对照 | 部分：样本与原生输出均已验证非空、可打开、页数一致和体积语义；代表性文本 PDF 已用 Poppler 渲染前后页检查，扫描/图片/大文件的逐样本人工视觉复核仍待补 |
| W14 | PPT 转 PDF/图像上传后空状态、滚动、导出可见性、摘要样式 | 完成：含低高度浏览器与截图验证 |
| W15 | PPT 原生转换、中间 PDF 切换、取消/过期任务和输出目录 | 完成：托管 LibreOffice 26.2.5 真实转换、4 页输出、无效输入、取消、唯一目录、输出路径和临时 PDF 生命周期均通过 |
| W16 | PPT 图片提取筛选/选择/导出/成功弹框/重开/失败 | 部分：上传、布局、按钮与翻译修复 |
| W17 | PPT 文本提取及压缩的完整转换/失败/输出/低高度回归 | 部分：共享样式恢复，上传态通过 |
| W18 | PPT 大纲/草稿布局、离线与缺 Key 门禁、结果/失败/资源释放 | 部分：空状态/低高度布局通过，生成与失败链路待做 |
| W19 | 全部入口、首次/重开/切换、语言、Tab/Escape、窗口操作、隐藏问题复测 | 部分：65 工具巡视、页面过渡矩阵和 13/13 PDF/PPT 浏览器场景通过；语言切换、窗口按钮及全部真实输出链路仍待最终矩阵 |
| W20 | 最终 focused/release/security/CLI/Rust/build/diff/敏感信息审核与报告 | 中期门禁已跑通，最终需重跑受影响门禁 |

## 初始问题与已证实根因

| 现象 | 根因/责任边界 | 修复与证据 |
| --- | --- | --- |
| PPT 转 PDF 上传后空态不消失 | 依赖 `.ppt-images-empty[hidden]`，却未加载图片提取的懒加载 CSS | 共享样式下沉到 `styles/components/ppt-workbench.css`；转换页自己声明 hidden 语义 |
| PPT 页面超长或不填满窗口 | `.feature-tool-overlay.visible { display:block }` 覆盖原来 grid 根布局 | `styles/pages/ppt.css` 为这 7 个直接承载 topbar/body 的根节点恢复 grid |
| PPT 转换/文本导出不可见 | 复用上传前进场按钮，缺少图片提取 CSS 中 opacity/transform 的恢复规则 | 共享导出原语恢复；浏览器同时检查 opacity、命中层、可滚动范围，不能只检查按钮坐标 |
| PPT 转图像摘要多余胶囊、白底灰字 | 特定 feature 样式和通用按钮继承竞争 | `ppt-render.css` 去掉摘要框；主按钮黑字、正常透明度；小窗口明确滚动 owner |
| 三个 PDF 选页不覆盖导航 | `pdf-common.css` 的工作区沿用旧版 `top:64px` | 改为 top:0；浏览器检查遮罩坐标和顶部命中层 |
| 鼠标垂直滚轮不横向移动 | 迁移后的三个预览模块没有 wheel 绑定 | 共享 `shared/horizontal-wheel.js`，会话持有 disposer，RAF 合并，保留 Ctrl 缩放和表单行为 |
| Escape 关闭选页时连整个工具一起关闭 | lazy registry 的 microtask 兜底会在原生事件的监听器之间执行，早于 feature 的 preventDefault | 使用 lifecycle 的零延时任务等完整事件派发结束；真实浏览器验证返回工具而非首页 |
| 背景区域可能被重新启用 | 全局 modal observer 只根据 visible 恢复 inert，覆盖 sibling modal 的交互锁 | `setModalInteractivity` 记录显式交互状态，真实可见性改变时仍正确同步 |
| PDF 转图像选中页没有勾号 | `.pdf-split-workspace-tile.is-selected` 的显示规则只在拆分 CSS 中 | 提取 `components/pdf-page-selection.css`，两个懒加载 CSS 显式引用；浏览器断言勾号 opacity |
| PPT 转 PDF 提示出现 `{images}`，失败文案说图片提取 | 中英 JSON 中图片提取的错误/成功 keys 错放在 pptToPdfPage，重复 key 覆盖 | 将 keys 移回 pptImagesPage；契约测试校验各自参数和必要错误 key |
| PDF 编辑器始终禁用 | 加载时序和插入门禁已覆盖普通/90°旋转 PDF；现有文字编辑限制仍只针对原始旋转文字层 | 插入、撤销/重做、浏览器导出通过；桌面输出和多轮重开仍由 W19 覆盖 |

## 本轮文件与契约

- `app/modal-runtime.js`：在既有 modal owner 中补显式交互锁、会话级焦点/Tab/Escape 管理，没有另造弹框模板。
- `app/lazy-tool-registry.js`：修复 Escape 兜底时序，保留进入、关闭、实例缓存和全部原接口。
- `features/pdf-split/preview.js`、`features/pdf-rotate/preview.js`：复用共享滚轮和模态会话；各自 tool 只注入原 overlay。
- 三个 PDF 工具的模板/CSS/preview/view：全屏、焦点、选择视觉；split/rotate 补 role/dialog/inert，未新增 DOM ID。
- `features/ppt-render/`：转换页独立布局、滚动复位、摘要及按钮状态。
- `features/ppt-images/`、`features/ppt-workflows/`、`features/ppt-draft/tool.js`：显式加载共同的 PPT UI 原语；不导入另一个工具的私有 CSS。
- `locales/zh.json`、`locales/en.json`：纠正误放的 PPT 错误提示。
- 新增 `scripts/test-horizontal-wheel.mjs` 与 `scripts/test-pdf-ppt-browser.mjs`；现有 modal/lazy/PDF/PPT contract 增加对应断言。
- 新增 `scripts/qa-pdf-to-image-ui-modes.mjs` 与 `npm run qa:pdf-to-image-ui-modes`，用于当前 Tauri WebView 的 1–21 页条件导出按钮矩阵；报告写入被忽略的 `tmp/pdf-to-image-ui-modes-report.json`。
- PDF 转图像新增 `features/pdf-to-image/export-modes.js`，core 与 Rust 原生端支持 `long-horizontal`、`grid`，不改变原 `images`/`long` 请求。
- PDF 压缩新增目标大小规范和 `targetSizeMb` processor/native 参数；目标选择会使用最高 qpdf 流压缩，并在无法缩小图片流时仍发布有效结果、标明未达到目标。
- 新增 npm 命令 `test:pdf-ppt-browser`；共享滚轮单测纳入 `test:architecture`。没有改 native/CLI/MCP/storage/event 契约或版本。

## 验证矩阵快照

| 工具 | 首次进入/上传/布局 | 选择区/关闭 | 完整输出/异常/重开/语言 |
| --- | --- | --- | --- |
| PDF 编辑器 | 六页普通 PDF 手动 Playwright 诊断通过 | 待完整回归 | 22 个已有 focused 脚本通过，端到端待补 |
| PDF 拆分 | 通过 | 全屏、顶部命中、滚轮、Escape、交互恢复通过 | 原有 core/contract 通过，完整 GUI 导出待补 |
| PDF 旋转 | 通过 | 全屏、顶部命中、滚轮、Escape、交互恢复通过 | 原有 core/contract 通过，完整 GUI 导出待补 |
| PDF 转图像 | 通过 | 以上及选中勾号通过 | Windows Tauri 原生横向/田型输出、唯一命名、取消和临时会话清理通过；全局 GUI 重开矩阵仍由 W19 覆盖 |
| PDF 压缩 | 原生样本与 IPC 通过 | 目标选择/无收益/不可达/取消契约通过 | 输出结构、页数和体积已验证；GUI 多语言与逐样本视觉复核仍由 W13/W19 覆盖 |
| PPT 转 PDF/图像 | 低窗口上传和托管 LibreOffice 原生转换通过 | 摘要、空态、滚动、导出可见且黑字通过；PPT 转图像中间 PDF 关闭清理通过 | 真实 PDF 输出 4 页、取消、无效输入和唯一目录通过 |
| PPT 图片提取/文本提取/压缩 | 3 个低窗口上传场景通过 | 导出按钮不透明、正确 grid 根通过 | 完整 GUI 导出与重开/语言待做 |
| PPT 大纲/草稿 | 低高度空状态和根布局通过 | AI 生成、失败和成功弹框待做 | 不使用真实用户密钥发起验证请求 |

## 本轮门禁结果

- `npm run test:release`：88 个 npm 脚本通过，包含现有 PDF/PPT core/runtime、安全（967 项）、CLI package/clean-worktree/MCP、架构与 build（本轮最新代码重跑）。
- 套件构建时出现 CSS @import 位置警告，已移动至文件开头；随后独立 `npm run build` 通过，仅保留既有大 chunk 与 crypto externalization 提示。
- 改动后的 `npm run test:architecture` 和四个 PPT tool-contract 另行重跑通过。
- `cargo test --manifest-path src-tauri/Cargo.toml`：94 passed，0 failed，1 ignored；最新原生模式和压缩代码编译/测试通过。跳过项要求 LibreOffice 和外部 Excel QA 文件，不能记为已验证。
- `npm run test:pdf-ppt-browser`：13/13 场景通过（普通/旋转编辑器、3 PDF 选择区、5 PPT 上传页、压缩目标选择、大纲/草稿空状态）；截图和逐项 JSON 输出位于忽略目录 `tmp/pdf-ppt-regression/`。
 - 新增模式单测：PDF 转图像 core、模式门禁、原生 grouping/naming 通过；Rust PDF-to-image backend 16 项通过。浏览器田型真实下载通过。
 - Windows Tauri 原生 QA：`npm run qa:pdf-to-image-native` 已通过，逐项报告位于 `tmp/pdf-to-image-native-report.json`。横向长图 PNG/JPG/WebP 输出均非空且尺寸正确；4 页为 `2x2`，5/6 页为 `2x3`，7/8/9 页为 `3x3`，均验证 PNG/JPG/WebP 解码和页面序列。
 - 原生发布闭环额外验证：相同输出名第二次导出生成 `_1` 唯一文件且不覆盖首批结果；成功后输出目录无 `.toolknit-pdf-image-*` 临时文件；活动取消返回 `cancelled`、不发布输出并删除页面会话；进度事件包含 `prepare/inspect/compose/encode/publish/complete` 且单调到 100%。QA 使用 `%TEMP%\toolknit-pdf-to-image-native-qa`，未把测试输出写入仓库。
 - 当前构建 UI 复测：`npm run qa:pdf-to-image-ui-modes` 通过 1–21 页选择数量；田型按钮 4–9 页可见可用，其他数量隐藏且不可命中，横向按钮 2–20 页可见可用。原先 disabled 样式将隐藏按钮 opacity 覆盖为 `0.36`，已用更具体的条件选择器修复并由 `test-pdf-to-image-tool-contract.mjs` 锁定。
 - QA 初次事件采样发现 group 内 `encode` 后回退到下一组 `compose` 的进度问题；已在 `src-tauri/src/native_runtime/image/pdf.rs` 将每组 compose/encode 放入连续进度区间，并在 `pdf_tests.rs` 增加单调性断言，Rust focused 与真实 Tauri QA 均通过。
- PDF 编辑器浏览器用例覆盖普通六页 PDF 的文字/矩形/椭圆插入、撤销、重做和有效 PDF 下载，以及 90° 旋转 PDF 的形状插入。
- 浏览器用 Edge headless、生成的无隐私 PDF/PPTX，尺寸 1366x768 与 1366x620。当前环境未发现 `soffice/libreoffice`，因此没有伪造 PPT 原生转换通过；原生验证需依赖安装/下载 Office 渲染运行时后再执行。
- 单元与浏览器测试用途不同：前者检验资源/状态契约，后者检验真实派发时序和 CSS 加载顺序。不能用一方替代另一方。

## 运行浏览器套件

需要可用的 Vite 地址（默认 1420）、Playwright、PptxGenJS 和 Chromium。若项目中没有测试依赖，可用环境变量指定本机测试运行时，无需修改应用依赖：

```powershell
$env:TOOLKNIT_TEST_MODULES = '<测试 Node node_modules 目录>'
$env:TOOLKNIT_TEST_BROWSER = '<Edge 或 Chromium 可执行文件>'
$env:TOOLKNIT_TEST_URL = 'http://127.0.0.1:1420/'
npm run test:pdf-ppt-browser
```

调试 Vite 使用 `--mode tauri-debug`，HMR 关闭。每次改动后页面完整重载。测试产物不进入发布包。

## 2026-09-06 夜间增量

- N1 竖纹背景：新增共享 `src/styles/components/vertical-stripe-surface.css`，并接入图像裁剪、智能颜色替换、长图拼接、音频剪辑波形面板和提词器台词输入容器。五处均通过 `test-vertical-stripe-surfaces.mjs`、相关 feature focused tests、浏览器 computed style 和 1366x768 截图检查；没有改变输出像素、取色、裁剪或音频逻辑。
- N2 页面过渡：新增 `src/app/page-transition-runtime.js` 和 `src/styles/components/page-transitions.css`，通过单一 inert 视觉幕接入 lazy tool、工具返回、设置、帮助、反馈和法律页面；具备 revision 串行、异常 finally 收尾、生命周期释放和 `prefers-reduced-motion` 降级。页面业务 close/cancel 不等待视觉动画。
- N2 验证：`test-page-transition-runtime.mjs`、`test:architecture`、`qa:page-transitions` 均通过；覆盖普通进入/返回 10 轮、快速切换 30 轮、设置/帮助 10 轮、`prefers-reduced-motion`、1024x480 低高度和过渡中间态，控制台无新增错误/警告。
- N3 PDF 压缩：`qa:pdf-compress-samples` 与 `qa:pdf-compress-native` 均已在 2026-09-06 刷新通过。样本矩阵覆盖文本、扫描型、图片型、约 5.7MB 不可达目标、80 页大文本和已优化无收益；真实 Tauri IPC 覆盖 5/10/15/20/50MB 目标、`target_reached`、无收益不发布、不可达目标保留有效输出、取消无输出、重复唯一命名和临时文件清理。W10/W11 已完成，W13 仍只保留多样本视觉可读性缺口。
- 新增夜间账本与问题清单：`docs/V3_OVERNIGHT_PROGRESS.zh-CN.md`、`docs/V3_OVERNIGHT_BUGS.zh-CN.md`。外部 Playwright 已通过工作区运行时接入，托管 LibreOffice 26.2.5 已通过真实转换；未使用用户密钥、未发布、未改版本。
- N4 全工具巡视：`npm run qa:tool-sweep` 严格模式通过，按 `src/features/lazy-tools.js` 实际注册表检查 65/65 工具；全部入口可打开/关闭，关闭后焦点离开隐藏 overlay，无未预期错误/警告。
- PPT 原生证据：`npm run qa:ppt-native` 与 `npm run qa:ppt-ui-native` 通过；前者覆盖 4 页真实 PDF、无效输入、取消、唯一目录和临时目录，后者覆盖 PPT 转图像中间 PDF、页选择器、关闭清理和重开。QA 等待条件已兼容静态工具卡与首页卡，降低 reload 竞态误报。

## 2026-09-11 PDF 裁剪增量

- 修复多页缩略图卡片内容越界，常规窗口固定为 132px 宽，低高度窗口固定为 110px 宽；标题和状态保持在卡片内并安全截断。
- 裁剪拖动改为单帧 RAF 合并：`pointerdown` 缓存边界，移动期间只更新当前裁剪框和尺寸标签，页状态、历史、控件和缩略图只在 `pointerup` 后提交一次。
- 新增 feature 内部可暂停缩略图渲染队列。拖动开始会取消正在运行的 PDF.js 缩略图任务，拖动结束后重排并继续，避免 24 页等大文档在交互期间争用主线程；`pointercancel` 不再误提交裁剪。
- 导出区拆分为“导出当前预览页”和“导出全部页”。前者生成有效单页裁剪 PDF，后者保留 04 区域的单 PDF/ZIP 逻辑；两者分别按当前页和全局裁剪状态启用。
- PDF.js 的 CMap、标准字体和 WASM 改为随构建提供版本匹配的本地资源，浏览器回归未再出现 ICCBased/QCMS WebAssembly 警告。
- 24 页 Edge 浏览器回归通过：6 倍 CPU 限速时有 15 个缩略图未完成，拖动期间列表 0 次变更；正常速度下 96 次密集指针移动约 85.4 FPS，P95 帧间隔 20.8ms，深色/白色及 1400x887、720x480 布局均通过，当前页输出为 1 页、全部输出为 24 页。报告位于忽略目录 `tmp/pdf-crop-browser/report.json`。
- `npm run test:release` 通过 89 个 npm 脚本；focused crop、PDF.js 资源、主题、架构、CLI/MCP、Rust 和生产构建均通过。仅保留既有大 chunk、browser crypto externalization 和行尾提示；本轮未打包、提交、推送或发布。

## 下一步

### 2026-09-12 PDF 旋转专用工作台

- 已按拆分模板接入公共导航、三栏布局、按需缩略图和滚轮缩放。旋转 feature 管理当前/所选/全部范围、左右 90 度及恢复原方向；共享视图通过可选角度读取与局部刷新扩展，不复制导航或编辑器业务。
- 当前预览页可独立于勾选导出；全部/所选页合成 PDF，独立页生成单页 PDF ZIP。复用原旋转核心叠加原始方向，在 Worker 内组装并重新打开验证输出；拆分与旋转共用任务取消、超时、错误和销毁 owner。
- 精确对比了上传页与工作台的导航字号、字重、文字/图标颜色、尺寸、静止和悬停状态，两套主题一致。统一 PDF 家族旧支持按钮悬停规则。窄屏共享网格行高对齐预览最小高度，避免预览覆盖操作区。
- 24 页浏览器回归通过：原始 90 度加旋转 90 度输出为 180 度、未勾选当前页导出、23 页子集 PDF、23 个有效单页 ZIP、范围切换/恢复原方向、空选择禁用、Worker 失败恢复/取消无下载、设置返回、语言切换、Escape、资源释放及重开。两种主题四种尺寸无面板重叠，控制台无非预期错误或警告。
- 拆分模板浏览器回归通过，导航和 31/45/64/93/134% 缩放回归通过，稳定采样无画布隐藏或尺寸抖动。证据在忽略目录 `tmp/pdf-rotate-workbench/`、`tmp/pdf-split-workbench/` 和 `tmp/pdf-workbench-interaction/`。
- PDF/PPT 综合浏览器回归 13 项通过；旧页面选择检查按拆分/旋转工作台的新滚轮缩放契约更新，PDF 转图像仍验证原横向选择区。
- focused、architecture、build、89 项 release 脚本（含安全与 CLI/MCP）通过；Rust 131 passed、2 ignored。仅保留既有构建提示。未验证本轮打包 EXE 或所有大型扫描文档；本轮未打包、改版本、提交或发布，等待用户验收旋转后再迁移转图像和合并。

### 2026-09-12 PDF 拆分专用工作台模板

- 仅迁移 PDF 拆分：共享导航、左侧按需缩略图与勾选、中间预览及缩放、右侧导出。复用已验收 PDF 编辑器的布局类和公共深浅主题；共享视图不导入编辑器业务。多文件上传能力保留，返回上传页保留输入，关闭工作台释放文档、渲染任务与画布。
- 三种导出：当前预览页独立于勾选，全部/所选页合成一个 PDF，所选独立页逐页生成 PDF 后打为 ZIP。空选择禁用合成和 ZIP；同名源文件的 ZIP 条目加顺序前缀。导出组装进入独立 Worker，支持取消、五分钟超时、失败恢复和生命周期销毁，原生输出沿用唯一文件写入命令。
- 新增 `pdfSplitWorkbenchActions`、`pdfSplitDownloadCurrentBtn`、`pdfSplitDownloadZipBtn`、`pdfSplitProcessCancel`；保留旧页面容器、PageStrip/PageStage、返回及主导出 ID。不新增 storage、原生命令或 CLI/MCP 参数，旧拆分核心接口不变。
- 核心测试验证多源文件页序、尺寸、90 度旋转、PDF/ZIP 输出和 Worker 成功/错误/取消清理。Edge 浏览器验证 24+2 页、多文件、按需缩略图、非空预览像素、当前未勾选页输出、25 页子集 PDF、25 个有效单页 ZIP、零选中禁用、取消无下载、设置返回、两种主题四种窗口尺寸、英文、关闭重开及 Escape；无页面错误或警告。证据保存在 `tmp/pdf-split-workbench/`。
- 共享主题浏览器回归、focused、architecture、build 通过；发布门禁 89 项脚本通过（包含安全和 CLI/MCP）；Rust 131 passed、2 ignored。保留既有大 chunk、crypto externalization、linker 和传递依赖弃用提示。本轮未验证打包 EXE 的原生保存和大型扫描文件，未打包、提交、改版本或发布。后续旋转、转图像、合并分别等待用户验收后迁移。

### 2026-09-12 PDF 编辑器白天主题

- 编辑器接入 `pdf-workbench-light.css` 的公共面板、导航、主按钮、禁用、处理和成功弹框规则；新增 `pdf-editor-light.css` 仅维护工具状态、缩略图、对象轮廓/手柄、形状面板和文字编辑弹框。保留原有三栏、DOM ID、命令与导出契约。
- 主题不改变透明文字命中层、覆盖原文的遮挡层、插入文字和图像、SVG 填充/描边。浮动工具条取消重模糊，选中边缘使用黑白双层对比；不改变显隐生命周期。
- 截图检查发现缩略图完成加载后骨架仍显示、序号被画布遮住；在编辑器基础样式中补齐 ready 状态和角标层级，两种主题均生效，补充缩略图契约测试。
- 浏览器回归通过：空状态、六页文件上传、文字插入弹框、形状插入与颜色修改、深浅主题内容颜色隔离、撤销/重做、旋转/撤销、四种窗口尺寸导出可达、中英文、有效六页 PDF 输出、成功弹框、关闭重开和 Escape；裁剪和加页码共享主题用例同时通过。报告与截图位于 `tmp/pdf-workbench-theme/`，未捕获页面异常。
- 编辑器 22 项 focused 脚本、生产构建、89 项发布脚本（包含架构、安全和 CLI/MCP）通过；Rust 131 passed、2 ignored。保留既有构建提示，未测试打包 EXE 或真实大型扫描文档，本轮没有打包、提交、改版本或发布。

### 2026-09-12 PDF 加页码白天主题

- 以已验收 PDF 裁剪为基准，提取 `src/styles/themes/pdf-workbench-light.css`，两页共同引用面板、主按钮、预览背景、导出底栏、下拉菜单、禁用状态和弹框样式。裁剪特有样式保留在 `pdf-crop-light.css`；加页码的队列、九宫格、样式示例、滑块和颜色输入由 `pdf-page-number-light.css` 管理。
- 保留加页码三栏和原有 DOM/导出契约；主题不改 PDF 页码颜色值和预览标注。修复加页码下拉菜单 Escape 导致整页退出的问题，支持鼠标打开和菜单按键已处理两种路径。
- `test-pdf-workbench-theme-browser.mjs` 通过两页空状态配色、禁用、下拉、选择、排序、删除/撤销、深浅主题、中文/英文、1400x887 / 1100x700 / 900x520 / 720x480、有效六页 PDF 导出、成功弹框、关闭重开及 Escape。报告和截图位于忽略目录 `tmp/pdf-workbench-theme/`。
- PDF 裁剪原有浏览器回归通过，覆盖 24 页夹具、缩略图暂停、两种主题、低高度布局、当前页/全部页导出。该夹具与自动化帧采样不代表所有扫描大文件或用户硬件的固定帧率。
- focused、主题、架构和生产构建通过；`test:release` 89 个脚本通过（含安全和 CLI/MCP）；完整 Rust 131 passed、2 ignored。保留既有大 chunk / crypto externalization / Windows linker 提示。
- 已将公共样式归属与基准约定写入维护指南。本轮未打包、改版本、提交或发布。

### 2026-09-12 PDF 转图像专用工作台

- 以已验收 PDF 拆分/旋转工作台为公共模板，迁移 PDF 转图像的页面选择流程：共享工具页导航、左侧按需缩略图与勾选、中间预览和滚轮缩放、右侧格式/清晰度/长图及田型导出操作均保留。
- 通过 `ids` 适配保留 PDF 转图像现有 DOM 契约、导出模式和 Tauri 任务接口；未新增 storage、原生命令或 CLI/MCP 参数。页面状态由共享工作台维护，原工具控制器继续负责文件加载、导出和进度生命周期。
- 修复迁移后的两个初始化缺陷：共享工作台首次选中状态回调访问未完成初始化的 preview；旧控制器访问已不存在的 `selectButton` 状态引用。另移除工具控制器与共享工作台之间的翻译刷新递归。
- 更新 PDF 转图像契约测试和 PDF/PPT 浏览器回归选择器，保留缩放、选中状态、田型导出、成功弹框、Escape、关闭重开和无控制台错误检查。
- `test:pdf-to-image`、`test:pdf-to-image-tool-contract` 和 PDF/PPT 综合浏览器回归均通过；本轮未打包、改版本、提交或发布，等待用户验收后再迁移 PDF 合并工作台。

 优先补完 W13 多样本视觉可读性、W16-W18 PPT 内容输出矩阵和 W19 语言/窗口操作回归，再执行最终门禁。整轮未完成前不标记目标完成、不打包、不发布、不推送、不改版本。
