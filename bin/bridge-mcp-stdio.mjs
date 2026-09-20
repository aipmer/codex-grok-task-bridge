#!/usr/bin/env node
import readline from 'node:readline';

const bridgeUrl = process.env.GROK_BRIDGE_URL;
const token = process.env.GROK_BRIDGE_TOKEN;
if (!bridgeUrl || !token) {
  process.stderr.write('GROK_BRIDGE_URL and GROK_BRIDGE_TOKEN must be set.\n');
  process.exit(1);
}

let endpoint;
try {
  endpoint = new URL(bridgeUrl);
  if (endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' && endpoint.hostname === 'localhost')) throw new Error('invalid protocol');
} catch {
  process.stderr.write('GROK_BRIDGE_URL must be an HTTPS MCP endpoint.\n');
  process.exit(1);
}

const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of lines) {
  if (!line.trim()) continue;
  let request;
  try { request = JSON.parse(line); } catch {
    writeError(null, -32700, 'Parse error');
    continue;
  }
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(request),
    });
    const payload = await response.text();
    if (!payload) continue;
    const parsed = JSON.parse(payload);
    process.stdout.write(`${JSON.stringify(parsed)}\n`);
  } catch {
    writeError(request?.id ?? null, -32000, 'Bridge transport unavailable');
  }
}

function writeError(id, code, message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })}\n`);
}
