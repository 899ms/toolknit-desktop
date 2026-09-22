# ToolKnit Desktop 3.0.0 发布前检查

检查日期：2026-09-21。基于本地 `ToolKnit-Desktop-V3.0-正式版` 工作区；保留已有修改。
本次目标为本地生产安装包，不代表已发布到 GitHub 或 npm。

## 冗余与修正

- 移出无引用的 `public/controls.html` 和根级旧 `openjpeg.wasm`、`qcms_bg.wasm`，共 344,325 字节。
  本地备份在忽略目录 `tmp/v3-release-redundant-assets/`；PDF.js 继续使用与依赖版本一致的 `assets/pdfjs/` 资源。
- 确认旧 Inter、Fonarto 字体和旧首页网页截图不进入 dist。
  保留 Alibaba PuHuiTi、Montserrat、Noto Sans SC 各两种字重，分别服务界面和 PDF 渲染/导出，保留授权文件。
- AI 文档、AI 表格的开发演示数据可被生产构建剔除，开发预览和测试仍可使用。
- 合并中英文重复的 `common` 字典组，恢复被覆盖的 `openLinkFailed` 文案。
- 移除设置页白天主题对通用导航圆角的重复覆盖，恢复共享控件形状。
- 帮助概览、英文 README 和当前更新说明对齐实际 68 个桌面工具、46 项 CLI/MCP 能力。
- 修复安全检查读取已删除字体导致的 ENOENT，并覆盖非忽略的新源码；native 安全断言读取实际领域模块。
- 添加独立产物检查并接入发布门禁，避免删除的旧资源、开发演示和调试文件再次进入 dist。

静态资源检查结果：17 个 public 文件、492 个构建文件、31 个原生资源文件；
public 文件无相同 SHA-256 的重复副本，依赖名称引用检查未发现无引用候选项。
没有全量删除兼容转发层，也没有根据单次文本匹配删除依赖或动态加载代码。

## 生产配置

- 桌面 package、锁文件、Tauri、Rust 和 CLI 的版本一致为 3.0.0，应用标识沿用 `com.toolknit.desktop`。
- 使用默认生产 Tauri 配置；主窗口 DevTools 为 false，无远程调试参数，不启用 `qa-devtools` feature。
- 使用 release 编译，默认 feature 为 `custom-protocol`；保留现有生产 Info 日志和错误反馈。
- 维持本地文件及密钥安全边界、CSP、按需运行时下载和明确的原生资源列表。
- Windows x64 NSIS，支持中英文安装器并内嵌 WebView2 引导程序；不改安装标识或用户设置路径。
- 首次 V3 白天主题、已有用户设置保留、深色默认壁纸和启动加载遮罩保持现有契约。

## 验证记录

- 完整 `test:release`：94 个脚本通过，包含 CLI/MCP、安全及架构检查；新增产物门禁另行通过。
- 后续变更复核：AI 文档/表格契约、帮助、版本、架构、PDF.js 资源、安全和构建均通过。
- 安全检查 1227 项通过；`npm ls --omit=dev --depth=0` 正常；生产 npm 依赖审计报告 0 个已知漏洞。
- 完整 Rust：164 passed、3 ignored、0 failed。忽略项未记作已验证。
- Edge 页面切换：白天和深色各自覆盖首次打开、返回、重开、设置/帮助、英文、快速切换、CPU 限速、
  低高度/640–1366 宽度、减少动画和焦点；两套均通过。白天布局按实际配色和 980px 断点验证。
- Edge 启动遮罩：4 组通过，覆盖双主题、入口脚本/字体/壁纸延迟、字体失败、减少动画、
  1400/1024/390 窗口、输入恢复、主题切换、设置返回和缓存重载，无新增控制台异常。
- `git diff --check` 通过。

## 生产安装包

`npm run tauri -- build` 成功，release 编译与 NSIS 打包均完成。
最新 Cargo 指纹的 features 为 `["custom-protocol", "default"]`，不包含 `qa-devtools`。

- 文件：`src-tauri/target/release/bundle/nsis/ToolKnit-Desktop-V3.0.0-Production-20260921-setup.exe`
- 生成时间：2026-09-21 15:12:41（Asia/Shanghai）。
- FileVersion / ProductVersion：3.0.0 / 3.0.0。
- 大小：54,505,672 字节（51.98 MiB）。
- SHA-256：`7C3FABCC234EADEEC6DCFDD60F27145DC9B321F61E5780FFC0EB10D50B719DC1`。
- Authenticode：`NotSigned`，未配置代码签名；没有将未签名文件描述为已签名发布。
- 带日期的生产文件与 Tauri 默认产物哈希一致，旁边保存同名 `.sha256` 校验文件。

打包后的前端资源再次通过独立产物检查。当前安装版进程仍在运行，没有结束用户进程、
启动第二实例转发或执行覆盖安装，因此本轮未验证新包在干净 Windows 环境的安装与首次启动。
安装包可用于最终安装验收；本地打包成功不代表已执行线上发布。

## 范围限制

既有大型 JS chunk、浏览器 crypto externalization 与 Windows linker 提示保留，未通过隐藏警告处理。
静态检查不能证明所有动态路径没有冗余，浏览器回归也不能替代所有 Windows/WebView2 设备实测。
不自动提交、推送、安装覆盖当前正在运行的程序或对外发布。
