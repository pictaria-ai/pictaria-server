import { timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import { join } from 'node:path';

import { loadConfig, missingImmichSettings, validateServerAuthConfig } from './config.mjs';
import { createAuthAdmissionGate, createAuthFailureLimiter } from './authFailureLimiter.mjs';
import { awaitDrain, createLifecycle } from './lifecycle.mjs';
import { handleBodyError, readJsonBody, sendError, sendJson, serveStaticFile } from './http.mjs';
import { ImmichApiError, ImmichClient } from './immich.mjs';
import { configuredSecrets, sanitizeDiagnostic } from './diagnostics.mjs';
import { isImmichVersionSupported, parseImmichVersion } from './immichCompatibility.mjs';
import { Repository } from './enrich/repository.mjs';
import { ReviewService } from './enrich/reviewService.mjs';
import { backfillAssetVisuals } from './enrich/visualBackfill.mjs';
import { CaptionWritebackService } from './enrich/captionWriteback.mjs';
import { RefereeService } from './enrich/refereeService.mjs';
import { EnrichJobRunner } from './enrich/jobRunner.mjs';
import { EnrichScheduler } from './enrich/scheduler.mjs';
import { loadActiveTaxonomy, replaceTaxonomy } from './enrich/taxonomy.mjs';
import { SmartAlbumStore } from './albums/store.mjs';
import { SmartAlbumValidationError } from './albums/smartAlbums.mjs';
import { SmartAlbumScheduler } from './albums/scheduler.mjs';
import { reverseGeocodeArea } from './ambient/geocoding.mjs';
import { createFrameHub } from './frame/hub.mjs';
import { createFrameLedger } from './frame/ledger.mjs';
import { createVoiceMetrics } from './voice/metrics.mjs';
import { WakeWordModelStore } from './wakeword/store.mjs';
import { InsightsRepository } from './insights/repository.mjs';
import { InsightsCollector } from './insights/collector.mjs';
import { SettingsStore } from './settings.mjs';
import { backupTargets, markActiveBackupLockAbandoned, newestCompleteBackupAtAsync, runBackup } from './backup.mjs';
import { PersistentStateGuard } from './persistentState.mjs';
import { PERSISTENT_STATE_VERSION, preparePersistentStateUpgrade } from './upgradeSafety.mjs';
import { createBackupRoutes } from './routes/backup.mjs';
import { createEnrichRoutes } from './routes/enrich.mjs';
import { createInsightsRoutes } from './routes/insights.mjs';
import { createSettingsRoutes } from './routes/settings.mjs';
import { createSupportRoutes } from './routes/support.mjs';
import { createAlbumsRoutes } from './routes/albums.mjs';
import { createFrameRoutes } from './routes/frame.mjs';
import { createVoiceRoutes } from './routes/voice.mjs';
import { createWakeWordRoutes } from './routes/wakeword.mjs';
import { createAmbientRoutes } from './routes/ambient.mjs';
import { MIN_APP_PROTOCOL, PROTOCOL_VERSION, SERVER_CAPABILITIES } from './protocol.mjs';
import { canDescribeImages, resolveProseProvider } from './voice/prose.mjs';
import { createSessionTokenCodec, loadOrCreateSessionSecret, SESSION_TTL_MS } from './sessionTokens.mjs';
import { createClientAddressResolver } from './trustedProxy.mjs';
import { createActivityLog } from './activity/log.mjs';
import { createActivityHistory } from './activity/history.mjs';
import { createActivityRoutes } from './routes/activity.mjs';
import { createBrowserAuthorityPolicy } from './browserAuthority.mjs';
import { UpstreamPaginationError } from './pagination.mjs';

// Captured once, before startup checks and migrations, so health reports the
// age of this server process rather than the age of an individual request.
const serverStartedAt = Date.now();
const config = loadConfig();
let resolveClientAddress;
let browserAuthority;
let persistentStateGuard;
let serverVersion;
try {
  validateServerAuthConfig(config);
  browserAuthority = createBrowserAuthorityPolicy(config.browserAllowedHosts);
  serverVersion = readServerVersion(config.rootDir);
  resolveClientAddress = createClientAddressResolver(config.trustedProxyIps);
  persistentStateGuard = new PersistentStateGuard({
    inventoryPath: config.persistentState.inventoryPath,
    markerPath: config.persistentState.markerPath,
    legacySettingsMarkerPath: config.persistentState.legacySettingsMarkerPath,
    targets: backupTargets(config),
  });
  persistentStateGuard.preflight();
  const upgrade = await preparePersistentStateUpgrade({
    guard: persistentStateGuard,
    config,
    currentServerVersion: serverVersion,
  });
  if (upgrade.action === 'create') {
    console.log(
      `[Pictaria] Pre-migration recovery point created: ${upgrade.snapshotName} `
      + `(persistent state v${upgrade.fromStateVersion} → v${upgrade.toStateVersion})`,
    );
  } else if (upgrade.action === 'reuse') {
    console.log(
      `[Pictaria] Reusing pre-migration recovery point: ${upgrade.snapshotName} `
      + `(persistent state v${upgrade.fromStateVersion} → v${upgrade.toStateVersion})`,
    );
  }
} catch (error) {
  console.error(`[Pictaria] Refusing to start: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
const installationSecret = loadOrCreateSessionSecret(config.sessionSecretPath);
const sessionTokens = config.appPassword
  ? createSessionTokenCodec({
      appPassword: config.appPassword,
      installationSecret,
    })
  : null;
// Session cookie attributes. `Secure` is opt-in (SESSION_COOKIE_SECURE) for
// installs reached only through an HTTPS reverse proxy — the server itself
// never terminates TLS, so the default must stay plain-HTTP compatible.
const SESSION_COOKIE_ATTRIBUTES = `Path=/; HttpOnly; SameSite=Lax${config.sessionCookieSecure ? '; Secure' : ''}`;
const UNSAFE_HTTP_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const LOGIN_MAX_BODY_BYTES = 4 * 1024;
const LOGIN_BODY_TIMEOUT_MS = 5_000;
// Owns every background timer and the shutdown registry: shutdown() clears
// the timers in one move and drains the registered services with budgets.
const lifecycle = createLifecycle();
let settingsStore;
try {
  settingsStore = new SettingsStore({ filePath: config.settingsPath, config }).load();
} catch (error) {
  console.error(`[Pictaria] Refusing to start: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
// Immich clients capture URL/key at construction; when settings change them,
// re-point the shared clients and force a fresh reachability probe.
let appliedTaxonomySource = config.taxonomyOverrideJson || '';
let appliedLocationGroupsJson = JSON.stringify(config.insights.locationGroups ?? []);
settingsStore.onApplied = () => {
  for (const client of [immich, immichPingClient]) {
    client.baseUrl = config.immichBaseUrl;
    client.apiKey = config.immichApiKey;
  }
  immichPing = emptyImmichStatus();
  enrichScheduler.settingsChanged();
  // First-time setup: the moment Immich becomes reachable, populate
  // Insights instead of waiting for the hourly staleness check. A no-op
  // whenever the snapshot is fresh or Immich is still unconfigured.
  insightsCollector.checkSoon();
  // Swap the live taxonomy in place when the override changes: every service
  // holds a reference to this one object and reads it at call time.
  if ((config.taxonomyOverrideJson || '') !== appliedTaxonomySource) {
    appliedTaxonomySource = config.taxonomyOverrideJson || '';
    replaceTaxonomy(taxonomy, loadActiveTaxonomy(config));
    console.log(`[Pictaria] Taxonomy now ${taxonomy.version}${appliedTaxonomySource ? ' (settings override)' : ' (built-in)'}`);
  }
  // Location groups have side effects beyond persistence (the insights DB
  // lookup table + the snapshot's Places board). Applying them HERE means
  // every path that changes the setting — the dedicated route AND the
  // generic settings API — yields identical live behavior.
  const locationGroupsJson = JSON.stringify(config.insights.locationGroups ?? []);
  if (locationGroupsJson !== appliedLocationGroupsJson) {
    appliedLocationGroupsJson = locationGroupsJson;
    insightsRepo.setLocationGroups(config.insights.locationGroups);
    const snapshot = insightsRepo.getMeta('snapshot');
    if (snapshot) {
      snapshot.places = insightsRepo.topPlaces(10);
      insightsRepo.setMeta('snapshot', snapshot);
    }
    console.log('[Pictaria] Location groups mirrored into Insights');
  }
};
const publicDir = join(config.rootDir, 'public');
const taxonomy = loadActiveTaxonomy(config);
const repo = new Repository(config.databasePath);
repo.initSchema();
const activityLog = createActivityLog({ repo, setIntervalFn: lifecycle.setInterval });
const activityHistory = createActivityHistory({ repo });
settingsStore.onUpdated = (fields) => activityLog.settingsChanged({ fields });
const immich = new ImmichClient({
  baseUrl: config.immichBaseUrl,
  apiKey: config.immichApiKey,
  timeoutMs: config.requestTimeoutMs,
});
const review = new ReviewService({ repo, immich, taxonomy, config, log: (message) => console.log(`[Pictaria] ${message}`) });
const captionWriteback = new CaptionWritebackService({ repo, immich, config, log: (message) => console.log(`[Pictaria] ${message}`) });
const enrichRunner = new EnrichJobRunner({ repo, immich, taxonomy, config });
const enrichScheduler = new EnrichScheduler({ runner: enrichRunner, repo, config });
const referee = new RefereeService({ repo, immich, review, enrichRunner, config, log: (message) => console.log(`[Pictaria] ${message}`) });
const albumStore = new SmartAlbumStore(config.albums.dataFile, { installationSecret });
const albumScheduler = new SmartAlbumScheduler({ immich, store: albumStore, config: config.albums, enrichRepo: repo });
const frameHub = createFrameHub();
const frameLedger = createFrameLedger({ dbPath: config.frame.dbPath });
const voiceMetrics = createVoiceMetrics({ dbPath: config.frame.dbPath });
const wakeWordModels = new WakeWordModelStore(config.wakeWordModelsDir);
await wakeWordModels.load();
const insightsRepo = new InsightsRepository(config.insights.dbPath);
// Settings are already loaded; mirror the user's location groups into the
// insights DB so city aggregates relabel them from the first query.
insightsRepo.setLocationGroups(config.insights.locationGroups);
const insightsCollector = new InsightsCollector({
  repo: insightsRepo,
  immich,
  config: config.insights,
  enrichRepo: repo,
  geocodeHome: (coordinates) => reverseGeocodeArea(coordinates, config.ambient),
  log: (message) => console.log(`[Pictaria] ${message}`),
});

review.startSyncWorker();
captionWriteback.start();
referee.start();
// Near-dup grouping needs thumbhashes; fill rows that predate the columns
// once Immich is reachable. No-op after the first complete pass. The pass
// checks shouldStop between pages and its promise is drained at shutdown.
let thumbhashBackfill = null;
lifecycle.setTimeout(() => {
  if (missingImmichSettings(config).length === 0) {
    thumbhashBackfill = backfillAssetVisuals({
      repo,
      immich,
      shouldStop: () => lifecycle.stopped,
      log: (message) => console.log(`[Pictaria] ${message}`),
    }).catch((error) => console.error(`[Pictaria] thumbhash backfill failed: ${error?.message ?? error}`));
  }
}, 15000);
await albumStore.load();
try {
  persistentStateGuard.seal({
    successfulStateVersion: PERSISTENT_STATE_VERSION,
    successfulServerVersion: serverVersion,
  });
} catch (error) {
  console.error(`[Pictaria] Refusing to start: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
albumScheduler.start();
enrichScheduler.start();
insightsCollector.startAutoRefresh();

// Automatic backups: catch up on boot if the newest snapshot is older than
// the interval, then check hourly. Failures are logged and retried on the
// next tick; "Back up now" in Settings shares the same state.
const backupState = { running: false, lastResult: null, lastError: null };
async function backupTick() {
  if (!config.backup.enabled || backupState.running) {
    return;
  }
  // An incomplete, damaged, or implausibly future-dated snapshot is not a
  // recovery point and must not reset the cadence. Full verification is
  // asynchronous and cached for an hour so large NAS snapshots do not block
  // requests or get re-read on every tick.
  const newest = await newestCompleteBackupAtAsync(
    config.backup.dir,
    backupTargets(config),
  );
  if (newest && Date.now() - newest.getTime() < config.backup.intervalHours * 3600000) {
    return;
  }
  backupState.running = true;
  try {
    backupState.lastResult = await runBackup(config);
    backupState.lastError = null;
    console.log(`[Pictaria] Backup written: ${backupState.lastResult.dir} (${backupState.lastResult.files.length} files)`);
    if (!backupState.lastResult.complete) {
      console.warn(`[Pictaria] Backup incomplete — missing: ${backupState.lastResult.missing.map((m) => m.name).join(', ')}`);
    }
  } catch (error) {
    backupState.lastError = error instanceof Error ? error.message : String(error);
    console.error(`[Pictaria] Backup failed: ${backupState.lastError}`);
  } finally {
    backupState.running = false;
  }
}
// The in-flight tick is stored so shutdown can drain it; backupTick never
// rejects (it catches into backupState.lastError).
let backupDrain = null;
const scheduleBackupTick = () => {
  backupDrain = backupTick();
};
lifecycle.setInterval(scheduleBackupTick, 3600000);
lifecycle.setTimeout(scheduleBackupTick, 60000);

// The shutdown registry: every owner of background work joins with the
// budget its drain deserves. Budgets run in parallel and must all fit under
// the 5s force-exit guard in shutdown(). stop(timeoutMs) resolves within its
// budget; false means "gave up waiting" and gets warned by name.
lifecycle.register('review-sync', 3000, (timeoutMs) => review.stopSyncWorker(timeoutMs));
lifecycle.register('caption-writeback', 3000, (timeoutMs) => captionWriteback.stop(timeoutMs));
lifecycle.register('enrich-runner', 3000, (timeoutMs) => enrichRunner.stop(timeoutMs));
lifecycle.register('enrich-scheduler', 3000, () => enrichScheduler.stop());
lifecycle.register('insights-collector', 3000, (timeoutMs) => insightsCollector.stop(timeoutMs));
lifecycle.register('curate-referee', 3000, (timeoutMs) => referee.stop(timeoutMs));
lifecycle.register('album-scheduler', 3000, (timeoutMs) => albumScheduler.stop(timeoutMs));
// A timed-out backup leaves only unpublished, ownership-marked work plus its
// destination lock. Immediately before this process exits, shutdown explicitly
// hands that lock back to the same persistent installation. A replacement
// container can then reclaim it despite Docker assigning a new hostname; the
// next tick sweeps the partial and retries.
lifecycle.register('backup', 3000, (timeoutMs) => awaitDrain(backupDrain, timeoutMs));
lifecycle.register('thumbhash-backfill', 3000, (timeoutMs) => awaitDrain(thumbhashBackfill, timeoutMs));

const features = [
  createActivityRoutes({ activityHistory }),
  createEnrichRoutes({ review, enrichRunner, taxonomy, repo, requireImmich, config, immich, captionWriteback, referee, activityLog }),
  createAlbumsRoutes({ immich, store: albumStore, config, requireImmich, enrichRepo: repo }),
  createWakeWordRoutes({ store: wakeWordModels }),
  createFrameRoutes({ immich, frameHub, frameLedger, requireImmich, voiceMetrics, activityLog }),
  createVoiceRoutes({ immich, config, requireImmich, voiceMetrics, activityLog }),
  createAmbientRoutes({ config }),
  createInsightsRoutes({ collector: insightsCollector, repo: insightsRepo, immich, config, settingsStore, requireImmich }),
  createSettingsRoutes({ settingsStore }),
  createSupportRoutes({ config }),
  createBackupRoutes({ config, backupState }),
];

const server = http.createServer(async (request, response) => {
  // Routes can reject a request from its headers alone (auth, origin, feature
  // readiness, or routing) without ever consuming its declared body. Such a
  // response must not leave the unread request framing parked on a reusable
  // connection. Completed requests keep their normal keep-alive behavior.
  response.once('finish', () => {
    if (!request.complete) request.destroy();
  });
  try {
    await routeRequest(request, response);
  } catch (error) {
    if (handleBodyError(request, response, error)) {
      return;
    }
    if (error instanceof ImmichApiError) {
      sendError(response, error.status ?? 502, 'immich_error', sanitizeDiagnostic(error.message, {
        secrets: configuredSecrets(config, immich),
      }));
      return;
    }
    if (error instanceof UpstreamPaginationError || error instanceof SmartAlbumValidationError) {
      sendError(response, error.status, error.code, error.message);
      return;
    }
    console.error(error);
    sendError(response, 500, 'internal_error', 'Unexpected Pictaria Server error.');
  }
});

// Node answers unsupported Expect headers before invoking the normal request
// callback above. Handle that edge explicitly so its unread declared body
// cannot retain a keep-alive connection outside the shared cleanup guard.
server.on('checkExpectation', (request, response) => {
  response.once('finish', () => request.destroy());
  response.writeHead(417, { Connection: 'close', 'Content-Length': '0' });
  response.end();
});

server.listen(config.port, config.host, () => {
  console.log(`Pictaria Server listening on http://${config.host}:${config.port}`);
  activityLog.systemStarted({ serverVersion });
  const missing = missingImmichSettings(config);
  if (missing.length > 0) {
    console.warn(`Missing configuration: ${missing.join(', ')}`);
  }
  if (!config.appPassword) {
    console.warn('ALLOW_INSECURE_OPEN=true: APP_PASSWORD is not set; the API is open to your network.');
  }
});

process.on('SIGINT', () => shutdown('SIGINT', 0));
process.on('SIGTERM', () => shutdown('SIGTERM', 0));
process.on('uncaughtException', (error) => {
  console.error('[Pictaria] Uncaught exception; shutting down for supervisor restart.', error);
  shutdown('uncaughtException', 1);
});
process.on('unhandledRejection', (reason) => {
  console.error('[Pictaria] Unhandled rejection; shutting down for supervisor restart.', reason);
  shutdown('unhandledRejection', 1);
});

let isShuttingDown = false;

// Ordered shutdown — bounded end to end. The phases:
//   1. mark stopping: no new work is accepted or scheduled from here on
//   2. clear every tracked timer (the stopped flag flips first, so a
//      callback already on the event loop cannot re-arm or start work)
//   3. signal cancel on every registered service and start their drains
//      (each stop() sets its cancel flag synchronously before its first
//      await, so kicking off the drains IS the cancel broadcast)
//   4. end the SSE streams — deliberately early, they would otherwise hold
//      server.close() open forever — then close the HTTP server
//   5. await the drains: parallel, per-service budgets, laggards warned BY
//      NAME (the breadcrumb if a late write hits a closed database later)
//   6. close the databases: repo, insightsRepo, frameLedger, voiceMetrics —
//      last, once every owned writer has drained or been named and abandoned
//   7. force-exit guard: 5s after shutdown began, exit no matter what
function shutdown(reason, exitCode) {
  if (isShuttingDown) {
    return;
  }
  isShuttingDown = true; // phase 1
  activityLog.systemStopping({ reason, exitCode });
  console.log(`[Pictaria] Shutting down: ${reason}`);
  const handOffBackupLock = () => {
    try {
      markActiveBackupLockAbandoned(config);
    } catch (error) {
      console.error(`[Pictaria] Could not mark the active backup lock abandoned: ${error?.message ?? error}`);
    }
  };

  // Phase 7 is armed first so nothing below can starve it. Every drain
  // budget in the registry fits under it — a graceful pass beats it; only a
  // genuinely wedged shutdown (or an unbounded in-flight request) trips it.
  // 8s: worst graceful drain is ~3.5s (3000ms budgets + 500ms grace), which
  // must leave real headroom for the WAL checkpoints of four sqlite closes
  // on slow disks — a clean `docker stop` should never read as exit 1.
  // Still comfortably under Docker's default 10s SIGKILL.
  const forceExit = setTimeout(() => {
    console.error('[Pictaria] Forced shutdown after timeout.');
    handOffBackupLock();
    process.exit(exitCode || 1);
  }, 8000);
  forceExit.unref();

  void (async () => {
    let failed = false;
    try {
      // Phase 2: no delayed callback may start new work.
      lifecycle.clearTimers();

      // Phase 3: signal everything, start every drain.
      const drains = lifecycle.drainServices();

      // Phase 4: SSE first (unblocks server.close), then the listener.
      // Idle keep-alive sockets are dropped; in-flight requests may finish.
      frameHub.close();
      const serverClosed = new Promise((resolve) => server.close(() => resolve()));
      server.closeIdleConnections?.();

      // Phase 5: drains and the request tail settle in parallel, each
      // bounded — a hung in-flight request must not hold the databases open.
      const requestTail = awaitDrain(serverClosed, 3000);
      await drains;
      if (!(await requestTail)) {
        console.warn('[Pictaria] Shutdown: open HTTP connections did not finish within 3000ms — closing the databases anyway.');
      }
    } catch (error) {
      failed = true;
      console.error('[Pictaria] Shutdown error.', error);
    }

    // Phase 6: databases close even when a drain timed out above — bounded
    // shutdown wins, and the named warning already said whose write might
    // still be in flight.
    for (const closeable of [repo, insightsRepo, frameLedger, voiceMetrics]) {
      try {
        closeable.close();
      } catch (closeError) {
        console.error('[Pictaria] Could not close a database cleanly.', closeError);
      }
    }
    clearTimeout(forceExit);
    handOffBackupLock();
    process.exit(failed ? 1 : exitCode);
  })();
}

async function routeRequest(request, response) {
  // request.url is an origin-form path in Node's HTTP server; do not promote
  // caller-controlled Host into the URL parser's trust base.
  const url = new URL(request.url ?? '/', 'http://localhost');
  const browserHostAllowed = browserAuthority.isAllowed(request.headers.host);

  // Baseline hardening headers on every response. No CSP: the admin pages
  // are inline-script/style by design, so a policy would be all-unsafe-inline
  // theater. Frame denial + nosniff cost nothing and close real vectors.
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Referrer-Policy', 'no-referrer');

  // Route handlers decode individual path segments after matching them. A
  // malformed percent escape would otherwise throw URIError inside any such
  // handler and turn one bad path into a 500 plus a logged stack trace. Check
  // the path once at the shared boundary; keep the encoded pathname itself so
  // valid escaped identifiers retain their existing route semantics.
  try {
    decodeURI(url.pathname);
  } catch (error) {
    if (!(error instanceof URIError)) throw error;
    sendError(response, 400, 'invalid_path', 'Request path contains invalid percent encoding.');
    return;
  }

  // Open mode trusts network reachability instead of a password, so an
  // Internet hostname must not use a victim's browser to cross that LAN
  // boundary. The same policy already protects the browser UI and sessions.
  if (!config.appPassword && url.pathname.startsWith('/api/') && !browserHostAllowed) {
    sendUntrustedBrowserHost(response);
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/health') {
    const base = {
      ok: true,
      service: 'pictaria-server',
      time: new Date().toISOString(),
      authRequired: Boolean(config.appPassword),
    };
    const explicitCredential = authAttempted(request);
    if (explicitCredential) {
      const lockoutMs = authClientLockoutRemainingMs(request);
      if (lockoutMs > 0) {
        sendLockout(response, lockoutMs);
        return;
      }
    }
    let releaseAuthAdmission = explicitCredential ? tryAdmitAuthAttempt(response) : null;
    if (explicitCredential && !releaseAuthAdmission) return;
    // Unauthenticated callers learn only that the server is up and whether
    // it wants a password — not which providers/models are configured or
    // whether Immich is reachable. Pictaria Frame sends its password with
    // this call and tolerates the trimmed shape before setup completes.
    const healthAuthorization = authorizationChannelAfterAdmission(request, releaseAuthAdmission);
    if (healthAuthorization === 'none') {
      if (explicitCredential) {
        const globalLockoutMs = await recordDelayedAuthFailure(request);
        releaseAuthAdmission();
        releaseAuthAdmission = null;
        if (globalLockoutMs > 0) {
          sendLockout(response, globalLockoutMs);
          return;
        }
      }
      sendJson(response, 200, base);
      return;
    }
    releaseAuthAdmission?.();
    releaseAuthAdmission = null;
    if (healthAuthorization === 'session' && !browserHostAllowed) {
      sendUntrustedBrowserHost(response);
      return;
    }
    if (
      (healthAuthorization === 'open' || healthAuthorization === 'session')
      && (isForeignBrowserSite(request)
        || (request.headers.origin !== undefined && !hasSameHostOrigin(request)))
    ) {
      sendCsrfError(response);
      return;
    }
    if (healthAuthorization === 'credential') {
      clearAuthFailures(request);
    }
    const immich = await immichStatus();
    sendJson(response, 200, {
      ...base,
      // The version handshake (see src/protocol.mjs): the app compares these
      // against its own supported protocol so mismatched upgrades fail
      // clearly instead of partially. Authenticated-only, like everything
      // below — the trimmed payload above must not grow.
      serverVersion,
      uptimeSeconds: Math.max(0, Math.floor((Date.now() - serverStartedAt) / 1000)),
      protocolVersion: PROTOCOL_VERSION,
      minAppProtocol: MIN_APP_PROTOCOL,
      capabilities: SERVER_CAPABILITIES,
      immichConfigured: missingImmichSettings(config).length === 0,
      // status: connected | unreachable | unauthorized | missing_permissions
      // | incompatible_version | incompatible_api | not_configured. The list names the permissions a
      // missing_permissions key lacks, so the UI can say which boxes to tick.
      immich: immich.status,
      immichVersion: immich.version,
      immichMissingPermissions: immich.missing,
      taxonomyVersion: taxonomy.version,
      enrichEnabled: config.enrichEnabled,
      // Pictaria Frame reads TTS defaults from health during setup.
      providers: {
        stt: config.voice.sttProvider || null,
        tts: describeTtsProvider(config.voice),
        // Any configured provider can supply spoken-prose commands. An OpenAI
        // key alone cannot determine readiness.
        interesting: proseProviderReady(config),
      },
    });
    return;
  }

  // Login: verify the password once, hand back an HttpOnly session cookie so
  // the browser never stores the raw password. Signatures use a persisted,
  // per-installation secret plus the password: they survive restarts, die if
  // the password changes, and cannot verify password guesses on their own.
  if (url.pathname === '/api/session') {
    if (!browserHostAllowed) {
      sendUntrustedBrowserHost(response);
      return;
    }
    // This route authenticates only the POST body. Header credentials are
    // irrelevant here and must not trigger password comparisons before the
    // login admission gate (or at all on DELETE).
    const sessionAuthorization = ambientAuthorizationChannel(request);
    if (
      (sessionAuthorization === 'open' || sessionAuthorization === 'session')
      && isForeignBrowserSite(request)
    ) {
      sendCsrfError(response);
      return;
    }
    if (
      !config.appPassword
      && UNSAFE_HTTP_METHODS.has(request.method)
      && request.headers.origin !== undefined
      && !hasSameHostOrigin(request)
    ) {
      sendCsrfError(response);
      return;
    }
    if (request.method === 'POST') {
      let releaseAuthAdmission = null;
      if (config.appPassword) {
        const lockoutMs = authClientLockoutRemainingMs(request);
        if (lockoutMs > 0) {
          // No request body is needed to make this decision. Close after the
          // response so an incomplete body cannot keep the connection alive.
          response.once('finish', () => request.destroy());
          sendLockout(response, lockoutMs, { Connection: 'close' });
          return;
        }
        releaseAuthAdmission = tryAdmitAuthAttempt(response, { closeRequest: request });
        if (!releaseAuthAdmission) return;
      }
      try {
        const body = await readJsonBody(request, {
          maxBytes: LOGIN_MAX_BODY_BYTES,
          timeoutMs: LOGIN_BODY_TIMEOUT_MS,
        });
        if (!config.appPassword) {
          sendJson(response, 200, { ok: true, authRequired: false });
          return;
        }
        if (!passwordMatches(String(body?.password ?? ''))) {
          const globalLockoutMs = await recordDelayedAuthFailure(request);
          if (globalLockoutMs > 0) {
            sendLockout(response, globalLockoutMs);
          } else {
            sendError(response, 401, 'unauthorized', 'That password did not match.');
          }
          return;
        }
        clearAuthFailures(request);
        sendJson(response, 200, { ok: true }, {
          'Set-Cookie': [
            `pictaria_session=${sessionTokens.issue()}; ${SESSION_COOKIE_ATTRIBUTES}; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
            // Retire the legacy raw-password cookie wherever one is still set.
            'pictaria_pw=; Path=/; Max-Age=0',
          ],
        });
        return;
      } finally {
        releaseAuthAdmission?.();
      }
    }
    if (request.method === 'DELETE') {
      if (ambientAuthorizationChannel(request) === 'session' && !hasSameHostOrigin(request)) {
        sendCsrfError(response);
        return;
      }
      sendJson(response, 200, { ok: true }, {
        'Set-Cookie': `pictaria_session=; ${SESSION_COOKIE_ATTRIBUTES}; Max-Age=0`,
      });
      return;
    }
  }

  if (url.pathname.startsWith('/api/')) {
    // A client's own lockout gates credential-carrying requests before the
    // password is evaluated. The higher distributed threshold is handled
    // after evaluation so unrelated clients with valid credentials remain
    // available. Session-cookie users never carry credentials here.
    const explicitCredential = authAttempted(request);
    if (explicitCredential) {
      const lockoutMs = authClientLockoutRemainingMs(request);
      if (lockoutMs > 0) {
        sendLockout(response, lockoutMs);
        return;
      }
    }
    let releaseAuthAdmission = explicitCredential ? tryAdmitAuthAttempt(response) : null;
    if (explicitCredential && !releaseAuthAdmission) return;
    const authorization = authorizationChannelAfterAdmission(request, releaseAuthAdmission);
    if (authorization === 'none') {
      // A failed attempt that actually carried credentials gets a flat
      // delay AND counts toward the shared per-IP limiter — concurrent
      // guesses can't ride around a per-request sleep. Requests with no
      // credentials stay fast (that is every first page load before the
      // gate).
      if (explicitCredential) {
        const globalLockoutMs = await recordDelayedAuthFailure(request);
        releaseAuthAdmission();
        releaseAuthAdmission = null;
        if (globalLockoutMs > 0) {
          sendLockout(response, globalLockoutMs);
          return;
        }
      }
      sendError(response, 401, 'unauthorized', 'App password is required.');
      return;
    }
    releaseAuthAdmission?.();
    releaseAuthAdmission = null;
    if (authorization === 'session' && !browserHostAllowed) {
      sendUntrustedBrowserHost(response);
      return;
    }
    // Fetch Metadata covers browser request shapes that omit Origin entirely
    // (images, iframes, forms, and navigations). `same-site` is still a
    // different origin and can carry a SameSite cookie, so only same-origin
    // subrequests and user-initiated `none` navigations are browser-trusted.
    // Native/programmatic clients send no Sec-Fetch-Site and remain valid.
    if (isForeignBrowserSite(request)) {
      sendCsrfError(response);
      return;
    }
    // Frame events are a private same-origin stream. EventSource sends an
    // Origin in browsers, while native Frame clients do not; reject only a
    // browser-declared foreign/null origin so native clients remain usable.
    if (
      request.method === 'GET'
      && url.pathname === '/api/frame/events'
      && request.headers.origin !== undefined
      && !hasSameHostOrigin(request)
    ) {
      sendCsrfError(response);
      return;
    }
    const browserDeclaredOrigin = request.headers.origin !== undefined;
    // Open mode deliberately grants direct LAN clients administrator
    // authority, but an unrelated website is not a LAN client. GET routes
    // are not uniformly passive: some perform provider/Immich work, refresh
    // caches, subscribe streams, or write derived metadata. Protect the
    // complete open-mode browser GET surface here so a new route cannot
    // accidentally reintroduce ambient cross-origin authority. Native Frame
    // and programmatic clients send no Origin and remain supported.
    const unsafeSessionRequest = authorization === 'session' && UNSAFE_HTTP_METHODS.has(request.method);
    const declaredBrowserRequest = browserDeclaredOrigin
      && (authorization === 'session' || authorization === 'open')
      && (UNSAFE_HTTP_METHODS.has(request.method) || request.method === 'GET');
    if ((unsafeSessionRequest || declaredBrowserRequest) && !hasSameHostOrigin(request)) {
      sendCsrfError(response);
      return;
    }
    for (const feature of features) {
      if (await feature(request, response, url)) {
        return;
      }
    }
    sendError(response, 404, 'not_found', 'Route not found.');
    return;
  }

  if (request.method === 'GET') {
    if (!browserHostAllowed) {
      sendUntrustedBrowserHost(response);
      return;
    }
    if (await serveStaticFile(response, publicDir, url.pathname)) {
      return;
    }
  }
  sendError(response, 404, 'not_found', 'Route not found.');
}

// Shared failure limiter: per-client lockouts isolate users behind a
// configured trusted proxy. The higher global threshold records distributed
// abuse and changes subsequent failed responses to 429, but is not a
// pre-evaluation gate that can lock out unrelated valid clients. Without
// TRUSTED_PROXY_IPS, the direct socket address remains the client key and
// caller-controlled forwarding headers are ignored.
const authFailureLimiter = createAuthFailureLimiter();
const authAdmissionGate = createAuthAdmissionGate();

function authClientKey(request) {
  return resolveClientAddress(request);
}

function authClientLockoutRemainingMs(request) {
  return authFailureLimiter.clientRemainingMs(authClientKey(request));
}

function recordAuthFailure(request) {
  authFailureLimiter.recordFailure(authClientKey(request));
}

async function recordDelayedAuthFailure(request) {
  recordAuthFailure(request);
  // At this point the credential comparison has already happened. Holding a
  // wrong request open for the global window would not reduce comparisons —
  // concurrent callers could submit them first — and would turn the limiter
  // into a connection-exhaustion tool. Keep the uniform baseline delay; the
  // global state instead supplies the 429 response and retry guidance.
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 1000));
  return authFailureLimiter.globalRemainingMs();
}

function clearAuthFailures(request) {
  authFailureLimiter.clearClient(authClientKey(request));
}

function tryAdmitAuthAttempt(response, { closeRequest = null } = {}) {
  const release = authAdmissionGate.tryAcquire();
  if (release) return release;
  // Saturated attempts do not consume a per-client password budget because
  // their credential was never evaluated. They still contribute to the
  // distributed-failure signal, which only changes later *invalid* responses
  // and therefore cannot lock out an unrelated valid credential.
  authFailureLimiter.recordGlobalFailure();
  if (closeRequest) {
    response.once('finish', () => closeRequest.destroy());
  }
  sendLockout(response, 1_000, closeRequest ? { Connection: 'close' } : {});
  return null;
}

function authorizationChannelAfterAdmission(request, release) {
  try {
    return authorizationChannel(request);
  } catch (error) {
    release?.();
    throw error;
  }
}

function sendLockout(response, remainingMs, extraHeaders = {}) {
  sendError(
    response,
    429,
    'too_many_attempts',
    'Too many failed password attempts. Try again later.',
    { 'Retry-After': String(Math.ceil(remainingMs / 1000)), ...extraHeaders },
  );
}

// Only password-carrying channels count as an "attempt" for the brute-force
// delay. An expired session cookie is not a guess — it just falls through to
// a fast 401 and the login gate.
function authAttempted(request) {
  return Boolean(
    request.headers['x-app-password']
    || request.headers.authorization,
  );
}

// Identify HOW this request authenticated, not just whether it did. Only
// browser session cookies are ambient credentials and therefore vulnerable
// to CSRF; explicit password/Bearer headers remain suitable for the Frame
// app and programmatic clients. Explicit credentials take precedence when a
// browser happens to carry both during the one-release storage migration.
function authorizationChannel(request) {
  if (!config.appPassword) {
    return 'open';
  }
  const headerToken = request.headers['x-app-password'];
  const authHeader = String(request.headers.authorization ?? '');
  const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice('Bearer '.length) : '';
  if ([headerToken, bearer].some((token) => passwordMatches(token))) {
    return 'credential';
  }
  return ambientAuthorizationChannel(request);
}

function ambientAuthorizationChannel(request) {
  if (!config.appPassword) {
    return 'open';
  }
  const cookies = String(request.headers.cookie ?? '');
  // Browser sessions: HttpOnly cookie issued by POST /api/session. Rides on
  // <img>/EventSource requests too, which cannot send headers.
  const sessionMatch = /(?:^|;\s*)pictaria_session=([^;]*)/.exec(cookies);
  if (sessionMatch) {
    try {
      if (sessionTokens.valid(decodeURIComponent(sessionMatch[1]))) {
        return 'session';
      }
    } catch (error) {
      // A malformed percent escape is just an invalid ambient credential.
      // Do not log the untrusted cookie or turn repetition into log traffic.
      if (!(error instanceof URIError)) throw error;
    }
  }
  return 'none';
}

// Origin is the browser-controlled authority that initiated an unsafe
// request. Exact host+port equality blocks cross-site and same-site sibling
// origins. The scheme is intentionally ignored: HTTPS commonly terminates at
// a reverse proxy while this process receives plain HTTP. Such proxies must
// preserve the original Host header (documented in the deployment guide).
function hasSameHostOrigin(request) {
  const host = String(request.headers.host ?? '').trim().toLowerCase();
  const originHeader = request.headers.origin;
  if (!browserAuthority.isAllowed(host) || typeof originHeader !== 'string' || originHeader === 'null') {
    return false;
  }
  try {
    const origin = new URL(originHeader);
    return (origin.protocol === 'http:' || origin.protocol === 'https:')
      && !origin.username
      && !origin.password
      && origin.host.toLowerCase() === host;
  } catch {
    return false;
  }
}

function isForeignBrowserSite(request) {
  const site = String(request.headers['sec-fetch-site'] ?? '').trim().toLowerCase();
  return site === 'cross-site' || site === 'same-site';
}

function sendUntrustedBrowserHost(response) {
  sendError(
    response,
    421,
    'untrusted_browser_host',
    'This host is not allowed for the Pictaria browser interface. Add it to BROWSER_ALLOWED_HOSTS.',
  );
}

function sendCsrfError(response) {
  sendError(
    response,
    403,
    'csrf_rejected',
    'Browser mutation rejected because its Origin does not match this Pictaria Server.',
  );
}

function passwordMatches(candidate) {
  if (typeof candidate !== 'string' || candidate.length === 0) {
    return false;
  }
  const expected = Buffer.from(config.appPassword);
  const provided = Buffer.from(candidate);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

// Read once before migration safety runs. A build without a trustworthy
// package version cannot publish a last-successful marker, so it must not
// touch persistent state.
function readServerVersion(rootDir) {
  const version = JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf8')).version;
  if (typeof version !== 'string' || !version) {
    throw new Error('package.json has no valid server version');
  }
  return version;
}

// Health is polled by every open page, so the Immich probe is cached.
// "connected" means Immich answered an AUTHENTICATED call. /server/ping is
// public, so it would bless a revoked or wrong key. /api-keys/me is the same
// probe Pictaria Frame uses: any valid key can read its own metadata without an
// extra permission, and the response lists permissions so the probe can verify
// the documented least-privilege checklist and name what's missing.
const IMMICH_PING_TTL_MS = 60_000;
const immichPingClient = new ImmichClient({
  baseUrl: config.immichBaseUrl,
  apiKey: config.immichApiKey,
  timeoutMs: 4000,
});
let immichPing = emptyImmichStatus();

// The least-privilege checklist from docs/GETTING-STARTED.md. asset.update
// is conditional — only the two opt-in write-backs use it — so it is
// required only while one of them is switched on.
const IMMICH_REQUIRED_PERMISSIONS = [
  'asset.read', 'asset.view', 'asset.download', 'asset.statistics',
  'person.read', 'person.statistics', 'album.read', 'album.create',
  'album.delete', 'albumAsset.create', 'albumAsset.delete',
  'tag.read', 'tag.create', 'tag.asset',
];

function missingImmichPermissions(granted) {
  if (granted.includes('all')) {
    return [];
  }
  const required = [...IMMICH_REQUIRED_PERMISSIONS];
  if (config.captionWriteback || config.ambient.immichMetadataWriteback) {
    required.push('asset.update');
  }
  return required.filter((permission) => !granted.includes(permission));
}

async function immichStatus() {
  if (missingImmichSettings(config).length > 0) {
    return { ...emptyImmichStatus(), status: 'not_configured' };
  }
  if (Date.now() - immichPing.at > IMMICH_PING_TTL_MS) {
    let version;
    try {
      const response = await immichPingClient.requestJson('/server/version');
      version = parseImmichVersion(response);
      if (!version) {
        immichPing = {
          at: Date.now(),
          status: 'incompatible_api',
          missing: [],
          version: null,
        };
        return immichPing;
      }
      if (!isImmichVersionSupported(version)) {
        immichPing = {
          at: Date.now(),
          status: 'incompatible_version',
          missing: [],
          version: version.display,
        };
        return immichPing;
      }
    } catch (error) {
      const incompatible = error instanceof SyntaxError
        || (error instanceof ImmichApiError && (error.status === 400 || error.status === 404));
      immichPing = {
        at: Date.now(),
        status: incompatible ? 'incompatible_api' : 'unreachable',
        missing: [],
        version: null,
      };
      return immichPing;
    }

    try {
      const key = await immichPingClient.requestJson('/api-keys/me');
      if (!Array.isArray(key?.permissions) || !key.permissions.every((permission) => typeof permission === 'string')) {
        immichPing = {
          at: Date.now(),
          status: 'incompatible_api',
          missing: [],
          version: version.display,
        };
        return immichPing;
      }
      const granted = key.permissions;
      const missing = missingImmichPermissions(granted);
      immichPing = {
        at: Date.now(),
        status: missing.length > 0 ? 'missing_permissions' : 'connected',
        missing,
        version: version.display,
      };
    } catch (error) {
      // 401/403 mean Immich answered and rejected the key — a very
      // different problem (and fix) than an unreachable host.
      const rejected = error instanceof ImmichApiError && (error.status === 401 || error.status === 403);
      const incompatible = error instanceof SyntaxError
        || (error instanceof ImmichApiError && (error.status === 400 || error.status === 404));
      immichPing = {
        at: Date.now(),
        status: rejected ? 'unauthorized' : incompatible ? 'incompatible_api' : 'unreachable',
        missing: [],
        version: version.display,
      };
    }
  }
  return immichPing;
}

function emptyImmichStatus() {
  return { at: 0, status: 'unreachable', missing: [], version: null };
}

// Can the voice commands that speak prose actually run right now? Building
// the provider is the honest test: each constructor throws when its own
// credential (or model) is missing, which is exactly the readiness question
// — and it is the same resolution the commands themselves perform.
function proseProviderReady(config) {
  // Constructing the provider would succeed on Linux even though the
  // command cannot work there, so readiness asks the shared rule.
  if (!canDescribeImages(config.voice.proseProvider ?? 'cloud_openai')) {
    return false;
  }
  try {
    resolveProseProvider(config, {
      model: config.voice.interestingModel,
      openAiDefaultModel: config.voice.openAiInterestingModel,
    });
    return true;
  } catch {
    return false;
  }
}

function describeTtsProvider(voiceConfig) {
  if (!voiceConfig.ttsProvider) {
    return null;
  }
  if (voiceConfig.ttsProvider === 'openai') {
    return {
      provider: 'openai',
      model: voiceConfig.openAiTtsModel,
      voice: voiceConfig.openAiTtsVoice,
      configured: Boolean(voiceConfig.openAiApiKey),
    };
  }
  if (voiceConfig.ttsProvider === 'elevenlabs') {
    return {
      provider: 'elevenlabs',
      model: voiceConfig.elevenLabsTtsModel,
      voice: voiceConfig.elevenLabsVoiceId || null,
      configured: Boolean(voiceConfig.elevenLabsApiKey && voiceConfig.elevenLabsVoiceId),
    };
  }
  return { provider: voiceConfig.ttsProvider, configured: false };
}

function requireImmich(response) {
  if (missingImmichSettings(config).length === 0) {
    return true;
  }
  sendError(response, 503, 'immich_not_configured', 'Immich settings are missing.');
  return false;
}
