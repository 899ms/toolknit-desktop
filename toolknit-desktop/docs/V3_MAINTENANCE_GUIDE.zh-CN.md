# ToolKnit Desktop V3.0 维护规范

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

- 通用按钮、弹层、导航、进度、窗口控制放在 `src/styles/components/`。
- 页面布局放在 `src/styles/pages/`；工具专属状态和控件放在 feature CSS。
- 不把工具样式重新塞回全局入口，不通过新增无理由 `!important` 或竞争性 `z-index` 修补布局。
- 关闭态 overlay 必须脱离布局，返回按钮、分类标签和窗口圆角要复用既有组件规则。

## 测试门槛

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
- 修改 native command 后必须跑对应 Rust 单测，并重新核对 127 实现、126 唯一名称和前端 invoke 清单。

## CLI / MCP 维护

- CLI 只能依赖明确导出的 core/runtime，不得导入页面或 Tauri 模块。
- 保持 8 MB 消息限制、最多 4 个并发、重复 request id 拒绝和结构化错误。
- 新增能力必须同时补 CLI package、MCP registry、clean-worktree 安装和调用契约。
- 发布前必须从干净临时 worktree stage 资源并安装测试，避免依赖本机未跟踪文件。

## 提交与发布

- 每个独立阶段使用一个语义明确的本地 Git checkpoint。
- 提交前检查 `git status`、`git diff --check`、测试结果和生成物是否被忽略。
- V3.0 架构阶段不得自动推送 GitHub、发布 npm、创建 Release 或修改版本号；这些动作必须由用户单独确认。
- 大 chunk 和浏览器 crypto externalization 警告目前非阻断，但不得新增同类 warning；来源和后续优化方向必须记录在架构进度文档。

