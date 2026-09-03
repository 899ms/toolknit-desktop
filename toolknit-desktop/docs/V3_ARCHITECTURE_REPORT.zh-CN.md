# ToolKnit Desktop V3.0 架构迁移报告

更新时间：2026-09-04  
分支：`codex/v3.0`  
版本：`2.3.1`（版本号保持不变）

## 1. 结论摘要

V3.0 的 65 个桌面工具已经全部进入懒加载、生命周期可控的 feature 边界。应用壳、共享 UI、平台适配、CLI/MCP 契约和安全检查均保持现有公开协议。本阶段继续把原应用编排脚本中的高耦合职责拆成独立运行时，并补齐了对应的契约测试。

本地验证基线：

- 桌面工具：65 项，12 个分类。
- Tauri command：127 个实现，126 个唯一名称。
- CLI/MCP：46 项能力，名称和参数协议未改动。
- HTML ID：1,312 个，重复数 0。
- Rust 单测：95 个，其中 1 个 LibreOffice 外部环境测试按设计忽略。
- `src/main.js`：32 行；`src/styles.css`：4 行；`index.html`：1,663 行。
- `src/application-runtime.js`：约 2,633 行，作为应用组合根，剩余职责主要是依赖门禁、窗口/平台协调和全局弹层编排。

## 2. 文件迁移映射

### 前端应用层

| 原职责 | 当前模块 | 主要责任 |
| --- | --- | --- |
| 应用启动和依赖注入 | `src/main.js`、`src/application.js` | 启动入口、应用组装 |
| 懒加载和工具实例切换 | `src/app/lazy-tool-registry.js` | 模板挂载、动态 import、open/close/dispose、过期请求隔离 |
| 生命周期 | `src/app/tool-lifecycle.js` | listener、timer、AbortController、revision token 统一释放 |
| AI 设置 | `src/app/ai-settings-runtime.js` | 平台配置、密钥门禁、本地存储、URL 校验 |
| 外链和 GitHub 数据 | `src/app/external-links-runtime.js` | HTTP(S) 白名单、Tauri/浏览器打开、统计缓存 |
| 首页工具浏览 | `src/app/home-explorer-runtime.js` | 搜索、分类、分页、收藏、事件委托、水波交互 |
| 自定义字体 | `src/app/font-settings-runtime.js` | 字体资产导入、元数据、FontFace 加载和恢复 |
| 背景媒体 | `src/app/background-runtime.js` | 自定义背景解析、挂载、播放和销毁 |
| 输出目录 | `src/app/output-runtime.js` | 默认目录、子目录、路径校验和打开位置 |
| 更新服务 | `src/app/update-runtime.js` | 版本读取、Release 解析、缓存和延迟更新 |
| 弹层与 Toast | `src/app/modal-runtime.js`、`src/app/toast-manager.js` | 可访问性、焦点和 transient feedback |

### HTML 与样式

- `index.html` 只保留应用壳、首页首屏、全局控制和必要的 fallback。
- 设置、反馈、赞助、帮助、更新和工具模板位于 `src/app/templates/` 或对应 feature 的 `template.js`。
- 全局样式入口为 `src/styles/index.css`，基础、布局、组件、页面和兼容样式分层；工具专属样式位于 `src/features/*`。
- 静态模板使用统一的 trusted template 挂载契约；动态文本使用 `textContent`、`escapeHtml` 或经过验证的固定 HTML。

### Rust 原生层

`src-tauri/src/lib.rs` 目前只负责模块注册和公开 `native_runtime::run`。`native_runtime.rs` 通过同一命名空间的 `include!` 聚合 `core`、`dependencies`、`transcription`、`pdf`、`image`、`media`、`system`、`office` 等领域实现，保持 command 私有可见性和现有协议不变。平台安全、路径和任务注册已经位于 `platform/*`、`runtime/*` 和 `commands/*`。

这种组织避免了高风险的命令签名迁移；后续如需继续缩小单个 Rust 领域文件，应优先在同一命名空间内做 `include!` 级拆分，并为跨域私有 helper 增加明确的 `pub(super)` 边界，禁止复制安全校验。

