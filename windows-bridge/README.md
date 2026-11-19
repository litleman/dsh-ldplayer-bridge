# windows-bridge — DSH ↔ Via ↔ ChatGPT 桥的 Windows 端

本目录是 v0.1.2 包中 `docs/03_交给DSH继续开发的说明.md` 所列 8 项 Windows 端交付物的实现，
零第三方依赖（Node ≥ 20），所有流量只走 `127.0.0.1:18765`，再经 `adb reverse` 进入雷电模拟器里的 Via。

```
DSH（对话内工具 gpt_* / 本机 CLI）
  │  HTTP + X-DSH-Token  127.0.0.1:18765
  ▼
dsh-bridge serve ── 任务队列（queued → leased → running → succeeded/failed/timed_out/cancelled）
  ▲
  │  adb reverse tcp:18765 tcp:18765
  ▼
雷电模拟器 → Via → https://chatgpt.com（Via 用户脚本：领任务 / 填输入框 / 抓回复 / 回传）
```

## 1. 交付物对照（docs/03 的 8 项）

| # | 需求 | 实现位置 | 验证方式 |
|---|------|----------|----------|
| 1 | Bridge HTTP Server（127.0.0.1:18765） | `src/server.js`、`bin/dsh-bridge.js serve` | `dsh-bridge status` |
| 2 | X-DSH-Token 鉴权（常量时间比较） | `src/util.js` `tokenMatches()`、`src/server.js` `requireToken()` | `dsh-bridge selftest`（401 两项） |
| 3 | 任务队列：创建 / 领取 / 回传 | `src/store.js`、`src/server.js` | `dsh-bridge selftest`、`send` |
| 4 | task_id 关联与幂等 | `src/store.js` `submitResult()` | selftest 的 duplicate / already_finished |
| 5 | 超时与取消 | `TaskStore.sweep()`、`POST /v1/tasks/{id}/cancel` | selftest 的 timed_out / cancelled |
| 6 | ADB 发现 serial + reverse | `src/adb.js`、`dsh-bridge adb setup` | `dsh-bridge adb status`、`diag` |
| 7 | DSH 工具层（status / send / wait） | `dsh-plugin/`（`gpt_bridge_status` / `gpt_send_message` / `gpt_wait_reply`）+ `bin/dsh-bridge.js` | 对话里调 `gpt_bridge_status`；或 `dsh-bridge send --text "…"` |
| 8 | 健康诊断（Bridge / reverse / 心跳 / 页面） | `dsh-bridge diag` | 10 项检查全绿 |

## 2. 快速开始

```powershell
cd D:\Administrator\allWorkFiles\ds-workspace\雷电bridge\windows-bridge
node bin/dsh-bridge.js init          # 生成 config.json（随机 token、探测 adb 与设备）
node bin/dsh-bridge.js serve --verbose   # 前台运行；生产建议用计划任务/后台作业托管
node bin/dsh-bridge.js adb setup     # adb reverse tcp:18765 tcp:18765
node bin/dsh-bridge.js diag          # 端到端自检（含设备侧 curl 回环）
```

Via 端脚本有两种安装方式（二选一）：

1. **推荐：安装链接**（token 已注入，无需手工改脚本）
   `dsh-bridge enroll` 会打印两条链接，例如
   `http://127.0.0.1:18765/install/<token>/diagnostic.user.js` 与 `.../bridge.user.js`，
   在 Via 地址栏打开即可弹出安装框（Via 只对以 `.user.js` 结尾的 URL 弹框）。
2. `dsh-bridge enroll --push` 把渲染好的脚本推到 `/sdcard/Download/`，再用 Via 的「设置 → 脚本 → + → 本地文件」导入。

> 注意：`am start file:///...user.js` 在 Android 14 上会 `ERR_ACCESS_DENIED`（分区存储），不要用。
> 打开网页必须指定 Via，否则会落到系统默认浏览器：
> `adb -s emulator-5554 shell "am start -n mark.via/.Shell -a android.intent.action.VIEW -d 'https://chatgpt.com/'"`

## 3. 命令一览

