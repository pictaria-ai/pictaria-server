# Changelog

All notable changes to Pictaria Server are documented here. This project follows
[Semantic Versioning](https://semver.org/).

## Unreleased

### Development

- Password prompts reliably appear even when a page receives an immediate
  authentication response during startup. The shared gate now loads before
  page callers and builds its dialog only when needed, including early calls
  before the page body exists.
- Curate's optional Stack Referee scope accepts blank, spaced and mixed-case
  environment values. Invalid values log a short warning and use **Uncertain
  stacks** without preventing startup or enabling AI. Unavailable-role notes
  distinguish saved on preferences from off defaults; an unsaved opt-out can
  be reversed without reloading Settings.

- Settings → Curate separates optional Stack Referee and Keeper Referee
  preferences, with **Uncertain stacks** (recommended) or **All stacks** scope
  for the Stack Referee. Preview AI workers are not connected yet: controls
  show their availability and cannot newly enable an unavailable role. The
  existing-page referee remains separate. Both new roles default off; upgrades
  preserve the previously effective keeper preference without activating a
  dormant legacy switch. Stacks off preserves dependent preferences. Settings
  version 8 / persistent-state contract 23 create the standard recovery point;
  older-build rollback requires restoring it. See [Curate AI](docs/CURATE-AI.md).

- Curate's existing AI referee stops preparing new work when Stacks, the
  referee or Enrich is disabled, when paused, or during shutdown. It rechecks
  those controls between photo downloads and before submitting to the provider;
  already-submitted calls may finish. Shared provider selection now lives in one
  job-start resolver for the upcoming Stack and Keeper Referees. This groundwork
  preserves the current prompt, saved settings and legacy Enrich dependency.

- Curate Preview places All/Stacks/Singles on the left and date, category and
  Search filters on the right, with Search last. Shown counts and active progress
  share the right side of the status row; the header checkbox appears in Singles
  and Decided. Finished incomplete checks keep their per-stack explanations
  without leaving an aggregate warning in the header. Search stays focused and
  editable while results load; typing during a slow request applies the latest
  text next, and failed requests preserve the search draft.
  A red notice beside the header spinner warns while Enrich is running that
  stacks may change as photos arrive. It keeps a fixed lower line when update
  text appears above it, with shorter fully visible wording on phones. Reserved
  scrollbar space prevents sideways movement between long and short views.
  Card check progress temporarily replaces
  the capture date on the same line, then restores it without resizing cards.
  The lightbox briefly shows **Saved — press Z to undo** after saving, without
  shortening the existing Undo window. The last-action bar has a dismiss button;
  dismissing it leaves Undo available and the next saved action shows it again.
  **Z** also undoes the last save from the grid, except while editing a field.
  Stack status is simplified to a working spinner, quiet readiness, or a muted
  **i** labeled **Grouped with limited evidence**. Hover and **Why?** retain the
  specific reason, including whether searches failed or finished inconclusively.
  Normal comparisons keep **Why?** without a completion checkmark.
  Explanations show useful details together without a nested dropdown or duplicate
  raw wording; the algorithm version remains in a small muted footer.

- Curate Preview settles failed similarity checks after one retry instead of
  keeping a long-term repair queue. Incomplete groupings remain ready for human
  curation, and healthy stacks continue processing. Finished outcomes survive
  restart; partial-pass checkpoints and retry deadlines are removed. Refresh
  reloads the view without restarting checks. Failed and inconclusive checks use
  the same muted information indicator, with distinct explanations. Saving one stack now
  preserves its checked/incomplete neighbours across restart. Upcoming comparisons
  and visible cards get priority; open comparisons no longer prompt users to
  close them for routine grouping updates. Enrich schema 18 /
  persistent-state contract 22 retains the normal pre-migration snapshot and
  discards retry checkpoints from the earlier unreleased preview.

- Curate Preview now distinguishes saved outcomes (including Fav) from drafts
  and checked batches. Stack keyboard choices advance without saving; **Save &
  next** continues with the latest grouping in the chosen date order. Undo is
  available inside the next stack; Enter cannot save an untouched comparison.
  Stack cards gain member previews and capture times, completed status is quieter, and Why
  uses plain-language explanations. Mobile filters collapse, bulk actions stay
  fixed below the grid, and comparisons retain the full uncropped images.
  Decided cards subtly shade the current decision button instead of putting a
  duplicate label over the photo; the lightbox uses the same shading.
  Selected stack draft buttons use those same subtle fills for all four choices,
  both beneath comparison photos and in the lightbox.
  Stack comparisons combine the title and photo count, omit the instruction
  paragraph, and place the check-status icon beside the checkbox controls.
  They align decision buttons beneath equal-height uncropped photo
  areas, and keep counts, Undo and Save actions in a slimmer footer.
  Single-photo navigation and decisions retain the lightbox through loading,
  preload adjacent images, and swap photos only when ready, avoiding the white
  comparison-window flash. Open in Immich is compact and vertically centered;
  the stack action now reads **Save** alongside **Save & next**.
  **Save & next** stays the primary action regardless of the chosen outcomes.
  Card captions stay on one line with an ellipsis, keeping decision buttons
  aligned; single-photo checkboxes have even padding. Background progress shows
  how many checks remain across all pending photos, including outside the view.
  The page header uses stable view, filter and results rows: Refresh and More
  sit beside Pending/Decided, shared controls stay anchored when optional
  filters disappear, and the selection slot remains reserved in Stacks.

- Curate checks now run in the background with Stacks enabled, including after
  server startup and new Enrich arrivals. Opening the page or Load more is no
  longer required. Complete checks survive restarts; active slots turn over to
  process the whole backlog, and failed searches retry with bounded backoff.
  Existing pacing and grouping rules are unchanged. A spinner beside Refresh
  and short inline progress show activity without moving the grid. Counts
  distinguish stacks and single photos, **Pending** replaces To curate, and
  clicking a stack opens it without a separate Compare button.
  Enrich schema **16** / persistent-state contract **19** adds the bounded
  completed-evidence cache, with the normal complete recovery snapshot before
  migration. See [Curate algorithm](docs/CURATE-ALGORITHM.md).

- Curate Preview combines **Pending / Decided**, category and date filters,
  compact card actions, and explicit bulk selection of single photos. Clicking
  a photo opens a production-style full-screen lightbox with tags and details
  beside it. Singles regain keyboard decisions, automatic advance and Undo;
  **Yes / Skip / Fav / No** appear under photos and in their lightboxes. Stack
  choices remain drafts until Save choices; independent checkboxes expose the
  same four actions for a batch. The footer counts every outcome. Long filenames
  are omitted, and the grey Why? explanation overlays photos on hover, focus or
  tap. The shared Settings gear opens the current feature’s settings; stacking
  wording now describes similar photos rather than just the same moment.
  Already-kept references remain read-only, and uncertain responses retain exact
  safe retry.
  Stacks are now just a comparison aid: Remove from stack, Split into singles and
  Stack corrections controls are removed; existing saved corrections remain intact.
  Background updates appear at idle boundaries while open comparisons and selected
  batches stay fixed. Loaded pages and scroll position are preserved. One Refresh
  button handles manual updates/recovery independently of background processing.
  Open comparisons clearly show unfinished checks; the More menu is aligned.
  This iteration remains at `/curate-preview.html`; AI referee integration and
  the default-page cutover are still pending. [Review flow](docs/CURATE-PREVIEW.md).

- Curate Preview now tries a versioned candidate stacking algorithm: wider time
  candidates, contextual people evidence, positive ThumbHash and reciprocal
  Immich search ranks. Selective background searches are paced and cached; new
  results appear automatically when idle, preserving open comparisons and selections.
  Cards show waiting/checking progress and highlight ready updates. Search results
  are applied only after all required references have been checked; completed
  evidence stays saved for unchanged pending candidates, preventing timed cache expiry
  from repeatedly splitting and rejoining an unchanged stack.
  Compatible uncertain photos stay together provisionally while
  searches are pending, unavailable or missing results. Enrich Group separates
  from None/One (Group vs Couple remains ambiguous). Searches skip references
  that cannot resolve uncertainty or support core recovery; rank counts use the original
  time group. Completed inconclusive checks are explicitly labeled uncertain.
  Candidate 3 uses repeated rank contrast between internally close subgroups to
  separate different compositions despite similar ThumbHashes. Larger hash-only
  groups get bounded verification searches; isolated missing results, failed
  checks and partial passes cannot trigger the contrast rule. Search size stays
  at 50; comparisons remain fixed throughout the open comparison.
  Healthy searches now start two seconds apart (up to 30 automatic requests per
  minute), with extra delay on slow responses. Open comparisons and visible
  cards take priority; cached evidence avoids network waits. Small queued/checking
  spinners and amber attention markers make progress visible
  without relying on color alone. Diagnostic counters expose request/latency and
  queue-completion measurements; grouping rules and search coverage are unchanged.
  Comparisons include **Why this stack?**, and unconfirmed time groups are labeled.
  Exact rules, bounds and change history live in [the algorithm guide](docs/CURATE-ALGORITHM.md).
  The released Curate page and AI keeper recommendations are unchanged.

- The stacking lab now compares directional Immich search ranks from multiple
  reference photos, with request estimates, progress, cancellation and explicit
  partial coverage. Each pass makes at most eight new paced searches; the matrix
  supports up to 40 photos. A separate **Combine evidence** mode combines
  ThumbHash, people evidence and reciprocal ranks, explaining supported,
  provisional and separated groups. Rules and cutoffs remain experimental;
  neither production Curate nor AI referees change. Combined mode now places
  supported pairs before uncertain attachments, adjusts ranks for other photos
  in the candidate group, and uses three ThumbHash bands. People
  differences and returned-rank contrast can separate shared-backdrop compositions;
  missing ranks stay unknown. Raw ranks and adjusted counts remain visible.
  Lab controls now sit beside the photos, with a bounded, collapsible settings
  panel on mobile. Rank tables and longer explanations expand below the photos.

- Added a testing-only **Stacking lab** linked from the Curate preview. Start
  with time-only groups, then try time/span, ThumbHash and Enrich people-category
  rules while keeping every photo visible in labelled proposed groups. Click a
  photo to highlight its group and inspect distances. Experiments combine local
  Enrich evidence with selected-photo Immich reads and do not save settings,
  make curation decisions or call AI.
  The people experiment separates None, One, Couple and Group without requiring
  matching Immich recognition. Cards display those two evidence sources separately.
  **Same recognized people** splits on any change in observed Immich identities
  in either lab mode, including partial overlaps and empty versus nonempty lists.
  Missing or failed recognition stays unknown. Hash/rank similarity cannot
  override this enabled rule; ordering and repeated IDs do not affect matches.
  Person 1 / 2 labels help explain the evidence within each experiment.
  Opening a group now refreshes recognition through Curate's shared metadata
  service. A Refresh from Immich button repeats the read; loading, missing,
  empty and failed results are distinct, with check times and fixed evidence
  while experimenting. Reads are bounded and cancellable, with no re-enrichment.
  An on-demand **Check similarity ranking** searches Immich from the group's
  earliest photo and shows other members' ranks among the first 50 timeline
  photo results (excluding the reference), plus search time. It reuses results,
  makes one bounded search at a time and does not apply a new grouping rule.
  See [lab rules and limits](docs/CURATE-STACKING-LAB.md).
- The Curate preview now offers **Date taken → Oldest first / Newest first**,
  remembered per browser. Sorting applies across the full result set before
  pagination, using each stack's earliest photo and placing unknown dates last.
  Stack membership, keeper choices and photo order inside comparisons are unchanged.
- Added an opt-in human-only Curate comparison preview at `/curate-preview.html`:
  stable complete stacks, multiple keeper selection, explicit reviewed remainder,
  conditional Undo and saved-versus-synced feedback. Earlier saved manual stack
  separations remain respected; their editing controls have since been removed. Interrupted actions can be retried safely
  after a reload. This is an implementation preview, not the v1.3 default-page or
  AI cutover. Photos toggle Keep directly; large comparisons default to a compact
  grid, and the large viewer supports Keep (K), Favorite and Never show. Singles
  have simpler controls; zero-keeper saves are neutral; Undo and conflict messages
  explain the current state. Enrichment schema 15 / persistent-state contract 18
  retains earlier correction action history and requires checkpoint restoration
  for rollback. See
  [preview scope and testing](docs/CURATE-PREVIEW.md).
- Added coherent Curate keeper/remainder operations, exact retry receipts,
  conditional Undo and synchronization status. The existing Keep best and Undo
  controls use atomic/conditional operations without changing their layout;
  the new multi-keeper comparison preview is described above.
- Curate and Frame Favorite/Hide now share durable decision-tag intent. Delayed
  retries respect newer choices, and failed Frame writes remain recoverable.
  Frame replies after the remote mutation while verification/repair continues in
  the background. Decision verification releases the shared write lane during its
  settle delays, so consecutive Frame actions can proceed; stale verification
  cannot repair over newer human decisions or AI tags. Unavailable photos become
  individually retryable failed jobs, allowing healthy photos from the same
  decision to finish synchronizing.
  Enrichment schema 14 / persistent-state contract 17 preserves existing decisions
  and adopts pending jobs from current local intent. See
  [Curate decisions](docs/CURATE-DECISIONS.md) for API, ownership and rollback details.

- Added the first Curate v1.3 foundation: conservative standard grouping,
  producing-configuration evidence, persistent separation constraints and bounded
  comparison APIs. The current Curate page and keeper recommendations are unchanged;
  the UI and decision cutover follow separately. See [Curate foundation](docs/CURATE-FOUNDATION.md).
- Curate foundation views share compact stable snapshots and replace comparisons
  as users browse. Separation retries retain their receipts after scope expiry.
  Unchanged discovery updates skip Curate recalculation; extra evidence is stored
  only for review-listed photos.
- Saved Curate foundation views now trigger bounded background Immich metadata
  refresh, with durable freshness/retry state and protection against stale responses.
  Pending photos and requested kept context receive available people/edit evidence
  without blocking page reads. This becomes user-facing with the later UI cutover.
- Enrichment schema 13 / persistent-state contract 16 adds Curate records without
  rewriting decisions or tags. Upgrade creates the normal recovery snapshot;
  rollback requires restoring that snapshot.
- Curate's foundation API can explicitly replace a previous view during refresh
  or filtering, releasing its snapshot budget while preserving other tabs' views.
  Retrying after a lost replacement response resolves the current successor,
  including after restart, so abandoned views do not retain obsolete snapshots.

### Fixed

- Immich metadata ingestion now clears cached thumbnail and duplicate-group
  fields when Immich explicitly returns `null`, preventing stale grouping evidence.
  Fields absent from a partial response still preserve their cached values.

## 1.2.1 - 2026-09-12

This patch improves Smart Album compatibility with older Immich versions and
hierarchical tag synchronization with Immich 3.2.

### Documentation

- Added guidance for managed tags and Immich workflows, API-key rotation and
  the resulting inventory refresh, and rechecking person filters after an
  optional Immich recognition reset.

### Fixed

- **Smart Albums on Immich before 3.1** now read metadata through complete
  date windows, avoiding duplicate or omitted photos at unstable page
  boundaries. Matching, exclusion and album-membership reads share the
  compatibility reader; newer Immich versions keep ordinary pagination.
  Legacy counts are checked independently, with one bounded retry on mismatch.
  Unverifiable exclusions or membership leave the album unchanged. Legacy
  exclusion/membership reads also include archived and hidden photos.

- Enrich and Curate tag sync now recover missing IDs from an incomplete
  successful Immich tag-creation response by refreshing the tag list once.
  This avoids a fallback incompatible with hierarchical tags on Immich 3.2;
  unresolved tags remain visible errors handled by the existing sync queues.

### Upgrade notes

- No new persisted-state migration from v1.2.0: persistent-state contract 15,
  Enrich schema 12, and settings version 7 are unchanged. Earlier releases
  still perform the v1.2 migrations when upgrading directly to v1.2.1.
- Node requirements, the Frame protocol, and the Immich compatibility floor
  are unchanged. The legacy Smart Album reader needs `asset.statistics` to
  verify completeness in addition to the existing asset/tag read permissions.
- Targeted live checks passed on Immich 2.7.5, 3.1, and 3.2: Smart Album
  reconciliation and Enrich/Curate tag writes. Broader Server/Frame testing
  against Immich 3.2 remains separate; this is not a blanket compatibility
  certification. See [Upgrading](docs/UPGRADING.md#upgrading-to-v121).

## 1.2.0 - 2026-09-10

This release focuses on Enrich: reusable profiles, predictable run settings,
faster library discovery, useful performance history, and automatic AI-tag
synchronization to Immich.

### Added

- **Enrichment profiles** pair reusable prompts and taxonomy. Create, copy,
  edit, archive, and restore profiles in Settings; select one active profile
  on Enrich for library sweeps, queued jobs, retries, and Daily Enrich.
- **Saved run settings** preserve the exact prompts, taxonomy, provider/model,
  and processing options used for each run. Running work and automatic retries
  keep those inputs when Settings changes. Run all uses one saved profile
  revision for the batch.
- **Enrich performance**, linked from Enrich and Settings, shows run history
  and compares setups by request speed, reliability, and throughput. Details
  include photo/request times, retries, timeouts, median and average times,
  Copy, and photo links to Immich. Missing or expired measurements remain
  explicit; older runs do not acquire invented timing data.
- **Configurable history retention** keeps 100–1,000 run summaries and
  Performance entries, with logs independently limited to the newest 0–100
  runs. Defaults remain 100 each; photo/request detail has separate bounds.

### Changed

- Library sweeps and Daily Enrich use a resumable local inventory and SQL
  eligibility checks instead of repeatedly walking already-enriched photos.
  Later runs fetch changed metadata; periodic full reconciliation catches
  missed changes. Large or interrupted discovery saves progress and reports
  incomplete work honestly.
- Every newly successful enrichment queues its AI tags for Immich, whether
  Send to Curate is on or off. Sync retries survive restart without repeating
  inference. Enrich shows pending/failed sync and a retry action; a separate
  backlog and coordinated writes preserve Curate responsiveness.
- **Send to Curate** on library sweeps adds only photos successfully enriched
  by that run. Explicit targeted selections can still send existing results.
- Provider and active-profile controls share one Enrich card. Profile editing
  lives in Settings, and Recent Runs focuses on processed photos rather than
  routine already-enriched skips. Logs retain compact discovery diagnostics.
- Lowering history limits prunes older records after confirmation. Raising
  limits cannot restore deleted history.
- First-run, configuration, and backup guides now cover the profile workflow,
  automatic AI-tag sync, performance page, and history controls.

### Fixed

- Settings changes cannot mix prompts or taxonomy within an enrichment run.
  With Only unenriched off, reprocessing checks use actual inference inputs;
  label-only or live review-policy changes do not force new AI calls.
- An Immich connection change cancels active enrichment and invalidates queue
  resolution instead of switching libraries midway through a run.
- Unexpected eligibility metadata excludes affected photos with diagnostics
  rather than blocking every sweep at the same page.
- Turning Enrich off pauses Daily Enrich, caption writeback, and automatic
  AI-tag sync while preserving pending work and saved preferences.
- Profile creation clearly distinguishes Pictaria templates from copies of
  saved profiles; new installations start with **My profile**.

### Upgrade notes

- This release uses **Enrich schema 12, settings version 7, and persistent-state
  contract 15**. Startup creates a complete pre-migration recovery snapshot.
  Keep that snapshot and the prior image/version; rollback requires restoring
  the snapshot with the matching older build, not opening upgraded state with
  older code. See [Upgrading](docs/UPGRADING.md#upgrading-to-v120).
- Existing effective prompts/taxonomy seed the initial active profile once.
  Check it in Settings after upgrading. Saved profiles then own inference
  content; the live Curate review policy remains separate. Earlier v1.2 preview
  queue pins are cleared while selections and historical snapshots remain.
- **Only unenriched** still skips every prior success. With it off, historical
  results lacking a known configuration may be reprocessed. Legacy failures
  no longer count toward the current configuration's failure limit, so
  subsequent sweeps may make fresh provider calls for previously stuck photos.
- Automatic tag sync requires Immich tag permissions. Pictaria manages the
  entire **ai/** namespace: re-enrichment can remove stale or manually added
  tags within that namespace. Human **frame/** decisions and unrelated tags
  remain intact. AI-tag searches/albums can include photos before curation.
  Existing enriched photos are **not** automatically backfilled on upgrade.
- The first budgeted library sweep builds the inventory. A full metadata
  reconciliation is expected on the first sweep after 24 hours; ordinary new
  uploads are discovered incrementally even with older capture dates.

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
