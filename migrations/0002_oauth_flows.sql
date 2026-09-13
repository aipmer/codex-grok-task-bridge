CREATE TABLE IF NOT EXISTS oauth_flows (
  flow_id TEXT PRIMARY KEY,
  request_json TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_oauth_flows_expiry ON oauth_flows(expires_at);
