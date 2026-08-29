# Pictaria Server — Architecture

Pictaria Server is one self-hosted service that bundles every server-side
feature of the Pictaria photo frame ecosystem. It is a single Node process
(no runtime dependencies, Node `^22.16 || >=23.8`) with one HTTP server,
one config, one password, and one data directory.

## Features

| Feature | What it does | API prefix | UI page |
| --- | --- | --- | --- |
| **Insights** | Local collection statistics: yearly histogram + lens, timeline with trips, people constellation, records, leaderboards; every stat opens a photo browser | `/api/insights` | `/insights.html` |
| **Enrich** | AI tagging/captioning of the Immich library, review workflow | `/api/enrich`, `/api/review`, `/api/taxonomy` | `/curate.html` |
| **Albums** | Smart albums: saved Immich searches synced to real albums on a schedule; Best-of mode corroborates free-text hits against the enrichment DB and ranks by Curate signals | `/api/albums` | `/albums.html` |
| **Frame** | Frame hub: device presence, live state per device, remote commands (SSE) routed by device name, display ledger/stats | `/api/frame` | `/remote.html` |
| **Voice** | Voice pipeline for Pictaria Frame: intent parsing, photo search, photo Q&A, TTS, usage counters | `/api/voice`, `/api/photos` | testers in `/settings.html` (Voice section) |
| **Frame Metrics** | Display ledger (totals, per-device, most shown) + voice command usage (per device, with a device picker; counts recorded before device tracking show as "unattributed"); counts only, no transcripts | `/api/frame/ledger/top`, `/api/voice/metrics` | `/metrics.html` ("Frame" in the nav) |
| **Ambient** | Weather + location display strings for the frame's ambient screen | `/api/weather` | — |
| **Wake words** | Custom openWakeWord model registry for Pictaria Frame: validated upload, integrity-checked download, delete | `/api/frame/wake-word-models` | Settings → Devices |
| **Settings** | Runtime-editable configuration overriding env vars, applied live | `/api/settings` | `/settings.html` |
| **Activity** | Authenticated, privacy-bounded chronological history merged at read time from operational events and existing Enrich/Curate records; keyset pagination + bounded JSON/CSV export | `/api/activity` | `/activity.html` |
| **Support** | Supporter-key status (tier/since/key id) for the nav badge | `/api/support` | badge + footer in every page's nav |
| **Backup** | Destination-locked automatic snapshots of irreplaceable data (SQLite online-backup API) | `/api/backup` | Settings → Backups |

## Module layout

```
src/
  server.mjs        one HTTP server; mounts the feature routers below
  config.mjs        all env vars, grouped per feature
  http.mjs          shared HTTP helpers (JSON body, errors, static files, SSE)
  immich.mjs        the one shared Immich API client (union of all feature needs)
  routes/           one router file per feature (thin: parse/validate → service)
  enrich/           enrichment pipeline + review service
  activity/         fail-open structured operational events + merged read model;
                    operational events retained for 90 days
  albums/           smart-album jobs, store (JSON file), scheduler; Best-of
                    reads the enrich repository (tags, captions, decisions)
  migrations.mjs    numbered PRAGMA user_version migrations shared by the
                    SQLite databases (fresh installs stamp latest; existing
                    DBs run pending migrations in order)
  frame/            frame hub (SSE), display ledger (sqlite), remote command relay
  voice/            intent, photo search/answers, TTS providers, usage
                    counters (metrics.mjs, stored in the frame DB)
  ambient/          weather (open-meteo), geocoding, location display
  insights/         sweep repository (sqlite cache) + collector (snapshot,
                    trips, graph); see docs/INSIGHTS.md
  wakeword/         custom wake-word model registry: inspector (tensor
                    contract validation) + store (integrity registry);
                    see docs/WAKE-WORDS.md
  support/          supporter-key verification (pinned public key)
  settings.mjs      UI-editable settings overrides (data/settings.json), with
                    numbered JSON migrations and a frozen persisted contract
  backup.mjs        automatic snapshots of the data files (docs/BACKUP.md)
  lifecycle.mjs,    small shared utilities: tracked timers + drain registry
  protocol.mjs,     for shutdown, the app protocol/capability handshake,
  boundedMap.mjs,   a size-capped map, fetch with timeout
  fetchWithTimeout.mjs
bin/backup.mjs      the same snapshot logic as a standalone CLI (cron)
public/             static UI on the Pictaria design system (pictaria.css)
data/               all persistent state (gitignored): enrichment.sqlite,
                    frame.db, smart-albums.json, settings.json,
                    insights.sqlite, wake-word-models/, backups/
```

## Conventions

