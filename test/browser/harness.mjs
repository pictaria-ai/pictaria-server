import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Zero-dependency headless-browser harness: system Chrome/Chromium driven
// over raw CDP with Node's builtin WebSocket client. No npm packages — the
// suite skips (never fails) on machines without a Chrome binary; set
// PICTARIA_CHROME_BIN to point at a non-standard install.

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const CHROME_CANDIDATES = [
  process.env.PICTARIA_CHROME_BIN,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/snap/bin/chromium',
].filter(Boolean);

export function findChrome() {
  return CHROME_CANDIDATES.find((path) => existsSync(path)) ?? null;
}

function delay(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

class Page {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id && this.pending.has(message.id)) {
        const { resolve: resolveCall, reject: rejectCall } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) {
          rejectCall(new Error(`${message.error.message} (${message.error.code})`));
        } else {
          resolveCall(message.result);
        }
      }
    });
    socket.addEventListener('close', () => {
      for (const { reject: rejectCall } of this.pending.values()) {
        rejectCall(new Error('CDP socket closed'));
      }
      this.pending.clear();
    });
  }

  send(method, params = {}) {
    // A send() on a non-open socket is silently discarded by WebSocket, so
    // the caller would await forever; fail loudly instead (Chrome died).
    if (this.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('CDP socket closed'));
    }
    const id = this.nextId++;
    return new Promise((resolveCall, rejectCall) => {
      this.pending.set(id, { resolve: resolveCall, reject: rejectCall });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  // readyState alone is not enough: it would be read from the OLD document
  // (already "complete") before the navigation commits. The sentinel only
  // exists on the old document, so waiting for it to vanish AND readyState
  // to complete guarantees the NEW document's end-of-body scripts have run
  // before the caller starts clicking.
  async navigate(url) {
    await this.evaluate('window.__pictariaNavSentinel = true');
    await this.send('Page.navigate', { url });
    await this.waitFor(
      '!window.__pictariaNavSentinel && document.readyState === "complete"',
      { label: `load ${url}` },
    );
  }

  // Evaluates an expression in the page; promises are awaited, values come
  // back JSON-serialized.
  async evaluate(expression) {
    const { result, exceptionDetails } = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (exceptionDetails) {
      throw new Error(exceptionDetails.exception?.description
        ?? exceptionDetails.text ?? 'evaluate failed');
    }
    return result.value;
  }

  // Polls until the expression is truthy and returns its value. Navigation
  // mid-poll (the gate reloads the page after login) destroys the JS
  // context; ONLY those errors count as "not yet" — a closed CDP socket
  // means Chrome died and must fail immediately, not time out opaquely.
  async waitFor(expression, { timeoutMs = 15000, label = expression } = {}) {
    const start = Date.now();
    for (;;) {
      try {
        const value = await this.evaluate(expression);
        if (value) {
          return value;
        }
      } catch (error) {
        if (!/execution context|context was destroyed|cannot find context|target navigated/i
          .test(String(error.message))) {
          throw error;
        }
      }
      if (Date.now() - start > timeoutMs) {
        throw new Error(`timed out after ${timeoutMs}ms waiting for: ${label}`);
      }
      await delay(100);
    }
  }
}

export async function launchChrome() {
  const bin = findChrome();
  if (!bin) {
    return null;
  }
  const hasProcessGroup = process.platform !== 'win32';
  const profileDir = mkdtempSync(join(tmpdir(), 'pictaria-chrome-'));
  const child = spawn(bin, [
    '--headless',
    '--remote-debugging-port=0',
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-gpu',
    '--hide-scrollbars',
    '--window-size=1400,1000',
    // Chrome refuses to start as root (CI containers) without this.
    ...(process.getuid?.() === 0 ? ['--no-sandbox'] : []),
    'about:blank',
  ], {
    stdio: ['ignore', 'ignore', 'pipe'],
    // Chrome fans out into subprocesses on Linux. Its own process group lets
    // cleanup terminate the whole test-only tree instead of orphaning writers
    // that keep recreating profile files after the parent has exited.
    detached: hasProcessGroup,
  });

  let stopPromise;
  function stopChrome() {
    stopPromise ??= (async () => {
      const parentRunning = child.exitCode === null && child.signalCode === null;
      const parentExit = parentRunning
        ? new Promise((resolveExit) => child.once('exit', resolveExit))
        : null;
      try {
        if (hasProcessGroup) {
          process.kill(-child.pid, 'SIGKILL');
        } else if (parentRunning) {
          child.kill('SIGKILL');
        }
      } catch (error) {
        if (error?.code !== 'ESRCH') {
          throw error;
        }
      }
      if (parentExit) {
        await parentExit;
      }
      // Chrome's Linux subprocesses can finish touching profile files just
      // after the parent exits. Node's bounded ENOTEMPTY retry handles that
      // documented rimraf race without hiding a persistent cleanup failure.
      rmSync(profileDir, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 100,
      });
    })();
    return stopPromise;
  }

  // Chrome announces the browser endpoint on stderr; the port was picked by
  // the OS (--remote-debugging-port=0), so this line is the only source.
  let httpBase;
  try {
    httpBase = await new Promise((resolvePromise, rejectPromise) => {
      let stderr = '';
      const timer = setTimeout(() => {
        rejectPromise(new Error(`Chrome did not announce DevTools:\n${stderr}`));
      }, 45000);
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
        const match = /DevTools listening on ws:\/\/([^:]+):(\d+)\//.exec(stderr);
        if (match) {
          clearTimeout(timer);
          resolvePromise(`http://${match[1]}:${match[2]}`);
        }
      });
      child.on('exit', () => {
        clearTimeout(timer);
        rejectPromise(new Error(`Chrome exited during startup:\n${stderr}`));
      });
    });
  } catch (error) {
    await stopChrome();
    throw error;
  }

  async function newPage() {
    // Newer Chrome wants PUT on /json/new; older builds only accept GET.
    let response = await fetch(`${httpBase}/json/new?about:blank`, { method: 'PUT' });
    if (!response.ok) {
      response = await fetch(`${httpBase}/json/new?about:blank`);
    }
    const target = await response.json();
    const socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolvePromise, rejectPromise) => {
      socket.addEventListener('open', resolvePromise, { once: true });
      socket.addEventListener('error', () => rejectPromise(new Error('CDP connect failed')), { once: true });
    });
    const page = new Page(socket);
    await page.send('Page.enable');
    await page.send('Runtime.enable');
    return page;
  }

  return { newPage, stop: stopChrome };
}

