import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import { makeWakeWordModelFixture } from '../wakeword/modelFixture.mjs';

// The only tests that exercise server.mjs over real HTTP: the auth gate,
// the static traversal guard, health, and 404 shapes. The server is booted
// as a child process against temp data dirs and no Immich.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

// HTTP integration children inherit ordinary runtime variables (PATH, temp
// directories, coverage hooks), but never provider configuration from the
// developer shell. Credentials and models are empty, configurable endpoints
// point at the local discard port, and selectors stay on inert defaults.
// Deliberate per-test overrides are applied after this object.
const INERT_PROVIDER_ENV = Object.freeze({
  DEFAULT_PROVIDER: 'cloud_openai',
  CURATE_REFEREE_PROVIDER: '',
  CURATE_REFEREE_MODEL: '',
  STT_PROVIDER: '',
  TTS_PROVIDER: '',
  VOICE_PROSE_PROVIDER: 'cloud_openai',
  VOICE_INTERESTING_MODEL: '',
  VOICE_ASK_MODEL: '',
  OPENAI_API_KEY: '',
  OPENAI_MODEL: '',
  OPENAI_INTERESTING_MODEL: '',
  OPENAI_ASK_MODEL: '',
  OPENAI_TTS_MODEL: '',
  LMSTUDIO_API_KEY: '',
  LMSTUDIO_MODEL: '',
  LMSTUDIO_BASE_URL: 'http://127.0.0.1:9/v1',
  OPENAI_COMPATIBLE_API_KEY: '',
  OPENAI_COMPATIBLE_MODEL: '',
  OPENAI_COMPATIBLE_BASE_URL: 'http://127.0.0.1:9/v1',
  OLLAMA_LOCAL_API_KEY: '',
  OLLAMA_LOCAL_MODEL: '',
  OLLAMA_LOCAL_BASE_URL: 'http://127.0.0.1:9',
  OPENROUTER_API_KEY: '',
  OPENROUTER_MODEL: '',
  OPENROUTER_BASE_URL: 'http://127.0.0.1:9',
  OLLAMA_API_KEY: '',
  OLLAMA_MODEL: '',
  OLLAMA_BASE_URL: 'http://127.0.0.1:9',
  VENICE_API_KEY: '',
  VENICE_MODEL: '',
  VENICE_BASE_URL: 'http://127.0.0.1:9',
  ELEVENLABS_API_KEY: '',
  ELEVENLABS_TTS_MODEL: '',
  ELEVENLABS_VOICE_ID: '',
  GEOCODING_PROVIDER: '',
  GEOAPIFY_API_KEY: '',
});

function httpServerChildEnv(parentEnv, overrides = {}) {
  return {
    ...parentEnv,
    ...INERT_PROVIDER_ENV,
    ...overrides,
  };
}

function rawHttpRequest({ port, path = '/', method = 'GET', headers = {}, body = '' }) {
  return new Promise((resolveRequest, rejectRequest) => {
    const request = httpRequest({ host: '127.0.0.1', port, path, method, headers }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolveRequest({
        status: response.statusCode,
        body: Buffer.concat(chunks).toString('utf8'),
        headers: response.headers,
      }));
    });
    request.on('error', rejectRequest);
    request.end(body);
  });
}

function partialHttpRequest({ port, path, headers = {}, body }) {
  return new Promise((resolveRequest, rejectRequest) => {
    let responseStarted = false;
    const request = httpRequest({ host: '127.0.0.1', port, path, method: 'POST', headers }, (response) => {
      responseStarted = true;
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolveRequest({
        status: response.statusCode,
        body: Buffer.concat(chunks).toString('utf8'),
        headers: response.headers,
      }));
    });
    request.on('error', (error) => {
      if (!responseStarted) rejectRequest(error);
    });
    request.write(body);
  });
}

async function bootServer({ password, env = {}, dataDir = null, parentEnv = process.env }) {
  const dir = mkdtempSync(join(tmpdir(), 'pictaria-http-'));
  const stateDir = dataDir ?? dir;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const port = 20000 + Math.floor(Math.random() * 20000);
    const child = spawn(process.execPath, ['src/server.mjs'], {
      cwd: ROOT,
      env: httpServerChildEnv(parentEnv, {
        HOST: '127.0.0.1',
        PORT: String(port),
        APP_PASSWORD: password,
        ALLOW_INSECURE_OPEN: password ? '' : 'true',
        DATABASE_PATH: join(stateDir, 'enrichment.sqlite'),
        INSIGHTS_DB_PATH: join(stateDir, 'insights.sqlite'),
        FRAME_DB_PATH: join(stateDir, 'frame.db'),
        ALBUMS_DATA_FILE: join(stateDir, 'albums.json'),
        SETTINGS_PATH: join(stateDir, 'settings.json'),
        WAKE_WORD_MODELS_DIR: join(stateDir, 'wake-word-models'),
        BACKUP_DIR: join(stateDir, 'backups'),
        BACKUP_ENABLED: 'false',
        IMMICH_BASE_URL: '',
        IMMICH_API_KEY: '',
        ENRICH_ENABLED: 'false',
        // Pinned so an inherited shell export can't flip the default-off
        // cookie assertion; explicit test overrides below still win.
        SESSION_COOKIE_SECURE: '',
        BROWSER_ALLOWED_HOSTS: '',
        // Forwarding headers stay untrusted unless a test explicitly opts in.
        TRUSTED_PROXY_IPS: '',
        ...env,
      }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    let exited = false;
    child.on('exit', () => { exited = true; });
    const listeningLine = `Pictaria Server listening on http://127.0.0.1:${port}`;

    for (let i = 0; i < 100 && !exited; i += 1) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/health`);
        // A random port can collide with another concurrently running test
        // server. Its health response must not make this child appear ready:
        // require the listening line emitted by this exact process too.
        if (response.ok && stdout.includes(listeningLine)) {
          return {
            dir: stateDir,
            port,
            base: `http://127.0.0.1:${port}`,
            async stop() {
              child.kill('SIGTERM');
              await new Promise((resolveExit) => child.on('exit', resolveExit));
              rmSync(dir, { recursive: true, force: true });
            },
          };
        }
      } catch {
        // not up yet
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    }
    child.kill('SIGKILL');
    if (!/EADDRINUSE/.test(stderr)) {
      throw new Error(`server did not start:\n${stderr}`);
    }
  }
  throw new Error('no free port after 3 attempts');
}

async function rejectedServerStart(appPassword, env = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pictaria-auth-config-'));
  const childEnv = httpServerChildEnv(process.env, {
    HOST: '127.0.0.1',
    PORT: '0',
    ALLOW_INSECURE_OPEN: '',
    DATABASE_PATH: join(dir, 'enrichment.sqlite'),
    INSIGHTS_DB_PATH: join(dir, 'insights.sqlite'),
    FRAME_DB_PATH: join(dir, 'frame.db'),
    ALBUMS_DATA_FILE: join(dir, 'albums.json'),
    SETTINGS_PATH: join(dir, 'settings.json'),
    WAKE_WORD_MODELS_DIR: join(dir, 'wake-word-models'),
    BACKUP_DIR: join(dir, 'backups'),
    BACKUP_ENABLED: 'false',
    IMMICH_BASE_URL: '',
    IMMICH_API_KEY: '',
    ENRICH_ENABLED: 'false',
    ...env,
  });
  delete childEnv.APP_PASSWORD;
  if (appPassword !== undefined) {
    childEnv.APP_PASSWORD = appPassword;
  }
  const child = spawn(process.execPath, ['src/server.mjs'], {
    cwd: ROOT,
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const result = await Promise.race([
    new Promise((resolveExit) => child.once('exit', (code, signal) => resolveExit({ code, signal }))),
    new Promise((resolveTimeout) => setTimeout(() => resolveTimeout({ timedOut: true }), 3_000)),
  ]);
  if (result.timedOut) {
    child.kill('SIGKILL');
    await new Promise((resolveExit) => child.once('exit', resolveExit));
  }
  rmSync(dir, { recursive: true, force: true });
  return { ...result, stderr };
}

test('server entry point refuses missing or blank passwords without the explicit open-mode opt-in', async () => {
  for (const password of [undefined, '']) {
    const result = await rejectedServerStart(password);
    assert.equal(result.timedOut, undefined, `server stayed up with APP_PASSWORD=${String(password)}`);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /APP_PASSWORD.*ALLOW_INSECURE_OPEN=true/);
    assert.doesNotMatch(result.stderr, /listening on/);
  }
});

test('server entry point refuses invalid trusted-proxy configuration', async () => {
  const result = await rejectedServerStart('test-secret', { TRUSTED_PROXY_IPS: '0.0.0.0/0' });
  assert.equal(result.timedOut, undefined);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /TRUSTED_PROXY_IPS.*invalid CIDR/);
  assert.doesNotMatch(result.stderr, /listening on/);
});

