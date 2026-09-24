# Curate stacking algorithm

**Status: candidate 3, in Curate Preview only (PIC-382 / PIC-380).** These are
starting rules for evaluation, not calibrated accuracy claims or the released
Curate algorithm. The implementation identifier is `candidate-3`. The current
`/curate.html` and its AI referee are unchanged.

## What a stack means

A stack should contain repetitive alternatives from which you would normally
choose one or a few keepers. Sharing a moment is not enough: a portrait, a couple
and a landscape can deserve three separate comparisons. Curate finds good,
non-repetitive photos; choosing photos to tell a larger story belongs to future
Compose work. Keeper taste is separate from stack composition.

The preview first finds photos taken near each other, then combines available
people and visual evidence. A similar thumbnail is helpful; a different-looking
thumbnail does not necessarily mean a different subject. Rotation, framing and
zoom can change that descriptor. Nearby reciprocal Immich search results can
supply stronger composition evidence. A photo with uneven search results can
still belong when an established group consistently supports it.

There is one algorithm for portraits, landscapes and mixed libraries. People
signals matter where informative. Neither “no people” nor “group” tells us that
two scenes match. Missing information stays unknown. Enrich is optional; existing
supported Enrich results remain usable even if future enrichment is disabled.

Human separations always win. No AI calls are made by this candidate algorithm.
The optional Stack Referee and Keeper Referee remain separate future integrations.
“Supported” below describes this rule's evidence, **not** an AI check or permission
to bypass one. The preview's keeper decisions are still entirely human.

## Candidate 3: precise rules

Membership rules live in `src/curate/candidate.mjs`, with subgroup contrast in
`src/curate/rank-contrast.mjs`. They run in the existing
background grouping worker; the page renders immutable views of its output.

| Stage | Rule |
| --- | --- |
| Stacking off | Show singles. Stop automatic composition searches. Preserve human decisions/corrections. |
| Time candidates | Pending, available photos sorted by capture time, then ID. Consecutive gap at most **90 seconds** and total span at most **180 seconds**. Start a new candidate when either limit is exceeded. Missing dates and known unavailable photos remain singles. |
| Bounds | Evaluate all pairs in candidates of **2–40 photos**, at most **600,000 pairs per rebuild**. No sampled subset is represented as a complete check. Larger/budget-limited candidates retain unconfirmed time grouping, respecting human partitions, without rank searches. |
| Producing Enrich evidence | Read the saved schema and output that produced the photo's result. Recognize the supported None / One / Couple / Group contract with consistent `has_people`. Unsupported or contradictory records are unknown. Never infer semantics from tag spelling or today's active profile. |
| People composition conflict | Different supported **None / One / Couple** categories; or changed nonempty recognized identity sets when each set's size agrees with its supported small Enrich category. **Group vs None/One** is also a conflict. **Group vs Couple** remains ambiguous because background people can change the category; Group is not a precise count. |
| Recognition uncertainty | Different nonempty identity sets without that count corroboration block a ThumbHash-only match, but reciprocal ranks may support it. Recognition missing in one image, including an observed empty list, is not proof of different people. Identity lists are never claimed complete. |
| Exact rendition support | Equal original checksums **and** compatible recorded rendition keys support grouping, within time/human constraints. An original checksum alone or an approximate Immich duplicate-group ID does not force membership. |
| ThumbHash support | Normalized mean absolute difference of descriptor bytes **≤ 0.10** supports a pair absent people conflict/recognition uncertainty or established subgroup rank contrast. This is the existing comparator, not a semantic embedding distance. Missing/malformed descriptors are unknown; unequal descriptor lengths do not supply close support. Larger distance alone is not a separation veto. |
| Search support | For each direction, count photos **outside the entire original time candidate** ranked ahead of the target. Both directions with **≤ 3 outside** support a pair. An unreturned target, failed search or unqueried direction is unknown. There is no absolute similarity score. |
| Subgroup rank contrast | After the complete pass, form separate **reciprocal-near cores of at least 2** without human/people conflicts, using the same deterministic clique ordering as normal cores. A previously single member can belong to one contrast subgroup if at least **2 and 75%** of its frozen core rank it near, it has no far outgoing relation to that core, and it conflicts with no member. Attachments never vote or anchor further attachments. Two qualifying cores are ambiguous. Require at least **2 and 75%** of each core’s reference searches to rank **every** member of the other subgroup at **12 or more outside photos ahead**, or omit it under the bounded-absence rule below. Any close cross-direction or compatible exact rendition blocks this contrast rule. Established contrast overrides ThumbHash support and prevents provisional joins and asymmetric recovery across the boundary. |
| Bounded absence | A missing target can contribute only to the subgroup rule: the successful row must contain the **full 50 results**, with at least **12 outside-candidate results** retained. The target must already have positive membership evidence in the other reciprocal core/subgroup. Store these counts, not unrelated IDs. Failed/unqueried rows, empty/short results, unknown targets and isolated misses cannot establish this contrast. Absence is never assigned an exact rank or similarity distance. |
| Strong separations | Human separations and the supported people conflicts above prevent grouping, including when a supplied search row is close. Do not search a pair whose separation cannot change. Uncorroborated recognition changes remain uncertainty, not a strong separation. |
| Core grouping | Order by number of supported neighbors, then capture time/ID. Greedily form cores where every pair is supported. A–B and B–C support alone cannot establish A–B–C. |
| Asymmetric recovery | An initially single photo may attach to exactly one **frozen core of at least 3**: at least **75%** of core members rank it within 3 outside; it ranks at least one core member within 3 outside and at least **50%** within **8 outside**. Round required counts up. No people conflict or human separation with any member, including other attachments. Attachments cannot act as further attachment anchors. Two competing cores remain ambiguous. |
| Pending or missing evidence | Keep supported cores intact, then combine cores provisionally only when **every cross-pair is supported or unknown**. Until all required searches finish, unsupported nonconflicting pairs are unknown. Completed empty rows or absent targets stay unknown unless the collective subgroup-contrast rule resolves the relationship. A distant ThumbHash alone never fragments a candidate. Strong people differences and human separations apply immediately. |
| Completed evidence | Apply core grouping and asymmetric recovery using the completed pass. If an unsupported pair has both directional observations, it cannot be joined provisionally through an unknown bridge. Remaining unknown-compatible photos may still form a labeled provisional group. Separate comparisons mean insufficient support under these rules, not proof of different subjects. |

