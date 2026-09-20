-- v0.4: source remains a legacy compatibility field. owner_client_id is the
-- authoritative caller identity for authorization and idempotency isolation.
ALTER TABLE tasks ADD COLUMN owner_client_id TEXT NOT NULL DEFAULT 'codex';
CREATE INDEX IF NOT EXISTS idx_tasks_owner_status ON tasks(owner_client_id, status, created_at DESC);
