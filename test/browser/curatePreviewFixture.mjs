import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Repository } from '../../src/enrich/repository.mjs';
import { bootServer } from './harness.mjs';

export async function curatePreviewFixture({ stackSize = 52, singles = 52 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'curate-preview-'));
  const repo = new Repository(join(dir, 'enrichment.sqlite'));
  repo.initSchema();
  const assets = [],
    tags = new Map(),
    photoTags = new Map();
  const detailReads = [], detailResponses = new Map();
  const similarityReads = [], similarityResponses = new Map();
  const id = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
  function add(n, seconds, name) {
    const asset = {
      id: id(n),
      originalPath: `/synthetic/${name}.jpg`,
      type: 'IMAGE',
      fileCreatedAt: new Date(Date.UTC(2026, 0, 1) + seconds * 1000).toISOString(),
      people: [],
      isTrashed: false,
      isOffline: false,
    };
    assets.push(asset);
    photoTags.set(asset.id, new Set());
    repo.upsertAsset(asset);
    repo.reviewListAdd([asset.id], 'synthetic');
    return asset.id;
  }
  for (let n = 1; n <= stackSize; n++) add(n, n, n === 1 ? 'target-portrait' : `portrait-${n}`);
  for (let n = 1; n <= singles; n++) add(1000 + n, n * 600, `single-${n}`);
  const contextId = add(999, -2, 'already-kept');
  repo.setManualFrameTags({ assetIds: [contextId], addTags: ['frame/eligible'], removeTags: [], action: 'approve' });
  photoTags.get(contextId).add('frame/eligible');
  tags.set('frame/eligible', 'frame/eligible');
  const fake = createServer(async (request, response) => {
    let text = '';
    for await (const c of request) text += c;
    const body = text ? JSON.parse(text) : {};
    const path = new URL(request.url, 'http://fake').pathname;
    const json = (data, status = 200) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(data));
    };
    if (path.endsWith('/thumbnail')) {
      response.writeHead(200, { 'content-type': 'image/png' });
      return response.end(
        Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==',
          'base64',
        ),
      );
    }
    if (path.startsWith('/api/assets/')) {
      if (request.method === 'GET') detailReads.push(path.split('/')[3]);
      const asset = assets.find((a) => a.id === path.split('/')[3]);
      const override = await detailResponses.get(asset?.id)?.(asset);
      if (override) return json(override.body, override.status);
      return asset
        ? json({ ...asset, tags: [...photoTags.get(asset.id)].map((value) => ({ id: value, value })) })
        : json({}, 404);
    }
    if (path === '/api/tags') {
      if (request.method === 'PUT') body.tags.forEach((value) => tags.set(value, value));
      return json([...tags].map(([id, value]) => ({ id, value })));
    }
    if (path === '/api/tags/assets') {
      for (const id of body.assetIds) for (const tag of body.tagIds) photoTags.get(id)?.add(tag);
      return json({ count: body.assetIds.length });
    }
    if (path.startsWith('/api/tags/') && path.endsWith('/assets')) {
      const tag = decodeURIComponent(path.split('/')[3]);
      for (const id of body.ids) photoTags.get(id)?.delete(tag);
      return json(body.ids.map((id) => ({ id, success: true })));
    }
    if (path === '/api/search/metadata')
      return json({ assets: { items: assets, nextPage: null, total: assets.length } });
    if (path === '/api/search/smart') {
      similarityReads.push(body);
      const override = await similarityResponses.get(body.queryAssetId)?.(body);
      return override ? json(override.body, override.status) : json({ assets: { items: assets.slice(0, body.size) } });
    }
    if (path === '/api/server/version') return json({ major: 3, minor: 2, patch: 0 });
    if (path === '/api/people') return json({ people: [], total: 0 });
    if (path === '/api/search/statistics') return json({ total: assets.length });
    json({});
  });
  await new Promise((resolve) => fake.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${fake.address().port}`;
  let server;
  try {
    server = await bootServer(dir, {
      env: {
        IMMICH_BASE_URL: base,
        IMMICH_PUBLIC_URL: base,
        IMMICH_API_KEY: 'synthetic',
        CURATE_REFEREE_ENABLED: 'false',
      },
    });
  } catch (error) {
    repo.close();
    fake.closeAllConnections();
    await new Promise((resolve) => fake.close(resolve));
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
  return {
    ...server,
    repo,
    id,
    add,
    assets,
    contextId,
    photoTags,
    detailReads,
    detailResponses,
    similarityReads,
    similarityResponses,
    dir,
    async stop() {
      await server.stop();
      repo.close();
      fake.closeAllConnections();
      await new Promise((resolve) => fake.close(resolve));
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
