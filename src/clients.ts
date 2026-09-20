import { BridgeError } from './validation';

export const CALLER_SCOPES = ['task:create', 'task:read', 'task:cancel'] as const;
export type CallerScope = typeof CALLER_SCOPES[number];

export interface ManagedClient {
  clientId: string;
  tokenSha256: string;
  scopes: CallerScope[];
  enabled: boolean;
}

export function parseManagedClients(value: string | undefined): ManagedClient[] | null {
  if (!value?.trim()) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw new BridgeError('invalid_client_registry', 'BRIDGE_CLIENTS must be valid JSON'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new BridgeError('invalid_client_registry', 'BRIDGE_CLIENTS must be an object');
  const clients = (parsed as Record<string, unknown>).clients;
  if (!Array.isArray(clients) || clients.length < 1 || clients.length > 50) throw new BridgeError('invalid_client_registry', 'BRIDGE_CLIENTS.clients must contain 1-50 clients');
  const ids = new Set<string>();
  return clients.map((raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new BridgeError('invalid_client_registry', 'Each managed client must be an object');
    const item = raw as Record<string, unknown>;
    const clientId = item.client_id;
    const tokenSha256 = item.token_sha256;
    const scopes = item.scopes;
    const enabled = item.enabled;
    if (typeof clientId !== 'string' || !/^[a-z][a-z0-9_-]{2,63}$/.test(clientId) || ids.has(clientId)) throw new BridgeError('invalid_client_registry', 'Each client_id must be unique and use lowercase letters, digits, hyphens, or underscores');
    if (typeof tokenSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(tokenSha256)) throw new BridgeError('invalid_client_registry', 'Each token_sha256 must be a lowercase SHA-256 digest');
    if (!Array.isArray(scopes) || !scopes.length || scopes.some((scope) => typeof scope !== 'string' || !CALLER_SCOPES.includes(scope as CallerScope))) throw new BridgeError('invalid_client_registry', 'Each client may request only caller scopes');
    if (new Set(scopes).size !== scopes.length || typeof enabled !== 'boolean') throw new BridgeError('invalid_client_registry', 'Client scopes must be unique and enabled must be boolean');
    ids.add(clientId);
    return { clientId, tokenSha256, scopes: scopes as CallerScope[], enabled };
  });
}