- **Auth**: everything under `/api/` requires the app password when
  `APP_PASSWORD` is set — accepted as `X-App-Password` header,
  `Authorization: Bearer`, or the HttpOnly `pictaria_session` cookie issued
  by `POST /api/session` (the UI logs in once; the cookie rides on
  `<img>`/`EventSource` requests, which cannot send headers). Session
  signatures are bound to both `APP_PASSWORD` and a random installation
  secret persisted beside `settings.json`: password-only guesses cannot mint
  or verify cookies, normal restarts retain sessions, and changing the
  password invalidates them. Cookie-authenticated browser requests, and
  browser requests in deliberate open mode, reject foreign/null `Origin`
  authorities and cross-/same-site Fetch Metadata. Same-origin pages, direct
  navigations, and native clients without browser headers remain supported. Credential
  headers are not ambient browser authority and remain available to the Frame
  app and API clients. Routes that parse JSON require an `application/json`
  media type, closing the simple-form fallback. The raw-password
  `pictaria_pw` cookie never authorizes requests and is cleared on login.
  `/api/health` is always open, but
  unauthenticated callers get only `{ ok, service, time, authRequired }`.
  A blank or missing password fails server startup unless the independent
  `ALLOW_INSECURE_OPEN=true` escape hatch explicitly opts into an entirely
  unauthenticated deployment.
  The intended
  trust boundary is your own network: plain HTTP plus one shared password
  is a LAN (or Tailscale tailnet) posture — anything wider goes behind
  HTTPS or a VPN, per [Exposing beyond your
  LAN](../README.md#exposing-beyond-your-lan).
- **Errors**: JSON `{ "error": { "code", "message" } }` everywhere.
- **Immich client**: `src/immich.mjs` is the only place that talks to Immich.
  Binary responses are `{ data, contentType }`.
- **No runtime npm dependencies** — `node:` builtins only. Keep it that way.
- **State**: each feature owns one file (or directory) under `data/`, path
  overridable per feature (`DATABASE_PATH`, `FRAME_DB_PATH`,
  `ALBUMS_DATA_FILE`, `SETTINGS_PATH`, `INSIGHTS_DB_PATH`,
  `WAKE_WORD_MODELS_DIR`).
- **Restored-state failure policy**: startup and backup decisions follow the
  consequence of a failure, not a blanket rule that every malformed file must
  stop the whole server:
  - Missing, corrupt, redirected, or incompatible **core protected state**
    refuses normal startup before a store or migration can create replacement
    data. The log names the affected role and says that Pictaria refused to
    start; recovery remains an operator action until a dedicated recovery UI
    exists.
  - A missing or incomplete **pre-migration recovery point** refuses the
    migration and startup. A migration never runs merely because ordinary
    scheduled backups are optional.
  - A **recomputable role** may be rebuilt from its authoritative source.
    A structurally unsafe optional subsystem may instead be disabled with a
    warning while unrelated server functions continue. Custom wake-word
    storage uses that narrow degradation path for unsafe internal filesystem
    entries: built-in wake-word support remains available, the suspect data is
    left untouched, and its API reports unavailable. A missing registry or a
    failed integrity check still counts as loss of recorded protected state
    and refuses startup.
  - A bad source affects only that target in an **ordinary backup**: the
    snapshot records it in `missing[]`, is published as incomplete, and cannot
    displace a complete recovery point. The same incomplete result cannot
    authorize a migration.
  - A secret about to cross authorities, or an irreversible write whose
    safety cannot be established, is refused rather than degraded.

  The role classification is static application policy, not a claim supplied
  by restored state:

  | Role | Static classification | Failure behavior |
  | --- | --- | --- |
  | `enrichment.sqlite` | Protected core state | Refuse startup if missing, unreadable, structurally invalid, or unsafe to open |
  | `settings.json` | Protected core state | Refuse startup rather than initialize replacement settings |
  | `smart-albums.json` | Protected core state | Refuse startup rather than lose rules, confirmations, or job state |
  | `frame.db` | Protected core state | Refuse startup rather than silently reset display and voice history |
  | `wake-word-models/` | Protected state with one narrow optional-access exception | Refuse recorded-state loss or integrity failure; disable only custom-model access for unsafe internal filesystem entries |
  | `insights.sqlite` | Recomputable cache | Recreate from Immich without taking down unrelated features |
  | `persistent-state.json` | Safety metadata | Refuse startup if an initialized installation loses or corrupts it |

  `PROTECTED_PERSISTENT_ROLES` and `RECOMPUTABLE_PERSISTENT_ROLES` in
  `src/persistentState.mjs`, plus the static wake-word target failure mode,
  enforce this table. A restored `persistent-state.json` must exactly match
  those compiled-in role sets; it cannot relabel a protected role as
  recomputable or choose its own degradation policy.
- **Filesystem trust within configured state**: the host operator chooses and
  therefore trusts configured roots and parent paths. Those path components
  may legitimately include a symbolic link, bind mount, Docker volume, or NAS
  mount; Pictaria resolves and pins the resulting directory rather than
  rejecting the deployment shape. Names and files selected *inside* that
  boundary remain untrusted restored data. Protected entries use containment,
  no-follow opens, regular-file checks, and identity rechecks before Pictaria
  reads, changes permissions, migrates, replaces, or deletes them. A final
  symlink is rejected. A multi-linked protected file is rejected unless an
  operation deliberately materializes it as a new private copy. Filesystem
  ownership is deployment metadata, not proof of integrity, so a usable file
  is not rejected solely because its numeric UID differs after a restore.
- **Activity history**: structured operational events share the enrichment
  database so existing snapshot/restore coverage applies. Writes are bounded,
  privacy-allowlisted, and fail open; existing Enrich and Curate domain records
  remain authoritative and will be merged at read time rather than duplicated.
  The stable event vocabulary and explicit exclusions are documented in
  [Activity history](ACTIVITY.md).
- **Upgrade compatibility**: persisted settings are versioned and migrated
  sequentially before they are applied. A migration rewrites `settings.json`
  through the store's atomic temp-file replacement, and unknown keys or a
  version newer than the running server fail closed rather than being silently
  lost. Saved credentials whose destination can be configured carry the
  destination's normalized HTTP authority in the same state file. After a
  restore or environment change points one at a different authority, startup
  keeps the key quarantined in memory, leaves it preserved on disk, and makes
  Settings available so the administrator can restore the original authority
  or re-enter the credential for the new one. HTTP and HTTPS remain distinct
  authorities. Version-2 state recorded no credential provenance: its
  version-3 migration trusts only a saved Immich URL; legacy provider keys
  always require one-time re-entry because their former environment URLs
  were not persisted. Sanitized version-pinned inputs and the storage
  contract live under `test/fixtures/upgrades/`. The version-pinned
  whole-install fixture is
  materialized into temporary SQLite/JSON/directory state and opened through
  the same stores as production; it must survive migration, an idempotent
  restart, live backup, restore into a clean volume, and another restart with
  representative relationships intact. The named **Upgrade compatibility**
  CI job runs that scenario plus the focused SQLite migrations,
  persistent-state guard, settings, and backup suites. A persisted settings
  field addition—or a change to a field's name, type, environment fallback,
  enum/range, secrecy, or size limit—is a storage-contract change: bump the
  settings version, add the next migration, and freeze a new contract fixture.
  Any release that changes a persisted contract also bumps
  `PERSISTENT_STATE_VERSION`. Startup records the last server/state version
  that sealed successfully. Before migrations can run, it creates a complete,
  specially retained pre-migration snapshot and durably records it as pending.
  A retry revalidates and reuses that exact snapshot; it never snapshots a
  potentially half-migrated volume. Only after every production store opens
  and the global persistent-state guard seals does the last-successful marker
  advance. Older images refuse newer state: rollback restores the recorded
  snapshot rather than attempting arbitrary downgrade compatibility. Labels
  and help copy are deliberately outside the persisted contract.
- **Ports**: Pictaria Server listens on `4080`. It must be the only writer of
  its enrichment database (see Scale: review state is cached in-process and
  projected at write time, so external writes are invisible until restart).
- **Scale**: no request path or poll loop does whole-library work. The
  enrichment DB keeps a `latest_success` projection (the few review-path
  fields of each asset's latest succeeded run, written through on
  enrichment, raw values so taxonomy changes apply at read time), review
  queries are scoped to the review list or to explicit asset ids (chunked
  `IN` lookups), and the assembled review rows are cached against a
  repository write generation — every repository method that writes
  review-relevant state bumps it, so the referee tick and status poll cost
  no review SQL between decisions. Same-day thumbhash grouping is exact for
  ordinary days and uses a fixed candidate window plus a 250,000-comparison
  ceiling for dense imports, keeping that stage non-quadratic while retaining
  exact-hash, capture-time, and Immich duplicate signals. `bin/scale-bench.mjs` (temp database
  only, never `DATABASE_PATH`) seeds a synthetic library and holds the hot
  paths to budgets: at 10k listed assets, warm `assetsResponse` p95 < 30ms,
  cold/warm `pendingGroups` < 400/50ms, Best-of signals for 500 candidates
  < 40ms. **Supported scale is stated in review-listed rows, not library
  size** — they are different workloads. Benchmarked: 30k review-listed
  assets pass every budget (~412MB peak RSS under synthetic load); at 100k
  review-listed rows the same bench FAILS every budget (~1.24GB RSS,
  ~1.5s cold pending-groups / event-loop stall) — do not claim that scale
  without paging/materialization work or an explicit high-memory envelope.
  Measured reference installation (2026-07-16): a 115k-photo Immich
  library materializes 86k enricher-known assets and **27.4k review-listed
  rows** (27.2k enriched, 247k tag rows, 29k processing runs, 346 referee
  groups) — comfortably inside the verified 30k envelope, idling at ~34MB
  RSS with 3–13ms review responses on live hardware. Larger enrichment
  footprints grow Curate cold rebuilds and memory with review-list size —
  run the bench before promising more.
- **Display reporting is best-effort telemetry**, not product-critical
  state: batches are idempotent server-side, but the app holds pending
  reports in memory, so a process kill can drop unsent events and stats can
  undercount during flaky connectivity. Rotation and Metrics tolerate gaps
  by design; nothing entitlement- or correctness-critical may ever depend
  on display counts being complete.
- **Enrichment history retention**: `processing_runs` keeps every run
  (including raw model output) forever — growth is one row per asset per
  reprocessing pass, slow at household scale but unbounded. A retention/
  compaction policy is deliberately deferred; revisit when a real install
  reports pressure (the backup size is the early signal).
