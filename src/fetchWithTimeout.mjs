export class RequestTimeoutError extends Error {
  constructor(label, timeoutMs) {
    super(`${label} timed out after ${timeoutMs}ms.`);
    this.name = 'RequestTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

export class ResponseTooLargeError extends Error {
  constructor(label, maxBytes) {
    super(`${label} response exceeded the ${maxBytes}-byte limit.`);
    this.name = 'ResponseTooLargeError';
    this.maxBytes = maxBytes;
  }
}

// Big enough for any expected payload (a long TTS clip is a few MB); small
// enough that a runaway body cannot exhaust process memory.
export const DEFAULT_MAX_RESPONSE_BYTES = 32 * 1024 * 1024;

export function errorMessageWithCause(error) {
  const message = typeof error?.message === 'string' ? error.message : String(error);
  const causeMessage = typeof error?.cause?.message === 'string' ? error.cause.message : '';
  return causeMessage && causeMessage !== message && !message.includes(causeMessage)
    ? `${message}: ${causeMessage}`
    : message;
}

// One deadline for the WHOLE exchange: connect, headers, and body. The old
// shape cleared the timer when headers arrived, so a server that stalled
// mid-body hung the caller forever (the exact failure mode behind the frame's
// white-screen bug, on the app side). Real fetch responses come back fully
// buffered with json()/text()/arrayBuffer() reading from memory; injected
// fetchImpl doubles without a body stream pass through untouched.
export async function fetchWithTimeout(url, options = {}, timeoutMs = 30000, label = 'Request') {
  const {
    fetchImpl: customFetchImpl,
    maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
    ...fetchOptions
  } = options;
  const fetchImpl = customFetchImpl ?? fetch;
  const hasDeadline = Number.isFinite(timeoutMs) && timeoutMs > 0;

  const controller = new AbortController();
  const timeout = hasDeadline ? setTimeout(() => controller.abort(), timeoutMs) : null;

  try {
    const response = await fetchImpl(url, {
      ...fetchOptions,
      // The configured URL is the trust boundary. Do not let an upstream
      // move request bodies or custom credentials to another authority.
      redirect: 'error',
      ...(hasDeadline ? { signal: controller.signal } : {}),
    });
    if (typeof response?.body?.getReader !== 'function') {
      return response;
    }
    const buffer = await readBodyBounded(response, maxResponseBytes, label);
    return bufferResponse(response, buffer);
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new RequestTimeoutError(label, timeoutMs);
    }

    if (error instanceof Error) {
      const detailedMessage = errorMessageWithCause(error);
      if (detailedMessage !== error.message) {
        error.message = detailedMessage;
      }
    }
    throw error;
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

// Shared bounded read: rejects up front on a declared oversize body, and
// aborts a streamed one the moment it crosses the cap — the whole payload
// never sits in memory. Also used by the Immich client, whose requests do
// not go through fetchWithTimeout.
export async function readBodyBounded(response, maxBytes, label) {
  const declared = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body.cancel().catch(() => {});
    throw new ResponseTooLargeError(label, maxBytes);
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new ResponseTooLargeError(label, maxBytes);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

function bufferResponse(response, buffer) {
  return {
    ok: response.ok,
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
    url: response.url,
    arrayBuffer: async () => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
    text: async () => buffer.toString('utf8'),
    json: async () => JSON.parse(buffer.toString('utf8')),
  };
}
