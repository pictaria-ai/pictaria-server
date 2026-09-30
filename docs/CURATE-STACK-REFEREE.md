# Stack Referee implementation

The Stack Referee checks whether the photos in a proposed stack are useful
alternatives of substantially the same subject and composition. It can retain
the stack or split it into smaller stacks and singles. It does not select photos,
mark anything Yes/Skip/Fav/No, or write tags to Immich. The separate Photo Referee
will recommend photos within the resulting stacks.

## Current development state

PIC-370 now has a request/response contract and a background worker composed with
the existing scheduler, changing-input lifecycle, executor and advice validator.
The worker discovers current groups, prepares bounded previews, saves accepted
partitions and publishes them through normal grouping rebuilds and stable views.
Tests exercise this path with synthetic providers and injected comparative
capabilities. The server now supplies the evidence-based capability resolver
described below; Curate displays its recorded states. **Both production
availability flags remain false.** No new model request or changed stack is
enabled by this development slice.

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
insufficient. Unknown capability cannot submit a request. The worker accepts a
server-owned resolver; without one it returns unknown. The server composes
`refereeCapability` from `src/curate/referee-capabilities.mjs`:

| Provider and endpoint | Exact model | Evaluated request ceiling |
| --- | --- | --- |
| Venice, `https://api.venice.ai/api/v1` | `qwen3-vl-235b-a22b` | 10 images |

