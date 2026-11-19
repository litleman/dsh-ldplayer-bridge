# DSH ↔ Via Bridge API v1

本协议是 Windows Bridge 与 Via 用户脚本之间的接口契约。Windows/DSH 开发应以此为基线；如需修改字段，升级协议版本并保持兼容。

## 网络约定

- Windows Bridge 监听：`127.0.0.1:18765`
- Via 访问地址：`http://127.0.0.1:18765`
- 通过 `adb reverse tcp:18765 tcp:18765` 建立设备到主机转发。
- 所有 API 使用 JSON。
- 所有请求必须携带 `X-DSH-Token: <shared-secret>`。
- 不允许把服务绑定到公网/局域网接口。

## 端点

### GET /v1/health

返回：

```json
{"status":"ok","protocol":"v1","server_time":"2026-11-17T12:00:00Z"}
```

### GET /v1/tasks/next?client_id=<id>

由 Via 用户脚本轮询。若无任务：

```json
{"task":null}
```

若有任务，Bridge 应原子性地把任务标记为 leased/claimed，避免重复下发：

```json
{
  "task": {
    "id": "req-000001",
    "text": "请解释一下什么是人工智能。",
    "session_id": "chatgpt-main",
    "created_at": "2026-11-17T12:00:00Z",
    "timeout_seconds": 180
  }
}
```

### POST /v1/tasks/{task_id}/result

成功：

```json
{
  "client_id": "ldplayer-via-main",
  "status": "success",
  "reply": "人工智能是指……",
  "completed": true
}
```

失败：

```json
{
  "client_id": "ldplayer-via-main",
  "status": "error",
  "error": "找不到 ChatGPT 输入框",
  "completed": true
}
```

Bridge 应校验任务归属、状态和 client_id，并把结果关联回原始 DSH 请求。

## 任务状态建议

`queued → leased → running → succeeded | failed | timed_out | cancelled`

要求：
- `task_id` 全局唯一；
- 同一任务不能被两个 Via 客户端同时执行；
- 对重复 result 请求应幂等；
- Bridge 保存任务创建、领取、完成时间；
- 超时任务返回明确错误；
- 断线重连后，未完成任务应按策略重新入队或标记失败，不能静默丢失。

## 安全要求

- Token 至少 32 字节随机熵；不要使用示例字符串。
- 比较 token 时使用常量时间比较。
- 日志不得记录 token、Cookie、Authorization 值或完整敏感对话内容。
- 建议提供任务文本日志开关，默认关闭。
- 只允许本机回环监听。
- 对请求体大小、任务长度和轮询频率设置上限。
- 不提供读取浏览器 Cookie/本地存储/密码的 API。

## Via 客户端当前实现

`via/DSH-GPT-Bridge.user.js` 使用：
- `GET /v1/health`
- `GET /v1/tasks/next?client_id=...`
- `POST /v1/tasks/{task_id}/result`

脚本通过 Via 的 `GM_xmlhttpRequest` 发请求；需要在 Via 脚本元数据中声明 `@grant GM_xmlhttpRequest`。
