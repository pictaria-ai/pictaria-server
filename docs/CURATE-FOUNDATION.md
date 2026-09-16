# Curate v1.3 foundation

This is the production foundation being built in PIC-367. The existing Curate
page and released referee continue using their existing interfaces. PIC-368
supplies [coherent decisions/sync/Undo](CURATE-DECISIONS.md) and PIC-369 moves the comparison UI onto
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

The foundation now admits bounded background asset-detail refresh while a saved
Curate view is live. `GET /assets/{id}` supplies `people`, `isEdited`, orientation
and availability when Immich provides them; unsupported or unfetched fields stay
unknown. Normal list/comparison responses never wait for these requests. Updated
evidence can change the next view, while an already-open view keeps its membership.
The released Curate page still uses the old path until PIC-369's cutover; it does
not open these foundation views or start their refresh demand.

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
The decision layer additionally uses schema 14 / persistent-state contract 17.
The current contract requires the ordinary pre-migration recovery point;
rollback uses that snapshot, not a promise that the v1.2.1 binary understands new
state. No human decisions, existing tags, old referee verdicts, or profile settings
are rewritten during this migration. Existing review rows enter a durable dirty
queue, and their projection can resume after interruption.

| Record | Purpose and bounds |
| --- | --- |
| `curate_observations` | Extra Immich evidence for review-listed photos only: recognition, orientation, edit state and availability flags. Identity, dimensions and visual descriptors stay in `assets`. Absent fields do not erase observed recognition. At most 4 KiB and 100 recognized IDs, with omissions explicit. Removing a review row removes its extra observations. |
| `curate_photos` | Compact indexed projection plus cold bounded evidence. The worker reads only grouping columns, not prompts, captions or full normalized Enrich results. |
| `curate_metadata` / control | One durable refresh row per review photo, indexed due work, last observation result, claim cooldown and connection-wide retry state. No responses, credentials or provider prompts. Removing a review member removes its refresh row. |
| `curate_dirty` | Transactional change tracking across assets, successful enrichment, tags, membership, overrides and observations. Asset updates queue work only when a grouping source column changes; an unchanged discovery sync does not re-project the collection. Unchanged projections do not increment the grouping generation. |
| `curate_separations` / members | Durable active human constraints, conditional reset and 30-minute correction Undo. Neither writes photo decisions or Immich tags. |
| `curate_leases` / view snapshots / view groups / view replacements | Server-issued 30-minute scopes, at most 200 views and 200 comparisons, with one current comparison per view. Identical ordered memberships share immutable indexed snapshots; single-photo IDs are stored once per snapshot. The shared 5 MiB bound counts every retained snapshot, lease and replacement record. Closing/expiring the last owner removes its snapshot. Capacity refuses new scopes instead of evicting another view. |
| `curate_advice` / members | Shared exhaustive-partition and keeper-set validation with producing schema/input metadata. New advice replaces overlapping current scope for that role; no raw-response history. Real provider calls and their lifecycle remain PIC-370/PIC-116/PIC-346 work. |

Evidence projection uses bounded transactions with a 4 ms yielding target. One
read-only worker loads a coherent SQLite snapshot and builds complete groups.
Publication replaces the old index atomically, and the worker exits before another
can start. A failed rebuild leaves the prior view usable. The source connection
remains the only writer. Normal reads make no per-card Immich requests. Existing
asset ingestion records additional observations it already fetched for listed
photos. Unlisted library discovery stores no Curate observation rows.

Metadata refresh is a separate Immich-read lane, not the AI job queue:

- At most 500 photos per batch, two concurrent reads, a 30-second request deadline
  and a 1 MiB response ceiling. Each result is applied in a short transaction,
  with a yield before the next request. Unknown optional fields do not cause a loop.
- Pending review photos are due initially, then after 24 hours while a live view
  exists. Observed image/detail changes can request an earlier read, with a durable
  30-second per-photo minimum. Enrich output and human decisions alone do not.
  Reopening a page preserves these timestamps; restart preserves claims and retries.
- Already-decided history is not scanned for refresh. Opening a comparison can
  prioritize its at-most-eight read-only context photos when due. Context demand
  expires after 30 minutes; expired work is retired in bounded indexed pages.
- Authentication, rate-limit and connection failures pause the entire lane for
  30 seconds, doubling up to 15 minutes. Recovery starts with one probe. Only
  404/410 mark a photo unavailable; malformed/oversized responses retain prior
  evidence and record `invalid-response` until another refresh is due.
- Applying a response checks the current connection, review membership, claim and
  source-image/detail fingerprint. A late response cannot overwrite a newer local
  observation or restore removed membership. Human decisions are never rewritten.
- Stacks off, no connection, or no live view stops new work. Stacks/connection
  changes and shutdown cancel in-flight reads. Enrich and AI-provider settings do
  not control this lane. A changed Immich connection resets its read/backoff state;
  prior evidence remains explicitly last-observed until replaced.

The shared Immich client accepts caller cancellation and a smaller response bound
for this lane; other callers retain their existing defaults. Metadata refresh
performs no image downloads, AI calls, tag writes, album changes or curation actions.

Already-kept context comes from an indexed query of at most 64 candidates within
the local time bounds, selects at most eight compatible photos, and reports
omissions. It is read-only. A single pending newcomer remains a single for manual
comparison; automatic newcomer-versus-kept keeper evaluation is not introduced.

## Foundation API

These authenticated endpoints support the upcoming interface, not a second public
Curate page. They inherit the server's existing password/session/origin checks.

