import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import { fetchWithTimeout } from '../src/fetchWithTimeout.mjs';
import { ImmichClient } from '../src/immich.mjs';

async function listen(handler) {
  const server = createServer(handler);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  return { server, baseUrl: `http://127.0.0.1:${port}` };
}

async function close(server) {
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
}

test('shared outbound fetch boundaries reject redirects without a second request', async (t) => {
  let redirectedRequests = 0;
  let directRequests = 0;
  const direct = await listen((request, response) => {
    directRequests += 1;
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ ok: true }));
  });
  const redirect = await listen((request, response) => {
    redirectedRequests += 1;
    response.writeHead(307, { Location: `${direct.baseUrl}/redirect-target` });
    response.end();
  });
  t.after(async () => {
    await close(redirect.server);
    await close(direct.server);
  });

  await assert.rejects(
    () => fetchWithTimeout(`${redirect.baseUrl}/provider`, {
      method: 'POST',
      headers: { 'x-api-key': 'provider-secret' },
      body: JSON.stringify({ private: 'provider-body' }),
    }),
    /redirect/i,
  );

  const immich = new ImmichClient({
    baseUrl: redirect.baseUrl,
    apiKey: 'immich-secret',
  });
  await assert.rejects(
    () => immich.requestJson('/asset', { method: 'POST', body: { private: 'immich-body' } }),
    (error) => error.name === 'ImmichApiError' && /redirect/i.test(error.message),
  );

  assert.equal(redirectedRequests, 2);
  assert.equal(directRequests, 0, 'neither body nor credential reaches the redirect target');

  const providerResponse = await fetchWithTimeout(`${direct.baseUrl}/provider`);
  assert.deepEqual(await providerResponse.json(), { ok: true });

  const directImmich = new ImmichClient({ baseUrl: direct.baseUrl, apiKey: 'immich-secret' });
  assert.deepEqual(await directImmich.requestJson('/asset'), { ok: true });
  assert.equal(directRequests, 2, 'final configured URLs still work at both boundaries');
});