test('server entry point refuses URL-shaped browser-host configuration', async () => {
  const result = await rejectedServerStart('test-secret', {
    BROWSER_ALLOWED_HOSTS: 'https://pictaria.example.com',
  });
  assert.equal(result.timedOut, undefined);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /BROWSER_ALLOWED_HOSTS.*host\[:port\], not URLs/);
  assert.doesNotMatch(result.stderr, /listening on/);
});

test('server entry point presents saved provider credential conflicts as concise boot errors', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pictaria-provider-binding-'));
  try {
    const settingsPath = join(dir, 'settings.json');
    writeFileSync(settingsPath, JSON.stringify({
      version: 2,
      enrich: { lmStudioBaseUrl: 'http://attacker.example/v1' },
    }));
    const result = await rejectedServerStart('test-secret', {
      SETTINGS_PATH: settingsPath,
      LMSTUDIO_API_KEY: 'synthetic-provider-key',
    });
    assert.equal(result.timedOut, undefined);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /^\[Pictaria\] Refusing to start: An environment-backed LM Studio API key/m);
    assert.match(result.stderr, /remove LMSTUDIO_API_KEY if that server does not require it/);
    assert.doesNotMatch(result.stderr, /SettingsError:|\n\s+at /);
    assert.doesNotMatch(result.stderr, /listening on/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('HTTP children ignore inherited provider configuration but allow explicit local fakes', async (t) => {
  const inheritedCases = [
    {
      name: 'OpenRouter',
      provider: 'openrouter',
      env: {
        OPENROUTER_API_KEY: 'inherited-openrouter-key',
        OPENROUTER_MODEL: 'inherited-openrouter-model',
        OPENROUTER_BASE_URL: 'http://127.0.0.1:9',
      },
    },
    {
      name: 'Ollama Cloud',
      provider: 'cloud_ollama',
      env: {
        OLLAMA_API_KEY: 'inherited-ollama-key',
        OLLAMA_MODEL: 'inherited-ollama-model',
        OLLAMA_BASE_URL: 'http://127.0.0.1:9',
      },
    },
    {
      name: 'Ollama Local',
      provider: 'local_ollama',
      env: {
        OLLAMA_LOCAL_API_KEY: 'inherited-local-ollama-key',
        OLLAMA_LOCAL_MODEL: 'inherited-local-ollama-model',
        OLLAMA_LOCAL_BASE_URL: 'http://127.0.0.1:9',
      },
    },
    {
      name: 'Venice',
      provider: 'venice',
      env: {
        VENICE_API_KEY: 'inherited-venice-key',
        VENICE_MODEL: 'inherited-venice-model',
        VENICE_BASE_URL: 'http://127.0.0.1:9',
      },
    },
    {
      name: 'LM Studio',
      provider: 'local_lmstudio',
      env: {
        LMSTUDIO_API_KEY: 'inherited-lm-studio-key',
        LMSTUDIO_MODEL: 'inherited-lm-studio-model',
        LMSTUDIO_BASE_URL: 'http://127.0.0.1:9/v1',
      },
    },
    {
      name: 'OpenAI-compatible',
      provider: 'openai_compatible',
      env: {
        OPENAI_COMPATIBLE_API_KEY: 'inherited-compatible-key',
        OPENAI_COMPATIBLE_MODEL: 'inherited-compatible-model',
        OPENAI_COMPATIBLE_BASE_URL: 'http://127.0.0.1:9/v1',
      },
    },
  ];

  for (const inherited of inheritedCases) {
    await t.test(`${inherited.name} exports cannot dispatch the no-provider request`, async () => {
      const server = await bootServer({
        password: 'test-secret',
        parentEnv: {
          ...process.env,
          VOICE_PROSE_PROVIDER: inherited.provider,
          ...inherited.env,
        },
      });
      try {
        const response = await fetch(`${server.base}/api/voice/ask`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-App-Password': 'test-secret' },
          body: JSON.stringify({ question: 'how far away is the moon' }),
        });
        assert.equal(response.status, 503);
      } finally {
        await server.stop();
      }
    });
  }

  await t.test('an explicit loopback fake still overrides the inert defaults', async () => {
    const { createServer } = await import('node:http');
    const seen = [];
    const fakeOllama = createServer(async (request, response) => {
      let body = '';
      for await (const chunk of request) body += chunk;
      seen.push({ path: request.url, body: JSON.parse(body) });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"message":{"content":"The loopback fake answered."}}');
    });
    await new Promise((resolveListen) => fakeOllama.listen(0, '127.0.0.1', resolveListen));
    const fakePort = fakeOllama.address().port;
    const server = await bootServer({
      password: 'test-secret',
      env: {
        VOICE_PROSE_PROVIDER: 'local_ollama',
        OLLAMA_LOCAL_MODEL: 'test-voice-model',
        OLLAMA_LOCAL_BASE_URL: `http://127.0.0.1:${fakePort}`,
      },
    });

    try {
      const response = await fetch(`${server.base}/api/voice/ask`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-App-Password': 'test-secret' },
        body: JSON.stringify({ question: 'how far away is the moon' }),
      });
      assert.equal(response.status, 200);
      assert.equal((await response.json()).text, 'The loopback fake answered.');
      assert.equal(seen.length, 1);
      assert.equal(seen[0].path, '/api/chat');
      assert.equal(seen[0].body.model, 'test-voice-model');
    } finally {
      await server.stop();
      await new Promise((resolveClose) => fakeOllama.close(resolveClose));
    }
  });
});

