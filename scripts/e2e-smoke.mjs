import { randomUUID } from 'node:crypto';

const baseUrl = process.env.BRIDGE_URL;
const codexToken = process.env.CODEX_TOKEN;
const grokToken = process.env.GROK_TOKEN;

if (!baseUrl || !codexToken || !grokToken) {
  throw new Error('BRIDGE_URL, CODEX_TOKEN, and GROK_TOKEN are required');
}

async function rpc(token, id, method, params) {
  const response = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
  if (!response.ok) throw new Error(`${method} returned HTTP ${response.status}`);
  const payload = await response.json();
  if (payload.error) throw new Error(`${method}: ${payload.error.message}`);
  return payload.result;
}

async function tool(token, id, name, args) {
  const result = await rpc(token, id, 'tools/call', { name, arguments: args });
  if (result.isError) throw new Error(`${name}: ${result.content?.[0]?.text ?? 'unknown MCP tool error'}`);
  return JSON.parse(result.content[0].text);
}

async function expectRejected(label, operation) {
  try {
    await operation();
  } catch {
    return;
  }
  throw new Error(`${label} was unexpectedly accepted`);
}

const health = await fetch(`${baseUrl}/health`);
if (!health.ok) throw new Error(`/health returned HTTP ${health.status}`);

await rpc(codexToken, 1, 'initialize', {
  protocolVersion: '2025-03-26', clientInfo: { name: 'staging-smoke', version: '1' }, capabilities: {},
});
const tools = await rpc(codexToken, 2, 'tools/list', {});
if (!tools.tools?.some((item) => item.name === 'create_task')) throw new Error('create_task was not discovered');

const createKey = `staging-e2e-create-${randomUUID()}`;
const created = await tool(codexToken, 3, 'create_task', {
  source: 'codex', task_type: 'codex_research', title: 'Staging bridge end-to-end smoke test',
  instructions: 'Validate queue, lease, progress, result, and attachment handling. Do not perform external actions.',
  acceptance_criteria: 'Return a structured test result.', priority: 100,
  idempotency_key: createKey,
  attachments: [{ name: 'smoke.txt', mime_type: 'text/plain', size_bytes: 11 }],
});

const taskId = created.task_id;
await expectRejected('conflicting create idempotency key', () => tool(codexToken, 31, 'create_task', {
  source: 'codex', task_type: 'codex_research', title: 'Different content must not reuse the same key',
  instructions: 'This must be rejected as an idempotency conflict.', idempotency_key: createKey,
}));
const upload = await fetch(created.attachments[0].upload_url, {
  method: 'PUT', headers: { 'content-type': 'text/plain', 'content-length': '11' }, body: 'smoke-test!',
});
if (!upload.ok) throw new Error(`attachment upload returned HTTP ${upload.status}`);

const claimed = await tool(grokToken, 4, 'claim_next_task', { idempotency_key: `staging-e2e-claim-${randomUUID()}` });
if (claimed.task?.task_id !== taskId) throw new Error('Grok lease did not claim the created task');
if (!claimed.lease_token) throw new Error('claim did not return a lease token');

await expectRejected('stale or invalid lease token', () => tool(grokToken, 41, 'append_progress', {
  task_id: taskId, lease_token: 'v1.0.this-is-not-a-valid-lease-token', message: 'This must be rejected.',
}));

await tool(grokToken, 5, 'append_progress', { task_id: taskId, lease_token: claimed.lease_token, message: 'Staging smoke test in progress' });
const completionKey = `staging-e2e-complete-${randomUUID()}`;
const completed = await tool(grokToken, 6, 'complete_task', {
  task_id: taskId, lease_token: claimed.lease_token, idempotency_key: completionKey,
  result: {
    summary: 'Staging end-to-end smoke test completed.',
    evidence: [{ url: 'https://example.com', title: 'Example Domain', observed_at: new Date().toISOString(), claim: 'Synthetic evidence used only to validate result schema.', excerpt: 'Synthetic staging test.' }],
    artifacts: [], limitations: ['Synthetic smoke test; no external research was performed.'],
    recommended_next_action: 'Configure the Grok Bot connector after its authentication preflight.',
  },
});
if (completed.status !== 'succeeded') throw new Error(`completion status was ${completed.status}`);

const replayed = await tool(grokToken, 7, 'complete_task', {
  task_id: taskId, lease_token: claimed.lease_token, idempotency_key: completionKey,
  result: completed.result,
});
if (replayed.status !== 'succeeded') throw new Error('completion idempotency replay did not return success');

const fetched = await tool(codexToken, 8, 'get_task', { task_id: taskId });
if (fetched.status !== 'succeeded' || fetched.attachments[0]?.upload_status !== 'uploaded') {
  throw new Error('final task state or attachment state did not match expected values');
}

console.log(`staging smoke passed: task=${taskId}, status=${fetched.status}, attachment=${fetched.attachments[0].upload_status}`);
