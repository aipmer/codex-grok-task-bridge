# Codex × Grok Bot MCP 任务桥

[English README](README.md)

面向 Codex 和 Grok Bot 的开源 MCP 任务桥，提供异步任务、租约 fencing、幂等、范围化 OAuth，以及 Cloudflare Workers/D1/R2 支持。Codex 创建任务，已连接的执行端领取任务并返回结构化结果与证据。

本项目不是官方 xAI SDK，也不是 Grok API 集成；不使用 CC Switch Grok OAuth、Grok 私有 API 或无鉴权回退。Hermes 集成属于后续路线，不是 v0.2 的运行依赖。

## 工作方式

```text
Codex ── Bearer MCP ──> Cloudflare Task Bridge <── OAuth MCP ── Grok Bot
                              │
                         D1 + R2
```

任务桥负责队列、租约、重试、幂等、附件限制和权限检查，不负责知识判断，也不写入外部知识库。

目标中的无人值守模式是：Grok Bot Routine 按计划调用 `claim_next_task`，在自己的云电脑中执行任务，并在所属 Bot 对话中报告结果。Codex 以 `get_task` 返回的状态为权威结果。详见[自动云端执行模式](docs/automatic-cloud-execution.md)。

## 当前状态

- v0.2 增加租约令牌与代次 fencing、执行尝试记录、受控延迟重试、取消请求和可重放的完成响应。
- 已完成一次公开 X 账号只读调研案例；该案例通过手动触发的 Grok Bot 对话验证，不代表 Routine 无人值守触发能力已完成验收。
- Grok 仅拥有读取、领取、更新进度、续租和提交结果的权限。
- 不提供公共共享 Worker 实例；请部署自己的 Cloudflare 资源。
- Worker、D1、R2 和 OAuth 2.1 + PKCE 已完成代码级验证。

## 快速开始

依赖：Node.js LTS、Cloudflare 账号、Wrangler、D1、R2 和 KV。

```bash
npm ci
cp .dev.vars.example .dev.vars
npm run check
npm test
npx wrangler kv namespace create codex-grok-task-bridge-oauth
npx wrangler d1 create codex-grok-task-bridge
npx wrangler r2 bucket create codex-grok-task-bridge-attachments
```

替换 `wrangler.jsonc` 中的资源占位符，再使用 Wrangler 设置密钥。不要提交 `.dev.vars`、访问令牌、OAuth 登录码、Cookie 或生产数据。

`wrangler.jsonc` 声明了两个定时触发：`*/5 * * * *` 通过 D1 回收过期的任务租约，每天一次的 `17 3 * * *` 清理过期 OAuth 状态。清理任务没有放在五分钟周期里，因为它的 KV `list` 调用会很快耗尽免费版每日额度。

```bash
npx wrangler d1 migrations apply codex-grok-task-bridge --local
npm run dev
```

认证端到端烟测时，仅通过 Shell 环境变量提供 `BRIDGE_URL`、`CODEX_TOKEN` 和 `GROK_TOKEN`，然后运行：

```bash
npm run smoke
```

## 验证案例

[Codex ↔ Grok 连接器协议烟测](docs/case-study-codex-grok-smoke-test.md)记录了重启 Codex 客户端后仍能完成的异步交接。Grok 在 grok.com 普通对话中被手动提示，完成任务创建、领取、进度回报、完成和结果查询；该案例不验证无人值守 Routine 或云电脑浏览器执行。

[公开 X 账号调研案例](docs/case-study-public-x-research-2026-09-13.md)记录了一次只读任务：让 Grok Bot 抓取某个 X 账号当天的公开发文，并返回带证据的精简摘要。案例验证了云端浏览器调研和结果回传；Routine 的无人值守触发仍需单独验证。

## Codex 和 Grok Bot 配置

Codex 使用专用 Bearer Token 访问 `/mcp`。Grok Bot 通过 OAuth 发现、授权码和 PKCE 流程，经 `/grok/mcp` 访问。Grok 的权限范围限制为：

```text
task:read task:claim task:progress task:complete
```

连接 Custom MCP Connector 后，应确认 Grok 能看到 `claim_next_task` 和 `complete_task`，但看不到 `create_task` 或 `cancel_task`。遇到登录、MFA、付款、发布、删除、生产变更或对外发送时，必须暂停并请求人工批准。

连接器可以由普通对话或定时 Routine 调用。当前 Custom MCP 服务不能把消息主动推送到任意 Grok 对话，也不能通过公开 Webhook 唤醒 Bot，因此 Routine 是受支持的自动轮询入口。

## 安全边界

- 不上传凭据、Cookie、`.env` 文件、浏览器配置或完整工作区。
- 输入和结果附件仅支持小文件，并使用短期签名地址。
- Codex、Grok 和未来的 Hermes 使用相互独立的凭据。
- 未加入限流、防滥用、租户隔离和成本控制前，不要暴露共享公共 Worker。
- 漏洞请按照 `SECURITY.md` 私下报告，不要在 Issue 中公开凭据。

## 路线图

### v0.1 — Codex × Grok Bot

- Codex 创建研究和浏览器任务；
- Grok Bot 领取、续租、更新进度并完成任务；
- 结果包含结构化证据、限制说明和产物；
- Cloudflare Worker、D1、R2 和 OAuth 提供传输与状态层。

### v0.2 — 执行安全

- 每次领取都会获得一次性租约令牌和递增代次。过期或已被接管的执行者不能续租、更新进度、上传结果附件、失败或完成任务。
- 当前只允许只读任务。浏览器写入、发送消息、发布、付款、删除和生产修改一律拒绝。
- 重试使用延迟退避并保留执行尝试记录；运行中任务采用协作式取消。
- 完成状态已写入但响应丢失时，使用同一幂等键可安全取得原结果。

### 后续 — Hermes × Grok Bot

- Hermes 继续使用 `hermes kanban` 作为任务真源；
- 适配器只投递 `research_evidence` 和 `browser_collection` 任务；
- 返回的证据包先进入 Hermes 待审核状态；
- Hermes 完成来源核验、去重及事实/观点分类；
- 只有审核通过的内容才能进入 Hermes 知识笔记或飞书 Wiki；
- Grok Bot 不获得 Hermes Memory、知识库、飞书或 VPS 写权限。

## Maintainer

由 [@aipmer](https://github.com/aipmer) 维护，关注 AI Agent、MCP、自动化工作流与知识体系。

- X：[@ai_pmer](https://x.com/ai_pmer)
- Website：[pmer.cn](https://pmer.cn/)
- GitHub：[@aipmer](https://github.com/aipmer)

## 关联项目

- [plugins-codex-feishu](https://github.com/aipmer/plugins-codex-feishu) — Codex 与飞书之间的值班、审批、文档和协作能力。

## 许可证

Apache-2.0，详见 [LICENSE](LICENSE)。
