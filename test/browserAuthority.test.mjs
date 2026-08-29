import assert from 'node:assert/strict';
import test from 'node:test';

import { createBrowserAuthorityPolicy } from '../src/browserAuthority.mjs';

test('browser authority accepts local and explicitly configured hosts', () => {
  const policy = createBrowserAuthorityPolicy('pictaria.example.com,alt.example.com:8443');
  for (const host of [
    '127.0.0.1:4080',
    '[::1]:4080',
    'pictaria:4080',
    'pictaria.local:4080',
    'pictaria.home.arpa',
    'frame.example.ts.net',
    'pictaria.example.com',
    'pictaria.example.com:4443',
    'alt.example.com:8443',
  ]) {
    assert.equal(policy.isAllowed(host), true, host);
  }
});

test('browser authority rejects arbitrary public and malformed hosts', () => {
  const policy = createBrowserAuthorityPolicy('alt.example.com:8443');
  for (const host of [
    'attacker.example',
    'alt.example.com',
    'alt.example.com:443',
    'https://alt.example.com:8443',
    'user@alt.example.com:8443',
    'alt.example.com/path',
    '',
  ]) {
    assert.equal(policy.isAllowed(host), false, host);
  }
});

test('browser authority preserves an explicitly configured default HTTP port', () => {
  const policy = createBrowserAuthorityPolicy('port80.example.com:80');

  assert.equal(policy.isAllowed('port80.example.com:80'), true);
  assert.equal(policy.isAllowed('port80.example.com:080'), true);
  assert.equal(policy.isAllowed('port80.example.com'), false);
  assert.equal(policy.isAllowed('port80.example.com:8080'), false);
});

test('browser authority rejects URL-shaped configuration entries', () => {
  assert.throws(
    () => createBrowserAuthorityPolicy('https://pictaria.example.com'),
    /host\[:port\], not URLs/,
  );
});
