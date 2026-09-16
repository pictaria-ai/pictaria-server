# Curate stacking lab

Open **Stacking lab** from `/curate-preview.html`, or visit
`/curate-stacking-lab.html`. This is a temporary evaluation tool for v1.3 stack
composition, not a new curation workflow or an exact replay of either existing
Curate algorithm. The normal password gate protects its APIs.

## How to use it

1. Build time groups using a maximum consecutive capture gap (1–180 seconds;
   initially 15). The baseline has no total-span limit, no similarity checks,
   no duplicate overrides and no saved human separation rules. It includes
   pending photos from all Curate categories; already-decided photos are absent.
   Undated photos remain singles; known unavailable photos are counted separately.
2. Open a group. Start with time only, then try a shorter gap, an optional total
   span, ThumbHash, and supported people-count differences. Settings apply only
   to that complete time group. Widen the starting gap on the main page to test
   neighbors outside it. Experiment settings reset when another group opens.
3. Every photo stays visible in capture order with a numbered proposed group.
   Click an image to highlight its group and dim the others; no photo is discarded.
   This also shows ThumbHash distances to the highlighted reference. **View
   larger** opens a viewer with previous/next controls and a configured Immich
   link. **Copy experiment summary** copies rules, group sizes and evidence
   coverage, without photo IDs, names, hashes or images.

## Experimental rules

Photos are considered oldest first with deterministic ID ties. Each joins the
most recently created group that satisfies the selected rules; otherwise it
starts a new group. The gap is measured from that group's last photo, the span
from its first, and visual/count compatibility against **every member**. No
pair-comparison sampling is performed within an admitted experiment. This is a
greedy partition, not an optimal clustering guarantee. Threshold changes can
rearrange memberships, not simply remove members from a fixed group.

The ThumbHash heuristic is released Curate's normalized absolute difference
between raw descriptor bytes. It is a coarse signal, distinct from an original
file checksum, and is not a calibrated similarity/confidence score. Lower
thresholds are stricter. The initial threshold is 0.100, but the rule starts off.
With the rule on, absent, malformed or different-length descriptors cannot pass
the pair test and stay separate. The lab does not reproduce released Curate's
neighbor chaining, same-day links, ten-photo cap or AI subject splits.

The people rule uses the preview's conservative count veto: both photos must
have an exact supported producing Enrich count (0/1/2), each corroborated by the
cached recognized-face count. Different supported counts then block a join.
Missing, conflicting or unsupported facts remain unknown. Recognized identities
are not compared, recognition completeness is not assumed, and scene tags do
not affect this experiment.

## Isolation, snapshots and limits

- No provider requests, human/tag/album mutations, settings saves or saved stack
  corrections originate from this page. It does not issue decision leases.
  Reading it can update the existing derived local Curate cache, and viewing
  thumbnails uses the ordinary read-only Immich image proxy. Other independent
  scheduled work in the instance continues normally.
- It does not request fresh per-photo metadata. Evidence is taken from one
  coherent local SQLite snapshot after projection refresh. New enrichment or
  decisions in other pages do not change an open experiment; rebuild explicitly.
- Snapshots are held only in memory, expire after 30 minutes, and disappear on
  restart. At most four snapshots are retained; the oldest is replaced by a fifth
  build. An expired/replaced view returns an explicit rebuild message. No database
  migration or new persistent-state contract is introduced.
- Sorting precedes 50-group pagination. Newest reverses dated groups by their
  earliest photo; undated singles remain last. Photos within groups stay oldest
  first. Counts distinguish time groups from photos.
- Snapshot creation runs in a read-only worker, capped at 50,000 pending photos
  and 8 MiB of serialized evidence per snapshot. The four-snapshot bound is a
  serialized-data limit, not a claim about total Node heap use. Concurrent builds
  receive a retryable busy response instead of creating unbounded workers.
- An interactive experiment admits at most 250 photos, bounding pairwise work
  and DOM size. Larger time groups remain visible with their full counts, but
  opening them explains the limit and suggests a shorter starting gap. No partial
  experiment silently represents the whole group.

The lab is separate from PIC-367's production grouping, PIC-370's AI stack checks
and PIC-371's production explanations. Experiments should inform those choices;
no threshold selected here is adopted automatically. Remove the lab entry point,
browser modules, service/routes and worker together when this evaluation aid is
retired. It owns no persistent domain records to migrate.
