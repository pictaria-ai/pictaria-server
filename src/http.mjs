import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';

const MAX_JSON_BODY_BYTES = 1024 * 1024;
export const DEFAULT_JSON_BODY_TIMEOUT_MS = 30_000;

const CONTENT_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

export class HttpBodyError extends Error {
  constructor(message, status = 400, code = 'invalid_request_body') {
    super(message);
    this.name = 'HttpBodyError';
    this.status = status;
    this.code = code;
  }
}

// Event-based reading (not for-await) so an early size-limit abort does not
// destroy the socket before the error response can be written.
export async function readJsonBody(request, { maxBytes = MAX_JSON_BODY_BYTES, timeoutMs = DEFAULT_JSON_BODY_TIMEOUT_MS } = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError('timeoutMs must be a finite positive number.');
  }
  const mediaType = String(request.headers['content-type'] ?? '')
    .split(';', 1)[0]
    .trim()
    .toLowerCase();
  if (mediaType !== 'application/json' && !(mediaType.startsWith('application/') && mediaType.endsWith('+json'))) {
    throw new HttpBodyError(
      'Request body must use an application/json content type.',
      415,
      'unsupported_media_type',
    );
  }
  return new Promise((resolvePromise, reject) => {
    const chunks = [];
    let byteLength = 0;
    let settled = false;
    const timeout = setTimeout(onTimeout, timeoutMs);
    timeout?.unref?.();

    function cleanup() {
      if (timeout) {
        clearTimeout(timeout);
      }
      request.off('data', onData);
      request.off('end', onEnd);
      request.off('error', onError);
      request.off('aborted', onAborted);
    }

    function finish(error, value) {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      if (error) {
        reject(error);
        return;
      }
      resolvePromise(value);
    }

    function onData(chunk) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      byteLength += buffer.byteLength;
      if (byteLength > maxBytes) {
        request.pause();
        finish(new HttpBodyError('Request body is too large.', 413, 'payload_too_large'));
        return;
      }
      chunks.push(buffer);
    }

    function onEnd() {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) {
        finish(null, {});
        return;
      }
      try {
        finish(null, JSON.parse(raw));
      } catch {
        finish(new HttpBodyError('Request body must be valid JSON.', 400, 'invalid_json'));
      }
    }

    function onError(error) {
      finish(error);
    }

    function onAborted() {
      finish(new HttpBodyError('Request body was interrupted.', 400, 'request_body_aborted'));
    }

    function onTimeout() {
      request.pause();
      finish(new HttpBodyError('Request body took too long to arrive.', 408, 'request_body_timeout'));
    }

    request.on('data', onData);
    request.once('end', onEnd);
    request.once('error', onError);
    request.once('aborted', onAborted);
  });
}

export function sendJson(response, statusCode, body, extraHeaders = {}) {
  const payload = JSON.stringify(body, null, 2);
  response.writeHead(statusCode, {
    'Content-Length': Buffer.byteLength(payload),
    'Content-Type': 'application/json; charset=utf-8',
    ...extraHeaders,
  });
  response.end(payload);
}

export function sendError(response, statusCode, code, message, extraHeaders = {}) {
  sendJson(response, statusCode, { error: { code, message } }, extraHeaders);
}

export function sendAudio(response, statusCode, { audio, contentType, provider, model, voice }) {
  sendBinary(response, statusCode, audio, contentType, {
    'Cache-Control': 'no-store',
    'X-TTS-Model': model || '',
    'X-TTS-Provider': provider || '',
    'X-TTS-Voice': voice || '',
  });
}

export function sendNoContent(response) {
  response.writeHead(204);
  response.end();
}

export function sendBinary(response, statusCode, buffer, contentType, extraHeaders = {}) {
  response.writeHead(statusCode, {
    'Cache-Control': 'private, max-age=300',
    'Content-Length': buffer.byteLength,
    'Content-Type': contentType,
    ...extraHeaders,
  });
  response.end(buffer);
}

// Immich is a separately administered upstream service. Do not forward its
// Content-Type header blindly: a misrouted proxy or compromised upstream could
// otherwise make this authenticated origin serve active HTML or SVG. Derive a
// narrow raster type from the bytes and let the global `nosniff` header keep
// browsers from interpreting the response as anything else.
export function detectRasterImageContentType(value) {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value ?? []);
  if (buffer.length >= 3
    && buffer[0] === 0xff
    && buffer[1] === 0xd8
    && buffer[2] === 0xff) {
    return 'image/jpeg';
  }
  if (buffer.length >= 8
    && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png';
  }
  if (buffer.length >= 6) {
    const signature = buffer.toString('ascii', 0, 6);
    if (signature === 'GIF87a' || signature === 'GIF89a') {
      return 'image/gif';
    }
  }
  if (buffer.length >= 12
    && buffer.toString('ascii', 0, 4) === 'RIFF'
    && buffer.toString('ascii', 8, 12) === 'WEBP') {
    return 'image/webp';
  }
  if (buffer.length >= 16 && buffer.toString('ascii', 4, 8) === 'ftyp') {
    const boxSize = buffer.readUInt32BE(0);
    if (boxSize >= 16 && boxSize <= buffer.length) {
      for (let offset = 8; offset + 4 <= boxSize; offset += 4) {
        const brand = buffer.toString('ascii', offset, offset + 4);
        if (brand === 'avif' || brand === 'avis') {
          return 'image/avif';
        }
      }
    }
  }
  return null;
}

export function sendImage(response, statusCode, buffer, extraHeaders = {}) {
  const contentType = detectRasterImageContentType(buffer);
  if (!contentType) {
    sendError(
      response,
      502,
      'invalid_upstream_image',
      'Immich returned unsupported or malformed image content.',
      { 'Cache-Control': 'no-store' },
    );
    return false;
  }
  sendBinary(response, statusCode, buffer, contentType, extraHeaders);
  return true;
}

export function handleBodyError(request, response, error) {
  if (!(error instanceof HttpBodyError)) {
    return false;
  }
  if (error.status === 408 || error.status === 413) {
    response.once('finish', () => request.destroy());
    sendError(response, error.status, error.code, error.message, { Connection: 'close' });
    return true;
  }
  sendError(response, error.status, error.code, error.message);
  return true;
}

export async function serveStaticFile(response, publicDir, pathname) {
  const safePath = pathname === '/' ? '/index.html' : pathname;
  const resolvedPath = resolve(publicDir, `.${safePath}`);
  if (resolvedPath !== publicDir && !resolvedPath.startsWith(`${publicDir}${sep}`)) {
    sendError(response, 403, 'forbidden', 'Forbidden.');
    return true;
  }
  try {
    const file = await readFile(resolvedPath);
    response.writeHead(200, {
      'Cache-Control': 'no-store',
      'Content-Length': file.byteLength,
      'Content-Type': CONTENT_TYPES[extname(resolvedPath)] ?? 'application/octet-stream',
    });
    response.end(file);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}
