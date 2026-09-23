# 窗口圆角刷新与滚动修复

日期：2026-09-10。范围为公共窗口表层，不修改工具页、圆角偏好、原生命令、阴影算法或发布配置。

## 根因与最小修复

原生 WebView2 152.0.4191.66 中复现：首页刷新及工具返回后角部被填白，滚动中透明度反复变化，
但保存的 32px 半径、CSS clip-path 和窗口状态均未改变。关闭阴影没有消除问题；只改变 body
底色就能改变错误角部的颜色。问题属于不透明 body 背景与文档裁切的合成冲突。

`src/styles/components/window-surface.css` 在现有
`body.use-css-window-radius:not(.window-is-maximized)` 规则内增加透明背景。
沿用已有背景规则的优先级；可见底色继续由 `.app`、工具和弹层自身负责。未启用圆角、最大化、
全屏的实心底色保持原行为；不加定时重绘、不逐页复制圆角，也不调整层级或 Win32 区域。

## 验证

- `test-window-radius-rendering.mjs` 新断言先在旧实现失败，再在修复后通过；原阴影状态契约通过。
- `scripts/test-window-radius-browser.mjs` 使用 PNG 实际像素，而不是只断言 CSS 值。
  浏览器与隔离原生 WebView2 各 62 个采样通过：深浅主题、0/10/18/32px、反复刷新、36 次滚轮采样、
  PDF 压缩/合并及设置页往返、最大化 CSS 状态和恢复。四角透明时同时验证页顶中部保持不透明，
  防止把整个页面误设透明。最大化在此为 CSS 状态验证，不宣称执行了真实最大化或切换显示器。
- 原生验证使用临时命令行配置的独立 identifier 和 WebView2 数据目录，未操作用户测试实例，
  不下载依赖、转换文件或修改系统显示设置。诊断实例完成后关闭；原安装包未变化。
- 截图和逐采样数据保存在忽略目录 `tmp/window-radius-fix/browser`、`native`。

常规回归（先 build，测试运行中不能再次 build 清空 dist）：

```powershell
npm run test:window-radius
npm run build
node scripts/test-window-radius-browser.mjs
```

浏览器沿用 `TOOLKNIT_TEST_MODULES` / `TOOLKNIT_TEST_BROWSER` 环境变量。
原生模式还须显式指定隔离实例的 `TOOLKNIT_CDP_ENDPOINT` 和
`TOOLKNIT_TEST_ISOLATED_NATIVE=1`；脚本会临时调整该实例的主题和圆角并恢复偏好，
不得连接用户正在使用的实例。浏览器及原生截图均不注入修复 CSS，验证实际构建内容。

仍需其他设备核对不同 Windows/GPU/DPI 下的真实桌面边缘；本轮不额外调整首屏启动顺序。
未打包、改版本、提交、推送或发布。

## 补充门禁与既有问题

- 发布门禁 `npm run test:release` 的 89 个脚本通过，包含安全 977 项、CLI/MCP、架构与前端 build。
- 架构、前端 build、圆角/阴影契约、差异格式检查通过；完整 Rust 为 128 passed、2 ignored。
  首次 Rust 链接被 Tauri 调试构建留下的 82 字节 `msvcrt.lib` 占位缓存阻塞，确认生成来源后
  仅将该缓存改名移出链接搜索，再完整重跑通过，没有修改 Rust 或编译配置。
- 扩展 `test-theme-browser.mjs` 在第 434 行仍未通过：PDF 编辑器的 `--ink` 为 `#171717`，
  旧断言要求 `#f5f5f3`。原公共 PDF 浅色选择器已经覆盖该页；在圆角关闭、本轮规则不匹配、
  恢复原背景行为时结果相同。该问题不属于本轮圆角修复，不修改页面配色或放宽断言。
  证据为 `tmp/window-radius-fix/existing-pdf-theme-mismatch.json`，不能将扩展主题套件算作全通过。
- 独立浏览器测试服务器已关闭。尝试启动常驻本地预览被当前执行环境拒绝，未绕过限制；
  不把之前的 localhost 页面或旧安装程序视为已经自动更新。
