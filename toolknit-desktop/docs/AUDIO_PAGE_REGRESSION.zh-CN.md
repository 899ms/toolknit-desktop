# 音频页面与共享样式修复

- 音频格式转换：桌面选择器和原生拖放曾把路径包装为 `size: 0`，被严格大小校验拒绝。现在通过既有 `get_file_size` 获取真实大小，并保留空文件、10GB、100 文件限制；关闭/重新打开后旧元数据不会写回。输入错误使用中英翻译，不再直接显示英文 core 错误。
- 音频提取：模板接入 `tool-page-v2-shell` / `tool-page-v2-topbar`，恢复通用返回、网页版本、支持作者、设置及窗口按钮的尺寸与配色。开始按钮由上传状态所在容器控制可见性，不再继承共享处理按钮的初始缩小隐藏态。多音轨选择在刷新状态/语言时保持不变；过期文件大小响应不会修改新会话。
- 全局颜色/字体：`compatibility.css` 的 feature host 重置改为低优先级 `:where(...)`，使具体按钮、下拉框和图标组件样式生效，避免白底白字和字号被继承值覆盖。音频剪辑加入既有导航选择器清单，没有新建第二套导航样式。
- 开发环境：Cargo 使用标准 `custom-protocol` 默认特性，`tauri dev --no-default-features` 可以真正加载 1420 的 Vite 源码。右键检查仅在开发模式放开；只有 debug 编译且窗口配置 `devtools: true` 才自动打开开发工具，生产配置保持 `devtools: false`。

验证入口：

```powershell
npm run test:audio-convert
npm run test:audio-extract
npm run test:architecture
node scripts/qa-tool-style-sweep.mjs
node scripts/qa-audio-pages-native.mjs
```

样式脚本检查 65 个工具的空页面亮色按钮对比度与导航参数。转写工具在浏览器中有桌面门禁，因此只检查其挂载模板，不冒充转写功能验证。音频原生脚本使用外部 Playwright、当前 Tauri WebView 与 FFmpeg 合成样本：只注入文件选择器和测试输出目录，真实执行 Rust 文件大小读取、媒体探测、音频转换和音轨提取，并检查非空 MP3、按钮持续可见、颜色和打开目录目标。报告保存在忽略目录 `tmp`。

本轮仅开发验证，不打包、不发布、不修改版本。
