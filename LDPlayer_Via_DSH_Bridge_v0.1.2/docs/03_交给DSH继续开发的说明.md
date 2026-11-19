# 交给 DeepSeekHarness / Windows 端继续开发的说明

## 本包已经提供

- Via 端用户脚本；
- Via 脚本到 Windows Bridge 的 HTTP 协议；
- ADB reverse 网络拓扑；
- 任务/结果 JSON 样例；
- 安装、测试、安全与故障排查文档。

## Windows 端需要实现

1. `Bridge HTTP Server`：绑定 `127.0.0.1:18765`。
2. Token 鉴权：校验 `X-DSH-Token`。
3. 任务队列：支持 DSH 创建任务、Via 领取任务、Via 提交结果。
4. 请求关联：使用 task_id/request_id 将 GPT 回复返回给发起工具调用的 DSH 会话。
5. 超时与取消：超时后给 DSH 明确错误；不要无限等待。
6. ADB 管理：发现雷电实例、识别 serial，并执行 `adb -s <serial> reverse tcp:18765 tcp:18765`。
7. DSH 工具：建议提供 `gpt_bridge_status`、`gpt_send_message`、`gpt_wait_reply`。
8. 健康诊断：分别显示 Bridge HTTP、ADB reverse、Via 脚本心跳、ChatGPT 页面状态。

## 建议 DSH 工具语义

### gpt_bridge_status()
返回 Bridge 是否运行、客户端最近心跳、ADB serial、脚本版本、页面域名/状态。不要返回 Cookie 或令牌。

### gpt_send_message(text, session_id="chatgpt-main", timeout=180)
创建任务并等待完成，或返回 request_id 供后续查询。第一版建议同步等待，内部仍用异步队列。

### gpt_get_reply(request_id)
查询任务状态和结果。

## 重要的分层原则

DSH 不应直接拼接网页 DOM 操作，也不应把 ADB 命令散落在每个工具实现里。推荐：

DSH Plugin → MCP Server/Tool Adapter → Bridge Service → ADB reverse → Via Userscript → ChatGPT Web UI

这样 Windows 端可以独立优化，不需要改动 Via 脚本内部实现；只要遵守 `protocol/Bridge_API_v1.md` 即可。

## 不要做的事

- 不要把它改成 OpenAI API 直连：这会绕过本项目“通过模拟器中的 ChatGPT 网页”这一目标。
- 不要要求用户提供 ChatGPT Cookie 或账号密码。
- 不要把本地 Bridge 暴露到公网。
- 不要假设 Via 是 Chrome，也不要默认 Chrome DevTools Protocol 可用。
- 不要把脚本“已安装”当成“端到端已成功”；必须完成消息发送和回复回传验收。
