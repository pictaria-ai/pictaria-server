const DEFAULT_MAX_BYTES = 512;
const REDACTED = '[redacted]';
const SECRET_KEY = /(?:api.?key|authorization|password|secret|token)$/i;

export function configuredSecrets(...sources) {
  const secrets = new Set();
  const seen = new WeakSet();
  const visit = (value, key = '') => {
    if (typeof value === 'string') {
      if (SECRET_KEY.test(key) && value.length >= 4) secrets.add(value);
      return;
    }
    if (!value || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    for (const [childKey, child] of Object.entries(value)) visit(child, childKey);
  };
  for (const source of sources) visit(source);
  return [...secrets];
}

export function sanitizeDiagnostic(value, { secrets = [], maxBytes = DEFAULT_MAX_BYTES, fallback = '' } = {}) {
  let text = String(value ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!text) text = fallback;

  // Remove credential-shaped header echoes even if a caller forgot to pass
  // the corresponding secret. Exact configured values and common encodings
  // are then removed wherever an upstream reflected them.
  text = text.replace(
    /\b(authorization|proxy-authorization|x-api-key|xi-api-key|api[-_ ]?key)\s*[:=]\s*(?:bearer\s+)?[^\s,;)}\]]+/gi,
    `$1: ${REDACTED}`,
  );
  for (const secret of [...new Set(secrets.filter((item) => typeof item === 'string' && item.length >= 4))]) {
    for (const variant of secretVariants(secret)) {
      text = text.replace(new RegExp(escapeRegExp(variant), 'gi'), REDACTED);
    }
  }
  return truncateUtf8(text, maxBytes);
}

// Provider error bodies are untrusted. Retain only a small stable diagnostic
// vocabulary; debug dumps, reflected headers, request objects, and stacks are
// deliberately ignored even when present in otherwise valid JSON.
export function structuredUpstreamDiagnostic(value, options = {}) {
  if (!isPlainObject(value)) return sanitizeDiagnostic('', options);
  const fields = [];
  addField(fields, 'code', value.code);
  addField(fields, 'type', value.type);
  addField(fields, 'message', value.message);
  if (typeof value.error === 'string') {
    addField(fields, 'message', value.error);
  } else if (isPlainObject(value.error)) {
    addField(fields, 'code', value.error.code);
    addField(fields, 'type', value.error.type);
    addField(fields, 'message', value.error.message);
  }
  if (typeof value.detail === 'string') {
    addField(fields, 'message', value.detail);
  } else if (isPlainObject(value.detail)) {
    addField(fields, 'code', value.detail.code);
    addField(fields, 'type', value.detail.type);
    addField(fields, 'message', value.detail.message);
  }
  return sanitizeDiagnostic(fields.join('; '), options);
}

function addField(fields, label, value) {
  if (typeof value === 'string' || typeof value === 'number') {
    const text = String(value).trim();
    if (text) fields.push(label === 'message' ? text : `${label}: ${text}`);
  }
}

function secretVariants(secret) {
  const formEncoded = new URLSearchParams({ value: secret }).toString().slice('value='.length);
  const variants = new Set([secret, encodeURIComponent(secret), formEncoded]);
  const bytes = Buffer.from(secret, 'utf8');
  variants.add(bytes.toString('base64'));
  variants.add(bytes.toString('base64url'));
  return [...variants].filter(Boolean).sort((left, right) => right.length - left.length);
}

function truncateUtf8(value, maxBytes) {
  const limit = Number.isSafeInteger(maxBytes) && maxBytes > 0 ? maxBytes : DEFAULT_MAX_BYTES;
  if (Buffer.byteLength(value, 'utf8') <= limit) return value;
  const suffix = '…';
  let output = '';
  for (const character of value) {
    if (Buffer.byteLength(output + character + suffix, 'utf8') > limit) break;
    output += character;
  }
  return `${output}${suffix}`;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