| 命令 | 作用 |
|------|------|
| `init [--port] [--adb] [--serial] [--force]` | 生成/覆盖 `config.json`（会新建随机 token） |
| `serve [--verbose]` | 启动 Bridge，写 `.state/bridge.pid`，Ctrl-C 优雅关闭 |
| `status [--json]` | Bridge 版本、队列计数、Via 心跳、ADB/reverse 概况 |
| `diag [--json]` | 8 项 + 设备侧 curl + 页面状态，任一失败退出码 2 |
| `send --text "…" [--timeout 180] [--session …] [--no-wait] [--json]` | 建任务并等待回复；成功打印回复正文 |
| `new-chat [--timeout 60] [--no-wait] [--json]` | 让页面新建一个对话（回到项目内空白会话），用于上下文已满或换议题 |
| `wait --id req-000001` | 只等待已有任务 |
| `get --id` / `cancel --id` / `tasks` / `clients` | 任务与客户端查询 |
| `adb status\|devices\|setup\|remove` | 设备发现与 reverse 管理 |
| `enroll [--push]` | 渲染带 token 的 Via 脚本到 `out/`，可选推送 |
| `token [--show\|--rotate]` | 查看/轮换 token（轮换后需重新 enroll 并重启 serve） |
| `selftest` | 23 项协议自测，不碰真机（临时目录 + 随机端口） |
| `mock-via [--client --interval --once --fail --typing --reply]` | 模拟 Via 客户端，做无真机联调 |

退出码：`0` 成功 ｜ `1` 用法/配置错误 ｜ `2` 任务失败或诊断未通过 ｜ `3` Bridge 不可达。

## 4. HTTP 协议（v1.1，向后兼容 protocol `v1`）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/v1/health` | `{"status":"ok","protocol":"v1.1","version":"0.2.0","server_time":…}` |
| GET | `/v1/status` | 队列计数 + 客户端列表 |
| GET | `/v1/clients` | 仅客户端心跳 |
| GET | `/v1/tasks/next?client_id=&page=&ready=&generating=&v=` | 原子领取一条任务；无任务返回 `{"task":null}` |
| POST | `/v1/tasks` | `{text, session_id?, timeout_seconds?, client_id?}` → 201 `{id,…}` |
| GET | `/v1/tasks?limit=&status=` | 任务列表 |
| GET | `/v1/tasks/{id}` | 单任务详情 |
| POST | `/v1/tasks/{id}/result` | `{client_id, status:"success"\|"error", reply?\|error?, completed?}` |
| POST | `/v1/tasks/{id}/cancel` | 取消（终态任务返回 409） |
| POST | `/v1/diag/page` | Via 页面把 DOM 诊断报告回传，落盘 `.state/page-report.json` |
| GET | `/install/<token>/<diagnostic\|bridge>.user.js` | 渲染好 token 的脚本（供 Via 安装，token 在路径里） |

所有端点都必须带 `X-DSH-Token`；`/v1/tasks/next` 另受 `limits.minPollIntervalMs` 轮询节流（超频 429 `poll_too_fast`）。

## 5. 安全设计

- 仅监听回环，启动时校验 host 属于 `127.0.0.0/8`/`::1`，非回环请求 403。
- token：48 字节随机（base64url，长度 64），存 `config.json`（`0o600`）；比较时先各自 sha256 再 `timingSafeEqual`，避免长度与内容时序泄漏。
- 日志默认不记录任务正文与 token（`logging.taskText=false`，日志里只出现 `maskToken()` 结果）。
- 请求体上限 64 KB（`413 body_too_large`），任务文本上限 20000 字符（`400 text_too_long`），队列上限 200 条、保留 500 条。
- 安装链接把 token 放在 path 里，是因为 Via 只对 `.user.js` 结尾的 URL 弹安装框；该链接等价于凭据，不要外传。

## 6. 任务状态机与容错

- `queued → leased →（Via 执行中）→ succeeded | failed`，另有 `timed_out`、`cancelled`。
- 租约 `limits.leaseSeconds`（默认 300s）：Via 掉线/关闭页面时，任务过期重新入队，重试超过 `maxLeaseAttempts`（默认 2）才判 `failed`，不会静默丢任务。
- Bridge 重启：`.state/state.json` 里所有非终态任务重新入队，`notes` 记 `bridge_restarted`。
- 重复回传：相同载荷 → `duplicate:true`（幂等），不同载荷 → `409 already_finished`；非租约持有者 → `409 not_lease_owner`。
- 取消：`POST /v1/tasks/{id}/cancel` 只能从非终态进入 `cancelled`。

## 7. Via 脚本的两处关键细节

1. **GM_* 只能 `typeof` 探测后再调用**。Via 未 grant 的 `GM_getValue/GM_setValue/GM_registerMenuCommand` 是未声明标识符，裸引用会抛 `ReferenceError` 直接终止整个脚本——表现为「脚本装了、页面没面板、Bridge 收不到心跳」。
2. **回复选择器锚定无障碍标题，不锚定 hash 类名**。当前 ChatGPT（Via/WebView 146、Android）里已没有 `[data-message-author-role]`、`article`、`[data-message-id]`，助手轮次的稳定锚点是 `h1..h6.sr-only` 内文本 `ChatGPT 说：` / `ChatGPT said:`；脚本先试 legacy 选择器，为空再走该兜底。

