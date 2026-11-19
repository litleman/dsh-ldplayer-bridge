# dsh-ldplayer-bridge — 把桥接注册成 DSH 原生工具

这是 `windows-bridge` 的 DSH 插件外壳：把「往雷电里的 ChatGPT 发一句话、把回复拿回来」变成一个可以在对话里直接调用的工具，而不是每次让模型去 shell 里跑 CLI。

```
对话 → gpt_send_message ─┐
                          ├─ HTTP + X-DSH-Token → 127.0.0.1:18765（windows-bridge serve）
对话 → gpt_bridge_status ─┘                              │
                                            adb reverse  ▼
                                     雷电模拟器 → Via → ChatGPT
```

## 注册的工具

| 工具 | 作用 | 返回 |
|------|------|------|
| `gpt_bridge_status` | Bridge 是否在线、队列计数、Via 心跳 / ready / 页面、adb reverse 映射 | 多行中文状态摘要（`ok` = Bridge 在线且有新鲜心跳） |
| `gpt_send_message` | 建任务 → 等 Via 领取 → 等 ChatGPT 回复；`wait:false` 时立即返回 `task_id` | `ok / task_id / state / reply / error / elapsed_ms` |
| `gpt_wait_reply` | 等一个已存在的 `task_id` 完成并取回正文 | 同上 |
| `gpt_install_userscript` | 用 adb 补 reverse → 在 Via 打开安装地址 → 按 1920×1080 坐标走「菜单 → 设置 → 脚本 → 更新 → 确认」→ 用心跳里的 `script_version` 校验是否真升到服务端版本 | `ok / url / served_version / installed_versions / summary` |

失败不抛异常，而是 `ok:false` + 中文 `error`，模型可以据此决定是否先用 `gpt_bridge_status` 排查。

## 在 Via 里安装 / 更新用户脚本

脚本本身由 Bridge 的安装路由提供：`http://127.0.0.1:<port>/install/<token>/bridge.user.js`（`src/server.js` 把 `bridge.user.js` 映射到 `via/DSH-GPT-Bridge.user.js`）。所以升级脚本只要**在 `via/` 里改版本号**，不必重新分发文件。

`gpt_install_userscript` 把这一步也自动化了：

1. `adb reverse tcp:<port> tcp:<port>`（设备侧才能访问 Bridge）；
2. `am start -a android.intent.action.VIEW -d <install url> -p mark.via`；
3. 依次点 `菜单(1851,80) → 设置(1852,391) → 脚本(600,727) → 更新(1871,90) → 确认(1166,699)`（1920×1080；可用 `settle_ms` 调间隔）；
4. **强制重载页面**（`am force-stop mark.via` 后再打开 `chat_url`，默认 `https://chatgpt.com/`）——脚本库更新后 Via 不会重跑已加载的脚本，只做 SPA 导航心跳会一直停在旧版本；
5. 轮询 `/v1/status` 的 `clients[].script_version`，只有当心跳报出**服务端正在提供的版本**才返回 `ok:true`。

`open_only=true` 只做第 1、2 步；Via 布局不同（别的分辨率/缩放）时，先用 `open_only` 打开页面，再自己点，或改 `VIA_UPDATE_TAPS`。

## 安装（本机 profile）

插件已通过 DSH 的 plugin_manager 以 `link:` 规格装进 `desktop` profile，`package.json` 里写入依赖，`dsh.profile.bundles` 里追加 `dsh-ldplayer-bridge`：

```powershell
# 已装；重装或换机时：
plugin_manager install_bundle target="link:D:/Administrator/allWorkFiles/ds-workspace/雷电bridge/windows-bridge/dsh-plugin"
# 改完 index.js 后必须重新加载（HMR 不接管工具注册）。set_bundle 用包名，实测返回 applied：
plugin_manager set_bundle target="dsh-ldplayer-bridge" enabled=false
plugin_manager set_bundle target="dsh-ldplayer-bridge" enabled=true
# 也可以只重载这一条 loader 条目：
plugin_manager set_plugin target="include:ldplayer-bridge" enabled=false
plugin_manager set_plugin target="include:ldplayer-bridge" enabled=true
```

## 声明方式（这就是 DSH 标准插件写法）

三个文件即可，和官方 `@deepseek-ai/dsh-tool-todo`、第三方 `dsh-free-search` 完全同构：

1. `package.json`：`"type":"module"`、`main`/`exports` 指向 `index.js`，并声明
   `"dsh": { "bundle": { "patch": "cordis.patch.yml" }, "engines": { "dsh": ">=0.2.1-rc.2 <0.4.0-0" } }`；
   `@deepseek-ai/dsh-tools`、`@deepseek-ai/schemastery` 放 peerDependencies 且标 optional（由宿主提供）。
2. `cordis.patch.yml`：`- insert: [{ id: ldplayer-bridge, name: dsh-ldplayer-bridge, config: {...} }]`。
3. `index.js`：`export { name, inject, Config, apply }`，其中
   `inject = ["tools"]`、`Config = z.object({...})`（`z` 来自 `@deepseek-ai/schemastery`），
   `apply(ctx, config)` 里 `ctx.tools.register(defineTool({ name, description, parameters, output, execute }))`。

`defineTool` 的 `parameters` 是 DSH 的 value schema DSL：字段用 `{ type, required, description, enum, items, properties, additionalProperties }`。**不支持 `minimum`/`maximum`**（会抛 `JsonSchemaError: ... is not supported by the value schema DSL`），取值范围在 `execute` 里自己 clamp。

## 配置项

| 键 | 默认 | 说明 |
|----|------|------|
| `bridgeDir` | 本插件上一级目录 | `windows-bridge` 的位置，用来读 `config.json` 和 `src/client.js` |
| `defaultTimeoutSeconds` | 180 | 工具未传 `timeout_seconds` 时的等待上限（10–900） |
| `pollIntervalMs` | 500 | 轮询任务状态的间隔 |

Bridge 的地址与 token 不在这里配：插件每次调用都读 `windows-bridge/config.json`，所以 `dsh-bridge token --rotate` 之后不用重启 DSH。

## 验证

```powershell
# 前提：dsh-bridge serve 在跑、Via 停在 chatgpt.com 且脚本已「启动」
cd D:\Administrator\allWorkFiles\ds-workspace\雷电bridge\windows-bridge
node bin/dsh-bridge.js status          # Bridge 在线 + Via 心跳
node bin/dsh-bridge.js selftest        # 23/23
node bin/dsh-bridge.js diag            # 10 项全绿（含设备侧 curl 回环）
```

对话内：`gpt_bridge_status` → `gpt_send_message({ text: "…" })` → 直接拿到 ChatGPT 的回复正文。