// A stand-in for Immich so pages that require a configured connection work
// end-to-end. Unfiltered metadata searches return the caller's assets (the
// same ones seeded into insights.sqlite, so a boot-time resweep republishes
// identical data); filtered searches return nothing, keeping album creation
// from adding assets. Album creation answers with a fresh id.
export async function startFakeImmich({ assets = [] } = {}) {
  let albumCounter = 0;
  const server = createServer((request, response) => {
    let raw = '';
    request.on('data', (chunk) => { raw += chunk; });
    request.on('end', () => {
      let body = {};
      try {
        body = raw ? JSON.parse(raw) : {};
      } catch {
        body = {};
      }
      const { pathname } = new URL(request.url, 'http://immich.fake');
      const reply = (payload) => {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify(payload));
      };
      if (pathname === '/api/search/metadata') {
        const filtered = Boolean(body.country || body.city || body.state || body.make || body.model);
        const items = filtered ? [] : assets;
        reply({ assets: { items, nextPage: null, total: items.length, count: items.length } });
        return;
      }
      if (pathname === '/api/albums' && request.method === 'POST') {
        albumCounter += 1;
        reply({ id: `fake-album-${albumCounter}`, albumName: body.albumName ?? 'album' });
        return;
      }
      if (pathname === '/api/albums') {
        reply([]);
        return;
      }
      if (pathname === '/api/tags') {
        reply([]);
        return;
      }
      if (pathname.startsWith('/api/people')) {
        reply({ people: [], total: 0, hasNextPage: false });
        return;
      }
      if (pathname === '/api/search/statistics') {
        reply({ total: 0 });
        return;
      }
      reply({});
    });
  });
  await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise));
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    stop() {
      return new Promise((resolvePromise) => server.close(resolvePromise));
    },
  };
}

// Boots src/server.mjs as a child against a caller-prepared temp data dir —
// seed the databases into `dir` first, then boot. Every data path points
// into `dir`; the production data directory is never touched.
export async function bootServer(dir, { password = 'smoke-secret', env = {} } = {}) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const port = 20000 + Math.floor(Math.random() * 20000);
    const child = spawn(process.execPath, ['src/server.mjs'], {
      cwd: ROOT,
      env: {
        ...process.env,
        HOST: '127.0.0.1',
        PORT: String(port),
        APP_PASSWORD: password,
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
        // Caller overrides win — the browser suite points IMMICH_* at its
        // fake Immich, for example.
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    let exited = false;
    child.on('exit', () => { exited = true; });

    const stop = async () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM');
        await new Promise((resolveExit) => child.once('exit', resolveExit));
      }
    };

    let collision = false;
    for (let i = 0; i < 100 && !exited; i += 1) {
      try {
        const health = await fetch(`http://127.0.0.1:${port}/api/health`);
        if (health.ok) {
          // Identity probe: another concurrently-booted test server could own
          // this random port (our child then dies on EADDRINUSE). Only OUR
          // server accepts our password — a 401 means wrong server, retry.
          const probe = await fetch(`http://127.0.0.1:${port}/api/session`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password }),
          });
          if (!probe.ok) {
            collision = true;
            break;
          }
          return { base: `http://127.0.0.1:${port}`, stop };
        }
      } catch {
        // not up yet
      }
      await delay(100);
    }
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await new Promise((resolveExit) => child.once('exit', resolveExit));
    }
    if (!collision && !/EADDRINUSE/.test(stderr)) {
      throw new Error(`server did not start:\n${stderr}`);
    }
  }
  throw new Error('no free port after 3 attempts');
}
