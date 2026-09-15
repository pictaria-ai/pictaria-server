# Curate v1.3 foundation

This is the production foundation being built in PIC-367. The existing Curate
page and released referee continue using their existing interfaces. PIC-368
supplies coherent decisions/sync/Undo and PIC-369 moves the comparison UI onto
this foundation. The legacy grouping path must be removed at that cutover;
maintaining two permanent grouping implementations is not the plan.

## Grouping and evidence

A stack represents plausible alternatives, rather than simply a shared moment.
Standard grouping works without Enrich or an AI provider. Capture-time candidates
use a 15-second gap and a 180-second total span, at most 32 recent candidates,
64 soft member comparisons per candidate and two million comparisons per rebuild.
Exact original checksums and Immich duplicate IDs can discover candidates outside
the time window. Thumbnail similarity and longer-gap lookback are not enabled.
There is no ten-photo chunking of logical stacks.

Available producing-schema evidence can separate candidates whose explicit
none/one/couple counts differ and whose recognized-person observations corroborate
those counts. Missing faces, contradictory counts, group/unknown results, or
unsupported producing schemas stay unknown. Equal counts do not prove matching
subjects. Empty recognition is never described as complete. This is a conservative
initial rule with limited visual calibration, not a universal composition detector.

Saved human separations apply to every group member even when the soft comparison
budget is exhausted. A new bridge cannot reunite separated photos. A removed photo
may still join other compatible alternatives. The computation records its actual
route and concise reasons; it does not invent a confidence score or call an AI
model for explanations. A checksum check bypass additionally requires compatible
observed rendition identity and an explicitly observed unedited state (`isEdited: false`).
The optional flag is defined in the [Immich 2.7.5 API](https://github.com/immich-app/immich/blob/v2.7.5/open-api/immich-openapi-specs.json). Missing edit-state evidence does not authorize a checksum bypass.

`src/curate/evidence.mjs` reads the schema of the configuration that produced the
successful Enrich result. Active profile names and arbitrary `ai/` tag spellings
cannot establish people counts. Changing provenance alone does not invalidate
an otherwise identical comparison. New tags, supported grouping evidence, observed
image identity, membership, or human state can change its applicability.

## Storage and runtime

The existing enrichment SQLite database owns the additive schema-13 tables.
Persistent-state contract 16 requires the ordinary pre-migration recovery point;
rollback uses that snapshot, not a promise that the v1.2.1 binary understands new
state. No human decisions, existing tags, old referee verdicts, or profile settings
are rewritten during this migration. Existing review rows enter a durable dirty
queue, and their projection can resume after interruption.

| Record | Purpose and bounds |
| --- | --- |
| `curate_observations` | Partial Immich observations; absent fields do not erase observed recognition. At most 4 KiB and 100 recognized IDs, with omissions explicit. |
| `curate_photos` | Compact indexed projection plus cold bounded evidence. The worker reads only grouping columns, not prompts, captions or full normalized Enrich results. |
| `curate_dirty` | Transactional change tracking across assets, successful enrichment, tags, membership, overrides and observations. Unchanged projections do not increment the grouping generation. |
| `curate_separations` / members | Durable active human constraints, conditional reset and 30-minute correction Undo. Neither writes photo decisions or Immich tags. |
| `curate_leases` / view groups | Server-issued 30-minute scopes, at most 200 live leases and 5 MiB encoded scope data. Indexed view rows preserve order and full membership across pages. Expired leases delete their saved view rows. Capacity refuses new scopes instead of silently evicting live ones. |
| `curate_advice` / members | Shared exhaustive-partition and keeper-set validation with producing schema/input metadata. New advice replaces overlapping current scope for that role; no raw-response history. Real provider calls and their lifecycle remain PIC-370/PIC-116/PIC-346 work. |

Evidence projection uses bounded transactions with a 4 ms yielding target. One
read-only worker loads a coherent SQLite snapshot and builds complete groups.
Publication replaces the old index atomically, and the worker exits before another
can start. A failed rebuild leaves the prior view usable. The source connection
remains the only writer. Normal reads make no per-card Immich requests. Existing
asset ingestion records observations it already fetched; an explicit metadata
refresh adapter accepts at most 500 listed photos and runs at most two requests
at once. Authentication/transport failures do not become deletion evidence.
Automatic refresh demand and admission belong to the upcoming integration.

Already-kept context comes from an indexed query of at most 64 candidates within
the local time bounds, selects at most eight compatible photos, and reports
omissions. It is read-only. A single pending newcomer remains a single for manual
comparison; automatic newcomer-versus-kept keeper evaluation is not introduced.

## Foundation API

These authenticated endpoints support the upcoming interface, not a second public
Curate page. They inherit the server's existing password/session/origin checks.

- `GET /api/review/curate/groups`: open a saved view; optional `kind` is `all`,
  `stacks`, or `singles`, and `q` searches through members without shrinking a stack.
- The same endpoint with `viewId`, `offset`, and `limit` pages up to 50 group
  summaries in the original order. `updatesAvailable` does not mutate that view.
- `POST /api/review/curate/comparisons` with `viewId` and `groupId` returns the
  full pending ID scope, a comparison ID, bounded photo details, and separate
  read-only context. Details beyond 50 photos are retrieved using
  `POST /api/review/curate/comparisons/photos` with `comparisonId`, `offset`, `limit`.
- `POST /api/review/curate/separations` supplies `comparisonId` and an exhaustive
  disjoint `partitions` array. The UI will expose Remove from stack / Split into
  singles, not an arbitrary subgroup editor. A repeated identical request is
  idempotent; changed payloads cannot reuse the correction ID.
- `POST /api/review/curate/separations/reset` supplies correction `id` and expected
  `revision`; `undo: true` additionally enforces its Undo deadline.
- `DELETE /api/review/curate/leases` releases an `id` when its view closes.

Comparison scopes bind inspected IDs and per-photo material/human signatures.
Related dirty candidates and new group members prevent a stale correction;
unrelated imports do not fail a scope solely through a global generation change.
Photo decisions, outcome authorization, operation receipts, cross-entry-point
intent ordering and remote synchronization are not implemented by these endpoints.
PIC-368 must consume these scopes inside its actual atomic decision operation.

## Validation and remaining acceptance

The focused suite exercises producing-schema provenance, positive and missing-face
cases, complete 30-photo stacks, bounded long chains, hard separations, stale
inputs and membership, related versus unrelated updates, read-only context,
capacity/expiry, real worker/HTTP paths, schema-12 migration, SQLite restart, and
online backup/restore. Fixtures contain synthetic photos and no credentials.

Run `node bin/curate-foundation-bench.mjs` for isolated 1k/10k/30k, decided-context,
and dense fixtures. It reports initial evidence backfill separately from a
persisted-projection rebuild and from opening/paging a view. RSS is a sampled
whole-process delta for this harness, including SQLite/worker/GC effects, not
complete-server acceptance or a retained-heap measurement. It does not load the
application environment, contact Immich, or invoke inference.

Before PIC-367 is considered complete, finish integration of evidence-refresh
admission, validate the complete collection/resource gates, and reconcile the
shared cohort/admission boundary with PIC-346. The first production slice does
not waive the 500 ms rebuild, 8 ms practical slice, 30 ms list p95, 50 ms local
decision p95, 128 MiB incremental Curate or 800 MiB complete-server budgets.
Broader real-photo and long-chain quality remains for integrated owner review;
the small earlier convenience sample is not general accuracy evidence. PIC-372
and PIC-373 retain whole-release migration and runtime acceptance.
