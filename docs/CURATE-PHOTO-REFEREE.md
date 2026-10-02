# Photo Referee implementation

The Photo Referee recommends the best photos within the stacks produced by
Curate. It is independent of the optional Stack Referee and uses the same
shared Curate provider/model settings. Recommendations are advice: only a human
decision marks a photo Yes, Skip, Fav or No.

## Current delivery

PIC-116 adds the request/result contract, bounded comparison planner, background
worker and saved-result/API integration. **Photo Referee remains unavailable in
Settings.** Server availability still prevents its requests, regardless of the
saved preference. Tests explicitly enable the worker with synthetic transports.
The released `/curate.html` referee is unchanged.

Recommendation UI, publication of whole-input grouping corrections and
controlled test-instance acceptance remain before activation. This increment
stores proposed partitions but does not publish them as new stacks or change
human choices.

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

`planPhotoRefereeComparisons` accepts chronological pending membership, at most
eight already-kept references, an explicit provider/model-bound capability and
a complete rendition-size inventory. It preserves pending order. At least two
pending alternatives are required; a sole newcomer with context remains manual.

Use one whole-input comparison when it fits. Otherwise use at most three balanced
chronological comparisons. With the current ten-image request ceiling, eleven
pending photos become 6/5 and thirty become 10/10/10. Each request still contains
at least two pending photos; no singleton remainder, padding, truncation,
tournament or final winner cap is introduced. These are transport batches, not
new visible stacks.

The complete plan is limited to thirty submitted images, 2 MiB per rendition and
24 MiB aggregate raw image bytes. Read-only context is repeated in each batch and
counts each time toward the aggregate image/byte limits. It does not consume
the actionable-photo churn allowance. If context leaves an unsupported layout
or exceeds the plan limits, the comparison stays manual; it is not silently
dropped. Missing sizes, unknown capability and unsupported layouts do not create
a ready plan. The current capability resolver grants bounded attempts through
the seven existing multi-image adapters; it is not a model-quality guarantee.

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

Each scheduled batch preflights the **full comparison's previews**, including
repeated-context image/byte accounting. It retains only the current batch's
bytes and compact hashes/sizes for the rest. This trades up to three preview
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
recommendations, per-photo assessments and valid partitions without internal
snapshots or hashes. Decided photos receive no recommendation payload. Pending
prerequisites disable structural full-set application. These fields do not grant
decision authority, change stable view membership, or overwrite draft choices.

## Integration still required

Before activation:

1. Publish complete whole-input grouping corrections at the stable-view boundary
   and reuse their per-partition recommendations without recursive referee work.
   Partial or mixed batch results must not fabricate a global partition.
2. Connect visible Photo Referee states, recommendation markers and explanations.
   Preselect only untouched drafts, preserve all accepted recommendations and
   human edits, and bind any advice action to current applicability and intent.
3. Run UI and controlled test-instance acceptance with the configured provider.
   Synthetic worker tests do not establish model quality or live performance.
   Keep legacy-referee removal and default-page cutover with PIC-372.

The [shared AI guide](CURATE-AI.md) and
[Stack Referee guide](CURATE-STACK-REFEREE.md) describe the existing runtime.
No new queue, repair mechanism, database migration or provider transport is
introduced by this increment.
