# ToolKnit V3 夜间任务进度

启动：2026-09-06。目标仍执行中，未提交、未发布。

## 基线

- 工作区：仓库根目录；桌面端：相对目录 `toolknit-desktop/`。
- 分支：`codex/v3.0`；package 版本：`2.3.1`。启动时保留了既有未提交改动。
- 旧 PDF/PPT 工作包：14/20 已完成（70%，W04、W08、W10、W11、W14、W15 已完成）；W13、W16、W17、W18、W19、W20 仍未全部完成。
- 新增夜间目标：竖纹背景 5/5（代码和视觉验证完成）；共享页面过渡 1/1（快速切换/低高度/减少动态效果矩阵完成）；全工具巡视 65/65（严格模式通过）。

## 本轮状态

| 阶段 | 状态 | 证据/下一步 |
| --- | --- | --- |
| N0 基线与矩阵 | 已完成 | 已读取 AGENTS、夜间目标、V3 维护规范、相关 feature 和导航 owner；未修改版本/分支 |
| N1 五处竖纹背景 | 已修复，验证通过 | 5/5 容器接入共享 class/token；focused、computed-style 和 1366x768 可视验证通过，未改输出像素逻辑 |
| N2 共享页面过渡 | 已完成 | 已接入 lazy tool、工具返回、设置、帮助、反馈和法律；普通/快速切换、减少动态效果、低高度和焦点收尾矩阵通过 |
| N3 PDF/PPT 剩余回归 | 执行中 | AGENTS 剩余清单第 1 项、PDF 压缩 W10/W11、PPT 布局 W04 和 PPT 原生 W15 已完成；W13/W16-W19 仍需内容和全局回归 |
| N4 全工具巡视 | 已完成 | 严格模式按 lazy registry 检查 65/65 工具，全部入口打开/关闭通过，无未预期错误/警告 |
| N5 最终交接 | 未开始 | 最终代码状态下重跑所有受影响门禁并生成晨间交接 |

## N1 记录

参考样式来自 `.text-stats-v2-textarea`：竖向 1px 细线、38px 横向间距、`rgba(0, 0, 0, .24)` 底色。

| 工具 | 容器 | 结果 |
| --- | --- | --- |
| 图像裁剪 | `.image-crop-stage-shell` | 已挂载 `.tk-vertical-stripe-surface`，浏览器 computed style 通过 |
| 智能颜色替换 | `.color-replace-stage` | 已挂载共享 class，空态截图和 computed style 通过 |
| 长图拼接 | `.image-stitch-preview-viewport` | 已挂载共享 class，空态截图和 computed style 通过 |
| 音频剪辑 | `.audio-clip-v2-wave-panel` | 已挂载共享 class，空态截图和 computed style 通过 |
| 提词器 | `.teleprompter-input` | 已挂载共享 class，台词输入截图和 computed style 通过 |

当前 CSS 契约：共享变量位于 `src/styles/components/vertical-stripe-surface.css`，全局入口显式导入；五个 feature 模板显式声明 class，feature CSS 以更高选择器优先级覆盖旧棋盘/三角纹声明。没有修改输出 Canvas、取色、裁剪、音频或提词器业务逻辑。

focused 结果：`node scripts/test-vertical-stripe-surfaces.mjs`、`npm run test:image-crop`、`npm run test:image-stitch`、`npm run test:teleprompter`、`npm run test:audio-clip`、`npm run test:color-extractor`、`npm run test:color-space-compare` 均通过。真实浏览器在本地 Vite `1420` 页面逐一打开五个工具并读取 computed style；五个目标均为 `linear-gradient(90deg, ...)`、`38px 100%`、`rgba(0, 0, 0, 0.24)`。截图确认图像裁剪、颜色替换、长图拼接、音频剪辑和提词器的指定容器均已显示细竖纹。

## N2 记录

实现文件：`src/app/page-transition-runtime.js`、`src/styles/components/page-transitions.css`，并接入 `src/app/lazy-tool-registry.js`、`src/shared/tool-page-shell.js`、`src/app/help-center-runtime.js`、`src/application-runtime.js`。过渡幕是唯一的视觉 owner，带 inert/aria-hidden、revision 串行队列、异常 finally 收尾、`prefers-reduced-motion` 降级和 lifecycle timeout；业务 close/cancel 不等待动画释放资源。设置、帮助、反馈和法律的程序化隐藏路径也会先移出焦点。

已验证：首页打开 PDF 编辑器、工具返回、工具页设置、设置帮助入口、帮助页显示和控制台 error/warn 为空；过渡结束后 veil 为隐藏、opacity 0、pointer-events none。`node scripts/test-page-transition-runtime.mjs`、`npm run qa:page-transitions` 和 `npm run test:architecture` 通过，覆盖普通 10 轮、快速 30 轮、设置/帮助 10 轮、减少动态效果及 1024x480 低高度。

## AGENTS 剩余清单第 1 项：PDF 转图像原生输出闭环

状态：已修复且复测通过（当前构建）。

