// Shutdown plumbing shared by server.mjs and its background services:
// timers the shutdown sequence can clear en masse, a registry of stoppable
// services drained in parallel with per-service budgets, and the bounded
// wait the services' stop() contracts are built on. Node built-ins only;
// deliberately boring.

// Wait for a promise for at most timeoutMs. Resolves true when the promise
// settled in time (fulfilled OR rejected — settled is settled), false when
// the budget ran out. Cooperative work can't be aborted, only abandoned, so
// a false here means "it may still be running".
export async function awaitDrain(promise, timeoutMs) {
  if (!promise) {
    return true;
  }
  const timedOut = Symbol('timedOut');
  let timer = null;
  try {
    const outcome = await Promise.race([
      Promise.resolve(promise).then(() => true, () => true),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(timedOut), timeoutMs);
        // This deadline is part of the awaited shutdown contract. Keeping it
        // referenced prevents Node from exiting when the drain target itself
        // has no active handles (for example, a stalled network promise).
      }),
    ]);
    return outcome !== timedOut;
  } finally {
    clearTimeout(timer);
  }
}

// One object owns everything shutdown has to unwind:
//   - setTimeout/setInterval register their timers so clearTimers() can
//     retire every delayed callback in one move;
//   - register(name, budgetMs, stop) enrolls a service whose stop(timeoutMs)
//     signals cancellation synchronously and resolves once its in-flight
//     work drains (returning false when it gave up waiting);
//   - drainServices() runs every stop() in parallel and names the laggards.
export function createLifecycle({ warn = (message) => console.warn(message) } = {}) {
  const timers = new Set();
  const services = [];
  let stopped = false;

  async function drainService({ name, budgetMs, stop }) {
    let timer = null;
    try {
      const outcome = await Promise.race([
        // async wrapper: a synchronously-throwing stop() must land in the
        // rejection handler below, not blow up the whole drain pass.
        (async () => stop(budgetMs))().then(
          (result) => (result === false ? 'timeout' : 'drained'),
          (error) => {
            warn(`[Pictaria] Shutdown: ${name} stop() failed: ${error?.message ?? error}`);
            return 'failed';
          },
        ),
        // Backstop for a stop() that ignores its budget; the grace keeps a
        // well-behaved bounded wait (which resolves at exactly budgetMs)
        // from losing a photo finish to its own referee.
        new Promise((resolve) => {
          timer = setTimeout(() => resolve('timeout'), budgetMs + 500);
          // Like awaitDrain's deadline, this must keep the bounded shutdown
          // wait alive when the stalled stop() owns no referenced handles.
        }),
      ]);
      if (outcome === 'timeout') {
        // The debugging breadcrumb: when a late write from an abandoned
        // drain hits a closed database, this line says whose write it was.
        warn(`[Pictaria] Shutdown: ${name} did not drain within ${budgetMs}ms — abandoning it; a late write from it may land after the databases close.`);
      }
      return outcome;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    get stopped() {
      return stopped;
    },

    // Timers registered here never hold the process open (always unref'd)
    // and never fire once shutdown has begun.
    setTimeout(fn, ms) {
      const timer = setTimeout(() => {
        timers.delete(timer);
        if (stopped) {
          return; // raced clearTimers(); shutdown means no new work
        }
        fn();
      }, ms);
      timer.unref?.();
      timers.add(timer);
      return timer;
    },

    setInterval(fn, ms) {
      const timer = setInterval(() => {
        if (stopped) {
          return;
        }
        fn();
      }, ms);
      timer.unref?.();
      timers.add(timer);
      return timer;
    },

    register(name, budgetMs, stop) {
      services.push({ name, budgetMs, stop });
    },

    // Shutdown phase "no delayed callback may start new work": the flag
    // flips before the clears so a callback already dequeued onto the event
    // loop sees `stopped` and does nothing instead of re-arming anything.
    clearTimers() {
      stopped = true;
      for (const timer of timers) {
        clearTimeout(timer); // clears intervals too
      }
      timers.clear();
    },

    // Signal + drain: each stop() sets its cancel flag synchronously before
    // its first await, so *starting* the drains doubles as the cancel
    // broadcast; the returned promise is the bounded parallel wait.
    drainServices() {
      return Promise.allSettled(services.map((service) => drainService(service)));
    },
  };
}