test('HTTP surface with a password set', async (t) => {
  const server = await bootServer({ password: 'test-secret' });
  t.after(() => server.stop());

  await t.test('records server startup without changing the public health surface', () => {
    const db = new DatabaseSync(join(server.dir, 'enrichment.sqlite'), { readOnly: true });
    const event = db.prepare(`
      SELECT category, type, source, outcome, summary, detail_json
      FROM activity_log
      WHERE type = 'system.start'
      ORDER BY id DESC
      LIMIT 1
    `).get();
    db.close();
    assert.deepEqual(
      {
        category: event.category,
        type: event.type,
        source: event.source,
        outcome: event.outcome,
        summary: event.summary,
      },
      {
        category: 'system',
        type: 'system.start',
        source: 'server',
        outcome: 'succeeded',
        summary: 'Pictaria Server started',
      },
    );
    assert.equal(typeof JSON.parse(event.detail_json).serverVersion, 'string');
  });

  await t.test('wired activity capture records bounded operations and no submitted values', async () => {
    const secret = 'PRIVATE VOICE TRANSCRIPT';
    const headers = { 'Content-Type': 'application/json', 'X-App-Password': 'test-secret' };

    const settings = await fetch(`${server.base}/api/settings`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ voice: { openAiTtsVoice: 'private-setting-value' } }),
    });
    assert.equal(settings.status, 200);

    const usage = await fetch(`${server.base}/api/voice/command-used`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ label: secret, deviceId: 'kitchen', transcript: secret }),
    });
    assert.equal(usage.status, 200);

    const command = await fetch(`${server.base}/api/frame/command`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ command: 'next', deviceId: 'kitchen' }),
    });
    assert.equal(command.status, 200);
    assert.equal((await command.json()).delivered, false);

    const db = new DatabaseSync(join(server.dir, 'enrichment.sqlite'), { readOnly: true });
    const events = db.prepare(`
      SELECT type, device_id, outcome, summary, detail_json
      FROM activity_log
      WHERE type IN ('settings.changed', 'voice.command', 'frame.command')
      ORDER BY id
    `).all();
    db.close();
    assert.deepEqual(events.map((event) => event.type), ['settings.changed', 'voice.command', 'frame.command']);
    assert.deepEqual(JSON.parse(events[0].detail_json).fields, ['voice.openAiTtsVoice']);
    assert.equal(events[1].summary, 'Voice command used: unrecognized');
    assert.equal(events[2].outcome, 'undelivered');
    assert.doesNotMatch(JSON.stringify(events), /PRIVATE VOICE TRANSCRIPT|private-setting-value/);
  });

  await t.test('unified Activity API and bounded downloads require authentication', async () => {
    const unauthenticated = await fetch(`${server.base}/api/activity`);
    assert.equal(unauthenticated.status, 401);

    const headers = { 'X-App-Password': 'test-secret' };
    const response = await fetch(`${server.base}/api/activity?type=system.start&limit=10`, { headers });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.ok(body.items.some((event) => event.type === 'system.start'));
    assert.equal(body.retention.operationalDays, 90);

    const invalid = await fetch(`${server.base}/api/activity?cursor=not-real`, { headers });
    assert.equal(invalid.status, 400);
    assert.equal((await invalid.json()).error.code, 'invalid_activity_query');

    const csv = await fetch(`${server.base}/api/activity/export?format=csv&type=system.start`, { headers });
    assert.equal(csv.status, 200);
    assert.match(csv.headers.get('content-type'), /^text\/csv/);
    assert.match(csv.headers.get('content-disposition'), /pictaria-activity-.*\.csv/);
    assert.match(await csv.text(), /Pictaria Server started/);
  });

  await t.test('unauthenticated health is trimmed to liveness + authRequired', async () => {
    const response = await fetch(`${server.base}/api/health`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(body.authRequired, true);
    // No configuration disclosure before auth.
    assert.equal('providers' in body, false);
    assert.equal('taxonomyVersion' in body, false);
    assert.equal('immichConfigured' in body, false);
    assert.equal('immichVersion' in body, false);
    // The protocol handshake is configuration too: nothing about versions or
    // capabilities leaks unauthenticated.
    assert.equal('serverVersion' in body, false);
    assert.equal('protocolVersion' in body, false);
    assert.equal('minAppProtocol' in body, false);
    assert.equal('capabilities' in body, false);
    assert.equal('uptimeSeconds' in body, false);
  });

  await t.test('authenticated health carries the full payload', async () => {
    const response = await fetch(`${server.base}/api/health`, {
      headers: { 'X-App-Password': 'test-secret' },
    });
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal('providers' in body, true);
    assert.equal('taxonomyVersion' in body, true);
    assert.equal(typeof body.immichConfigured, 'boolean');
    assert.equal(typeof body.uptimeSeconds, 'number');
    assert.ok(body.uptimeSeconds >= 0);
  });

  await t.test('authenticated health carries the protocol handshake', async () => {
    const response = await fetch(`${server.base}/api/health`, {
      headers: { 'X-App-Password': 'test-secret' },
    });
    const body = await response.json();
    // serverVersion mirrors package.json — the running build, not a constant.
    const { readFileSync } = await import('node:fs');
    const packageVersion = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
    assert.equal(body.serverVersion, packageVersion);
    assert.equal(body.protocolVersion, 1);
    assert.equal(body.minAppProtocol, 1);
    // Stable capability strings the app gates optional features on.
    assert.ok(Array.isArray(body.capabilities));
    for (const capability of [
      'remote-commands',
      'named-frames',
      'display-reports',
      'voice',
      'voice-ask',
      'weather',
      'custom-wake-word-models',
    ]) {
      assert.ok(body.capabilities.includes(capability), `missing capability: ${capability}`);
    }
  });

  await t.test('insights month drill is authenticated, validates the month, and answers empty months', async () => {
    const unauthenticated = await fetch(`${server.base}/api/insights/year/2019/month/5`);
    assert.equal(unauthenticated.status, 401);

    const headers = { 'X-App-Password': 'test-secret' };
    const invalid = await fetch(`${server.base}/api/insights/year/2019/month/13`, { headers });
    assert.equal(invalid.status, 400);
    assert.equal((await invalid.json()).error.code, 'invalid_month');

    // Fresh install, nothing swept: an empty month is a normal answer.
    const empty = await fetch(`${server.base}/api/insights/year/2019/month/5`, { headers });
    assert.equal(empty.status, 200);
    assert.deepEqual(await empty.json(), { year: 2019, month: 5, count: 0, cities: [], people: [] });
  });

  await t.test('custom wake-word registry is authenticated, validated, downloadable, and deletable', async () => {
    const unauthenticated = await fetch(`${server.base}/api/frame/wake-word-models`);
    assert.equal(unauthenticated.status, 401);

    const modelBytes = makeWakeWordModelFixture();
    const upload = await fetch(`${server.base}/api/frame/wake-word-models`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-App-Password': 'test-secret' },
      body: JSON.stringify({
        defaultThreshold: 0.52,
        displayName: 'Test phrase',
        filename: 'test-phrase.tflite',
        modelBase64: modelBytes.toString('base64'),
        phrase: 'Hey test phrase',
        rightsConfirmed: true,
      }),
    });
    assert.equal(upload.status, 201);
    const uploaded = await upload.json();
    assert.equal(uploaded.available, true);
    assert.deepEqual(uploaded.inputFrames, 16);
    assert.match(uploaded.sha256, /^[0-9a-f]{64}$/);

    const manifest = await fetch(`${server.base}/api/frame/wake-word-models`, {
      headers: { 'X-App-Password': 'test-secret' },
    });
    assert.equal(manifest.status, 200);
    const manifestBody = await manifest.json();
    assert.equal(manifestBody.featureStack, 'pictaria-openwakeword-v1');
    assert.equal(manifestBody.models[0].id, uploaded.id);

    const download = await fetch(`${server.base}${uploaded.downloadPath}`, {
      headers: { 'X-App-Password': 'test-secret' },
    });
    assert.equal(download.status, 200);
    assert.equal(download.headers.get('x-content-sha256'), uploaded.sha256);
    assert.deepEqual(Buffer.from(await download.arrayBuffer()), modelBytes);

    const removed = await fetch(`${server.base}/api/frame/wake-word-models/${uploaded.id}`, {
      method: 'DELETE',
      headers: { 'X-App-Password': 'test-secret' },
    });
    assert.equal(removed.status, 204);
    const after = await fetch(`${server.base}/api/frame/wake-word-models`, {
      headers: { 'X-App-Password': 'test-secret' },
    });
    assert.deepEqual((await after.json()).models, []);
  });

  await t.test('built-in voice prompts are exposed behind auth', async () => {
    const unauthenticated = await fetch(`${server.base}/api/voice/prompts`);
    assert.equal(unauthenticated.status, 401);

    const response = await fetch(`${server.base}/api/voice/prompts`, {
      headers: { 'X-App-Password': 'test-secret' },
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.ok(body.builtin.interestingPrompt.includes('{context}'));
    assert.ok(body.builtin.askPrompt.includes('{question}'));
  });

  await t.test('voice ask validates input and fails closed without a provider key', async () => {
    const unauthenticated = await fetch(`${server.base}/api/voice/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: 'how far away is the moon' }),
    });
    assert.equal(unauthenticated.status, 401);

    const missingQuestion = await fetch(`${server.base}/api/voice/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-App-Password': 'test-secret' },
      body: JSON.stringify({}),
    });
    assert.equal(missingQuestion.status, 400);
    const missingBody = await missingQuestion.json();
    assert.equal(missingBody.error.code, 'invalid_ask_request');

    // The shared child environment pins every provider inert: the route must
    // answer 503 (not attempt a provider call) when no key is configured.
    const noProvider = await fetch(`${server.base}/api/voice/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-App-Password': 'test-secret' },
      body: JSON.stringify({ question: 'how far away is the moon' }),
    });
    assert.equal(noProvider.status, 503);
  });

  await t.test('voice TTS is POST-only and GET cannot dispatch provider work', async () => {
    const headers = { 'X-App-Password': 'test-secret' };
    const retiredGet = await fetch(`${server.base}/api/voice/tts?text=chargeable`, { headers });
    assert.equal(retiredGet.status, 404);
    assert.equal((await retiredGet.json()).error.code, 'not_found');

    // The supported Frame path remains live. With no provider configured it
    // reaches normal TTS handling and fails closed, rather than disappearing
    // with the retired compatibility route.
    const supportedPost = await fetch(`${server.base}/api/voice/tts`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'supported post' }),
    });
    assert.equal(supportedPost.status, 501);
    assert.equal((await supportedPost.json()).error.code, 'tts_provider_error');
  });

  await t.test('the SSE stream opens with the complete live protocol contract', async () => {
    const response = await fetch(`${server.base}/api/frame/events?role=frame&device=fold`, {
      headers: { accept: 'text/event-stream', 'X-App-Password': 'test-secret' },
    });
    assert.equal(response.status, 200);
    const reader = response.body.getReader();
    let text = '';
    // The hello rides right behind the `: connected` comment; read until the
    // first complete event frame arrives.
    while (!text.includes('\n\n') || !text.includes('event: hello')) {
      const { value, done } = await reader.read();
      assert.equal(done, false, 'stream ended before the hello event');
      text += Buffer.from(value).toString();
    }
    const helloData = /event: hello\ndata: (.*)\n/.exec(text);
    assert.ok(helloData, `no hello event in:\n${text}`);
    const hello = JSON.parse(helloData[1]);
    assert.equal(hello.protocolVersion, 1);
    assert.equal(hello.minAppProtocol, 1);
    assert.ok(hello.capabilities.includes('remote-commands'));
    assert.ok(hello.capabilities.includes('named-frames'));
    assert.equal(hello.deviceId, 'fold');
    assert.equal(response.headers.get('access-control-allow-origin'), null);
    await reader.cancel();
  });

  await t.test('SSE capacity is bounded per role and recovers after disconnect', async () => {
    const headers = { accept: 'text/event-stream', 'X-App-Password': 'test-secret' };
    const remotes = [];
    try {
      for (let index = 0; index < 32; index += 1) {
        const response = await fetch(`${server.base}/api/frame/events?role=remote`, { headers });
        assert.equal(response.status, 200, `remote stream ${index + 1}`);
        remotes.push(response);
      }

      const rejected = await fetch(`${server.base}/api/frame/events?role=remote`, { headers });
      assert.equal(rejected.status, 503);
      assert.equal((await rejected.json()).error.code, 'frame_event_capacity');
      assert.equal(rejected.headers.get('retry-after'), '5');

      const frame = await fetch(`${server.base}/api/frame/events?role=frame&device=capacity-control`, { headers });
      assert.equal(frame.status, 200, 'remote saturation must not consume frame capacity');
      await frame.body.cancel();

      await remotes.shift().body.cancel();
      let replacement;
      for (let attempt = 0; attempt < 20; attempt += 1) {
        replacement = await fetch(`${server.base}/api/frame/events?role=remote`, { headers });
        if (replacement.status === 200) break;
        await replacement.body.cancel();
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
      }
      assert.equal(replacement.status, 200, 'disconnect must release a subscriber slot');
      await replacement.body.cancel();
    } finally {
      await Promise.all(remotes.map((response) => response.body.cancel()));
    }
  });

  await t.test('API requests without credentials get a fast 401 with the error shape', async () => {
    const started = Date.now();
    const response = await fetch(`${server.base}/api/enrich/status`);
    const elapsed = Date.now() - started;
    assert.equal(response.status, 401);
    const body = await response.json();
    assert.equal(body.error.code, 'unauthorized');
    assert.equal(typeof body.error.message, 'string');
    // No credentials attempted -> no brute-force delay (every first page
    // load hits this path before the gate).
    assert.ok(elapsed < 500, `expected a fast 401, took ${elapsed}ms`);
  });

  await t.test('a wrong password is rejected after a flat delay; length differences do not throw', async () => {
    const started = Date.now();
    const first = await fetch(`${server.base}/api/enrich/status`, {
      headers: { 'X-App-Password': 'nope' },
    });
    const elapsed = Date.now() - started;
    assert.equal(first.status, 401);
    assert.ok(elapsed >= 900, `expected the brute-force delay, took ${elapsed}ms`);
    for (const wrong of ['test-secret-x', 't']) {
      const response = await fetch(`${server.base}/api/enrich/status`, {
        headers: { 'X-App-Password': wrong },
      });
      assert.equal(response.status, 401);
    }
  });

  await t.test('header and bearer credentials authorize; the retired raw-password cookie does not', async () => {
    for (const headers of [
      { 'X-App-Password': 'test-secret' },
      { Authorization: 'Bearer test-secret' },
    ]) {
      const response = await fetch(`${server.base}/api/enrich/status`, { headers });
      assert.equal(response.status, 200, JSON.stringify(headers));
    }

    const legacyCookie = await fetch(`${server.base}/api/enrich/status`, {
      headers: { Cookie: 'pictaria_pw=test-secret' },
    });
    assert.equal(legacyCookie.status, 401);
  });

  await t.test('session login: wrong password 401s, right password sets an HttpOnly cookie that authorizes', async () => {
    const wrong = await fetch(`${server.base}/api/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'nope' }),
    });
    assert.equal(wrong.status, 401);

    const login = await fetch(`${server.base}/api/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'test-secret' }),
    });
    assert.equal(login.status, 200);
    const cookies = login.headers.getSetCookie();
    const session = cookies.find((cookie) => cookie.startsWith('pictaria_session='));
    assert.ok(session, 'session cookie set');
    assert.match(session, /HttpOnly/);
    assert.match(session, /SameSite=Lax/);
    // Default install speaks plain HTTP; a Secure cookie would break login.
    assert.ok(!/;\s*Secure/i.test(session), 'Secure only with SESSION_COOKIE_SECURE');
    // The legacy raw-password cookie is actively retired at login.
    assert.ok(cookies.some((cookie) => cookie.startsWith('pictaria_pw=;') || /pictaria_pw=.*Max-Age=0/.test(cookie)));

    const token = session.split(';')[0];
    const authorized = await fetch(`${server.base}/api/enrich/status`, { headers: { Cookie: token } });
    assert.equal(authorized.status, 200);

    // APP_PASSWORD alone must not be enough to mint a session. Before the
    // persisted signing secret, this exact construction was the fast offline
    // guessing oracle: derive a key from a password candidate, choose an
    // expiry, and test the forged cookie without touching the delayed login.
    const forgedExpires = String(Date.now() + 60_000);
    const forgedKey = createHmac('sha256', 'pictaria-session-v1').update('test-secret').digest();
    const forgedSignature = createHmac('sha256', forgedKey).update(forgedExpires).digest('hex');
    const forged = await fetch(`${server.base}/api/enrich/status`, {
      headers: { Cookie: `pictaria_session=${forgedExpires}.${forgedSignature}` },
    });
    assert.equal(forged.status, 401);

    // Even another Pictaria instance configured with the same password has a
    // different installation secret, so it cannot validate this session.
    const independent = await bootServer({ password: 'test-secret' });
    try {
      const wrongInstallation = await fetch(`${independent.base}/api/enrich/status`, { headers: { Cookie: token } });
      assert.equal(wrongInstallation.status, 401);
    } finally {
      await independent.stop();
    }

    // A restarted process for this installation reloads the persisted secret
    // and accepts the session. A real restart reuses the complete persistent
    // data directory; sharing only SETTINGS_PATH would be a split-brain
    // configuration that the persistent-state guard correctly refuses.
    const restarted = await bootServer({
      password: 'test-secret',
      dataDir: server.dir,
    });
    try {
      const acrossRestart = await fetch(`${restarted.base}/api/enrich/status`, { headers: { Cookie: token } });
      assert.equal(acrossRestart.status, 200);
    } finally {
      await restarted.stop();
    }

    // The signing key remains bound to APP_PASSWORD, so changing the password
    // still invalidates every outstanding session immediately.
    const changedPassword = await bootServer({
      password: 'different-secret',
      dataDir: server.dir,
    });
    try {
      const invalidated = await fetch(`${changedPassword.base}/api/enrich/status`, { headers: { Cookie: token } });
      assert.equal(invalidated.status, 401);
    } finally {
      await changedPassword.stop();
    }

    // Tampered and garbage tokens fail fast — an expired/broken session is
    // not a password guess, so no brute-force delay.
    const started = Date.now();
    const tampered = await fetch(`${server.base}/api/enrich/status`, {
      headers: { Cookie: `${token}ff` },
    });
    assert.equal(tampered.status, 401);
    assert.ok(Date.now() - started < 500);

    const logout = await fetch(`${server.base}/api/session`, {
      method: 'DELETE',
      headers: { Cookie: token, Origin: server.base },
    });
    assert.equal(logout.status, 200);
    assert.match(logout.headers.getSetCookie()[0], /pictaria_session=;.*Max-Age=0/);
  });

  await t.test('cookie-authenticated mutations require an exact same-host Origin', async () => {
    const login = await fetch(`${server.base}/api/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'test-secret' }),
    });
    const session = login.headers.getSetCookie().find((cookie) => cookie.startsWith('pictaria_session='));
    assert.ok(session, 'session cookie set');
    const cookie = session.split(';')[0];
    const body = JSON.stringify({ transcript: 'next photo' });

    const sameOrigin = await fetch(`${server.base}/api/voice/intent`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json', Origin: server.base },
      body,
    });
    assert.equal(sameOrigin.status, 200);

    // TLS commonly terminates at a reverse proxy, so the server can see an
    // HTTP connection while Host and the browser Origin still name the same
    // public authority. The scheme is deliberately not compared.
    const publicUrl = new URL(server.base);
    const proxiedHttps = await fetch(`${server.base}/api/voice/intent`, {
      method: 'POST',
      headers: {
        Cookie: cookie,
        'Content-Type': 'application/json',
        Origin: `https://${publicUrl.host}`,
      },
      body,
    });
    assert.equal(proxiedHttps.status, 200);

    // A matching Host and Origin are not sufficient when that browser
    // authority is an arbitrary public name (DNS-rebinding defense).
    const rebound = await rawHttpRequest({
      port: server.port,
      path: '/api/voice/intent',
      method: 'POST',
      headers: {
        Host: 'attacker.example',
        Cookie: cookie,
        'Content-Type': 'application/json',
        Origin: 'https://attacker.example',
      },
      body,
    });
    assert.equal(rebound.status, 421);
    assert.equal(JSON.parse(rebound.body).error.code, 'untrusted_browser_host');

    for (const origin of [undefined, 'null', 'https://evil.example', `http://${publicUrl.hostname}:${server.port + 1}`]) {
      const headers = { Cookie: cookie, 'Content-Type': 'application/json' };
      if (origin !== undefined) headers.Origin = origin;
      const response = await fetch(`${server.base}/api/voice/intent`, {
        method: 'POST',
        headers,
        body,
      });
      assert.equal(response.status, 403, String(origin));
      assert.equal((await response.json()).error.code, 'csrf_rejected');
    }

    // Custom credential headers cannot be emitted by a cross-origin form and
    // remain the supported path for Pictaria Frame and other API clients.
    for (const headers of [
      { 'X-App-Password': 'test-secret', Origin: 'https://evil.example' },
      { Authorization: 'Bearer test-secret' },
    ]) {
      const response = await fetch(`${server.base}/api/voice/intent`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body,
      });
      assert.equal(response.status, 200, JSON.stringify(headers));
    }

    const foreignLogout = await fetch(`${server.base}/api/session`, {
      method: 'DELETE',
      headers: {
        Cookie: cookie,
        Origin: 'https://evil.example',
        // Session-route CSRF classification must inspect only the ambient
        // cookie. An unrelated explicit credential must not move a password
        // comparison outside the authentication admission gate.
        'X-App-Password': 'wrong-value',
      },
    });
    assert.equal(foreignLogout.status, 403);
    assert.equal((await foreignLogout.json()).error.code, 'csrf_rejected');
    assert.equal(foreignLogout.headers.getSetCookie().length, 0);
  });

  await t.test('cookie-authenticated browser GETs reject foreign origins and sites', async () => {
    const login = await fetch(`${server.base}/api/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'test-secret' }),
    });
    const session = login.headers.getSetCookie().find((cookie) => cookie.startsWith('pictaria_session='));
    const cookie = session.split(';')[0];

    for (const headers of [
      { Cookie: cookie, Origin: 'null' },
      { Cookie: cookie, Origin: 'https://evil.example' },
      { Cookie: cookie, 'Sec-Fetch-Site': 'cross-site' },
      { Cookie: cookie, 'Sec-Fetch-Site': 'same-site' },
    ]) {
      const rejected = await fetch(`${server.base}/api/enrich/status`, { headers });
      assert.equal(rejected.status, 403, JSON.stringify(headers));
      assert.equal((await rejected.json()).error.code, 'csrf_rejected');
    }

    const rejectedHealth = await fetch(`${server.base}/api/health`, {
      headers: { Cookie: cookie, 'Sec-Fetch-Site': 'same-site' },
    });
    assert.equal(rejectedHealth.status, 403);
    assert.equal((await rejectedHealth.json()).error.code, 'csrf_rejected');

    for (const headers of [
      { Cookie: cookie, Origin: server.base, 'Sec-Fetch-Site': 'same-origin' },
      { Cookie: cookie, 'Sec-Fetch-Site': 'none' },
      { Cookie: cookie },
    ]) {
      const allowed = await fetch(`${server.base}/api/enrich/status`, { headers });
      assert.equal(allowed.status, 200, JSON.stringify(headers));
    }
  });

  await t.test('JSON request readers reject simple non-JSON content types', async () => {
    const response = await fetch(`${server.base}/api/voice/intent`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain', 'X-App-Password': 'test-secret' },
      body: JSON.stringify({ transcript: 'next photo' }),
    });
    assert.equal(response.status, 415);
    assert.equal((await response.json()).error.code, 'unsupported_media_type');
  });

  await t.test('baseline security headers ride on every response', async () => {
    for (const path of ['/', '/api/health']) {
      const response = await fetch(`${server.base}${path}`);
      assert.equal(response.headers.get('x-content-type-options'), 'nosniff', path);
      assert.equal(response.headers.get('x-frame-options'), 'DENY', path);
    }
  });

  await t.test('unknown API routes 404 with the error shape (authorized)', async () => {
    const response = await fetch(`${server.base}/api/definitely-not-a-route`, {
      headers: { 'X-App-Password': 'test-secret' },
    });
    assert.equal(response.status, 404);
    assert.equal((await response.json()).error.code, 'not_found');
  });

  await t.test('static files serve; nothing outside public/ is reachable', async () => {
    const index = await fetch(`${server.base}/`);
    assert.equal(index.status, 200);
    assert.match(await index.text(), /Pictaria/);

    // Dot segments are normalized by URL parsing, so this resolves inside
    // public/ (where no package.json exists) — it must 404, never serve the
    // repo root's package.json.
    const dotdot = await fetch(`${server.base}/../package.json`);
    assert.equal(dotdot.status, 404);

    // Encoded dots are never decoded on the file path — literal name, 404.
    const encoded = await fetch(`${server.base}/%2e%2e/package.json`);
    assert.equal(encoded.status, 404);

    const src = await fetch(`${server.base}/src/server.mjs`);
    assert.equal(src.status, 404);
  });
});

test('unexpected wake-word entries degrade custom storage without blocking restart', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'pictaria-wakeword-restart-'));
  const wakeWordDir = join(dataDir, 'wake-word-models');
  const headers = { 'X-App-Password': 'test-secret' };
  const scenarios = [
    {
      name: '.DS_Store',
      entryPath: join(wakeWordDir, '.DS_Store'),
      add: () => writeFileSync(join(wakeWordDir, '.DS_Store'), 'finder metadata'),
    },
    {
      name: 'atomic-save temporary file',
      entryPath: join(
        wakeWordDir,
        'registry.json.4242.00000000-0000-4000-8000-000000000000.tmp',
      ),
      add: () => writeFileSync(
        join(wakeWordDir, 'registry.json.4242.00000000-0000-4000-8000-000000000000.tmp'),
        'temporary registry',
      ),
    },
    {
      name: '@eaDir',
      entryPath: join(wakeWordDir, '@eaDir'),
      add: () => mkdirSync(join(wakeWordDir, '@eaDir')),
    },
    {
      name: 'unregistered model',
      entryPath: join(
        wakeWordDir,
        'models',
        '11111111-1111-4111-8111-111111111111.tflite',
      ),
      add: () => writeFileSync(
        join(wakeWordDir, 'models', '11111111-1111-4111-8111-111111111111.tflite'),
        'orphan model',
      ),
    },
  ];

  try {
    const initial = await bootServer({ password: 'test-secret', dataDir });
    await initial.stop();

    for (const scenario of scenarios) {
      scenario.add();
      const restarted = await bootServer({ password: 'test-secret', dataDir });
      try {
        const health = await fetch(`${restarted.base}/api/health`, { headers });
        assert.equal(health.status, 200, scenario.name);

        const settings = await fetch(`${restarted.base}/api/settings`, { headers });
        assert.equal(settings.status, 200, scenario.name);

        const wakeWord = await fetch(`${restarted.base}/api/frame/wake-word-models`, { headers });
        assert.equal(wakeWord.status, 503, scenario.name);
        assert.equal(
          (await wakeWord.json()).error.code,
          'wake_word_storage_unavailable',
          scenario.name,
        );
      } finally {
        await restarted.stop();
      }
      rmSync(scenario.entryPath, { recursive: true, force: true });
    }

    const healthy = await bootServer({ password: 'test-secret', dataDir });
    try {
      const wakeWord = await fetch(`${healthy.base}/api/frame/wake-word-models`, { headers });
      assert.equal(wakeWord.status, 200);
      assert.deepEqual((await wakeWord.json()).models, []);
    } finally {
      await healthy.stop();
    }
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

// For installs reached only through an HTTPS reverse proxy: the opt-in flag
// must mark both the login cookie and the logout clear as Secure.
test('SESSION_COOKIE_SECURE adds the Secure attribute to set and clear', async (t) => {
  const server = await bootServer({ password: 'test-secret', env: { SESSION_COOKIE_SECURE: 'true' } });
  t.after(() => server.stop());

  const login = await fetch(`${server.base}/api/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'test-secret' }),
  });
  assert.equal(login.status, 200);
  const session = login.headers.getSetCookie().find((cookie) => cookie.startsWith('pictaria_session='));
  assert.ok(session, 'session cookie set');
  assert.match(session, /;\s*Secure/);
  assert.match(session, /HttpOnly/);

  const logout = await fetch(`${server.base}/api/session`, { method: 'DELETE' });
  assert.equal(logout.status, 200);
  const cleared = logout.headers.getSetCookie()[0];
  assert.match(cleared, /pictaria_session=;.*Max-Age=0/);
  assert.match(cleared, /;\s*Secure/);
});

