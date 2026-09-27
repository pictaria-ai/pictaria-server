# Stack Referee implementation

The Stack Referee checks whether the photos in a proposed stack are useful
alternatives of substantially the same subject and composition. It can retain
the stack or split it into smaller stacks and singles. It does not select photos,
mark anything Yes/Skip/Fav/No, or write tags to Immich. The separate Photo Referee
will recommend photos within the resulting stacks.

## Current development state

PIC-370 has started with the request/response contract in
[`stack-referee-contract.mjs`](../src/curate/stack-referee-contract.mjs).
This module is exercised with synthetic providers through the existing scheduler,
changing-input lifecycle, executor and advice validator. It is **not connected to
background discovery or the review page**. Both new AI availability flags remain
false; this change alone submits no requests and changes no stacks.

The [shared AI guide](CURATE-AI.md) defines scheduling, settings, attempts and
human authority. The following agreed behavior remains the integration target:

- An independent optional switch, off by default; no prerequisite Enrich run.
- **Uncertain stacks** by default, or **All stacks** using the same request path.
  A supported composition skipped by scope is not labeled AI-checked.
- Start after deterministic checking settles. Prioritize upcoming comparisons
  while keeping the comparison currently being inspected stable.
- Retain applicable results, including split children, without recursively
  checking them again. Publish membership changes through the existing stable
  view/update mechanism.
- Respect the existing two-attempt limit and provider/photo safeguards. After
  bounded failure, retain the usable grouping and a quiet explanation. No repair
  queue or routine Retry control.
- Whole-input checking only. A stack too large for the confirmed model limit
  stays manually reviewable; independent request chunks cannot prove a global
  partition. The agreed, labeled Photo Referee exception remains separate.

## Grouping instructions

The versioned `curate_stack_check_v2` prompt builds on the dedicated grouping
prompt evaluated during the Curate prototype, with an explicit distinction
between composition and photo quality:

- Different main subjects, solo versus couple compositions, and substantial
  scene/composition changes justify separation.
- Different expressions, small pose changes, camera orientation or modest zoom
  alone do not require separation when the photos remain alternatives of the
  same subject/composition. Incidental background people alone do not change
  the main subject.
- Blur, closed eyes or poor lighting do not by themselves split alternatives;
  choosing the better photo belongs to the later review.
- Return one exhaustive, disjoint partition, including singles, with a short
  visible reason per group. Reasons describe the scene without referring to
  photo IDs; aliases belong only in membership arrays. No names, keeper
  selections, ranks or human decisions. Version 2 adds this reason wording;
  rendering must still treat model text as untrusted.

These are model instructions, not a deterministic guarantee of visual quality.
The new wording still needs evaluation on the approved real-photo cases after
the integrated worker is ready. Synthetic tests establish membership and runtime
contracts, not the correctness of a model's visual judgment.

## Request and response boundary

`stackRefereeSupport` requires explicit server-supplied comparative capability
and an image limit matching the resolved provider and model. The presence of an
`analyzeImages` method or a successful single-image connection verification is
insufficient. Unknown capability cannot submit a request. This slice does not
implement a capability registry, discovery probe or user override.

The contract and lifecycle share an overall 30-photo automation limit. Larger
current stacks return `input-limit` / `too-many-images` with `limit: 30`, including
31–40-photo candidates and larger manual fallback groups. They do not throw a
batch-validation error or masquerade as stale inputs. The full human comparison
remains usable; smaller Photo Referee batches do not expand this total scope
limit. A missing or no-longer-current group still returns `stale`.

Within that envelope, exceeding a confirmed model limit remains
`unsupported-size`, distinct from unknown capability or the overall scope cap.
The future worker must check capability and size **before offering work** and
retain a settled outcome so rediscovery does not repeatedly prepare/download
unsupported stacks. Only a confirmed model-size limit within the overall
envelope qualifies for the separate labeled Photo Referee batching exception.

`createStackRefereeRequest` takes already-prepared images inside the lifecycle's
preparation phase. It enforces 2–30 images, 2 MiB per image and 24 MiB total raw
bytes, as well as the confirmed model limit. It never pads, truncates, batches,
downloads or falls back. The worker must also enforce these limits while fetching
and preparing renditions; this in-memory boundary is not a download limit.
JPEG, PNG and WebP are accepted; LM Studio must receive an already prepared
JPEG/PNG to avoid an unbounded conversion inside its transport.

Requests contain only image bytes and fixed grouping instructions with positional
aliases (`p1`, `p2`, …). Asset IDs, captions, tags and recognized-person metadata
are not forwarded as prompt text. Prepared bytes are copied before hashing and
submission. The returned provenance includes ordered rendition hashes, byte
counts/MIME types, provider/model, prompt/contract identity and a hashed inference
configuration; it excludes connection credentials and raw responses. It describes
the prepared request, not an independently observed provider receipt.

Each `submit` invocation calls the pinned provider once. The shared executor owns
attempt accounting and retries; no Enrich validation-retry wrapper is used.
`validate` runs separately against the model's normalized JSON using the existing
exhaustive-partition validator. Duplicated, omitted or invented IDs and unexpected
keeper/rank fields are rejected. Only valid aliases are mapped back to asset IDs.
Member and group presentation order are normalized to input order without
repairing membership. The model's concise reasons are returned as untrusted
display text for the existing escaped rendering path.

The request fingerprint is provenance, **not** a replacement for the lifecycle's
input/attempt key. Changing the model or request byte identity must not silently
reset an unchanged input's automatic allowance.

## Next integration slice

Connect model-capability resolution and bounded preview preparation to current
stack discovery; persist compact accepted partition/provenance and terminal
per-input outcomes; apply still-current partitions during regrouping; and expose
the existing working/checked/limited-evidence states in the UI. Include restart,
split-child reuse, stale-input, toggle, request-limit and human-view stability
coverage before turning on availability. Scope selection, open-comparison
deferral and next-five priority should reuse the shared policy and lifecycle.

Preparation failures and unsupported inputs also need a settled outcome at the
worker boundary so rediscovery cannot repeatedly prepare the same failing stack.
No new paid validation or deployment is part of this contract-only slice.

Before activation, verify the following with approved real-photo inputs and
the actual provider/model paths we intend to support:

- A non-contiguous partition with 20–30 images where the confirmed model limit
  permits it. Valid membership JSON does not prove correct image-to-alias
  association. Never exceed a known model limit to satisfy this gate; a smaller
  test does not close the large-input gate. If positional association proves
  unreliable, evaluate labels interleaved with individual images.
- Actual schema acceptance, especially OpenAI strict Responses and
  OpenRouter/Gemini schema projection, including the reason's `minLength`.
  Mock transport tests do not establish provider acceptance, and a successful
  compatibility call does not establish visual grouping quality.
