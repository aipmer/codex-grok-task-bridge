# Codex × Grok Bot MCP Task Bridge

[Chinese README](README.zh-CN.md)

Open-source MCP task bridge for trusted local Codex, Claude Code, and Cursor callers plus one Grok Bot executor, with asynchronous jobs, fenced leases, idempotency, scoped OAuth, and Cloudflare Workers/D1/R2.

This is not an official xAI SDK or Grok API integration. It does not use CC Switch Grok OAuth, private Grok APIs, or an unauthenticated fallback. Hermes integration is planned for a later release and is not a runtime dependency of v0.4.

## How it works

```text
Codex / Claude Code / Cursor ──> Cloudflare Task Bridge <── OAuth MCP ── Grok Bot
                              │
                         D1 + R2
```

The bridge handles queueing, leases, retries, idempotency, attachment limits, and permission checks. It does not make knowledge judgments or write to external knowledge bases.

The target unattended setup uses a Grok Bot Routine to call `claim_next_task` on a schedule, execute in its cloud computer, and report in the owning Bot conversation. This specific Grok Bot integration still needs an in-app connector and Routine test. Codex uses `get_task` as the authoritative status read. See [Automatic cloud execution](docs/automatic-cloud-execution.md).

## Current status

- v0.4 adds isolated named callers and per-client token digests. Callers can create and read only their own tasks; Grok remains the sole executor.
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

`wrangler.jsonc` declares two cron triggers: `*/5 * * * *` reconciles expired task leases against D1, and the daily `17 3 * * *` run purges stale OAuth state. The purge stays off the five-minute schedule because its KV `list` calls would otherwise exhaust the free-plan daily limit.

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

The [public X account research case](docs/case-study-public-x-research-2026-09-13.md) records a read-only task that asked Grok Bot to collect the day's public posts from an X account and return a concise evidence-backed summary. It verifies cloud-browser research through a manually triggered Bot conversation; Routine-based unattended triggering remains a separate capability to verify.

## Caller and Grok Bot setup

Codex uses the `/mcp` endpoint with a dedicated Bearer token. Grok Bot uses `/grok/mcp` through the OAuth discovery, authorization-code, and PKCE flow. The Grok scope set is limited to:

```text
task:read task:claim task:progress task:complete
```

After connecting the Custom MCP Connector, verify that Grok can see `claim_next_task` and `complete_task`, but cannot see `create_task` or `cancel_task`. Any login, MFA, payment, publishing, deletion, production change, or external message action must stop for human approval.

The connector is invoked by a conversation or a scheduled Routine. A Custom MCP server cannot currently push a message into an arbitrary Grok conversation or wake a Bot through a public webhook, so the Routine is the supported automatic polling mechanism.

### Use the bridge from any Codex conversation

Register the remote MCP server once at the Codex user level, then restart the Codex desktop app. New Codex desktop, CLI, and IDE conversations on the same host can use the bridge tools without per-project setup.

```bash
codex mcp add grok-bridge \
  --url https://<bridge-domain>/mcp \
  --bearer-token-env-var GROK_BRIDGE_TOKEN
```

Keep `GROK_BRIDGE_TOKEN` in the local environment or a secret manager; never place its value in repository configuration. Confirm the registration with `codex mcp list`. To remove only this registration, run `codex mcp remove grok-bridge` and restart the client.

### Multi-agent callers

v0.4 supports trusted local Codex, Claude Code, and Cursor callers with independent identities and least-privilege scopes. [Multi-agent callers](docs/multi-agent-callers.md) documents the managed Worker Secret, setup backups, rollback commands, and the credential-free stdio proxy used by clients without a native bearer-token environment setting. Callers cannot read, cancel, or list another caller's tasks.

## Security boundary

- Do not upload credentials, cookies, `.env` files, browser profiles, or complete workspaces.
- Input and result attachments are limited to small files and use short-lived signed URLs.
- Keep Codex, Grok, and future Hermes credentials separate.
- Do not expose a shared public Worker without adding rate limits, abuse controls, tenant isolation, and cost controls.
- Report suspected vulnerabilities privately using `SECURITY.md`; do not publish credentials in Issues.

## Continue the originating Codex task

The optional [Grok Task Continuation skill](skills/grok-task-continuation/SKILL.md) makes the Codex side of an asynchronous hand-off explicit. After creating bridge tasks, it creates a heartbeat scoped to the current Codex task. When a known task reaches a terminal state, Codex reviews the authoritative `get_task` result, including evidence and limitations, then continues the original request using the authority already granted.

Install it globally for future Codex tasks:

```bash
mkdir -p ~/.codex/skills
cp -R skills/grok-task-continuation ~/.codex/skills/
```

This is a per-task continuation consumer, not a Worker callback. Neither the Worker nor Grok Bot can push a message into an arbitrary Codex conversation. The heartbeat remains silent while tasks are non-terminal and asks for new authority before any external write, deployment, publication, payment, or destructive action.

## Roadmap

### v0.1 — Codex × Grok Bot

- Codex creates research and browser tasks.
- Grok Bot claims, renews, progresses, and completes tasks.
- Results include structured evidence, limitations, and artifacts.
- Cloudflare Worker, D1, R2, and OAuth provide the transport and state layer.

### v0.2 — Execution safety

- Each claim receives an opaque lease token and generation; stale executors cannot renew, report progress, upload result attachments, fail, or complete a reclaimed task.
- Read-only task types only. Browser writes, sending messages, publishing, payments, deletion, and production changes are rejected.
- Retry uses delayed backoff and attempt records; cancellation of a running task is cooperative and visible to the executor.
- Completion responses are replay-safe when the response is lost after the state transition.

### v0.3 — Codex continuation

- Optional `grok-task-continuation` Skill keeps the originating Codex task responsible for evaluating a terminal bridge result and completing the requested follow-up.
- A per-task heartbeat polls only the task IDs created in that Codex task; it is silent while work is pending and does not scan unrelated conversations.
- The documented flow preserves evidence and limitations, and requires fresh authority for any newly proposed external side effect.

### v0.4 — Multi-agent callers

- Codex, Claude Code, and Cursor authenticate as separate trusted local caller identities.
- Caller credentials are SHA-256 digests in a Worker Secret; each caller can be independently disabled or rotated.
- Tasks are private to their `owner_client_id`; Grok remains the only executor.

### Later — Hermes × Grok Bot

- Hermes keeps `hermes kanban` as its task source of truth.
- A separate adapter will submit only `research_evidence` and `browser_collection` tasks.
- Returned evidence will enter Hermes pending review.
- Hermes will perform source verification, deduplication, and fact/opinion classification.
- Only approved content may enter Hermes knowledge notes or Feishu Wiki.
- Grok Bot will not receive Hermes Memory, knowledge-base, Feishu, or VPS write access.

## Maintainer

Maintained by [@aipmer](https://github.com/aipmer), focusing on AI agents, MCP, automation workflows, and knowledge systems.

- X: [@ai_pmer](https://x.com/ai_pmer)
- Website: [pmer.cn](https://pmer.cn/)
- GitHub: [@aipmer](https://github.com/aipmer)

## Related project

- [plugins-codex-feishu](https://github.com/aipmer/plugins-codex-feishu) — Codex and Feishu workflows for on-call operations, approvals, documents, and collaboration.

## License

Apache-2.0. See [LICENSE](LICENSE).
