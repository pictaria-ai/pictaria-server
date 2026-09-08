import { readJsonBody, sendError, sendJson } from '../http.mjs';
import { SettingsError } from '../settings.mjs';

export function createSettingsRoutes({ settingsStore, profiles = null }) {
  return async function handleSettingsRoute(request, response, url) {
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
          throw new SettingsError('Enrich prompts are now managed in named profiles on the Enrich page.');
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
