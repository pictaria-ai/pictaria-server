import { awaitDrain } from '../../src/lifecycle.mjs';

// Killing a detached Chrome group does not guarantee Node delivers the
// parent's exit event. Never let a missed event hang browser-test teardown.
export async function terminateTestProcess(child, {
  kill,
  timeoutMs = 3000,
  warn = message => console.warn(message),
}) {
  const running = child.exitCode === null && child.signalCode === null;
  let onExit;
  const exited = running ? new Promise(resolve => {
    onExit = resolve;
    child.once('exit', onExit);
  }) : null;
  try {
    // Still kill the group if the parent already exited: helpers can remain.
    try { kill(); }
    catch (error) { if (error?.code !== 'ESRCH') throw error; }
    if (exited && !await awaitDrain(exited, timeoutMs)) {
      warn('Browser test cleanup: Chrome exit was not observed within the shutdown deadline; continuing cleanup after SIGKILL.');
    }
    // Chrome helpers can retain stderr even AFTER the parent's exit event.
    // Closing this test-owned pipe lets Node retire the ChildProcess handles
    // rather than waiting for EOF from an orphaned helper.
    child.stderr?.destroy();
    child.unref();
  } finally {
    if (onExit) child.removeListener('exit', onExit);
  }
}