// Dedicated server: this test locks out 127.0.0.1, so it must not share an
// instance with the other auth tests.
test('repeated failed password attempts lock the client out with 429', async (t) => {
  const server = await bootServer({ password: 'test-secret' });
  t.after(() => server.stop());

  // Ten CONCURRENT wrong guesses (the per-attempt 1s delay runs in parallel,
  // which is exactly the bypass the shared limiter exists to close).
  const guesses = await Promise.all(
    Array.from({ length: 10 }, (_, index) =>
      fetch(`${server.base}/api/session`, {
        method: 'POST',
        // Spoofing a different forwarding value per request must not bypass
        // the default direct-peer limiter.
        headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': `198.51.100.${index + 1}` },
        body: JSON.stringify({ password: `wrong-${index}` }),
      })),
  );
  for (const guess of guesses) {
    assert.equal(guess.status, 401);
  }

  // Past the limit: locked out fast, password never evaluated — even the
  // RIGHT password is refused while the lockout stands.
  const started = Date.now();
  const locked = await fetch(`${server.base}/api/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'test-secret' }),
  });
  assert.equal(locked.status, 429);
  assert.equal((await locked.json()).error.code, 'too_many_attempts');
  assert.ok(Number(locked.headers.get('retry-after')) > 0);
  assert.ok(Date.now() - started < 500, 'lockout responses must not burn the delay');

  // An already-locked client is rejected from the headers alone. It cannot
  // keep a socket parked by starting a login body and never completing it.
  const partialStarted = Date.now();
  const partialLocked = await partialHttpRequest({
    port: server.port,
    path: '/api/session',
    headers: { 'Content-Type': 'application/json', 'Content-Length': '100' },
    body: '{"password":"',
  });
  assert.equal(partialLocked.status, 429);
  assert.equal(JSON.parse(partialLocked.body).error.code, 'too_many_attempts');
  assert.ok(Date.now() - partialStarted < 500, 'locked login must not wait for its body');

  // The generic API gate enforces the same lockout for credentialed attempts.
  const apiLocked = await fetch(`${server.base}/api/enrich/status`, {
    headers: { 'X-App-Password': 'test-secret' },
  });
  assert.equal(apiLocked.status, 429);

  // Credential-less requests (first page loads) stay a plain fast 401.
  const anonymous = await fetch(`${server.base}/api/enrich/status`);
  assert.equal(anonymous.status, 401);
});

test('login bodies have a small byte ceiling and elapsed-time deadline', async (t) => {
  const server = await bootServer({ password: 'test-secret' });
  t.after(() => server.stop());

  const oversized = await fetch(`${server.base}/api/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'x'.repeat(5 * 1024) }),
  });
  assert.equal(oversized.status, 413);
  assert.equal((await oversized.json()).error.code, 'payload_too_large');

  const started = Date.now();
  const timedOut = await partialHttpRequest({
    port: server.port,
    path: '/api/session',
    headers: { 'Content-Type': 'application/json', 'Content-Length': '100' },
    body: '{"password":"',
  });
  const elapsed = Date.now() - started;
  assert.equal(timedOut.status, 408);
  assert.equal(JSON.parse(timedOut.body).error.code, 'request_body_timeout');
  assert.ok(elapsed >= 4_500, `deadline fired too early: ${elapsed}ms`);
  assert.ok(elapsed < 7_000, `deadline did not bound the body read: ${elapsed}ms`);
});

