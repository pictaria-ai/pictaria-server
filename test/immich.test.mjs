import test from 'node:test';
import assert from 'node:assert/strict';

import { ImmichClient, extractAssets } from '../src/immich.mjs';

class FakeImmichClient extends ImmichClient {
  constructor() {
    super({ baseUrl: 'http://immich.test', apiKey: 'test-key' });
    this.requests = [];
  }

  async searchMetadata(body) {
    this.requests.push(body);
    const page = Number(body.page);
    const size = Number(body.size);
    const start = (page - 1) * size;
    const items = Array.from({ length: size }, (_, index) => ({ id: `asset-${start + index}` }));
    const nextPage = page < 5 ? page + 1 : null;
    return { assets: { items, nextPage } };
  }
}

test('listImageAssets supports offset', async () => {
  const client = new FakeImmichClient();

  const assets = await client.listImageAssets({ limit: 5, pageSize: 10, offset: 23 });

  assert.deepEqual(
    assets.map((asset) => asset.id),
    ['asset-23', 'asset-24', 'asset-25', 'asset-26', 'asset-27'],
  );
  assert.equal(client.requests[0].page, 3);
  assert.equal(client.requests[0].size, 10);
});

test('listImageAssets can continue after the offset page', async () => {
  const client = new FakeImmichClient();

  const assets = await client.listImageAssets({ limit: 5, pageSize: 10, offset: 28 });

  assert.deepEqual(
    assets.map((asset) => asset.id),
    ['asset-28', 'asset-29', 'asset-30', 'asset-31', 'asset-32'],
  );
  assert.deepEqual(client.requests.map((request) => request.page), [3, 4]);
});

test('listImageAssets permits short progressing pages within its hard request budget', async () => {
  const client = new FakeImmichClient();
  client.searchMetadata = async (body) => {
    client.requests.push(body);
    return {
      assets: {
        items: [{ id: `asset-${body.page}` }],
        nextPage: body.page < 3 ? body.page + 1 : null,
      },
    };
  };

  const assets = await client.listImageAssets({ limit: 3, pageSize: 100 });

  assert.deepEqual(assets.map((asset) => asset.id), ['asset-1', 'asset-2', 'asset-3']);
  assert.deepEqual(client.requests.map((request) => request.page), [1, 2, 3]);
});

test('listImageAssets returns a short terminal result without requesting a null page', async () => {
  const client = new FakeImmichClient();
  client.searchMetadata = async (body) => {
    client.requests.push(body);
    assert.notEqual(body.page, null);
    return { assets: { items: [{ id: 'only-asset' }], nextPage: null } };
  };

  const assets = await client.listImageAssets({ limit: 3 });

  assert.deepEqual(assets.map((asset) => asset.id), ['only-asset']);
  assert.equal(client.requests.length, 1);
});

test('listImageAssets pins timeline visibility for Immich v3', async () => {
  const client = new FakeImmichClient();

  await client.listImageAssets({ limit: 1 });

  assert.equal(client.requests[0].visibility, 'timeline');
  assert.equal(client.requests[0].type, 'IMAGE');
});

test('listImageAssets rejects malformed, oversized, and non-progressing pages', async () => {
  const malformed = new FakeImmichClient();
  malformed.searchMetadata = async () => ({ assets: { items: null, nextPage: null } });
  await assert.rejects(
    () => malformed.listImageAssets({ limit: 1 }),
    /invalid or oversized item page/,
  );

  const oversized = new FakeImmichClient();
  oversized.searchMetadata = async () => ({
    assets: { items: [{ id: 'a' }, { id: 'b' }, { id: 'c' }], nextPage: null },
  });
  await assert.rejects(
    () => oversized.listImageAssets({ limit: 1, pageSize: 2 }),
    /invalid or oversized item page/,
  );

  const repeated = new FakeImmichClient();
  repeated.searchMetadata = async () => ({ assets: { items: [{ id: 'a' }], nextPage: 1 } });
  await assert.rejects(
    () => repeated.listImageAssets({ limit: 2, pageSize: 1 }),
    /non-progressing next page/,
  );
});

test('listImageAssets honors cancellation between pages', async () => {
  const client = new FakeImmichClient();
  let checks = 0;
  const assets = await client.listImageAssets({
    limit: 3,
    pageSize: 1,
    shouldStop: () => checks++ > 0,
  });

  assert.deepEqual(assets.map((asset) => asset.id), ['asset-0']);
  assert.deepEqual(client.requests.map((request) => request.page), [1]);
});

// Real fetch responses expose a body stream; the client must read it bounded
// so a runaway Immich body can never exhaust process memory.
function streamFetch(chunks, { status = 200, headers = {} } = {}) {
  return async () =>
    new Response(
      new ReadableStream({
        start(controller) {
          for (const chunk of chunks) {
            controller.enqueue(typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk);
          }
          controller.close();
        },
      }),
      { status, headers: { 'content-type': 'image/jpeg', ...headers } },
    );
}

function streamClient(chunks, options) {
  return new ImmichClient({
    baseUrl: 'http://immich.test',
    apiKey: 'test-key',
    fetchImpl: streamFetch(chunks, options),
  });
}

test('requestBytes buffers a streamed body within the cap', async () => {
  const result = await streamClient(['ab', 'cd']).requestBytes('/assets/a/thumbnail');

  assert.equal(result.data.toString('utf8'), 'abcd');
  assert.equal(result.contentType, 'image/jpeg');
});

