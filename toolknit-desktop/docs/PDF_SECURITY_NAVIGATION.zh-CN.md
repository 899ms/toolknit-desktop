# PDF 加密与解密密码页导航

## 范围与契约

- `features/pdf-security/shell.js` 为两个工具复用同一个导航节点：密码页打开时移动工具页原 topbar，
  返回/取消/Escape 后还原原位置。不会 clone 导航、产生重复 ID 或另绑窗口动作；保留上传队列，
  离开密码页清空密码。用现有 `createModalSession` 管理父页 inert、焦点、Tab 循环和 Escape。
- `template.html` 保留 `pdfEncryptPasswordDialog`、`pdfDecryptPasswordDialog`，为两者增加明确的
  `data-tool-page-chrome` 标记和对话框语义。内容体在共享导航下面居中并独立滚动；父工具内容固定
  在原第二行，导航移动不会造成背景内容上移。密码及权限选项、加解密引擎和导出契约不变。
- `shared/tool-page-shell.js` 的全局捕获代理识别显式标记的子页面，也继续识别原 Overlay 根。
  子页 Back 不交给 lazy registry 关闭整个工具，而由 feature 返回父页；窗口/网页/支持作者/设置
  仍使用原全局 owner。设置与支持作者覆盖密码页时保留表单，返回后可以继续。
- 新增 `common.backToPrevious` 中英文词条；未新增 DOM ID、storage key、事件或原生命令。

## 验证方法

```powershell
node scripts/test-pdf-security-tool-contract.mjs
node scripts/test-app-runtimes.mjs
node scripts/test-pdf-encrypt-core.mjs
node scripts/test-pdf-decrypt-core.mjs
npm run build
node scripts/test-pdf-security-navigation-browser.mjs
```

浏览器测试沿用 `TOOLKNIT_TEST_MODULES` / `TOOLKNIT_TEST_BROWSER`，覆盖两种主题、中英文、
1400x887 / 1100x700 / 720x480 / 720x320，按相同视口与 PDF 压缩模板比较导航高度/配色/间距。
验证按钮命中、输入焦点、Tab、返回/取消/Escape、设置/支持作者往返、重开和浏览器真实加密下载。

`qa-pdf-security-navigation-native.mjs` 仅对单独 identifier 和数据目录的本地诊断实例执行，
须设置 `TOOLKNIT_TEST_ISOLATED_NATIVE=1` 和本地 `TOOLKNIT_CDP_ENDPOINT`。
原生 UI 使用支持的定向拖放事件加入样本，不覆盖只读 IPC 入口。另行显式调用加解密原生命令，
真实处理文件、验证错误密码拒绝和解密输出，样本与结果只写入原生白名单允许的
`src-tauri/target/debug/qa-pdf-security-navigation`，不改用户输出配置。截图和报告仍在 tmp 目录。
原生 UI 回归不触发会使用用户默认输出位置的确认按钮；确认流程另由浏览器加密下载验证。
窗口动作派发由共享契约测试验证，不宣称实际操作了 Windows 最小化/最大化/关闭。
不得对用户正在使用的实例执行此脚本。

截图和测试报告仅保存在忽略目录 `tmp/pdf-security-navigation`；本轮不打包、不修改版本或发布。

## 本轮结果

- 加解密核心、PDF security 契约、共享导航事件与架构检查通过。
- 浏览器 32 组布局、9 条流程通过；含实时切换语言、完整导航、父页保留、Tab/焦点、
  返回/取消/Escape、反复打开及真实浏览器加密下载，页面错误和焦点警告为零。
- 隔离原生密码页的定向拖放、设置往返、返回/Escape 和密码清理通过；原生命令独立执行的
  加密、错误密码拒绝和解密输出通过，解密结果可重新打开且页数正确。
- 发布门禁 89 个 npm 脚本通过，包含安全 977 项、CLI/MCP、架构及前端 build。
  完整 Rust 为 128 passed、2 ignored。保留既知构建提示；未重新测试其他 Windows/DPI 设备。
- 诊断实例已关闭，用户原测试实例和旧安装包未改变。实际窗口最小化/最大化/关闭未自动执行，
  本轮验证的是按钮可命中、复用原导航节点以及共享代理的动作调用契约。
