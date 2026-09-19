import {
  AuthorizationError,
  OAuthProvider,
  getOAuthApi,
  type AuthRequest,
  type OAuthProviderOptions,
} from '@cloudflare/workers-oauth-provider';
import { WorkerEntrypoint } from 'cloudflare:workers';
import { BridgeError, MAX_TASK_ATTACHMENT_BYTES, safeEqual, validateAttachments, validateResult } from './validation';
import { isAuthorizationCallback, validateOAuthClientRegistration } from './oauth-callbacks';

export { safeEqual, validateAttachments, validateResult } from './validation';

export interface Env {
  DB: D1Database;
  ATTACHMENTS: R2Bucket;
  OAUTH_KV: KVNamespace;
  ENVIRONMENT: string;
  CODEX_TOKEN: string;
  GROK_TOKEN: string;
  GROK_OAUTH_LOGIN_CODE: string;
  ATTACHMENT_SIGNING_SECRET: string;
  PUBLIC_BASE_URL: string;
}

type Client = 'codex' | 'grok';
type Scope = 'task:create' | 'task:read' | 'task:cancel' | 'task:claim' | 'task:progress' | 'task:complete';
type TaskStatus = 'queued' | 'claimed' | 'running' | 'succeeded' | 'failed' | 'cancelled';
type AttachmentDirection = 'input' | 'result';

const TASK_CAPABILITIES = {
  codex_research: { effectClass: 'read_only' },
  research_evidence: { effectClass: 'read_only' },
  browser_collection: { effectClass: 'read_only' },
} as const;
type TaskType = keyof typeof TASK_CAPABILITIES;

const PROTOCOL_VERSION = '2025-03-26';
const LEASE_MINUTES = 15;
const ATTACHMENT_UPLOAD_MINUTES = 15;
const ATTACHMENT_RETENTION_DAYS = 7;
// KV list calls are capped at 1,000/day on the free plan, so the OAuth purge
// runs on its own daily trigger instead of every five minutes.
const OAUTH_PURGE_CRON = '17 3 * * *';
// Consent may be completed in a separate browser window. Keep it alive for
// 30 minutes and retain an authoritative D1 copy because KV propagation is
// eventually consistent across Cloudflare locations.
const OAUTH_FLOW_TTL_SECONDS = 1800;
const GROK_OAUTH_SCOPES: Scope[] = ['task:read', 'task:claim', 'task:progress', 'task:complete'];
const MAX_RESULT_BYTES = 500 * 1024;
const MAX_TASK_EVENTS = 200;
const EXECUTION_DEADLINE_MINUTES = 45;
const MAX_RETRY_DELAY_MINUTES = 60;
const TERMINAL = new Set<TaskStatus>(['succeeded', 'failed', 'cancelled']);

const TOOL_DEFINITIONS = [
  tool('create_task', 'Create a Codex task for Grok Bot.', {
    type: 'object', required: ['source', 'task_type', 'title', 'instructions', 'idempotency_key'],
    properties: {
      source: { type: 'string', enum: ['codex'] },
      task_type: { type: 'string', enum: ['codex_research'] },
      title: { type: 'string', minLength: 1, maxLength: 200 },
      instructions: { type: 'string', minLength: 1, maxLength: 50000 },
      acceptance_criteria: { type: 'string', maxLength: 10000 },
      priority: { type: 'integer', minimum: 0, maximum: 100 },
      idempotency_key: { type: 'string', minLength: 8, maxLength: 200 },
      attachments: { type: 'array', maxItems: 20, items: { type: 'object' } },
    },
  }),
  tool('get_task', 'Read a task, progress events, result, and attachment URLs.', {
    type: 'object', required: ['task_id'], properties: { task_id: { type: 'string' } },
  }),
  tool('list_tasks', 'List tasks visible to the authenticated client.', {
    type: 'object', properties: {
      status: { type: 'string' }, source: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 50 },
    },
  }),
  tool('cancel_task', 'Cancel a queued or claimed task.', {
    type: 'object', required: ['task_id', 'idempotency_key'], properties: { task_id: { type: 'string' }, idempotency_key: { type: 'string', minLength: 8, maxLength: 200 } },
  }),
  tool('claim_next_task', 'Atomically claim the next eligible task for Grok Bot.', {
    type: 'object', required: ['idempotency_key'], properties: { task_type: { type: 'string' }, idempotency_key: { type: 'string', minLength: 8, maxLength: 200 } },
  }),
  tool('renew_task_lease', 'Renew the current Grok Bot task lease.', {
    type: 'object', required: ['task_id', 'lease_token'], properties: { task_id: { type: 'string' }, lease_token: { type: 'string', minLength: 20, maxLength: 200 } },
  }),
  tool('append_progress', 'Append progress to a claimed Grok Bot task.', {
    type: 'object', required: ['task_id', 'lease_token', 'message'], properties: { task_id: { type: 'string' }, lease_token: { type: 'string', minLength: 20, maxLength: 200 }, message: { type: 'string', maxLength: 5000 } },
  }),
  tool('complete_task', 'Complete a Grok Bot task with a structured evidence result.', {
    type: 'object', required: ['task_id', 'lease_token', 'result', 'idempotency_key'], properties: { task_id: { type: 'string' }, lease_token: { type: 'string', minLength: 20, maxLength: 200 }, result: { type: 'object' }, idempotency_key: { type: 'string', minLength: 8, maxLength: 200 } },
  }),
  tool('fail_task', 'Fail or requeue a Grok Bot task.', {
    type: 'object', required: ['task_id', 'lease_token', 'error', 'idempotency_key'], properties: { task_id: { type: 'string' }, lease_token: { type: 'string', minLength: 20, maxLength: 200 }, error: { type: 'object' }, retryable: { type: 'boolean' }, idempotency_key: { type: 'string', minLength: 8, maxLength: 200 } },
  }),
  tool('prepare_result_attachment', 'Reserve a small result attachment slot and return a signed upload URL.', {
    type: 'object', required: ['task_id', 'lease_token', 'name', 'mime_type', 'size_bytes'], properties: { task_id: { type: 'string' }, lease_token: { type: 'string', minLength: 20, maxLength: 200 }, name: { type: 'string' }, mime_type: { type: 'string' }, size_bytes: { type: 'integer' } },
  }),
];

const TOOL_REQUIRED_SCOPE: Record<string, Scope> = {
  create_task: 'task:create',
  get_task: 'task:read',
  list_tasks: 'task:read',
  cancel_task: 'task:cancel',
  claim_next_task: 'task:claim',
  renew_task_lease: 'task:progress',
  append_progress: 'task:progress',
  complete_task: 'task:complete',
  fail_task: 'task:progress',
  prepare_result_attachment: 'task:progress',
};

function tool(name: string, description: string, inputSchema: Record<string, unknown>) {
  return { name, description, inputSchema };
}

interface OAuthProps { client: 'grok'; scopes: Scope[]; }

