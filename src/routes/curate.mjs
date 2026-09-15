import { readJsonBody, sendError, sendJson, HttpBodyError } from '../http.mjs';
import { CurateError } from '../curate/contracts.mjs';

// Production foundation for PIC-368/369. The existing /api/review/assets UI
// contract is intentionally unchanged until complete keeper-set actions land.
export function createCurateRoutes({ curate }) {
  return async (request, response, url) => {
    if (!url.pathname.startsWith('/api/review/curate/')) return false;
    response.setHeader('Cache-Control', 'no-store');
    try {
      const path = url.pathname.slice('/api/review/curate/'.length);
      let result;
      if (request.method === 'GET' && path === 'groups') {
        if (url.searchParams.has('replacesViewId'))
          throw new CurateError('Use POST to replace a Curate view.', 'invalid_curate_query', 400);
        result = url.searchParams.has('viewId')
          ? curate.page(
              url.searchParams.get('viewId'),
              Number(url.searchParams.get('offset') ?? 0),
              Number(url.searchParams.get('limit') ?? 50),
            )
          : await curate.openView({
              kind: url.searchParams.get('kind') ?? 'all',
              search: url.searchParams.get('q') ?? '',
            });
      } else if (request.method === 'POST' && path === 'groups') {
        const body = await readObject(request, { maxBytes: 4096 });
        result = await curate.openView({
          kind: body.kind,
          search: body.search,
          replacesViewId: body.replacesViewId,
        });
      } else if (request.method === 'POST' && path === 'comparisons') {
        const body = await readObject(request, { maxBytes: 4096 });
        await curate.refresh();
        result = curate.comparison(body.viewId, body.groupId);
      } else if (request.method === 'POST' && path === 'comparisons/photos') {
        const body = await readObject(request, { maxBytes: 4096 });
        result = curate.comparisonPhotos(body.comparisonId, body.offset ?? 0, body.limit ?? 50);
      } else if (request.method === 'POST' && path === 'separations') {
        const body = await readObject(request, { maxBytes: 5 * 1024 * 1024 });
        result = await curate.separate(body.comparisonId, body.partitions);
      } else if (request.method === 'POST' && path === 'separations/reset') {
        const body = await readObject(request, { maxBytes: 4096 });
        if (
          typeof body.id !== 'string' ||
          !Number.isSafeInteger(body.revision) ||
          typeof (body.undo ?? false) !== 'boolean'
        )
          throw new CurateError('Invalid correction reset.', 'invalid_curate_query', 400);
        result = await curate.reset(body.id, body.revision, { undo: body.undo === true });
      } else if (request.method === 'DELETE' && path === 'leases') {
        const body = await readObject(request, { maxBytes: 4096 });
        if (typeof body.id !== 'string') throw new CurateError('Invalid view ID.', 'invalid_curate_query', 400);
        curate.store.releaseLease(body.id);
        result = { ok: true };
      } else return false;
      sendJson(response, 200, result);
      return true;
    } catch (error) {
      if (error instanceof CurateError || error instanceof HttpBodyError) {
        sendError(response, error.status ?? 400, error.code, error.message);
        return true;
      }
      throw error;
    }
  };
}

async function readObject(request, options) {
  const body = await readJsonBody(request, options);
  if (!body || typeof body !== 'object' || Array.isArray(body))
    throw new CurateError('A JSON object is required.', 'invalid_curate_query', 400);
  return body;
}
