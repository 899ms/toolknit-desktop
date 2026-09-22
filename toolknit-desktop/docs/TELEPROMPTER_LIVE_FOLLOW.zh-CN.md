# 提词器低延迟跟随修复记录

日期：2026-09-07。分支 `codex/v3.0`，package `2.3.1`，未改版本、未打包、未提交。

## 原因与修复

- 旧流程攒满 3.2 秒再识别，单次处理后丢掉大部分上下文；模型忙时继续积压旧音频。
- 新 `audio-window.js` 使用固定 3.2 秒环形缓冲，首轮约 0.9 秒，最小更新间隔 0.45 秒。一次只运行一个推理，完成后取最新窗口；实际更新间隔仍受推理耗时约束。
- 安静音频不进入推理，讲话结束后允许一次带尾部静音的补识别。这里只是能量门限，不是能区分人声与背景声音的完整 VAD。
- 采集回调块由 4096 降到 1024。麦克风、AudioContext、原生会话和推理状态按会话持有，旧启动/旧返回不能清理或覆盖新会话。
- 旧匹配主要比较完整句子的相似度，短句开头难命中，跨句结果容易定位到前一句。
- 新匹配在附近台词上做有序编辑对齐，定位识别文本末端；几个有效字即可更新句内进度，跨句文本更新到最后读到的位置。
- 滚动窗口不再当作相互独立的 final 累加；相同、重叠、过期结果不能重复推进。新的讲话段和暂停重开仍可朗读重复台词。
- 只有匹配成功才更新阅读光标，语音驱动换句不再清空匹配器状态。提示文本仅包含此前台词，不注入未来五句。
- Whisper v1.9.1 CPU 短音频解码采用最小 512 的音频上下文、受音频长度限制的 token 数、单段输出和无 temperature 重试。保留既有取消与 DLL ABI 检查。

## 修改边界

| 文件 | 责任 |
| --- | --- |
| `src/features/teleprompter/audio-window.js` | 有界音频窗口与安静输入过滤 |
| `src/features/teleprompter/recognition.js` | 采集、实时调度、重叠元数据、会话释放 |
| `src/teleprompter-core.js` | 纯文本对齐、去重、进度、繁简识别兼容 |
| `src/features/teleprompter/controller.js` | 复用匹配进度与上下文，不改页面结构 |
| `src-tauri/src/teleprompter_whisper.rs` | 短音频解码参数及可选合成语音基准 |
| `scripts/test-teleprompter-*.mjs` | 核心、采集、竞争条件与无界面浏览器回归 |
| `scripts/qa-teleprompter-synthetic.mjs` | 原生识别结果到定位器的检查与耗时比较 |
| `package.json` | 将新增采集与离线生命周期测试纳入既有测试命令 |

公开 DOM、storage、Tauri command、CLI/MCP 参数不变。纯文本匹配仍位于已有核心模块，CLI 转写的繁简转换导入保持独立可运行；未引入新的页面依赖。

## 实测证据

环境：Windows，AMD Ryzen 5 5600，CPU 推理，已安装 Whisper Small；本地 Microsoft Huihui 合成单声道 16 kHz 音频。没有采集用户麦克风、上传音频或调用收费 API。

| 同一段合成语音的 9 个短窗口 | 原参数 | 当前参数 |
| --- | ---: | ---: |
| 平均单次解码 | 2838 ms | 816 ms |
| 当前解码范围 | — | 732–930 ms |
| 固定首轮采集等待 | 3200 ms | 约 900 ms |

平均解码耗时降低约 71.3%。这不是麦克风到屏幕的端到端延迟测量：还包括模型准备、采集回调、IPC、页面滚动等耗时。

