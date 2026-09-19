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
   span, ThumbHash, Enrich people categories and recognized-person identities. Settings apply only
   to that complete time group. Widen the starting gap on the main page to test
   neighbors outside it. Experiment settings reset when another group opens.
   Opening a group loads recognition from Immich before enabling the controls.
   **Refresh from Immich** repeats that read while keeping the selected rules.
3. Every photo stays visible in capture order with a numbered proposed group.
   Click an image to highlight its group and dim the others; no photo is discarded.
   This also shows ThumbHash distances to the highlighted reference. **View
   larger** opens a viewer with previous/next controls and a configured Immich
   link. **Copy experiment summary** copies rules, group sizes and evidence
   coverage, without photo IDs, names, hashes or images.
4. Optionally click **Check similarity ranking**. Immich searches its timeline
   images using this time group's earliest photo, including images outside the
   group. The other cards show their positions among the first 50 results after
   removing the reference. The reference stays fixed even when highlighting a
   different photo or changing rules. Search duration and check time appear above
   the photos; copied summaries include ranks using Photo 1 / Photo 2 labels.

## Immich similarity ranking

The earliest-photo check is an inspection tool. The multi-reference table can also
feed the explicitly selected combined-evidence experiment described below. Immich uses its existing Smart
Search image embeddings; Pictaria neither downloads images for this search nor
runs new AI inference. Smart Search must be enabled and have processed the
reference photo. The existing API key needs `asset.read`. No direct access to
Immich's database or internal machine-learning service is used.

Ranks are relative to the accessible timeline-image search pool, not distances,
confidence scores or proof that photos belong together. A library containing many
similar images can push a good alternative down the list. Missing embeddings,
visibility and access can also keep a photo out. **Not in the first 50 results**
does not mean different; if Immich returns fewer photos, the label reports that
actual returned count. Failed or malformed searches assign no ranks.

Each uncached reference uses one public `POST /api/search/smart` request with `queryAssetId`,
`type: IMAGE`, `visibility: timeline`, `size: 51` and `withExif: false`. Requesting
51 allows for the reference itself; it is removed wherever it appears and the
remaining list is capped at 50. The flat filters are supported in Immich 2.7.5,
3.1 and 3.2 (deprecated but still accepted in 3.2). No paging, retries or alternate
endpoint fallback occurs. Only members of the opened group receive ranks in the
browser; unrelated result IDs and full asset metadata are not exposed.

The reusable `CurateSimilaritySearch` service has one search lane per Pictaria
instance, a 15-second deadline and 2 MiB response ceiling. Concurrent uncached
checks return a busy message, rather than queueing. Starts are at least five
seconds apart; a failure imposes a 30-second pause. Closing the dialog cancels
the request, and late answers cannot populate another experiment. Connection
changes, changed reference-image evidence or removal from the review list
invalidate reuse; changes during a read withhold the response.

At most 40 results (50 IDs each, without metadata) are kept in memory for ten
minutes. They are reused across tabs and group reopenings with the same reference;
the displayed time is the original search time, not cache lookup time. Once
checked, the open experiment keeps that result fixed. Reopen and check after
expiry to obtain a new result. Library changes or an Immich search-model change
may alter rankings on the next search. The cache does not promise a live view of
those changes and is cleared on restart.

Opening groups, loading more groups, refreshing recognition, and adjusting rules
never launch this search. There is no automatic all-stack mode. Returning 50
results limits response size, not Immich's internal search work; measured test-
instance latency and library load should guide any future background use.

## Multi-reference rank comparison (PIC-380)

**Check selected group** checks multiple references in capture order. Each row
is one search: A→B and B→A are separate observations, never an inferred symmetric
score. The table identifies references by the same Photo 1 / 2 labels shown on
cards. Click a row label to highlight that photo's proposed group. It shows
unqueried, waiting/searching, complete, cached and failed states, returned depth,
original check time and search duration. Only selected-photo ranks reach the UI.

A local-only preflight displays new searches, reusable cache rows and references
left for later. Each explicit pass admits **at most eight uncached searches**,
reserves the existing shared search lane and spaces request starts at least five
seconds apart. It streams progress and has a 180-second overall deadline. The
per-request timeout, response cap, failure cooldown and cache limits still apply.
If the cache estimate changes before admission, the pass does not start; the UI
shows an updated estimate. There are no hidden retries or extra result pages.

**Cancel** or closing the dialog aborts further work. Completed rows remain;
unqueried rows are unknown. A failed request stops the pass. **Check remaining
references** starts another explicit pass and does not retry failed references.
**Reset rank evidence** deliberately clears those held rows; the next pass can
reuse any valid ten-minute cache entries. It is not a forced cache eviction.
Changing the connection or any selected source revision invalidates the combined
rank evidence, rather than mixing libraries/renditions. A changed or expired
snapshot requires reset/rebuild. Ranks do not detect unrelated library changes
or search-model revisions; their displayed timestamps describe that limitation.

The matrix admits **2–40 photos**. A larger group stays available to the other lab
experiments, but its rank check is explicitly unavailable; no subset silently
stands for the whole group. Groups with 9–40 uncached references need multiple
explicit passes. Each direction needs at most one search, so N references cost
at most N requests, not N². This does not imply Immich's internal search work is
constant or cheap; test-instance load still needs evaluation before automation.

## Combined-evidence experiment (PIC-380)

Select **Try combined evidence** to compare candidate rules with the original
individual filters. Enable the evidence sources to include, then optionally
**Use reciprocal search ranks**. These switches only reuse held data. Search
rows are committed to the grouping experiment after the explicit pass ends,
including completed rows from a cancelled/failed pass. No incremental arrival
silently rearranges the grouping mid-pass. Changing controls still recalculates
against the previously held evidence until that pass ends.

