# LibreOffice 运行时安装修复

日期：2026-09-10。保持 LibreOffice 26.2.5、下载地址、SHA-256、Tauri 命令及事件名不变。

## 原因与边界

行政解包 `msiexec /a` 把微软 VC++ x64 DLL 放到 `System64`，不会替用户执行系统运行库安装。
LibreOffice 位于 `program`，旧链路没有部署这批 DLL，因此开发机已有系统运行库时可能掩盖缺失。
启动检查还把超时、进程启动失败及 Windows 加载器退出码统一丢弃，随后删除运行时及下载包。
依赖弹层另外存在 `libreofficeProgress` 与 `libreOfficeProgress` 字段不一致，导致状态停留在等待下载。

## 实现

- `native_runtime/dependencies/libreoffice_install.rs`：从已校验 MSI 的 `System64` 将固定清单中的
  10 个 DLL 部署到 `program`，检查普通文件、大小和目标路径，不写 Windows 系统目录。
  已有托管安装通过同一函数补齐缺失文件。部署锁避免本进程内重复状态检查竞争写入。
- MSI 在暂存目录解包、部署并验证启动，通过后才替换当前目录；替换失败尝试恢复原目录。
  新安装启动检查允许 30 秒，常规探测仍为 10 秒；解包使用独立活动监控并检查取消状态。
- `native_runtime/office/probe.rs`：保留失败阶段、OS 错误码或十六进制退出码；不回传文件内容、
  私有路径或任意子进程输出。版本输出有界读取，临时 profile 随作用域释放。
- 下载的完整包在安装失败时保留；重试先重新核对 SHA-256，再本地安装，避免 EOF Range 请求及重复下载。
- `app/dependency-helpers.js`：统一三类依赖的进度字段映射和总进度；错误提示使用中英文词条。
  应用组合根只调用 helper，继续复用既有弹层及外链，不新增工具业务。

## 验证方法

常规 focused 检查：

```powershell
node scripts/test-dependency-contract.mjs
cargo test --manifest-path src-tauri/Cargo.toml libreoffice --lib
```

实际 MSI 检查使用 `libreoffice_install_real_msi_startup`，须显式提供两个本地路径：

- `TOOLKNIT_OFFICE_INSTALL_TEST_MSI`：与代码固定 SHA-256 一致的原始 MSI。
- `TOOLKNIT_OFFICE_DLL_PROBE`：用 MSVC 编译 `scripts/fixtures/libreoffice-dll-probe.c` 得到的 x64 EXE。
  文件注释给出编译参数；产物只依赖 KERNEL32，不链接 CRT，输出放在忽略目录 `tmp`。

```powershell
cargo test --manifest-path src-tauri/Cargo.toml libreoffice_install_real_msi_startup --lib -- --ignored --nocapture
```

该测试验证原始 MSI 校验、真实解包、每个 DLL 的源/目标哈希、暂存和最终目录中的启动检查。
隔离加载器禁止系统/PATH 目录提供 VC++ DLL：部署前返回 126，调用正式部署函数后加载成功。
这验证了对系统 VC++ 预装状态的独立性，不等同于覆盖全部 Windows 版本或安全软件配置。

同一受控 EXE 支持慢启动测试：验证探测超时和启动后取消都会返回对应错误并及时结束子进程。

## 第一轮结果（CRT 修复）

- 固定 MSI 的真实解包、暂存/最终启动、10 个 DLL 的源/目标哈希通过。
- 禁止系统 VC++ DLL 搜索的加载器：部署前 126、正式部署后 0；慢启动超时及取消通过。
- 依赖进度、中英文错误提示和重试状态 focused 检查通过；架构及差异格式检查通过。
- 完整 Rust：121 passed、2 ignored；本次 MSI 专项已显式单独执行通过，另一个外部样本专项仍未执行。
- 发布门禁：89 个 npm 脚本通过，包含 977 项安全检查、CLI/MCP、PDF/PPT 回归和前端构建。
- 仅保留已有大 chunk、crypto externalization、Windows linker 和传递依赖弃用提示。

