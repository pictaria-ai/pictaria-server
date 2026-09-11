// Read-only validation of the production Smart Album metadata reader.
// No duplicate traversal implementation: remove this probe with legacy support.
import { readFile } from 'node:fs/promises';
import { ImmichClient } from '../../src/immich.mjs';
import { readMetadataAssets } from '../../src/albums/metadataSearch.mjs';

async function main() {
  const args = process.argv.slice(2);
  if (args.length && !(args.length === 2 && args[0] === '--filters-file')) throw new Error('Invalid arguments.');
  const url = new URL(process.env.IMMICH_BASE_URL);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('Invalid base URL.');
  }
  const apiKey = process.env.IMMICH_API_KEY;
  if (!apiKey) throw new Error('Missing API key.');
  const counts = { metadataRequests: 0, statisticsRequests: 0, versionRequests: 0, tagRequests: 0 };
  const immich = new ImmichClient({ baseUrl: url.href, apiKey, timeoutMs: 30_000,
    fetchImpl: async (target, options) => {
      const parsed = new URL(target);
      const method = options.method || 'GET';
      const path = parsed.pathname.replace(/\/$/, '');
      if (parsed.origin !== url.origin || ![
        'GET /api/server/version', 'GET /api/tags',
        'POST /api/search/metadata', 'POST /api/search/statistics',
      ].includes(`${method} ${path}`)) throw new Error('Read-only route restriction.');
      if (path.endsWith('/metadata')) counts.metadataRequests++;
      if (path.endsWith('/statistics')) counts.statisticsRequests++;
      if (path.endsWith('/version')) counts.versionRequests++;
      if (path.endsWith('/tags')) counts.tagRequests++;
      return fetch(target, { ...options, redirect: 'error' });
    },
  });
  let filters;
  if (args.length) {
    filters = JSON.parse(await readFile(args[1], 'utf8'));
    const allowed = new Set(['tagIds', 'personIds', 'albumIds', 'visibility',
      'takenAfter', 'takenBefore', 'city', 'state', 'country', 'make', 'model', 'isFavorite']);
    if (!filters || Array.isArray(filters) || typeof filters !== 'object' || Object.keys(filters).some(k => !allowed.has(k))) {
      throw new Error('Invalid filters.');
    }
  } else {
    const tags = await immich.listTags({ strict: true });
    const matches = tags.filter(tag => tag.value === 'frame/eligible');
    if (matches.length !== 1 || !matches[0].id) throw new Error('Cannot uniquely resolve frame/eligible.');
    filters = { tagIds: [matches[0].id], visibility: 'timeline' };
  }
  const started = performance.now();
  const result = await readMetadataAssets({ immich, config: { searchPageSize: 1000, maxSearchPages: 25 }, filters });
  console.log(JSON.stringify({ matched: result.assets.length, complete: result.complete,
    truncated: result.truncated, ...counts, elapsedSeconds: Math.round((performance.now() - started) / 100) / 10,
    snapshotGuaranteed: false, mutations: 0 }));
}

main().catch(error => {
  // Deliberately suppress bodies, filter values, hostnames and asset details.
  console.error(JSON.stringify({ complete: false, errorType: error.name, status: error.status ?? null, mutations: 0 }));
  process.exitCode = 1;
});
