import http from 'node:http';
import { createHash } from 'node:crypto';

// Minimal stand-in for Immich's machine-learning service (immich_ml/main.py):
// GET /ping → "pong", POST /predict with multipart `entries` + `image`, and a
// response of {"clip": "<JSON array string>", imageHeight, imageWidth}. Vectors
// are a deterministic function of the image bytes, the model and `variant`, so
// a changed variant stands in for a preprocessing change in a new release.
const MODEL_DIMS = { 'ViT-B-32__openai': 512, 'ViT-B-16-SigLIP__webli': 768 };

export async function startFakeMl({ dims = null, models = null } = {}) {
  const state = {
    dims, variant: 0, noise: 0, delayMs: 0, slowAfter: 0, slowMs: 0, status: null, pong: 'pong', raw: null,
    models: models ?? new Set(['ViT-B-32__openai', 'ViT-B-16-SigLIP__webli']),
    requests: [],
  };
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    if (state.delayMs) await new Promise((resolve) => setTimeout(resolve, state.delayMs));
    if (request.method === 'GET' && request.url === '/ping') {
      response.writeHead(200, { 'content-type': 'text/plain' }).end(state.pong);
      return;
    }
    if (request.method !== 'POST' || request.url !== '/predict') {
      response.writeHead(404, { 'content-type': 'application/json' }).end('{"detail":"Not Found"}');
      return;
    }
    const parts = parseMultipart(request.headers['content-type'], body);
    const entries = JSON.parse(parts.entries?.data.toString('utf8') ?? 'null');
    const image = parts.image;
    const model = entries?.clip?.visual?.modelName;
    // Predictions after the first `slowAfter` wait `slowMs` (e.g. calibration fast, photos slow).
    if (state.slowMs && state.requests.length >= state.slowAfter) await new Promise((resolve) => setTimeout(resolve, state.slowMs));
    state.requests.push({ model, entries, bytes: image?.data.length ?? 0, contentType: image?.contentType ?? null,
      filename: image?.filename ?? null, sha256: image ? createHash('sha256').update(image.data).digest('hex') : null });
    if (state.status) {
      response.writeHead(state.status, { 'content-type': 'application/json' }).end(state.raw ?? '{"detail":"synthetic failure"}');
      return;
    }
    if (!state.models.has(model)) {
      // Immich raises an unhandled ValueError for unknown models.
      response.writeHead(500, { 'content-type': 'text/plain' }).end('Internal Server Error');
      return;
    }
    if (state.raw !== null) {
      response.writeHead(200, { 'content-type': 'application/json' }).end(state.raw);
      return;
    }
    const chosen = state.vectorFor?.(image.data, model);
    const vector = (chosen ?? vectorFor(image.data, model, state.variant, state.dims ?? MODEL_DIMS[model] ?? 512))
      .map((x, i) => x + state.noise * Math.sin(i * 13));
    response.writeHead(200, { 'content-type': 'application/json' })
      .end(JSON.stringify({ clip: JSON.stringify(vector), imageHeight: 256, imageWidth: 384 }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    url, state,
    predictions: () => state.requests.length,
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }),
  };
}

export function vectorFor(bytes, model, variant = 0, dims = 512) {
  const seed = createHash('sha256').update(bytes).update(String(model)).update(String(variant)).digest();
  const vector = [];
  for (let i = 0; i < dims; i++) vector.push((seed[i % 32] - 127.5) / 127.5 + Math.sin(i + seed[(i * 7) % 32]) / 4);
  return vector;
}

function parseMultipart(contentType, body) {
  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType ?? '');
  if (!boundary) return {};
  const marker = Buffer.from(`--${boundary[1] ?? boundary[2]}`);
  const parts = {};
  let start = body.indexOf(marker);
  while (start !== -1) {
    const next = body.indexOf(marker, start + marker.length);
    if (next === -1) break;
    const part = body.subarray(start + marker.length + 2, next - 2);
    const split = part.indexOf('\r\n\r\n');
    const headers = part.subarray(0, split).toString('utf8');
    const name = /name="([^"]+)"/.exec(headers)?.[1];
    if (name) {
      parts[name] = {
        data: part.subarray(split + 4),
        filename: /filename="([^"]*)"/.exec(headers)?.[1] ?? null,
        contentType: /content-type:\s*([^\r\n]+)/i.exec(headers)?.[1] ?? null,
      };
    }
    start = next;
  }
  return parts;
}
