import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { cleanupAfter } from './harness.mjs';

// A fake test context: the hook must be registered before anything starts.
function context() {
  const t = { hook: null, after(fn) { t.hook = fn; } };
  return t;
}

test('test cleanup registers first, stops newest first and keeps going past a failure', async () => {
  const t = context(), stopped = [];
  const track = cleanupAfter(t);
  assert.equal(typeof t.hook, 'function');
  const server = track({ stop: async () => { stopped.push('server'); } });
  track(() => { stopped.push('fake'); throw new Error('fake did not close'); });
  track({ stop: () => { stopped.push('browser'); } });
  assert.equal(typeof server.stop, 'function', 'track returns the resource');
  await assert.rejects(t.hook(), /fake did not close/);
  assert.deepEqual(stopped, ['browser', 'fake', 'server']);
});

test('test cleanup reports every failure', async () => {
  const t = context(), track = cleanupAfter(t);
  track(() => { throw new Error('first'); }); track(() => { throw new Error('second'); });
  await assert.rejects(t.hook(), error => error instanceof AggregateError &&
    error.errors.map(e => e.message).join() === 'second,first');
});

test('a resource that finishes starting after its test ended is stopped at once', async () => {
  const t = context(), track = cleanupAfter(t), stopped = Promise.withResolvers();
  await t.hook();
  const late = { stop: () => stopped.resolve('stopped') };
  assert.equal(track(late), late);
  assert.equal(await Promise.race([stopped.promise, delay(1000, 'still running', { ref: false })]), 'stopped');
});

// node:test keeps running a timed-out test's body, so a server or Chrome that
// was still starting arrives after cleanup has finished. It must not keep the
// test file's process alive.
test('a test file still exits when its test times out while a resource is starting', { timeout: 20000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'pictaria-late-cleanup-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'late.test.mjs');
  writeFileSync(file, `import test from 'node:test';
import { createServer } from 'node:http';
import { cleanupAfter } from ${JSON.stringify(new URL('./harness.mjs', import.meta.url).href)};
test('times out while a listener is still starting', { timeout: 50 }, async (t) => {
  const track = cleanupAfter(t);
  track(await new Promise((resolve) => setTimeout(() => {
    const listener = createServer().listen(0, '127.0.0.1', () =>
      resolve({ stop: () => new Promise((done) => listener.close(done)) }));
  }, 300)));
});
`);
  // Run it as a standalone file, not as a child of this test runner.
  const { NODE_TEST_CONTEXT, ...env } = process.env;
  const child = spawn(process.execPath, [file], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  const exit = once(child, 'exit');
  const exited = await Promise.race([exit.then(() => true), delay(10000, false, { ref: false })]);
  if (!exited) {
    child.kill('SIGKILL');
    await exit;
  }
  assert.equal(exited, true, `the test file did not exit on its own:\n${output}`);
  assert.equal(child.exitCode, 1);
  assert.match(output, /timed out after 50ms/);
});