These bounds intentionally do not reproduce the older foundation's out-of-window
checksum/duplicate lookback. Candidate 3 uses one time-bounded composition scope.
Scene tags, descriptions, detected-face counts, direct embeddings and AI judgments
are not inputs in this version. The stricter **Same recognized people** lab
checkbox remains an independent experimental rule, not the preview's policy.

### Why the asymmetric rule exists

In an owner-confirmed five-photo landscape comparison, four photos formed a
strong reciprocal core. The fifth was ranked near the top by all four core
members. Its own searches were less consistent: one near, two moderate and one
weak relationship. It belongs despite framing differences and that weak direction.

The anonymized regression records outside counts (row → column):

| | 1 | 2 | 3 | 4 | 5 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1 | — | 0 | 1 | 0 | 0 |
| 2 | 0 | — | 0 | 0 | 0 |
| 3 | 6 | 1 | — | 19 | 6 |
| 4 | 0 | 0 | 1 | — | 0 |
| 5 | 0 | 2 | 2 | 0 | — |

Candidate 3 retains all five. This is one useful acceptance example, not evidence
that the thresholds generalize. Synthetic bridge, recognition, human-correction
and fallback tests cover the complementary failure cases.

### Why subgroup contrast exists

In a nine-photo lab comparison, the owner identified photos 1–3 as scene views
and 7–9 as couple portraits; photos 4–6 were already separated by other evidence.
The observed searches rank 1–3 close to each other and 7–8 close to their couple
peers, including 9. Across those sets, targets are absent from the full top 50,
except 1 → 7 at 22 outside photos ahead. This repeated contrast should separate
the two sets despite a common background or close ThumbHashes.

The anonymized regression preserves the **eight observed rows**. Row 9 was not
queried in the lab screenshot and remains unqueried in that fixture. It cannot
publish a completed pass. Separate, explicitly synthetic completions test the
final split, including a ninth row with close peers and an empty ninth response
whose photo still has two positive incoming witnesses. No private images, asset
IDs or source metadata are included. The middle trio’s synthetic people evidence
models its existing separation; it is not a claim about its real Enrich output.

This complements the five-photo landscape regression above: one unevenly ranked
member does not make two independently supported subgroups, so the existing
recovery remains available. Human separations and exact-rendition safeguards
remain intact.

## Automatic searches and stable views

