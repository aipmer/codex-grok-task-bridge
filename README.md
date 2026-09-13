# Codex × Grok Bot MCP Task Bridge

Open-source MCP task bridge for Codex and Grok Bot, with asynchronous jobs, leases, idempotency, scoped OAuth, and Cloudflare Workers/D1/R2. Codex creates a task; a connected executor claims it and returns structured results and evidence.

This is not an official xAI SDK or Grok API integration. It does not use CC Switch Grok OAuth, private Grok APIs, or an unauthenticated fallback. Hermes integration is planned for a later release and is not a runtime dependency of v0.1.

## How it works

```text
Codex ── Bearer MCP ──> Cloudflare Task Bridge <── OAuth MCP ── Grok Bot
                              │
                         D1 + R2
```

The bridge handles queueing, leases, retries, idempotency, attachment limits, and permission checks. It does not make knowledge judgments or write to external knowledge bases.

The target unattended setup uses a Grok Bot Routine to call `claim_next_task` on a schedule, execute in its cloud computer, and report in the owning Bot conversation. This specific Grok Bot integration still needs an in-app connector and Routine test. Codex uses `get_task` as the authoritative status read. See [Automatic cloud execution](docs/automatic-cloud-execution.md).

## Current status

- v0.1 implements Codex task creation and the Grok-facing claim/progress/result protocol. The live smoke test so far used a manually prompted grok.com conversation; unattended Grok Bot execution has not yet been verified.
- Grok is limited to read, claim, progress, lease renewal, and result submission.
- No public shared Worker instance is provided. Deploy your own Cloudflare resources.
- The code has been validated with Cloudflare Worker, D1, R2, and OAuth 2.1 + PKCE.

## Quick start

Requirements: Node.js LTS, a Cloudflare account, Wrangler, D1, R2, and KV.

```bash
npm ci
cp .dev.vars.example .dev.vars
npm run check
npm test
npx wrangler kv namespace create codex-grok-task-bridge-oauth
npx wrangler d1 create codex-grok-task-bridge
npx wrangler r2 bucket create codex-grok-task-bridge-attachments
```

Replace the resource placeholders in `wrangler.jsonc`, then set secrets with Wrangler. Never commit `.dev.vars`, access tokens, OAuth login codes, cookies, or production data.

```bash
npx wrangler d1 migrations apply codex-grok-task-bridge --local
npm run dev
```

For an authenticated end-to-end smoke test, provide `BRIDGE_URL`, `CODEX_TOKEN`, and `GROK_TOKEN` only in the shell environment and run:

```bash
npm run smoke
```

## Validation case

The [Codex ↔ Grok connector protocol smoke test](docs/case-study-codex-grok-smoke-test.md) records a verified handoff after restarting the Codex client. Grok was manually prompted in a grok.com conversation. It covers task creation, claim, progress reporting, completion, and result retrieval; it does not verify an unattended Grok Bot Routine or cloud-computer browser work.

## Codex and Grok Bot setup

Codex uses the `/mcp` endpoint with a dedicated Bearer token. Grok Bot uses `/grok/mcp` through the OAuth discovery, authorization-code, and PKCE flow. The Grok scope set is limited to:

```text
task:read task:claim task:progress task:complete
```

After connecting the Custom MCP Connector, verify that Grok can see `claim_next_task` and `complete_task`, but cannot see `create_task` or `cancel_task`. Any login, MFA, payment, publishing, deletion, production change, or external message action must stop for human approval.

The connector is invoked by a conversation or a scheduled Routine. A Custom MCP server cannot currently push a message into an arbitrary Grok conversation or wake a Bot through a public webhook, so the Routine is the supported automatic polling mechanism.

## Security boundary

- Do not upload credentials, cookies, `.env` files, browser profiles, or complete workspaces.
- Input and result attachments are limited to small files and use short-lived signed URLs.
- Keep Codex, Grok, and future Hermes credentials separate.
- Do not expose a shared public Worker without adding rate limits, abuse controls, tenant isolation, and cost controls.
- Report suspected vulnerabilities privately using `SECURITY.md`; do not publish credentials in Issues.

## Roadmap

### v0.1 — Codex × Grok Bot

- Codex creates research and browser tasks.
- Grok Bot claims, renews, progresses, and completes tasks.
- Results include structured evidence, limitations, and artifacts.
- Cloudflare Worker, D1, R2, and OAuth provide the transport and state layer.

### v0.2 — Hermes × Grok Bot

- Hermes keeps `hermes kanban` as its task source of truth.
- A separate adapter will submit only `research_evidence` and `browser_collection` tasks.
- Returned evidence will enter Hermes pending review.
- Hermes will perform source verification, deduplication, and fact/opinion classification.
- Only approved content may enter Hermes knowledge notes or Feishu Wiki.
- Grok Bot will not receive Hermes Memory, knowledge-base, Feishu, or VPS write access.

## Maintainer

由吴煜维护，关注 AI Agent、MCP、自动化工作流与知识沉淀。

- X：[@ai_pmer](https://x.com/ai_pmer)
- Website：[pmer.cn](https://pmer.cn/)
- GitHub：[@aipmer](https://github.com/aipmer)

## Related project

- [plugins-codex-feishu](https://github.com/aipmer/plugins-codex-feishu) — Codex 与飞书之间的值班、审批、文档和协作能力。

## License

Apache-2.0. See [LICENSE](LICENSE).
