# LDPlayer × Via × ChatGPT × DeepSeekHarness 桥接原型 v0.1.1

本包的目标：先完成雷电模拟器中的 Via 浏览器端，使 Windows 上的 DeepSeekHarness（DSH）未来可以通过本机 Bridge 向 Via 中已登录的 ChatGPT 网页发送消息，并收取回复。

## 当前交付范围

- Via 用户脚本：`via/DSH-GPT-Bridge.user.js`
- Via 通信诊断脚本：`via/DSH-Bridge-Diagnostic.user.js`
- Via 脚本安装说明：`docs/01_Via安装与配置.md`
- 模拟器与 ADB 配置：`docs/02_雷电与ADB配置.md`
- DSH/Windows Bridge 接口契约：`protocol/Bridge_API_v1.md`
- 请求/响应示例：`protocol/examples/`
- Windows 端集成指导：`docs/03_交给DSH继续开发的说明.md`
- 测试与验收计划：`docs/04_测试验收清单.md`
- 安全与故障排查：`docs/05_安全与故障排查.md`

## 重要说明

这是针对 Via 7.4.1 + 雷电 14 编制、可供集成和现场验证的原型，不是已经在用户机器上完成端到端实测的成品。当前测试基线已明确为 Via Browser 7.4.1、雷电模拟器 14；但无法远程进入你的模拟器，也没有 Android WebView 版本和实际 ADB serial。因此，脚本实现了约定的通信与网页交互逻辑，但需要按文档完成现场验证。

Via 官方源码中的中文用户脚本说明列出了 `GM_xmlhttpRequest`、`GM_getValue`、`GM_setValue`、`GM_registerMenuCommand` 等 API，并说明了 `@match`、`@grant`、`@run-at` 元数据。参考：
- https://github.com/tuyafeng/Via/blob/master/app/src/main/res/values-zh-rCN/strings.xml
- https://github.com/tuyafeng/Via

Android 官方说明 `adb reverse` 可以让设备/模拟器访问映射到 Windows 主机的本机服务：
- https://developer.android.com/develop/ui/views/layout/webapps/access-local-server

## 快速路线

1. 在雷电中确认 Via 能正常打开 `https://chatgpt.com/` 并登录。
2. 在 Windows 启动由 DSH 端开发/提供的 Bridge，监听 `127.0.0.1:18765`。
3. 生成一条随机 token，同时配置 Bridge 与 Via 用户脚本。
4. 对目标雷电实例执行 `adb -s <serial> reverse tcp:18765 tcp:18765`。
5. 在 Via 安装 `via/DSH-GPT-Bridge.user.js`，修改其中的 `BRIDGE_TOKEN`。
6. 打开 ChatGPT 网页，确认页面右下角桥接状态面板显示在线。
7. 从 Bridge/DSH 投递一条测试任务，确认 ChatGPT 收到消息并回传回复。

## 本版本的明确边界

- 只针对 ChatGPT 网页 UI，不调用 OpenAI API。
- 不读取、不导出 Cookie、密码或登录令牌。
- 不绕过验证码、登录验证、付费墙或访问控制。
- 不承诺 ChatGPT 页面 DOM 永久不变；网页升级后可能需要调整选择器。
- 暂按单个 Via 标签页、单个活动任务设计。多实例、多标签页和并发队列属于后续版本。
- 页面必须保持打开且可运行脚本；第一版不保证后台冻结标签页仍能及时轮询。
- 若 ChatGPT 页面结构或输入控件不匹配，脚本会报告错误，不会伪造成功状态。


## 用户确认的环境基线

- Via Browser：7.4.1
- LDPlayer：14
- Android/WebView build：待从模拟器内读取
- ADB serial：待现场读取

## v0.1.1 变更

- 加入独立诊断用户脚本，先验证 GM_xmlhttpRequest、Bridge health、页面 DOM 选择器。
- 将 Via 7.4.1 / 雷电 14 写入兼容性基线。
- 明确区分“资料支持”与“用户设备实测”：GM API 在 Via 生态中有近期实测支持记录，但尚未在用户的 7.4.1 安装上完成验证。


## 先验证 Via 到 Windows 的通信（不依赖 DSH Bridge）

可先使用 `windows-reference/bridge_probe_server.py` 启动最小健康检查服务。它只实现 `/v1/health`，用于验证 GM_xmlhttpRequest 和 ADB reverse，不具备消息队列或 ChatGPT 自动化能力。
