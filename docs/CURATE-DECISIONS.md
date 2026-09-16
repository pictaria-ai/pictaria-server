# Curate decisions and synchronization

PIC-368 provides a shared human-decision boundary for Curate and Pictaria Frame.
SQLite records the accepted choice and durable Immich work together. A remote
multi-photo update can partially complete; local acceptance does not mean every
photo is already synchronized.

The current page keeps its layout and controls. Its Keep best action now submits
one keeper/remainder operation, and its immediate Undo uses a conditional receipt
instead of clearing whatever decisions happen to exist when the button is clicked.
PIC-369 connects the new comparison UI to immutable inspected scopes and exposes
multiple keeper selection. Production AI advice applicability remains PIC-116/
PIC-370 work; the new advice operation currently fails closed.

## Writer ownership

| Entry point | Human meaning | Write path |
| --- | --- | --- |
| New `/api/review/curate/operations` API | Explicit per-photo outcomes over the inspected pending set | Issued scope → atomic operation and receipt → shared queue |
| Existing `/api/review/decision`, including reopen after re-enrichment | Explicit current selection; approve, Curate Favorite, Never show, reviewed/Skip or clear | Atomic operation and receipt → shared queue |
| Frame/voice `/api/assets/:id/favorite` | Add `frame/favorite` only | Accept intent → immediate remote mutation → queued verification/repair |
| Frame/voice `/api/assets/:id/never-show` | Add `frame/never-show`, remove `frame/eligible` | Same shared boundary, including photos outside Curate |
| Conditional Undo | Restore the operation's prior owned tags if no affected photo has a newer human decision | New compensating operation → shared queue |
| Enrich / AI tag sync | AI-owned tags only | Existing separate AI queue under the same tag-write coordinator |

Curate Favorite still adds both eligible and favorite. Frame Favorite does not
silently add eligibility or remove Never show. Reviewed/Skip does not mean Never
show or deletion. AI cannot write the four human decision tags. The local-only
`setManualFrameTags` repository helper is retained for fixture/import projection;
it is not used by production command routes. It records an already-synchronized
local projection, not pending remote work.

The legacy decision endpoint captures current state at command acceptance. It
cannot infer which historical photo inputs a browser inspected, or distinguish a
repeated old client request from a new command without a supplied issued scope.
PIC-369 replaces that interaction with the new operation protocol below. Existing
Frame success response fields remain compatible. Success follows the remote
mutation without waiting for the background verification delay; the durable job
stays pending until verification/repair completes. A remote failure after local
acceptance reports HTTP 502 with `savedLocally: true` and pending synchronization.
If the inline attempt discovers a missing or trashed photo, it returns that same
saved-locally response; the worker subsequently parks the photo in the failed-job
list until it becomes available and is retried.
Existing Frame clients display that as a failure; presenting the saved/pending
distinction in Frame is separate client work. Frame calls do not currently issue
their own operation receipt or Undo. Their accepted human revision still protects
them from an older Curate operation's Undo.

## Scoped operation protocol

1. Open a view and comparison through the [foundation API](CURATE-FOUNDATION.md).
2. `POST /api/review/curate/operations` with `{ comparisonId, mode: "manual" }`.
   The result contains `operationId`, `expiresAt`, `kind`, `mode` and `snapshot`.
   Repeating issuance for the same live scope returns the same operation ID.
3. `POST /api/review/curate/operations/apply` with the issued `operationId`,
   `kind`, `mode`, `snapshot`, and an `outcomes` object mapping **every** actionable
   photo ID to `approve`, `favorite`, `reviewed`, `reject` or `clear`. Omit the
   informational `expiresAt` field. No remainder is inferred from current grouping;
   context photos cannot be included. Up to 1,000 explicit outcomes are accepted.
4. Retain that exact request while its response is uncertain. The same ID and full
   canonical payload replay the saved receipt, even after scope expiry or restart.
   Changed payloads conflict. Unknown IDs never authorize fresh work.
5. A receipt contains `savedLocally`, initial `sync: "pending"`, and an Undo
   descriptor. For Undo, submit its `operationId`, `kind` and `targetOperationId`
   to the same apply endpoint, omitting informational `expiresAt`.
6. Read current progress at `GET /api/review/curate/operations/status?operationId=…`.
   States are pending, failed, synced or superseded by newer intent. Counts are
   per photo. The receipt itself remains immutable and records initial acceptance.
   `POST /api/review/curate/operations/retry` with `{ operationId }` retries pending
   current intent without changing human decisions or running AI. The existing
   sync-status and failed-job recovery endpoints remain available.

