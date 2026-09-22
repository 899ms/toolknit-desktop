# PDF 压缩核心与严格目标大小

## 原因与行为

旧桌面端只有 qpdf 数据流重压缩：低/中档主要为 Flate 6，高档或指定目标为 Flate 9。
没有图片降采样、JPEG 重编码或目标参数搜索；已经优化的 PDF 常常无法缩小。
旧目标模式还会发布未达标候选，甚至复制原文件作为输出。新实现不再采用这套结果语义。

- 默认 `structure` 保留文字、链接和表单等结构，使用 qpdf；低/中/高为 Flate 6/8/9。
- 用户显式选择 `raster` 才进行有损图像化重建。文字搜索、链接、表单、书签及无障碍标签不保留。
  保留的是可见页面的尺寸、方向和顺序；旋转和 CropBox 烘焙到页面图像中，不复制旧交互结构。
- 普通图像化低/中/高采用 scale/quality：2/0.86、1.5/0.66、1/0.45。
- 目标范围 50 KiB 至 50 MiB，UI 的 KB/MB 均按 1024 换算。保留 5/10/15/20/50 MB 快捷项并增加自定义。
  原文件已符合上限时不重新编码或复制；只有完整结果不超过上限且比原文件小才发布。
- 目标图像化从 scale=2、quality=0.94 开始，最多 6 轮，按实测整份 PDF 字节调整参数并回补质量。
  未达标结论须实际尝试所选最低参数；候选生成错误、资源超限不伪装成“目标未达到”。
- `readable` 下限为 72 DPI / JPEG 0.4，`compact` 为 36 DPI / JPEG 0.25。页尺寸超出像素预算且无法
  满足下限时明确拒绝，不偷偷降到更低分辨率。没有 OCR 可读性评分，档位不构成清晰度保证。

## 模块归属

| 模块 | 责任 |
| --- | --- |
| `src/core/pdf-compression.js` | 共用参数、资源预算、目标搜索、精确字节状态判定 |
| `src/core/pdf-raster-candidate.js` | 共用 PDF 组装与重新打开、页数/尺寸验证 |
| `features/pdf-compress/raster.js`、`page-cache.js` | 桌面页面预处理、会话缓存、超时/取消、Worker 调度与兼容回退 |
| `features/pdf-compress/raster-worker.js`、`raster-encode.js` | 从固定源 JPEG 编码候选，不从上一轮失真的结果继续压缩 |
| `features/pdf-compress/processor.js`、`results.js`、`tool.js` | 平台调用、分块写入、逐文件状态、精确字节记录和首页原始像素预览 |
| `cli/lib/pdf-compress-worker.mjs`、`pdf-compress-raster-runtime.mjs` | Node Worker 与磁盘缓存；调用同一搜索和候选核心 |
| `native_runtime/pdf/compress.rs`、`compress_write.rs` | 保结构压缩，原生大小/页数/有效性校验，取消及唯一名称原子发布 |

原 `src/pdf-compress-core.js` 保留兼容导出；CLI staging 包含两个新增 core 文件，不依赖 DOM/Tauri。
没有把工具业务追加到应用组合根，没有引入新渲染引擎、二进制或 npm 依赖。

## 资源与生命周期

源页面逐页渲染一次并编码为 quality=0.98 的 JPEG。每页最多 400 万像素，最长边 8192。
桌面优先用会话 IndexedDB 缓存；不可用时用至多 128 MiB 的内存缓存。桌面磁盘缓存与 CLI 临时
目录缓存上限为 1 GiB。候选 PDF 上限 200 MiB；这些不是整个进程的 RAM 上限，解析器、图像解码
和 PDF 组装还有额外工作内存。原输入上限 150 MiB、500 页、每批 10 个不变。

每文件计算最长 15 分钟；缓存打开/事务有独立超时。Worker 不可用时，桌面复用已缓存页面在兼容
路径编码，不重跑整份 PDF 渲染。取消会停止渲染/Worker，清理页面缓存与写入会话。
CLI 父线程在成功/失败/取消后终止 Worker，再清理自己创建的临时目录。

原生写入会话使用转换锁、顺序 offset、每块最多 2 MiB、总长度上限和 180 秒过期清理。
写盘后核对实际字节数、qpdf 检查和源页数；仅在最终验证后复用现有原子发布器。
取消最终校验不会提前释放转换锁，也不会发布半成品。原文件不覆盖，重复输出使用唯一名称。
正常生命周期的清理已验证；系统强杀、断电或底层存储故障不保证立即完成物理清理。

## 新增与兼容契约

