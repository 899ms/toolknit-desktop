# Windows 剪贴板历史

## 使用行为

- 入口位于硬件工具分类，`data-tool="clipboard-history"`。默认关闭监控；在工具页确认开启后，仅记录之后观察到的复制事件，不导入 Windows Win+V 历史或开启前的当前内容。
- 支持 Unicode 文字、图片、文件路径。富文本只保存纯文字；图片统一为 PNG；文件只保存路径，不读取文件正文。
- 返回首页、切换工具、隐藏到托盘后继续监控。工具页和托盘均可暂停；完全退出会停止原生监听与存储线程。可单独开启“下次启动时恢复仍在运行的监控”，默认不恢复。
- 按日期分组、倒序显示观察时间；详情包含毫秒、采集时的 UTC 偏移、来源进程、类型和大小。来源取剪贴板 owner，无法获取时显示未知，不猜测前台应用。
- 相同内容仅存储一份加密实体，每次观察到的新复制仍保留独立时间线事件。来源应用与文字/路径可搜索；支持类型、日期、收藏过滤，50 条分页、批量删除和清空。
- 新记录到达时保留当前阅读位置与预览，显示新记录入口。支持完整文字、图片缩放、图片另存、文件路径列表及再次复制；再次复制文件按 copy 处理，绝不恢复 cut 行为。
- 查看文件记录不访问原路径；用户点击复制文件时才检查可用性，文件缺失时可改为复制路径。删除历史不会删除原文件或清空系统当前剪贴板。

## 模块与所有权

| 边界 | 文件 | 职责 |
| --- | --- | --- |
| 懒加载工具 | `src/features/clipboard-history/` | 模板、交互、纯格式化、状态与样式 |
| 共用 UI | `shared/tool-page-shell.js`、`app/modal-runtime.js`、`tool-custom-select.js` | 导航、窗口动作、焦点与弹层、自定义下拉菜单 |
| 硬件主题 | `styles/components/hardware-workbench.css`、`hardware-workbench-light.css` | 原硬件主题移至共享层，旧 feature 路径保留 import 兼容入口 |
| 平台适配 | `src/platform/clipboard-runtime.js` | invoke/listen、浏览器能力边界、敏感文字复制 |
| 应用级服务 | `src-tauri/src/clipboard_history/mod.rs` | 服务状态、托盘、命令、退出与线程生命周期 |
| Windows 监听 | `clipboard_history/windows.rs` | message-only window、格式监听、读取边界、敏感标记、重写剪贴板 |
| 持久化 | `clipboard_history/store.rs` | SQLite、加密、去重、时间线、分页、搜索、容量和过期清理 |
| Windows 密钥保护 | `platform/protected_data.rs` | 当前 Windows 用户的 DPAPI 包装 |

前端 `close/dispose` 释放自己的事件、下拉菜单、弹层、DOM 内容和异步会话，不停止应用持有的监控。原生层通过 generation 取消过期采集、query revision 取消过期搜索；关闭软件的 `ExitRequested` 将线程收尾放到后台，完成后才允许退出，避免主线程等待正在更新托盘的工作线程。

## 新增契约

- 首页/lazy ID：`clipboard-history`；overlay：`clipboardHistoryOverlay`；initializer：`initClipboardHistoryTool`。
- UI DOM 统一采用 `clipboard*` 前缀，核心包括 `clipboardToggle`、`clipboardList`、`clipboardPreview`、`clipboardHistoryDialog`；静态模板通过契约测试检查 ID 唯一性。
- Tauri `clipboard_history({ request })`，仅主窗口可调用。`request.action` 为 `status/start/stop/settings/list/detail/favorite/delete/clear/copy`。
- `settings` 带完整 settings；`list` 带 query；detail/favorite/copy 带 id；delete 带 ids；clear 带 includeFavorites；copy 可带 paths，仅复制路径文字。
- 事件 `clipboard-history-changed` 仅包含 revision，不广播剪贴板正文。页面按需重新查询。
- Tauri `copy_sensitive_text({ text })` 供密码生成器使用；写入 Windows 隐私格式标记。原有普通复制契约保持不变。
- 中英文键：`home.clipboardHistory.*`。不新增 CLI/MCP 剪贴板读取入口。

