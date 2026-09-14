# Curate v1.3 contract prototype (PIC-366)

**Status: experimental; visual validation is outstanding.** This directory is
not imported by the server or included in its container. It does not change
Curate, migrate a database, or authorize automatic decisions. The SQL in
`decisions.mjs` is a disposable contract experiment, not a production migration.

Curate should find good, non-repetitive photos. A stack should represent
alternative shots, rather than everything photographed during one moment.
Grouping establishes the comparison boundary; the referee recommends zero,
one or multiple keepers inside it. Humans decide. Enrich remains optional.

This is the first implementation record for
[PIC-366](https://linear.app/aedr/issue/PIC-366). The reviewed behavioral contract
is the [functional specification](https://linear.app/aedr/document/curate-v13-functional-specification-8e7497272bc6).
Numbers below are proposed implementation budgets, subject to the remaining
measurements. Passing synthetic fixtures does not establish visual accuracy.

## Run the experiment

Requires the repository's supported Node runtime; no npm dependencies.

```sh
node --test test/experiments/curate-v13.test.mjs
node experiments/curate-v13/bench.mjs
node bin/scale-bench.mjs --assets=1000
node bin/scale-bench.mjs --assets=10000
node bin/scale-bench.mjs --assets=30000
```

The benchmark uses invented metadata and temporary SQLite files. It reads no
deployment configuration, sends no requests, and removes its temporary database.
The provider tests inject fake responses into the real OpenAI, Venice and
OpenAI-compatible transports. Their 30-image result proves serialization and
contract handling, **not provider acceptance, image comprehension or quality**.

The representative path groups a synthetic 30-photo burst, validates an explicit
two-keeper answer, applies all 30 outcomes atomically, and preserves read-only
context. Other tests cover missing/correlated facts, human separation through a
bridge, long chains, invalid partitions, stale advice, unrelated enrichment,
transaction failure, lost-response retries, conditional Undo, Frame writes,
restart, fair turns, coalescing and provider cooldowns.

## What to retain and replace

| Current code | Proposed responsibility |
| --- | --- |
| `src/enrich/reviewService.mjs`: `reviewRows`, `annotatedReviewRows`, `annotateBursts` | Retain the bounded review projection/cache pattern. Extract grouping from HTTP reads; replace adjacent-time union, raw-thumbhash confidence assumptions and arbitrary ten-member splitting. Global generation invalidates a cache, not every open human action. |
| `src/enrich/repository.mjs`, `schema.sql` | Retain SQLite transactions, review membership and producing-run/configuration provenance. Add the minimum group/action records below; do not build a general event platform. |
| `src/insights/collector.mjs`, `repository.mjs` | Reuse batched recognized-person metadata where available. Current `asset_people` rows alone do not prove detection completeness or distinguish missing from an empty result; retain freshness/omission information in the Curate adapter. Do not require Insights or fetch once per displayed card. |
| `src/enrich/refereeService.mjs` | Reuse bounded image fetch/source fallback and operational diagnostics. Replace ten-image grouping, default ranks/subject groups, people-over-landscape prompt bias and per-photo advice applicability. Remove unconditional yielding to any Enrich run. |
| `src/enrich/providers.mjs` | Reuse `analyzeImages` and bounded HTTP transport. Keep provider-specific schema handling (notably Venice). Pin provider/model/rendition/prompt when work starts. No silent provider fallback. |
| `src/enrich/reviewActions.mjs` | Preserve existing decision-tag meanings; extend the operation to an explicit per-photo outcome map. |
| `src/enrich/reviewService.mjs` sync workers, `tagWriteCoordinator.mjs` | Reuse the common remote mutation boundary, bounded batches and retries. Replace historical action replay with revision-checked, latest authorized per-photo intent. Human priority still needs bounded background opportunities. |
| `src/routes/enrich.mjs` | Route normal/bulk/stack decisions AND queued re-enrichment's explicit `clear`/reopen path through the new action boundary. Merely adding review membership is not a new keep/hide decision. |
| `src/routes/voice.mjs` | Frame Favorite and Hide currently mutate Immich directly. Both must enter the same durable intent boundary, including assets outside Curate. Favorite adds only `frame/favorite`; it must not inherit Curate Favorite's approval semantics. Hide adds never-show and removes eligible. |
| `src/enrich/runner.mjs` and AI-tag sync | Preserve scoped `ai/*` ownership, ordinary tags, and human decision tags. Enrich must not create a competing keep/hide writer. |
| `public/curate.js` and Curate routes | Replace two-request keep/skip operations and clear-as-Undo with an atomic receipt and conditional Undo. Keep loaded comparisons stable and render every selected keeper. Retain existing auth, thumbnail and Immich link conventions. |

The source audit found the two `applyDecision` entry points in Enrich routes
(direct review and queue reopen), plus Frame Favorite/Hide's direct writes.
Repository helpers are implementation boundaries, not extra user actions.
PIC-368 must repeat this writer search when wiring production changes; new
routes must not bypass it.

## Proposed data and action boundary

Choose explicit fields rather than relying on today's in-memory per-photo ranks:

| Record / owner | Minimum contents and storage direction |
| --- | --- |
| Per-photo evidence / PIC-367 | Existing asset/review projection plus a bounded `curate_input_json` and hash: capture time/source, image/checksum revision, available thumbnail descriptor, recognized IDs with observed/omitted/unknown status, producing run/config/schema identity, supported facts, availability. Keep large original model output in existing run storage. |
| Current group / PIC-367 | `curate_groups`: opaque ID, stable work-lineage ID, sorted full member IDs, pending IDs, bounded context IDs, method version, evidence/correction signature, concise reason codes. Publish a replacement atomically; display filters do not create new group identities. |
| Human grouping correction / PIC-367 | `curate_separations`: ID, original member partitions, revision, active/reset state. Index membership for bounded lookup. This survives recomputation and prevents transitive reunion; it is not a tag decision. |
| Role job and answer / PIC-370/PIC-116 | Replace the current referee group/pick representation with a role job containing lineage, exact input IDs/signature, resolved configuration, attempts/state, bounded exhaustive partition/keeper JSON and explanation. Keep old advice historical. Share one validator; no separate record per rank, explanation or subject. |
| Human operation / PIC-368 | `curate_operations`: request ID, canonical payload hash, inspected scope, outcomes, scoped before-state, resulting per-photo revisions, receipt and optional undo target. Atomic with current intent and outbox updates. |
| Latest intent / PIC-368 | Extend/replace current manual override and pending-sync storage with current per-photo revision and authorized managed-tag patch. One pending latest intent per photo, retaining affected-tag scope from superseded unfinished work. Store synchronization state/attempts there rather than another diagnostic subsystem. |

These are proposed production fields; the disposable spike intentionally uses
fewer tables and an opaque `input` signature. It does not yet implement evidence
ingestion, record pruning, correction lookup, migrations, or a production API.

Supported initial Enrich facts should come from the producing normalized schema:
`has_people`, `people_count` (none/one/couple/group/unknown), `scene`, `subjects`,
`composition`, and provenance. None/one/couple can map to count observations;
group is not an exact count. Unknown or contradictory `has_people`/count values
remain unknown. Quality scores are keeper evidence, not subject identity.
Custom taxonomies do not authorize interpreting arbitrary tag names using the
currently selected profile. Unsupported producing contracts contribute no facts.

The prototype's opt-in contradiction heuristic uses differing known people
counts, non-conflicting recognition observations and a thumbnail-distance signal.
It is **not calibrated and defaults off**. Its descriptor fixtures are invented
bytes, not decoded perceptual hashes. It misses different subjects with equal
people counts; recognition misses and correlated mistakes remain possible.
Keep this heuristic out of production until real positive/negative labels justify
it. Matching broad facts alone never earns an AI-confirmed label.

An immutable comparison snapshot has full displayed IDs, actionable pending IDs,
context IDs, relevant input/human/correction signatures, and an optional advice
signature. The server, not the submitted client ID list, establishes its scope.
An explicit manual action submits `{requestId, snapshotId, outcomesByPhoto}`.
Advice application additionally names its exact answer and applies its full
keeper set. Outcome IDs must exactly cover the actionable selection; context
cannot become writable. Any real membership/input/human/availability change
conflicts atomically. AI-only repartition of unchanged inspected photos does not
veto a manual choice. Unrelated enrichment or descriptive tags do not veto it.

One SQLite transaction validates and writes all outcomes, before-state, receipt,
and pending intents. Same request ID/payload returns the same receipt, even after
a lost response; different payload conflicts. Undo is a new compensating operation
and only succeeds if every affected photo still has the target operation's
revision. It restores only the operation's authorized tag scope. Initial API
targets: `POST /api/review/operations`, `GET /api/review/operations/:id`, and
`POST /api/review/operations/:id/undo`; retain existing routes as thin adapters
during cutover, not alternative implementations.

The worker checks current intent before submission and after completion. A stale
completion cannot acknowledge a newer revision; a newer pending patch repairs an
older in-flight write. Once current work completes, stop asserting it forever.
Partial Immich writes remain visibly pending/failed until resolved. No claim is
made about a global order spanning direct external Immich edits.

## Measurements and initial budgets

Measured on Node **25.9.0**, Apple M5 Pro, macOS. The initial draft also passed
Node 22 CI tests, upgrade checks and container build/boot smoke. Target-host
measurements remain necessary. Each prototype case ran in a fresh process:
one cold build, 20 rebuilds, 100 cached page serializations and 100
30-photo SQLite operations. p95 is the observed sample percentile, not a service
level guarantee. No real Enrich traffic ran inside the benchmark process.

| Synthetic collection | Cold grouping | Rebuild p95 | Cached page p95 | 30-photo decision p95 | Peak RSS |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1k pending | 3.15 ms | 1.07 ms | 0.02 ms | 2.04 ms | 82 MiB |
| 10k pending | 14.41 ms | 9.27 ms | 0.06 ms | 1.27 ms | 148 MiB |
| 30k pending | 33.43 ms | 28.53 ms | 0.06 ms | 1.23 ms | 307 MiB |
| 100 pending + 30k decided | 32.55 ms | 27.84 ms | 0.01 ms | 1.21 ms | 308 MiB |
| 30k tightly packed, conflicting counts/similar descriptors | 242.67 ms | 238.62 ms | 0.49 ms | 1.28 ms | 243 MiB |

The first four fixtures use cheap compatible facts and 30-photo candidate bursts.
The dense case exercises expensive comparisons and becomes one **unconfirmed,
manual-only** group when its evidence limit is reached. It is a resource stress
case, not a claim that such a huge group is good UX or visually correct.

At 30k, the normal fixture performs 60,472 candidate visits and 435,000 pair
comparisons; serialized grouping is 1.24 MB. The decided-heavy case still scans
30,100 inputs (not yet an incremental index), but exposes only four pending
groups. The dense case performs 1,917,920 comparisons and blocks the event loop
for up to 253 ms. This is evidence to run rebuilds in bounded background work,
not synchronously on each dashboard request. SQLite sizes are 0.71–2.33 MB after
100 synthetic operations, excluding real enrichment records and images.

For comparison, the **existing** full review-path benchmark (different fixtures,
80% pending) measured:

| Existing collection | `assetsResponse` p95 | `pendingGroups` cold / warm | Max loop delay | Peak RSS |
| --- | ---: | ---: | ---: | ---: |
| 1k | 0.6 ms | 10.2 / 0.2 ms | 17.3 ms | 99 MB |
| 10k | 2.9 ms | 111.5 / 1.9 ms | 117.3 ms | 271 MB |
| 30k | 8.6 ms | 310.8 / 5.2 ms | 315.1 ms | 513 MB |

All existing benchmark budgets passed. These tables are not an apples-to-apples
speedup claim: the prototype does not load real review SQL, build all display
fields, or implement HTTP routes. Preserve the existing tests as integration gates.

Proposed gates for PIC-367/368/346/118, to measure on the target Node 22 host:

* 30k collection rebuild <=500 ms total; warm list p95 <=30 ms; warm pending-work
  selection <=50 ms; local 30-photo decision p95 <=50 ms, excluding Immich latency.
* Keep request-thread work slices <=8 ms where practical, with measured event-loop
  p95 <=50 ms under mixed review/Enrich load. The synchronous spike does not meet
  the dense-case responsiveness goal; publish background results atomically.
* <=800 MiB peak process RSS for the complete synthetic server matrix; <=128 MiB
  incremental Curate working memory measured relative to the same server baseline.
  Prototype RSS is not an incremental-memory measurement.
* Start with 32 recent candidate groups, <=64 member comparisons per candidate,
  <=2 million soft comparisons per rebuild. Human separation is never skipped
  because of a soft limit. Timing starts at 15-second gaps/180-second span;
  these are candidate-search bounds, not proof of sameness. Report exhausted work
  as unconfirmed rather than dropping members or inventing confident chunks.
* Bound retained evidence to 4 KiB/photo and 100 recognized IDs/photo; omitted or
  stale information is unknown. Keep at most eight nearest already-kept photos
  as read-only context per displayed comparison. The spike has not implemented
  this context selection/retention cap; its full grouping JSON is a diagnostic.
* Cache no more than the current collection projection, current group index and
  one replacement build. Active comparisons have a 30-minute refreshable lease;
  expired snapshots require reopening, never silent scope expansion. Retain
  completed receipts for 30 days, never prune pending/failed work or a live Undo
  dependency, and reserve request-ID tombstones for a further 30 days. Measure
  storage growth before adopting retention numbers in production.

No 100k support claim is made. PIC-59 remains separate.

## AI request, scheduling and failure policy

Try a **single full-group request** first: <=30 images, <=2 MiB per rendition,
<=24 MiB aggregate raw image bytes (about 32 MiB base64 plus JSON). Load using
the existing bounded preview/thumbnail fallback; never silently fall back to
originals beyond the envelope. Two pending photos are required for automatic
keeper work; a sole newcomer with kept context remains manual. Oversized groups
remain inspectable but receive an explicit manual/unsupported result. Do not
discard a worthwhile second keeper through one-winner-per-chunk tournaments.

The real-provider 30-image quality test is still a completion gate. If the selected
model cannot handle it, revisit rendition sizing or a strategy that preserves all
candidate alternatives, with measured quality. Do not declare the synthetic
transport test sufficient or quietly reduce the required product envelope.

`scheduling.mjs` exercises the proposed policy with an explicit clock:

* One active Curate request globally. On shared resources, alternate completed
  Enrich and Curate opportunities; within Curate, give background a turn after
  at most two interactive turns. Independent backends may run concurrently.
* Default resource identity is normalized endpoint origin, independent of model
  and API path. A configured opaque resource alias joins endpoints sharing a
  local GPU. Do not put credentials in keys, logs, or aliases. Conservative
  serialization is preferable to pretending different model names mean separate
  hardware; shared-cloud concurrency can be refined later.
* Settle changed inputs for 30 seconds. Persist at most one active and one latest
  replacement per lineage/role. A lineage is the durable local candidate-cohort
  origin, not its membership hash: splits inherit it; overlapping merges retain
  the union of recent allowance history. PIC-367 must test this reconciliation
  so rotating members cannot manufacture a fresh budget.
* At most two automatic attempts per exact role/input revision, and three total
  automatic submissions per lineage/role in 30 minutes, including failures and
  successful-but-superseded work. Explicit re-check can exceed the automatic
  allowance, but cannot bypass disabled roles, pause or a provider cooldown.
* Failed requests impose >=60-second backend cooldown; three consecutive failures
  impose >=5 minutes. Honor Retry-After up to 30 minutes. Authentication/model
  incompatibility blocks automatic work until corrected. A failed enabled stack
  check leaves manual review available and prevents dependent keeper submission.
* Persist reservations and cooldowns before sending. Restarts, page reloads and
  toggle changes do not reset them. The policy tests serialize/reload state;
  production durable reservations, queue integration and history pruning remain
  PIC-346/PIC-118 work. The spike does not itself reconcile lineage merges.

## Private visual evaluation

Use only owner-approved renditions and the approved provider. Keep every image,
filename, source identifier, manifest and raw answer outside Git and Linear.
Public evidence should contain aggregate counts and failure categories only.
First label expected alternative groups separately from acceptable keeper sets;
do not derive the expected answer from the model being measured. Record whether
reference labels are owner-reviewed or provisional visual judgments. Authorization
to use a library does not mean its owner supplied or endorsed those labels.

`visual.mjs` defaults to a local dry run. A private manifest has this shape:

```json
{
  "photos": [
    {"id": "p0", "file": "rendition-a.jpg", "mimeType": "image/jpeg"},
    {"id": "p1", "file": "rendition-b.jpg", "mimeType": "image/jpeg"}
  ],
  "expected": {"groups": [{"ids": ["p0", "p1"], "keepers": ["p0"], "reason": "Owner-labeled alternatives."}]}
}
```

Paths resolve relative to the manifest. IDs are evaluation aliases (`p0`, etc.),
not library identifiers. Omit `keepers` for a grouping-only expected answer.
Missing labels produce no quality score. Use a manifest per case, including a
legitimate 30-photo alternative set with at least two worthwhile keepers.

```sh
node experiments/curate-v13/visual.mjs --manifest=/private/evaluation/case.json --role=keeper
```

After reviewing that dry-run envelope, set `CURATE_EVAL_PROVIDER`,
`CURATE_EVAL_MODEL`, `CURATE_EVAL_API_KEY` and optional `CURATE_EVAL_BASE_URL`
through the machine's existing private credential setup. No key in command-line
arguments, reports or chat. Then add `--submit` and
`--out=/private/evaluation/result.json`. Each invocation makes one request, with
no automatic retry or fallback. It never calls Immich or changes photo decisions.
The output must be outside this checkout, is created with mode 600 and is never
overwritten. A failure can leave an empty report; use a new filename on retry.

Record grouping false-merge/missed-alternative pairs separately from keeper-set
agreement, schema failures, elapsed time and bytes. The scorer compares an exact
label set; a human should adjudicate legitimate alternative keeper answers rather
than treating subjective disagreement as a technical failure. Repeat selected
cases with input order changed and fresh aliases to detect positional bias.

## Migration, sequence and remaining acceptance

PIC-372 should begin with a consistent backup and a paused/serialized cutover of
all human writers and sync workers. Preserve existing review membership, AI tags,
human tag meaning and provider overrides. Stacks carries forward its saved value;
new stack checking starts off. Enable the migrated referee only when prior
effective Enrich/referee settings permitted it **and** Stacks is on. Preserve
inactive preferences without turning decoupling into new automatic AI permission.
New installations have Stacks on and both AI roles off.

Mark old per-photo advice historical, preserve its source, and offer scoped
re-check; do not auto-replay paid work. Convert attributable pending Curate jobs
using their durable order and current intent, preserving dead/retry state. Old
Frame writes have no equivalent local chronology. Do not guess that a local
timestamp outranks remote state: reconcile affected pending managed tags against
Immich during controlled cutover; ambiguous overlaps stay held and visible for
explicit resolution. Unrelated AI tag jobs keep their ownership and retry state.
PIC-372 must test interrupted migration, offline Immich, partial sync, and restored
backup behavior. Restoring the matched pre-upgrade data backup is the dependable
rollback; an older binary opening changed SQLite is not a promised rollback path.

Proceed with a thin end-to-end slice before expanding the interface. Initial
effort estimate, excluding review/owner-testing waits: evidence/group contracts
2–4 focused engineering days; coherent intent 3–5; AI/runtime roles 3–5; comparison
UI/settings 3–5; migration/integration/docs 3–5. That is roughly **14–24 engineering
days**, not a calendar commitment. Re-estimate after the first slice and actual
visual evaluation; poor grouping/model quality is the largest unresolved risk.
Simple Curate usability issues can follow once these boundaries are stable.

Before PIC-366 can be complete:

1. Label and evaluate the owner-authorized private visual set, including incomplete
   recognition, scene/composition changes, real expression alternatives and a legitimate
   30-photo group. Run the prototype prompt against the selected real provider.
2. Use those results to adopt/reject semantic vetoes and validate the request
   envelope; document any narrowly necessary strategy change.
3. Validate target-host/Node 22 timings and the full mixed-load/context budgets;
   finalize lineage reconciliation, retained context and record lifetime choices.
4. Review these contracts and estimates, then link the accepted revision from
   the spec/plan. Production implementation remains in the follow-on issues.