- 原生结果送入定位器，9/9 位置检查通过；首个短片段更新句内光标，跨句正确推进，最后到达文稿末尾。
- 半句话仍可能被模型识别错；测试中的一段重复、模糊结果被定位器拒绝，等待后续新证据，没有误跳。9/9 是定位检查，不是宣称词准确率 100%。
- 试过更小的 256/384 上下文，但短片段重复与错词更明显，没有选择最低耗时的配置。
- 快读（TTS Rate=3）和低音量（Volume=20）整段合成语音真实识别通过，分别约 1.12 秒、1.34 秒；这是整段推理耗时，不是实时窗口的延迟。
- 文本对齐本机额外微基准：较长英文上下文 median 1.67 ms、p95 2.66 ms，不代表所有设备的固定帧耗时。

## 验证

- `npm run test:teleprompter`：核心、环形缓冲、系统识别、离线生命周期全部通过。
- `npm run test:architecture`：通过。
- `npm run test:release`：88 项全部通过，包含 security-release 和 build。
- `npm run test:cli`：通过，包括 CLI/MCP 契约。
- `cargo test --manifest-path src-tauri/Cargo.toml`：108 passed，1 ignored。默认运行中的可选模型测试没有启用，不能用该计数代替真实推理证据。
- 另行设置 `TOOLKNIT_TEST_WHISPER_MODEL`、`TOOLKNIT_TEST_TTS_WAV`，执行 `rolling_synthetic_speech_benchmark` 与 `chinese_tts_speech_transcribes_end_to_end`，得到上面的真实 Small 模型结果。
- `node scripts/test-teleprompter-browser.mjs`：短语光标、跨句、无关语音、暂停恢复、返回重开、Escape、隐藏焦点和控制台检查通过；截图覆盖 1366×900 与 800×600。浏览器语音事件是注入测试，不是真麦克风识别。
- `git diff --check`：通过。已知大 chunk、crypto externalization 和 Windows linker 提示仍在，未隐藏。

基准测试可通过 `TOOLKNIT_TEST_ROLLING_OUTPUT` 将合成结果写到临时 JSON，再执行：

```powershell
node scripts/qa-teleprompter-synthetic.mjs <current-synthetic.json> <baseline-synthetic.json>
```

## 尚需实机确认

真实麦克风、轻声门限、口音、远距离收音、持续背景噪声和较慢电脑尚未覆盖。Base/Medium 模型没有本轮真实性能数据；音频上下文缩短属于 Whisper 的实验性选项，不能据此承诺所有模型的相同准确度或亚秒跟随。

未更换识别引擎、下载新模型、开启可见开发窗口、打包或更改此前约定的 F12 配置。

## 2026-09-07：测试版控制台诊断追加

用户实机反馈朗读后光标仍停在开头，明确要求输出识别文字，以区分采集、识别和显示问题。本轮仅增加诊断，不改变识别参数、能量门限或台词匹配算法。此前的提词器测试安装包不会自动获得这些新日志；本轮尚未打包。

控制台筛选 `Teleprompter`，开启语音跟随后点击播放：

| 日志 | 判读 |
| --- | --- |
| `ready` / `playback` / `start` | 确认 `voiceFollow`、`engine`、文稿句数和播放状态。关闭语音跟随时不会启动麦克风识别 |
| `model-gate` / `model-loading` | 确认模型门禁是否通过，以及是否停在原生模型加载 |
| `microphone-request` / `microphone-ready` | 请求输入与 AudioContext 就绪；记录采样率、track 是否启用、静音、结束 |
| `audio` | 每秒一次；`no-audio-callbacks` 表示没有收到采集回调，`below-gate` 表示收到 PCM 但没有音量超过门限的块，`above-gate` 表示存在过门限的块，不等于确认人声 |
| `recognize` | 已提交原生识别，包含音频长度和请求编号；对应 `audio.inferenceMs` 可观察识别是否长时间未返回 |
| `transcript` | 原始识别文字、耗时、模型和 `confidence`；空文字、低置信度、过期会话也会记录明确的 `skipped` 原因 |
| `follow` | 接收到的识别文字、当前目标句、匹配分数、句内进度、光标可见性；区分 `matched`、`moved`、`pending`、`no-match-or-duplicate` |

