import test from 'node:test';
import assert from 'node:assert/strict';

import { detectRasterImageContentType, sendImage } from '../../src/http.mjs';

function avifFixture(brand = 'avif') {
  const buffer = Buffer.alloc(24);
  buffer.writeUInt32BE(buffer.length, 0);
  buffer.write('ftyp', 4, 'ascii');
  buffer.write(brand, 8, 'ascii');
  buffer.writeUInt32BE(0, 12);
  buffer.write('mif1', 16, 'ascii');
  buffer.write('miaf', 20, 'ascii');
  return buffer;
}

function captureResponse() {
  return {
    status: null,
    headers: {},
    body: null,
    setHeader(name, value) {
      this.headers[name] = value;
    },
    writeHead(status, headers) {
      this.status = status;
      this.headers = { ...this.headers, ...headers };
    },
    end(body) {
      this.body = Buffer.from(body ?? '');
    },
  };
}

test('raster image detection derives only the supported response types from bytes', () => {
  const fixtures = [
    [Buffer.from([0xff, 0xd8, 0xff, 0xe0]), 'image/jpeg'],
    [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), 'image/png'],
    [Buffer.from('GIF87a', 'ascii'), 'image/gif'],
    [Buffer.from('GIF89a', 'ascii'), 'image/gif'],
    [Buffer.from('RIFF0000WEBP', 'ascii'), 'image/webp'],
    [avifFixture(), 'image/avif'],
    [avifFixture('avis'), 'image/avif'],
  ];

  for (const [bytes, expected] of fixtures) {
    assert.equal(detectRasterImageContentType(bytes), expected);
  }
});

test('active, unknown, empty, and truncated upstream content is rejected', () => {
  for (const bytes of [
    Buffer.from('<!doctype html><script>alert(1)</script>'),
    Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'),
    Buffer.from('not an image'),
    Buffer.alloc(0),
    avifFixture().subarray(0, 12),
  ]) {
    assert.equal(detectRasterImageContentType(bytes), null);
  }
});

test('validated images use the detected type and invalid upstream bodies fail closed', () => {
  const image = captureResponse();
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
  assert.equal(sendImage(image, 200, jpeg), true);
  assert.equal(image.status, 200);
  assert.equal(image.headers['Content-Type'], 'image/jpeg');
  assert.equal(image.headers['Content-Length'], jpeg.length);
  assert.deepEqual(image.body, jpeg);

  const invalid = captureResponse();
  assert.equal(sendImage(invalid, 200, Buffer.from('<html>not an image</html>')), false);
  assert.equal(invalid.status, 502);
  assert.equal(invalid.headers['Content-Type'], 'application/json; charset=utf-8');
  assert.equal(invalid.headers['Cache-Control'], 'no-store');
  assert.equal(JSON.parse(invalid.body.toString()).error.code, 'invalid_upstream_image');
});

test('a GIF-prefixed HTML polyglot stays image/gif under the global nosniff policy', () => {
  const response = captureResponse();
  response.setHeader('X-Content-Type-Options', 'nosniff');
  const polyglot = Buffer.from('GIF89a<html><script>alert(1)</script></html>', 'ascii');

  assert.equal(sendImage(response, 200, polyglot), true);
  assert.equal(response.status, 200);
  assert.equal(response.headers['Content-Type'], 'image/gif');
  assert.equal(response.headers['X-Content-Type-Options'], 'nosniff');
  assert.deepEqual(response.body, polyglot);
});
