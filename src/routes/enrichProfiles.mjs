import { readJsonBody, sendError, sendJson } from '../http.mjs';
import { ProfileError } from '../enrich/profiles.mjs';

export function createEnrichProfileRoutes({ profiles }) {
  return async (request, response, url) => {
    const base = '/api/enrich/profiles';
    const item = url.pathname.match(/^\/api\/enrich\/profiles\/([a-f0-9-]+)(?:\/(default|archive))?$/);
    const queued = url.pathname.match(/^\/api\/enrich\/queue\/(\d+)\/profile$/);
    if (url.pathname !== base && url.pathname !== `${base}/builtin` && url.pathname !== `${base}/validate` && url.pathname !== `${base}/active` && !item && !queued) return false;
    try {
      if (request.method === 'GET' && url.pathname === base) {
        const items = profiles.list();
        sendJson(response, 200, { profiles: items, activeProfileId: items.find(p => p.isActive)?.id, activeProfile: items.find(p => p.isActive) });
      } else if (request.method === 'GET' && url.pathname === `${base}/builtin`) {
        sendJson(response, 200, profiles.builtin());
      } else if (request.method === 'GET' && item && !item[2]) {
        sendJson(response, 200, profiles.get(item[1]));
      } else if (request.method === 'POST' && url.pathname === `${base}/validate`) {
        profiles.validate(await readJsonBody(request));
        sendJson(response, 200, { valid: true });
      } else if (request.method === 'POST' && url.pathname === base) {
        sendJson(response, 201, profiles.create(await readJsonBody(request)));
      } else if (request.method === 'PATCH' && item && !item[2]) {
        sendJson(response, 200, profiles.update(item[1], await readJsonBody(request)));
      } else if (request.method === 'POST' && url.pathname === `${base}/active`) {
        const body = await readJsonBody(request);
        sendJson(response, 200, profiles.setActive(body?.profileId, body?.expectedActiveRevisionId));
      } else if (request.method === 'POST' && item?.[2] === 'default') {
        throw new ProfileError('Select the active profile on Enrich. Separate default profiles are no longer supported.', 410);
      } else if (request.method === 'POST' && item?.[2] === 'archive') {
        const body = await readJsonBody(request);
        sendJson(response, 200, profiles.archive(item[1], body?.archived));
      } else if (request.method === 'PATCH' && queued) {
        throw new ProfileError('Queued photos use the active profile when started. Per-item profiles are no longer supported.', 410);
      } else { return false; }
    } catch (error) {
      if (!(error instanceof ProfileError)) throw error;
      sendError(response, error.status, error.code, error.message);
    }
    return true;
  };
}
