import test from 'node:test';
import assert from 'node:assert/strict';
import { parseManagedClients } from '../src/clients.ts';

const digest = 'a'.repeat(64);

test('managed caller registry accepts distinct least-privilege clients', () => {
  const clients = parseManagedClients(JSON.stringify({ clients: [
    { client_id: 'codex', token_sha256: digest, scopes: ['task:create', 'task:read', 'task:cancel'], enabled: true },
    { client_id: 'claude-code', token_sha256: 'b'.repeat(64), scopes: ['task:create', 'task:read'], enabled: true },
  ] }));
  assert.deepEqual(clients?.map((client) => client.clientId), ['codex', 'claude-code']);
  assert.equal(clients?.[1].scopes.includes('task:cancel'), false);
});

test('managed caller registry rejects executor scopes, malformed digests, and duplicate identities', () => {
  assert.throws(() => parseManagedClients(JSON.stringify({ clients: [{ client_id: 'grok', token_sha256: digest, scopes: ['task:claim'], enabled: true }] })));
  assert.throws(() => parseManagedClients(JSON.stringify({ clients: [{ client_id: 'codex', token_sha256: 'short', scopes: ['task:read'], enabled: true }] })));
  assert.throws(() => parseManagedClients(JSON.stringify({ clients: [
    { client_id: 'codex', token_sha256: digest, scopes: ['task:read'], enabled: true },
    { client_id: 'codex', token_sha256: 'b'.repeat(64), scopes: ['task:read'], enabled: true },
  ] })));
});
