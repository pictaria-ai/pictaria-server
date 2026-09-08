import { readJsonBody, sendError, sendJson } from '../http.mjs';
import { ProfileError } from '../enrich/profiles.mjs';

export function createEnrichProfileRoutes({ profiles, repo, protectedQueueIds, queuePagePayload }) {
  return async (request, response, url) => {
    const base = '/api/enrich/profiles';
    const item = url.pathname.match(/^\/api\/enrich\/profiles\/([a-f0-9-]+)(?:\/(default|archive))?$/);
    const queued = url.pathname.match(/^\/api\/enrich\/queue\/(\d+)\/profile$/);
    if (url.pathname !== base && url.pathname !== `${base}/builtin` && url.pathname !== `${base}/validate` && !item && !queued) return false;
    try {
      if (request.method === 'GET' && url.pathname === base) {
        const items = profiles.list();
        sendJson(response, 200, { profiles: items, defaultProfileId: items.find(p => p.isDefault)?.id });
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
      } else if (request.method === 'POST' && item?.[2] === 'default') {
        await readJsonBody(request);
        sendJson(response, 200, profiles.setDefault(item[1]));
      } else if (request.method === 'POST' && item?.[2] === 'archive') {
        const body = await readJsonBody(request);
        sendJson(response, 200, profiles.archive(item[1], body?.archived));
      } else if (request.method === 'PATCH' && queued) {
        const body = await readJsonBody(request);
        const id = Number(queued[1]);
        if (protectedQueueIds().includes(id)) throw new ProfileError('Cancel the active run or Run all chain before changing this queued profile.', 409);
        const current = repo.queueGet(id);
        if (!current) throw new ProfileError('That queued item no longer exists.', 404);
        if (body?.expectedRevisionId !== current.profileRevisionId) throw new ProfileError('This queued profile changed. Reload the queue before replacing it.', 409);
        if (typeof body?.profileId !== 'string') throw new ProfileError('Choose a profile for the queued item.');
        const selected = profiles.resolve({ profileId: body.profileId });
        repo.db.prepare('UPDATE enrich_queue SET profile_revision_id = ? WHERE id = ?').run(selected.revisionId, id);
        sendJson(response, 200, queuePagePayload());
      } else { return false; }
    } catch (error) {
      if (!(error instanceof ProfileError)) throw error;
      sendError(response, error.status, error.code, error.message);
    }
    return true;
  };
}