test('unsupported expectations close incomplete request bodies', async (t) => {
  const server = await bootServer({ password: 'test-secret' });
  t.after(() => server.stop());

  const rejected = await partialHttpRequest({
    port: server.port,
    path: '/api/frame/state',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': '100',
      Expect: 'unsupported-expectation',
    },
    body: '{',
  });
  assert.equal(rejected.status, 417);
  assert.equal(rejected.headers.connection, 'close');
});

test('explicit health credentials share the password-attempt limiter', async (t) => {
  const server = await bootServer({ password: 'test-secret' });
  t.after(() => server.stop());

  const started = Date.now();
  const firstWrong = await fetch(`${server.base}/api/health`, {
    headers: { 'X-App-Password': 'wrong-first' },
  });
  assert.equal(firstWrong.status, 200);
  const trimmed = await firstWrong.json();
  assert.equal(trimmed.authRequired, true);
  assert.equal('providers' in trimmed, false);
  assert.ok(Date.now() - started >= 900, 'a wrong health credential receives the baseline delay');

  // A successful explicit health check clears this client's earlier failure.
  const successful = await fetch(`${server.base}/api/health`, {
    headers: { Authorization: 'Bearer test-secret' },
  });
  assert.equal(successful.status, 200);
  assert.equal('providers' in await successful.json(), true);

  // Ten new concurrent failures reach the per-client ceiling. They retain
  // the health endpoint's trimmed response; the next credentialed attempt is
  // rejected before password evaluation, exactly like the generic API gate.
  const guesses = await Promise.all(
    Array.from({ length: 10 }, (_, index) => fetch(`${server.base}/api/health`, {
      headers: { 'X-App-Password': `wrong-${index}` },
    })),
  );
  for (const guess of guesses) {
    assert.equal(guess.status, 200);
    assert.equal('providers' in await guess.json(), false);
  }

  const locked = await fetch(`${server.base}/api/health`, {
    headers: { 'X-App-Password': 'test-secret' },
  });
  assert.equal(locked.status, 429);
  assert.equal((await locked.json()).error.code, 'too_many_attempts');
  assert.ok(Number(locked.headers.get('retry-after')) > 0);

  // Credential-free liveness never consumes or consults the password budget.
  const anonymousStarted = Date.now();
  const anonymous = await fetch(`${server.base}/api/health`);
  assert.equal(anonymous.status, 200);
  assert.equal('providers' in await anonymous.json(), false);
  assert.ok(Date.now() - anonymousStarted < 500, 'credential-free health remains fast');
});

