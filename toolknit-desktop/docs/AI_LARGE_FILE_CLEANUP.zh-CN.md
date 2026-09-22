# AI 大文件清理：主题与安全边界

本轮仅涉及 `large-file-cleanup`。独立 C 盘系统清理器的扫描、提权和清理命令不在此次改动范围。

## 页面与交互

- 复用现有工具导航、下拉菜单、语言切换和生命周期；主题覆盖集中在 `src/features/cleanup-tools/cleanup-tools-light.css`。
- 左侧选择目录、选择 C 盘、设置阈值与类型，扫描和 AI 分析都可取消。C 盘快捷按钮只选择扫描根目录，点击开始扫描才进入确认流程。
- 选择整个盘符时展示风险说明，必须勾选确认才能继续。扫描为只读，不申请管理员权限；不可访问区域直接跳过。
- 右侧支持名称/目录搜索、风险/类别筛选，显示扫描数量、保护跳过项、不可访问目录、耗时和截断提示。单击文件名可打开所在文件夹。
- AI 仅提供参考，默认不勾选任何文件。批量选择仅面向当前筛选结果，跳过高风险与保护项，每次最多 200 项；高风险候选只能由用户单独审查选择。
- 移入回收站之前再次确认数量和容量，容量显示为待释放；只有清空回收站后才可能实际释放。清空回收站由用户在 Windows 中自行决定。

## 原生保护策略

策略版本：`windows-cleanup-v2`。扫描和移入回收站都在原生侧校验，前端隐藏按钮不能替代这些约束。

| 类型 | 策略 |
| --- | --- |
| 系统与恢复目录 | 跳过 Windows、Windows.old、Recovery、Boot、EFI、System Volume Information、$Recycle.Bin、Config.Msi、$Windows.~BT、$Windows.~WS、$WinREAgent 等 |
| 应用与配置 | 跳过 Program Files、Program Files (x86)、ProgramData、AppData、WindowsApps、MSOCache、Documents and Settings；同时解析系统/应用目录环境变量，保护重定位目录 |
| 开发与缓存目录 | 保留原有 .git、node_modules、target、dist、build、虚拟环境、缓存与临时目录排除规则 |
| 文件属性 | 跳过隐藏、系统、只读文件；跳过重解析点、符号链接、目录联接、云端占位；目录只读属性本身不作为排除依据 |
| 系统文件 | 跳过分页/休眠/交换文件、启动与转储文件，以及 sys/dll/ocx/efi/cat/cpl/drv/mui/msu/cab 等受保护扩展名 |
| 云端同步 | 跳过系统环境变量标识的 OneDrive 根目录；未登记的第三方同步目录无法自动穷尽识别 |
| 文件身份 | 候选仅限本地普通文件；检查硬链接数量、卷号/文件 ID、大小、创建与修改时间；扫描后发生变化则要求重新扫描 |
| 路径 | 必须是绝对本地盘符路径，拒绝 UNC 与重解析祖先；按规范化路径检查扫描范围，按完整目录分量匹配保护名，避免误伤 WindowsBackup 等名称 |

最多检查 250,000 个文件、返回 1,200 个候选，达到上限明确提示结果不完整，建议缩小扫描目录。扫描候选仍按工具支持的媒体、文档、归档、安装包和模型类型筛选；“全部大文件”表示全部支持类型。

扫描使用原生会话保存候选身份，只有本次已完成扫描的文件能进入回收站操作。会话最多有效 30 分钟，取消、换目录、重扫、退出工具后失效；过期需重扫。最多 32 个活动会话，取消记录保留以阻断迟到的扫描调用，不占活动名额。

Windows 10/11 使用 `IFileOperation` 配合 `FOFX_RECYCLEONDELETE`，取消/错误作为失败返回，不再保留 PowerShell 删除备用实现，不回退到永久删除。系统目录、不可访问文件不通过提升权限绕过。

微软资料用于确认 Windows 目录用途与平台 API 语义；这些目录不是微软承诺的完整“安全清理黑名单”：

