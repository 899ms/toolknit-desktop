# 长图拼接：排序与田字格

- 左侧说明左对齐；开始拼接按钮使用黑色文字。
- 参数栏按内容高度滚动，避免低高度窗口下质量、文件名和导出区域重叠；PNG 模式隐藏质量字段，JPG 模式显示。
- 排序箭头修改队列后同步刷新列表和预览。拖动复用共享指针排序，避免 Windows 原生文件拖放干扰；按处理状态锁定排序，重新渲染/销毁时释放监听。
- 方向选项保留 `vertical`、`horizontal`，新增 `grid-2`、`grid-3`、`grid-4`、`grid-5`，分别要求恰好 4、9、16、25 张有效图片。少于或多于该数量均禁用导出；添加、删除、清空、切换模式后重新判断。普通横向/纵向仍支持 2–100 张。
- 网格按队列顺序从左到右、从上到下排列。统一宽度沿用首张/最小/最大参考和缩放设置；等高格子内图片垂直居中、保持比例，不裁切、不拉伸，空白区采用既有背景色。间距仅位于格子之间。
- 桌面纯逻辑位于 `src/features/image-stitch/core.js`，预览和导出数量门禁复用同一布局。原生 `stitch_images` 在既有 `mode` 字段接受上述四个新值，并独立校验数量、尺寸和内存；PNG/JPG 继续复用取消、进度、唯一命名和临时文件原子发布。
- 没有新增 DOM ID、storage key、事件或 Tauri command；CLI/MCP 的参数、普通拼接模式和根级纯逻辑兼容入口不变。共享指针排序新增可选 `rowSelector`，默认仍为原有音频/PDF 文件列表选择器。

针对性验证：

```powershell
npm run test:image-stitch
node scripts/test-image-stitch-browser.mjs
cargo test --manifest-path src-tauri/Cargo.toml image_stitch_ --lib
node scripts/test-pdf-merge-tool-contract.mjs
node scripts/test-pdf-compress-tool-contract.mjs
```

浏览器脚本使用 `TOOLKNIT_TEST_MODULES`、`TOOLKNIT_TEST_BROWSER`、`TOOLKNIT_TEST_URL` 指定外部 Playwright、浏览器和本地 Vite。它验证真实点击/指针拖动、队列/预览同步、四档数量门禁和发送给原生命令的参数；文件检查与导出使用注入适配器。Rust 测试另行真实生成并解码四档 PNG/JPG，检查尺寸、格子像素顺序、补白、唯一输出及临时文件清理。两类证据不能互相替代。

本轮不打包、不发布、不改版本。
