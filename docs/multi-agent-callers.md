# Multi-agent callers

v0.4 lets trusted local development agents submit independent, read-only jobs to one Grok Bot executor. It is not a public multi-tenant service and does not authorize any additional executor.

## Caller registry

Set the Worker secret `BRIDGE_CLIENTS` before adding a second caller. Its JSON value contains only SHA-256 token digests, never raw tokens:

```json
{
  "clients": [
    { "client_id": "codex", "token_sha256": "<64-lowercase-hex-digest>", "scopes": ["task:create", "task:read", "task:cancel"], "enabled": true },
    { "client_id": "claude-code", "token_sha256": "<64-lowercase-hex-digest>", "scopes": ["task:create", "task:read"], "enabled": true },
    { "client_id": "cursor", "token_sha256": "<64-lowercase-hex-digest>", "scopes": ["task:create", "task:read", "task:cancel"], "enabled": true }
  ]
}
```

Generate each raw token locally, retain it only in that client's secret environment, and calculate its digest locally:

```bash
printf %s "$GROK_BRIDGE_TOKEN" | shasum -a 256
```

Update the secret with Wrangler from a secure terminal, then deploy staging. To revoke a client, remove it or set `enabled` to `false`; to rotate it, replace only that client's digest and restart the corresponding local client. `CODEX_TOKEN` remains a single-caller compatibility fallback only while `BRIDGE_CLIENTS` is unset.

The authenticated `client_id` becomes the authoritative `owner_client_id`. Task IDs are not a sharing mechanism: callers may list, read, and cancel only their own tasks. Grok can read only tasks it has claimed.

## Client setup and rollback

Set these variables in the launch environment of the chosen client; do not put their values in repository files:

```text
GROK_BRIDGE_URL=https://<bridge-domain>/mcp
GROK_BRIDGE_TOKEN=<the raw token assigned to this client>
```

### Codex

Codex natively supports a bearer-token environment variable:

```bash
cp ~/.codex/config.toml ~/.codex/config.toml.grok-bridge-backup-$(date +%Y%m%d%H%M%S)
codex mcp add grok-bridge --url "$GROK_BRIDGE_URL" --bearer-token-env-var GROK_BRIDGE_TOKEN
codex mcp list
```

Rollback with `codex mcp remove grok-bridge`, then restore the timestamped backup only if other intended configuration changes were not made afterwards.

### Claude Code and Cursor

Use the included stdio-to-HTTP proxy so the MCP configuration contains no bearer token. It inherits only the two environment variables above and forwards JSON-RPC to the bridge; it neither stores nor logs task contents or credentials.

Claude Code user-scoped setup:

```bash
claude mcp add --scope user grok-bridge -- node /absolute/path/to/codex-grok-task-bridge/bin/bridge-mcp-stdio.mjs
claude mcp list
```

Rollback with `claude mcp remove grok-bridge`. Before manually editing Cursor's MCP configuration, create a timestamped copy of its existing configuration. Add a stdio server whose command is `node` and whose sole argument is the absolute path to `bin/bridge-mcp-stdio.mjs`; start Cursor with `GROK_BRIDGE_URL` and that Cursor client's `GROK_BRIDGE_TOKEN` in its environment. Remove that server entry to roll back.

## Caller workflow

1. Create only registered `read_only` task types and retain the returned `task_id`.
2. Poll `get_task`; do not infer completion from a Grok conversation transcript.
3. Evaluate evidence, limitations, and `recommended_next_action` before continuing the originating work.
4. Do not attempt to access another caller's task or let a caller become an executor.

Codex may additionally use the optional [continuation Skill](../skills/grok-task-continuation/SKILL.md). Other clients should implement their own task-local follow-up flow; the Worker cannot wake arbitrary conversations.
