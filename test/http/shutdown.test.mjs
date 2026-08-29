import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

// The shutdown lifecycle over a real process: the server boots against temp
// dirs with its background machinery armed — scheduler (2s boot kick),
// insights auto-refresh (30s boot check), thumbhash backfill (15s), backup
// enabled (hourly interval + 60s boot tick) — then receives SIGTERM while
// every one of those timers is still pending. It must exit 0 promptly
// through the phased path, never the 5s force-exit guard.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

// Well under the server's 5s force-exit guard: a graceful pass with no work
// in flight is near-instant, and reaching the guard means a phase hung.
const EXIT_BUDGET_MS = 4500;

async function bootServer() {
  const dir = mkdtempSync(join(tmpdir(), 'pictaria-shutdown-'));
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const port = 20000 + Math.floor(Math.random() * 20000);
    const child = spawn(process.execPath, ['src/server.mjs'], {
      cwd: ROOT,
      env: {
        ...process.env,
        HOST: '127.0.0.1',
        PORT: String(port),
        APP_PASSWORD: '', // open mode: the SSE test needs cookie-less access
        ALLOW_INSECURE_OPEN: 'true',
        DATABASE_PATH: join(dir, 'enrichment.sqlite'),
        INSIGHTS_DB_PATH: join(dir, 'insights.sqlite'),
        FRAME_DB_PATH: join(dir, 'frame.db'),
        ALBUMS_DATA_FILE: join(dir, 'albums.json'),
        SETTINGS_PATH: join(dir, 'settings.json'),
        WAKE_WORD_MODELS_DIR: join(dir, 'wake-word-models'),
        BACKUP_DIR: join(dir, 'backups'),
        // Backups ON so the hourly interval and the 60s boot tick are armed
        // and must be owned (cleared) by shutdown.
        BACKUP_ENABLED: 'true',
        IMMICH_BASE_URL: '',
        IMMICH_API_KEY: '',
        ENRICH_ENABLED: 'false',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    let exited = false;
    const exit = new Promise((resolveExit) => {
      child.on('exit', (code, signal) => {
        exited = true;
        resolveExit({ code, signal });
      });
    });

    for (let i = 0; i < 100 && !exited; i += 1) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/health`);
        if (response.ok) {
          return {
            child,
            base: `http://127.0.0.1:${port}`,
            databasePath: join(dir, 'enrichment.sqlite'),
            exit,
            stdout: () => stdout,
            stderr: () => stderr,
            cleanup() {
              try { child.kill('SIGKILL'); } catch { /* already gone */ }
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

function withTimeout(promise, ms, label) {
  let timer = null;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(label)), ms);
      timer.unref?.();
    }),
  ]).finally(() => clearTimeout(timer));
}

test('SIGTERM with every boot timer pending drains and exits 0 inside the budget', async (t) => {
  const server = await bootServer();
  t.after(() => server.cleanup());

  // Killed within ~1s of boot: the scheduler kick (2s), backfill (15s),
  // insights check (30s), and backup tick (60s) are ALL still pending.
  const started = Date.now();
  server.child.kill('SIGTERM');
  const { code } = await withTimeout(server.exit, EXIT_BUDGET_MS, 'server did not exit within the shutdown budget');
  const elapsed = Date.now() - started;

  assert.equal(code, 0, `expected a clean exit\nstderr:\n${server.stderr()}`);
  assert.ok(elapsed < EXIT_BUDGET_MS, `graceful shutdown took ${elapsed}ms`);
  assert.match(server.stdout(), /Shutting down: SIGTERM/);
  // The graceful path, not the guard — and with nothing in flight, no
  // laggard warnings and no database-close complaints either.
  assert.doesNotMatch(server.stderr(), /Forced shutdown/);
  assert.doesNotMatch(server.stderr(), /did not drain/);
  assert.doesNotMatch(server.stderr(), /Could not close a database/);

  const database = new DatabaseSync(server.databasePath, { readOnly: true });
  const lifecycleEvents = database
    .prepare("SELECT type, outcome, detail_json FROM activity_log WHERE category = 'system' ORDER BY id")
    .all();
  database.close();
  assert.deepEqual(lifecycleEvents.map((event) => event.type), ['system.start', 'system.stop']);
  assert.equal(lifecycleEvents[1].outcome, 'succeeded');
  assert.deepEqual(JSON.parse(lifecycleEvents[1].detail_json), { reason: 'SIGTERM', exitCode: 0 });
});

test('a second SIGTERM during shutdown is a safe no-op', async (t) => {
  const server = await bootServer();
  t.after(() => server.cleanup());

  server.child.kill('SIGTERM');
  server.child.kill('SIGTERM');
  const { code } = await withTimeout(server.exit, EXIT_BUDGET_MS, 'server did not exit within the shutdown budget');

  assert.equal(code, 0, `expected a clean exit\nstderr:\n${server.stderr()}`);
  const announcements = server.stdout().match(/Shutting down:/g) ?? [];
  assert.equal(announcements.length, 1, 'shutdown must only run once');
});

test('an open SSE subscription does not hold shutdown open', async (t) => {
  const server = await bootServer();
  t.after(() => server.cleanup());

  // A live event-stream connection — exactly what would park server.close()
  // forever if the hub were not closed first (phase 4).
  const response = await fetch(`${server.base}/api/frame/events?role=remote`, {
    headers: { accept: 'text/event-stream' },
  });
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  const first = await withTimeout(reader.read(), 2000, 'no initial SSE frame');
  assert.match(Buffer.from(first.value).toString(), /connected/);

  server.child.kill('SIGTERM');
  const { code } = await withTimeout(server.exit, EXIT_BUDGET_MS, 'SSE stream held shutdown past its budget');
  assert.equal(code, 0, `expected a clean exit\nstderr:\n${server.stderr()}`);
  assert.doesNotMatch(server.stderr(), /Forced shutdown/);

  // The stream was ended by the server, not abandoned.
  await withTimeout(
    (async () => {
      for (;;) {
        const { done } = await reader.read().catch(() => ({ done: true }));
        if (done) return;
      }
    })(),
    2000,
    'SSE stream never ended',
  );
});