function oauthOptionsFor(env: Env): OAuthProviderOptions<Env> {
  const baseUrl = env.PUBLIC_BASE_URL.replace(/\/$/, '');
  return {
  apiRoute: '/grok/mcp',
  apiHandler: class GrokOAuthApi extends WorkerEntrypoint<Env, OAuthProps> {
    fetch(request: Request) {
      const auth: AuthContext = { client: this.ctx.props.client, scopes: new Set(this.ctx.props.scopes) };
      return handleMcp(request, this.env, auth);
    }
  },
  defaultHandler: {
    fetch(request, env) { return handleOAuthAuthorization(request, env); },
  },
  authorizeEndpoint: '/oauth/authorize',
  tokenEndpoint: '/oauth/token',
  clientRegistrationEndpoint: '/oauth/register',
  scopesSupported: GROK_OAUTH_SCOPES,
  resourceMetadata: {
    resource: `${baseUrl}/grok/mcp`,
    scopes_supported: GROK_OAUTH_SCOPES,
    resource_name: 'Codex Grok Bot Task Bridge',
  },
  clientRegistrationCallback: ({ clientMetadata }) => validateOAuthClientRegistration(clientMetadata),
  accessTokenTTL: 3600,
  refreshTokenTTL: 60 * 60 * 24 * 30,
  clientRegistrationTTL: undefined,
  };
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    let requestId: JSONRPCRequest['id'] = null;
    try {
      const url = new URL(request.url);
      if (url.pathname === '/health' && request.method === 'GET') return json({ ok: true, environment: env.ENVIRONMENT });
      if (url.pathname.startsWith('/attachments/')) return handleAttachment(request, env, url);
      if (url.pathname === '/grok-token/mcp') {
        const auth = authenticateGrokToken(request, env);
        return auth ? handleMcp(request, env, auth) : json({ error: 'unauthorized' }, 401, { 'WWW-Authenticate': 'Bearer' });
      }
      if (url.pathname === '/mcp') return handleMcp(request, env);
      return await new OAuthProvider<Env>(oauthOptionsFor(env)).fetch(request, env, ctx);
    } catch (error) {
      console.error(JSON.stringify({ error: classifyError(error) }));
      if (error instanceof BridgeError) return rpcError(requestId, -32000, `${error.code}: ${error.message}`);
      return json({ error: 'internal_error' }, 500);
    }
  },
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    // reconcileExpired only touches D1 and must stay frequent so expired
    // leases requeue quickly. purgeExpiredData scans KV with list calls and
    // the free tier allows only 1,000 lists/day, so it runs on a separate
    // daily cron instead of every 5 minutes.
    if (event.cron === OAUTH_PURGE_CRON) {
      const oauthProvider = new OAuthProvider<Env>(oauthOptionsFor(env));
      ctx.waitUntil(oauthProvider.purgeExpiredData(env).then(() => undefined));
      return;
    }
    ctx.waitUntil(reconcileExpired(env).then(() => undefined));
  },
};

async function handleMcp(request: Request, env: Env, suppliedAuth?: AuthContext): Promise<Response> {
  let requestId: JSONRPCRequest['id'] = null;
  try {
    if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405, { Allow: 'POST' });
    const auth = suppliedAuth ?? authenticate(request, env);
    if (!auth) return json({ error: 'unauthorized' }, 401, { 'WWW-Authenticate': 'Bearer' });
    const contentLength = Number(request.headers.get('content-length') ?? 0);
    if (Number.isFinite(contentLength) && contentLength > 1024 * 1024) return json({ error: 'request_too_large' }, 413);
    let body: JSONRPCRequest;
    try {
      const rawBody = await request.text();
      if (new TextEncoder().encode(rawBody).byteLength > 1024 * 1024) return json({ error: 'request_too_large' }, 413);
      const parsed = JSON.parse(rawBody) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return rpcError(null, -32600, 'Invalid JSON-RPC request');
      body = parsed as JSONRPCRequest;
    } catch {
      return rpcError(null, -32700, 'Parse error');
    }
    requestId = body.id ?? null;
    if (body.jsonrpc !== '2.0' || typeof body.method !== 'string') return rpcError(body.id, -32600, 'Invalid JSON-RPC request');
    if (body.method === 'notifications/initialized' || body.method.startsWith('notifications/')) return new Response(null, { status: 204 });
    if (body.method === 'initialize') return rpcResult(body.id, { protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: { name: 'codex-grok-task-bridge', version: '0.2.0' } });
    if (body.method === 'ping') return rpcResult(body.id, {});
    if (body.method === 'tools/list') return rpcResult(body.id, { tools: TOOL_DEFINITIONS.filter((item) => auth.scopes.has(TOOL_REQUIRED_SCOPE[item.name])) });
    if (body.method !== 'tools/call') return rpcError(body.id, -32601, 'Method not found');
    if (body.params !== undefined && (!body.params || typeof body.params !== 'object' || Array.isArray(body.params))) return rpcError(body.id, -32602, 'Invalid params');
    const params = body.params as { name?: unknown; arguments?: unknown } | undefined;
    if (!params?.name) return rpcError(body.id, -32602, 'Tool name is required');
    if (params.arguments !== undefined && (!params.arguments || typeof params.arguments !== 'object' || Array.isArray(params.arguments))) return rpcError(body.id, -32602, 'Tool arguments must be an object');
    const result = await callTool(String(params.name), (params.arguments ?? {}) as Record<string, unknown>, auth, env);
    return rpcResult(body.id, { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result });
  } catch (error) {
    console.error(JSON.stringify({ error: classifyError(error) }));
    if (error instanceof BridgeError) return rpcError(requestId, -32000, `${error.code}: ${error.message}`);
    return json({ error: 'internal_error' }, 500);
  }
}