This deliberately small decision table is an experiment, **not calibrated
production behavior**:

- Close ThumbHash, with no observed conflict in the enabled people evidence,
  supports alternatives under the tested rule.
- Different known Enrich categories or disjoint nonempty recognized IDs plus a
  ThumbHash difference propose a separation, unless reciprocal near ranks
  contradict it. This corroboration rule can still be wrong and needs evaluation.
- Close ThumbHash or reciprocal near ranks conflicting with people evidence
  remain uncertain. People differences alone do not split photos in this mode.
- Reciprocal near ranks plus supported people agreement can support alternatives
  even when the coarse hash differs. Rank alone needs independent composition
  evidence. The initial top-10 cutoff is a lab starting value, not a recommendation.
- Missing, failed, asymmetric, low or not-returned rank evidence is unknown,
  never evidence of dissimilarity. With insufficient evidence, keep the bounded
  time group provisional for inspection rather than inventing a separation.

Every proposed group checks every pair. A supported A–B and B–C cannot bridge a
proposed A–C separation. Any uncertain internal pair labels the group provisional.
Stable capture-time/ID ordering and the same greedy placement rules apply. Time
and span boundaries still constrain the scope. All original photos remain visible.
Highlight a photo to see its pair explanations, raw hash distances, directional
ranks, people conflicts and missing observations. The copy action includes those
explanations using photo numbers without filenames, asset IDs or identity labels.

This does not implement exact-checksum/rendition rules, detected-face counts,
scene tags, Pictaria vectors, production defaults or either AI role. The lab still
ignores saved human separations, so it cannot stand in for production acceptance.
No supported/provisional label here authorizes bypassing an AI stack check.

## Individual-filter rules

These are the original lab rules, used when combined mode is off.

Photos are considered oldest first with deterministic ID ties. Each joins the
most recently created group that satisfies the selected rules; otherwise it
starts a new group. The gap is measured from that group's last photo, the span
from its first, and visual/category/identity compatibility against **every member**. No
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

The people rule compares supported saved Enrich categories: **None, One, Couple
and Group**. Different known categories block a join; `group` is a useful category,
not an invented exact headcount. Two Group photos are still compatible under this
rule even if one contains more people than the other. The time and visual rules
continue to apply.

The lab reads the latest successful Enrich result with its saved producing schema;
it does not guess from tag text or today's profile. Missing/unsupported provenance,
unknown values, or conflicting `has_people` / `people_count` fields remain unknown
and do not force a split. The photo card explains unavailable/conflicting evidence.
Immich recognition is shown separately and is not required to match:
recognition may miss people. Scene tags are not compared.
This is deliberately broader than the Curate Preview's current corroborated
exact-count rule. Production/Preview grouping rules are unchanged by this lab
experiment. Fresh shared metadata can affect their next view, just as normal
Curate metadata refresh can.

**Separate different recognized people** is an independent, initially-off rule.
It compares Immich person IDs without needing Enrich categories. Two
nonempty identity lists with **no identities in common** block a join. Missing,
empty, omitted or malformed lists do not force a split; overlapping lists remain
compatible because one could be incomplete. Matching identities never override
the other enabled rules. All-pairs checking prevents an unknown or overlapping
photo from bridging two photos with disjoint identities.

For example, solo photos recognized as `{A}` and `{B}` separate under this rule.
A couple photo `{A,B}` overlaps both and is not separated from either by identity
alone; enabling Enrich people categories also separates it from the One photos.
This is an experimental signal, not certainty: if Immich detects only A in one
couple photo and only B in another, even this rule can split similar photos.

Cards use **Person 1, Person 2, …** consistently within the open experiment so
identity overlaps are visible. These labels are local to that experiment, not
Immich names or stable labels across groups. Identity lists are bounded to the
existing evidence limits; no person-name lookup is added.
Copied summaries include the switch and evidence coverage, but no identity IDs
or labels. Recognition reads distinguish an explicit empty list (**No recognized
people returned**), omitted/unusable recognition (**Recognition data not returned**),
and a failed read (**Couldn't load recognition data**). Successful asset reads show
their check time. An empty list still does not mean there are no people in the image.

Recognition stays fixed while toggling rules. **Refresh from Immich** replaces it
with new responses; failures never silently reuse old identities. Group membership,
time, ThumbHash and Enrich evidence stay at the baseline snapshot until time groups
are rebuilt. This is recognition refresh, not re-enrichment or a detected/unassigned
face-count experiment.

## Isolation, snapshots and limits

- No provider requests, human/tag/album mutations, settings saves or saved stack
  corrections originate from this page. It does not issue decision leases.
  Reading it can update the existing derived local Curate cache, and viewing
  thumbnails uses the ordinary read-only Immich image proxy. Other independent
  scheduled work in the instance continues normally.
- Building time groups reads one coherent local SQLite snapshot after projection
  refresh. Opening a complete group or pressing **Refresh from Immich** requests
  asset metadata for just those photos through Curate's shared read lane. No
  production view lease is created, and opening the lab does not enable automatic
  library refresh. Explicit reads also work with production Stacks turned off.
- Recognition refresh allows at most two Immich requests at once, shares the
  existing cooldown/backoff and source-change checks, and has a 45-second overall
  deadline including queue time. Repeating a read may wait for the 30-second
  per-photo minimum. Partial failure is explicit. Closing the experiment cancels
  its request; a late response cannot change another experiment. Up to four
  explicit selections may be active/waiting; further requests return a busy error.
- New enrichment, background refresh or decisions elsewhere do not silently change
  an open experiment. Recognition refresh returns an independent snapshot rather
  than changing the retained baseline or another tab's evidence. Reads update the
  existing shared metadata cache but never rewrite human decisions.
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
