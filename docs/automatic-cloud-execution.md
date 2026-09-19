# 自动云端执行模式

这是目标运行方式，尚未在 Grok Bot 客户端完成端到端验收。Codex 负责投递和查询；Grok Bot 通过后台 Routine 自动领取任务，并在自己的持久云电脑中执行浏览器操作。先确认 Grok Bot 能安装并调用该 MCP 插件，再启用 Routine。

```text
Codex create_task
  → Cloudflare Worker / D1（queued）
  → Grok Bot Routine 调用 claim_next_task
  → Grok Bot 云电脑与浏览器执行
  → progress / renew / complete_task
  → Routine 所属 Bot 对话回报
  → Codex get_task 查询最终结果
```

## Grok Bot 端配置

1. 在 Grok Bot 中安装并认证本项目的 Custom MCP Connector。
2. 创建一个专用 Bot，例如 `Codex Task Worker`，先在它的对话中验证 `claim_next_task`、`append_progress` 和 `complete_task` 可用，并在云电脑界面观察一次只读浏览器操作。
3. 为这个 Bot 创建 Routine。Routine 的执行频率以 Grok Bot 界面实际提供的选项为准；建议从 10 分钟开始观察，再根据延迟和用量调整。
4. 将下面的说明作为 Routine 指令，并使用安全的只读测试任务执行 Test run：

```text
每次运行只通过 Codex Hermes Grok Bridge 处理任务：

1. 调用 claim_next_task，每次最多领取一个任务。
2. 没有任务时直接结束，不在对话中反复发送空队列消息。
3. 领取后调用 get_task，阅读 instructions、acceptance_criteria、权限边界和附件说明。
4. 只在 Grok Bot 云电脑中执行任务；不要使用或修改我当前的本地电脑。
5. 领取响应中的 lease_token 是本次执行的临时凭据。后续 renew_task_lease、append_progress、prepare_result_attachment、complete_task 和 fail_task 都必须携带它，不能在不同任务或不同领取周期复用。
6. 执行期间定期调用 renew_task_lease，并用 append_progress 回报阶段性进度。遇到 cancel_requested、lease_expired 或 execution_deadline_exceeded 时立即停止，不要继续浏览器操作。
7. 完成后调用 complete_task，返回 summary、evidence、artifacts、limitations 和 recommended_next_action；网络结果不确定时使用同一个 idempotency_key 重试提交，不要重新执行网页任务。
8. 失败时调用 fail_task，说明失败原因和是否可以安全重试。
9. 在本对话中报告 task_id、关键进度、最终状态、摘要和下一步。不要调用其他连接器。
10. 遇到登录、MFA、付款、发布、删除、生产修改或对外发送时暂停并请求人工批准。
```

Routine 可以在电脑关闭时继续运行。若完全不需要本机执行，可把“Execution on Local Computer”设为 `Never allowed`；这只会禁止 Bot 使用你面前的本机，不会影响 Grok Bot 自己的云电脑。

## 对话中的可见性

Routine 的运行记录和它发布到所属 Bot 对话的回报，是 Grok 端预期的可见记录，仍需在客户端用真实任务验收。任务桥的完整状态、事件时间线和结构化结果以 Worker/D1 为准，Codex 可以用 `get_task` 查询。

任务桥不会把任务主动推送成任意 Grok 会话中的新消息；如果没有 Routine 运行，或者你在另一个普通会话里查看，就不会看到这条任务。需要人工临时触发时，可以在专用 Bot 对话中发送同样的“领取并处理一个任务”指令。

## 为什么不依赖本地电脑

Codex 到任务桥是 HTTPS MCP 调用，只负责创建和读取任务。浏览器登录态、网页操作、文件处理和执行过程都发生在 Grok Bot 的云电脑上。`ego-browser` 或本地 Grok 网页窗口只适合人工配置、查看对话和处理审批，不应成为生产任务的执行环节。

## 当前边界

公开的 Grok Bot 接口目前没有为任意 Custom MCP 服务提供通用 webhook 或即时唤醒能力。因此“Codex 投递后零等待、立即唤醒 Bot”不能由 Worker 单方面保证。Routine 是官方支持的自动化入口，实际延迟取决于 Routine 周期、Bot 用量和 Grok 的运行状态。

如果未来 Grok 为 Custom MCP 开放事件触发器，可以把 `queued` 事件接到该触发器；在此之前不应通过私有 API、浏览器逆向或无鉴权回退来模拟推送。