test('trusted proxy clients receive independent password lockouts', async (t) => {
  const server = await bootServer({ password: 'test-secret', env: { TRUSTED_PROXY_IPS: '127.0.0.1' } });
  t.after(() => server.stop());

  const guesses = await Promise.all(
    Array.from({ length: 10 }, (_, index) =>
      fetch(`${server.base}/api/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '198.51.100.10' },
        body: JSON.stringify({ password: `wrong-${index}` }),
      })),
  );
  for (const guess of guesses) {
    assert.equal(guess.status, 401);
  }

  const otherClient = await fetch(`${server.base}/api/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '198.51.100.11' },
    body: JSON.stringify({ password: 'test-secret' }),
  });
  assert.equal(otherClient.status, 200);

  const otherClientApi = await fetch(`${server.base}/api/enrich/status`, {
    headers: { 'X-App-Password': 'test-secret', 'X-Forwarded-For': '198.51.100.11' },
  });
  assert.equal(otherClientApi.status, 200);

  const lockedClient = await fetch(`${server.base}/api/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '198.51.100.10' },
    body: JSON.stringify({ password: 'test-secret' }),
  });
  assert.equal(lockedClient.status, 429);

  const lockedClientApi = await fetch(`${server.base}/api/enrich/status`, {
    headers: { 'X-App-Password': 'test-secret', 'X-Forwarded-For': '198.51.100.10' },
  });
  assert.equal(lockedClientApi.status, 429);
});

test('password attempts share a bounded global admission gate', async (t) => {
  const server = await bootServer({ password: 'test-secret', env: { TRUSTED_PROXY_IPS: '127.0.0.1' } });
  t.after(() => server.stop());

  const attempts = await Promise.all(
    Array.from({ length: 32 }, (_, index) => {
      const headers = { 'X-Forwarded-For': `198.51.100.${index + 1}` };
      if (index % 2 === 0) {
        return fetch(`${server.base}/api/session`, {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({ password: `wrong-${index}` }),
        });
      }
      return fetch(`${server.base}/api/enrich/status`, {
        headers: { ...headers, 'X-App-Password': `wrong-${index}` },
      });
    }),
  );
  const statuses = attempts.map((response) => response.status);
  assert.ok(statuses.includes(401), 'admitted invalid attempts keep the ordinary response');
  assert.ok(statuses.includes(429), 'overflow attempts are rejected instead of queued');
  assert.ok(statuses.every((status) => status === 401 || status === 429));

  const valid = await fetch(`${server.base}/api/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '198.51.100.200' },
    body: JSON.stringify({ password: 'test-secret' }),
  });
  assert.equal(valid.status, 200, 'a valid client succeeds after the admitted work drains');
});