`compress_pdf` 保留既有参数，增加可选 `targetBytes`，旧 `targetSizeMb` 仍支持；同时传入时须一致。
返回保留原字段，增加 `status`、`target_bytes`、`page_count`、`candidate_size`。
已达标、不达标和无收益都返回空 `output_path`，不是失败后复制原文件。

新增四个 Tauri 命令，当前 132 个实现、131 个唯一名称：

- `begin_pdf_compress_write(inputPath, directory, expectedBytes, targetBytes?) -> sessionId`
- `append_pdf_compress_chunk(sessionId, offset, bytes)`
- `finalize_pdf_compress_write(sessionId) -> outputPath`
- `discard_pdf_compress_write(sessionId)`，重复清理允许幂等调用。

UI 新增方式、清晰度、自定义上限、取消和结果列表控件；均有中英文词条和契约检查。
`applyTranslations(root?)` 支持懒加载页面局部翻译，无参数仍沿用全局行为；其他页面不自动改版。

CLI/MCP 保持 `toolknit_pdf_compress` 名称及原默认参数，增加 `mode`、`clarity`、`target_bytes`。
CLI 对应 `--mode`、`--clarity`、`--target-kb` / `--target-mb`，两个单位参数不能同时使用。
结果的 `status` 为 `compressed`、`already-within-target`、`target-not-reached` 或 `no-reduction`；
执行错误仍走结构化错误通道。调用者应检查 `status` 和 `outputs`，不能只凭命令完成判定目标达成。

```powershell
toolknit pdf compress --input .\input.pdf --output .\small.pdf --mode raster --target-kb 500 --clarity readable --json
```

## 验证入口

- `npm run test:pdf-compress`：qpdf、搜索边界、真实图像/中文/表单/旋转/CropBox 样本、严格目标、取消及缓存清理。
- `node scripts/test-pdf-compress-tool-contract.mjs`：懒加载、UI、写入与取消契约。
- `node scripts/test-pdf-compress-browser.mjs`：实际 Worker 与兼容路径、下载字节、预览、取消、缓存、中英文和深浅布局。
- `cargo test --manifest-path src-tauri/Cargo.toml compression_ --lib`：目标边界、真实写入校验、唯一名称、无效输出拒绝和取消所有权。
- `qa-pdf-compress-raster-native.mjs`：仅在独立 identifier / 用户数据目录的诊断实例中执行；完整 EXE UI 到输出校验。
  使用唯一命名的合成文件；生成在用户配置目录的测试输出会核对并清理，证据复制到 tmp，不改输出偏好。

原有样本/原生 QA 脚本已对齐“不达标不发布”语义，样本生成器 JPEG 质量按 Node 编码器的 0–100 范围使用。
测试产物与日志放在忽略目录 `tmp/pdf-compress-redesign`。本轮不打包、改版本、提交或发布。

## 本轮验证结果

- 搜索边界、最低参数尝试、异常/取消释放和实际 qpdf 核心回归通过。
- CLI 真实图片/中文/表单/旋转/CropBox 样本通过：保结构时表单和旋转保持，图像化输出页尺寸正确；
  目标未达到与已达标不导出，取消后没有未完成输出或新缓存目录，原始哈希不变。
- 浏览器实际 Worker、Worker 不可用时兼容编码、精确字节下载、首面预览、取消和 IndexedDB 清理通过；
  中英文/深浅主题 12 组布局通过，无新增页面错误或焦点警告。
- 最终 EXE UI 全链路：三页合成样本 14,017,078 字节，500 KB 上限为 512,000 字节，输出 494,129 字节。
  同时验证未达标无输出、原文件已达标不处理、取消及缓存清理、保结构模式严格目标；测试输出已清理，
  证据副本保存在工作区。源页只渲染一次；该样本的压缩比例不代表所有 PDF。
- 中文样本的字体改为完整嵌入后，用独立 Poppler 渲染源文件与输出检查可见字形；
  最初的缺字出现在测试源 PDF 自身，不是压缩器删除了字形。
- 真实 CLI 参数入口以及 MCP 的 mode/clarity/target_bytes 调用通过；MCP 已达标状态返回零输出、零尝试。
- `npm run test:release`：89 个 npm 脚本通过，其中安全 981 项；完整 Rust：131 passed、2 ignored。
  架构、前端 build、CLI/MCP 与差异格式检查通过。只保留已有构建/传递依赖提示。
- 旧大样本 QA 脚本已更新语义并做语法检查，本轮没有重新执行其全部历史大矩阵；
  其他 Windows/GPU/DPI 与特殊 PDF 仍需测试设备确认。没有 OCR 质量评分或任意目标可达承诺。
- 两个新增共享 core 文件使用 Git intent-to-add 纳入差异审查；没有提交、推送、发布 npm 或打包。
