import assert from 'node:assert/strict';
import test from 'node:test';

import {
  configuredSecrets,
  sanitizeDiagnostic,
  structuredUpstreamDiagnostic,
} from '../src/diagnostics.mjs';

test('diagnostics redact exact, encoded, and echoed-header credentials', () => {
  const secret = 'test:key/+ value';
  const encoded = encodeURIComponent(secret);
  const formEncoded = new URLSearchParams({ value: secret }).toString().slice('value='.length);
  const base64 = Buffer.from(secret).toString('base64');
  const diagnostic = sanitizeDiagnostic(
    `exact=${secret} encoded=${encoded} form=${formEncoded} b64=${base64} Authorization: Bearer unknown-header-value`,
    { secrets: [secret] },
  );
  assert.doesNotMatch(diagnostic, /test:key|test%3Akey|dGVzdDprZXkvKyB2YWx1ZQ/i);
  assert.doesNotMatch(diagnostic, /unknown-header-value/);
  assert.match(diagnostic, /\[redacted\]/);
});

test('configuredSecrets finds integration credentials without collecting ordinary settings', () => {
  assert.deepEqual(
    configuredSecrets({ immichApiKey: 'immich-test', providers: { p: { apiKey: 'provider-test', modelName: 'not-secret' } } }).sort(),
    ['immich-test', 'provider-test'],
  );
});

test('structured upstream diagnostics allowlist fields, redact, and stay byte bounded', () => {
  const diagnostic = structuredUpstreamDiagnostic({
    code: 'bad_auth',
    error: { message: `key echoed: ${'secret-value'} ${'x'.repeat(2000)}` },
    request: { headers: { Authorization: 'must-not-survive' } },
    stack: 'must-not-survive',
  }, { secrets: ['secret-value'], maxBytes: 160 });
  assert.match(diagnostic, /code: bad_auth/);
  assert.match(diagnostic, /\[redacted\]/);
  assert.doesNotMatch(diagnostic, /must-not-survive/);
  assert.ok(Buffer.byteLength(diagnostic, 'utf8') <= 160);
});
