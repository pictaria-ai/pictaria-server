import { sendError, sendJson } from '../http.mjs';
import {
  ActivityQueryError,
  activityExportCsv,
  activityExportJson,
} from '../activity/history.mjs';

export function createActivityRoutes({ activityHistory }) {
  return async function handleActivityRoute(request, response, url) {
    if (!url.pathname.startsWith('/api/activity')) {
      return false;
    }

    try {
      if (request.method === 'GET' && url.pathname === '/api/activity') {
        sendJson(response, 200, activityHistory.list(Object.fromEntries(url.searchParams)));
        return true;
      }

      if (request.method === 'GET' && url.pathname === '/api/activity/export') {
        const format = String(url.searchParams.get('format') ?? 'json').toLowerCase();
        if (format !== 'json' && format !== 'csv') {
          throw new ActivityQueryError('Export format must be json or csv.');
        }
        const result = activityHistory.export(Object.fromEntries(url.searchParams));
        const payload = format === 'csv' ? activityExportCsv(result) : activityExportJson(result);
        const stamp = result.generatedAt.slice(0, 10);
        response.writeHead(200, {
          'Cache-Control': 'no-store',
          'Content-Disposition': `attachment; filename="pictaria-activity-${stamp}.${format}"`,
          'Content-Length': Buffer.byteLength(payload),
          'Content-Type': format === 'csv'
            ? 'text/csv; charset=utf-8'
            : 'application/json; charset=utf-8',
        });
        response.end(payload);
        return true;
      }
    } catch (error) {
      if (error instanceof ActivityQueryError) {
        sendError(response, 400, 'invalid_activity_query', error.message);
        return true;
      }
      throw error;
    }

    return false;
  };
}
