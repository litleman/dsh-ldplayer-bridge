# 测试矩阵（advisor-toggle）

对应实现见 `index.js` / `client.js` / `config.js`；跑法见每行「位置」列的 `node --test` 目标。
本表只列**已存在**的用例，不做「计划中」的占位（对抗评审要求：未实现的不得写成已实现）。

## 一、授权与门禁（自动化）

| # | 场景 | 触发点 | 期望 | 位置 |
| --- | --- | --- | --- | --- |
| T1 | 摘要完整不截断 | `contentVersion()` | 64 位十六进制 | `test/p0.test.mjs` |
| T2 | 授权绑计划号 + 工具快照 | `makeGrant()` | `planId`/`toolSnapshotDigest` 必填 | `test/p0.test.mjs` |
| T3 | 用别的计划的授权 | `grant.planId` ≠ `state.activePlanId` | 拒绝 + 清 grant + `grantExpired=plan-mismatch` | `test/p0.test.mjs` |
| T4 | 工具集在授权后变化 | `toolSnapshotDigest` 不同 | 拒绝 + 清 grant + `grantExpired=tool-snapshot` | `test/p0.test.mjs` |
| T5 | 版本漂移但同批次 | 版本变、grant 未过期未超额 | 放行 + `why=granted-drift` + 日志 `advisor:version-stale` | `test/p0.test.mjs` |
| T6 | 绑定字段缺失 | grant 缺 `planId`/`toolSnapshotDigest`/`expiresAt` | 一律 fail-closed（6 个断言） | `test/p0.test.mjs` |
| T7 | 工具表读不到 | `toolSnapshotOf()` → `no-tools-service`/`empty-tool-list`/抛错 | `trusted=false`，`makeGrant` 抛错 | `test/p0.test.mjs` |
| T8 | 宿主替换 tools 服务（真实 Cordis） | 同一 Context 里 `ctx.tools = B` | `resolveTools()` 立刻返回 B，摘要随之变化 | `test/c2-real-cordis.test.mjs`（C2） |
| T9 | 执行上下文里的旧服务 | 只给宿主上下文注入新服务 | 解析只认宿主上下文（C4） | `test/p0.test.mjs` |
| T10 | 卸载只清自己的绑定 | 先绑 A 再绑 B，随后 `disposeA()` | B 仍是现役；`disposeB()` 后为 `null` | `test/c2-real-cordis.test.mjs`（R3） |
| T11 | 写前复核工具集 | `enforceToolSnapshot()`，工具集变/空/抛错 | 每次重新 `list()`；变化即 `ok=false,changed=true` | `test/p0.test.mjs`（R2） |
| T12 | 重载即作废 | 再次 `apply()` | `sessions.clear()`，旧 grant 全失 | `test/p0.test.mjs` |
| T13 | 未配置 workspace | `workspaceState≠ready` | 非只读工具一律拒 | `test/gate.test.mjs` |
| T14 | 只读白名单 | `compress` / `decompress` / `pwsh` / `write` / `plugin_manager` | 前者放行、后四者拒绝 | `test/hardening.test.mjs` |
| T15 | 只读工具间接写入 | 名字像只读但会写的（`read_and_write_config` 等） | 不放行 | `test/hardening.test.mjs` |

## 二、评审链路与脱敏

| # | 场景 | 触发点 | 期望 | 位置 |
| --- | --- | --- | --- | --- |
| T16 | VERDICT 解析 | 首行 `VERDICT: GO/HOLD/NO-GO` | 正确取值；注入到正文的不算 | `test/gate.test.mjs` |
| T17 | 外发脱敏（真实 `review()`） | 正文含 token / 用户名 | 外发 body 无真值、含 `<redacted>`、头部写命中数 | `test/review-redaction.test.mjs` 第 1 条 |
| T18 | 脱敏失败必须拒发 | `setRedactor(() => throw)` | 桥请求数 **0**，结果非成功 | `test/review-redaction.test.mjs` 第 2 条 |
| T19 | `<agent-message>` 注入 | 正文里写 `</agent-message>` | 被转义，nonce 标签不被闭合 | `test/hardening.test.mjs` |
| T20 | 会话串行 | 同会话并发评审 | 串行执行（队列） | `test/audit.test.mjs` / `test/p0.test.mjs` |

## 三、浏览器半与端点