- focused：`npm run test:pdf-to-image`、`node scripts/test-pdf-to-image-tool-contract.mjs`、`node scripts/test-horizontal-wheel.mjs` 均通过。
- Windows Tauri IPC：`npm run qa:pdf-to-image-native` 通过横向长图 PNG/JPG/WebP、4/5/6/7/8/9 页田型、输出非空与格式解码、尺寸和页序、唯一命名、临时文件清理、单调进度、活动取消和页面会话删除。报告：`tmp/pdf-to-image-native-report.json`。
- 当前 WebView UI：`npm run qa:pdf-to-image-ui-modes` 注入 21 页无隐私合成 PDF，逐步验证 1–21 页。田型按钮仅在 4–9 页显示并可命中；1–3、10–21 页为 `visibility:hidden`、`opacity:0`、`pointer-events:none`、禁用且 `aria-hidden=true`。横向按钮仅在 2–20 页显示。报告：`tmp/pdf-to-image-ui-modes-report.json`。
- 本轮发现并修复一个低风险视觉回归：全局 `.pdf-merge-selection-btn:disabled` 会把条件按钮的退场透明度覆盖为 `0.36`。在 `pdf-to-image.css` 增加条件隐藏选择器后，重新构建当前 `dist` 并完成上述 UI 矩阵；契约测试增加了该规则断言。
- 没有修改导出格式、页面分组、取色/文件像素、Tauri command、事件、storage、CLI 或 MCP 契约。调试端口仅存在于 `src-tauri/tauri.dev.conf.json`，生产配置仍关闭 DevTools。

## 风险和阻塞

- N1 需在最终门禁中复用 focused/build/release 证据；当前视觉验证已完成。
- W13 仍未把所有扫描/图片/大文件样本宣称为人工视觉可读性全覆盖；当前已完成结构验证和代表性 Poppler 渲染检查。
- 系统 PATH 没有全局 `soffice`，但 ToolKnit 托管 LibreOffice 26.2.5 已被应用检测并完成真实 PPT QA；不要把 WPS 作为替代证据。
- PDF 压缩样本矩阵：`npm run qa:pdf-compress-samples` 已于 2026-09-06 刷新通过，报告位于 `tmp/pdf-compress-samples-report.json`。文本、扫描型、图片型、约 5.7MB 不可达目标、80 页大文本和已优化无收益样本均通过 qpdf `--check`、页数一致和 `pdf-lib` 打开验证；auto 无收益不发布，目标请求保持有效输出并记录是否达标。
- PDF 压缩原生 QA：`npm run qa:pdf-compress-native` 已于 2026-09-06 刷新通过，报告位于 `tmp/pdf-compress-native-report.json`。真实 Tauri WebView IPC 对 5/10/15/20/50MB 目标均返回有效 3 页 PDF；另验证无收益 auto 不发布、5MB 不可达目标发布有效结果并返回 `target_reached=false`、取消拒绝且无输出/临时文件、重复输出唯一命名。代表性文本输出已用 Poppler 渲染前后首页面检查；W13 仍不宣称所有样本完成人工可读性复核。
- PPT 原生 QA：`npm run qa:ppt-native` 与 `npm run qa:ppt-ui-native` 已通过。托管 LibreOffice 26.2.5 真实生成 4 页 PDF，并通过无效输入不发布、取消无输出、重复唯一目录和临时文件清理；PPT 转图像选择器的中间 PDF 在关闭选择器/工具后均清理，重开通过。
- PDF 转图像清单第 1 项的当前构建原生/UI QA 已通过；后续只需在最终门禁中复用受影响 focused/native 证据，不把这次合成页面会话当作真实用户 PDF 全流程的替代。

## 最后门禁快照

- 新增/受影响 focused tests、`npm run test:architecture`、`npm run test:release`（88 scripts）、`npm run test:security-release`（967 checks）、`npm run test:cli`、`cargo test --manifest-path src-tauri/Cargo.toml`（94 passed，1 ignored）、`npm run build` 和 `git diff --check` 已通过。
- 构建仅出现既知大 chunk、crypto externalization 和 Windows linker 信息；未发现新的同类 warning。
- `test:pdf-ppt-browser` 已通过 13/13 场景，使用工作区外部 Playwright/PptxGenJS 运行时，不修改项目依赖。
- `qa:page-transitions` 已通过普通、快速、设置/帮助、减少动态效果和低高度矩阵；`qa:tool-sweep` 严格模式已通过 65/65 工具。
- 当前调试 Vite/Tauri 服务仍在运行以支持本轮 QA；收尾前会关闭本轮自己的进程并确认 1420/9223 释放。测试报告保留在忽略的 `tmp` 中，原生 QA 成功后临时输出目录已按脚本清理。
- TEMP 中的浏览器/测试产物不得写入仓库报告；任何真实用户文件、API Key、私人路径和屏幕内容不进入日志。

## 继续顺序

1. 补完 W13 多样本视觉可读性复核，以及 W16-W18 PPT 图片/文本/压缩/大纲草稿内容输出矩阵。
2. 完成 W19 语言切换、窗口按钮、焦点和 PDF/PPT 全部输出链路回归。
3. 最后执行 W20 全部门禁、敏感值/生成物审核并生成晨间交接。
4. 最后执行最终门禁、敏感值/生成物检查和 `V3_OVERNIGHT_HANDOFF.zh-CN.md`。
