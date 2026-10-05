# Photo Referee implementation

The Photo Referee recommends the best photos within the stacks produced by
Curate. It is independent of the optional Stack Referee and uses the same
shared Curate provider/model settings. Recommendations are advice: only a human
decision marks a photo Yes, Skip, Fav or No.

## Current delivery

PIC-116 adds the request/result contract, bounded comparison planner, background
worker, saved-result/API integration, recommendation UI and whole-input
partition publication. **Photo Referee is available in Settings → Curate.**
It defaults off on fresh installs and requires Stacks to be on. It does not
require Enrich or Stack Referee. The released `/curate.html` referee is unchanged.

Existing saved or environment preferences are honored. In particular, the
settings v8 upgrade may already have copied an effective legacy referee on
preference into Photo Referee. That preference can now start eligible background
work after an update, even without a browser open. Saved Settings overrides win
over environment values. Check the effective switch before a controlled install;
no new migration resets the person's choice.

Controlled test-instance acceptance remains before release. The UI consumes
PIC-371's shared badges rather than introducing another status scheme. Synthetic
tests cover the production availability gates, saved-result UI and transports;
they do not establish real-provider quality or runtime acceptance.

## Quality baseline and response

`curate_photo_referee_v1` preserves the owner-accepted released quality criteria
within each subject: sharp people, open eyes and natural expressions, then
sharpness, composition and overall appeal. Every photo receives a short visible
assessment and a closed-eyes observation, with `unsure` for absent, obscured or
small faces. The released legacy contract remains unchanged.

The deliberate differences are:

- Zero, one or multiple recommendations are explicit. There is no fixed
  best-one-or-two cap. A valid empty keeper set means **None recommended**;
  a missing field, failed request or invalid response never means that.
- Clearly different subjects receive an exhaustive, disjoint partition.
  People do not outrank unrelated scenery. Re-framing, modest zoom, expressions,
  orientation and quality differences alone do not require a split.
- Already-kept photos are read-only context. They can inform the comparison but
  cannot appear in the actionable recommendation set. An existing human choice
  is never reopened or demoted.
- There are no model ranks to repair or default. Each group supplies `ids`,
  `keepers` and a concise `reason`. A separate exhaustive `photos` array supplies
  `id`, `eyes_closed` and `reason` for every submitted photo, including context.

Requests use positional aliases and image bytes, with no asset IDs, captions,
tags or recognized-person metadata in the prompt. The worker supplies the
authoritative context membership; it is not a client-controlled exemption.
Per-photo text and group reasons remain untrusted text for escaped rendering.
These are model instructions, not guarantees of visual judgment. This adapted
contract has synthetic transport coverage, not new live model-quality evidence.

## Bounded comparisons

`layoutPhotoRefereeComparisons` accepts chronological pending membership, up to
eight nearby already-kept reference candidates in nearest-first order, and an
explicit provider/model-bound capability. Pending photos determine the layout.
Include at most **two** references, only using spare capacity in a single
whole-stack request. Batched comparisons use no references. References never
split a stack, increase the number of requests, or push a supported pending
comparison over the image/byte envelope. With today's ten-image ceiling, eight
pending photos can include two references, nine can include one, and ten include
none. Larger stacks retain their pending-only batch layout.

Reference capacity also reserves their maximum possible bytes within the
aggregate limit; it does not require fetching unused previews to discover that
they will not fit. The worker supplies this capacity to authoritative input
capture, which derives the selected IDs from the repository. Omitted candidates
are not downloaded, charged, assessed or included in saved applicability
snapshots. The manual comparison's existing context display is unchanged.

`planPhotoRefereeComparisons` then requires a complete rendition-size inventory
for the selected pending photos and references. It preserves pending order.
At least two pending alternatives are required; a sole newcomer with context
remains manual.

Use one whole-input comparison when it fits. Otherwise use at most three balanced
chronological comparisons. With the current ten-image request ceiling, eleven
pending photos become 6/5 and thirty become 10/10/10. Each request still contains
at least two pending photos; no singleton remainder, padding, truncation,
tournament or final winner cap is introduced. These are transport batches, not
new visible stacks.

The complete plan is limited to thirty submitted images, 2 MiB per rendition and
24 MiB aggregate raw image bytes. Selected read-only context counts toward the
single request's image/byte limits but not the actionable-photo churn allowance.
Oversized pending scopes, missing sizes, unknown capability and unsupported
pending layouts do not create a ready plan. The current capability resolver
grants bounded attempts through the seven existing multi-image adapters; it is
not a model-quality guarantee.

