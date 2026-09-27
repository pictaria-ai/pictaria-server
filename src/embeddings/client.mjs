import { randomBytes } from 'node:crypto';
import { appendHttpUrlPath, normalizeHttpUrl } from '../config.mjs';
import { structuredUpstreamDiagnostic } from '../diagnostics.mjs';
import { readBodyBounded } from '../fetchWithTimeout.mjs';

// Client for Immich's internal machine-learning service (port 3003). It is not
// part of Immich's public API: the request shape below matches Immich's own
// server (machine-learning.repository.ts) and immich_ml/main.py from 2.7.5
// through 3.2.2. The service is unauthenticated, so no credential is sent.
export const ML_LIMITS = Object.freeze({
  pingTimeoutMs: 5_000,
  embedTimeoutMs: 60_000,
  responseBytes: 1024 * 1024,
  minDims: 32,
  maxDims: 4096,
});

export class EmbeddingServiceError extends Error {
  constructor(message, code, { status = null, service = true } = {}) {
    super(message);
    this.name = 'EmbeddingServiceError';
    this.code = code;
    this.status = status;
    // Service-wide problems pause a session; a rejected image affects one photo.
    this.service = service;
  }
}

export class ImmichMlClient {
  constructor({ baseUrl, fetchImpl = fetch } = {}) {
    this.baseUrl = normalizeHttpUrl(baseUrl ?? '');
    this.fetchImpl = fetchImpl;
  }

  async ping({ signal, timeoutMs = ML_LIMITS.pingTimeoutMs } = {}) {
    const text = await this.#request('ping', { method: 'GET', accept: 'text/plain', signal, timeoutMs });
    if (text.trim() !== 'pong') {
      throw new EmbeddingServiceError(
        'This address answered, but not as the Immich machine-learning service.',
        'ml_not_immich',
      );
    }
    return true;
  }

  // Returns the model's raw visual embedding. Immich serialises it as a JSON
  // string inside the JSON response ({"clip":"[...]"}); a plain array is also
  // accepted in case a future release stops double-encoding it.
  async embedImage({ data, contentType }, { model, signal, timeoutMs = ML_LIMITS.embedTimeoutMs } = {}) {
    const form = multipart([
      { name: 'entries', value: JSON.stringify({ clip: { visual: { modelName: model } } }) },
      { name: 'image', value: data, filename: 'image', contentType: safeMediaType(contentType) },
    ]);
    const text = await this.#request('predict', {
      method: 'POST', body: form.body, headers: { 'Content-Type': form.contentType },
      accept: 'application/json', signal, timeoutMs,
    });
    return parseVisualEmbedding(text);
  }

  async #request(path, { method, body = undefined, headers = {}, accept, signal, timeoutMs }) {
    if (!this.baseUrl) {
      throw new EmbeddingServiceError('Set the Immich machine-learning URL first.', 'ml_not_configured');
    }
    signal?.throwIfAborted();
    const deadline = AbortSignal.timeout(timeoutMs);
    const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
    const failure = (error) => {
      if (signal?.aborted) return new EmbeddingServiceError('The request was cancelled.', 'ml_cancelled', { service: false });
      if (deadline.aborted) {
        return new EmbeddingServiceError(
          `The machine-learning service did not answer within ${Math.round(timeoutMs / 1000)} seconds.`,
          'ml_timeout',
        );
      }
      return error instanceof EmbeddingServiceError ? error
        : new EmbeddingServiceError('Could not reach the machine-learning service.', 'ml_unreachable');
    };
    let response, buffer;
    try {
      response = await this.fetchImpl(appendHttpUrlPath(this.baseUrl, path), {
        method,
        body,
        // The configured URL is the trust boundary; never follow a redirect
        // elsewhere with a photo in the request body.
        redirect: 'error',
        signal: combined,
        headers: { ...headers, Accept: accept },
      });
      buffer = typeof response.body?.getReader === 'function'
        ? await readBodyBounded(response, ML_LIMITS.responseBytes, 'Machine-learning service')
        : Buffer.from(await response.text(), 'utf8');
    } catch (error) {
      if (error?.name === 'ResponseTooLargeError') {
        throw new EmbeddingServiceError('The machine-learning service returned an unexpectedly large response.', 'ml_invalid_response');
      }
      throw failure(error);
    }
    if (buffer.byteLength > ML_LIMITS.responseBytes) {
      throw new EmbeddingServiceError('The machine-learning service returned an unexpectedly large response.', 'ml_invalid_response');
    }
    const text = buffer.toString('utf8');
    if (!response.ok) throw statusError(response.status, text);
    return text;
  }
}

