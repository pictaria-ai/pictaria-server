# PIC-366 implementation decisions

Lead implementation choices for review, September 15, 2026. This closes the
prototype's remaining design questions; it does not claim a deployed feature,
production performance acceptance, or owner approval of an unreviewed PR.
The [functional spec](https://linear.app/aedr/document/curate-v13-functional-specification-8e7497272bc6)
is updated with these behavioral limits. This record supersedes earlier proposed
choices where they differ. Historical visual and runtime reports remain evidence.

## September 24 amendment — settled checks (PIC-387)

The owner-approved D3 contract now allows enabled keeper advice after a per-group
check finishes incomplete following bounded effort. Similarity work settles first,
then any enabled AI Stack Referee; pending work still waits. Retain an honest
not-fully-checked label and all provider/configuration, capacity, budget,
validation, applicability and human-authority guards. No long-term stack repair
queue or routine Retry control is required. The verified too-large exception
remains distinct. Failed or mixed keeper batches still withhold full-stack advice
application.

This supersedes the September 15 table/text below where **failed** checks block
keeper work indefinitely. Those rows and the prototype planner record the earlier
evaluated contract; PIC-370/PIC-116 must implement the amended admission rule.
Current deterministic composition/lifecycle rules live in
[the candidate algorithm guide](../../docs/CURATE-ALGORITHM.md); the prototype's
initial grouping thresholds below are historical.

## 1. Grouping and keeper baseline

Keep the released keeper-quality criteria that the owner accepted, with validated
zero/one/multiple recommendations and faithful application of all selected photos.
Personal taste guidance remains optional PIC-375. No more broad prompt tuning is
required to choose this baseline.

PIC-367 starts with 15-second adjacent-gap/180-second span candidate discovery,
32 recent candidates, 64 soft member comparisons per candidate and two million
soft comparisons per rebuild. Human separation constraints remain binding.
Use the narrow corroborated none/one/couple rule with producing-schema provenance;
unknown or contradictory facts remain unknown. Validate the actual adapter on the
recorded positive, missing-detection and unsupported-schema fixtures. The small
visual sample supports this starting point, not a calibrated general classifier.
Longer-gap lookback stays off. Do not pursue the ineffective thumbnail bypass.
An exact-checksum check bypass also requires compatible observed rendition identity.

## 2. Large-stack behavior

A logical stack is not a provider request. Keep full membership available for
human comparison. The initial automated envelope is 30 total photos (including
any submitted read-only context), 2 MiB per rendition and 24 MiB raw bytes across
the plan. Resolve the actual provider's image limit before preparing requests.
Unknown capability does not authorize a request; no implicit provider fallback.

For keeper suggestions, use one request where it fits; otherwise use up to three
balanced chronological batches, preserving every input and all accepted keeper
flags. Thirty photos on the evaluated ten-image provider use 10/10/10. A layout
with a singleton remainder is rebalanced; unsupported layouts or more than three
requests stay manual. Only the three-by-ten layout has real-photo evidence;
other supported layouts require their ordinary implementation validation.

| Settings / state | Within provider limit | Above provider limit, within the keeper-plan envelope |
| --- | --- | --- |
| Stacks off | Singles; no Curate AI | Same |
| Both AI roles off | Standard grouping and manual review | Same |
| Check on, keeper off | Full-input check or recorded bypass; human chooses | Check unavailable for this group; manual comparison remains available |
| Check off, keeper on | Full-input keeper suggestions | Separate keeper comparisons, with their full union shown and coverage explained |
| Both on; check pending, failed or unsupported for another reason | Wait for a valid check/bypass; manual comparison remains available | Same; batching cannot bypass the check |
| Both on; check exceeds the provider's confirmed image-count limit | Not a valid size exception if the input fits | Keeper batches may run, explicitly labeled Stack not checked: too large |
| Both on; applicable full check/bypass already valid | Keeper suggestions for eligible resulting groups | Keeper batches may run if the resulting logical comparison still needs them |

This explicitly limits **dedicated checking** above the provider's full-input
limit. Check-only remains useful for supported groups. A future global checking
strategy needs evidence; a union of independent partitions cannot stand in for it.
The owner approved the narrow unchecked-keeper exception after review on
September 15. It requires a recorded `unsupported-size` check state and an input
that actually exceeds the resolved provider image-count limit. Pending/failed
checks, unknown capacity, authentication/configuration errors and other unsupported
states remain blocking. No retry, new feature permission or byte/plan-budget
exception is implied. Preserve the unchecked notice with the saved suggestions;
do not mark the check successful or call this a strong-evidence bypass.
This is not a claim that all thirty-photo AI combinations have been validated.

For batched keeper results:

* Show that suggestions came from separate comparisons. Do not imply cross-batch
  duplicate elimination or a globally best set. Keep the visible stack intact.
* Validate exhaustive membership independently for every request. Missing/failed
  batches are unavailable, never an explicit zero-keeper verdict.
* Enable applying the full suggested set only when every batch is valid and no
  batch reports a mixed-subject split. All ordinary current-input, check and
  human-intent guards still apply. The complete inspected set is actionable.
* If a batch reports mixed subjects, show the local evidence but withhold the
  full-stack apply-advice shortcut. Independent local partitions cannot establish
  the whole-stack partition. Human comparison/correction remains available; do
  not invent a global correction or launch an unrequested extra AI round.
* A single whole-input response can carry a valid partition and per-partition
  keepers through the normal refresh/action contract.

`batching.mjs` and its role-matrix tests exercise these boundaries. The executed
released baseline returned six keep flags across the natural thirty-photo set;
the owner judged it good enough. No one-winner tournament or extra final pass.

## 3. Hot data, context and record lifetimes

Keep existing SQLite and module boundaries. Use IDs and small signatures in
current group records, not copies of full Enrich output in every group/history.
Persist at most 4 KiB of normalized evidence/provenance and 100 recognized IDs
per photo, whichever limit is reached first. Omission must remain explicit;
never truncate JSON or pretend omitted detection data is complete.

The grouping projection needs IDs, time, image/input signatures, availability,
supported count observations and recognition count/set signature. Load full
recognized IDs/provenance only when a rule or explanation actually needs them.
The first rule uses counts; deferred lookback must not force large arrays into
every hot row. A stored digest identifies observed-set changes, not completeness
or proof that two pictures have the same composition.

Context is **at most eight** kept photos chosen by time distance from an indexed,
locally compatible candidate query returning at most 64 lightweight rows.
Use a 180-second local distance bound; discard known-unavailable, non-kept and
unknown-time rows. A limited query or additional eligible candidates produces an
explicit omission flag. These are nearest among returned candidates, not a claim
of exhaustive library search. Context never becomes actionable. One pending
newcomer remains manual-only. Do not scan decided history on each page load.
`selectKeptContext` demonstrates these limits; PIC-367 implements the real query.

Use cached/batched Immich metadata. Normal page reads make no per-card metadata
fetches. Refresh missing/changed evidence in background batches of at most 500
asset observations, with at most two concurrent metadata calls, yielding between
batches. API-specific page caps may lower these numbers. Unavailable evidence
stays unknown while refresh is pending. PIC-367 now integrates this read lane with
live foundation views: initially due pending photos, 24-hour refresh, a durable
30-second minimum on earlier rechecks, and at most eight due kept-context photos
when a comparison opens. Decided history is not a polling queue. Per-request
bounds are 30 seconds and 1 MiB; connection failures back off from 30 seconds to
15 minutes and recover with one probe. Stacks off and shutdown cancel requests;
Enrich being off does not. Freshness, claims and retry timing survive restart.
Responses revalidate source evidence/membership/connection before applying. This
lane has no paid-call accounting: paid-call admission remains PIC-346. Synthetic
real-HTTP, restart, failure and concurrency tests cover the adapter; integrated
resource and live-version acceptance remain separate.

| Data | Chosen lifetime / bound |
| --- | --- |
| Current projection/index | One current projection/index plus one replacement; publish atomically. Full provenance stays cold. |
| Comparison/action leases | 30 minutes; deliberate refresh issues a new lease for the verified scope. PIC-367 review clarification: at most 200 views and 200 comparisons, with one current comparison per view. Reopening an identical comparison reuses its ID; navigating within that view supersedes only its prior comparison. Immutable membership snapshots can be shared across views, and all retained snapshots, scopes and replacement records count toward the same 5 MiB installation bound. Refuse new allocation clearly at capacity; do not evict another view or truncate membership. |
| Immediate Undo | 30 minutes from the operation, and only while all target revisions are still current. The receipt states its deadline. Decided review remains available for later choices. No new history browser is required. |
| Completed operation receipts | 30 days after settling, then a minimal ID/payload/expiry tombstone for 30 more days. Store only authorized decision-tag before-state, not descriptive tags or original metadata. |
| Pending/failed sync and live Undo dependencies | Retain until resolved/superseded or the dependency expires. Age/space cleanup cannot discard them. Keep one latest merged scoped intent per photo. |
| Human separation constraints | Keep while active and their photos exist; deliberate reset deactivates them. Expired Undo/history does not reset a correction. |
| AI jobs/advice | Current applicable result and exact-input attempt state, active request, and one current queued replacement per overlapping scope/role. No raw-response history. Retire obsolete inactive records after their comparison/Undo references and recent budget window expire. |

PIC-367's view API accepts `replacesViewId` on POST opens. PIC-369 must pass
the current tab's prior ID on refresh/filter changes, including refresh after
decisions, and retain that ID across reload/history navigation. Only that view
and its current comparison are superseded; another tab starts/retains its own
scope. Capacity rejection preserves the old scope. Distinct unreleased views
still consume the shared 5 MiB budget; this is explicit replacement, not eviction
of another view or an increase in the bound.

A lost replacement response can be retried with the old view ID until that ID's
original expiry. Retired IDs resolve through a stable family key to the current
successor, which is replaced without retaining an orphan view. Persist this across
restart; do not extend old-ID lifetimes or follow aliases for paging/actions/close.
Replacement records count toward the same 5 MiB bound and expire independently.
Capacity refusal rolls their changes back with the view/comparison release.

An operation is settled when its relevant writes are acknowledged or its intent
is explicitly superseded by later durable intent that retains all unfinished tag
scope. Do not infer settlement merely from a missing historical queue row.
Permanent failure remains recorded/recoverable. Time-based receipt retention
bounds history duration, not arbitrary high-volume disk usage; pending work is
an explicit exception. Report storage pressure instead of deleting required work.

### Expiration and idempotency

Issue opaque operation IDs on the server with the comparison lease; issue the
conditional Undo ID/deadline with the receipt. Bind each to its immutable scope
or undo target. Adapters for other Pictaria entry points establish the same
durable identity at command acceptance. Clients reuse the ID for a retry.

Within the action transaction, fetch the receipt and lease by the submitted
server-issued operation ID, never an unrelated live lease. Same ID/full canonical
payload returns the receipt even after lease expiry; different payload conflicts.
A tombstone returns an explicit expired result. With no saved record, require a
live lease whose operation ID and scope fingerprint match the request. Derive the
scope fingerprint from its decision mode and immutable snapshot, or its Undo
target; decision outcome IDs must exactly cover that snapshot's actionable IDs.
Do not trust a separately supplied scope hash. The normal decision handler still
validates current material state, action values and user authorization atomically.
Once receipt and tombstone are
pruned, the expired/absent lease still prevents an old ID becoming a new operation.
Never accept an arbitrary unknown client ID as a fresh action after pruning.
An expired comparison requests Refresh; it never grows the inspected scope.

The lifecycle tests exercise ID-indexed lookup, unrelated live scopes, changed
photo sets/modes/Undo targets, full-payload replay, SQLite restart and pruning.
They do not implement production cleanup or lease issuance;
PIC-368 must wire it atomically into the actual operation/outbox transaction.

## 4. Bounded AI effort (September 25 owner decision)

The per-photo policy below supersedes the prototype's cohort reservation,
merge/split rebinding, absent-sibling and quiet-period compaction design. Stacks
are an intermediate aid; incomplete advice is acceptable and remains usable.

- Keep one active Curate call and fair Enrich/Curate turns, independent role
  gates, at most two dispatched attempts per exact role/input and 30-second
  settling. Coalesce overlapping changes to the latest queued replacement.
- Each participating photo has an allowance of three automatic comparisons per
  role in a rolling 30 minutes, including retries and read-only context. Charge
  only the photos actually included in each call. Disjoint Photo Referee batches
  have separate participants; shared context consumes an allowance in each call.
  Changes in membership, model or backend do not reset the photo allowance.
- A limit settles that input without further automatic advice. Expiry, refresh,
  restart and toggles never resurrect it. Newly changed eligible inputs may be
  considered normally; there is no repair queue or per-stack reset control.
- On the first shared provider failure, protect the rest of its queue. Bad
  credentials/configuration pause until corrected. A transient failure waits at
  least 30 seconds (longer when Retry-After requires it), then admits one recovery
  request. Another shared failure pauses until explicit connection recovery.
  Dispatched requests, including timeouts, remain charged. A bad answer is an
  input failure, not evidence of a service-wide outage.
- Keep one shared executor. Only the exclusive server owner may recover
  interrupted work. Retire obsolete inactive records after current/queued
  work, comparison/Undo/advice references and the budget window no longer need
  them; do not prune unchanged inputs just because time passed.

`lifecycle.mjs` remains historical prototype evidence, not the production budget
implementation. `src/curate/ai-limits.mjs` implements durable provider protection
and per-photo admission with synthetic restart/upgrade tests. Production worker
composition, settling/coalescing, protected-reference selection for cleanup and
shared Enrich integration remain PIC-346/PIC-118 activation prerequisites.

## 5. Sizing evidence and acceptance ownership

`storage-bench.mjs` measured synthetic SQLite record shapes once on Node 25.9.0:

| Photos / full receipts | Provenance bytes per photo | Hot JSON MiB | Group JSON MiB | Receipt JSON MiB | SQLite MiB |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1,000 / 100 | 512 | 0.35 | 0.04 | 0.83 | 2.15 |
| 30,000 / 3,000 | 512 | 10.50 | 1.30 | 24.91 | 63.38 |
| 30,000 / 3,000 | 4,096 | 10.50 | 1.30 | 24.91 | 165.88 |

The 30-photo full receipt averaged 8,707 encoded bytes. Three thousand receipts
is a scenario of 100 such operations/day for 30 days, not measured user behavior.
The database includes illustrative primary/expiry/cohort indexes, not final schema,
WAL, original Enrich records, images or backup size. JSON sizes are not retained
JavaScript heap measurements. The maximum evidence case supports keeping cold
provenance out of rebuild memory; it does not establish the 128 MiB memory gate.

Retain the [target-host runtime findings](TARGET-RUNTIME.md): standalone response
and build targets passed; three slices exceeded 8 ms. Keep the 8 ms practical
slice target, 50 ms loop p95, 30 ms list p95, 50 ms decision p95, 500 ms rebuild,
128 MiB incremental Curate and 800 MiB complete-server memory gates. Profile
production preparation/sort/output and measure the same-server baseline; do not
waive missing evidence or assume a worker pool is necessary.

The prototype is ready for review of these decisions. Its reuse map, executable
contracts, owner-accepted keeper baseline, thirty-photo keeper protocol and scoped
runtime/sizing evidence are delivered. Real long-chain visual evidence and broader
grouping quality remain unestablished by the convenience sample; use the integrated
workflow to validate those with PIC-367/370/373. No further owner prompt evaluation
or repeated offline host benchmark is requested for this closeout.

Production adapters/context/lease limits belong to PIC-367/368; AI admission and
roles to PIC-346/118/370/116; migration to PIC-372; complete acceptance to PIC-373.
These are required implementation checks, not claims of already working code.
The original 14–24 focused engineering-day estimate remains a rough implementation
range excluding prototype/review/owner waits; re-estimate after the human-only
grouping → comparison → decision/sync/Undo slice. Review and merge PIC-366 before
treating its decisions as the accepted base for PIC-367. No production change or
merge is performed by this record.