test('Immich appends its API path structurally and rejects query-bearing bases before fetch', async () => {
  const calls = [];
  const client = new ImmichClient({
    baseUrl: 'http://immich.test/custom',
    apiKey: 'test-key',
    fetchImpl: async (url) => {
      calls.push(String(url));
      return new Response('{"id":"asset-1"}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });
  await client.getAsset('asset-1');
  assert.deepEqual(calls, ['http://immich.test/custom/api/assets/asset-1']);

  assert.throws(
    () => new ImmichClient({
      baseUrl: 'http://internal.invalid/chosen?',
      apiKey: 'replacement',
      fetchImpl: async () => {
        calls.push('unexpected');
      },
    }),
    /without credentials, a query, or a fragment/,
  );
  assert.equal(calls.includes('unexpected'), false);
});

test('requestBytes aborts a streamed body that crosses its byte cap', async () => {
  await assert.rejects(
    () => streamClient(['ab', 'cd']).requestBytes('/assets/a/thumbnail', { maxBytes: 3 }),
    (error) => error.name === 'ResponseTooLargeError',
  );
});

test('a declared oversize body rejects up front; originals get the higher cap', async () => {
  // 40MB declared: past the 32MB thumbnail/JSON default, within the 64MB
  // original-class ceiling.
  const declared = { 'content-length': String(40 * 1024 * 1024) };

  await assert.rejects(
    () => streamClient(['x'], { headers: declared }).getAssetThumbnail('a'),
    (error) => error.name === 'ResponseTooLargeError',
  );

  const original = await streamClient(['x'], { headers: declared }).getAssetOriginal('a');
  assert.equal(original.data.toString('utf8'), 'x');
});

test('getAssetOriginal honors a caller-supplied byte cap', async () => {
  await assert.rejects(
    () => streamClient(['abcd']).getAssetOriginal('a', { maxBytes: 3 }),
    (error) => error.name === 'ResponseTooLargeError',
  );
});

test('a streamed JSON error body surfaces its message', async () => {
  await assert.rejects(
    () => streamClient(['{"message":"asset not found"}'], { status: 404 }).getAsset('a'),
    (error) => {
      assert.equal(error.name, 'ImmichApiError');
      assert.equal(error.status, 404);
      assert.equal(error.message, 'asset not found');
      return true;
    },
  );
});

test('Immich errors redact exact, encoded, and echoed-header API credentials', async () => {
  const secret = 'immich:test/+ key';
  const body = JSON.stringify({
    code: 'bad_key',
    message: `exact ${secret}; encoded ${encodeURIComponent(secret)}; Authorization: Bearer reflected-value`,
    request: { headers: { 'x-api-key': secret } },
  });
  const client = new ImmichClient({
    baseUrl: 'http://immich.test',
    apiKey: secret,
    fetchImpl: streamFetch([body], { status: 401, headers: { 'content-type': 'application/json' } }),
  });

  await assert.rejects(client.getAsset('a'), (error) => {
    assert.equal(error.status, 401);
    assert.match(error.message, /code: bad_key/);
    assert.doesNotMatch(error.message, /immich:test|immich%3Atest|reflected-value/i);
    assert.doesNotMatch(error.message, /request|headers/i);
    return true;
  });
});

test('a huge error body reads bounded and degrades to the generic status message', async () => {
  // 96KB of non-JSON error page, far past the 64KB error-body cap: the read
  // must abort (never buffer the flood) and the failure must still surface
  // as an ImmichApiError with the status — NOT a ResponseTooLargeError,
  // which callers would misread as "image too big" and degrade on.
  const flood = [new Uint8Array(48 * 1024).fill(120), new Uint8Array(48 * 1024).fill(120)];

  await assert.rejects(
    () => streamClient(flood, { status: 500, headers: { 'content-type': 'text/html' } }).getAsset('a'),
    (error) => {
      assert.equal(error.name, 'ImmichApiError');
      assert.equal(error.status, 500);
      assert.equal(error.message, 'Immich request failed with status 500');
      return true;
    },
  );
});

test('a non-JSON error body degrades to the generic status message', async () => {
  await assert.rejects(
    () => streamClient(['<html>bad gateway</html>'], { status: 502 }).getAsset('a'),
    (error) => {
      assert.equal(error.name, 'ImmichApiError');
      assert.equal(error.status, 502);
      assert.equal(error.message, 'Immich request failed with status 502');
      return true;
    },
  );
});

test('extractAssets supports Immich search response shapes', () => {
  assert.deepEqual(extractAssets([{ id: 'a' }]).map((asset) => asset.id), ['a']);
  assert.deepEqual(extractAssets({ assets: { items: [{ id: 'b' }] } }).map((asset) => asset.id), ['b']);
  assert.deepEqual(extractAssets({ items: [{ id: 'c' }] }).map((asset) => asset.id), ['c']);
  assert.deepEqual(extractAssets({ assets: [{ id: 'd' }] }).map((asset) => asset.id), ['d']);
});

test('listTags keeps legacy tolerant reads but offers fail-closed Smart Album reads', async () => {
  const client = new ImmichClient({
    baseUrl: 'http://immich.test',
    apiKey: 'test-key',
    fetchImpl: async () => new Response('{"unexpected":true}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  });

  assert.deepEqual(await client.listTags(), []);
  await assert.rejects(
    client.listTags({ strict: true }),
    (error) => error?.code === 'invalid_upstream_pagination' && /invalid response/.test(error.message),
  );
});
