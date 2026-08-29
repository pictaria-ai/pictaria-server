import { readJsonBody, sendError, sendJson } from '../http.mjs';
import { SettingsError } from '../settings.mjs';

export function createSettingsRoutes({ settingsStore }) {
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