| # | 场景 | 触发点 | 期望 | 位置 |
| --- | --- | --- | --- | --- |
| T21 | `/hello` 首次注册 | 两次不同 `clientNonce` | 首次 200；第二次 409 `nonce_mismatch` | `test/p0.test.mjs`、`scripts/verify-restart.mjs` |
| T22 | toggle 乐观并发 | 旧 `expectedVersion` | 409，不覆盖服务端状态 | `test/gate.test.mjs` |
| T23 | override 挑战票 | 无票 / 错票 / 跨会话 / 过期 / 重放 | 全部拒绝；连领 6 张 → 第 5 张起 429 | `test/gate.test.mjs` |
| T24 | 长按 3 秒应急 | pointerdown→3s→up | 只发 `/override`（含 challenge），随后 click 被吞 | `test/longpress.test.mjs` |
| T25 | 三态胶囊 | `workspaceState` = 空 / `unconfigured` / `ready` | loading / 配置异常 / 正常；异常时点击无效 | `test/client.test.mjs` |
| T26 | 路由重试 | webServer 未就绪 | 退避重试后挂上 `/api/advisor-toggle` | `test/route-retry.test.mjs` |
| T27 | pre-step 注入带 source | 交付提醒 | 消息必须有 `source.kind`（否则宿主 liveshare 崩） | `test/injection.test.mjs` |

## 四、配置与分发

| # | 场景 | 触发点 | 期望 | 位置 |
| --- | --- | --- | --- | --- |
| T28 | workspace 未配置 | 无 `config.workspace`、无 `DSH_WORKSPACE` | `unconfigured`，禁写 | `test/config.test.mjs` |
| T29 | 相对路径 | `workspace: ./x` | `invalid('workspace-not-absolute')` | `test/config.test.mjs` |
| T30 | 路径不存在/不是目录 | `workspace-missing` / `workspace-not-directory` | 各自错误码 | `test/config.test.mjs` |
| T31 | 笔记路径逃逸 | `notes` 指向 workspace 外（含符号链接） | `notes-path-escape` | `test/config.test.mjs` |
| T32 | 桥三态 + 超时 | 文件缺失 / JSON 坏 / 无 token / 不响应 | `unconfigured` / `unreachable` / `ready`，3 秒上限 | `test/config.test.mjs` |
| T33 | 路径归属判定 | `C:\work` vs `C:\workspace-escape`、UNC、`\\?\`、`C:foo`、junction | 越界一律拒；相对路径按父目录 realpath 恢复 | `test/path-inside.test.mjs` |
| T34 | 自检扫描不到机器路径 | `selfcheck.mjs` 扫描 `config.js`/README 等 | 含 `D:\`、`/Users/x/`、`\\srv\share` 即失败 | `test/selfcheck.test.mjs` |
| T35 | `--dist` 必须独立目录 | `--dist` 缺 `--root/--source` | exit 2，不许退回源码目录 | `test/selfcheck.test.mjs` |
| T36 | 缺文件/不可读即失败 | 删 `config.js` 或目录不可读 | `target-unreadable` / FAILED | `test/selfcheck.test.mjs` |

## 五、只跑在真机/真宿主上的（非自动化）

| # | 场景 | 怎么做 | 2026-11-19 结果 |
| --- | --- | --- | --- |
| M1 | 端点自检 9 项 | `node scripts/verify-restart.mjs --base http://127.0.0.1:56051` | PASS（`docs/anomaly-report.txt`） |
| M2 | 门禁真实生效 | 开开关后调 `write` | 拒绝，回执含版本与两条出路 |
| M3 | 长按应急解除 | 真机长按胶囊 3 秒 | 解除，日志 `host:override by=user challenge=…` |
| M4 | 分发副本可装 | 干净目录 `install_bundle` + 重载 | 胶囊出现；未配 workspace 时提示配置异常 |
| M5 | 跨实例卸载 | 装两个副本，卸载其中一个 | 另一个仍可用（对应 T10 的真机版） |

## 六、明示未覆盖（不假装做到）

1. 工具**实现**身份：只能证明「工具名集合与插件代码版本没变」，证明不了同名工具的实现被换掉（见 `docs/threat-model.md` 残余风险 2）。
2. 系统级竞态：写前复核与真正落盘之间仍有毫秒级窗口（残余风险 1）。
3. 提示注入：只做结构隔离（nonce + 转义），不防「顾问自己被用户的自然语言说服」（残余风险 3）。
4. 交付提醒只是提醒，不是硬拦截（残余风险 4）。
