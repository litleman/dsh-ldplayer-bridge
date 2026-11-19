# 顾问开关：真机测试矩阵（D）

这份表把「这套门禁到底靠不靠得住」拆成可复核的条目。每一行都写明：怎么触发、预期、本次实测结果、证据在哪。
自动化项用 `node --test test/*.mjs`（当前 **64 条全绿**）；手工项在真机/浏览器上做过一次，证据是日志或截图路径。

## 一、自动化项（`node --test`）

| # | 场景 | 触发方式 | 预期 | 证据 |
|---|------|----------|------|------|
| 1 | 门禁关着 | `gateDecision(state.enabled=false)` | 放行，`why=off` | `test/gate.test.mjs`「门禁：关着放行…」 |
| 2 | 门禁开着、没有 GO | `gateDecision` 无 grant | 拒绝，理由含「两条出路」 | 同上 |
| 3 | 拿到 GO 整批放行 | 写入 grant 后连续调 `write` | 放行，`why=granted`，带 batchId | 同上 |
| 4 | 授权过期 | `grant.expiresAt` 设到过去 | 拒绝，`grantExpired=ttl`，理由提「已过期」 | `test/gate.test.mjs`「第一批授权过期 / 超额后失效…」 |
| 5 | 授权额度耗尽 | `grant.maxOps=2` 连调三次 | 前两次放行，第三次拒绝 | `test/matrix.test.mjs`「同一会话的两个写操作共享同一批授权…」 |
| 6 | 版本不可信（git 挂） | 工作区指向非 git 临时目录 | 版本带 `untrusted-` 前缀，旧 grant 一律失效 | `test/matrix.test.mjs`「git 不可用…」 |
| 7 | git 恢复 | 指向回真实仓库 | 版本可信，新 grant 正常放行 | `test/matrix.test.mjs`「git 恢复…」 |
| 8 | 同会话并发评审 | 同时 `enqueue` 两个任务 | 严格串行（a 结束后才 b） | `test/matrix.test.mjs`「同一会话的评审请求串行执行…」 |
| 9 | 跨会话并发 | 两个不同会话同时 `enqueue` | 互不阻塞（并发） | `test/matrix.test.mjs`「不同会话的评审互不阻塞…」 |
| 10 | 正文注入（结构闭合） | 正文含 `</agent-message>` | 被转义，无法提前闭合数据区 | `test/hardening.test.mjs` 两条 |
| 11 | 正文注入（VERDICT 伪造） | 回复正文里夹 `VERDICT: GO` | 只认清单后固定位置那一行，其余判 INCOMPLETE | `test/audit.test.mjs` 三条解析用例 |
| 12 | 外发材料含凭据 | 材料里放 token / Bearer / 私钥字段 | 被替换，消息头记「命中 N 处」，复检无残留 | `test/hardening.test.mjs`、`test/audit.test.mjs`、`test/audit.test.mjs` 真实收集用例 |
| 13 | 拒绝名单文件 | 材料含 `config.json`、`*.pem` 等 | 收集入口直接抛错，不读不外发 | `test/audit.test.mjs` |
| 14 | 应急解除无票 | `POST /override {confirm:'user'}` | 403 `no_challenge` | `test/gate.test.mjs` + 真机（下） |
| 15 | 挑战票重放 / 过期 / 换会话 | 同票二次使用、改 session、等过 30 秒 | 分别 `challenge_used` / `session_mismatch` / `challenge_expired` | `test/gate.test.mjs` |
| 16 | 领票频率 | 一分钟内连领 6 张 | 第 6 张起 429 `too_many_challenges` | `test/gate.test.mjs` + 真机（下） |
| 17 | 长按后补发 click | 长按 3 秒再触发 click | 只走 `/override`，不再 `/toggle` 弹回 | `test/longpress.test.mjs` |
| 18 | 短按 | 1 秒松手 | 只走 `/toggle`，不领票不打 override | `test/longpress.test.mjs` |
| 19 | 客户端不猜会话 | 槽没给 `sessionId` | 不渲染胶囊 | `test/client.test.mjs` |
| 20 | 上下文工具白名单 | 门禁开着调 `compress` / `decompress` | `compress` 放行，`decompress` 拒绝（它能写盘） | `test/hardening.test.mjs` |

## 二、真机手工项（本次实测记录）