`createPhotoRefereeRequest` requires that complete size-checked plan and one
batch's prepared images. Actual image IDs, order and bytes must match the plan
before submission. Images are copied and hashed; JPEG, PNG and WebP are accepted,
except that LM Studio requires JPEG/PNG to avoid unbounded transport conversion.
The provider configuration is pinned and checked before dispatch. Each `submit`
invocation makes exactly one call; the shared executor owns retries and charging.
The response validator is separate and retains no image buffers.

Returned provenance includes the contract, lifecycle input key, plan key, batch
index, provider/model, hashed inference configuration, prompt identity and
rendition hashes/sizes. It contains no credentials, connection URLs, raw provider
envelope or image buffers. These are prepared-request facts, not independent
proof of provider receipt. Plan/request identities do not reset automatic
attempt or per-photo allowances.

## Collection and application boundary

`collectPhotoRefereeComparisons` accepts the validated results in plan order.
It revalidates membership, assessments and context exclusions, and checks the
plan/batch identity. Missing results remain unavailable; malformed or mismatched
ones remain invalid. Valid recommendations from other batches remain inspectable.

A whole-input response can supply a complete partition and all its per-group
recommendations. Separate comparisons cannot establish a global partition or
promise cross-batch duplicate elimination. Their recommendation union is complete
only when every batch is valid and none reports mixed subjects. No accepted
recommendation is discarded to make one global winner. An incomplete or mixed
batch plan withholds full-stack advice application and launches no extra AI round.

The collector's `canApplyAll` means **structurally complete advice**, not authority
to change photos. The worker and decision service must still verify current
membership, input revisions, coverage, settings and human intent. The collector
does not itself save, publish or apply anything.

## Background worker and saved results

The pipeline is deterministic grouping (including optional Pictaria embeddings),
then optional Stack Referee, then optional Photo Referee, then human decisions.
PIC-392 owns embedding evidence and resulting grouping. This contract consumes
membership and never computes embedding similarity or reimplements stacking.

Discovery runs in the existing background tick, without browser demand or an
active Enrich run. It rotates through at most 32 groups plus bounded attention
priorities, then offers individual comparisons to the shared lifecycle. Queued
jobs contain identities and callbacks, never image buffers. A focused comparison
defers new work. Deterministic checks and an enabled Stack Referee must settle;
finished-incomplete checks, supported scope skips and verified size exceptions
retain `incomplete`, `scope-skipped` or `unchecked-size` coverage. Unknown
capability, invalid configuration and shared provider protection still block.

Each scheduled batch preflights the **full comparison's selected previews**.
References appear only in whole-stack requests. Preparation retains only the
current batch's bytes and compact hashes/sizes for the rest. This trades up to three preview
passes for bounded memory without a buffer pool, disk spool or recovery queue.
A 30-photo comparison therefore reads up to 90 previews across its three initial
requests; bounded retries repeat preparation. No originals, resizing or silent
thumbnail fallback are used. Each preflight has a 30-second deadline, and the
real Immich client limits response bytes while streaming. Same-size changed
images are detected by hashes, not merely by their byte lengths.

One batch consumes one shared scheduler turn. Existing settling, two attempts
per exact input, actionable-photo churn limits and provider guards apply.
Temporary preview failures get at most two preparations per input and a shared
three-minute role pause; permanent/unusable previews settle immediately. Three
distinct comparisons with model rejection or malformed answers pause Photo
Referee for that model configuration. Multiple batches of one stack count as
one comparison for this pause. A successful accepted recommendation clears the
streak; Stack Referee and Enrich remain independent. Protection survives restart
and role toggles.

Validated batches occupy one versioned `curate_advice` record for the pending
scope, capped at 64 KiB. Shared approved context is not indexed as owned
membership. The record contains the plan, applicability snapshot, validated
answers and compact provenance; it contains no image buffers, credentials,
connection URLs or raw provider envelopes. Partial advice has no fabricated
generic/global result. Its applicable input accounting remains protected from
retention cleanup.

Acceptance rechecks all source members, human state, availability, context,
nearby changes and the grouping boundary inside the executor transaction.
Adding a photo or changing a human decision during inference discards the stale
answer. Role-off stops new work but allows an already-paid, still-applicable
answer to be saved. Completed advice is reused across restart and model-setting
changes. Partial advice resumes only missing batches with the same configuration
and full rendition plan; changed configuration or bytes leave it inspectable
but incomplete, without automatically replaying accepted comparisons.

The page API adds `photoRefereeActivity` and compact per-group `photoReferee`
status. Comparisons add `photoRecommendations`, projecting coverage, current
recommendations, per-photo assessments and valid partitions with the saved provider/model name but without internal
snapshots, connection details or hashes. Decided photos receive no recommendation payload. Pending
prerequisites disable structural full-set application. These fields do not grant
decision authority or overwrite open memberships and draft choices.