test('global failure state preserves valid unrelated clients and marks further failures', async (t) => {
  const server = await bootServer({ password: 'test-secret', env: { TRUSTED_PROXY_IPS: '127.0.0.1' } });
  t.after(() => server.stop());

  const initialLogin = await fetch(`${server.base}/api/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '198.51.100.200' },
    body: JSON.stringify({ password: 'test-secret' }),
  });
  assert.equal(initialLogin.status, 200);
  const existingSession = initialLogin.headers.getSetCookie()
    .find((cookie) => cookie.startsWith('pictaria_session='))
    .split(';')[0];

  const guesses = await Promise.all(
    Array.from({ length: 100 }, (_, index) => {
      const client = Math.floor(index / 10) + 1;
      return fetch(`${server.base}/api/session`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Forwarded-For': `198.51.100.${client}`,
        },
        body: JSON.stringify({ password: `wrong-${index}` }),
      });
    }),
  );
  assert.ok(guesses.some((response) => response.status === 429));
  assert.ok(guesses.every((response) => response.status === 401 || response.status === 429));

  const correctLogin = await fetch(`${server.base}/api/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '198.51.100.11' },
    body: JSON.stringify({ password: 'test-secret' }),
  });
  assert.equal(correctLogin.status, 200);

  for (const headers of [
    { 'X-App-Password': 'test-secret', 'X-Forwarded-For': '198.51.100.11' },
    { Authorization: 'Bearer test-secret', 'X-Forwarded-For': '198.51.100.12' },
  ]) {
    const correctHeader = await fetch(`${server.base}/api/enrich/status`, { headers });
    assert.equal(correctHeader.status, 200);
  }

  const started = Date.now();
  const wrongHeader = await fetch(`${server.base}/api/enrich/status`, {
    headers: { 'X-App-Password': 'still-wrong', 'X-Forwarded-For': '198.51.100.11' },
  });
  assert.equal(wrongHeader.status, 429);
  assert.ok(Date.now() - started >= 900, 'globally marked failures retain the baseline delay');

  const personallyLocked = await fetch(`${server.base}/api/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '198.51.100.1' },
    body: JSON.stringify({ password: 'test-secret' }),
  });
  assert.equal(personallyLocked.status, 429);

  const sessionRequest = await fetch(`${server.base}/api/enrich/status`, {
    headers: { Cookie: existingSession },
  });
  assert.equal(sessionRequest.status, 200);

  const anonymous = await fetch(`${server.base}/api/enrich/status`);
  assert.equal(anonymous.status, 401);
  const staleSession = await fetch(`${server.base}/api/enrich/status`, {
    headers: { Cookie: 'pictaria_session=v2.0.invalid' },
  });
  assert.equal(staleSession.status, 401);
});

test('stale or malformed session cookies do not consume the password lockout budget', async (t) => {
  const server = await bootServer({ password: 'test-secret' });
  t.after(() => server.stop());

  // Old browser tabs and expired cookies are not password guesses. More than
  // the password-attempt limit must remain fast and must not lock the owner
  // out of a subsequent legitimate login.
  const started = Date.now();
  const malformed = ['%', '%2', '%GG', 'v2%ZZinvalid'];
  for (let index = 0; index < 24; index += 1) {
    const response = await fetch(`${server.base}/api/enrich/status`, {
      headers: {
        Cookie: `other=value; pictaria_session=${malformed[index % malformed.length]}; trailing=value`,
      },
    });
    assert.equal(response.status, 401);
  }
  assert.ok(Date.now() - started < 1_000, 'invalid sessions should not use the password-guess delay');

  const login = await fetch(`${server.base}/api/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'test-secret' }),
  });
  assert.equal(login.status, 200);

  const session = login.headers.getSetCookie()
    .find((cookie) => cookie.startsWith('pictaria_session='))
    .split(';')[0]
    .slice('pictaria_session='.length);
  const encoded = await fetch(`${server.base}/api/enrich/status`, {
    headers: { Cookie: `pictaria_session=${session.replaceAll('.', '%2E')}` },
  });
  assert.equal(encoded.status, 200, 'ordinary percent-encoded session tokens remain valid');
});

test('malformed percent escapes are rejected once before any route decodes a path segment', async (t) => {
  for (const password of ['test-secret', '']) {
    const server = await bootServer({ password });
    t.after(() => server.stop());
    const headers = password ? { 'X-App-Password': password } : {};

    for (const path of [
      '/api/frame/wake-word-models/%GG',
      '/api/albums/jobs/%E0%A4%A',
      '/api/albums/jobs/%/run',
    ]) {
      const response = await rawHttpRequest({ port: server.port, path, headers });
      assert.equal(response.status, 400);
      assert.equal(JSON.parse(response.body).error.code, 'invalid_path');
    }

    const validEncoding = await rawHttpRequest({
      port: server.port,
      path: '/api/frame/wake-word-models/%31%31%31%31%31%31%31%31-1111-4111-8111-111111111111',
      headers,
    });
    assert.notEqual(validEncoding.status, 400, 'valid percent-encoded route parameters remain supported');
  }
});

