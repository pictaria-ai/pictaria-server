# PIC-359: read-only legacy pagination proof

Target: Pictaria Server v1.2.1. This investigation does not change the running
application, sync albums, or implement the production fix. Live validation
results and release tracking belong in PIC-359.

## Why offset pagination is insufficient

Immich 2.7.5 metadata search orders by `fileCreatedAt` only, followed by
`LIMIT size + 1` and `OFFSET`. Equal timestamps can cross a page boundary in
different orders. Deduplicating pages cannot recover omitted members.
Pictaria's duplicate rejection predates v1.2, appearing in the initial public
release. Detecting overlap before reconciliation protects that particular run,
but duplicate detection alone is not a completeness proof.

Primary sources:

- [2.7.5 metadata ordering](https://github.com/immich-app/immich/blob/v2.7.5/server/src/repositories/search.repository.ts#L200-L209)
- [2.7.5 inclusive date bounds](https://github.com/immich-app/immich/blob/v2.7.5/server/src/utils/database.ts#L314-L317)
- [2.7.5 date input conversion](https://github.com/immich-app/immich/blob/v2.7.5/server/src/validation.ts#L235-L261)
- [3.1.0 secondary ID ordering](https://github.com/immich-app/immich/blob/v3.1.0/server/src/repositories/search.repository.ts#L223-L230)

## Candidate algorithm and its argument

1. Query **page one** of the requested date range with the original filters.
2. If Immich reports no next page, that single response contains the full
   range under its `size + 1` query contract. Accept that range.
3. Otherwise discard the partial response and divide the range at a whole
   millisecond: `[lower, split]` and `[split, upper]`. Both bounds are inclusive.
4. Repeat until every range is complete, within request/item/time limits.
5. Combine terminal ranges. Deduplicate only equal IDs with unchanged
   timestamps lying on the shared bounds; reject unexpected overlap.

For a static source, the terminal ranges cover the original range without a
gap, and each terminal range was read in one response. Consequently, the
argument does not depend on tie order, detecting duplicates first, or repeated
queries eventually returning the same set. Parent samples only choose split
points; they are never accepted as complete results.

Do **not** subtract a millisecond to advance past a timestamp. Responses may
contain finer precision than JavaScript Date; doing that could skip photos.
The probe preserves response precision to nanoseconds for comparisons, uses
millisecond query bounds, and overlaps the bounds deliberately.

## Explicit limits

- More than one page in an indivisible millisecond interval fails closed.
  This includes oversized exact-timestamp groups and some dense adjacent
  timestamp groups. The probe returns no partial ID set on failure.
- Each date traversal permits at most 500 requests, 500,000 returned entries
  including parent samples/overlaps, and five minutes, with a 30-second network
  timeout and 32 MiB ceiling per response. The CLI performs two sequential
  traversals. Optional offset diagnostics have a separate 500-request,
  five-minute bound. They are evidence only, never a reconciliation source.
- Completeness relies on the verified first-page/filter contract. A server
  that silently lies about terminal pages cannot be validated by this client.
- There is no cross-request snapshot. Concurrent uploads, changes to dates,
  tags, or album membership can change the set during a traversal. Some
  changes are detected; two identical passes are corroboration, not proof
  against every concurrent edit.
- The prototype uses a strict 2.7.5 response shape. It does not decide the
  production version-selection policy or support arbitrary query dialects.

## Running the standalone probe

Use Node 22.16 or newer. Store the instance URL and key in a private file:

```text
IMMICH_BASE_URL=https://your-immich-host
IMMICH_API_KEY=your-read-only-key
```

The key only needs `asset.read` and `tag.read`. Do not add this file, filter
files, private hostnames, asset IDs, or raw responses to Git or the PR.

```sh
node --env-file=/private/probe.env scripts/probes/immich-legacy-pagination.mjs
node --env-file=/private/probe.env scripts/probes/immich-legacy-pagination.mjs --compare-offset
```

The default query searches `frame/eligible`, image type, timeline visibility.
For an exclusion or membership query, use `--filters-file /private/filters.json`
with the exact metadata filters for that read path, for example `tagIds` or
`albumIds`. The file contains an object, not a full Pictaria Smart Album rule.
Keep version-specific visibility semantics explicit when preparing it.

Only `GET /server/version`, `GET /tags`, and `POST /search/metadata` are allowed
by the probe's transport. Redirects are rejected. Output contains aggregate
counts, consistency checks, and generic errors; never credentials, URLs,
photo IDs, capture dates, filenames or server response bodies. IDs are held
in memory only. No files are written by the probe.

Offset diagnostics compare the legacy traversal with the date result, query
the timestamp bucket at every page's last item independently, and sample up
to three six-photo timestamp groups if available. A successful legacy pass
does not disprove the bug: unstable ordering may happen to agree on that pass.

## Before production integration

- Apply a shared verified traversal to metadata matching, exclusion reads,
  and current-membership reads. Validate all three on an appropriate fixture
  and controlled album; a successful tag-only probe does not cover them all.
- Preserve existing AND/OR filter planning, ranked search/Best-of, Top-N,
  deterministic ordering, visibility/trash rules, and aggregate work limits.
  This prototype collects sets and does not establish Top-N semantics.
- Keep efficient stable ordering on known fixed servers. Establish the
  earliest fixed version, conservative unknown-version behavior, and error
  handling without guessing capabilities from network/permission errors.
- Use existing bounded transport, cancellation, and diagnostics in the
  application. Do not copy the standalone transport into runtime code.
- Decide how partial trustworthy ranges interact with existing add-only
  partial-search behavior. Never remove members from an untrusted result.
- Validate the pathological timestamp-group error and ordinary tie handling
  in user-facing diagnostics, then update the compatibility documentation.
- Audit other consumers separately: Enrich inventory discovery, Insights
  collection, visual backfill, generic image listing and Frame metadata
  pagination also consume this endpoint. A shared endpoint is evidence for
  follow-up investigation, not proof of identical symptoms in each feature.

Tests: `node --test test/probes/immich-legacy-pagination.test.mjs`.