## 存储与限制

数据位于 Tauri `app_local_data_dir()/clipboard-history/`：`history.sqlite`、`history-key.dpapi`、`resume.json`。正文、摘要、缩略图、来源与设置使用 AES-256-GCM 加密，随机密钥由当前 Windows 用户 DPAPI 保护；内容去重采用带密钥 HMAC。事件 ID、时间、类型、收藏标志为明文元数据。损坏或无法解密的密钥不会被静默替换。

默认保留 7 天、2000 条、256 MB 内容容量；可设置 1–365 天、100–10000 条、32–2048 MB。容量统计包含加密内容、摘要与事件估算，不是数据库磁盘文件硬上限，索引、空闲页与 SQLite 文件开销另计。普通记录按旧到新清理，收藏不自动删除；收藏占满上限时暂停记录。启动监控、写入、保存设置及查询状态时执行有界频率的过期清理。

单条文字上限 2 MB；图片 20 MB、3200 万像素；文件路径最多 1000 个，合计 2 MB。监听线程只做有界读取，图片解码、加密和写库由后台存储线程处理，队列有界以控制突发复制的内存。

## 隐私和能力边界

默认无上传、无 AI 请求。排除应用按进程文件名匹配，尊重 `ExcludeClipboardContentFromMonitorProcessing`、`CanIncludeInClipboardHistory=0`、`Clipboard Viewer Ignore` 等标记；应用内部从历史复制使用自身标记防止循环记账。密码生成器同时设置不进系统历史和不同步云剪贴板的格式标记。

无法承诺识别所有密码：第三方应用可能不标记敏感内容，owner 也可能不可用；开启说明明确提示暂停或排除应用。加密保护静态文件，不能隔离同一登录用户下的恶意程序，也不能承诺删除历史等于磁盘安全擦除。

系统格式通知不是无损消息队列。极快覆盖、延迟渲染、剪贴板占用、超限或不支持格式可能无法收录；界面显示跳过/失败计数，不伪造记录或时间。浏览器预览不读取系统剪贴板，只显示桌面能力提示。

## 验证

- `npm run test:clipboard-history`：设置/时间、适配器、敏感复制、中英文、生命周期和入口契约。
- `cargo test --manifest-path src-tauri/Cargo.toml clipboard_history --lib`：加密去重、事件、持久化、搜索分页、收藏、过期、篡改、容量回滚、文件路径和图片边界。
- 原生监听测试在独立子进程的私有 Windows window station/desktop 中执行，验证开启前不补录、重复复制、隐私标记、图片、暂停；不读取或替换用户剪贴板。
- `scripts/test-clipboard-history-browser.mjs`：真实共享样式配合注入的合成原生数据，覆盖深浅主题、中英文、三种视口、预览、搜索、收藏、弹层、后台继续、关闭重开与过期异步结果。
- 发布检查包含安全、架构、帮助中心与 CLI/MCP 回归；完整 Rust 测试与生产前端构建单独运行。

浏览器注入测试不能替代安装包中的多应用复制、Windows 10/11、远程桌面或长时间后台测试。测试数据均为合成内容；安装包验证由后续用户打包测试完成。

2026-09-20 本地结果：92 项发布脚本（包含安全、架构、CLI/MCP 与构建）通过；Rust 全量 161 passed、3 ignored，其中剪贴板 10 项全部通过。Edge 深浅主题截图与交互回归通过；生产预览的真实首页入口、桌面限制提示、返回与重复打开通过。保留既知的大 chunk、crypto externalization、Windows linker 信息提示，没有新增同类构建警告。未打包、提交或发布。
