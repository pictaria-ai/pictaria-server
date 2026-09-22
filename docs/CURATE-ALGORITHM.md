# Curate stacking algorithm

**Status: candidate 2, in Curate Preview only (PIC-382 / PIC-380).** These are
starting rules for evaluation, not calibrated accuracy claims or the released
Curate algorithm. The implementation identifier is `candidate-2`. The current
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

## Candidate 2: precise rules

All membership rules live in `src/curate/candidate.mjs`. They run in the existing
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
| ThumbHash support | Normalized mean absolute difference of descriptor bytes **≤ 0.10** supports a pair absent people conflict/recognition uncertainty. This is the existing comparator, not a semantic embedding distance. Missing/malformed descriptors are unknown; unequal descriptor lengths do not supply close support. Larger distance alone is not a separation veto. |
| Search support | For each direction, count photos **outside the entire original time candidate** ranked ahead of the target. Both directions with **≤ 3 outside** support a pair. An unreturned target, failed search or unqueried direction is unknown. There is no absolute similarity score. |
| Strong separations | Human separations and the supported people conflicts above prevent grouping, including when a supplied search row is close. Do not search a pair whose separation cannot change. Uncorroborated recognition changes remain uncertainty, not a strong separation. |
| Core grouping | Order by number of supported neighbors, then capture time/ID. Greedily form cores where every pair is supported. A–B and B–C support alone cannot establish A–B–C. |
| Asymmetric recovery | An initially single photo may attach to exactly one **frozen core of at least 3**: at least **75%** of core members rank it within 3 outside; it ranks at least one core member within 3 outside and at least **50%** within **8 outside**. Round required counts up. No people conflict or human separation with any member, including other attachments. Attachments cannot act as further attachment anchors. Two competing cores remain ambiguous. |
| Pending or missing evidence | Keep supported cores intact, then combine cores provisionally only when **every cross-pair is supported or unknown**. Until all required searches finish, unsupported nonconflicting pairs are unknown. Completed empty rows or absent targets also stay unknown. A distant ThumbHash alone never fragments a candidate. Strong people differences and human separations apply immediately. |
| Completed evidence | Apply core grouping and asymmetric recovery using the completed pass. If an unsupported pair has both directional observations, it cannot be joined provisionally through an unknown bridge. Remaining unknown-compatible photos may still form a labeled provisional group. Separate comparisons mean insufficient support under these rules, not proof of different subjects. |

These bounds intentionally do not reproduce the older foundation's out-of-window
checksum/duplicate lookback. Candidate 2 uses one time-bounded composition scope.
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

Candidate 2 retains all five. This is one useful acceptance example, not evidence
that the thresholds generalize. Synthetic bridge, recognition, human-correction
and fallback tests cover the complementary failure cases.

## Automatic searches and stable views

Only opening/paging a **Curate Preview** view admits automatic searches, for
unresolved time candidates represented on the pages requested. Opening the lab,
released Curate, or starting the server does not admit this work. Local coherent
matches need no extra lookup. Required references are the endpoints of locally
unsupported pairs without a human or strong people conflict. In candidates of
four or more photos, also include nonconflicting neighbors of those endpoints:
a locally supported neighbor can still supply a rank needed for asymmetric
recovery against a core. This deliberately favors preserving useful recovery
evidence over the smallest possible request count. For example, a
landscape/solo/couple candidate already resolved by people categories needs zero
searches. A resolved couple in a larger candidate need not be queried when only
the solo photos are uncertain. Filtering to just that resolved couple does not
admit searches for the hidden solo group. Outside-rank counts still exclude the
**entire original time candidate**, including members not queried.

For each admitted candidate, the scheduler collects all **required** reference
searches before publishing its matrix. Partial results are used
only for progress, never for intermediate regrouping. Changed local evidence can
still invalidate or resolve a candidate between requests.

- One shared lane with the lab, at least **5 seconds** between new requests,
  at most **8 new requests per rolling minute**. No extra AI/provider calls.
- Each request asks for one reference's first 51 image results, removes the
  reference and keeps at most **50**. No pagination to find a desired match.
  Timeout **15 seconds**, response limit **2 MiB**, failure cooldown at least
  **30 seconds**. Permission/API/index failures leave manual Curate available.
- At most **32 candidate cohorts** retained in the automatic scheduler, each at
  most 40 photos. Active views retain their evidence, including completed matrices
  across explicit Refresh. Entries expire after **10 minutes without active view
  demand or progress**, rather than ten minutes from admission. No retained entry
  is evicted merely to start more work. At capacity, other cohorts wait until
  space expires; this is shown on their cards. Requests are sequential, and one
  candidate can take several minutes. Partial coverage is never published as a
  completed grouping result.
- The shared search cache holds at most **40 references for 10 minutes**. The
  automatic cache retains only candidate-member positions, not unrelated photos
  or response bodies. It is memory-only; restart begins a fresh bounded pass.
- Preview polling renews demand. After **60 seconds** without visible-page
  activity, demand stops. Expired/replaced views, stacking off, connection changes,
  changed candidate membership/material/human constraints, and shutdown cancel
  or discard in-flight work. Known source/connection revisions are checked before
  and after I/O; unseen remote changes cannot be guaranteed absent.
- Failures pause automatic work without repeated retry. An explicit new view
  (Refresh, a filter change or post-action refresh) allows another attempt after
  the shared cooldown. A busy lab search merely delays the preview.

Cards show **Waiting for similarity check**, **Checking nearby photos · N of M**,
or **Updated grouping ready**. Counts cover the required references for the
original time candidate, which can appear as several cards. Locally resolved
cards do not display another group's pending check. Pending groupings remain
provisional; failed searches are explicitly paused. Successful searches that
leave membership uncertain say **Check complete · similarity uncertain**, retain
the provisional grouping, and do not automatically retry or fragment it. An
unconfigured or unavailable search service also leaves time groups provisional.
The page summarizes checks for its own requested groups and highlights cards whose
grouping changed. Checks that finish without changing grouping, or in an unrelated
view, do not by themselves trigger a refresh prompt. Photo-information changes
retain their separate refresh notice.

Background evidence changes only the next grouping snapshot. **Show updated stacks**
explicitly loads it; progress polling does not move cards, change a comparison's
members or clear keeper selections. Polling reads at most 50 cards near the visible
cards or open comparison, every four seconds. A newly enlarged group can make an older smaller comparison
unsafe to save; the existing membership checks require a refresh in that case.
Human decisions, revisions, whole-group application and Undo keep their existing
contracts. No ranking changes human tags by itself.

**Why this stack?** shows the rules that supported the current comparison, with
its algorithm version. If the opened view predates the applicable calculation,
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
Similar backgrounds can produce close descriptors for different scenes; the
review identified this as a calibration concern, not a demonstrated real-photo
regression. Returned distant ranks do not currently cancel that local support.
Keep collecting real-photo wrong-merge examples before changing the cutoff or
adding another veto.

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

When membership rules, thresholds or interpretation of signals change, increment
the implementation identifier and add a row describing the behavioral change and
its evidence. Preserve earlier entries. Documentation clarifications or layout-only
changes do not require an algorithm-version change. Before making this the default
Curate page, update the main user guide and remove superseded staging descriptions.
