# Codex × Grok Bot：协议烟测案例

这是一份最小可复现的协议验证记录，用来确认 Codex、任务桥和 Grok Bot Connector 在重启客户端后仍能完成异步交接。它不是一项真实的网页研究，也没有访问登录页面、发送消息或修改外部系统。

## 交接过程

```text
Codex create_task
  → queued
  → Grok Bot claim_next_task
  → Grok Bot append_progress
  → Grok Bot complete_task
  → Codex get_task
  → succeeded
```

Codex 创建了一个无敏感信息的 `codex_research` 测试任务，并设置了明确的验收标准。Grok Bot 通过已连接的 Custom MCP Connector 完成以下动作：

1. 原子领取任务并取得租约；
2. 读取任务说明和验收标准；
3. 写入一条进度事件；
4. 提交包含 `summary`、`evidence`、`artifacts` 和 `limitations` 的结构化结果。

Codex 随后通过 `get_task` 读取到 `succeeded`，并确认只有一次尝试。事件链包含 `created`、`claimed`、`progress` 和 `completed`。

## 结果与边界

- 任务桥的队列、租约、进度事件和结果回传均可用。
- 重启 Codex 客户端后，已注册的远程 MCP 会自动恢复，无需重新执行 `codex mcp add`。
- 本案例使用合成证据，仅用于校验结果结构；不应作为事实研究结论引用。
- Grok Bot 未调用其他连接器，也未执行登录、发布、付款、删除或生产变更。
- 真实网页调查应另行创建任务，并要求返回可核验的来源、观察时间、限制说明和产物地址。

## Hermes 后续接入

未来的 Hermes 适配器可以复用同一任务桥，但仍应遵循“先审核、后沉淀”的链路：

```text
Grok Bot 证据包
  → Hermes 待审核
  → 来源核验、去重、事实/观点分类
  → 知识笔记或飞书 Wiki
```

Hermes 不是当前 v0.1 的运行依赖，Grok Bot 也不会直接获得 Hermes Memory、飞书、知识库或 VPS 的写权限。