## Recommendations in Curate Preview

The PIC-371 grouping badge remains independent of the Photo Referee. Complete
advice supplies a gold star with the number suggested. A valid empty set reads
“none suggested”; missing, invalid or mixed batch output never means none.
The Why panel includes the comparison coverage, concise group reasons and
saved provider/model. Every inspected valid batch provides per-photo reasons;
the lightbox shows the full assessment. Model text is rendered as text.

Opening a new pending comparison seeds an untouched draft only when its advice
is complete and applicable: suggested photos start at **Yes**, the others at
**Skip**. Saved human outcomes take precedence. Partial/mixed batches and advice
awaiting a prerequisite are inspectable but do not seed choices. Recommendations
arriving while a comparison is open never change its draft; the page says to
reopen it to inspect them. Zero suggestions never silently reject any photo.

**Save** and **Save & next** remain explicit human confirmation of the displayed
four-way outcomes, using the existing comparison-material, human-state and
idempotent operation guards. There is no automatic advice-application endpoint
or new decision mode. People can change any suggestion to Yes, Skip, Fav or No,
including preserving several suggestions or none. Enter can confirm a draft
with suggested Yes choices; an untouched all-Skip draft still needs an explicit
button click or mark. Undo uses the existing decision operation.

Undo also restores the applicability of already accepted recommendations when
the original photo, context and comparison evidence still matches. The gold
stars and suggested choices return with the restored stack; there is no new
Photo Referee call or preview download just to undo Save. This works with the
role off and through restart, for whole comparisons, split children and saved
batches. An incomplete comparison resumes only its missing batches.

The decision receipt's private before-state records the prior human signature.
Successful Undo checks the restored tags and renews only accepted advice in the
same transaction. The original request snapshot, provenance and accounting are
unchanged. Human revisions still advance, so a request in flight during Save
and Undo remains stale. New/changed photos, references, separations and newer
human decisions are not forgiven by Undo. Older receipts without this
before-state still undo human choices but cannot renew advice applicability;
no database migration or repair queue is added.

## Publishing Photo Referee splits

A complete whole-input response can split an existing deterministic/Stack
Referee group at the next stable-view refresh. It never joins groups, publishes
transport batches as stacks, or includes reference-only groups. Each resulting
group reads its own keeper set and assessments from the original accepted
comparison. Neither referee recursively evaluates these children. A Photo
Referee split is explained as such; it does not claim the Stack Referee ran.

Saved partition evidence checks every original member's source, availability
and human separation, plus the selected references. A new member joining the
source group or changed evidence invalidates the partition. Human decisions
may subtract members without undoing the split; recommendations on an untouched
sibling remain useful. Recommendations require unchanged human state on their
own pending members. A partially decided child falls back to manual review
rather than manufacturing a new keeper judgment. The original paid input
accounting remains protected while its recommendations are usable.

Existing open comparisons retain their membership and drafts and report that
a newer grouping is ready. Partial or mixed batch results never publish a
global partition. Off stops new calls and does not erase accepted results.

## Test-instance rollout

1. Before installing, turn **Photo Referee** off in Settings → Curate if it is
   already checked. Older builds permit saving an off preference even while
   the worker is unavailable. Use the normal backup/update process. For an
   isolated preview test, leave **Current-page AI referee** off as well.
2. After installing, confirm the effective Curate provider/model and that Photo
   Referee is available but still off. Inspect the existing pending groups and
   decisions. No new enrichment or embedding backfill is needed.
3. With Stacks on, enable **Photo Referee**. First test with Stack Referee off,
   then with it on if testing the full pipeline. Photo Referee runs after
   deterministic grouping and any enabled Stack Referee checks settle. Work
   covers eligible pending stacks throughout the library, not only visible
   cards; no open browser is required. Observe activity, gold stars/counts,
   reasons, draft suggestions and labeled batch/incomplete coverage in
   `/curate-preview.html`.
4. After a few results, turn Photo Referee off. New preparation, submission and
   retries stop; an already-submitted valid response may still finish. This
   is an observed session, not an exact request cap. Record requests including
   automatic retries, and confirm accepted results remain available. An open
   draft and human decisions must remain unchanged until an explicit Save.
5. Check restart reuse, then manually exercise Save and Undo as desired. Report
   the exact commit and configured provider/model with any unexpected behavior.
   Keep photos, raw model responses, identities and credentials private.

These checks are still required for runtime acceptance. Legacy-referee removal
and default-page cutover remain PIC-372 work; this build keeps the preview page.

The [shared AI guide](CURATE-AI.md) and
[Stack Referee guide](CURATE-STACK-REFEREE.md) describe the existing runtime.
No new queue, repair mechanism, database migration or provider transport is
introduced by this increment.
