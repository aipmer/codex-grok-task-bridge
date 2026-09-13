import test from 'node:test';
import assert from 'node:assert/strict';
import { isAuthorizationCallback, isCloudCallback, validateOAuthClientRegistration } from '../src/oauth-callbacks.ts';

test('Cursor Grok Bot DCR permits documented cloud, desktop, and loopback callbacks', () => {
  assert.equal(validateOAuthClientRegistration({ redirect_uris: [
    'cursor://anysphere.cursor-mcp/oauth/callback',
    'https://www.cursor.com/agents/mcp/oauth/callback',
    'http://localhost:8787/callback',
  ] }), undefined);
});

test('actual authorization requires a cloud HTTPS callback', () => {
  assert.equal(isCloudCallback('https://www.cursor.com/agents/mcp/oauth/callback'), true);
  assert.equal(isCloudCallback('http://localhost:8787/callback'), false);
  assert.equal(isCloudCallback('cursor://anysphere.cursor-mcp/oauth/callback'), false);
});

test('desktop authorization permits only the fixed Cursor loopback callback', () => {
  assert.equal(isAuthorizationCallback('http://localhost:8787/callback'), true);
  assert.equal(isAuthorizationCallback('http://localhost:8788/callback'), false);
  assert.equal(isAuthorizationCallback('http://127.0.0.1:8787/callback'), false);
  assert.equal(isAuthorizationCallback('cursor://anysphere.cursor-mcp/oauth/callback'), false);
});

test('registration rejects arbitrary localhost ports, cursor paths, and unrelated domains', () => {
  for (const uri of [
    'http://localhost:9876/callback',
    'cursor://anysphere.cursor-mcp/other',
    'https://evil.example/callback',
    'https://www.cursor.com/other',
  ]) {
    assert.equal(validateOAuthClientRegistration({ redirect_uris: ['https://grok.com/callback', uri] })?.code, 'invalid_client_metadata');
  }
  assert.equal(validateOAuthClientRegistration({ redirect_uris: ['http://localhost:8787/callback'] })?.code, 'invalid_client_metadata');
});
