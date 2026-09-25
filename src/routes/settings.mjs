import { readJsonBody, sendError, sendJson } from '../http.mjs';
import { SettingsError } from '../settings.mjs';

export function createSettingsRoutes({ settingsStore, profiles = null, aiConnections = null }) {
  return async function handleSettingsRoute(request, response, url) {
    if (aiConnections && url.pathname === '/api/ai/connections' && request.method === 'GET') {
      sendJson(response, 200, { connections: aiConnections.describe() });
      return true;
    }
    if (aiConnections && url.pathname === '/api/ai/connections/verify' && request.method === 'POST') {
      const body = await readJsonBody(request);
      if (!body || !aiConnections.isTarget(body.target) || Object.keys(body).some(key => key !== 'target')) {
        sendError(response, 400, 'invalid_connection', 'Choose a saved AI connection.');
      } else {
        const result = await aiConnections.verify(body.target);
        sendJson(response, 200, { ...result, connections: aiConnections.describe() });
      }
      return true;
    }
    if (url.pathname !== '/api/settings') {
      return false;
    }

    if (request.method === 'GET') {
      sendJson(response, 200, settingsStore.describe());
      return true;
    }

    if (request.method === 'PATCH') {
      const patch = await readJsonBody(request);
      try {
        if (profiles && patch?.enrich && ['systemPrompt', 'userTemplate'].some(key => Object.hasOwn(patch.enrich, key))) {
          throw new SettingsError('Enrich prompts are now managed in named profiles in Settings → Enrichment profiles.');
        }
        sendJson(response, 200, settingsStore.update(patch));
      } catch (error) {
        if (error instanceof SettingsError) {
          sendError(response, 400, 'invalid_settings', error.message);
          return true;
        }
        throw error;
      }
      return true;
    }

    return false;
  };
}
