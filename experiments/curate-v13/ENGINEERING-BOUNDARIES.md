# Curate implementation boundaries (PIC-366)

This is the current engineering direction after the private visual evaluations.
It does not enable production behavior or mark the prototype complete. The
[functional specification](https://linear.app/aedr/document/curate-v13-functional-specification-8e7497272bc6)
remains the behavioral source of truth. Earlier experiments remain reproducible.
The [implementation decisions](IMPLEMENTATION-DECISIONS.md) now settle the
large-group and lifecycle choices for review and supersede proposals below.

## 1. Keeper judgment is settled enough to proceed

The owner judged the released v1.2.1 keeper selections better and good enough.
Use those concrete quality criteria as the foundation, with only the adaptations
needed for the new validated zero/one/multiple-keeper contract. Render and apply
the entire accepted set; a rank-1 star must not silently discard other keepers.
Do not recreate permissive rank repair or require another taste-tuning exercise.
[PIC-375](https://linear.app/aedr/issue/PIC-375) is optional preference guidance,
with v1.3 inclusion undecided. Grouping remains the main quality improvement.

## 2. Starting point for standard grouping — PIC-367

* Retain bounded timing discovery: start with a 15-second adjacent gap and
  180-second overall span, a 32-candidate window and existing comparison budgets.
  Timing identifies a plausible comparison, not proven subject equivalence.
* Human separations are binding across all members, regardless of soft budgets.
  Do not reunite a split through a new bridging photo.
* Implement the narrowly corroborated people/composition rule first: supported
  producing none/one/couple facts plus non-conflicting recognition observations.
  Validate the actual adapter against the positive, missing-detection and
  unsupported-provenance fixtures before enabling it in production. Equal counts
  do not prove complete detection, and different identities alone do not split.
  The experimental rule remains explicitly selected in fixtures/benchmarks; this
  work has not silently changed its default or adopted a calibrated classifier.
* Missing, unsupported or contradictory evidence stays uncertain. Do not derive
  facts from today's profile, guessed tag meanings or empty recognition alone.
* Leave longer-gap lookback off initially. The observed 0.10 recovery was context
  sensitive; do not adopt it to recover one portrait example. Keep scenes and
  composition fields as provenance until a supported rule is validated.
* Do not chase the thumbnail-based check bypass now. Its measured savings were
  negligible. The prototype retains its recorded-checksum route; the production
  adapter must also establish compatible image/rendition identity before treating
  a checksum as a check bypass. Other eligible uncertain groups use the optional
  AI check, or remain available for human review when it is off.

This chooses a small implementation boundary. It does not claim that time-only
stacks or the small, mostly agent-labeled sample establish general precision.
Broader grouping acceptance continues with PIC-367/PIC-370 and the integrated UI.

## 3. Logical comparisons and provider requests are different

Retain a complete logical comparison in the UI. The local envelope stays at 30
images, 2 MiB per rendition and 24 MiB total raw bytes for the evaluated automated
path. The provider's known image limit is an additional constraint. Unknown or
non-comparative capability does not authorize submission. The recorded Venice
model accepted ten images and rejected thirty; no implicit provider fallback.

`planRequest` now accepts `maxImages` and withholds a full-group request above
it. Callers must supply resolved provider capability; the legacy default of 30
exists for offline fixtures and is not a real-provider capability assertion.

`planKeeperBatches` makes the tested three-by-ten layout explicit, preserving
chronological input order, all inputs and all accepted keeper flags. Other
bounded layouts avoid a singleton tail where possible; only the three-by-ten
layout has the recorded real-photo evidence. Every planned request consumes an
automatic budget slot; three calls cannot be hidden behind one job admission.
Reserve the plan before beginning, keep actual transport counts separate from
conservative reservations, and never treat reservations as measured cost.

`collectKeeperBatches` reports whole-group or within-batches coverage. A failed
batch produces a partial result, not a zero-keeper verdict for its missing
photos. Local partitions are retained separately and never turned into a
validated global partition. The evaluated union may retain repetition between
batches; no final tournament is added and no candidate is discarded to force a
winner quota.

**Selected initial large-group behavior for review in PIC-370/PIC-116:** full
human comparison remains available. A dedicated grouping check must cover its
whole input, so above the provider limit it remains explicitly unsupported/manual
until a global checking strategy is validated. Batched keeper proposals may be
available when checking is off, a whole-group check/bypass is already valid, or
the check is specifically unsupported because of the confirmed provider image
count limit. The owner approved that last exception with an explicit Stack not
checked: too large notice; it does not apply to unknown capability or other errors.
They must be presented as separate comparisons, with their complete union
inspectable; a pending or failed grouping check must not be bypassed by
batching keeper requests. The current prototype records this boundary but does
not wire an application shortcut or establish production acceptance for it.

The accepted keeper example establishes useful local proposals over thirty
photos. It does not establish global thirty-photo grouping, cross-batch
deduplication, all check/referee combinations or an arbitrary larger envelope.
The implementation decisions and updated spec record this product limitation.
A mixed-subject batch or a missing batch withholds the full-group apply-advice
action; more than three required keeper requests stays manual.

## 4. Background grouping and publication — executable now

The same grouping implementation can run synchronously for deterministic
fixtures or cooperatively with a 4 ms target slice. It yields between bounded
candidate/member and group-output operations. Sorting and one operation remain
indivisible; instrumentation reports actual slices rather than promising a hard
deadline. Production input projection and sorting must also be measured.

`BackgroundGroups` accepts a lazy immutable-snapshot loader. It retains one
active build and the latest queued request, cancels obsolete work at a yield,
and publishes only a complete current replacement. Readers retain the previous
usable index if a build fails. List pages project at most fifty summaries and
do not serialize every member of a dense group into the list response.

This is an isolated publication experiment. PIC-367 still owns the real database
adapter, immutable revision capture, bounded kept-context selection and comparison
detail reads. Prepared inputs must not be mutable live application objects.
Snapshot preparation, complete-server routes and migrations are not implemented
by this class. Current synthetic grouping still scans the decided collection.

The new tests also exercise a manual SQLite decision and an unrelated metadata
write during grouping. The existing action tests cover atomic outcomes, retries,
conditional Undo, Frame writes and restart. Neither result replaces integration
with actual Enrich, Frame and Immich writers.

## 5. Current measurements and remaining gates

Measured on Node 25.9.0 / Apple M5 Pro / macOS with the final standalone benchmark:
two localhost HTTP clients, repeated 30-photo SQLite decisions, a synthetic
metadata update every 5 ms, and continuous rebuilds for at least one second and
at least twenty iterations. No real provider, photos, deployment or Enrich job.
Each case uses a fresh process. This deliberately sustained rebuild campaign is
not a claim about normal application rebuild frequency.

| Fixture | Cold build ms | Rebuild p95 ms | List HTTP p95 ms (n) | Decision HTTP p95 ms (n) | Loop p95 / max ms | Observed RSS increase MiB |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 1k pending | 2.09 | 0.40 | 3.28 (335) | 3.30 (334) | 2.33 / 4.50 | 43.59 |
| 10k pending | 7.59 | 6.55 | 14.22 (67) | 14.65 (66) | 5.35 / 9.17 | 132.38 |
| 30k pending | 17.98 | 18.72 | 14.05 (70) | 15.39 (69) | 6.03 / 8.66 | 201.55 |
| 100 pending + 30k decided | 17.34 | 18.96 | 14.52 (70) | 15.78 (69) | 6.00 / 9.22 | 191.44 |
| Dense 30k | 21.04 | 25.32 | 15.71 (64) | 17.21 (63) | 6.82 / 10.40 | 133.09 |
| Gapped triples, lookback experiment | 41.85 | 44.28 | 17.63 (61) | 18.84 (61) | 7.96 / 14.72 | 286.47 |

No measured grouping slice exceeded 8 ms in this pass; the maximum was 6.22 ms.
Request samples are finite, especially in larger cases. These timings support
cooperative work and bounded list summaries; they do not prove full-server SLOs.

**Memory remains open.** Observed peak RSS was 105.45–372.00 MiB. Increases above
the prepared-input/database baseline exceed the proposed 128 MiB allowance in
several cases. That increase includes the HTTP/SQLite load, allocations and GC
behavior, not solely retained Curate records. Input creation and database seeding
are excluded; GC runs once before the baseline, never during the measured campaign.
Do not turn standalone RSS into complete-server or incremental Curate acceptance.
Removing repeated candidate-array/Set allocation improved the discovery path,
but it did not settle the memory budget.

**Target-host Node 22 pass received:** [measurements and disposition](TARGET-RUNTIME.md)
at `84219d7` report 54/54 focused tests and all six standalone response/build
latency targets passing. Three individual slices exceeded 8 ms (maximum 16.34 ms).
Observed RSS increases were 21.20–79.92 MiB for standard/dense cases and 138.45 MiB
for the optional gapped-lookback case. Keep the slice and production memory gates
open. The pass supports this implementation direction without establishing
full-server acceptance; do not infer a Node-version effect from different hosts.

## 6. Persistence and retention boundaries

The [implementation decisions](IMPLEMENTATION-DECISIONS.md) choose compact SQLite
records and a small hot projection; at most eight read-only kept context photos
from a bounded indexed query; 30-minute comparison/action and immediate-Undo
leases; 30-day settled receipts plus 30-day tombstones. Pending sync and live Undo
dependencies survive ordinary cleanup. Expired or forgotten IDs cannot authorize
a fresh action without a live server-issued lease fetched by that operation ID
and matching the request's immutable scope/mode or Undo target.

The new lifecycle model exercises cohort split/merge/restart and deduplicated
reservations. Absent siblings inherit merged budgets. A complete stable cohort
may regain separate budgets after a full quiet 30-minute window, with no active
work or recent reservation; exact-input attempt/advice records do not reset.
Real indexed transactions and queue coalescing remain PIC-367/PIC-346 work.

A synthetic storage pass measures representative and maximum-provenance record
shapes; its JSON/SQLite sizes are not a JavaScript-memory acceptance claim.
Production lease limits, context queries, pruning and migration require their
named implementation tests. The pure lifecycle model is not the production
operation repository.

## 7. Next work

Prototype decisions and their evidence are ready for review. The requested Node
22 runtime pass is complete; no repeat or new private-photo/provider exercise is
requested now. Review the implementation decisions, role matrix and remaining
production checks, then agree the PIC-366 acceptance disposition before merging.

PIC-367 implements grouping/evidence, PIC-368 the coherent human operation, and
PIC-369 the first comparison/correction flow. AI roles and final resource/migration
checks remain with their named issues. Full production acceptance cannot be
supplied by a standalone prototype before that implementation exists.