// A prebuilt body rather than FormData: FormData streams through an async
// pull, and aborting mid-upload can make undici enqueue into a closed stream,
// an unhandled rejection that would stop the server (seen on Node 25).
function multipart(fields) {
  const boundary = `pictaria-${randomBytes(16).toString('hex')}`;
  const chunks = [];
  for (const { name, value, filename = null, contentType = null } of fields) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"`
      + (filename ? `; filename="${filename}"` : '') + '\r\n'
      + (contentType ? `Content-Type: ${contentType}\r\n` : '') + '\r\n'));
    chunks.push(Buffer.isBuffer(value) || value instanceof Uint8Array ? value : Buffer.from(String(value), 'utf8'));
    chunks.push(Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

function safeMediaType(value) {
  const type = String(value ?? '').split(';', 1)[0].trim().toLowerCase();
  return /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(type) ? type : 'application/octet-stream';
}

function statusError(status, text) {
  let detail = '';
  try { detail = structuredUpstreamDiagnostic(JSON.parse(text), { maxBytes: 200 }); } catch { /* plain-text body */ }
  const suffix = detail ? ` (${detail})` : '';
  if (status === 400) {
    return new EmbeddingServiceError(`The machine-learning service could not read this image${suffix}.`, 'ml_image_rejected',
      { status, service: false });
  }
  if (status === 404 || status === 405) {
    return new EmbeddingServiceError('This address does not offer the Immich machine-learning API.', 'ml_not_immich', { status });
  }
  if (status === 422) {
    return new EmbeddingServiceError(`The machine-learning service rejected the request${suffix}.`, 'ml_invalid_request', { status });
  }
  if (status === 500) {
    return new EmbeddingServiceError(
      `The machine-learning service could not run this model${suffix}. Check the model name; first use downloads it, which needs internet access.`,
      'ml_model_failed', { status });
  }
  if ([502, 503, 504].includes(status)) {
    return new EmbeddingServiceError('The machine-learning service is temporarily unavailable.', 'ml_unavailable', { status });
  }
  return new EmbeddingServiceError(`The machine-learning service returned HTTP ${status}.`, 'ml_http_error', { status });
}

export function parseVisualEmbedding(text) {
  const invalid = () => new EmbeddingServiceError(
    'The machine-learning service returned an unusable embedding.', 'ml_invalid_response');
  let value;
  try { value = JSON.parse(text); } catch { throw invalid(); }
  let clip = value && typeof value === 'object' ? value.clip : undefined;
  if (typeof clip === 'string') {
    try { clip = JSON.parse(clip); } catch { throw invalid(); }
  }
  if (!Array.isArray(clip) || clip.length < ML_LIMITS.minDims || clip.length > ML_LIMITS.maxDims) throw invalid();
  const vector = new Float32Array(clip.length);
  let norm = 0;
  for (let i = 0; i < clip.length; i++) {
    if (typeof clip[i] !== 'number') throw invalid();
    vector[i] = clip[i];
    if (!Number.isFinite(vector[i])) throw invalid();
    norm += vector[i] * vector[i];
  }
  if (!(norm > 0) || !Number.isFinite(norm)) throw invalid();
  return vector;
}
