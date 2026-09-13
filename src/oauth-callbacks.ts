const HTTPS_HOSTS = ['grok.com', 'x.ai'];
const CURSOR_CLOUD_CALLBACK = 'https://www.cursor.com/agents/mcp/oauth/callback';
const CURSOR_DESKTOP_CALLBACK = 'cursor://anysphere.cursor-mcp/oauth/callback';
const CURSOR_LOOPBACK_CALLBACKS = new Set([
  'http://localhost:8787/callback',
  'http://127.0.0.1:8787/callback',
]);

export function isCloudCallback(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  try {
    const uri = new URL(value);
    if (uri.username || uri.password || uri.hash) return false;
    if (uri.href === CURSOR_CLOUD_CALLBACK) return true;
    return uri.protocol === 'https:' && HTTPS_HOSTS.some((host) => uri.hostname === host || uri.hostname.endsWith(`.${host}`));
  } catch { return false; }
}

export function isRegisteredCallback(value: unknown): boolean {
  if (isCloudCallback(value)) return true;
  if (typeof value !== 'string') return false;
  return value === CURSOR_DESKTOP_CALLBACK || CURSOR_LOOPBACK_CALLBACKS.has(value);
}

export function isAuthorizationCallback(value: unknown): boolean {
  return isCloudCallback(value) || value === 'http://localhost:8787/callback';
}

export function validateOAuthClientRegistration(metadata: Record<string, unknown>) {
  const redirects = metadata.redirect_uris;
  if (!Array.isArray(redirects) || redirects.length === 0 || redirects.length > 10) {
    return { code: 'invalid_client_metadata', description: 'OAuth clients must register one to ten callback URLs.' };
  }
  if (!redirects.every(isRegisteredCallback) || !redirects.some(isCloudCallback)) {
    return { code: 'invalid_client_metadata', description: 'OAuth clients must register an approved Grok or Cursor cloud HTTPS callback. Only the documented Cursor desktop and loopback callbacks may accompany it.' };
  }
  return undefined;
}