同一个 `session` 和 `requestId` 可把原生请求、识别结果和台词匹配日志对应起来。`confidence` 源自模型的无语音概率，并非文字识别准确率。系统识别提供 `system-ready` 和 `transcript`，不会提供应用无法读取的原始 PCM 音量。

隐私与生命周期：

- 只在已有 `qa-devtools` 原生功能设置的测试窗口标记存在时启用；普通生产窗口不启动诊断计时器、不输出新增的识别文字日志。
- 按用户本次要求在本机控制台显示识别文字和当前目标短句。不保存音频、不写日志文件、不上传、不输出麦克风设备 ID、完整文稿或密钥配置。
- 收音汇总不保存 PCM 样本，仅保留计数和能量统计；暂停、关闭、错误和旧会话清理时释放所属计时器。控制台异常不得中断识别。
- 测试版控制台内容可能包含朗读文字，对外分享日志前自行检查内容。

新增 `diagnostics.js` 由提词器控制器与识别控制器复用；使用既有测试窗口标记，公开 DOM、storage、Tauri、CLI/MCP 契约不变。新增 `test-teleprompter-diagnostics.mjs`，并扩展离线生命周期和浏览器测试，覆盖诊断开关、无回调、静音、有效音量、空识别、低置信度、过期结果、匹配日志关联及清理。

## 2026-09-07：弱收音与简体输出修复

### 实机日志结论

本轮用户读到“生活处处藏着温柔与美好，平凡的日常里，总有细碎的温暖治愈人心”，光标仍停在首字。日志确认麦克风为 live、未静音，48 kHz 回调连续，并非没有采集到 PCM。背景 RMS 约 3–6，很多朗读片段约 10–95，而原固定门槛为 100：首个会话没有提交推理，后一个会话只提交了少量超过门槛的短窗口。音量不足会使有效语音被忽略，并反复重置话语起点，丢失上下文。

少量识别返回“无法接受”“视频”等无关内容；定位器拒绝这些内容是正确行为。日志中的 `confidence` 接近 1 只代表低无语音概率，不是文字正确率。本轮没有放宽匹配条件来制造进度，也没有改动 `ScriptProcessorNode`；其弃用警告不等于采集失败。

此前 Volume=20 的合成测试不覆盖这次实机的极弱音量范围，不能用此前通过的结果推断实际麦克风已经可用。

### 修改范围

- `audio-window.js`：最小 RMS 门槛改为 12，根据安静块估算的底噪取 2.5 倍门槛；保留 250 ms 前置上下文，850 ms 安静间隔才划分新话语。保持 3.2 秒有界环、900 ms 首窗和 450 ms 最小步长。孤立短脉冲不足 80 ms 不触发推理。
- 每个提交窗口统一计算增益，目标 RMS 1200、最多放大 64 倍，并保留峰值余量；不逐回调改变增益，不对纯静音或已过期音频持续推理。此门槛是能量过滤，不是人声分类器，也不能消除背景噪声或修复错误的输入设备。
- `recognition.js`、`diagnostics.js`：日志显示实际 `gateRms`、`noiseRms`、`inputRms` 和 `gain`。离线和系统识别文字在日志、交给定位器前均转成简体，QA 开关与会话清理保持原契约。
- `src/core/chinese-text.js` 与 `src-tauri/src/chinese_text.rs`：共享同一份固定版本字典，替代两套不完整的手写字符表。包括 4391 条来源词/字映射、212 条简体输出保护别名，以及 17 条“著”作为助词的台湾用字/词语例外；支持“藏著→藏着”，保留“著作、显著、乾坤、乾隆”等正确文字。英文、数字与换行不变，全部 4620 条字典输入通过重复转换检查。
- 字典来自 OpenCC `ver.1.1.9` 的 TSPhrases、TSCharacters、TWVariantsRevPhrases 和反向 TWVariants。后两者仅取“著”及其词语例外，匹配键和值先规范成简体，避免套用整份地区转换表导致原有“什么”被误改。单字链式转换收敛，并为合法词语生成已简化形式的保护别名。离线数据不到 75 KB，维护导入脚本记录源文件 SHA-256；应用不下载字典。许可、来源声明与桌面及 CLI 分发清单同步。
- 原生音视频转写、桌面预览/复制、AI 校对后的文本及 CLI 输出统一简体化。JSON 先解析，仅转换 `text` 字段，不改文件名、时间戳、token ID 或其他元数据；SRT/TXT 保持既有输出发布与唯一命名流程。
- 修复同一路径发现的 CLI 校对段数验证错误：对 Set 使用 `size`，避免有效回复总被误判。新增内部解析函数导出供测试，不新增用户 CLI/MCP 参数。

