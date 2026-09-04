# Changelog

All notable changes to Pictaria Server are documented here. This project follows
[Semantic Versioning](https://semver.org/).

## Unreleased

## 1.1.0 - 2026-09-03

### Added

- Optional **Daily Enrich** runs can process a user-set budget of new,
  unenriched photos once per day with the currently selected provider. The
  Settings UI remembers the browser's time zone, busy manual runs keep
  priority, and the result appears in normal run history.
- A generic OpenAI-compatible provider can now connect Enrich, the Curate AI
  referee, and provider-selectable voice answers to llama.cpp and similar
  chat-completions servers using a configurable base URL, model, and optional
  bearer key. It uses portable JSON-object output and keeps Pictaria's full
  local response validation.
- Curate decision confirmations now offer a five-second **Undo (Z)** action
  for individual photos and whole Stacks, returning the most recently decided
  photos to the queue without interrupting the review flow.
- Enrich Recent Runs cards now offer **Re-run N failed photos** for content
  and infrastructure failures that still need work. The server recalculates
  the set at click time, so later successes, deleted photos, and deliberately
  discarded photos are never reprocessed from a stale card.
- Enrich Recent Runs now show privacy-safe end-to-end throughput for successful
  photos, with the provider, model, and an optional operator-authored inference
  host label for comparing setups without adding prompts or provider responses
  to run history.
- Enrich Recent Runs now starts with the newest 20 summaries and offers
  **Load more** until every retained run is visible, including its log and any
  still-retryable failed photos.

### Changed

- Settings now keeps Immich description-sync status and its backfill action
  beside the writeback control, with plain-language photo counts for synced,
  unchanged, queued, and failed states.
- Settings now identifies Voice TTS as a Pictaria Frame feature and clarifies
  where its provider connections and Frame-owned voice controls are configured.
- Enrich cancellation now aborts the active AI-provider request immediately
  instead of waiting out that photo's provider timeout. The cancelled photo
  remains retryable on the next run, and queued work stays in place.
- The persisted Settings contract advances from the shipped version 3 to 6
  and the installation-state contract from the shipped version 5 to 8;
  intermediate versions were never released. Existing installations take the
  standard automatic pre-migration recovery snapshot before adopting the
  additive provider, per-run benchmark-context, and Daily Enrich settings.
- Enrich now retries a photo twice when any configured provider reports a
  temporary 429 or 503 response, honoring bounded `Retry-After` guidance and
  keeping cancellation responsive during the wait. Persistent overloads stop
  multiplying those waits across a run until the provider responds again. The
  Curate AI referee also uses bounded provider retry guidance before its
  existing five-minute fallback.

### Fixed

- A server shutdown that outlasts an Enrich run's drain now records exactly
  one interrupted Recent Runs entry. If abandoned work later settles, it
  cannot append a contradictory outcome or advance the queued job.

### Compatibility

- A 1.0.1 installation migrates persisted Settings from version 3 to 6 and
  the installation-state contract from version 5 to 8. It creates and verifies
  the standard automatic pre-migration snapshot before applying the additive
  provider, run-context, and Daily Enrich settings.
- Before upgrading, operators using a custom `BACKUP_DIR` must complete its
  one-time adoption as documented in [Backup and restore](docs/BACKUP.md).
  Startup intentionally stops if that destination is unavailable or unadopted,
  even when scheduled backups are disabled, rather than migrating without a
  verified recovery point.
- A rollback to 1.0.1 after 1.1.0 has started requires restoring the complete
  pre-migration snapshot before the older server is started. Pointing 1.0.1 at
  a 1.1.0-migrated data directory is not the documented rollback path.
- The Frame protocol, Node requirements, and Immich 2.0+ compatibility floor
  are unchanged. Docker Compose installations should download the 1.1.0
  Compose file and review the new OpenAI-compatible and Daily Enrich settings.

## 1.0.1 - 2026-09-02

### Changed

- Curate now offers the same synchronized **Load more** control below the
  photo grid, so long review sessions do not require scrolling back to the
  toolbar for another page.

### Fixed

- Enrich rejects caption prompt labels and placeholder text from small vision
  models instead of storing them as captions, and explicitly tells models to
  return caption text only.
- Docker Compose now forwards every documented non-path enrichment, AI,
  Curate-referee, voice, and geocoding variable, including LM Studio's token
  cap and temperature. Empty Compose values preserve the same runtime defaults
  as a native installation; custom taxonomy and prompt paths still require a
  matching container mount.
- Curate verifies and repairs both sides of every Immich tag decision, so a
  rejected or reviewed photo cannot finish synchronization while retaining
  `frame/eligible` or `frame/favorite`, and approving a photo likewise removes
  contradictory rejection tags.
- Insights keeps legitimate crowd photos in the library sweep when Immich
  reports more than 100 people. People relationships remain capped and excess
  entries are counted and surfaced instead of aborting the complete snapshot.
- Immich tag verification now distinguishes unavailable tag data from tags
  that remain missing after a repair attempt, and reports the relevant Tags
  feature, API-key permissions, and affected-photo writability checks.
- Insights ignores oversized Immich EXIF fields it does not store, while
  retaining strict bounds for metadata it uses. Malformed numeric metadata is
  left blank, counted, and reported without dropping the asset or the sweep.
  Refresh failures remain visible even when a run ends before the first status
  poll observes it.
- LM Studio Enrich and Curate requests accept validated schema JSON when a
  thinking-capable model returns it in `reasoning_content` with empty ordinary
  content. Voice and other prose never expose that reasoning channel.
- OpenRouter Enrich and Curate requests adapt strict schemas to Google
  Gemini's documented JSON Schema subset while retaining Pictaria's complete
  local validation. OpenRouter failures now expose bounded, credential-redacted
  provider and structured upstream error details; empty responses expose
  request and finish metadata instead of a context-free error.
- LM Studio-compatible local requests use a fresh HTTP connection for each
  generation, avoiding `socket hang up` failures when llama.cpp closes a
  completed connection before Pictaria's stricter validation retry.

### Compatibility

- Persisted-state contracts, the Frame protocol, Node requirements, and the
  Immich 2.0+ compatibility floor are unchanged from 1.0.0. This is a
  code-only update with no startup migration.
- Docker Compose installations should review their `.env` before upgrading.
  Documented non-path settings that earlier Compose files did not forward now
  take effect when configured, including enrichment limits, AI model and
  timeout overrides, and geocoding timeouts.

## 1.0.0 - 2026-08-28

The first public release of Pictaria Server: a self-hosted companion for
Pictaria Frame and Immich libraries.

### Added

- **Insights** provides local collection statistics, people and place views,
  timelines, trips, records, cameras, tags, and photo drill-downs. Optional
  Geoapify place naming uses the operator's own account.
- **Enrich** classifies selected photos into an operator-controlled taxonomy and
  can generate captions. It supports locally operated Ollama and LM Studio, or
  operator-provisioned OpenAI, OpenRouter, Venice, and Ollama cloud providers.
- **Curate** turns selected photos into a durable human-review queue. Related
  photos form Stacks with suggested keepers, keyboard navigation, comparison
  tools, optional AI referee ranking, and explicit keep or never-show choices.
- **Smart Albums** synchronize real Immich albums from saved people, tag, place,
  date, camera, or free-text rules. Optional Best of ranking combines search
  results with enrichment and Curate signals.
- **Frame Remote** reports live frame state and sends targeted commands to one
  of multiple connected frames. Settings can retire old device records.
- **Frame Metrics** records bounded local display counts and voice-command
  labels per device. Voice transcripts are never stored.
- **Voice and Ambient services** provide intent parsing, photo questions,
  one-shot questions, show-search, text-to-speech, weather summaries, and
  optional place naming for compatible Pictaria Frame clients.
- **Custom wake-word management** uploads structurally compatible TensorFlow
  Lite models, publishes their metadata to frames, and includes registered
  models in backups. Wake-word inference remains on the frame.
- **Runtime Settings** configures Immich, AI providers, prompts, voice, Insights,
  Smart Albums, backups, and other optional features without restarting the
  server. Infrastructure-managed environment values remain available.
- **Activity** provides a bounded local history of operational events with
  filters and privacy-limited JSON or CSV exports.
- **Automatic backups** snapshot databases, state files, and registered custom
  wake-word models while the server is running. Scheduled and manual backups,
  retention, off-machine destinations, restore validation, and pre-migration
  recovery snapshots are supported.
- **Docker and bare-Node deployment paths** include a first-run guide, complete
  configuration reference, service examples, backup and restore procedures,
  upgrade and rollback guidance, and Immich compatibility notes.
- **Single-container packaging** stores persistent state in one `/data` volume
  and exposes an application API plus an always-open health endpoint on port
  4080. Unauthenticated health responses contain only minimal status fields.

- Production installation and upgrade instructions select an explicit source
  release and its matching numeric container image tag. Moving `main` is a
  development preview, not a production upgrade path.
- Browser administration authenticates with an HttpOnly session cookie; the
  application password is never retained in browser storage. Sessions survive
  ordinary restarts and expire when the password changes.
- Startup requires a non-empty `APP_PASSWORD` unless the operator explicitly
  enables insecure open mode. Open mode remains visibly identified and retains
  browser-origin protections.
- Settings and persisted state use schema-versioned, atomic updates. Established
  installations receive a verified pre-migration snapshot before a
  persisted-state migration can begin.
- Enrich and Curate are independent, composable workflows: an Insights slice or
  completed enrichment run can enter Curate, and existing decisions are not
  reopened unless the operator explicitly asks.
- Provider credentials saved in Settings remain bound to the server identity
  for which they were configured, including across restores and restarts.
- Smart Album schedules restored onto another installation require local review
  before they resume.
- Both HTTP and HTTPS Immich endpoints are supported. Private certificate
  authorities must be trusted by the Node process inside the container.

### Reliability and data safety

- Database migrations, Insights publication, enrichment records, Curate
  decisions, Smart Album state, and settings saves commit atomically so an
  interrupted write cannot publish a partial generation as healthy state.
- Backups use online SQLite copies, private permissions, atomic publication,
  cross-process locking, ownership evidence, destination adoption, and complete
  recovery-point retention. Missing mounts and incomplete snapshots fail
  visibly instead of silently becoming the newest backup.
- Startup refuses to replace expected persistent state with an empty install
  after loss, corruption, an unsafe symlink, or a failed required migration
  snapshot.
- Smart Albums serialize concurrent changes, preserve every rule field across
  restarts, reconcile exact membership, and fail closed when Immich pagination
  or candidate data is incomplete.
- Enrich and Curate queues, retries, restored work, image downloads, provider
  replies, grouping, pagination, and background processing have explicit time,
  item, and byte limits. Provider outages do not consume a photo's permanent
  failure allowance.
- Insights builds into staging tables and publishes only a complete generation;
  cancelled, failed, or truncated sweeps leave the previous good view intact
  and report their state honestly.
- Frame command routing never broadcasts a targeted command to another device,
  display-report retries are idempotent, and event streams have fixed capacity
  with backpressure cleanup.
- Immich, provider, weather, geocoding, and text-to-speech deadlines cover both
  response headers and bodies. Redirects cannot reinterpret configured service
  boundaries.
- Curate review controls, long filenames, tall Stacks, compare navigation,
  queue pagination, provider persistence, and mobile navigation remain usable
  across supported screen sizes and long-running jobs.

### Security and privacy

- Pictaria Server has no telemetry, analytics, or Pictaria-operated cloud
  service. Optional provider requests occur only through services the operator
  configures and are described in the Privacy and Configuration documentation.
- Browser sessions, cookie-authenticated mutations, open-mode browser requests,
  Host validation, reverse-proxy handling, request content types, login delays,
  and bounded per-client and global password-attempt limits are enforced.
- Health responses reveal only a minimal unauthenticated shape. Sensitive
  prompts, transcripts, captions, provider errors, credentials, and request
  bodies are excluded or redacted from Activity and diagnostic output.
- Outbound credentials remain scoped to their configured authority. Redirects
  are rejected, fixed API paths cannot be reinterpreted by a configured URL,
  and restored credentials do not silently move to another server.
- File-backed state, wake-word models, backups, and restored databases use
  symlink-safe boundaries, private permissions, atomic replacement, quotas,
  format validation, and size limits.
- Image proxies validate bounded raster responses before serving them, and all
  externally supplied JSON, search plans, filters, identifiers, and downloads
  are subject to explicit resource limits.

### Requirements and compatibility

- **Node:** `^22.16.0 || >=23.8.0`. Earlier builds do not provide every
  `node:sqlite` API required by the server and fail at boot.
- **Immich:** 2.0 or newer. This release has been tested with Immich 2.7.5 and
  3.1.0; other compatible versions may work but are not explicitly validated.
- **Container platforms:** `linux/amd64` and `linux/arm64` are built by the
  release workflow.
- **Deployment boundary:** Pictaria Server is designed for a LAN or private VPN
  and uses one shared administrator password. Do not port-forward it directly;
  use an HTTPS reverse proxy or private VPN for access beyond the LAN.
- **License:** GNU Affero General Public License, version 3 only
  (`AGPL-3.0-only`).