A decision validates the whole set, relevant photo/human signatures, known
availability and separation constraints in the transaction. An unrelated Enrich
update does not conflict. A machine-only partition of the same unchanged inspected
photos does not veto manual choices. An added member, changed image/evidence,
newer human choice or manual separation conflicts without partially applying.
Advice-based actions are unavailable until the production advice lifecycle supplies
its stricter applicability checks; old per-photo ranks are not accepted as proof.

Undo checks every affected photo's latest human revision and restores only the
tags touched by its original operation. It preserves intervening AI/custom tags.
A newer human action on any affected photo rejects the entire Undo, even when
some of its individual tags might be compatible. This conservative boundary keeps
Undo from silently revisiting a newer human choice.

## Synchronization and external edits

Each accepted action records its latest intent per owned decision tag. Queue rows
are durable pointers to affected photos; their historical patches are not replay
authority. Inside the existing shared tag-write coordinator, work reads all current
unsynchronized decision intents for its bounded asset slice. It verifies additions
and removals, repairs once, and acknowledges only the exact revisions it sent.
An older in-flight request can finish after a new local action; that acknowledgment
cannot clear the new work. Its later job repairs toward current intent.

The decision worker releases the shared write lane during both the initial settle
delay and the delay after a repair. It reacquires the lane for verification and
repair, so consecutive Frame requests can mutate while it waits. Before verifying,
after remote reads and before repair writes, it checks the affected photos' human
revisions and AI-tag projection. A changed snapshot stays queued and is reconciled
again from current intent without counting it as a remote failure. Network work
already in progress still holds the lane; the existing AI-tag worker has its own
bounded synchronization pass.

Frame actions do not reconcile remote AI tags on previously un-enriched photos.
Ordinary/custom tags remain untouched. Curate retains its existing AI-tag-sync
behavior, independently of decision-tag ownership.

Known missing/trashed/offline assets prevent a successful new operation. A remote
404/410 on an asset read or an observed unavailable photo parks only that photo in
a separately retryable failed job; healthy photos in the batch continue. This
also handles photos disappearing during mutation or verification. Splitting a
job preserves its operation links and queue capacity, so status shows the healthy
photos as synchronized and the unavailable photos as pending/failed. Shared tag
service errors are not classified as missing photos. Other failures retain
bounded attempts and the existing failed-job UI.
Permission failures and partial writes never become successful receipts by dropping
photos. Retry does not change the local decision. Dismissing a failed queue entry
is not proof of synchronization; an operation with remaining intent stays pending
and can be requeued from its receipt.

Direct Immich edits have no global timestamp ordering with Pictaria. Pending
explicit Pictaria work may overwrite conflicting remote edits within its owned
tag scope. Once an intent is synchronized, obsolete queued work does not reassert
it against a later direct Immich edit. This is not continuous two-way tag sync.

## Persistence, bounds and migration

Enrichment schema **14** / persistent-state contract **17** adds:

- At most four durable `decision_intents` rows per human-touched photo.
- `decision_operations` receipts/prior state and indexed operation members.
- Links from the existing bounded sync queue to operation status and retries.

New comparison operation leases last 30 minutes and share the foundation's
5 MiB lease/snapshot limit, with at most 200 outstanding operation scopes. Accepted
operations release those scopes. Undo IDs are issued within the receipt, looked up
by a dedicated unique index, and expire after 30 minutes; completing many decisions
does not consume the open-comparison budget with Undo records.

Pending intent pins receipts, including failed work. Once settled, receipts remain
for 30 days, followed by 30 days of ID/payload tombstones. Forgotten IDs cannot
become fresh operations because the original issued scope no longer exists.
Retention visits at most 100 pending operations, 100 expired receipts and 100
expired tombstones per maintenance pass, at most once per five seconds. Durable
intent remains the latest per-photo projection, not an unbounded event history.
The existing queue still admits at most 10,000 asset references and sends at most
50 photos per worker slice. A capacity error rolls back the complete local action.

On upgrade, valid pre-existing pending/dead jobs seed intent from the **current
local human-tag projection**, never an old queued approval payload. Decisions,
settings, existing tags and failed-job state are not rewritten. Malformed restored
jobs retain the existing quarantine/recovery path. The normal upgrade recovery
snapshot precedes migration; roll back by restoring that complete snapshot, not
by running an old binary over the new decision state.

Automated fixtures cover transaction rollback, exact replay, scope conflicts,
conditional Undo, Frame actions outside Curate, in-flight races, partial remote
writes and restart, retry/retention, and schema-13 pending-job migration. Full
mixed-load and deployment acceptance remain part of the v1.3 integration gates.