The server processes pending time candidates in the background whenever Stacks
is enabled and Immich is configured. Startup resumes the backlog; arrivals from
Enrich are picked up without a browser. Opening Curate, filtering and **Load more**
only display work and adjust priority; they are not processing triggers. Small locally
resolved comparisons and compatible exact renditions need no extra lookup.
Larger ThumbHash-supported compositions also need verification: admit a photo
with at least three nonconflicting neighbors when at least one of those pairs
is not an exact rendition match. This enables the two-subgroup contrast rule
instead of allowing hash support to suppress the evidence that could contradict
it. It can increase requests on larger hash-only groups, within the same bounds.

Other required references are the endpoints of locally
unsupported pairs without a human or strong people conflict. In candidates of
four or more photos, also include nonconflicting neighbors of those endpoints:
a locally supported neighbor can still supply a rank needed for asymmetric
recovery against a core. This deliberately favors preserving useful recovery
evidence over the smallest possible request count. For example, a
landscape/solo/couple candidate already resolved by people categories needs zero
searches. A resolved two-photo couple in a larger candidate need not be queried when only
the solo photos are uncertain. Filtering to just that resolved couple does not display a check on its card; the
hidden solo group still progresses in the background. Outside-rank counts still exclude the
**entire original time candidate**, including members not queried.

For each admitted candidate, the scheduler collects all **required** reference
searches before publishing its matrix. Partial results are used
only for progress, never for intermediate regrouping. Changed local evidence can
still invalidate or resolve a candidate between requests.

- One shared lane with the lab, at least **2 seconds** between new requests,
  with a **30-new-request rolling-minute cap** on automatic work. Requests stay
  sequential. A successful search taking at least two seconds adds a pause equal
  to its duration (capped at 30 seconds) after completion. Service-wide failures
  retain the longer cooldown; failed references use exponential retry delays.
  No extra AI/provider calls.
- The opened comparison gets the next search turn, followed by currently visible
  cards, then other admitted groups. An in-flight request finishes normally.
  The browser reports at most 50 visible group IDs plus the open comparison;
  the server validates all against the saved view. Attention expires after 12
  seconds without renewal; view attention records are retired after 60 seconds
  idle. Neither expiry stops background processing. An inspected candidate can
  take an untouched waiting slot; partial and in-flight passes are retained.
  Prioritization does not bypass source or membership checks.
  Cached evidence can be consumed during network pacing without spending a
  request slot. The reference set and 50-result window are unchanged.
- Each request asks for one reference's first 51 image results, removes the
  reference and keeps at most **50**. No pagination to find a desired match.
  Timeout **15 seconds**, response limit **2 MiB**, failure cooldown at least
  **30 seconds** for authentication, rate limits, disabled search, timeouts and
  other service failures. A missing embedding or unavailable reference (HTTP
  400/404/422, except disabled search) keeps normal two-second pacing for other
  photos. Permission/API/index failures leave manual Curate available.
- At most **32 incomplete candidate passes** in memory, each at most 40 photos.
  Completing a pass frees its slot so the entire backlog can advance without
  pagination. Partial coverage is never published as a completed result.
- Completed candidate-member matrices persist in `curate_rank_evidence` in the
  Enrich database. Scope hashes include exact membership, material evidence,
  human constraints and algorithm version; the connection fingerprint must also
  match. No credentials, unrelated result IDs or response bodies are stored.
  The grouping worker reads one matrix at a time from its coherent SQLite snapshot.
  Completed evidence has no inactivity TTL: an unchanged pending candidate stays
  checked through restarts and Refresh, even when nobody opens the page.
- Storage is bounded to **50,000 matrices**, **256 KiB per matrix**, and **64 MiB
  of serialized evidence** (database/index overhead is additional). Obsolete
  scopes are pruned in batches of at most 128. At capacity, preserve existing
  evidence and pause new publication rather than evicting stable results and
  continually rechecking them. A limited status explains this condition.
- The separate shared search cache still holds **40 references for 10 minutes**
  in memory. Failed passes also checkpoint successful rows and per-reference retry
  deadlines, surviving restart; untouched in-progress passes may repeat after restart. Completed matrices
  are invalidated by known photo/people evidence, membership or human constraint
  changes, a changed algorithm, or a different Immich connection. Stacks off and
  shutdown cancel in-flight work; browser inactivity does not. Unseen remote
  changes (including changed search index rankings) cannot be detected by these
  fingerprints; this is retained evidence, not a continuously refreshed index.
- A failed reference does not hold an active slot while deferred. Except for
  missing embeddings, a reference failure also pauses its whole candidate for
  **60 seconds**, releasing the slot for other groups. When admitted again, it
  joins behind existing work at equal browsing priority. Unqueried members get
  a turn before due retries, so one repeatedly failing photo cannot monopolize
  its own group either. Parked partial passes stay outside the **32 active scopes**
  and never enter the grouping algorithm until every required search succeeds.
  Retry checkpoints are bounded to **50,000 records**, **256 KiB per record**,
  **16 MiB serialized total**, with obsolete scopes pruned in batches of 128.
  Only compact progress summaries stay in memory. At capacity, preserve active
  evidence and expose a storage-limited status instead of silently discarding it.
