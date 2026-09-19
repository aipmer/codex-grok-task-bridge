---
name: grok-task-continuation
description: Continue the originating Codex task after a Grok Task Bridge job reaches a terminal state. Use when creating or following up Codex-to-Grok bridge work.
---

# Grok Task Continuation

Use the bridge as an asynchronous delegation, not as a final hand-off. The original Codex task remains responsible for reviewing results and completing the requested work.

## When creating bridge work

1. Create only tasks that fit the bridge's read-only capability boundary, and retain every returned `task_id` in the current task context.
2. Before yielding the Codex task, create a **thread heartbeat** for the current task when the scheduler is available. Its prompt must:
   - poll only the known `task_id` values through `grok-bridge` read tools;
   - stay silent while a task is non-terminal and take no external action;
   - when a result becomes terminal, review its evidence, limitations, and recommended next action;
   - continue the original Codex request using the result and the authority already granted in that task, rather than merely reporting that the job finished;
   - ask the user only if the next action needs new authority, such as an external write, deployment, publication, payment, or destructive change;
   - delete the heartbeat only after every tracked task has been handled and no further Codex action remains.
3. Keep the original task's acceptance criteria in the heartbeat prompt. A generic “notify on completion” monitor is insufficient.

## When a result returns

- Treat `get_task` and its structured result as authoritative; a Grok Bot chat transcript is an execution record, not the source of truth.
- Separate verified facts from the executor's interpretation. Preserve limitations and do not promote an unsupported claim into project code, documentation, or a knowledge base.
- Continue the original work: for example, implement a validated code change, prepare the requested decision, update a draft, or report that no change is warranted. Do not stop at a task-status summary.
- If a task failed or exhausted retries, diagnose whether a safe Codex-side alternative is available; otherwise report the exact blocker and the smallest needed user decision.

## Platform boundary

The Worker and Grok Bot cannot push a new message into an arbitrary Codex conversation. The per-thread heartbeat is the supported continuation consumer. It is scoped to the originating Codex task; do not create a global monitor that scans unrelated tasks from other conversations.