async function handleOAuthAuthorization(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname !== '/oauth/authorize') return json({ error: 'not_found' }, 404);
  const oauth = getOAuthApi(oauthOptionsFor(env), env);
  if (request.method === 'GET') {
    let authRequest: AuthRequest;
    try {
      authRequest = await oauth.parseAuthRequest(request);
    } catch (error) {
      if (!(error instanceof AuthorizationError)) throw error;
      return oauthErrorPage(error.description, 400);
    }
    if (authRequest.scope.length === 0) return oauthErrorPage('OAuth 客户端必须明确请求最小权限范围。', 400);
    if (authRequest.scope.some((scope) => !GROK_OAUTH_SCOPES.includes(scope as Scope))) return oauthErrorPage('该连接器请求了不支持的权限。', 400);
    if (!isAuthorizationCallback(authRequest.redirectUri)) return oauthErrorPage('Grok Bot 必须通过已批准的 Cursor 或 Grok 回调授权。', 400);
    const client = await oauth.lookupClient(authRequest.clientId);
    if (!client) return oauthErrorPage('无法识别 OAuth 客户端。', 400);
    const flowId = crypto.randomUUID();
    const csrf = crypto.randomUUID();
    const serializedRequest = JSON.stringify(authRequest);
    const expiresAt = new Date(Date.now() + OAUTH_FLOW_TTL_SECONDS * 1000).toISOString();
    await env.OAUTH_KV.put(`grok-oauth-flow:${flowId}`, serializedRequest, { expirationTtl: OAUTH_FLOW_TTL_SECONDS });
    await env.DB.prepare('INSERT INTO oauth_flows (flow_id, request_json, expires_at, created_at) VALUES (?, ?, ?, ?)').bind(flowId, serializedRequest, expiresAt, new Date().toISOString()).run();
    return new Response(oauthConsentPage(client.clientName ?? 'Grok Connector', csrf, flowId, false, authRequest.scope as Scope[]), {
      headers: oauthHtmlHeaders(`__Host-GROK-OAUTH-CSRF=${csrf}; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=${OAUTH_FLOW_TTL_SECONDS}`),
    });
  }
  if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405, { Allow: 'GET, POST' });
  const contentLength = Number(request.headers.get('content-length') ?? 0);
  if (contentLength > 4096) return json({ error: 'request_too_large' }, 413);
  const form = await request.formData();
  const flowId = String(form.get('flow_id') ?? '');
  const csrf = String(form.get('csrf_token') ?? '');
  const cookieCsrf = readCookie(request, '__Host-GROK-OAUTH-CSRF');
  const csrfMatches = Boolean(csrf && cookieCsrf && safeEqual(csrf, cookieCsrf));
  if (!/^[0-9a-f-]{36}$/i.test(flowId) || !csrf || !cookieCsrf || !csrfMatches) return oauthErrorPage('授权会话无效或已过期，请从 Grok 连接器重新开始。', 400);
  const flowKey = `grok-oauth-flow:${flowId}`;
  // KV is fast but eventually consistent. D1 is the authoritative fallback
  // so a quick POST from another location cannot lose the consent session.
  const serialized = await env.OAUTH_KV.get(flowKey) ?? (await env.DB.prepare('SELECT request_json FROM oauth_flows WHERE flow_id = ? AND expires_at > ?').bind(flowId, new Date().toISOString()).first<{ request_json: string }>())?.request_json;
  if (!serialized) return oauthErrorPage('授权会话已过期，请从 Grok 连接器重新开始。', 400);
  const loginCode = String(form.get('login_code') ?? '');
  if (!env.GROK_OAUTH_LOGIN_CODE || !safeEqual(loginCode, env.GROK_OAUTH_LOGIN_CODE)) {
    const pendingRequest = JSON.parse(serialized) as AuthRequest;
    const client = await oauth.lookupClient(pendingRequest.clientId);
    return new Response(oauthConsentPage(client?.clientName ?? 'Grok Connector', csrf, flowId, true, pendingRequest.scope as Scope[]), {
      status: 401,
      headers: oauthHtmlHeaders(`__Host-GROK-OAUTH-CSRF=${csrf}; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=${OAUTH_FLOW_TTL_SECONDS}`),
    });
  }
  const authRequest = JSON.parse(serialized) as AuthRequest;
  const client = await oauth.lookupClient(authRequest.clientId);
  if (!client) return oauthErrorPage('OAuth 客户端已失效，请从 Grok 连接器重新开始。', 400);
  const requested = authRequest.scope.length ? authRequest.scope : GROK_OAUTH_SCOPES;
  if (requested.some((scope) => !GROK_OAUTH_SCOPES.includes(scope as Scope))) return oauthErrorPage('该连接器请求了不支持的权限。', 400);
  const grantedScopes = [...new Set(requested as Scope[])];
  const { redirectTo } = await oauth.completeAuthorization({
    request: authRequest,
    userId: 'bridge-owner',
    metadata: { clientName: client.clientName ?? 'Grok Connector' },
    scope: grantedScopes,
    props: { client: 'grok', scopes: grantedScopes },
  });
  await Promise.allSettled([
    env.OAUTH_KV.delete(flowKey),
    env.DB.prepare('DELETE FROM oauth_flows WHERE flow_id = ?').bind(flowId).run(),
  ]);
  // Some connector webviews submit the form successfully but do not follow a
  // cross-origin 302 response. Show an explicit continuation page so the
  // browser can complete the connector callback instead of leaving the user
  // on the consent form (a second click would then report an expired flow).
  return oauthContinuationPage(redirectTo);
}

function oauthConsentPage(clientName: string, csrf: string, flowId: string, invalidCode: boolean, scopes: Scope[]) {
  const permissions = [...new Set(scopes)].map((scope) => `<li>${escapeHtml(scopeDescription(scope))}</li>`).join('');
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>授权 Codex Grok Bot 任务桥</title><body><main><h1>授权 Codex Grok Bot 任务桥</h1><p>客户端：<strong>${escapeHtml(clientName)}</strong></p><p>授权后，此 Grok Connector 可领取并处理 Codex 提交的任务。它不能创建或取消任务，也不能写入外部知识库或协作平台。</p><ul>${permissions}</ul>${invalidCode ? '<p role="alert">授权码不正确，请重试。</p>' : ''}<form method="post" action="/oauth/authorize"><input type="hidden" name="flow_id" value="${escapeHtml(flowId)}"><input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}"><label for="login_code">任务桥授权码</label><input id="login_code" name="login_code" type="password" autocomplete="off" required maxlength="256"><button type="submit">批准并连接 Grok</button></form><p>若不是你本人发起，请关闭此页面。授权码只用于此任务桥登录，不要粘贴到聊天内容。</p></main></body></html>`;
}

function oauthErrorPage(message: string, status: number) {
  return new Response(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>任务桥授权失败</title><body><main><h1>无法完成授权</h1><p>${escapeHtml(message)}</p></main></body></html>`, { status, headers: oauthHtmlHeaders() });
}

function oauthContinuationPage(redirectTo: string) {
  const safeTarget = escapeHtml(redirectTo);
  const headers = oauthHtmlHeaders();
  headers.set('Location', redirectTo);
  return new Response(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="0;url=${safeTarget}"><title>正在连接 Grok</title><body><main><h1>授权成功</h1><p>正在返回 Grok Connector。若未自动跳转，请点击下方链接。</p><p><a href="${safeTarget}">继续连接 Grok</a></p></main></body></html>`, { status: 302, headers });
}