- `POST /api/review/curate/groups`: open a saved view. Optional `kind` is `all`,
  `stacks`, or `singles`; `search` matches through members without shrinking a stack.
  Supply `replacesViewId` to relinquish this caller's previous view and comparison
  when opening the new view. Other tabs' scopes and snapshot ownership stay intact.
- `GET /api/review/curate/groups` with `viewId`, `offset`, and `limit` pages up to 50 group
  summaries in the original order. `updatesAvailable` does not mutate that view.
  `metadata` reports refresh state and a bounded problem code/retry time. Photo
  details carry the last `checkedAt` and `outcome`; absence is not proof of freshness.
  The earlier GET-based open (`kind`, `q`) remains available for staging callers;
  replacement requires POST so a prefetched link cannot close an existing scope.
- `POST /api/review/curate/comparisons` with `viewId` and `groupId` returns the
  full pending ID scope, a comparison ID, bounded photo details, and separate
  read-only context. Details beyond 50 photos are retrieved using
  `POST /api/review/curate/comparisons/photos` with `comparisonId`, `offset`, `limit`.
  Reopening the same scope reuses its comparison ID. Opening a different scope
  replaces that view's previous comparison; comparisons in other views remain valid.
- `POST /api/review/curate/separations` supplies `comparisonId` and an exhaustive
  disjoint `partitions` array. The UI will expose Remove from stack / Split into
  singles, not an arbitrary subgroup editor. A repeated identical request is
  idempotent even after its lease expires or is removed. A later reset does not
  prevent receipt replay or reactivate the separation. Changed payloads cannot
  reuse the correction ID, and an unknown ID still needs its original live lease.
  The receipt is an immutable acknowledgement, not the correction's current active
  state or revision; PIC-369 must read current correction state separately.
- `POST /api/review/curate/separations/reset` supplies correction `id` and expected
  `revision`; `undo: true` additionally enforces its Undo deadline.
- `DELETE /api/review/curate/leases` releases an `id` when its view closes,
  including that view's current comparison. Other owners keep shared snapshots.

PIC-369 must pass the current tab's `replacesViewId` on deliberate refresh,
post-decision refresh and filter changes. Retain the tab's current view ID across
reload/history navigation, serialize its view-opening requests, and save each
returned ID. A separate tab must establish its own view rather than replace
another tab's ID. Without explicit replacement/release, distinct old memberships
remain valid until expiry and still consume the 5 MiB budget. This backend support
does not waive the UI integration requirement or enlarge that budget.

If a replacement response is lost, retry with the same `replacesViewId`. Until
that ID's original expiry, the server resolves it to this view family's current
successor and replaces that successor. Retries do not retain an extra view or
keep obsolete snapshots alive. This survives restart and multiple replacements;
it does not replay an old response or extend a retired ID's expiry. Once that ID
expires, it no longer identifies a successor for replacement. Paging, actions and
explicit close still require their exact live scope IDs; they do not follow aliases.

Replacement records hold an old ID, a stable family ID and the original expiry.
One indexed lookup finds the current successor; there is no growing chain to walk
or rewrite on each replacement. These records count toward the existing 5 MiB
budget and expired records are pruned during scope admission. Concurrent retries
wait for an in-progress successor snapshot before superseding its reservation.

Filter/rebuild failures leave the old view available. Capacity admission and
release of the old view share one transaction, so capacity rejection also
preserves the old view/comparison. After admission, the old view is relinquished;
if writing the new snapshot fails, its reservation is cleaned up and the caller
can retry with the prior ID even if it has already expired or been released.
No replacement changes a human decision or saved separation receipt.

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
capacity/expiry, three simultaneous views of 30k UUID singles, ten successive
decision/view replacements at capacity with other tabs retained, browsing 250 stacks,
receipt replay after expiry/reset/restart, unchanged ingestion, real worker/HTTP
paths, schema-12 migration, SQLite restart, and online backup/restore. Interrupted
snapshot builds are discarded on restart rather than serving partial membership.
Replacement tests reproduce a lost response at 30k-photo capacity, retry across
multiple successors and restart, and cover expiry, alias byte accounting,
capacity rollback and a concurrent retry with different filters.
Metadata tests additionally cover actual HTTP background dispatch/cancellation and
response bounds, 500/two request limits, 1,000 decided photos with eight requested
context members, persistent freshness/backoff, single-probe recovery, changed
connections, newer local observations, membership removal, human decisions during
refresh, and draining concurrent calls after storage failure. Fixtures contain
synthetic photos and no credentials.

Run `node bin/curate-foundation-bench.mjs` for isolated 1k/10k/30k, decided-context,
and dense fixtures, using full-length UUIDs. It reports initial evidence backfill
separately from a persisted-projection rebuild, opening/reopening/paging a view,
retained bytes for two views, and an unchanged ingestion pass. RSS is a sampled
whole-process delta for the grouping/paging phase, including SQLite/worker/GC
effects, not complete-server acceptance or a retained-heap measurement. The
subsequent whole-library ingestion diagnostic reports its duration, dirty count
and ending RSS separately; it is an artificial single transaction, not a
production scheduling or mixed-load measurement. It does not load the
application environment, contact Immich, or invoke inference.

Before PIC-367 is considered complete, validate the complete collection/resource
gates and reconcile the shared cohort/admission boundary with PIC-346. Metadata
refresh supplies observed inputs; it does not reserve paid AI calls or implement
AI cohort scheduling. The first production slice does
not waive the 500 ms rebuild, 8 ms practical slice, 30 ms list p95, 50 ms local
decision p95, 128 MiB incremental Curate or 800 MiB complete-server budgets.
Broader real-photo and long-chain quality remains for integrated owner review;
the small earlier convenience sample is not general accuracy evidence. PIC-372
and PIC-373 retain whole-release migration and runtime acceptance.
