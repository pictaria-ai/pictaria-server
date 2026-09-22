import { readJsonBody, sendError, sendJson, HttpBodyError } from '../http.mjs';
import { CurateError } from '../curate/contracts.mjs';

// Production foundation for PIC-368/369. The existing /api/review/assets UI
// contract is intentionally unchanged until complete keeper-set actions land.
export function createCurateRoutes({ curate, review = null }) {
  return async (request, response, url) => {
    if (!url.pathname.startsWith('/api/review/curate/')) return false;
    response.setHeader('Cache-Control', 'no-store');
    try {
      const path = url.pathname.slice('/api/review/curate/'.length);
      let result;
      if (request.method === 'POST' && path === 'lab/views') {
        result = await curate.lab.open(await readObject(request, { maxBytes: 4096 }));
      } else if (request.method === 'GET' && path === 'lab/groups') {
        result = curate.lab.page(url.searchParams.get('viewId'), Number(url.searchParams.get('offset') ?? 0));
      } else if (request.method === 'GET' && path === 'lab/comparison') {
        result = curate.lab.comparison(url.searchParams.get('viewId'), Number(url.searchParams.get('groupId') ?? -1));
      } else if (request.method === 'POST' && path === 'lab/ranks/plan') {
        result = curate.lab.ranks.plan(await readObject(request, { maxBytes: 8192 }));
      } else if (request.method === 'POST' && path === 'lab/ranks/run') {
        const body = await readObject(request, { maxBytes: 8192 });
        const controller = new AbortController();
        const close = () => { if (!response.writableFinished) controller.abort(); };
        response.once('close', close);
        try {
          await curate.lab.ranks.run(body, { signal: controller.signal, emit: async event => {
            if (response.destroyed) { controller.abort(); controller.signal.throwIfAborted(); }
            if (!response.headersSent) response.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'X-Accel-Buffering': 'no' });
            // <=40 rows of <=40 ranks: bounded output even for a slow reader.
            response.write(JSON.stringify(event) + '\n');
          } });
          response.end();
        } catch (error) {
          if (response.destroyed) return true;
          if (!response.headersSent) throw error;
          response.end(JSON.stringify({ type: 'error', code: error instanceof CurateError ? error.code : 'lab_rank_interrupted',
            message: error instanceof CurateError ? error.message : 'Rank comparison interrupted. Completed rows are retained; no requests were retried.' }) + '\n');
        } finally { response.removeListener('close', close); }
        return true;
      } else if (request.method === 'POST' && ['lab/recognition', 'lab/ranking'].includes(path)) {
        const body = await readObject(request, { maxBytes: 4096 });
        const controller = new AbortController();
        const close = () => { if (!response.writableFinished) controller.abort(); };
        response.once('close', close);
        try {
          if (response.destroyed) return true;
          result = path === 'lab/ranking'
            ? await curate.lab.similarityRanking(body.viewId, body.groupId, { signal: controller.signal })
            : await curate.lab.refreshRecognition(body.viewId, body.groupId, { signal: controller.signal });
          if (response.destroyed) return true;
        } finally { response.removeListener('close', close); }
      } else if (request.method === 'GET' && path === 'groups') {
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
              sort: url.searchParams.get('sort') ?? 'oldest',
            });
      } else if (request.method === 'POST' && path === 'groups/status') {
        const body = await readObject(request, { maxBytes: 12 * 1024 });
        result = curate.page(body.viewId, body.offset ?? 0, body.limit ?? 50, body);
      } else if (request.method === 'POST' && path === 'groups') {
        const body = await readObject(request, { maxBytes: 4096 });
        result = await curate.openView({
          kind: body.kind,
          search: body.search,
          sort: body.sort,
          replacesViewId: body.replacesViewId,
        });
      } else if (request.method === 'POST' && path === 'comparisons') {
        const body = await readObject(request, { maxBytes: 4096 });
        await curate.refresh();
        result = curate.comparison(body.viewId, body.groupId);
      } else if (request.method === 'POST' && path === 'comparisons/photos') {
        const body = await readObject(request, { maxBytes: 4096 });
        result = curate.comparisonPhotos(body.comparisonId, body.offset ?? 0, body.limit ?? 50);
      } else if (request.method === 'POST' && path === 'operations') {
        const body = await readObject(request, { maxBytes: 4096 });
        result = await curate.issueDecision(body.comparisonId, body.mode ?? 'manual');
      } else if (request.method === 'POST' && path === 'operations/apply') {
        const body = await readObject(request, { maxBytes: 256 * 1024 });
        result = await curate.applyDecision(body);
        review?.wakeSyncWorker();
      } else if (request.method === 'GET' && path === 'operations/status') {
        result = curate.repo.decisions.status(url.searchParams.get('operationId'));
      } else if (request.method === 'POST' && path === 'operations/retry') {
        const body = await readObject(request, { maxBytes: 4096 });
        result = curate.repo.decisions.retry(body.operationId);
        review?.wakeSyncWorker();
      } else if (request.method === 'GET' && path === 'separations') {
        if (url.searchParams.has('id')) result = { correction: curate.store.correction(url.searchParams.get('id')) };
        else result = curate.store.corrections(Number(url.searchParams.get('offset') ?? 0), Number(url.searchParams.get('limit') ?? 50));
      } else if (request.method === 'POST' && path === 'metadata/refresh') {
        const body = await readObject(request, { maxBytes: 4096 });
        const comparison = curate.store.getLease(body.comparisonId, 'comparison');
        const offset = body.offset ?? 0;
        if (!Number.isSafeInteger(offset) || offset < 0)
          throw new CurateError('Invalid metadata page.', 'invalid_curate_query', 400);
        result = curate.requestMetadataRefresh([...comparison.ids, ...comparison.contextIds].slice(offset, offset + 500));
      } else if (request.method === 'POST' && path === 'separations') {
        const body = await readObject(request, { maxBytes: 5 * 1024 * 1024 });
        result = await curate.separate(body.comparisonId, body.partitions, body.action ?? null);
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
      if (error instanceof CurateError || error instanceof HttpBodyError || error?.name === 'AssetBatchError' || error?.code === 'review_sync_backlog_full') {
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
