// One in-process tag mutation boundary. Human actions jump ahead of queued
// background slices; network work already in flight is never interrupted.
export class TagWriteCoordinator {
  #busy = false;
  #waiting = [];

  async run(work, { priority = 1 } = {}) {
    await new Promise(resolve => {
      this.#waiting.push({ priority, resolve });
      this.#next();
    });
    try { return await work(); }
    finally { this.#busy = false; this.#next(); }
  }

  #next() {
    if (this.#busy || !this.#waiting.length) return;
    this.#waiting.sort((a, b) => b.priority - a.priority);
    this.#busy = true;
    this.#waiting.shift().resolve();
  }
}