### 新实测

本机已安装 Small 模型，CPU 推理。本地 Microsoft Huihui 合成用户提供的上述短句，缩放到整段 RMS 20 和 60，分别叠加确定性的 RMS 4 底噪；首尾各加 1 秒底噪。未录制用户麦克风、调用云端、下载模型或开启可见开发窗口。

| 样本 | 原门槛通过块数 | 新流程窗口数 | 原生结果到定位器 |
| --- | ---: | ---: | --- |
| RMS 20 + 底噪 4 | 0 | 9 | 推进 8 次，到末句进度 100% |
| RMS 60 + 底噪 4 | 40 | 9 | 推进 8 次，到末句进度 100% |

最终代码复测单窗口平均解码分别约 755/781 ms。首个正确定位使用约 2.7 秒采集位置的窗口，其中包含前置 1 秒底噪；窗口采集与模型计算耗时不能混为端到端延迟。这不是“零延迟”承诺。很短的首窗仍有错字，中途也有“细岁”等替换，后续窗口能恢复至“总有细碎的温暖治愈人心”。

复现入口：`qa-teleprompter-weak-audio.mjs prepare <synthetic.wav> <windows.json>`，设置 `TOOLKNIT_TEST_WHISPER_MODEL`、`TOOLKNIT_TEST_AUDIO_WINDOWS`、`TOOLKNIT_TEST_ROLLING_OUTPUT` 后运行 Rust `weak_audio_synthetic_windows`，再执行 `qa-teleprompter-weak-audio.mjs verify <native-results.json>`。仅使用合成夹具，文件放在临时目录。

### 验证与边界

- 提词器核心、低音量/底噪/脉冲/峰值限制、离线竞争条件及诊断测试通过；用户日志中无关识别仍不能推动光标。
- 中文转换、字幕解析、校对结果、JSON 元数据保护、CLI 资源/许可与校对段数测试通过。
- 无界面浏览器覆盖繁体识别事件转简体、句内光标、跨句、无关语音、暂停、返回重开、Escape 和焦点，测试通过。
- 全量 Rust：111 passed、1 ignored；其中默认未启用的模型测试不能冒充真实推理证据，真实低音量推理由上述独立测试提供。
- 最终 `npm run test:release`：88 项全部通过，包含安全检查（977）、架构检查、CLI 包/隔离安装/MCP 契约及 `build`。`git diff --check` 通过。原有大 chunk、crypto externalization 和 Windows linker 提示仍在，没有隐藏这些提示。
- 发布安全检查要求新增共享源码被 Git 跟踪，已对本轮新增源码、字典和测试做 `git add --intent-to-add` 登记；没有提交或覆盖已有暂存内容。

公开 DOM、storage、事件、Tauri command、CLI/MCP 参数不变，仍保留现有 `auto`/`zh`/`en` 合约，中文输出统一简体，不新增其他语言模式。真实麦克风、口音、持续高噪声、远距离收音与更慢设备仍待用户验证。本轮不打包、不改版本、不提交/推送；F12 测试诊断保留，生产诊断开关不变。
