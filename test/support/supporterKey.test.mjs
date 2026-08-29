import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';

import { parseSupporterKey, SUPPORT_PUBLIC_KEY_PEM } from '../../src/support/supporterKey.mjs';
import { createSupportRoutes } from '../../src/routes/support.mjs';

// Throwaway keypair per test run — the production private key never comes
// anywhere near this repo or CI. The test helper signs the public key format's
// base64url payload segment as ASCII, matching the parser's verification
// contract.
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' });

function mint(payload) {
  const payloadText = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signature = sign(null, Buffer.from(payloadText, 'ascii'), privateKey).toString('base64url');
  return `PICTARIA.${payloadText}.${signature}`;
}

const GOOD = { v: 1, tier: 'supporter', id: 'ABCD2345', iat: '2026-07-20' };

test('parses valid supporter and patron keys', () => {
  assert.deepEqual(parseSupporterKey(mint(GOOD), { publicKeyPem }), {
    tier: 'supporter',
    id: 'ABCD2345',
    iat: '2026-07-20',
  });
  const patron = parseSupporterKey(mint({ ...GOOD, tier: 'patron' }), { publicKeyPem });
  assert.equal(patron.tier, 'patron');
});

test('forgives email mangling: line wraps, surrounding whitespace, lowercased prefix', () => {
  const token = mint(GOOD);
  const mangled = `  pictaria.${token.slice(9, 40)}\n${token.slice(40)}  \n`;
  assert.deepEqual(parseSupporterKey(mangled, { publicKeyPem }), {
    tier: 'supporter',
    id: 'ABCD2345',
    iat: '2026-07-20',
  });
});

test('rejects tampering in either segment', () => {
  const token = mint(GOOD);
  const [prefix, payloadText, signatureText] = token.split('.');
  const flip = (text, at) => text.slice(0, at) + (text[at] === 'A' ? 'B' : 'A') + text.slice(at + 1);
  assert.equal(parseSupporterKey(`${prefix}.${flip(payloadText, 10)}.${signatureText}`, { publicKeyPem }), null);
  assert.equal(parseSupporterKey(`${prefix}.${payloadText}.${flip(signatureText, 30)}`, { publicKeyPem }), null);
});

test('rejects wrong version, unknown tier, malformed id and date', () => {
  for (const payload of [
    { ...GOOD, v: 2 },
    { ...GOOD, tier: 'gold' },
    { ...GOOD, id: 'ab' },
    { ...GOOD, id: 42 },
    { ...GOOD, iat: 'not-a-date' },
    { ...GOOD, iat: undefined },
  ]) {
    assert.equal(parseSupporterKey(mint(payload), { publicKeyPem }), null, JSON.stringify(payload));
  }
});

test('rejects garbage, empties, and non-strings without throwing', () => {
  for (const input of ['', null, undefined, 42, 'PICTARIA', 'PICTARIA.abc', 'PICTARIA.a.b.c', 'not a key at all', {}]) {
    assert.equal(parseSupporterKey(input, { publicKeyPem }), null);
  }
});

test('a key signed by a random keypair fails against the pinned production key', () => {
  // No override: the default is the production public key baked into the
  // module — a token from our throwaway pair must not validate against it.
  delete process.env.PICTARIA_SUPPORT_PUBLIC_KEY;
  assert.equal(parseSupporterKey(mint(GOOD)), null);
  assert.match(SUPPORT_PUBLIC_KEY_PEM, /^-----BEGIN PUBLIC KEY-----/);
});

test('PICTARIA_SUPPORT_PUBLIC_KEY env override is honored (rotation escape hatch)', () => {
  process.env.PICTARIA_SUPPORT_PUBLIC_KEY = publicKeyPem;
  try {
    assert.equal(parseSupporterKey(mint(GOOD)).tier, 'supporter');
  } finally {
    delete process.env.PICTARIA_SUPPORT_PUBLIC_KEY;
  }
});

test('status route reports the parsed badge facts, never the key', async () => {
  process.env.PICTARIA_SUPPORT_PUBLIC_KEY = publicKeyPem;
  try {
    const routes = createSupportRoutes({ config: { supporterKey: mint({ ...GOOD, tier: 'patron' }) } });
    const sent = [];
    const response = { writeHead: () => {}, end: (body) => sent.push(JSON.parse(body)) };
    const handled = await routes({ method: 'GET' }, response, new URL('http://x/api/support/status'));
    assert.equal(handled, true);
    assert.deepEqual(sent[0], { supporter: { tier: 'patron', since: '2026-07-20', keyId: 'ABCD2345' } });
    assert.equal(JSON.stringify(sent[0]).includes('PICTARIA.'), false);

    const none = [];
    const noneResponse = { writeHead: () => {}, end: (body) => none.push(JSON.parse(body)) };
    await createSupportRoutes({ config: {} })({ method: 'GET' }, noneResponse, new URL('http://x/api/support/status'));
    assert.deepEqual(none[0], { supporter: null });
  } finally {
    delete process.env.PICTARIA_SUPPORT_PUBLIC_KEY;
  }
});