function oauthHtmlHeaders(cookie?: string) {
  const headers = new Headers({ 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'" });
  if (cookie) headers.set('Set-Cookie', cookie);
  return headers;
}

function readCookie(request: Request, name: string) {
  const prefix = `${name}=`;
  return request.headers.get('Cookie')?.split(';').map((part) => part.trim()).find((part) => part.startsWith(prefix))?.slice(prefix.length) ?? '';
}

function escapeHtml(value: string) { return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;'); }
function scopeDescription(scope: Scope): string {
  const descriptions: Record<Scope, string> = {
    'task:create': '创建新任务',
    'task:read': '读取任务及其结果',
    'task:cancel': '取消尚未执行的任务',
    'task:claim': '领取一个待处理任务',
    'task:progress': '更新进度与租约',
    'task:complete': '提交任务结果或失败状态',
  };
  return descriptions[scope];
}

interface JSONRPCRequest { jsonrpc?: string; id?: string | number | null; method?: string; params?: unknown; }
interface AuthContext { client: Client; scopes: Set<Scope>; }

function authenticate(request: Request, env: Env): AuthContext | null {
  const header = request.headers.get('Authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) return null;
  if (safeEqual(token, env.CODEX_TOKEN ?? '')) return { client: 'codex', scopes: new Set(['task:create', 'task:read', 'task:cancel']) };
  if (safeEqual(token, env.GROK_TOKEN ?? '')) return { client: 'grok', scopes: new Set(['task:read', 'task:claim', 'task:progress', 'task:complete']) };
  return null;
}

// Optional static-header entry point for clients that cannot complete OAuth.
// It accepts only the dedicated Grok token and exposes no create/cancel scope.
function authenticateGrokToken(request: Request, env: Env): AuthContext | null {
  const header = request.headers.get('Authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  return token && safeEqual(token, env.GROK_TOKEN ?? '')
    ? { client: 'grok', scopes: new Set(['task:read', 'task:claim', 'task:progress', 'task:complete']) }
    : null;
}

async function callTool(name: string, args: Record<string, unknown>, auth: AuthContext, env: Env): Promise<Record<string, unknown>> {
  switch (name) {
    case 'create_task': requireScope(auth, 'task:create'); return createTask(args, auth, env);
    case 'get_task': requireScope(auth, 'task:read'); return getTask(requireTaskId(args.task_id), auth, env);
    case 'list_tasks': requireScope(auth, 'task:read'); return listTasks(args, auth, env);
    case 'cancel_task': requireScope(auth, 'task:cancel'); return cancelTask(args, auth, env);
    case 'claim_next_task': requireScope(auth, 'task:claim'); return claimNextTask(args, env);
    case 'renew_task_lease': requireScope(auth, 'task:progress'); return renewLease(requireTaskId(args.task_id), requireLeaseToken(args.lease_token), env);
    case 'append_progress': requireScope(auth, 'task:progress'); return appendProgress(args, env);
    case 'complete_task': requireScope(auth, 'task:complete'); return completeTask(args, env);
    case 'fail_task': requireScope(auth, 'task:progress'); return failTask(args, env);
    case 'prepare_result_attachment': requireScope(auth, 'task:progress'); return prepareResultAttachment(args, env);
    default: throw new BridgeError('tool_not_found', `Unknown tool: ${name}`);
  }
}

async function createTask(args: Record<string, unknown>, auth: AuthContext, env: Env) {
  const source = typeof args.source === 'string' ? args.source : '';
  if (source !== auth.client || source !== 'codex') throw new BridgeError('forbidden', 'source does not match authenticated client');
  const taskType = typeof args.task_type === 'string' ? args.task_type : '';
  if (taskType !== 'codex_research' || !isReadOnlyTaskType(taskType)) throw new BridgeError('invalid_task_type', 'Codex may only create registered read_only tasks');
  const title = cleanText(args.title, 200);
  const instructions = cleanText(args.instructions, 50000);
  const acceptance = cleanOptionalText(args.acceptance_criteria, 10000);
  const idempotencyKey = cleanText(args.idempotency_key, 200);
  if (idempotencyKey.length < 8) throw new BridgeError('invalid_idempotency_key', 'idempotency_key must have at least 8 characters');
  const attachments = validateAttachments(args.attachments);
  const requestHash = await requestHashFor(args);
  const existing = await env.DB.prepare('SELECT id, create_request_hash FROM tasks WHERE source = ? AND idempotency_key = ?').bind(source, idempotencyKey).first<{ id: string; create_request_hash: string }>();
  if (existing) {
    if (existing.create_request_hash && !safeEqual(existing.create_request_hash, requestHash)) throw new BridgeError('idempotency_conflict', 'idempotency_key was already used with different task content');
    return getTask(existing.id, auth, env);
  }
  const now = new Date().toISOString();
  const taskId = crypto.randomUUID();
  const rawPriority = args.priority ?? 50;
  if (typeof rawPriority !== 'number' || !Number.isInteger(rawPriority) || rawPriority < 0 || rawPriority > 100) throw new BridgeError('invalid_priority', 'priority must be an integer between 0 and 100');
  const priority = rawPriority;
  const statements: D1PreparedStatement[] = [env.DB.prepare(`INSERT INTO tasks (id, source, task_type, title, instructions, acceptance_criteria, priority, status, effect_class, idempotency_key, create_request_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', 'read_only', ?, ?, ?, ?)`).bind(taskId, source, taskType, title, instructions, acceptance, priority, idempotencyKey, requestHash, now, now), env.DB.prepare('INSERT INTO task_events (task_id, event_type, actor, payload_json, created_at) VALUES (?, ?, ?, ?, ?)').bind(taskId, 'created', auth.client, '{}', now)];
  const responseAttachments: Record<string, unknown>[] = [];
  for (const item of attachments) {
    const id = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + ATTACHMENT_RETENTION_DAYS * 86400000).toISOString();
    const key = `${env.ENVIRONMENT}/${taskId}/${id}/${item.name}`;
    statements.push(env.DB.prepare('INSERT INTO attachments (id, task_id, name, mime_type, size_bytes, object_key, upload_status, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, \'pending\', ?, ?)').bind(id, taskId, item.name, item.mimeType, item.sizeBytes, key, expiresAt, now));
    responseAttachments.push({ id, name: item.name, mime_type: item.mimeType, size_bytes: item.sizeBytes, upload_url: await signedAttachmentUrl(env, taskId, id, 'upload', ATTACHMENT_UPLOAD_MINUTES) });
  }
  try {
    await env.DB.batch(statements);
  } catch (error) {
    // Two first attempts with the same key can race before either sees the
    // existing row. Treat the unique-key winner as the idempotent result.
    const winner = await env.DB.prepare('SELECT id, create_request_hash FROM tasks WHERE source = ? AND idempotency_key = ?').bind(source, idempotencyKey).first<{ id: string; create_request_hash: string }>();
    if (winner) {
      if (winner.create_request_hash && !safeEqual(winner.create_request_hash, requestHash)) throw new BridgeError('idempotency_conflict', 'idempotency_key was already used with different task content');
      return getTask(winner.id, auth, env);
    }
    throw error;
  }
  return { task_id: taskId, status: 'queued', expires_at: new Date(Date.now() + ATTACHMENT_RETENTION_DAYS * 86400000).toISOString(), attachments: responseAttachments };
}

async function getTask(taskId: string, auth: AuthContext, env: Env) {
  if (!taskId) throw new BridgeError('invalid_task_id', 'task_id is required');
  const task = await env.DB.prepare('SELECT * FROM tasks WHERE id = ?').bind(taskId).first<Record<string, unknown>>();
  if (!task) throw new BridgeError('not_found', 'Task not found');
  if (auth.client !== 'grok' && task.source !== auth.client) throw new BridgeError('forbidden', 'Task belongs to another source');
  if (auth.client === 'grok' && task.lease_owner !== 'grok') {
    const previouslyClaimed = await env.DB.prepare("SELECT 1 AS claimed FROM task_events WHERE task_id = ? AND event_type = 'claimed' AND actor = 'grok' LIMIT 1").bind(taskId).first<{ claimed: number }>();
    if (!previouslyClaimed) throw new BridgeError('forbidden', 'Task is not assigned to Grok Bot');
  }
  const events = await env.DB.prepare('SELECT event_type, actor, payload_json, created_at FROM task_events WHERE task_id = ? ORDER BY id ASC').bind(taskId).all<Record<string, string>>();
  const attempts = await env.DB.prepare('SELECT id, lease_generation, executor, started_at, ended_at, end_reason, summary_json FROM execution_attempts WHERE task_id = ? ORDER BY lease_generation ASC').bind(taskId).all<Record<string, string>>();
  const attachments = await env.DB.prepare('SELECT id, name, mime_type, size_bytes, direction, upload_status, sha256, expires_at FROM attachments WHERE task_id = ?').bind(taskId).all<Record<string, string>>();
  const attachmentResults = await Promise.all((attachments.results ?? []).map(async (item) => ({ ...item, download_url: item.upload_status === 'uploaded' && item.expires_at > new Date().toISOString() ? await signedAttachmentUrl(env, taskId, item.id, 'download', ATTACHMENT_RETENTION_DAYS * 24 * 60) : null })));
  return { task_id: task.id, source: task.source, task_type: task.task_type, effect_class: task.effect_class, title: task.title, instructions: task.instructions, acceptance_criteria: task.acceptance_criteria, priority: task.priority, status: task.status, attempts: task.attempts, lease_generation: task.lease_generation, lease_expires_at: task.lease_expires_at, execution_deadline_at: task.execution_deadline_at, next_attempt_at: task.next_attempt_at, cancel_requested: Boolean(task.cancel_requested_at), created_at: task.created_at, updated_at: task.updated_at, completed_at: task.completed_at, result: parseJson(task.result_json), error: parseJson(task.error_json), events: (events.results ?? []).map((e) => ({ event_type: e.event_type, actor: e.actor, created_at: e.created_at, payload: parseJson(e.payload_json) })), execution_attempts: (attempts.results ?? []).map((attempt) => ({ attempt_id: attempt.id, lease_generation: attempt.lease_generation, executor: attempt.executor, started_at: attempt.started_at, ended_at: attempt.ended_at, end_reason: attempt.end_reason, summary: parseJson(attempt.summary_json) })), attachments: attachmentResults };
}

async function listTasks(args: Record<string, unknown>, auth: AuthContext, env: Env) {
  const rawLimit = args.limit ?? 20;
  if (typeof rawLimit !== 'number' || !Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > 50) throw new BridgeError('invalid_limit', 'limit must be an integer between 1 and 50');
  const limit = rawLimit;
  const status = args.status === undefined ? '' : cleanText(args.status, 20);
  if (status && !['queued', 'claimed', 'running', 'succeeded', 'failed', 'cancelled'].includes(status)) throw new BridgeError('invalid_status', 'Unsupported task status');
  const sourceArg = args.source === undefined ? '' : cleanText(args.source, 20);
  const source = auth.client === 'grok' ? sourceArg : auth.client;
  const clauses = auth.client === 'grok' ? ["lease_owner = 'grok'"] : ['1 = 1']; const values: (string | number)[] = [];
  if (source) { clauses.push('source = ?'); values.push(source); }
  if (status) { clauses.push('status = ?'); values.push(status); }
  const result = await env.DB.prepare(`SELECT id, source, task_type, title, status, attempts, created_at, updated_at FROM tasks WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC LIMIT ?`).bind(...values, limit).all();
  return { tasks: result.results ?? [] };
}

async function cancelTask(args: Record<string, unknown>, auth: AuthContext, env: Env) {
  const taskId = requireTaskId(args.task_id);
  const operationKey = requireIdempotencyKey(args.idempotency_key);
  const previous = await readIdempotent(env, auth.client, 'cancel_task', operationKey, args);
  if (previous) return previous;
  const task = await env.DB.prepare('SELECT status, source FROM tasks WHERE id = ?').bind(taskId).first<{ status: TaskStatus; source: Client }>();
  if (!task) throw new BridgeError('not_found', 'Task not found');
  if (task.source !== auth.client) throw new BridgeError('forbidden', 'Task belongs to another source');
  if (task.status === 'running') {
    const now = new Date().toISOString();
    const requested = await env.DB.prepare("UPDATE tasks SET cancel_requested_at = COALESCE(cancel_requested_at, ?), cancel_requested_by = COALESCE(cancel_requested_by, ?), updated_at = ? WHERE id = ? AND status = 'running'").bind(now, auth.client, now, taskId).run();
    if (!requested.meta.changes) throw new BridgeError('not_cancellable', 'Task changed state before cancellation');
    await appendEvent(env, taskId, 'cancel_requested', auth.client, {}, now);
    const response = { task_id: taskId, status: 'cancel_requested' };
    await writeIdempotent(env, auth.client, 'cancel_task', operationKey, taskId, response, args);
    return response;
  }
  if (TERMINAL.has(task.status)) {
    const response = { task_id: taskId, status: task.status };
    await writeIdempotent(env, auth.client, 'cancel_task', operationKey, taskId, response, args);
    return response;
  }
  const now = new Date().toISOString();
  const cancelled = await env.DB.prepare("UPDATE tasks SET status = 'cancelled', updated_at = ?, completed_at = ? WHERE id = ? AND status IN ('queued', 'claimed')").bind(now, now, taskId).run();
  if (!cancelled.meta.changes) throw new BridgeError('not_cancellable', 'Task changed state before cancellation');
  await appendEvent(env, taskId, 'cancelled', auth.client, {}, now);
  const response = { task_id: taskId, status: 'cancelled' };
  await writeIdempotent(env, auth.client, 'cancel_task', operationKey, taskId, response, args);
  return response;
}

async function claimNextTask(args: Record<string, unknown>, env: Env) {
  const operationKey = requireIdempotencyKey(args.idempotency_key);
  const taskType = args.task_type === undefined ? '' : args.task_type;
  if (typeof taskType !== 'string' || (taskType && !isReadOnlyTaskType(taskType))) throw new BridgeError('invalid_task_type', 'Unsupported or non-read-only task type');
  const requestHash = await requestHashFor(args);
  const now = new Date(); const nowText = now.toISOString();
  await reconcileExpired(env);
  const previous = await env.DB.prepare("SELECT t.id, t.status, t.lease_generation, t.lease_claim_key, t.lease_expires_at, a.request_hash FROM execution_attempts a JOIN tasks t ON t.id = a.task_id WHERE a.executor = 'grok' AND a.claim_idempotency_key = ?").bind(operationKey).first<{ id: string; status: TaskStatus; lease_generation: number; lease_claim_key: string; lease_expires_at: string; request_hash: string }>();
  if (previous) {
    if (previous.request_hash && !safeEqual(previous.request_hash, requestHash)) throw new BridgeError('idempotency_conflict', 'idempotency_key was already used with different claim content');
    const task = await getTask(previous.id, { client: 'grok', scopes: new Set(['task:read']) }, env);
    const active = ['claimed', 'running'].includes(previous.status) && previous.lease_claim_key === operationKey && previous.lease_expires_at > nowText;
    return { task, lease_token: active ? await makeLeaseToken(env, previous.id, previous.lease_generation, operationKey) : null };
  }
  const expires = new Date(now.getTime() + LEASE_MINUTES * 60000).toISOString();
  const deadline = new Date(now.getTime() + EXECUTION_DEADLINE_MINUTES * 60000).toISOString();
  const attemptId = crypto.randomUUID();
  const provisionalToken = await makeLeaseToken(env, 'pending', 0, `${operationKey}:${attemptId}`);
  const tokenHash = await sha256Text(provisionalToken);
  const query = taskType
    ? `UPDATE tasks SET status = 'claimed', lease_owner = 'grok', lease_expires_at = ?, execution_deadline_at = ?, lease_generation = lease_generation + 1, lease_token_hash = ?, lease_claim_key = ?, lease_attempt_id = ?, attempts = attempts + 1, updated_at = ? WHERE id = (SELECT id FROM tasks WHERE status = 'queued' AND task_type = ? AND effect_class = 'read_only' AND attempts < max_attempts AND (next_attempt_at IS NULL OR next_attempt_at <= ?) ORDER BY priority DESC, created_at ASC LIMIT 1) AND status = 'queued' RETURNING id, lease_generation`
    : `UPDATE tasks SET status = 'claimed', lease_owner = 'grok', lease_expires_at = ?, execution_deadline_at = ?, lease_generation = lease_generation + 1, lease_token_hash = ?, lease_claim_key = ?, lease_attempt_id = ?, attempts = attempts + 1, updated_at = ? WHERE id = (SELECT id FROM tasks WHERE status = 'queued' AND effect_class = 'read_only' AND attempts < max_attempts AND (next_attempt_at IS NULL OR next_attempt_at <= ?) ORDER BY priority DESC, created_at ASC LIMIT 1) AND status = 'queued' RETURNING id, lease_generation`;
  const claimed = taskType ? await env.DB.prepare(query).bind(expires, deadline, tokenHash, operationKey, attemptId, nowText, taskType, nowText).first<{ id: string; lease_generation: number }>() : await env.DB.prepare(query).bind(expires, deadline, tokenHash, operationKey, attemptId, nowText, nowText).first<{ id: string; lease_generation: number }>();
  if (!claimed) return { task: null, lease_token: null };
  const leaseToken = await makeLeaseToken(env, claimed.id, claimed.lease_generation, operationKey);
  await env.DB.batch([
    env.DB.prepare('UPDATE tasks SET lease_token_hash = ? WHERE id = ? AND lease_generation = ?').bind(await sha256Text(leaseToken), claimed.id, claimed.lease_generation),
    env.DB.prepare('INSERT INTO execution_attempts (id, task_id, lease_generation, executor, claim_idempotency_key, request_hash, started_at) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(attemptId, claimed.id, claimed.lease_generation, 'grok', operationKey, requestHash, nowText),
    env.DB.prepare('INSERT INTO task_events (task_id, event_type, actor, payload_json, created_at) VALUES (?, ?, ?, ?, ?)').bind(claimed.id, 'claimed', 'grok', JSON.stringify({ attempt_id: attemptId, lease_generation: claimed.lease_generation, lease_expires_at: expires, execution_deadline_at: deadline }), nowText),
  ]);
  return { task: await getTask(claimed.id, { client: 'grok', scopes: new Set(['task:read']) }, env), lease_token: leaseToken };
}

async function reconcileExpired(env: Env) {
  const now = new Date().toISOString();
  const expired = await env.DB.prepare("SELECT id, attempts, max_attempts, lease_generation, lease_attempt_id, cancel_requested_at FROM tasks WHERE status IN ('claimed', 'running') AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?").bind(now).all<{ id: string; attempts: number; max_attempts: number; lease_generation: number; lease_attempt_id: string | null; cancel_requested_at: string | null }>();
  for (const task of expired.results ?? []) {
    const cancelled = Boolean(task.cancel_requested_at); const exhausted = !cancelled && task.attempts >= task.max_attempts;
    const nextAttemptAt = cancelled || exhausted ? null : new Date(Date.now() + retryDelayMinutes(task.attempts) * 60000).toISOString();
    const nextStatus = cancelled ? 'cancelled' : exhausted ? 'failed' : 'queued';
    const reason = cancelled ? 'cancelled' : exhausted ? 'retry_exhausted' : 'lease_expired';
    const error = cancelled ? { code: 'cancelled', message: 'Cancellation was requested before the executor acknowledged it.' } : exhausted ? { code: 'retry_exhausted', message: 'Lease expired after the final permitted attempt.' } : { code: 'lease_expired', message: 'Lease expired; retry is delayed.' };
    const updated = await env.DB.prepare(`UPDATE tasks SET status = ?, lease_owner = NULL, lease_expires_at = NULL, lease_token_hash = NULL, lease_claim_key = NULL, lease_attempt_id = NULL, execution_deadline_at = NULL, next_attempt_at = ?, error_json = ?, updated_at = ?, completed_at = CASE WHEN ? THEN ? ELSE completed_at END WHERE id = ? AND lease_generation = ? AND status IN ('claimed', 'running') AND lease_expires_at <= ?`).bind(nextStatus, nextAttemptAt, JSON.stringify(error), now, cancelled || exhausted ? 1 : 0, now, task.id, task.lease_generation, now).run();
    if (!updated.meta.changes) continue;
    if (task.lease_attempt_id) await env.DB.prepare('UPDATE execution_attempts SET ended_at = ?, end_reason = ? WHERE id = ? AND ended_at IS NULL').bind(now, reason, task.lease_attempt_id).run();
    await appendEvent(env, task.id, cancelled ? 'cancelled' : exhausted ? 'retry_exhausted' : 'lease_expired_requeued', 'system', { next_attempt_at: nextAttemptAt, lease_generation: task.lease_generation }, now);
  }
  const attachments = await env.DB.prepare("SELECT id, object_key FROM attachments WHERE expires_at <= ? AND upload_status != 'expired' LIMIT 500").bind(now).all<{ id: string; object_key: string }>();
  if (attachments.results?.length) await env.ATTACHMENTS.delete(attachments.results.map((item) => item.object_key));
  for (const item of attachments.results ?? []) await env.DB.prepare("UPDATE attachments SET upload_status = 'expired' WHERE id = ?").bind(item.id).run();
  await env.DB.prepare("DELETE FROM oauth_flows WHERE expires_at <= ?").bind(now).run();
  await env.DB.prepare("DELETE FROM operation_idempotency WHERE created_at <= datetime('now', '-30 days')").run();
}

async function renewLease(taskId: string, leaseToken: string, env: Env) {
  const task = await ownedTask(taskId, leaseToken, env, ['claimed', 'running']);
  const now = new Date(); const nowText = now.toISOString();
  const expires = new Date(Math.min(now.getTime() + LEASE_MINUTES * 60000, Date.parse(task.execution_deadline_at))).toISOString();
  if (expires <= nowText) throw new BridgeError('execution_deadline_exceeded', 'Task execution deadline has elapsed');
  const renewed = await env.DB.prepare("UPDATE tasks SET lease_expires_at = ?, updated_at = ? WHERE id = ? AND lease_generation = ? AND lease_token_hash = ? AND cancel_requested_at IS NULL AND lease_expires_at > ? AND execution_deadline_at > ?").bind(expires, nowText, taskId, task.lease_generation, task.lease_token_hash, nowText, nowText).run();
  if (!renewed.meta.changes) throw new BridgeError('lease_expired', 'Task lease has expired or was cancelled');
  return { task_id: taskId, lease_expires_at: expires, execution_deadline_at: task.execution_deadline_at };
}

async function appendProgress(args: Record<string, unknown>, env: Env) {
  const taskId = requireTaskId(args.task_id); const leaseToken = requireLeaseToken(args.lease_token); const message = cleanText(args.message, 5000); const task = await ownedTask(taskId, leaseToken, env, ['claimed', 'running']);
  const now = new Date().toISOString();
  const progressed = await env.DB.prepare("UPDATE tasks SET status = 'running', updated_at = ? WHERE id = ? AND lease_generation = ? AND lease_token_hash = ? AND cancel_requested_at IS NULL AND status IN ('claimed', 'running') AND lease_expires_at > ? AND execution_deadline_at > ?").bind(now, taskId, task.lease_generation, task.lease_token_hash, now, now).run();
  if (!progressed.meta.changes) throw new BridgeError('lease_expired', 'Task lease has expired, was cancelled, or exceeded its deadline');
  await appendEvent(env, taskId, 'progress', 'grok', { message, attempt_id: task.lease_attempt_id }, now);
  return { task_id: taskId, status: 'running', message };
}

async function completeTask(args: Record<string, unknown>, env: Env) {
  const taskId = requireTaskId(args.task_id); const leaseToken = requireLeaseToken(args.lease_token); const operationKey = requireIdempotencyKey(args.idempotency_key); const requestHash = await requestHashFor(args);
  const previous = await readIdempotent(env, 'grok', 'complete_task', operationKey, args); if (previous) return previous;
  const priorCompletion = await env.DB.prepare('SELECT completed_operation_key, completed_request_hash, completed_response_json FROM tasks WHERE id = ?').bind(taskId).first<{ completed_operation_key: string | null; completed_request_hash: string | null; completed_response_json: string | null }>();
  if (priorCompletion?.completed_operation_key === operationKey) {
    if (priorCompletion.completed_request_hash && !safeEqual(priorCompletion.completed_request_hash, requestHash)) throw new BridgeError('idempotency_conflict', 'idempotency_key was already used with different completion content');
    return parseJson(priorCompletion.completed_response_json) as Record<string, unknown>;
  }
  const task = await ownedTask(taskId, leaseToken, env, ['claimed', 'running']);
  const result = validateResult(args.result);
  const serialized = JSON.stringify(result); if (new TextEncoder().encode(serialized).byteLength > MAX_RESULT_BYTES) throw new BridgeError('result_too_large', 'result exceeds 500 KB');
  const response = { task_id: taskId, status: 'succeeded', result }; const serializedResponse = JSON.stringify(response); const now = new Date().toISOString();
  const completed = await env.DB.prepare("UPDATE tasks SET status = 'succeeded', result_json = ?, lease_owner = NULL, lease_expires_at = NULL, lease_token_hash = NULL, lease_claim_key = NULL, execution_deadline_at = NULL, completed_operation_key = ?, completed_request_hash = ?, completed_response_json = ?, updated_at = ?, completed_at = ? WHERE id = ? AND lease_generation = ? AND lease_token_hash = ? AND cancel_requested_at IS NULL AND status IN ('claimed', 'running') AND lease_expires_at > ? AND execution_deadline_at > ?").bind(serialized, operationKey, requestHash, serializedResponse, now, now, taskId, task.lease_generation, task.lease_token_hash, now, now).run();
  if (!completed.meta.changes) throw new BridgeError('lease_expired', 'Task lease has expired, was cancelled, or exceeded its deadline');
  if (task.lease_attempt_id) await env.DB.prepare("UPDATE execution_attempts SET ended_at = ?, end_reason = 'succeeded', summary_json = ? WHERE id = ? AND ended_at IS NULL").bind(now, JSON.stringify({ result_bytes: new TextEncoder().encode(serialized).byteLength }), task.lease_attempt_id).run();
  await appendEvent(env, taskId, 'completed', 'grok', { attempt_id: task.lease_attempt_id, result }, now);
  await writeIdempotent(env, 'grok', 'complete_task', operationKey, taskId, response, args);
  return response;
}

async function failTask(args: Record<string, unknown>, env: Env) {
  const taskId = requireTaskId(args.task_id); const leaseToken = requireLeaseToken(args.lease_token); const operationKey = requireIdempotencyKey(args.idempotency_key);
  const previous = await readIdempotent(env, 'grok', 'fail_task', operationKey, args); if (previous) return previous;
  const task = await ownedTask(taskId, leaseToken, env, ['claimed', 'running']);
  const rawError = args.error;
  const error = rawError && typeof rawError === 'object' && !Array.isArray(rawError) ? rawError : { message: cleanText(rawError, 2000) };
  const serializedError = JSON.stringify(error);
  if (new TextEncoder().encode(serializedError).byteLength > 10000) throw new BridgeError('invalid_error', 'error exceeds 10 KB');
  const retryable = args.retryable === true; const shouldRetry = retryable && task.attempts < task.max_attempts;
  const now = new Date().toISOString(); const nextAttemptAt = shouldRetry ? new Date(Date.now() + retryDelayMinutes(task.attempts) * 60000).toISOString() : null;
  const status = shouldRetry ? 'queued' : 'failed';
  const failed = await env.DB.prepare(`UPDATE tasks SET status = ?, error_json = ?, lease_owner = NULL, lease_expires_at = NULL, lease_token_hash = NULL, lease_claim_key = NULL, execution_deadline_at = NULL, next_attempt_at = ?, updated_at = ?${shouldRetry ? '' : ', completed_at = ?'} WHERE id = ? AND lease_generation = ? AND lease_token_hash = ? AND cancel_requested_at IS NULL AND status IN ('claimed', 'running') AND lease_expires_at > ? AND execution_deadline_at > ?`).bind(...(shouldRetry ? [status, serializedError, nextAttemptAt, now, taskId, task.lease_generation, task.lease_token_hash, now, now] : [status, serializedError, nextAttemptAt, now, now, taskId, task.lease_generation, task.lease_token_hash, now, now])).run();
  if (!failed.meta.changes) throw new BridgeError('lease_expired', 'Task lease has expired, was cancelled, or exceeded its deadline');
  if (task.lease_attempt_id) await env.DB.prepare('UPDATE execution_attempts SET ended_at = ?, end_reason = ?, summary_json = ? WHERE id = ? AND ended_at IS NULL').bind(now, shouldRetry ? 'retryable_failure' : 'failed', JSON.stringify({ error: classifyErrorPayload(error) }), task.lease_attempt_id).run();
  await appendEvent(env, taskId, shouldRetry ? 'requeued' : 'failed', 'grok', { attempt_id: task.lease_attempt_id, error: classifyErrorPayload(error), next_attempt_at: nextAttemptAt }, now);
  const response = { task_id: taskId, status, next_attempt_at: nextAttemptAt };
  await writeIdempotent(env, 'grok', 'fail_task', operationKey, taskId, response, args);
  return response;
}

async function prepareResultAttachment(args: Record<string, unknown>, env: Env) {
  const taskId = requireTaskId(args.task_id); const leaseToken = requireLeaseToken(args.lease_token);
  await ownedTask(taskId, leaseToken, env, ['claimed', 'running']);
  const [item] = validateAttachments([{ name: args.name, mime_type: args.mime_type, size_bytes: args.size_bytes }]);
  const used = await env.DB.prepare('SELECT COALESCE(SUM(size_bytes), 0) AS total FROM attachments WHERE task_id = ?').bind(taskId).first<{ total: number }>();
  if (Number(used?.total ?? 0) + item.sizeBytes > MAX_TASK_ATTACHMENT_BYTES) throw new BridgeError('attachments_too_large', 'Task attachments exceed 25 MB');
  const id = crypto.randomUUID(); const now = new Date().toISOString(); const expiresAt = new Date(Date.now() + ATTACHMENT_RETENTION_DAYS * 86400000).toISOString();
  const key = `${env.ENVIRONMENT}/${taskId}/${id}/${item.name}`;
  await env.DB.prepare("INSERT INTO attachments (id, task_id, name, mime_type, direction, size_bytes, object_key, upload_status, expires_at, created_at) VALUES (?, ?, ?, ?, 'result', ?, ?, 'pending', ?, ?)").bind(id, taskId, item.name, item.mimeType, item.sizeBytes, key, expiresAt, now).run();
  return { attachment_id: id, upload_url: await signedAttachmentUrl(env, taskId, id, 'upload', ATTACHMENT_UPLOAD_MINUTES), expires_at: expiresAt };
}

async function ownedTask(taskId: string, leaseToken: string, env: Env, statuses: TaskStatus[]) {
  const task = await env.DB.prepare('SELECT id, status, attempts, max_attempts, lease_generation, lease_token_hash, lease_attempt_id, lease_expires_at, execution_deadline_at, cancel_requested_at FROM tasks WHERE id = ? AND lease_owner = \'grok\'').bind(taskId).first<Record<string, unknown>>();
  if (!task || !statuses.includes(task.status as TaskStatus)) throw new BridgeError('lease_not_owned', 'Task is not owned by the current Grok lease');
  if (!task.lease_token_hash || !safeEqual(String(task.lease_token_hash), await sha256Text(leaseToken))) throw new BridgeError('lease_not_owned', 'Task is not owned by the current Grok lease');
  const now = new Date().toISOString();
  if (String(task.lease_expires_at) <= now) throw new BridgeError('lease_expired', 'Task lease has expired');
  if (String(task.execution_deadline_at) <= now) throw new BridgeError('execution_deadline_exceeded', 'Task execution deadline has elapsed');
  if (task.cancel_requested_at) throw new BridgeError('cancel_requested', 'Task cancellation was requested');
  return task as { id: string; status: TaskStatus; attempts: number; max_attempts: number; lease_generation: number; lease_token_hash: string; lease_attempt_id: string | null; lease_expires_at: string; execution_deadline_at: string };
}

function requireTaskId(value: unknown) {
  return cleanText(value, 100);
}

async function handleAttachment(request: Request, env: Env, url: URL) {
  const parts = url.pathname.split('/').filter(Boolean); if (parts.length !== 3) return json({ error: 'not_found' }, 404);
  const [, taskId, attachmentId] = parts; const action = url.searchParams.get('action'); const expires = Number(url.searchParams.get('expires')); const signature = url.searchParams.get('sig') ?? '';
  if (!action || !['upload', 'download'].includes(action) || !Number.isFinite(expires) || expires < Date.now()) return json({ error: 'expired_attachment_url' }, 403);
  if (!await verifySignature(env, `${taskId}:${attachmentId}:${action}:${expires}`, signature)) return json({ error: 'invalid_attachment_signature' }, 403);
  const attachment = await env.DB.prepare('SELECT * FROM attachments WHERE id = ? AND task_id = ?').bind(attachmentId, taskId).first<Record<string, string>>(); if (!attachment) return json({ error: 'not_found' }, 404);
  if (action === 'upload') {
    if (request.method !== 'PUT') return json({ error: 'method_not_allowed' }, 405);
    if (attachment.upload_status !== 'pending') return json({ error: 'attachment_already_uploaded' }, 409);
    if (Number(request.headers.get('content-length') ?? 0) > Number(attachment.size_bytes)) return json({ error: 'attachment_too_large' }, 413);
    const body = await request.arrayBuffer(); if (body.byteLength !== Number(attachment.size_bytes)) return json({ error: 'attachment_size_mismatch' }, 400);
    await env.ATTACHMENTS.put(attachment.object_key, body, { httpMetadata: { contentType: attachment.mime_type } });
    const hash = await sha256Hex(body); await env.DB.prepare("UPDATE attachments SET upload_status = 'uploaded', sha256 = ? WHERE id = ?").bind(hash, attachmentId).run();
    return json({ ok: true, sha256: hash });
  }
  if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405);
  const object = await env.ATTACHMENTS.get(attachment.object_key); if (!object) return json({ error: 'attachment_not_uploaded' }, 404);
  return new Response(object.body, { headers: { 'Content-Type': attachment.mime_type, 'Content-Length': String(attachment.size_bytes), 'Cache-Control': 'private, max-age=60', 'X-Content-Type-Options': 'nosniff' } });
}

async function signedAttachmentUrl(env: Env, taskId: string, attachmentId: string, action: 'upload' | 'download', minutes: number) {
  const expires = Date.now() + minutes * 60000; const payload = `${taskId}:${attachmentId}:${action}:${expires}`; const sig = await sign(env.ATTACHMENT_SIGNING_SECRET, payload);
  const baseUrl = env.PUBLIC_BASE_URL?.replace(/\/$/, '');
  if (!baseUrl || baseUrl.includes('REPLACE_WITH') || !/^https:\/\//.test(baseUrl) && !/^http:\/\/localhost(?::\d+)?$/.test(baseUrl)) throw new BridgeError('server_misconfigured', 'PUBLIC_BASE_URL must be an HTTPS URL');
  return `${baseUrl}/attachments/${encodeURIComponent(taskId)}/${encodeURIComponent(attachmentId)}?action=${action}&expires=${expires}&sig=${sig}`;
}

async function sign(secret: string, payload: string) { const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']); const bytes = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload)); return b64url(new Uint8Array(bytes)); }
async function verifySignature(env: Env, payload: string, signature: string) { return safeEqual(await sign(env.ATTACHMENT_SIGNING_SECRET, payload), signature); }
function b64url(bytes: Uint8Array) { let binary = ''; bytes.forEach((b) => { binary += String.fromCharCode(b); }); return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', ''); }
async function sha256Hex(data: ArrayBuffer) { const digest = await crypto.subtle.digest('SHA-256', data); return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join(''); }
function cleanText(value: unknown, max: number) { if (typeof value !== 'string') throw new BridgeError('invalid_text', `Text must be 1-${max} characters`); const text = value.trim(); if (!text || text.length > max) throw new BridgeError('invalid_text', `Text must be 1-${max} characters`); return text; }
function cleanOptionalText(value: unknown, max: number) { if (value === undefined || value === null || value === '') return ''; return cleanText(value, max); }
function requireIdempotencyKey(value: unknown) { const key = cleanText(value, 200); if (key.length < 8) throw new BridgeError('invalid_idempotency_key', 'idempotency_key must have at least 8 characters'); return key; }
function requireLeaseToken(value: unknown) { const token = cleanText(value, 200); if (token.length < 20) throw new BridgeError('invalid_lease_token', 'lease_token is invalid'); return token; }
function isReadOnlyTaskType(value: string): value is TaskType { return Object.prototype.hasOwnProperty.call(TASK_CAPABILITIES, value) && TASK_CAPABILITIES[value as TaskType].effectClass === 'read_only'; }
function retryDelayMinutes(attempts: number) { return Math.min(MAX_RETRY_DELAY_MINUTES, 5 * 2 ** Math.max(0, attempts - 1)); }
function classifyErrorPayload(error: unknown) { return error instanceof Error ? { code: error instanceof BridgeError ? error.code : 'executor_error', message: error.message.slice(0, 500) } : { code: 'executor_error', message: 'Executor reported a failure.' }; }
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort().map((key) => [key, canonicalize((value as Record<string, unknown>)[key])]));
  return value;
}
async function requestHashFor(args: Record<string, unknown>) { return sha256Text(JSON.stringify(canonicalize(args))); }
async function sha256Text(value: string) { const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)); return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join(''); }
async function makeLeaseToken(env: Env, taskId: string, generation: number, claimKey: string) { return `v1.${generation}.${await sign(env.ATTACHMENT_SIGNING_SECRET, `lease:${taskId}:${generation}:${claimKey}`)}`; }
async function appendEvent(env: Env, taskId: string, eventType: string, actor: string, payload: Record<string, unknown>, createdAt = new Date().toISOString()) {
  const count = await env.DB.prepare('SELECT COUNT(*) AS count FROM task_events WHERE task_id = ?').bind(taskId).first<{ count: number }>();
  if (Number(count?.count ?? 0) >= MAX_TASK_EVENTS) throw new BridgeError('event_limit_exceeded', 'Task event limit was reached');
  await env.DB.prepare('INSERT INTO task_events (task_id, event_type, actor, payload_json, created_at) VALUES (?, ?, ?, ?, ?)').bind(taskId, eventType, actor, JSON.stringify(payload), createdAt).run();
}
async function readIdempotent(env: Env, actor: Client, operation: string, key: string, args: Record<string, unknown>): Promise<Record<string, unknown> | null> {
  const row = await env.DB.prepare('SELECT response_json, request_hash FROM operation_idempotency WHERE actor = ? AND operation = ? AND idempotency_key = ?').bind(actor, operation, key).first<{ response_json: string; request_hash: string }>();
  if (!row) return null;
  const hash = await requestHashFor(args);
  if (row.request_hash && !safeEqual(row.request_hash, hash)) throw new BridgeError('idempotency_conflict', 'idempotency_key was already used with different request content');
  return parseJson(row.response_json) as Record<string, unknown>;
}
async function writeIdempotent(env: Env, actor: Client, operation: string, key: string, taskId: string | null, response: Record<string, unknown>, args: Record<string, unknown>) {
  const hash = await requestHashFor(args);
  const result = await env.DB.prepare('INSERT OR IGNORE INTO operation_idempotency (actor, operation, idempotency_key, task_id, response_json, request_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(actor, operation, key, taskId, JSON.stringify(response), hash, new Date().toISOString()).run();
  if (!result.meta.changes) await readIdempotent(env, actor, operation, key, args);
  return Boolean(result.meta.changes);
}
function parseJson(value: unknown) { if (typeof value !== 'string' || !value) return null; try { return JSON.parse(value); } catch { return { raw: '[unparseable]' }; } }
function requireScope(auth: AuthContext, scope: Scope) { if (!auth.scopes.has(scope)) throw new BridgeError('forbidden', `Missing scope: ${scope}`); }
function classifyError(error: unknown) { return error instanceof BridgeError ? error.code : 'unexpected_error'; }
function json(value: unknown, status = 200, extra: Record<string, string> = {}) { return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...extra } }); }
function rpcResult(id: JSONRPCRequest['id'], result: unknown) { return json({ jsonrpc: '2.0', id, result }); }
function rpcError(id: JSONRPCRequest['id'], code: number, message: string) { return json({ jsonrpc: '2.0', id, error: { code, message } }, 400); }
