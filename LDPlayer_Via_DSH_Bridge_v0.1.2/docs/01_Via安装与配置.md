# Via 用户脚本安装与配置

## 前提

1. 雷电模拟器已启动。
2. Via 浏览器已安装并能正常打开 `https://chatgpt.com/`。
3. ChatGPT 已由你本人正常登录。
4. Windows Bridge 已启动，监听 `127.0.0.1:18765`。
5. 已为目标模拟器执行 ADB reverse（见下一份文档）。

## 建议先跑诊断脚本

先安装 `via/DSH-Bridge-Diagnostic.user.js`。它会显示 GM_xmlhttpRequest 是否存在、Bridge health 是否可达，以及 ChatGPT 输入框、发送按钮和 Assistant 节点是否可被定位。诊断通过后，再安装正式脚本 `via/DSH-GPT-Bridge.user.js`。两个脚本不要同时长期启用，避免面板重叠。

## 安装脚本

1. 将 `via/DSH-GPT-Bridge.user.js` 放到 Windows 易于访问的位置。
2. 通过雷电共享文件夹、ADB push，或 Via 可访问的本地文件方式，把脚本文件放进模拟器。
3. 在 Via 中打开该 `.user.js` 文件，按 Via 提示确认安装；也可以从 Via 菜单进入脚本管理器，选择导入/添加脚本（菜单文字可能因版本不同而不同）。
4. 打开 Via 的脚本管理器，确认 `DSH GPT Bridge (Via)` 已启用。
5. 修改脚本中的 `BRIDGE_TOKEN`，使其与 Windows Bridge 配置的 token 完全一致。若 Via 不能直接编辑已安装脚本，请修改原文件后重新导入/安装。
6. 确保脚本只匹配 `https://chatgpt.com/*` 和 `https://chat.openai.com/*`，不要扩大到所有网站。
7. 打开或刷新 ChatGPT 页面。

## 配置项

在脚本顶部修改：

- `BRIDGE_BASE`：默认 `http://127.0.0.1:18765`。使用 ADB reverse 时保持此值。
- `BRIDGE_TOKEN`：替换成随机长字符串；不得提交到公共仓库或截图公开。
- `CLIENT_ID`：当前 Via 客户端标识。单实例可用 `ldplayer-via-main`。
- `POLL_INTERVAL_MS`：轮询间隔，默认 1800ms。
- `REPLY_TIMEOUT_MS`：等待 GPT 回复上限，默认 180000ms。

## 成功标志

ChatGPT 页面右下角出现 `DSH ↔ GPT Bridge` 状态面板，点击“检查连接”后显示 Bridge 在线。

如果面板完全不出现：
- 确认脚本已启用；
- 确认地址是 chatgpt.com 或 chat.openai.com；
- 确认 Via 的 JavaScript 未针对该站点禁用；
- 查看 Via 的脚本管理器是否报告脚本执行错误。

如果面板出现但 Bridge 离线：
- 检查 Windows Bridge 是否运行；
- 检查 ADB reverse；
- 检查 token 是否一致；
- 检查 Bridge 是否绑定 `127.0.0.1` 且端口为 18765。

## 当前限制

脚本依赖 ChatGPT 页面中的输入框、发送按钮和 assistant 消息节点。ChatGPT 前端更新可能改变 DOM，需要调整 `findComposer()`、`findSendButton()`、`assistantNodes()` 和 `isGenerating()`。
