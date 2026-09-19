# Changelog

## v0.2.0 — 2026-09-19

- Added fenced lease tokens and monotonically increasing lease generations, preventing stale executors from reporting progress or submitting results after a task is reclaimed.
- Added execution-attempt history, delayed retry backoff, cooperative cancellation, request-content idempotency checks, and replay-safe completion responses.
- Restricted the public protocol to registered read-only task types; write-capable action records are schema-only groundwork for a future, explicitly approved release.
- Documented global Codex MCP setup so one local registration is available in new Codex desktop, CLI, and IDE conversations on the same host.

## v0.1.0 — 2026-09-12

- Initial Codex × Grok Bot MCP task bridge release.
