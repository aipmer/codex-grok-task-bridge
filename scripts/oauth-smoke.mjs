import { createHash, randomBytes, randomUUID } from 'node:crypto';

const baseUrl = (process.env.BRIDGE_BASE_URL ?? 'http://localhost:8791').replace(/\/$/, '');
const loginCode = process.env.GROK_OAUTH_TEST_LOGIN_CODE;
const codexToken = process.env.GROK_OAUTH_TEST_CODEX_TOKEN;
if (!loginCode || !codexToken) throw new Error('Set local-only OAuth and Codex test credentials in the environment.');

const resource = `${baseUrl}/grok/mcp`;
const callback = 'https://grok.com/oauth/callback';
const state = randomUUID();
const verifier = randomBytes(32).toString('base64url');
const challenge = createHash('sha256').update(verifier).digest('base64url');
const scopes = ['task:read', 'task:claim', 'task:progress', 'task:complete'].join(' ');

const challengeResponse = await fetch(resource, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize' }),
});
assertStatus(challengeResponse, 401, 'Unauthenticated MCP challenge');
const challengeHeader = challengeResponse.headers.get('www-authenticate') ?? '';
const metadataUrl = challengeHeader.match(/resource_metadata="([^"]+)"/)?.[1];
if (!metadataUrl) throw new Error('MCP challenge did not advertise protected-resource metadata.');
const resourceMetadata = await (await fetch(metadataUrl)).json();
if (resourceMetadata.resource !== resource || !resourceMetadata.authorization_servers?.length) throw new Error('Protected-resource metadata is incomplete.');
const authServerUrl = resourceMetadata.authorization_servers[0];
const authMetadata = await (await fetch(`${authServerUrl}/.well-known/oauth-authorization-server`)).json();
if (!authMetadata.authorization_endpoint || !authMetadata.token_endpoint || !authMetadata.registration_endpoint) throw new Error('OAuth authorization-server metadata is incomplete.');

const rejectedRegistration = await fetch(`${baseUrl}/oauth/register`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    client_name: 'Untrusted Client',
    redirect_uris: ['https://attacker.example/callback'],
    grant_types: ['authorization_code'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  }),
});
if (rejectedRegistration.ok) throw new Error('OAuth DCR accepted a non-Grok redirect host.');

const registration = await fetch(`${baseUrl}/oauth/register`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    client_name: 'Grok MCP Test',
    redirect_uris: [callback],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  }),
});
assertStatus(registration, 201, 'OAuth dynamic client registration');
const client = await registration.json();

const authorizationUrl = new URL(`${baseUrl}/oauth/authorize`);
for (const [key, value] of Object.entries({
  response_type: 'code', client_id: client.client_id, redirect_uri: callback,
  scope: scopes, state, code_challenge: challenge, code_challenge_method: 'S256', resource,
})) authorizationUrl.searchParams.set(key, value);

const consent = await fetch(authorizationUrl, { redirect: 'manual' });
assertStatus(consent, 200, 'OAuth consent page');
const html = await consent.text();
const flowId = hiddenInput(html, 'flow_id');
const csrf = hiddenInput(html, 'csrf_token');
const cookie = getCookie(consent);

const approval = await fetch(`${baseUrl}/oauth/authorize`, {
  method: 'POST',
  redirect: 'manual',
  headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
  body: new URLSearchParams({ flow_id: flowId, csrf_token: csrf, login_code: loginCode }),
});
assertStatus(approval, 302, 'OAuth approval');
const redirect = new URL(approval.headers.get('location'));
if (redirect.origin + redirect.pathname !== callback || redirect.searchParams.get('state') !== state) {
  throw new Error('OAuth approval did not return to the registered Grok callback with the original state.');
}
const code = redirect.searchParams.get('code');
if (!code) throw new Error('Authorization code was not issued.');

const tokenResponse = await fetch(`${baseUrl}/oauth/token`, {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    grant_type: 'authorization_code', client_id: client.client_id, code,
    redirect_uri: callback, code_verifier: verifier, resource,
  }),
});
assertStatus(tokenResponse, 200, 'OAuth token exchange');
const token = await tokenResponse.json();
if (!token.access_token || token.token_type?.toLowerCase() !== 'bearer') throw new Error('OAuth token response is incomplete.');

