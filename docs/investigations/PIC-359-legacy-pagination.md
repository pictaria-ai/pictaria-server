# PIC-359: legacy metadata compatibility and removal plan

Target: Pictaria Server v1.2.1. Live evidence and release tracking are in
PIC-359. The original read-only proof is preserved in Git at `2f671aa`;
production now uses one implementation, rather than retaining a second copy
of the algorithm in the probe.

## Module boundaries

- `src/albums/metadataSearch.mjs` is the Smart Album metadata reader. Callers
  provide filters, a selection limit, and whether partial matching is allowed;
  they receive assets, truncation, and completeness. It owns version selection,
  ordinary paging, the shared read budget, and count-check/retry orchestration.
- `src/albums/legacyMetadataTraversal.mjs` owns the pre-3.1 boundary, legacy
  visibility partitions, timestamp handling and date-window iterator.
- `src/albums/searchPage.mjs` validates page responses for both metadata and
  ranked searches. It has no pre-3.1-specific behavior.
- Smart Album matching, exclusions and membership call the reader. Ranked
  search remains separate but participates in the shared read budget.

When the supported floor reaches Immich 3.1:

1. Delete the legacy import/dispatch and `readLegacy`/statistics-projection
   helpers from `metadataSearch.mjs`; the offset reader keeps the same result
   contract. Remove the version lookup/cache if no other strategy needs it.
2. Delete `legacyMetadataTraversal.mjs`, the legacy cases in
   `test/albums/metadataSearch.test.mjs`, and the diagnostic probe below.
3. Remove legacy compatibility notes; keep shared page validation, run budgets,
   ordinary paging tests, and safe reconciliation behavior.

No Enrich, Curate, UI, or Smart Album rule schema needs to know that a legacy
algorithm exists. No persistent compatibility flags or data migration were
introduced.

## Completeness argument and limits

Immich 2.7.5 and 3.0.x order metadata by `fileCreatedAt` without a unique
secondary key, then apply offset/limit. Only complete **first-page** responses
are trusted by the workaround. Incomplete parent samples are discarded and
split into inclusive `[lower, split]` and `[split, upper]` windows, processed
newest first. Complete terminal windows cover the requested range without
precision gaps. Duplicate IDs are allowed only on shared boundaries with
unchanged timestamps.

Splits use whole milliseconds, matching the API's Date-based query precision;
response comparisons preserve finer precision if present. Never subtract a
millisecond to jump over a boundary. More than one page in an indivisible
millisecond interval fails closed. The count check corroborates the covered
raw set, including when Top-N stops at a completed prefix; it does not prove
cross-request snapshot consistency. Exclusion and membership reads must
complete before any mutation. Only completed matching windows may support
add-only results when a read budget is reached.

Primary sources:

- [2.7.5 metadata ordering](https://github.com/immich-app/immich/blob/v2.7.5/server/src/repositories/search.repository.ts#L200-L209)
- [2.7.5 inclusive date bounds](https://github.com/immich-app/immich/blob/v2.7.5/server/src/utils/database.ts#L314-L317)
- [2.7.5 Date conversion](https://github.com/immich-app/immich/blob/v2.7.5/server/src/validation.ts#L235-L261)
- [3.0.3 ordering](https://github.com/immich-app/immich/blob/v3.0.3/server/src/repositories/search.repository.ts#L197-L206)
- [3.1.0 secondary ID ordering](https://github.com/immich-app/immich/blob/v3.1.0/server/src/repositories/search.repository.ts#L223-L230)

## Read-only production probe

Store `IMMICH_BASE_URL` and `IMMICH_API_KEY` in a private environment file.
The key needs `asset.read`, `tag.read`, and `asset.statistics`.

```sh
node --env-file=/private/probe.env scripts/probes/immich-legacy-pagination.mjs
node --env-file=/private/probe.env scripts/probes/immich-legacy-pagination.mjs --filters-file /private/filters.json
```

The default is timeline-visible images tagged `frame/eligible`. A filters file
can supply `tagIds` for an exclusion query or `albumIds` for membership;
omitting visibility exercises the legacy visibility partitions. It contains
metadata filters, not a complete Smart Album rule. The probe calls the actual
production reader through the bounded Immich client. Its transport allows only
version/tag reads and metadata/statistics searches, rejects redirects, and
prints aggregate counts/timing or redacted error categories. It performs no
writes and persists no asset data. Do not commit private environment/filter
files, addresses, IDs, timestamps or raw responses.

Tests: `node --test test/albums/*.test.mjs`.

Before release: independently review the implementation; validate production
reads on older and fixed newer Immich; test add/remove behavior on a controlled
album. Do not hot-edit the personal production container or infer deployment
approval from the read-only investigation.