test('HTTP surface with no password (open mode)', async (t) => {
  const server = await bootServer({
    password: '',
    env: { BROWSER_ALLOWED_HOSTS: 'frame.example' },
  });
  t.after(() => server.stop());

  const health = await (await fetch(`${server.base}/api/health`)).json();
  assert.equal(health.authRequired, false);
  // Open mode: everything is reachable anyway, so health stays full —
  // handshake included.
  assert.equal('providers' in health, true);
  assert.equal(health.protocolVersion, 1);

  const response = await fetch(`${server.base}/api/enrich/status`);
  assert.equal(response.status, 200);

  for (const path of ['/api/health', '/api/enrich/status']) {
    const rebound = await rawHttpRequest({
      port: server.port,
      path,
      headers: { Host: 'attacker.example' },
    });
    assert.equal(rebound.status, 421, path);
    assert.equal(JSON.parse(rebound.body).error.code, 'untrusted_browser_host');
  }

  const configuredHost = await rawHttpRequest({
    port: server.port,
    path: '/api/enrich/status',
    headers: { Host: 'frame.example' },
  });
  assert.equal(configuredHost.status, 200);

  // Open mode trusts direct network clients, not unrelated websites using a
  // browser as a bridge. Origin covers fetch/XHR while Fetch Metadata covers
  // browser subresources and navigations that omit Origin. Native and
  // programmatic clients send neither and remain compatible.
  for (const origin of ['null', 'https://evil.example']) {
    const rejected = await fetch(`${server.base}/api/enrich/cancel`, {
      method: 'POST',
      headers: { Origin: origin },
    });
    assert.equal(rejected.status, 403, origin);
    assert.equal((await rejected.json()).error.code, 'csrf_rejected');
  }

  // Open-mode GETs share the same browser boundary: several GET routes can
  // dispatch upstream work or write derived metadata, so the central gate
  // protects every current and future API GET before feature routing.
  for (const origin of ['null', 'https://evil.example']) {
    for (const path of ['/api/health', '/api/enrich/status', '/api/albums/people?name=Alice']) {
      const rejected = await fetch(`${server.base}${path}`, {
        headers: { Origin: origin },
      });
      assert.equal(rejected.status, 403, `${origin} ${path}`);
      assert.equal((await rejected.json()).error.code, 'csrf_rejected');
    }
  }

  for (const headers of [{ Origin: server.base }, {}]) {
    const allowedRead = await fetch(`${server.base}/api/enrich/status`, { headers });
    assert.equal(allowedRead.status, 200, JSON.stringify(headers));
  }

  for (const site of ['cross-site', 'same-site']) {
    for (const path of ['/api/enrich/status', '/api/albums/people?name=Alice']) {
      const rejected = await fetch(`${server.base}${path}`, {
        headers: { 'Sec-Fetch-Site': site },
      });
      assert.equal(rejected.status, 403, `${site} ${path}`);
      assert.equal((await rejected.json()).error.code, 'csrf_rejected');
    }
  }

  for (const site of ['same-origin', 'none']) {
    const allowedRead = await fetch(`${server.base}/api/enrich/status`, {
      headers: { 'Sec-Fetch-Site': site },
    });
    assert.equal(allowedRead.status, 200, site);
  }

  const sameOriginMutation = await fetch(`${server.base}/api/enrich/cancel`, {
    method: 'POST',
    headers: { Origin: server.base },
  });
  assert.equal(sameOriginMutation.status, 200);

  const nativeMutation = await fetch(`${server.base}/api/insights/cancel`, { method: 'POST' });
  assert.equal(nativeMutation.status, 200);

  const foreignOpenLogin = await fetch(`${server.base}/api/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
    body: JSON.stringify({ password: 'anything' }),
  });
  assert.equal(foreignOpenLogin.status, 403);
  assert.equal((await foreignOpenLogin.json()).error.code, 'csrf_rejected');

  for (const origin of ['null', 'https://evil.example']) {
    const rejectedStream = await fetch(`${server.base}/api/frame/events?role=remote`, {
      headers: { Origin: origin },
    });
    assert.equal(rejectedStream.status, 403, origin);
    assert.equal((await rejectedStream.json()).error.code, 'csrf_rejected');
  }

  for (const headers of [{ Origin: server.base }, {}]) {
    const allowedStream = await fetch(`${server.base}/api/frame/events?role=remote`, { headers });
    assert.equal(allowedStream.status, 200, JSON.stringify(headers));
    assert.equal(allowedStream.headers.get('access-control-allow-origin'), null);
    await allowedStream.body.cancel();
  }

  // Login in open mode is a friendly no-op.
  const login = await fetch(`${server.base}/api/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'anything' }),
  });
  assert.equal(login.status, 200);
  assert.equal((await login.json()).authRequired, false);
});

// The 403 branch of the traversal guard is unreachable through a real URL
// (dot segments normalize first) — exercise it directly as defense in depth.
test('serveStaticFile refuses paths that escape the public dir', async () => {
  const { serveStaticFile } = await import('../../src/http.mjs');
  const writes = [];
  const response = {
    writeHead: (status) => writes.push(status),
    end: () => {},
  };
  const handled = await serveStaticFile(response, join(ROOT, 'public'), '/../package.json');
  assert.equal(handled, true);
  assert.deepEqual(writes, [403]);
});

// The health probe must validate the API key, not just reachability. Immich's
// /server/ping is public, so a reachable server would bless a revoked key. The
// probe uses the public server-version endpoint before /api-keys/me. This fake
// Immich supplies both contracts, rejects unknown keys, and reports each valid
// key's permission list. The settings PATCHes exercise the real re-point and
// cache-reset path.
test('health validates the Immich version, key, and required permissions', async (t) => {
  const { createServer } = await import('node:http');
  const keys = {
    'good-key': { permissions: ['all'] },
    'limited-key': { permissions: ['asset.read', 'tag.read'] },
    'missing-capability-key': { permissions: ['all'], missingCapability: true },
  };
  const fakeImmich = createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');
    const keyName = request.headers['x-api-key'];
    if (url.pathname === '/api/server/version') {
      response.writeHead(200, { 'content-type': 'application/json' });
      if (keyName === 'v1-key') {
        response.end('{"major":1,"minor":132,"patch":3,"prerelease":null}');
      } else if (keyName === 'malformed-version-key') {
        response.end('{"major":"3","minor":1,"patch":0}');
      } else {
        response.end('{"major":3,"minor":1,"patch":0,"prerelease":null}');
      }
      return;
    }
    if (url.pathname === '/api/api-keys/me') {
      const key = keys[keyName];
      if (key?.missingCapability) {
        response.writeHead(404, { 'content-type': 'application/json' });
        response.end('{"message":"not found"}');
        return;
      }
      if (!key) {
        response.writeHead(401, { 'content-type': 'application/json' });
        response.end('{"message":"Invalid API key"}');
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ id: 'k1', name: 'test', permissions: key.permissions }));
      return;
    }
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end('{"message":"not found"}');
  });
  await new Promise((resolve) => fakeImmich.listen(0, '127.0.0.1', resolve));
  const immichPort = fakeImmich.address().port;
  t.after(() => new Promise((resolve) => fakeImmich.close(resolve)));

  const server = await bootServer({
    password: 'test-secret',
    env: { IMMICH_BASE_URL: `http://127.0.0.1:${immichPort}`, IMMICH_API_KEY: 'good-key' },
  });
  t.after(() => server.stop());

  const authed = { 'X-App-Password': 'test-secret' };
  const patchSettings = async (values) => {
    const response = await fetch(`${server.base}/api/settings`, {
      method: 'PATCH',
      headers: { ...authed, 'Content-Type': 'application/json' },
      body: JSON.stringify({ server: values }),
    });
    assert.equal(response.status, 200);
  };
  const health = async () => (await fetch(`${server.base}/api/health`, { headers: authed })).json();

  await t.test('a valid key with full access is connected', async () => {
    const body = await health();
    assert.equal(body.immich, 'connected');
    assert.equal(body.immichVersion, '3.1.0');
    assert.deepEqual(body.immichMissingPermissions, []);
  });

  await t.test('an invalid key is unauthorized, not unreachable', async () => {
    await patchSettings({ immichApiKey: 'bad-key' });
    const body = await health();
    assert.equal(body.immich, 'unauthorized');
    assert.equal(body.immichVersion, '3.1.0');
  });

  await t.test('a valid key without the documented permissions names them', async () => {
    await patchSettings({ immichApiKey: 'limited-key' });
    const body = await health();
    assert.equal(body.immich, 'missing_permissions');
    assert.ok(body.immichMissingPermissions.includes('asset.view'));
    assert.ok(body.immichMissingPermissions.includes('album.create'));
    assert.ok(!body.immichMissingPermissions.includes('asset.read')); // granted
    // Conditional: write-backs are off, so asset.update is not demanded.
    assert.ok(!body.immichMissingPermissions.includes('asset.update'));
  });

  await t.test('Immich 1.x is reported as an incompatible version', async () => {
    await patchSettings({ immichApiKey: 'v1-key' });
    const body = await health();
    assert.equal(body.immich, 'incompatible_version');
    assert.equal(body.immichVersion, '1.132.3');
  });

  await t.test('a malformed version response is an incompatible API', async () => {
    await patchSettings({ immichApiKey: 'malformed-version-key' });
    const body = await health();
    assert.equal(body.immich, 'incompatible_api');
    assert.equal(body.immichVersion, null);
  });

  await t.test('a missing 2.0 capability is incompatible rather than unreachable', async () => {
    await patchSettings({ immichApiKey: 'missing-capability-key' });
    const body = await health();
    assert.equal(body.immich, 'incompatible_api');
    assert.equal(body.immichVersion, '3.1.0');
  });

  await t.test('a dead host is unreachable', async () => {
    await patchSettings({ immichApiKey: 'good-key', immichBaseUrl: 'http://127.0.0.1:9' });
    assert.equal((await health()).immich, 'unreachable');
  });
});