const call = async (name, args = {}) => {
  const response = await fetch(resource, {
    method: 'POST',
    headers: { authorization: `Bearer ${token.access_token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method: 'tools/call', params: { name, arguments: args } }),
  });
  if (!response.ok) throw new Error(`${name} returned HTTP ${response.status}.`);
  const rpc = await response.json();
  if (rpc.error) throw new Error(`${name} returned ${rpc.error.message}.`);
  return rpc.result.structuredContent;
};

const listedTools = await fetch(resource, {
  method: 'POST',
  headers: { authorization: `Bearer ${token.access_token}`, 'content-type': 'application/json' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
});
assertStatus(listedTools, 200, 'OAuth tools/list');
const toolNames = (await listedTools.json()).result.tools.map((tool) => tool.name);
if (toolNames.includes('create_task') || toolNames.includes('cancel_task')) throw new Error('Grok OAuth token exposes a task creation or cancellation tool.');
if (!toolNames.includes('claim_next_task') || !toolNames.includes('complete_task')) throw new Error('Grok OAuth token is missing worker tools.');

const deniedCreate = await fetch(resource, {
  method: 'POST',
  headers: { authorization: `Bearer ${token.access_token}`, 'content-type': 'application/json' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'create_task', arguments: {} } }),
});
assertStatus(deniedCreate, 400, 'OAuth scope enforcement response');
const deniedRpc = await deniedCreate.json();
if (!deniedRpc.error?.message?.includes('Missing scope: task:create')) throw new Error('Grok OAuth token was not denied the Codex-only create_task action.');

const taskIdempotencyKey = `oauth-smoke-create-${randomUUID()}`;
const created = await fetch(`${baseUrl}/mcp`, {
  method: 'POST',
  headers: { authorization: `Bearer ${codexToken}`, 'content-type': 'application/json' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'create_task', arguments: {
    source: 'codex', task_type: 'codex_research', title: 'OAuth connector smoke test',
    instructions: 'Local protocol test only; do not perform external actions.',
    acceptance_criteria: 'The authorized Grok client claims and completes this local test task.',
    idempotency_key: taskIdempotencyKey,
  } } }),
});
assertStatus(created, 200, 'Codex task creation');
const createRpc = await created.json();
if (createRpc.error) throw new Error(`Task creation returned ${createRpc.error.message}.`);

const beforeClaim = await call('list_tasks', { limit: 50 });
if (beforeClaim.tasks?.some((task) => task.id === createRpc.result.structuredContent.task_id)) throw new Error('Grok can see a task before claiming it.');
const claimed = await call('claim_next_task', { idempotency_key: `oauth-smoke-claim-${randomUUID()}` });
if (claimed.task?.task_id !== createRpc.result.structuredContent.task_id) throw new Error('Grok did not claim the queued smoke task.');

const completed = await call('complete_task', {
  task_id: claimed.task.task_id,
  idempotency_key: `oauth-smoke-complete-${randomUUID()}`,
  result: { summary: 'OAuth authorization and scoped task handoff passed.', evidence: [], artifacts: [], limitations: ['Local-only protocol smoke test.'], recommended_next_action: '' },
});
if (completed.status !== 'succeeded') throw new Error('Grok did not complete the smoke task.');

console.log(JSON.stringify({
  protected_resource_discovery: 'passed',
  oauth: 'authorization_code_pkce_passed',
  dcr: 'passed',
  non_grok_client_rejected: true,
  codex_only_tool_denied: true,
  tools: toolNames,
  task: 'created_claimed_completed',
  status: completed.status,
}, null, 2));

function getCookie(response) {
  const cookies = response.headers.getSetCookie?.() ?? [response.headers.get('set-cookie') ?? ''];
  const csrfCookie = cookies.find((value) => value.startsWith('__Host-GROK-OAUTH-CSRF='));
  if (!csrfCookie) throw new Error('CSRF cookie was not set.');
  return csrfCookie.split(';', 1)[0];
}
function hiddenInput(html, name) {
  const field = html.match(new RegExp(`<input[^>]+name="${name}"[^>]+value="([^"]+)"`));
  if (!field) throw new Error(`Missing ${name} field in consent form.`);
  return field[1];
}
function assertStatus(response, status, label) {
  if (response.status !== status) throw new Error(`${label} returned HTTP ${response.status}, expected ${status}.`);
}
