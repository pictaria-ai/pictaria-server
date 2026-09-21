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
   Controls sit beside the photos on desktop. On smaller screens, the settings
   panel has its own bounded scroll area and can be collapsed. Rank tables, pair
   evidence and longer explanations are expandable below the photos.
   Opening a group loads recognition from Immich before enabling the controls.
   **Recognition data → Refresh from Immich** repeats that read while keeping
   the selected rules.
3. Every photo stays visible in capture order with a numbered proposed group.
   Click an image to highlight its group and dim the others; no photo is discarded.
   This also shows ThumbHash distances to the highlighted reference. **View
   larger** opens a viewer with previous/next controls and a configured Immich
   link. **Copy** in the window header copies rules, group sizes and evidence
   coverage, without photo IDs, names, hashes or images.
4. Optionally open **Earliest-photo search** below the photos and click
   **Check similarity ranking**. Immich searches its timeline
   images using this time group's earliest photo, including images outside the
   group. The other cards show their positions among the first 50 results after
   removing the reference. The reference stays fixed even when highlighting a
   different photo or changing rules. Search duration and check time appear in
   that section; copied summaries include ranks using Photo 1 / Photo 2 labels.

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
cards. Click a row label to highlight that photo's proposed group. It retains raw ranks plus outside-photo counts, and shows
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

Select **Combine evidence** to compare candidate rules with the original
individual filters. Enable the evidence sources to include, then optionally
**Reciprocal search ranks**. These switches only reuse held data. Search
rows are committed to the grouping experiment after the explicit pass ends,
including completed rows from a cancelled/failed pass. No incremental arrival
silently rearranges the grouping mid-pass. Changing controls still recalculates
against the previously held evidence until that pass ends.

The September 21 review revises this experiment to prefer supported matches
before uncertain attachments. The original single-threshold/time-first rule is
superseded in combined mode; the individual-filter baseline remains available.
These rules are **not calibrated production behavior**:

- ThumbHash has three bands. **Very close** (initially ≤0.025) can support a
  pair without another signal, unless there is conflicting evidence. The **middle
  band** needs compatible people evidence or reciprocal near ranks. **Clearly
  different** (initially ≥0.150) can corroborate separation. There is no special
  transition at the individual filter's 0.100. A hash is never an exact-duplicate
  proof. These starting values need owner evaluation.
- **Same recognized people** is a strict, independent rule in both lab modes.
  Any difference between two observed identity sets proposes separation, including
  partial overlaps and an empty list versus a nonempty one. Missing/failed lists
  remain unknown. Matching sets ignore ordering and duplicates; empty matches do
  not supply positive composition evidence. Close hashes or strong reciprocal
  ranks cannot override an identity change when this switch is on. This replaces
  the earlier lab rule that required disjoint sets and corroboration; see the
  recognition examples below. Other production/preview grouping is unchanged.
- A supported Enrich-category difference plus clearly different ThumbHash or
  corroborating rank contrast can propose separation. Reciprocal near ranks
  conflicting with Enrich categories keep the pair uncertain unless the recognized
  people rule already requires separation. A rank contrast plus clearly different
  hash can also propose separation without people evidence.
- Reciprocal near ranks plus compatible people evidence can recover alternatives
  despite a coarse-hash difference. Rank alone does not support alternatives.
- Missing, failed and not-returned ranks stay unknown, never evidence of
  dissimilarity. Asymmetry or an isolated low returned rank does not establish
  separation. Unresolved pairs stay provisional for human inspection.

**Adjusted ranks.** The table retains raw ranks and also displays the number of
photos **outside the selected time group** ranked ahead of a returned target:
`raw rank − 1 − other selected photos ahead`. For a fourteen-photo burst with
all thirteen alternatives ahead of any outside photo, that count is zero for
every relationship. The initial reciprocal-near allowance is **2 outside photos
ahead** in both directions, independent of burst size. The removed candidates
are not assumed to be true siblings: this is a correction for outside competition,
not a distance, probability or proof that the selected photos match. Missing
results cannot be assigned an adjusted count. Changing the selected candidate
scope can change adjusted ranks; changing proposed partitions does not.

**Returned-rank contrast.** A worse returned position is usable only when both
directions have a better supported alternative in their respective rows. That
alternative must have reciprocal near ranks, no observed people conflict, and
independent hash/people corroboration. The worse target must exceed the near
allowance and have at least **8 more outside photos ahead** than that alternative
(initial lab value). This can corroborate another observed difference; it does
not turn a low or absent rank into a standalone veto. Both the allowance and
contrast gap are adjustable in combined mode without more API requests.

**Placement.** Consider supported links first in stable capture-time/ID order,
then attach uncertain relationships; every attempted merge checks all cross-group
separations and the final consecutive-gap/total-span limits. Revisit previously
out-of-gap supported links after uncertain attachments can supply intermediate
photos. For A–B uncertain, B–C supported and A–C separate, retain B+C and leave
A separate. Equal supported links use capture-time/ID ties; this is deterministic
greedy clustering, not a global optimality guarantee. A proposed separation
cannot be bridged by a third member. Any uncertain internal pair labels the group
provisional. Undated photos stay single; all original photos remain visible.

Highlight a photo to inspect raw and adjusted ranks, hash bands, corroborating
counts, conflicts and missing evidence. Copied explanations retain paragraph
breaks and omit filenames, asset IDs and identity labels. Whole-group synthetic
regressions cover mixed solo/couple/backlit photos, fourteen-photo bursts,
uncertain contamination, missing ranks and contradictory observations; real-photo
false merges and missed alternatives still need evaluation.

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

**Same recognized people** is an independent, initially-off rule in both lab
modes. It compares the complete returned sets of Immich person IDs without
needing Enrich categories. Any observed set change blocks a join. This includes
adding/removing one person, changing one identity while keeping another, or an
explicit empty list versus a nonempty one. Ordering and repeated IDs do not matter.
Missing, omitted, malformed or failed observations stay unknown and do not force
separation. All-pairs checking prevents an unknown photo from bridging two photos
with differing identity sets. Other enabled rules still apply to matching sets.

For example, `{A}`, `{B}`, and `{A,B}` form three groups with this rule enabled.
`{A,B}` and `{B,A}` remain compatible; `{A,B}` and `{A,C}` separate despite the
same count and one shared person. `[]` differs from `{A}`, whereas an unavailable
list is not compared as `[]`. In combined mode, visual/rank support cannot override
these differences. Disabling the switch removes this constraint.

This stricter behavior follows the September 21 owner-requested lab iteration.
It is not proof of different composition: if Immich misses a face or fails to
recognize someone, legitimate alternatives may separate. An empty list is an
observation of recognition, not proof that no people are present in the photo.

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
