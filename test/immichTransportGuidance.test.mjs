import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const [readme, gettingStarted, configuration, envExample] = await Promise.all([
  readFile(new URL('../README.md', import.meta.url), 'utf8'),
  readFile(new URL('../docs/GETTING-STARTED.md', import.meta.url), 'utf8'),
  readFile(new URL('../docs/CONFIGURATION.md', import.meta.url), 'utf8'),
  readFile(new URL('../.env.example', import.meta.url), 'utf8'),
]);

test('public Immich setup guidance covers HTTP, HTTPS, and URL normalization', () => {
  for (const source of [readme, gettingStarted, configuration, envExample]) {
    assert.match(source, /HTTP and HTTPS|HTTP or HTTPS/i);
    assert.match(source, /scheme-less|without a scheme/i);
    assert.match(source, /\/api/);
  }
});

test('private-CA guidance preserves certificate validation and URL roles', () => {
  assert.match(configuration, /NODE_EXTRA_CA_CERTS/);
  assert.match(configuration, /Do not use\s+`NODE_TLS_REJECT_UNAUTHORIZED=0`/);
  assert.match(configuration, /IMMICH_BASE_URL=http:\/\/immich:2283/);
  assert.match(configuration, /IMMICH_PUBLIC_URL=https:\/\/photos\.example\.com/);
  assert.match(gettingStarted, /does not disable certificate validation/i);
});
