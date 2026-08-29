import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const [home, settings] = await Promise.all([
  readFile(new URL('../public/index.html', import.meta.url), 'utf8'),
  readFile(new URL('../public/settings.html', import.meta.url), 'utf8'),
]);

test('home status distinguishes incompatible Immich from unreachable Immich', () => {
  assert.match(home, /is unsupported — requires 2\.0 or newer/);
  assert.match(home, /has an incompatible API/);
  assert.match(home, /Immich unreachable/);
  assert.match(home, /Immich connected/);
});

test('Settings gives actionable compatibility feedback after saving', () => {
  assert.match(settings, /Pictaria Server requires Immich 2\.0 or newer/);
  assert.match(settings, /does not provide the API Pictaria Server requires/);
  assert.match(settings, /Check the URL and Immich version/);
});