- [Windows 已知目录](https://learn.microsoft.com/en-us/windows/win32/shell/knownfolderid)
- [Windows 文件属性](https://learn.microsoft.com/en-us/windows/win32/fileio/file-attribute-constants)
- [IFileOperation 操作标志](https://learn.microsoft.com/en-us/windows/win32/api/shobjidl_core/nf-shobjidl_core-ifileoperation-setoperationflags)

自定义安装目录、个人项目、聊天数据、备份及普通同步文件无法仅靠名称判断是否可删。列表和确认框必须保留人工核实与备份提示，不宣传“绝对安全”；扫描校验也不构成对恶意进程并发替换路径的完整隔离。

## AI 与公开契约

- 扫描不调用 AI。仅用户点击 AI 分析时，通过已有 AI 请求运行时发送文件名、大小、修改时间、类别、风险和相对目录线索；不发送完整绝对路径或文件内容，整盘线索中的 Windows 用户名替换为 `[user]`。
- 名称和目录线索视为不可信数据；模型仅能为当前批次 ID 返回严格枚举的建议。重复 ID、越界 ID、缺失字段不生效，高风险/模型/项目等删除建议降为复核。
- 有效建议在部分失败时保留，继续分析只处理缺失项；重新分析的无效回复不会被旧建议掩盖。关闭或取消后的迟到回复不写回界面。
- `scan_large_files` 新增 `scanId`（必传，16–80 位字母/数字/连字符）、`allowSystemDriveRoot`（默认 false）。结果增加 `scan_id`、`policy_version`、`elapsed_ms`、`truncated`、`protected_dirs`、`protected_files`、`denied_dirs`。
- 新命令 `cancel_large_file_scan({scanId})`，幂等取消扫描并失效其候选授权。
- `move_files_to_recycle_bin` 新增必传 `scanId`，要求有效 `scanRoot`，最多 200 条；旧客户端缺少会话时拒绝执行。这是有意收紧的安全契约。
- 新 DOM ID：`largeFileCleanupScanSystemDrive`、`largeFileCleanupDriveRootAck`、`largeFileCleanupCancel`、`largeFileCleanupSearch`、`largeFileCleanupRiskFilter`、`largeFileCleanupCategoryFilter`、`largeFileCleanupScanStats`。既有工具 ID、存储键、CLI/MCP 契约不变。

## 验证入口

- `node scripts/test-cleanup-tools-contract.mjs`
- `node scripts/test-system-cleanup-runtime.mjs`
- `cargo test --manifest-path src-tauri/Cargo.toml cleanup_ --offline -- --test-threads=1`
- `node scripts/test-cleanup-large-file-browser.mjs`：使用已有 Playwright，`TOOLKNIT_TEST_MODULES` 可指定模块目录，默认使用已安装 Edge；测试临时 Vite 服务自动关闭。

浏览器回归使用注入的扫描/AI/回收站适配器和虚构路径，不扫描或移除用户文件；原生回归仅操作仓库 `tmp/cleanup-native-tests` 下生成的测试文件，包含真实回收站、中文/Unicode 文件名、硬链接、目录联接、隐藏/只读文件、超范围、扫描后变化、早取消和重复扫描。

## 本轮验证结果

- focused 契约、原生扫描/回收站测试通过；完整 Rust：148 passed、3 ignored。
- Edge 浏览器：深浅主题、1400×920 / 1100×700 / 720×640、中英文、筛选、AI 部分失败与续跑、无效重新分析、取消后的迟到结果、手动选择、回收站结果、关闭/重开/释放、确认框焦点限制通过。
- 构建后的实际应用已通过 `large-file-cleanup` 懒加载入口打开，1420 预览页能显示新组件，无新增未捕获异常。真实 AI 服务未调用，浏览器原生操作通过适配器测试；未进行用户 C 盘整盘扫描或安装版端到端测试。
- architecture、build、diff 检查通过；安全门禁 981 项通过；CLI package、CLI/MCP 与 clean-worktree CLI 检查通过。
- `test:release` 前 84 项通过，在 `test:help` 因已有 `common.remove` 中文翻译键缺失而中断。该引用位于音视频转换/转写工具，不是本轮新增；未为清理工具改动顺带修改这些页面。其后的 CLI 与 build 已单独验证。
- 构建保留既有大 chunk 提示，Rust 保留 Windows linker 提示。本轮没有打包安装器、提交、推送或发布。