- Confirmed Immich HTTP 400 “has no embedding” responses retry the affected photo
  after **15, 30 and 60 minutes**: three automatic retries after the initial
  attempt, then **stop**. The stopped state survives restart, releases its active
  slot and remains incomplete. Other references can still finish. Explicit
  **Refresh** starts a new bounded cycle for stopped references. This error does not impose a
  connection-wide failure cooldown. Other failures retry after **60 seconds**,
  doubling to **15 minutes**; service-wide failures also retain the shared
  transport cooldown. The three-retry cap applies only to missing embeddings,
  which are never interpreted as empty successful results or dissimilarity.
- Manual **Refresh** releases retry deadlines, while respecting shared pacing and
  rate limits. Opening the page, changing filters, loading more and automatic
  view replacement do not reset them. A busy lab search delays background work.
- Responses expose safe predefined problem codes/messages, failed group/reference
  counts and the next retry time, including while healthy work is still waiting
  or running. Upstream error bodies, private identifiers and credentials are not
  forwarded. Unknown HTTP 400s remain generic reference failures; only the known
  diagnostic is classified as a missing embedding.

The retry window accommodates a photo whose Immich Smart Search job is still
queued. It is not a repair guarantee: Immich's [reference search handler](https://github.com/immich-app/immich/blob/v3.2.0/server/src/services/search.service.ts)
rejects a missing embedding without scheduling generation. Generation belongs to
its [Smart Search job](https://github.com/immich-app/immich/blob/v3.2.0/server/src/services/smart-info.service.ts).
A persistent failure may need attention in Immich; Pictaria does not keep polling
it indefinitely or invoke Immich processing jobs.

Cards show **Waiting for similarity check**, **Checking nearby photos · N of M**,
or **Updated grouping ready**. Counts cover the required references for the
original time candidate, which can appear as several cards. Locally resolved
cards do not display another group's pending check. Pending groupings remain
provisional; failed searches are explicitly paused. Successful searches that
leave membership uncertain say **Check complete · similarity uncertain**, retain
the provisional grouping, and do not automatically retry or fragment it. An
unconfigured or unavailable search service also leaves time groups provisional.
Photo cards show a muted spinner for queued work, a blue spinner while checking,
and an amber indicator for paused, limited or inconclusive checks. Completed
supported work is quiet on cards. The open comparison retains the complete
status and explanation, including when no search was needed; unconfigured checks
are not shown as completed. Text/accessible labels accompany color and animation;
reduced-motion preferences disable spinning. Updated views with pending checks
keep a pending indicator, rather than claiming completion.

`refinement.metrics` on the groups/status response exposes only in-memory
aggregate measurements since service start: search attempts/completions, cache
hits, failures, last/average completed-search duration, completed automatic
cohorts and average admission-to-completion time (including queueing, pauses and
retry delays). Search measurements include the shared lab lane; direct lab-cache
reads do not increment `cacheHits`. No photo IDs or responses are included.
These are diagnostic counters, not persistent performance history or a new UI.

The page shows global background progress beside the stack/single-photo counts
in a reserved status row, plus an activity spinner beside Refresh. When checks
fail, this shows **N need attention** and an amber indicator; its tooltip explains
the cause and next retry. When only deferred work remains it says **Checks waiting**.
When only exhausted work remains, it says **Checks stopped**. The comparison’s
Why explanation also gives the cause and retry time, or says automatic retries
stopped and asks the user to check Immich before explicitly retrying. Cards still
show their own status and highlight changed grouping. Checks that finish without changing grouping, or in an unrelated
view, do not by themselves request a replacement view. The single **Refresh**
button highlights waiting updates, including changed photo information.

Background evidence changes only the next grouping snapshot. The grid adopts
that snapshot automatically when browsing pauses, preserving loaded pages and a
surviving scroll anchor. Open comparisons/lightboxes, selected batches and pending
operations keep their current view fixed. A failed automatic update requires
explicit Refresh; this does not stop the independent background scheduler. Polling reads at
most 50 cards near the visible cards or open comparison, every four seconds.
A newly enlarged group can make an older smaller comparison unsafe to save; the
existing membership checks require a refresh in that case. Human decisions,
revisions, whole-group application and Undo keep their existing contracts. No
ranking changes human tags by itself. See [preview behavior](CURATE-PREVIEW.md).

**Why?** beside the similarity status shows the rules that supported the current
comparison, with its algorithm version. Hover, focus or tap opens a read-only
overlay without reflowing the photos. If the opened view predates the applicable calculation,
the explanation says membership was preserved rather than inventing historical
reasoning. This initial explanation is a summary, not a persisted per-pair audit
log. Detailed signal inspection remains in the lab.

## Validation and iteration

Review a mix of portraits, landscapes, urban photos, different orientations,
looking-away faces, mixed compositions and unknown/missing signals. Report both
wrong merges and missed alternatives, with the algorithm version. Keep the
existing human-flow tests and verify bounded demand/cancellation, stale decisions,
cache expiry, partial/failing searches and shared-lane contention.

The **0.10 ThumbHash** cutoff remains an uncalibrated positive-support rule.
An owner-observed scene/couple example now supplies a concrete false-merge case.
Candidate 2 allowed ThumbHash support or provisional missing ranks to retain
such a grouping; the private descriptors/cache were not inspected. Candidate 3 lets repeated subgroup rank contrast outweigh that support;
a single distant direction or an isolated omission still cannot do so. The new
12-outside contrast threshold and subgroup requirements are explicit starting
choices, not measured accuracy guarantees. Keep evaluating both wrong merges and
unnecessary splits, especially in libraries with many similar scenes.

The numerical limits are explicit starting choices. Owner testing, complete-server
mixed-load/memory measurements and v1.3 rollout acceptance remain outstanding.
Do not turn qualitative examples into accuracy percentages. Future settings,
calibration, embeddings or Stack Referee integration should reuse this composition
and decision contract, not create a permanent second Curate pipeline.

## Change history

| Version | Date | Change / rationale | Tracking |
| --- | --- | --- | --- |
| `candidate-1` | 2026-09-21 | First integrated preview: wider time candidates, contextual people evidence, positive ThumbHash, reciprocal ranks and bounded core recovery; paced background searches and stable views. | PIC-382, under PIC-380 |
| `candidate-1` publication / UX follow-up | 2026-09-21 | Publish only complete search matrices, retain evidence for active views, and show per-card progress plus an explicit updated-stacks action. Fixes partial-result and timed-expiry regrouping during repeated refreshes; final membership rules and thresholds are unchanged. | PIC-382 |
| `candidate-2` | 2026-09-21 | Review follow-up: retain compatible uncertainty provisionally while searches are pending, failed or missing targets; separate Group from None/One; query unresolved, nonconflicting pairs and their potential core-recovery context. Preserve complete-pass publication, original-cohort outside counts and existing thresholds. | PIC-382 / PIC-380 |
| `candidate-3` | 2026-09-21 | Owner scene/couple counterexample: repeated contrast between reciprocal subgroups can override hash support and provisional unknown joins. Preserve bounded result-window counts; verify larger hash-only groups so contrary evidence can arrive. Keep 50 results, pacing, complete-pass publication, and the landscape recovery rule. | PIC-382 / PIC-380 |
| `candidate-3` scheduling / status follow-up | 2026-09-22 | Two-second healthy pacing, 30 automatic requests/minute, slow-response backoff, open/visible priority, immediate cached reuse and aggregate diagnostics. Visual queued/checking/done/attention markers; grouping rules, reference selection and result depth unchanged. | PIC-382 |
| `candidate-3` review UX follow-up | 2026-09-22 | Automatically adopt complete snapshots at idle boundaries; freeze open comparisons and selections, preserve browsing position, and retain explicit Refresh for recovery. Remove manual stack-management controls; existing saved separations remain respected. No membership-rule or search-threshold change. | PIC-384 |
| `candidate-3` background processing | 2026-09-23 | Process all pending candidates without browser demand; persist complete evidence, drain bounded active slots and retry failures with backoff. Compact global progress, Pending label and direct stack opening. Membership rules and search limits are unchanged. | PIC-385 |
| `candidate-3` failure recovery | 2026-09-23 | Surface safe search failures, park missing-embedding references with persistent backoff and a three-retry cap, and allow other work to drain. No grouping or search-limit change. | PIC-387 |

When membership rules, thresholds or interpretation of signals change, increment
the implementation identifier and add a row describing the behavioral change and
its evidence. Preserve earlier entries. Documentation clarifications or layout-only
changes do not require an algorithm-version change. Before making this the default
Curate page, update the main user guide and remove superseded staging descriptions.