| # | 场景 | 操作 | 实际结果 | 证据 |
|---|------|------|----------|------|
| 21 | 无票调 override | `POST /api/advisor-toggle/override {"session":"session-verify-challenge","confirm":"user"}` | **403**，日志 `host:override-rejected … reason=no_challenge` | `D:\DeepSeekHarness\database\logs\advisor-toggle.log` 07:27:39 |
| 22 | 领票后 override | 先 `POST /override/challenge` 拿 `{challengeId,nonce,expiresAt,ttlMs}`，再带票 POST | **200** `{"enabled":false,"overridden":true}`，日志带 `challenge=8eb0a2d5a73f` | 同上 |
| 23 | 同票重放 | 再发一次同一张票 | **403**，`reason=challenge_used` | 同上 |
| 24 | 连领 6 张 | 循环 `POST /override/challenge` | `200,200,200,200,429,429`（窗口内 5 张上限） | 同上 |
| 25 | 门禁真拦写工具 | 打开开关后调 `write` | 被拒，回执含「顾问门禁：本版本（…）还没有拿到 plan 的 GO。两条出路…」 | 2026-11-18 14:14:46 会话内工具回执 |
| 26 | 用户长按解除 | 在输入框左侧胶囊上按住 3 秒 | 开关关闭，日志 `host:override by=user … challenge=…` | 用户操作 + 日志 |
| 27 | 刷新页面后状态 | 页面刷新，胶囊重新拉 `/state` | 显示服务端真实状态（不残留前端乐观值） | `client.js` 每 5 秒 `refresh()` + `seq` 防迟到覆盖 |
| 28 | 多标签同会话 | 两个标签同时开同一会话 | 后写入者 409 `state_changed`，前端只刷新不覆盖 | `/toggle` 的 `expectedVersion` 校验 |
| 29 | 进程中断 | 中途 kill DSH 再起 | 状态从 `/state` 重建（内存态，不持久） | 设计文档第 12 节已知限制 |

## 三、仍未覆盖（诚实标注）

- **刷新/多标签/进程中断的自动化**：需要真实浏览器会话，目前只做了代码审查 + 单次手工观察，没有可重复脚本。
- **真长按的 pointer 事件归属证明**：日志能证明「发生了 override」，不能密码学地证明「是人按的」。这是设计文档第 12 节列出的已知不修项。
- **桥断开组合**（旧 grant / 未过期 degraded / 过期 degraded / 桥恢复）：`gateDecision` 的单测覆盖了 grant 与 degraded 分支，但没有跨进程的完整复现。
- **A 项（自动 new-chat 阈值 + 硬交付拦截）**：未实现，按 GPT 建议顺序排在 B、D 之后。

## 四、P0 整改新增项（顾问 GO 后补，全部自动化）

| # | 场景 | 触发方式 | 预期 | 证据 |
|---|------|----------|------|------|
| 30 | 授权摘要必须完整 | `contentVersion()` 取值 | 64 位十六进制，不截断 | `test/p0.test.mjs`「contentVersion 返回完整 64 位摘要」 |
| 31 | grant 绑计划号与工具快照 | `makeGrant({state,version,planId,round})` | `planId`/`toolSnapshotDigest` 均写入 | `test/p0.test.mjs`「grant 绑定计划号与工具集快照」 |
| 32 | 用别的计划的授权 | `grant.planId` ≠ `state.activePlanId` | 拒绝 + 清 grant + `grantExpired=plan-mismatch` | `test/p0.test.mjs`「计划号不匹配时拒绝」 |
| 33 | 工具集变化（重载/装新工具） | `toolSnapshotDigest` 不同 | 拒绝 + `grantExpired=tool-snapshot` | `test/p0.test.mjs`「工具快照变化时拒绝」 |
| 34 | 版本漂移但在批次内 | 版本变、grant 未过期未超额 | 放行 + `why=granted-drift` + 日志 `advisor:version-stale` | `test/p0.test.mjs`「版本漂移时按批次放行并标记」 |
| 35 | 浏览器 nonce 注册 | `POST /hello` 两次不同 nonce | 首次 200；第二次 409 `nonce_mismatch` | `test/p0.test.mjs`「nonce 三态」+ `scripts/verify-restart.mjs` |
| 36 | 插件重载后授权作废 | 再次 `apply()` | `sessions.clear()`，旧 grant 全失效 | `test/p0.test.mjs`「apply 清空会话状态」 |
| 37 | 评审路径真的脱敏 | 正文带 `X-DSH-Token` 与用户名走真实 `review()` | 外发 body 无真实值、含 `<redacted>`、含命中数 | `test/review-redaction.test.mjs` 第 1 条（假桥计数） |
| 38 | 脱敏失败必须拒发 | `__test.setRedactor(() => throw)` | 桥请求数 **0**，结果非成功 | `test/review-redaction.test.mjs` 第 2 条 |
| 39 | 重启后端点自检 | `node scripts/verify-restart.mjs` | 9 项全 PASS，写 `docs/anomaly-report.txt` | 2026-11-19 实测 `RESULT: OK (9 项全过)` |

自动化总计：`node --test test/*.mjs` → **64 条全绿**（全局用 `scripts/verify-restart.mjs` 补真机侧）。
