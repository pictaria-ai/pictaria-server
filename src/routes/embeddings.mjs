import { readJsonBody, sendError, sendJson } from '../http.mjs';
import { EmbeddingServiceError } from '../embeddings/client.mjs';

// Status and connection test for the optional Enrich image-embedding step.
// Photos never leave through these routes: the test embeds a synthetic image.
export function createEmbeddingRoutes({ embeddings }) {
  return async function handleEmbeddingRoute(request, response, url) {
    if (!url.pathname.startsWith('/api/enrich/embeddings')) return false;
    response.setHeader('Cache-Control', 'no-store');

    if (request.method === 'GET' && url.pathname === '/api/enrich/embeddings') {
      // ?check=1 refreshes the cached ping (home page); otherwise status only.
      const connection = url.searchParams.get('check') === '1' ? await embeddings.connection() : undefined;
      const status = embeddings.status();
      sendJson(response, 200, connection ? { ...status, connection } : status);
      return true;
    }

    if (request.method === 'POST' && url.pathname === '/api/enrich/embeddings/test') {
      const body = await readJsonBody(request, { maxBytes: 8 * 1024 });
      const known = ['url', 'model'];
      if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !known.includes(key))
          || known.some(key => body[key] !== undefined && typeof body[key] !== 'string')) {
        sendError(response, 400, 'invalid_embedding_test', 'Send the machine-learning URL and model to test.');
        return true;
      }
      const controller = new AbortController();
      const close = () => { if (!response.writableFinished) controller.abort(); };
      response.once('close', close);
      try {
        sendJson(response, 200, await embeddings.test({ url: body.url, model: body.model, signal: controller.signal }));
      } catch (error) {
        if (response.destroyed) return true;
        if (!(error instanceof EmbeddingServiceError)) throw error;
        const status = ['ml_invalid_url', 'ml_invalid_model'].includes(error.code) ? 400
          : error.code === 'ml_test_busy' ? 409 : 502;
        sendError(response, status, error.code, error.message);
      } finally { response.removeListener('close', close); }
      return true;
    }

    return false;
  };
}
