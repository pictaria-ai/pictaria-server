import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '../..');

const browserAuthClients = [
  'public/index.html',
  'public/settings.html',
  'public/activity.html',
  'public/enrich.html',
  'public/remote.html',
  'public/albums.js',
  'public/curate.js',
  'public/insights.js',
];

test('browser pages rely only on the HttpOnly session for authentication', () => {
  for (const relativePath of browserAuthClients) {
    const source = readFileSync(resolve(ROOT, relativePath), 'utf8');
    assert.doesNotMatch(
      source,
      /localStorage\.getItem\(['"]pictariaAppPassword['"]\)/,
      `${relativePath} must not read the legacy raw password`,
    );
    assert.doesNotMatch(
      source,
      /X-App-Password/,
      `${relativePath} must not authenticate with a JavaScript-readable password`,
    );
    assert.doesNotMatch(
      source,
      /pictaria_pw/,
      `${relativePath} must not depend on the retired password cookie`,
    );
  }
});

test('the auth gate reads a legacy password only to migrate and purge it', () => {
  const source = readFileSync(resolve(ROOT, 'public/auth-gate.js'), 'utf8');
  const reads = source.match(/localStorage\.getItem\(['"]pictariaAppPassword['"]\)/g) ?? [];

  assert.equal(reads.length, 1);
  assert.match(source, /async function purgeLegacyPassword\(\)/);
  assert.match(source, /localStorage\.removeItem\(['"]pictariaAppPassword['"]\)/);
  assert.doesNotMatch(source, /X-App-Password/);
});

test('the Remote recreates a terminal EventSource after temporary capacity rejection', () => {
  const source = readFileSync(resolve(ROOT, 'public/remote.html'), 'utf8');

  assert.match(source, /events\.readyState === EventSource\.CLOSED/);
  assert.match(source, /eventReconnectTimer = setTimeout\(\(\) => \{/);
  assert.match(source, /if \(!state\.authRequired\) connectEvents\(\)/);
});
