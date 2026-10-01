import test from 'node:test';
import assert from 'node:assert/strict';
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
