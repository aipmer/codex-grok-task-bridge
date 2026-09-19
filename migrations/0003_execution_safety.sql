-- v0.2 execution-safety protocol.  Lease credentials are intentionally stored
-- only as digests; the raw token is returned once to the active executor.
ALTER TABLE tasks ADD COLUMN effect_class TEXT NOT NULL DEFAULT 'read_only';
ALTER TABLE tasks ADD COLUMN lease_generation INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tasks ADD COLUMN lease_token_hash TEXT;
ALTER TABLE tasks ADD COLUMN lease_claim_key TEXT;
ALTER TABLE tasks ADD COLUMN lease_attempt_id TEXT;
ALTER TABLE tasks ADD COLUMN execution_deadline_at TEXT;
ALTER TABLE tasks ADD COLUMN next_attempt_at TEXT;
ALTER TABLE tasks ADD COLUMN cancel_requested_at TEXT;
ALTER TABLE tasks ADD COLUMN cancel_requested_by TEXT;
ALTER TABLE tasks ADD COLUMN create_request_hash TEXT NOT NULL DEFAULT '';
ALTER TABLE tasks ADD COLUMN completed_operation_key TEXT;
ALTER TABLE tasks ADD COLUMN completed_request_hash TEXT;
ALTER TABLE tasks ADD COLUMN completed_response_json TEXT;

ALTER TABLE operation_idempotency ADD COLUMN request_hash TEXT NOT NULL DEFAULT '';

CREATE TABLE IF NOT EXISTS execution_attempts (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  lease_generation INTEGER NOT NULL,
  executor TEXT NOT NULL,
  claim_idempotency_key TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  end_reason TEXT,
  summary_json TEXT NOT NULL DEFAULT '{}',
  UNIQUE(task_id, lease_generation),
  UNIQUE(executor, claim_idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_tasks_ready_queue ON tasks(status, next_attempt_at, priority DESC, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_execution_attempts_task ON execution_attempts(task_id, lease_generation DESC);

-- Reserved for a future, explicitly approved write-capable protocol. v0.2
-- creates no MCP tool that can insert executable external actions.
CREATE TABLE IF NOT EXISTS execution_actions (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  attempt_id TEXT NOT NULL REFERENCES execution_attempts(id) ON DELETE CASCADE,
  action_key TEXT NOT NULL,
  external_idempotency_key TEXT,
  state TEXT NOT NULL CHECK (state IN ('planned', 'in_progress', 'confirmed', 'reconciliation_required')),
  receipt_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(task_id, action_key)
);