This initial entry comes from the PIC-366 evaluation: the hosted model accepted
ten images and rejected thirty. Ten is a conservative evaluated ceiling, not a
claim about the service's absolute maximum. See the
[recorded engineering boundary](../experiments/curate-v13/ENGINEERING-BOUNDARIES.md#3-logical-comparisons-and-provider-requests-are-different).
It establishes a bounded input route, not acceptance of the new Stack Referee
prompt/schema or general grouping quality. Live acceptance and activation remain
pending. No other provider/model is implicitly supported, including local aliases
or compatible endpoints carrying the same model name. A connection check or a
vision catalog flag alone does not add an entry. There is no paid capability
probe, network catalog request, fallback model or user-supplied capability override.

Add future entries only with evidence for the exact provider/model/endpoint,
comparative input size and actual transport/schema behavior. Keep their visual
acceptance separate. The current Curate provider/model selection still follows
Enrich or its existing explicit override; the registry never changes that choice.

The contract and lifecycle share an overall 30-photo automation limit. Larger
current stacks return `input-limit` / `too-many-images` with `limit: 30`, including
31–40-photo candidates and larger manual fallback groups. They do not throw a
batch-validation error or masquerade as stale inputs. The full human comparison
remains usable; smaller Photo Referee batches do not expand this total scope
limit. A missing or no-longer-current group still returns `stale`.

Within that envelope, exceeding a confirmed model limit remains
`unsupported-size`, distinct from unknown capability or the overall scope cap.
The worker checks capability and size **before offering work** and derives the
same status directly for display, without writing a per-stack record or
preparing/downloading unsupported stacks. Only a confirmed model-size limit within the overall
envelope qualifies for the separate labeled Photo Referee batching exception.

`createStackRefereeRequest` takes already-prepared images inside the lifecycle's
preparation phase. It enforces 2–30 images, 2 MiB per image and 24 MiB total raw
bytes, as well as the confirmed model limit. It never pads, truncates, batches,
downloads or falls back. The worker also enforces these limits while fetching
previews, with a 30-second deadline for the complete preparation phase and
checkpoints between images. Downloads are sequential and use the existing Immich
streaming byte reader. The client connection is captured for preparation; a
changed Immich connection makes an in-flight result stale. No originals,
thumbnail fallback or conversion process is used. The image helper never retries;
the worker's bounded temporary-failure policy below controls any later attempt.
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
repairing membership. The model's concise reasons are retained as untrusted
display text for the existing escaped rendering path. A waiting retry retains
only validator metadata, not the previous request's image buffers.

The request fingerprint is provenance, **not** a replacement for the lifecycle's
input/attempt key. Changing the model or request byte identity must not silently
reset an unchanged input's automatic allowance.

## Background work and saved results

- Discovery rotates over 32 current groups per tick, additionally considering
  up to 32 groups with browser attention. It yields between small work slices.
  Unsupported/finished early groups do not prevent later groups from admission.
  Browser attention only changes priority; no browser is needed to discover work.
  Open comparisons defer new requests. The shared lifecycle owns the 30-second
  settling window, two-attempt limit, upcoming-comparison priority and fairness.
- Unsupported capability and oversized scopes are rejected cheaply before
  preparation; their status is derived without a per-stack database record.
- Unusable previews (including HTTP 403/404, excessive bytes or unsupported
  MIME) retain a compact terminal reason in the existing input JSON. Arbitrary
  adapter errors also stop rather than being assumed transient. Repeated
  discovery/restart do not download these inputs again. Changed configuration
  can remove a non-paid limitation without resetting request/photo budgets.
- Temporary preview failures (Immich network errors, HTTP 408/429/5xx and the
  preparation deadline) pause **all Stack Referee preview preparation for three
  minutes**, including already queued work. Normal discovery may then offer the
  affected input once more. A second temporary preparation failure for the same
  input settles it as incomplete and starts the same shared pause, protecting
  other stacks. Manual curation remains available throughout.
- The temporary-failure count lives in existing input JSON; one integer in
  `curate_meta` preserves the shared pause across restart. No new table, timer,
  repair queue or Retry control. Model/scope/role changes do not reset the two
  temporary-failure limit for unchanged inputs. Preparation failures spend no
  model attempt or per-photo charge; existing model retry limits stay separate.
  Shutdown, role-off and stale-input cancellation do not record failures. Raw
  upstream errors and connection details are not stored or exposed.
- Accepted partitions and prepared-request provenance extend the existing
  versioned advice JSON. Save and attempt completion share one transaction.
  Raw responses, image bytes and credentials are not stored. Existing overlap
  replacement and protected accounting cleanup remain in use; no new database
  table or migration is required.
- A read-only grouping worker applies applicable partitions after deterministic
  grouping. It can split a current group but cannot join groups. Existing human
  separations, changed photo inputs and newly joined members invalidate the old
  check. Human decisions can subtract members without rechecking the remaining
  children. Role/scope toggles do not erase an applicable result.
- The deterministic cache retains its own pre-AI groups. It must never learn an
  AI partition as deterministic evidence. Open views retain their original
  membership; the new composition is published for the existing refresh/update
  path. Cards/comparisons expose a separate `stackReferee` status. A current check
  displays a small **AI** badge with **AI checked** hover text, including split
  singles. Queued/running work uses a spinner naming the Stack Referee; temporary
  pauses and finished incomplete checks use a quiet information icon. Unsupported
  models/sizes, preparation failures and provider pauses have distinct plain
  explanations. They do not block human choices or pretend a check succeeded.
- Status polling also reports queued/active referee work outside the visible
  page, through the existing header activity slot. This reports admitted work,
  not an invented remaining-library total. Cards use their existing date/progress
  line, so statuses do not grow them. Open comparisons keep photos and drafts
  while their status changes. Badge applicability checks the saved check's own
  member signatures (including split siblings) and pending nearby source changes,
  rather than the library-wide rebuild generation. Unrelated imports or decisions
  do not hide an unchanged stack's badge during Save & next. Changed inputs,
  availability or separations withhold the badge; replaced memberships cannot
  inherit a new result. Switching the role off retains valid completed checks;
  unchecked groups stay off without changing their explanation during imports.
  Queued or just-accepted checks awaiting a rebuild use the neutral updated state,
  not a failure message. Actual input limits still report an incomplete check.
  Decided photos carry no pending-referee status.
- **Why?** retains the deterministic explanation and adds the applicable model
  reason as plain text. A current checked grouping no longer says that no AI
  check occurred. A changed grouping falls back to the saved-view explanation.
  The Photo Referee star and recommendations remain a separate implementation.

## Before activation

Model capability resolution and recorded-status presentation are connected.
The Photo Referee is a separate implementation. No new paid validation or
deployment is part of this development slice.

Before activation, verify the following with approved real-photo inputs and
the actual provider/model paths we intend to support:

- Measure coverage on the test library after deterministic grouping settles:
  count pending uncertain stacks and photos in the 2–10, 11–30 and over-30 size
  bands, with the percentage of uncertain stacks covered by the registered
  model. Keep pending deterministic work and supported compositions skipped by
  the default scope separate. This is an offline inventory, not extra AI calls;
  report counts only and use it to assess the ten-image ceiling before activation.
- A non-contiguous partition with 20–30 images where the confirmed model limit
  permits it. Valid membership JSON does not prove correct image-to-alias
  association. Never exceed a known model limit to satisfy this gate; a smaller
  test does not close the large-input gate. If positional association proves
  unreliable, evaluate labels interleaved with individual images.
- Actual schema acceptance, especially OpenAI strict Responses and
  OpenRouter/Gemini schema projection, including the reason's `minLength`.
  Mock transport tests do not establish provider acceptance, and a successful
  compatibility call does not establish visual grouping quality.

Start live validation with the registered Venice model at or below ten images,
including a non-contiguous mixed-subject partition and a genuine keep-together
control. The larger 20–30-image gate stays explicitly untested until a model
with a supported envelope can exercise it. Do not raise the registered ceiling,
silently batch a full-stack check, or claim all-provider acceptance to close it.