本轮日志在 `tmp/office-runtime-fix`。常规 Rust 套件默认忽略需要外部 MSI 的专项；
须记录显式执行结果，不能把 ignored 算作通过。没有修改系统运行库、发布配置或版本号。

## 第二轮：群友反馈解包超时

群友在上一轮测试包反馈 `extract: timeout`，系统为 Windows 11 家庭中文版 25H2。
这与之前的启动缺 DLL 不同：代码中的 180 秒硬上限不能区分缓慢解包与实际停滞。
现有截图不足以断定对方机器是慢磁盘、安全软件检查、Installer 等待还是其他原因。

- `dependencies/libreoffice_extract.rs` 单独拥有 MSI 子进程、活动监控和临时日志。
  文件数量、累计字节或日志大小发生变化时刷新活动时间；连续 5 分钟无变化才报
  `extract-stalled`，总时长仍以 30 分钟为上限，报 `extract-timeout`。不伪造解包百分比。
- 行政解包的详细日志分批读取（每秒最多 512 KiB，保留 1 KiB 跨批行片段），日志限额
  64 MiB。不使用逐行强制刷盘；只从日志提取允许的 MSI action 名称，不回传原始日志或私有路径。
  正常退出时删除临时日志；系统锁定文件时清理是尽力而为，不承诺系统崩溃后的清理。
- 解包进度沿用 `libreoffice-runtime-download-progress`，原有 `phase`、`downloaded_bytes`、
  `total_bytes` 不变；安装/校验事件可新增 `extraction` 对象，包含 `elapsed_seconds`、
  `extracted_files`、`extracted_bytes`、`action`。旧事件没有此对象时前端保持原提示。
- 依赖弹层和设置里的 Office 管理复用同一 helper，显示真实文件计数、体积、用时及安装/校验状态。
  Windows Installer 返回 1618 / 1625 时分别提示安装服务忙 / 系统策略限制。
- 每次使用唯一暂存目录；取消或失败不发布半成品，保留已校验安装包供重试。
  只终止本任务的客户端进程树，不结束其他 MSI 服务或其他软件的安装。
  系统侧 Installer 可能不属于该进程树；不能把受控子进程取消测试等同于服务端一定同步结束。

第二轮的实际验证记录在 `tmp/office-extract-fix`，与上一轮结果分开。

### 第二轮验证

- LibreOffice focused：13 passed、1 ignored；忽略的真实 MSI 专项随后显式执行通过。
- 真实 MSI 解包：19,485 个文件，1,594,984,948 字节，解包阶段 43 秒；完整专项 69 秒。
  验证完成前的真实 MSI action、文件计数、事件阶段、暂存/日志清理、CRT 部署哈希及实际启动。
  MSI 可在一秒内连续调度 InstallFiles/InstallFinalize，因此不要求轮询恰好采到短暂阶段。
- 隔离加载器检查、超时与取消通过；受控进程句柄验证确认超时/取消后进程已经退出。
- 发布门禁 89 个 npm 脚本通过，包含安全 977 项、架构、CLI/MCP 和前端构建。
- 完整 Rust：128 passed、2 ignored；真实 MSI 专项已按上文单独执行通过，另一项外部环境测试仍忽略。
- 浏览器 48 组中英文依赖弹层布局通过，覆盖长错误/真实格式的进度文案、390px 窄窗及低高度窗口、
  下载源切换、关闭重开、缺少密钥导航、深色隔离和焦点，无新增页面错误。
  浏览器中的依赖数据为视觉夹具，不代表原生下载；原生解包证据来自上述 MSI 专项。
- 本地诊断生成的 `inspect-*` 目录和原始 MSI 日志仍在忽略目录 `tmp/office-extract-fix`：
  环境拒绝了清理命令，未绕过限制。这些文件不纳入源码或安装包；正常专项自己的暂存/日志已清理。
- 对方 Windows 11 25H2 机器尚未用本轮代码复测，不能据本机通过宣称对方环境问题全部解决。
  本轮没有打包、提交、推送、发布或改版本号。
