# LDPlayer ⇄ Via ⇄ ChatGPT Bridge

把雷电模拟器里 Via 浏览器打开的 ChatGPT 变成 DSH（DeepSeek Harness）可以调用的工具：
发一段提示词进去，等回复生成完，把正文拿回来。反过来也能让页面自己「新建对话」，避免长任务把上下文撑满。

```
DSH 对话 ──工具──► 本机 Bridge (127.0.0.1:18765)
                     │  ▲
              adb reverse│  │ HTTP 轮询 + 回传
                     ▼  │
              雷电模拟器 ──► Via ──► ChatGPT 页面（用户脚本）
```

## 仓库结构

| 目录 | 内容 |
|------|------|
| `windows-bridge/` | 本机 Bridge 服务（Node.js，零依赖）：任务队列、租约、ADB 映射、用户脚本分发、REST API + CLI |
| `windows-bridge/dsh-plugin/` | DSH 插件外壳 `dsh-ldplayer-bridge`：把桥注册成 `gpt_send_message` / `gpt_wait_reply` / `gpt_bridge_status` / `gpt_new_chat` / `gpt_install_userscript` 等原生工具 |
| `windows-bridge/via/` | Via 用户脚本：在 ChatGPT 页面里领任务、填字、发送、等待生成结束、回传结果 |
| `windows-bridge/src/` | `server.js`（HTTP 路由）、`store.js`（队列/租约）、`client.js`（CLI 用的客户端）、`adb.js`、`config.js` |
| `LDPlayer_Via_DSH_Bridge_v0.1.2/` | 第一版设计与文档：协议 `protocol/Bridge_API_v1.md`、安装步骤、验收清单、排障 |

## 快速开始

```powershell
# 1. 准备配置（把占位符换成你自己的值）
Copy-Item windows-bridge/config.example.json windows-bridge/config.json
node windows-bridge/bin/dsh-bridge.js token        # 生成 token，填进 config.json

# 2. 起服务
node windows-bridge/bin/dsh-bridge.js serve

# 3. 让模拟器能访问本机端口
adb reverse tcp:18765 tcp:18765

# 4. 在 Via 里安装用户脚本（见下），然后自检
node windows-bridge/bin/dsh-bridge.js status
node windows-bridge/bin/dsh-bridge.js selftest     # 23/23
```

在 Via 里安装脚本：打开 `http://127.0.0.1:18765/install/<token>/bridge.user.js` → 菜单 → 设置 → 脚本 → 更新。**更新后必须重载页面**（Via 不会重跑已加载的脚本），心跳里的版本号才会变。

## DSH 插件

```powershell
plugin_manager install_bundle target="link:<repo>/windows-bridge/dsh-plugin"
# 改完 index.js 后需要重载
plugin_manager set_bundle target="dsh-ldplayer-bridge" enabled=false
plugin_manager set_bundle target="dsh-ldplayer-bridge" enabled=true
```

注册的工具：

| 工具 | 作用 |
|------|------|
| `gpt_bridge_status` | 桥是否在线、队列计数、Via 心跳/ready/页面、ADB 映射 |
| `gpt_send_message` | 建任务 → 等领取 → 等回复（`new_chat:true` 可先开新对话） |
| `gpt_wait_reply` | 等已有 `task_id` 完成并取正文 |
| `gpt_new_chat` | 让页面回到空白新对话（可留在同一项目内） |
| `gpt_install_userscript` | 用 adb 自动走完 Via 的脚本更新流程并校验心跳版本 |

## 设计要点

- **只轮询不推送**：页面脚本定时 `POST /v1/lease` 领任务，天然支持断线重连；页面重载会先把在途任务存进 `GM_setValue`，重载后补发或补报结果。
- **上限检测**：读页面上的「已达消息上限 / context window is full」等提示，命中就新建对话再重发，避免空等 5 分钟。
- **发送竞态**：发送按钮水合前点击无效，所以等「草稿离开输入框」或「出现新的助手节点」才算发出，最多重试 3 次。
- **安全边界**：桥只监听 `127.0.0.1`，用 64 位 token（`X-DSH-Token` 头）鉴权；token 只存在本机 `config.json`，不进仓库。

## 已知限制

- 依赖 Via 的脚本更新界面坐标（1920×1080），换分辨率/缩放要改 `VIA_UPDATE_TAPS` 或手动更新脚本。
- ChatGPT Web 的 DOM 是虚拟化的，滚动会卸载旧消息，因此不能用 `innerText` 长度推断上下文占用；只能靠页面自报的额度提示。
- 目前只针对 ChatGPT 网页版；其它站点需要改选择器。

## License

MIT