## 3. 依赖方向

```text
app -> features -> shared/platform/core
features -> shared/platform/core
shared -> platform/core
platform -> Tauri/browser runtime
core -> no UI or platform runtime
CLI/MCP -> exported core/runtime contracts
```

feature 不得导入 `main.js`，不得直接构造 Tauri API；所有 native 调用通过 `src/platform/tauri-runtime.js` 或 feature 注入的 adapter 进入。CLI/MCP 不依赖 DOM、页面模板或 Tauri 实例。

## 4. 本阶段修复的问题

1. 帮助中心从设置页打开时，设置层会先关闭，避免两个 modal 同时 visible、焦点栈和 ARIA 状态冲突。
2. 首页收藏查找不再把工具 ID 插入 CSS 选择器，兼容不提供 `CSS.escape` 的旧版 WebView2，并消除选择器注入风险。
3. 可选模板节点缺失时，AI、外链、首页和字体运行时不会在初始化阶段因事件绑定直接抛错。
4. 版本契约测试改为读取懒加载反馈模板，修复模板迁移后的错误失败。
5. AI 设置定时器改为注入窗口对象，浏览器测试和非窗口运行环境不再依赖隐式全局。
6. Rust 中明确的兼容入口和领域标记增加 `dead_code` 语义标注，Cargo 输出不再产生无意义 warning。
7. 修复 PDF 编辑器拆分后控制器遗漏 `createPdfEditorThumbnails` import 导致的懒加载 `ReferenceError`，并在缩略图契约测试中加入导入链断裂检查。

## 5. 性能与资源生命周期

- 首页首屏不会挂载懒加载工具 DOM；工具首次打开时才加载模板、脚本和 feature CSS。
- 重复打开共享实例不会重复挂载模板或初始化；关闭工具会失效旧 revision，阻止过期异步结果写入新工具。
- feature 生命周期统一回收事件、计时器、AbortController、原生 Tauri listener、PDF.js 任务和 object URL。
- 当前生产构建主入口约 1,308.94 kB JavaScript、344.52 kB CSS；PDF、编辑器、AI、图表、PPT 和媒体依赖继续以懒加载 chunk 输出。
- 已知非阻断提示：`pdf-lib-plus-encrypt` 的浏览器 `crypto` externalization、若干超过 500 kB 的 chunk，以及 Windows 链接器将导入库生成信息标记为 `linker_messages`。它们均不改变功能；前两项暂不阻塞开发，链接器提示属于工具链信息输出。

## 6. 验证结果

- `npm run test:architecture`：通过，包含懒加载、生命周期、运行时模块契约和架构基线。
- `npm run test:release`：87 个 npm 发布门禁全部通过。
- `cargo test --manifest-path src-tauri/Cargo.toml --lib`：94 passed、1 ignored、0 failed。
- `cargo test --manifest-path src-tauri/Cargo.toml`：94 passed、1 ignored、0 failed；仅有 Windows 链接器 `linker_messages` 信息提示。
- CLI clean worktree：打包并安装 `toolknit-cli@2.3.1`，46 个 MCP 工具枚举和调用契约通过。
- `npm run build`：通过；只保留上述已知非阻断 warning。
- `npm run tauri build -- --bundles nsis`：通过，生成 Windows x64 本地 NSIS 安装包；未签名、未上传。
- 浏览器回归：首页搜索/分类、设置到帮助弹层链路和控制台检查通过，错误/警告数为 0。

## 7. 本地 checkpoint

- `5b2d65a`：完成懒加载模板边界。
- `87d33df`：拆分 AI、外链和首页运行时。
- `3ff273e`：隔离字体设置运行时。
- `ff9c4d1`：标注 native 兼容边界。
- `77426f2`：修正懒加载反馈模板版本契约。
- `c737520`、`e962681`、`37be412`、`556860d`：同步进度、架构快照和注入修复。

所有 checkpoint 仅存在本地 `codex/v3.0`，没有推送 GitHub、发布 npm、创建 Release 或修改版本号。
