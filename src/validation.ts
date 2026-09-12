const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_TASK_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const ALLOWED_MIME_TYPES = new Set([
  'text/plain', 'text/markdown', 'application/json', 'text/csv',
  'application/pdf', 'image/png', 'image/jpeg', 'image/webp',
]);
const FORBIDDEN_EXTENSIONS = new Set(['.env', '.pem', '.key', '.p12', '.pfx', '.cookie', '.sqlite', '.db']);

export class BridgeError extends Error {
  constructor(public code: string, message: string) { super(message); }
}

export function validateAttachments(value: unknown) {
  if (value === undefined) return [] as { name: string; mimeType: string; sizeBytes: number }[];
  if (!Array.isArray(value) || value.length > 20) throw new BridgeError('invalid_attachments', 'attachments must be an array of at most 20 items');
  let total = 0;
  return value.map((raw) => {
    if (!raw || typeof raw !== 'object') throw new BridgeError('invalid_attachment', 'attachment metadata must be an object');
    const item = raw as Record<string, unknown>;
    const name = cleanText(item.name, 180);
    const mimeType = cleanText(item.mime_type, 100).toLowerCase();
    const sizeBytes = Number(item.size_bytes);
    const lower = name.toLowerCase();
    const extension = lower.includes('.') ? lower.slice(lower.lastIndexOf('.')) : '';
    if (!name || !ALLOWED_MIME_TYPES.has(mimeType) || FORBIDDEN_EXTENSIONS.has(extension) || !Number.isInteger(sizeBytes) || sizeBytes < 1 || sizeBytes > MAX_ATTACHMENT_BYTES) {
      throw new BridgeError('invalid_attachment', 'Attachment type, name, or size is not allowed');
    }
    total += sizeBytes;
    if (total > MAX_TASK_ATTACHMENT_BYTES) throw new BridgeError('attachments_too_large', 'Task attachments exceed 25 MB');
    return { name, mimeType, sizeBytes };
  });
}

export function validateResult(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BridgeError('invalid_result', 'result must be an object');
  const result = value as Record<string, unknown>;
  const summary = cleanText(result.summary, 10000);
  const evidence = result.evidence;
  if (!Array.isArray(evidence) || evidence.length > 100) throw new BridgeError('invalid_result', 'evidence must be an array of at most 100 items');
  for (const item of evidence) {
    if (!item || typeof item !== 'object') throw new BridgeError('invalid_result', 'each evidence item must be an object');
    const evidenceItem = item as Record<string, unknown>;
    if (!isHttpUrl(evidenceItem.url) || !cleanText(evidenceItem.title, 500) || !isIsoDate(evidenceItem.observed_at) || !cleanText(evidenceItem.claim, 5000) || !cleanText(evidenceItem.excerpt, 5000)) {
      throw new BridgeError('invalid_result', 'evidence needs url, title, observed_at, claim, and excerpt');
    }
  }
  for (const key of ['artifacts', 'limitations']) if (result[key] !== undefined && !Array.isArray(result[key])) throw new BridgeError('invalid_result', `${key} must be an array`);
  if (result.recommended_next_action !== undefined) cleanOptionalText(result.recommended_next_action, 5000);
  return { ...result, summary };
}

export function safeEqual(a: string, b: string) {
  const left = new TextEncoder().encode(a);
  const right = new TextEncoder().encode(b);
  let mismatch = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i++) mismatch |= (left[i] ?? 0) ^ (right[i] ?? 0);
  return mismatch === 0;
}

function cleanText(value: unknown, max: number) {
  const text = String(value ?? '').trim();
  if (!text || text.length > max) throw new BridgeError('invalid_text', `Text must be 1-${max} characters`);
  return text;
}
function cleanOptionalText(value: unknown, max: number) {
  if (value === undefined || value === null || value === '') return '';
  return cleanText(value, max);
}
function isHttpUrl(value: unknown) {
  try { const url = new URL(String(value)); return url.protocol === 'https:' || url.protocol === 'http:'; }
  catch { return false; }
}
function isIsoDate(value: unknown) { return typeof value === 'string' && !Number.isNaN(Date.parse(value)); }
