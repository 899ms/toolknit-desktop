# V3 架构维护规范

新增桌面工具必须放在 `src/features/<tool-id>/`，至少包含：

- `tool.js`：懒加载入口，只组装模板、控制器和 feature CSS。
- `template.js`：静态安全模板；动态文本使用 `textContent` 或受控转义函数。
- `controller.js`：事件、状态和异步流程；使用 `createLifecycleScope()` 管理清理。
- `core.js`：可测试的纯逻辑，不依赖 DOM、Tauri 或全局变量。
- `<tool-id>.css`：只包含该工具的视觉规则，禁止回写全局样式。

控制器必须通过 `src/platform/tauri-runtime.js` 调用原生 API；禁止直接从业务模块导入 `@tauri-apps/api`。长任务要有取消、过期结果校验和输出文件不覆盖保护。新增 command 时按职责放入 `src-tauri/src/commands/`，路径、URL、密钥和下载大小校验统一复用 `platform/security.rs`、`platform/paths.rs`。

每个工具至少补充一个 core 测试和一个 tool contract 测试；涉及原生能力时补充 Rust 测试。提交前运行 `npm run test:architecture`、`npm run test:security-release`、`npm run test:cli`、`npm run test:release`、`npm run build`、`cargo test --manifest-path src-tauri/Cargo.toml` 与 `git diff --check`。版本发布前再运行 NSIS 打包，并确认正式构建不开放 F12/DevTools。
