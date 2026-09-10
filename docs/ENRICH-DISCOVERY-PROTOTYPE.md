# Enrich discovery feasibility prototype (PIC-311)

Status: isolated experiment, September 2026. This does not change runtime
behavior or implement PIC-311. The proposed production direction is a small
Enrich-owned inventory, with the correctness constraints below resolved first.

## Why an inventory is needed

Enrich's existing history only knows photos it has encountered. Querying that
database alone cannot discover unseen photos in Immich. An inventory supplies
the missing IDs; SQL can then exclude completed, discarded, and failure-limited
photos before applying the run limit.

The baseline script exercises the real `runBatch` and
`ImmichClient.listImageAssets` against a synthetic source. With 100,050 photos,
the newest 100,000 already enriched, a run requesting 50 new photos fails at
the 100,000-item traversal limit with zero provider calls. In this local run it
took 11.9 seconds and fetched 1,001 metadata pages. This is a correctness issue
as well as repeated discovery work.

## What the experiment compares

Both variants use real repository schemas and identical Enrich history:

- **Enrich-owned:** an experimental inventory in the Enrich database, fed only
  eligible timeline images.
- **Strengthened Insights reuse:** an experimental inventory in a real separate
  Insights database, with the Enrich database attached for SQL history queries.
  The source also supplies hidden photos, stack children, and videos, which SQL
  excludes before its limit.

The second variant models changes Insights would need. It does **not** use the
current `swept_assets` table or run the Insights collector unchanged. Its
inventory needs eligibility and source-update fields absent from that table,
plus freshness and completion guarantees suitable for dispatching Enrich work.

Both variants stage pages, persist a checkpoint after each page, resume with a
fixed page size, and publish a generation only after reaching the end. Existing
published data remains available during refresh. Selection uses stable capture
date/ID ordering, applies history eligibility in SQL, and checks selected assets
against the source before simulated dispatch. Rejected candidates do not consume
the photo processing limit; validation has a separate budget.

## Results

Synthetic source, local SQLite, no HTTP or provider latency. Each row includes
50 eligible photos behind an already-enriched prefix. The broad source adds
5% hidden photos, 5% stack children, and 5% videos.

| Eligible library photos | Inventory | Full metadata pages | Resumable batches | Build time | Median SQL selection |
| ---: | --- | ---: | ---: | ---: | ---: |
| 10,000 | Enrich | 10 | 5 | 35 ms | 1.9 ms |
| 10,000 | Strengthened Insights | 12 | 6 | 33 ms | 1.9 ms |
| 100,000 | Enrich | 100 | 50 | 151 ms | 23.6 ms |
| 100,000 | Strengthened Insights | 115 | 58 | 341 ms | 23.6 ms |
| 150,000 | Enrich | 150 | 75 | 233 ms | 35.7 ms |
| 150,000 | Strengthened Insights | 173 | 87 | 332 ms | 35.9 ms |

Each batch reads at most two pages of 1,000 items. SQL timing is the median of
five reads. Both approaches select the same 50 photos, validate exactly those
50, and return no candidates after success history is recorded. In this fixture,
an unchanged incremental pass fetches one metadata page containing an overlapping
boundary row. These timings are not end-to-end production forecasts, and the
small difference between SQL timings does not favor either architecture.

An Enrich-owned inventory adds another initial scan if Insights also scans the
library. The broad-source counts above are not proof it saves total system work:
an existing Insights inventory may already have paid that cost.

## Correctness evidence and limits

The focused tests cover:

- 150,000 photos, bounded batches, checkpoint recovery after reopening the
  database, and no cold-start completeness claim before publication.
- SQL selection parity with `Repository.assetIdsNeedingWork`: prior success,
  inference changes, legacy configuration matching, discard, retry limits,
  infrastructure failures, and applying the run limit after eligibility.
- Deletion, hiding, or stack membership changes before selection; invalid
  candidates do not consume the requested photo budget.
- New uploads with old capture dates, restores with changed source timestamps,
  empty incremental passes, and malformed or failed pages preserving state.
- Full reconciliation recovering changes that leave source timestamps unchanged.
- Simulated Send to Curate adding only photos successfully processed in that
  run. Previously enriched photos are not added implicitly. This is the approved
  production behavior, but the real runner has not yet been changed.

Two tests deliberately demonstrate unresolved upstream constraints:

1. **Equal-timestamp imports:** an overlapping `updatedAfter` watermark can
   repeatedly fetch a large import when many records share the latest timestamp.
   The 10,000-photo equal-timestamp fixture requires ten pages on the next pass,
   rather than the benchmark's one. A source timestamp is safer than advancing
   to local wall-clock time, but is not a complete bounded freshness policy.
2. **Mutable offset pagination:** deleting an earlier item between pages can
   cause a later item to be missed even when a scan reaches the end. The test
   recovers it through a subsequent full reconciliation. Atomic publication
   protects local state; it does not make remote pages a consistent snapshot.

The normalized synthetic source is not an Immich adapter. In particular,
`stackChild`, `visibility`, and integer `updatedAt` are fixture fields, not a
claim about exact API response fields or guarantees. Candidate validation also
cannot eliminate changes occurring after validation and before processing.

## Recommendation and production gates

Prefer an **Enrich-owned inventory** because Enrich controls its lifecycle,
freshness, and dispatch rules independently of Insights. Both versions have
similar SQL cost; ownership and coupling are the deciding factors. Reusing
Insights would still require extending its projection and collector guarantees,
and introduces a cross-database dependency into core enrichment.

Keep the production change small, but settle these points before shipping:

1. Verify the actual supported Immich API fields and behavior for eligibility,
   update filtering, restores, access changes, and pagination under mutation.
   Define a bounded freshness policy for large equal-timestamp imports and a
   reconciliation policy for changes incremental reads cannot observe. Do not
   claim an exhaustive inventory merely because offset pagination ended.
2. Decide the minimal inventory projection in the Enrich database, migration
   and backup behavior, and reset rules when the Immich server or authorization
   context changes. Experimental tables are not the proposed final schema.
3. Integrate refresh and selection with manual and Daily Enrich runs, restart,
   cancellation, concurrency protections, saved run settings, and existing
   history writes. Share production eligibility SQL rather than copying it.
4. Implement and verify the approved Curate rule in the real runner, including
   its existing tests. Validate the complete flow against a test Immich instance.

## Reproduce

From the repository root with the project's supported Node version:

```sh
node --test test/enrich/discoveryPrototype.test.mjs
node scripts/prototypes/benchmark-discovery.mjs
node scripts/prototypes/baseline-discovery.mjs
```

The scripts create synthetic SQLite databases in the operating system's temp
directory and remove them on normal completion. They accept no database path,
server configuration, or credentials, and never call Immich or an AI provider.
No production module imports this prototype. Benchmark output is printed rather
than committed as generated evidence.
