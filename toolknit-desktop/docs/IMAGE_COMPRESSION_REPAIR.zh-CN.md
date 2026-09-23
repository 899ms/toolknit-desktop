# 图片压缩回归修复（2026-09-15）

## 根因

本轮针对用户提供的三张原始 PNG 实测，不使用截图或透明背景派生文件。
三张均为 10667 × 6000、8 位 RGB PNG，合计每张 64,002,000 像素。
此前的 40MP 门禁已单独修复，本轮失败发生在编码完成后的体积判断。

旧 PNG 路径固定使用 `FilterType::Sub`，三个档位仅切换
`Fast / Default / Best` 的 DEFLATE 设置，没有进行灰度、调色板和位深的无损精简。
`Best` 并不保证输出比 `Default` 小。候选文件不小于源文件时，后端又把这一正常结果计入
`fail_count`，导致两种不同情况混为“失败”。

## 实测证据

数值单位均为字节，编号对应用户附件的三张源图顺序。

| 样本 | 原始体积 | 旧 high | 旧 medium | 旧 low | 修复后三档 | 减小 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 575333 | 1756714 | 557363 | 575943 | 220076 | 61.7% |
| 2 | 416452 | 2230763 | 554007 | 559147 | 186921 | 55.1% |
| 3 | 2571548 | 13283596 | 3271789 | 3199790 | 2238612 | 12.9% |

修复后数据来自实际 `compress_image_batch_blocking_with_progress`，共 9 次调用。
所有输出均重新解码，逐像素相同，尺寸及原有 pHYs 等相关元数据相同，源文件字节未变化。
本机每次优化及验证约 5.4、5.9、14.9 秒，不作为跨设备耗时承诺。

## 修改范围

- `src-tauri/Cargo.toml`、`Cargo.lock`：引入 oxipng 10.2.1 库，关闭默认 binary、parallel、zopfli 特性；没有外部工具下载或模型依赖。
- `src-tauri/src/native_runtime/image/compression.rs`：PNG 直接优化原始编码数据，保留元数据、透明像素颜色及 16 位精度；顺序处理，设置解压大小边界及 20 秒优化搜索期限，不做有损量化或缩放。
- 同文件：只发布非空且更小的候选，未变小的输入不计成功输出或失败；取消、错误、发布失败清理临时文件，保留唯一命名和原文件保护。
- `src/image-batch-core.js`、`src/features/image-batch/controller.js`：完成态区分已生成、未变小、失败；无输出时禁用打开文件夹，使用中性信息图标，不再抛出伪失败 Toast。
- `src/features/image-batch/template.js`、`image-batch.css`、`src/locales/{zh,en}.json`：说明 JPG 的三档画质与 PNG/WebP 无损优化，同步结果统计与信息态样式。
- `src-tauri/src/native_runtime/image/conversion_tests.rs`、`scripts/test-image-batch-{core,tool-contract}.mjs`：补充无损、调色板、透明度、16 位、EXIF 方向、未变小、坏文件、取消、重名输出及统计回归。
- `scripts/test-image-compression-browser.mjs`：隔离测试服务器，模拟 IPC 验证结果展示、语言切换、重试、取消、重开及窄屏弹窗；不替代原生文件测试。

## 兼容与边界

没有新增或改名 Tauri command、参数、返回字段、事件名、storage key、DOM ID、CLI/MCP 参数。
`success_count` 仍表示实际输出数；`fail_count/errors` 仅表示真实错误。
完整完成且仍有效的 UI 会话中，未变小数为输入数减去这两个计数；取消后不展示迟到结果。
大小合计包含有效但未变小的输入，其最终大小等于原大小，不伪造节省空间。

PNG/WebP 使用无损策略，三档画质只作用于 JPEG；已充分优化的图片不保证还能变小。
优化搜索期限不是强制中断单个压缩步骤；取消后须等当前步骤退出，不发布取消中的结果。
损坏或真实不可解码文件仍保留失败提示。

## 验证

- focused：图片 core/contract 通过；原生图片 17 passed，1 个本地样本测试默认 ignored。
- 本地样本专项：显式运行上述 ignored 测试，3 图 × 3 档全部通过。
- 浏览器：成功、部分未变小、全部未变小、部分失败、全部失败、失败重试、取消隔离、中英文、关闭重开；1400/1024/390 宽度弹窗检查通过，无 pageerror。
- `npm run test:architecture`、`npm run build`、`npm run test:release`（89 项）、`npm run test:security-release`（981 项）、`npm run test:cli` 通过。
- 完整 `cargo test --manifest-path src-tauri/Cargo.toml`：137 passed，3 ignored；`git diff --check` 通过。
- 已知 Vite 大 chunk、crypto externalization 和 Windows linker 信息仍存在。优化单测初次受本机 CRT 链接配置影响，仅为该测试进程补充已有文档记录的 `LINK` 默认库；正常 debug 测试通过，未修改生产构建配置。
- 日志和浏览器截图保存在忽略目录 `tmp/image-compression-*`；源图及产物未加入仓库。

本轮未改版本、未提交、未推送、未发布，也未重新生成安装包。旧安装包不包含本轮原生修复。
