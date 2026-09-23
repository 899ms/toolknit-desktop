# ToolKnit V3 夜间巡视问题清单

启动：2026-09-06。只记录本轮已复现或有明确证据的问题；未验证内容不写成通过。

| ID | 严重度 | 工具/范围 | 状态 | 证据与下一步 |
| --- | --- | --- | --- | --- |
| ENV-001 | 环境阻塞 | PDF/PPT 浏览器回归 | 已解除 | 通过 `TOOLKNIT_TEST_MODULES` 接入工作区 Playwright/PptxGenJS 和 Edge，`npm run test:pdf-ppt-browser` 13/13 场景通过；未修改项目依赖 |
| ENV-002 | 环境阻塞 | PPT/Excel 原生转换 | 已解除（托管运行时） | 系统 PATH 无全局 `soffice`，但 ToolKnit 托管 LibreOffice 26.2.5 已被应用检测；`qa:ppt-native` 与 `qa:ppt-ui-native` 真实转换和中间文件清理通过，WPS 未作为证据 |
| QA-001 | 低风险 | PPT UI 原生 QA reload 清场 | 已修复且复测通过 | 首次运行在上一个浏览器场景的异步回调尚未完全退出时，入口等待条件偶发误报。`qa-ppt-ui-native.mjs` 现在同时等待静态工具卡/首页卡并在 reload 前清空旧日志；后续原生 UI QA 连续通过 |
| PDFIMG-001 | 低风险 | PDF 转图像条件导出按钮 | 已修复且复测通过 | 复现于当前 Tauri 构建：选中 1–3 或 10–21 页时，按钮虽已 `aria-hidden=true`、禁用且不可命中，但全局 disabled 规则将退场 opacity 计算为 `0.36`。在 `features/pdf-to-image/pdf-to-image.css` 增加 `.pdf-to-image-conditional-export:not(.is-available):disabled { opacity: 0; }`；`test-pdf-to-image-tool-contract.mjs`、`qa-pdf-to-image-ui-modes.mjs` 和当前构建 1–21 页矩阵通过。 |

## 2026-09-06 页面转场叠影修复

- 用户复现：首页进入 PDF 编辑器时，黑幕渐显阶段透出首页，首页卡片与工具内容叠在一起。
- 根因：`open()` 返回只表示 `.visible` 已设置，不代表工具根 overlay 的 300ms CSS opacity 过渡已结束。黑幕的 400ms 渐显与工具淡入同时运行，两层都半透明。首次创建黑幕时也没有计算透明起始样式，导致闭幕首帧直接变黑。
- 返回路径另有竞争：全局捕获监听启动转场后仍放行原点击，feature 返回监听会提前隐藏页面，并且稍后 registry 再关闭一次。
- 修复 owner：`app/page-transition-runtime.js` 在透明起点建立后闭幕，等待实际遮幕动画完成，在纯黑下等待根 overlay 的有限 CSS 过渡及绘制帧完成后再开幕；不等待背景循环动画。dispose 取消等待，不重建遮罩。保持纯黑、300ms/400ms、无位移的样式参数。
- 返回 owner：`lazy-tool-registry.js` 与 `shared/tool-page-shell.js` 只接管已注册页面根节点的返回，抑制重复 feature 点击；保留 `close() === false` 的关闭否决和内层编辑器/弹框自己的返回行为。
- 逐帧证据：`node scripts/test-page-transition-browser.mjs` 在 Edge 和实际 Tauri WebView 中各通过 22 个场景，覆盖首次、重开、返回、设置/帮助、快速切换、4 倍 CPU 降速、1024x480 和 reduced-motion。每一帧揭幕时目标 overlay 的 opacity 均为 1；截图确认没有首页叠影。报告和截图位于被忽略的 `tmp/page-transition-frames/browser`、`tmp/page-transition-frames/webview`。
- 测试使用当前 Vite 源码。旧调试窗口的 `tauri.localhost` 内嵌资源不能代表最新代码；不得把旧窗口上的检查标为新构建验证。
- 本次门禁：focused/architecture 通过；`npm run test:release` 全部 88 脚本通过（包含 security-release 967 项和 CLI/MCP）；Rust 全量 96 passed、1 ignored；生产 build、Tauri NSIS 打包与 `git diff --check` 通过。安装包版本保持 2.3.1、DevTools 关闭、未签名；没有提交、推送或发布。此前尚未完成的 PDF/PPT 人工矩阵仍留待用户实测，未因本次打包而标记完成。

## 先前检查记录

- 五处指定竖纹背景的 focused、computed-style 和本地浏览器截图均通过。
- PDF 转图像横向/田型原生输出、唯一发布、取消清理和条件按钮 1–21 页 UI 矩阵均通过；证据位于 `tmp/pdf-to-image-native-report.json` 与 `tmp/pdf-to-image-ui-modes-report.json`。
- 共享页面过渡的架构契约、基础工具/设置/帮助切换、快速 30 轮、低高度、减少动态效果和完整 Playwright 中间态均通过；控制台无新增错误/警告。
- `qa:tool-sweep` 严格模式按实际 lazy registry 检查 65/65 工具，均可打开/关闭，关闭后焦点离开隐藏 overlay。
- 当前未发现需要立即自动修复的数据损坏、文件覆盖、密钥外传或公开契约破坏问题。
