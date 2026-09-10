import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { terminateTestProcess } from './processCleanup.mjs';

function fakeChild() {
  const child = new EventEmitter();
  Object.assign(child, { exitCode: null, signalCode: null, released: false, stderrClosed: false });
  child.unref = () => { child.released = true; };
  child.stderr = { destroy: () => { child.stderrClosed = true; } };
  return child;
}

test('Chrome cleanup observes an exit delivered during the kill and removes its listener', async () => {
  const child = fakeChild(); const warnings = [];
  await terminateTestProcess(child, { kill: () => child.emit('exit', null, 'SIGKILL'), warn: message => warnings.push(message) });
  assert.equal(child.listenerCount('exit'), 0);
  assert.equal(child.released, true); assert.equal(child.stderrClosed, true);
  assert.deepEqual(warnings, []);
});

test('a missing Chrome exit event has a bounded wait and releases only test-owned handles', { timeout: 1000 }, async () => {
  const child = fakeChild(); const warnings = [];
  await terminateTestProcess(child, { kill() {}, timeoutMs: 10, warn: message => warnings.push(message) });
  assert.equal(child.released, true); assert.equal(child.stderrClosed, true);
  assert.equal(child.listenerCount('exit'), 0);
  assert.equal(warnings.length, 1); assert.match(warnings[0], /continuing cleanup after SIGKILL/);
});

test('Chrome group cleanup still runs after the parent exits; ESRCH is harmless', async () => {
  const child = fakeChild(); child.exitCode = 0; let killed = false;
  await terminateTestProcess(child, { kill() { killed = true; throw Object.assign(new Error('gone'), { code: 'ESRCH' }); } });
  assert.equal(killed, true); assert.equal(child.listenerCount('exit'), 0); assert.equal(child.released, true);
  assert.equal(child.stderrClosed, true);
});

test('Chrome cleanup does not conceal an actual kill failure', async () => {
  const child = fakeChild(); const denied = Object.assign(new Error('denied'), { code: 'EPERM' });
  await assert.rejects(terminateTestProcess(child, { kill() { throw denied; } }), error => error === denied);
  assert.equal(child.released, false); assert.equal(child.listenerCount('exit'), 0);
});
