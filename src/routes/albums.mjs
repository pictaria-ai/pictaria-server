import { readJsonBody, sendError, sendImage, sendJson, sendNoContent } from '../http.mjs';
import {
  DEFAULT_MAX_RESULTS,
  MAX_RESULTS_LIMIT,
  computeNextRunAt,
  createSmartAlbumJob,
  getSearchValidationError,
  hasFilters,
  normalizeFilters,
  previewSearch,
  runSmartAlbumJob,
  validateCreateRequest,
  validateJobPatch,
} from '../albums/smartAlbums.mjs';

export function createAlbumsRoutes({ immich, store, config, requireImmich, enrichRepo = null }) {
  const albumsConfig = config.albums;

  return async function handleAlbumsRoute(request, response, url) {
    if (!url.pathname.startsWith('/api/albums')) {
      return false;
    }

    if (request.method === 'GET' && url.pathname === '/api/albums/config') {
      sendJson(response, 200, {
        searchPageSize: albumsConfig.searchPageSize,
        maxSearchPages: albumsConfig.maxSearchPages,
        defaultMaxResults: DEFAULT_MAX_RESULTS,
      });
      return true;
    }

    if (request.method === 'GET' && url.pathname === '/api/albums/jobs') {
      sendJson(response, 200, { jobs: await store.listJobs() });
      return true;
    }

    if (request.method === 'GET' && url.pathname === '/api/albums/people') {
      if (!requireImmich(response)) {
        return true;
      }
      const name = String(url.searchParams.get('name') || '').trim();
      if (!name) {
        sendJson(response, 200, { people: [] });
        return true;
      }
      const people = await immich.searchPeople(name);
      sendJson(response, 200, {
        people: people.map((person) => ({
          id: person.id,
          name: person.name || 'Unnamed',
          isHidden: Boolean(person.isHidden),
          thumbnailPath: person.thumbnailPath || '',
        })),
      });
      return true;
    }

    if (request.method === 'GET' && url.pathname === '/api/albums/tags') {
      if (!requireImmich(response)) {
        return true;
      }
      const tags = await immich.listTags();
      sendJson(response, 200, {
        tags: tags
          .filter((tag) => tag?.id)
          .map((tag) => ({
            id: tag.id,
            name: tag.name || tag.value || 'Unnamed',
            value: tag.value || tag.name || 'Unnamed',
            color: tag.color || '',
            parentId: tag.parentId || null,
          })),
      });
      return true;
    }

    if (request.method === 'POST' && url.pathname === '/api/albums/preview') {
      if (!requireImmich(response)) {
        return true;
      }
      const body = await readJsonBody(request);
      const query = String(body?.query || '').trim();
      const bestOf = Boolean(body?.bestOf);
      const includeAllResults = Boolean(body?.includeAllResults);
      const maxResults = Number(body?.maxResults ?? DEFAULT_MAX_RESULTS);
      const filters = body?.filters || {};

      if (!query && !hasFilters(normalizeFilters(filters))) {
        sendError(response, 400, 'invalid_preview_request', 'Add a ranked search or at least one structured filter.');
        return true;
      }
      if (bestOf && !query) {
        sendError(response, 400, 'invalid_preview_request', 'Best of needs an Immich text search to corroborate.');
        return true;
      }
      const validationError = getSearchValidationError({ query, filters: normalizeFilters(filters) });
      if (validationError) {
        sendError(response, 400, 'invalid_preview_request', validationError);
        return true;
      }
      if (!includeAllResults && (!Number.isFinite(maxResults) || maxResults < 1 || maxResults > MAX_RESULTS_LIMIT)) {
        sendError(response, 400, 'invalid_preview_request', `Top photo limit must be between 1 and ${MAX_RESULTS_LIMIT}.`);
        return true;
      }

      sendJson(response, 200, await previewSearch({
        immich,
        config: albumsConfig,
        enrichRepo,
        query,
        filters,
        bestOf,
        includeAllResults,
        maxResults,
      }));
      return true;
    }

    if (request.method === 'POST' && url.pathname === '/api/albums/jobs') {
      if (!requireImmich(response)) {
        return true;
      }
      const validation = validateCreateRequest(await readJsonBody(request));
      if (validation.error) {
        sendError(response, 400, 'invalid_job_request', validation.error);
        return true;
      }
      const job = await createSmartAlbumJob({ immich, store, config: albumsConfig, enrichRepo, input: validation.value });
      sendJson(response, 201, { job });
      return true;
    }

    const thumbnailMatch = url.pathname.match(/^\/api\/albums\/assets\/([^/]+)\/thumbnail$/);
    if (request.method === 'GET' && thumbnailMatch) {
      if (!requireImmich(response)) {
        return true;
      }
      const size = url.searchParams.get('size') || 'thumbnail';
      const image = await immich.getAssetThumbnail(decodeURIComponent(thumbnailMatch[1]), size);
      sendImage(response, 200, image.data);
      return true;
    }

    const jobRunMatch = url.pathname.match(/^\/api\/albums\/jobs\/([^/]+)\/run$/);
    if (request.method === 'POST' && jobRunMatch) {
      if (!requireImmich(response)) {
        return true;
      }
      let job;
      try {
        job = await runSmartAlbumJob({
          immich,
          store,
          config: albumsConfig,
          enrichRepo,
          jobId: decodeURIComponent(jobRunMatch[1]),
        });
      } catch (error) {
        if (error?.code === 'job_running') {
          sendError(response, 409, 'job_running', 'This Smart Album job is already running.');
          return true;
        }
        throw error;
      }
      if (!job) {
        sendError(response, 404, 'job_not_found', 'Smart album job not found.');
        return true;
      }
      sendJson(response, 200, { job });
      return true;
    }

    const jobMatch = url.pathname.match(/^\/api\/albums\/jobs\/([^/]+)$/);
    if (jobMatch) {
      const jobId = decodeURIComponent(jobMatch[1]);

      if (request.method === 'PATCH') {
        const validation = validateJobPatch(await readJsonBody(request));
        if (validation.error) {
          sendError(response, 400, 'invalid_job_patch', validation.error);
          return true;
        }
        const confirmsSchedule = validation.value.enabled === true;
        const job = await store.updateJob(jobId, (current) => {
          const patch = { ...validation.value };
          const smart = Object.hasOwn(patch, 'smart') ? patch.smart : current.smart;
          const enabled = Object.hasOwn(patch, 'enabled') ? patch.enabled : current.enabled;
          const intervalDays = Object.hasOwn(patch, 'intervalDays') ? patch.intervalDays : current.intervalDays;
          const maxResults = Object.hasOwn(patch, 'maxResults') ? patch.maxResults : current.maxResults;
          const includeAllResults = Object.hasOwn(patch, 'includeAllResults')
            ? patch.includeAllResults
            : current.includeAllResults;
          const intervalChanged = Object.hasOwn(patch, 'intervalDays') && patch.intervalDays !== current.intervalDays;

          return {
            ...patch,
            includeAllResults,
            maxResults,
            enabled: Boolean(smart && enabled),
            nextRunAt: smart && enabled && intervalDays
              ? (!intervalChanged && current.nextRunAt
                  ? current.nextRunAt
                  : nextRunAtFromLastRun(current.lastRunAt, intervalDays))
              : null,
          };
        }, { confirmSchedule: confirmsSchedule });
        if (!job) {
          sendError(response, 404, 'job_not_found', 'Smart album job not found.');
          return true;
        }
        sendJson(response, 200, { job });
        return true;
      }

      if (request.method === 'DELETE') {
        const deleted = await store.deleteJob(jobId);
        if (!deleted) {
          sendError(response, 404, 'job_not_found', 'Smart album job not found.');
          return true;
        }
        sendNoContent(response);
        return true;
      }
    }

    return false;
  };
}

// Reschedule from the last run so shortening an interval takes effect without
// waiting out the previously computed date; never schedules into the past.
function nextRunAtFromLastRun(lastRunAt, intervalDays) {
  const base = lastRunAt ? new Date(lastRunAt) : new Date();
  const candidate = computeNextRunAt(base, intervalDays);
  return (candidate.getTime() < Date.now() ? new Date() : candidate).toISOString();
}
