import test from 'node:test';
import assert from 'node:assert/strict';
import { safeEqual, validateAttachments, validateResult } from '../src/validation.ts';

test('attachment validation enforces the declared security boundary', () => {
  const attachments = validateAttachments([{ name: 'brief.md', mime_type: 'text/markdown', size_bytes: 42 }]);
  assert.deepEqual(attachments, [{ name: 'brief.md', mimeType: 'text/markdown', sizeBytes: 42 }]);
  assert.throws(() => validateAttachments([{ name: '.env', mime_type: 'text/plain', size_bytes: 1 }]));
  assert.throws(() => validateAttachments([{ name: 'oversize.pdf', mime_type: 'application/pdf', size_bytes: 10 * 1024 * 1024 + 1 }]));
  assert.throws(() => validateAttachments([{ name: { toString: () => 'brief.md' }, mime_type: 'text/markdown', size_bytes: 42 }]));
});

test('structured evidence result rejects incomplete evidence', () => {
  const valid = validateResult({
    summary: 'One source was checked.',
    evidence: [{ url: 'https://example.com', title: 'Example', observed_at: '2026-09-12T00:00:00Z', claim: 'A supported fact.', excerpt: 'Short quote.' }],
    artifacts: [], limitations: [], recommended_next_action: '',
  });
  assert.equal(valid.summary, 'One source was checked.');
  assert.throws(() => validateResult({ summary: 'No source fields', evidence: [{ url: 'https://example.com' }] }));
  assert.throws(() => validateResult({ summary: { toString: () => 'not a string' }, evidence: [] }));
});

test('constant-time comparison has deterministic equality behavior', () => {
  assert.equal(safeEqual('abc', 'abc'), true);
  assert.equal(safeEqual('abc', 'abd'), false);
  assert.equal(safeEqual('abc', 'ab'), false);
});
