# Photo Referee implementation

The Photo Referee recommends the best photos within the stacks produced by
Curate. It is independent of the optional Stack Referee and uses the same
shared Curate provider/model settings. Recommendations are advice: only a human
decision marks a photo Yes, Skip, Fav or No.

## Current delivery

PIC-116's first slice adds a production request/result contract and a bounded
comparison planner. **Photo Referee remains unavailable in Settings.** This
slice does not add a background worker, fetch photos, persist recommendations,
change grouping, launch model requests from the application, or change the
released `/curate.html` referee.

The new modules can be exercised through the existing executor/lifecycle with
synthetic transports. Worker discovery, saved results, recommendation UI and
controlled test-instance acceptance are the next slices, before activation.

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
tags or recognized-person metadata in the prompt. The worker will supply the
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

## Integration still required

The pipeline is deterministic grouping (including optional Pictaria embeddings),
then optional Stack Referee, then optional Photo Referee, then human decisions.
PIC-392 owns embedding evidence and resulting grouping. This contract consumes
membership and never computes embedding similarity or reimplements stacking.

Before activation, the Photo Referee worker must:

1. Discover eligible pending stacks after deterministic work and any enabled
   Stack Referee check settle. Still-pending work waits. Finished-incomplete
   checks, supported scope skips and verified size exceptions retain their
   honest coverage instead of being reported as successful AI checks.
2. Build the full bounded rendition inventory inside controlled preparation;
   do not download a backlog or retain image buffers in queued jobs. Construct
   each request using its authoritative lifecycle snapshot and pinned provider.
   The planner is not permission to bypass role/provider gates or byte limits.
3. Use the existing shared scheduler, two-attempt limit, per-photo allowance,
   provider guards, settling/coalescing and current-input checks. Recheck
   applicability before dispatch and inside acceptance. Late embeddings that
   change membership must invalidate old recommendations through that boundary.
4. Save valid advice/provenance through existing Curate records. A whole-input
   mixed response may propose a grouping correction at the stable-view boundary;
   reuse its complete recommendations without recursively launching referees.
5. Show recommendations separately from human outcomes. Preselect only untouched
   drafts, preserve all accepted recommendations, and keep manual review usable.
6. Validate background operation, restart/attempt persistence, provider failures
   and actual UI behavior before enabling the role. Keep legacy-referee removal
   and default-page cutover with PIC-372.

The [shared AI guide](CURATE-AI.md) and
[Stack Referee guide](CURATE-STACK-REFEREE.md) describe the existing runtime.
No new queue, repair mechanism, database migration or provider transport is
introduced by this contract slice.
