# ToolKnit Desktop V3.0 架构迁移报告

## 当前状态

本地分支为 `codex/v3.0`，版本号保持 `2.3.1`。本轮没有推送 GitHub、发布 npm 或创建 Release。
迁移前已创建本地 checkpoint：`51bad26`（保留此前 7 个未提交修改）。

工具层此前已完成 65/65 模块化迁移。本轮继续完成全局边界收敛：

| 原入口 | 当前边界 | 说明 |
| --- | --- | --- |
| `src/main.js` | `src/application.js` + `src/app/*` | `main.js` 仅负责入口导入、平台依赖和组合层导出；运行时行为保持不变 |
| `src/styles.css` | `src/styles/index.css`、tokens/base/layout、components、pages、compatibility、`legacy.css` | 旧规则完整保留并按固定顺序导入，后续可逐块迁移 |
| `index.html` | 现有稳定 DOM 壳 + `src/features/*/template.js` | 工具模板已按 feature 懒加载，静态壳迁移继续进行 |
| `src-tauri/src/lib.rs` | `native_runtime.rs` + `commands/*`、`platform/*`、`runtime/*` | crate 根只注册模块并导出 `run`；安全 URL 校验已接入平台模块 |

## 新增模块职责

- `src/app/window-controller.js`：原生窗口动作的可注入边界。
- `src/app/modal-manager.js`：弹框显示、`aria-hidden`、`inert` 与焦点恢复。
- `src/app/settings-controller.js`：带命名空间的存储读写，避免业务散落 key。
- `src/app/update-controller.js`：更新检查去重、释放与错误处理。
- `src/app/home-controller.js`：首页搜索和工具打开协调。
- `src/app/app-lifecycle.js`：统一 listener 注册和幂等销毁。
- `src/styles/index.css`：全局样式入口；`legacy.css` 是迁移期间的兼容层。
- `src-tauri/src/platform/security.rs`：外部 URL 与 WebView 导航校验。
- `src-tauri/src/platform/paths.rs`：受限路径解析。
- `src-tauri/src/runtime/task_registry.rs`：重复任务 claim/release。
- `src-tauri/src/commands/files.rs`、`dependencies.rs`、`window.rs`：命令域迁移接缝。

## 依赖方向

`main.js` -> `app/app-composition.js` -> app controllers；业务 feature -> `shared/*` 与 `platform/tauri-runtime.js`；Rust command -> `platform/*` / `runtime/*`。CLI/MCP 继续只依赖 `cli/lib` 与公共核心，不引用 DOM 或 Tauri WebView。

## 契约与验证

- 桌面工具：65
- HTML ID：1,312，重复 ID：0
- Tauri command：127 个实现，126 个唯一名称
- Rust 测试：95（含本轮命令文件和任务注册表边界测试）
- MCP 工具：46
- 前端 invoke：102；事件：19
- `npm run test:architecture`：通过
- `npm run build`：通过
- `cargo test --manifest-path src-tauri/Cargo.toml --lib`：95 项通过（1 项按环境忽略）

## 性能与风险

入口文件和首屏样式已变为轻量兼容入口，生产构建主 JS 约 1.24 MB，懒加载工具仍保持独立 chunk。Vite 仍报告 `pdf-lib-plus-encrypt` 浏览器 crypto externalization 和若干大 chunk；这些是已记录的非阻断警告。本轮没有改变依赖加载策略，避免功能回归。

剩余工作是把 `application.js`、`legacy.css`、`index.html` 和 `native_runtime.rs` 内部职责继续逐段迁移到已建立的模块边界，并在每段迁移后跑完整 CLI/MCP、安全、发布和 NSIS 验证。
