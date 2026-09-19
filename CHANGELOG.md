# Changelog

## v0.3.0 — 2026-09-19

- Added the optional `grok-task-continuation` Codex Skill for per-task continuation after a Grok bridge task reaches a terminal state.
- Documented the scoped heartbeat pattern: poll only known task IDs, treat `get_task` as authoritative, preserve evidence and limitations, and continue the original Codex request rather than stop at a status notification.
- Clarified the platform boundary: this client-side continuation does not make the Worker or Grok Bot capable of waking arbitrary Codex conversations.

## v0.2.0 — 2026-09-19

- Added fenced lease tokens and monotonically increasing lease generations, preventing stale executors from reporting progress or submitting results after a task is reclaimed.
- Added execution-attempt history, delayed retry backoff, cooperative cancellation, request-content idempotency checks, and replay-safe completion responses.
- Restricted the public protocol to registered read-only task types; write-capable action records are schema-only groundwork for a future, explicitly approved release.
- Documented global Codex MCP setup so one local registration is available in new Codex desktop, CLI, and IDE conversations on the same host.

## v0.1.0 — 2026-09-12

- Initial Codex × Grok Bot MCP task bridge release.
