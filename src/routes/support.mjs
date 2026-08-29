import { sendJson } from '../http.mjs';
import { parseSupporterKey } from '../support/supporterKey.mjs';

// The supporter key lives in the settings store and never leaves the server;
// this endpoint exposes only the parsed, non-secret facts the admin pages need
// for the badge chip.
export function createSupportRoutes({ config }) {
  return async function handleSupportRoute(request, response, url) {
    if (!url.pathname.startsWith('/api/support')) {
      return false;
    }

    if (request.method === 'GET' && url.pathname === '/api/support/status') {
      const parsed = parseSupporterKey(config.supporterKey ?? '');
      sendJson(response, 200, {
        supporter: parsed ? { tier: parsed.tier, since: parsed.iat, keyId: parsed.id } : null,
      });
      return true;
    }

    return false;
  };
}