### 面板默认收起

页面属于 ChatGPT，两个脚本都不默认占屏：

- Bridge（`DSH-GPT-Bridge.user.js` v0.2.3）：右下角只有一枚胶囊 `DSH ↔ GPT · <状态>`，点它展开完整面板（检查连接 / 暂停 / 收起），点标题或「收起」回到胶囊；出错时胶囊边框与文字变红。v0.2.3 起支持 `new-chat` 控制任务（点侧栏「新聊天」→ 回到项目内空白会话），并在检测到「上下文窗口已达上限 / 已达到消息上限」时快速失败、自动新开对话后重发一次。
- Diagnostic（`DSH-Bridge-Diagnostic.user.js` v0.2.9）：胶囊 `DSH 诊断` 位于 Bridge 胶囊正上方（`bottom:58px`，避免重叠），点开才执行自检并显示明细；后台的 DOM 快照上报（`scheduleReports`）不受影响。

## 8. 排障

| 现象 | 先查 |
|------|------|
| `diag` 报「Via 客户端心跳」未通过 | Via 是否停在 `https://chatgpt.com/`；脚本开关是否 ON；是否被暂停（点开右下胶囊，按钮显示「启动」= 已暂停） |
| 任务一直 `queued` | `dsh-bridge clients` 看心跳时间；Via 页面是否被切到后台太久 |
| 任务 `failed`：等待回复超时 | 页面是否仍在生成、是否登录失效、选择器是否又改版（用 Diagnostic 脚本发 `/v1/diag/page` 看 `counts`/`spoken_chain`） |
| `fetch failed` / 401 | token 不一致：`dsh-bridge token --show` 与 Via 脚本内 `BRIDGE_TOKEN` 对比；轮换过 token 就要重新 enroll |
| `reverse 未生效` | `adb -s <serial> reverse --list`；雷电重启后映射会丢，重跑 `dsh-bridge adb setup` |
| 安装链接打不开 | Bridge 是否在跑、token 是否最新、URL 是否以 `.user.js` 结尾 |

`.state/` 下的 `bridge.log`（JSONL）、`state.json`、`page-report.json`、`ui*.xml` 是现场取证材料。

## 9. 已知限制

- 只支持单个 ChatGPT 会话（`session_id` 仅作标记，脚本不切换会话）；多会话需要扩展 `/v1/tasks/next` 的匹配逻辑。
- 依赖页面文案（`ChatGPT 说：`）与 compose 结构；ChatGPT 改版可能导致抓取失败，需用 Diagnostic 重新采样。
- Via 的 GM_xmlhttpRequest 不支持流式，回复靠「停止按钮消失 + 文本静止 2.6s」判定完成，极长回答可能偏慢。

## 10. 作为 DSH 插件在对话里直接用

`dsh-plugin/` 是 DSH 标准插件包（`dsh-ldplayer-bridge`）：`export { name, inject, Config, apply }`，`apply(ctx)` 里用 `ctx.tools.register(defineTool(...))` 注册三个工具，和官方 `@deepseek-ai/dsh-tool-todo` 同构。

| 工具 | 用途 |
|------|------|
| `gpt_bridge_status` | Bridge 在线 / 队列计数 / Via 心跳与页面 / adb reverse |
| `gpt_send_message` | 把提示词交给雷电里的 ChatGPT 并取回回复（`wait:false` 只建任务） |
| `gpt_wait_reply` | 等一个已有 `task_id` 的结果 |

装法（已在本机 `desktop` profile 装好，`link:` 规格）：

```powershell
plugin_manager install_bundle target="link:D:/Administrator/allWorkFiles/ds-workspace/雷电bridge/windows-bridge/dsh-plugin"
# 改完 dsh-plugin/index.js 后必须重载（HMR 不接管工具注册）：
plugin_manager set_plugin target="include:ldplayer-bridge" enabled=false
plugin_manager set_plugin target="include:ldplayer-bridge" enabled=true
```

声明方式见 [dsh-plugin/README.md](dsh-plugin/README.md)：`package.json` 的 `dsh.bundle.patch` → `cordis.patch.yml` 的 `insert` → `index.js` 的 `name/inject/Config/apply`。插件每次调用都读 `config.json`，所以轮换 token 后不用重启 DSH；但 `dsh-bridge serve` 必须先在跑。