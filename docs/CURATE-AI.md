# Curate AI integration

## Current implementation

The reviewed human workflow and candidate stacking algorithm are available in
[Curate Preview](CURATE-PREVIEW.md). Optional AI stack checking and keeper
recommendations have not yet been connected to that workflow. The existing
`/curate.html` referee continues to use its released prompt and result format.
That unchanged request/schema/normalization contract now lives in
`src/enrich/referee-contract.mjs`, shared by the legacy worker and the offline
baseline evaluator. The evaluator pins the contract hash rather than freezing
the worker's shutdown and scheduling implementation.

PIC-345 begins the shared configuration groundwork in
`src/curate/ai-config.mjs`. At job start, `createCurateAiProvider` selects the
current Enrich provider unless `curateRefereeProvider` overrides it, then applies
the optional `curateRefereeModel`. Clearing the overrides returns to the current
Enrich selection. No photo's historical enrichment model selects the provider.
The adapters validate their configuration; an invalid explicit selection does
not silently fall back to another provider.

Each job owns its provider instance, including the selected model, endpoint,
credentials and inference settings. Changes in Settings apply to the next job.
The helper does not mutate Enrich's configuration or enable either AI role.
Provider instances contain credentials and stay in memory; they are not job
records or public status objects. The legacy referee retains its minimum
20-minute request timeout, preserving any longer configured timeout.

The legacy referee now checks Stacks, its existing enable switch, Enrich,
pause/shutdown and whether Enrich is running before preparation, between
downloads (including fallback renditions), and before provider submission.
Stopping during preparation creates no verdict, failure or size deferral. A
submitted request can finish; its result keeps the provider/model actually used.
The existing worker retains its Enrich dependency until the new runtime replaces
it. This change does not activate AI on the preview page.

## Settings and scope (PIC-345)

Settings → Curate now distinguishes the two preview roles from the existing
page's referee. Each role has its own switch. Both default off on a fresh
installation; neither new role depends on Enrich being enabled. Turning Stacks
off pauses the dependent controls without erasing their choices. The shared
provider and optional model override apply to both roles and the existing
referee. The existing referee's control and status are under **Current Curate
page** and keep their existing Enrich dependency.

The preview workers are **not connected yet**. Their controls say so, and the
API rejects newly enabling an unavailable worker, including clearing an override
that would enable it through environment fallback. Saved on preferences may be
turned off before integration; saving unrelated settings preserves them.
An unsaved opt-out can be reversed; once saved off, it cannot be enabled until
the worker is available. The saved-preference notice appears only for an on
preference. Availability comes from server composition, not user settings or an environment
switch. An on preference is not reported as an active worker while unavailable.

`CURATE_STACK_REFEREE_SCOPE` ignores surrounding whitespace and letter case.
Blank values use `uncertain`. Invalid environment values warn without echoing
the supplied value and fall back to `uncertain`; they neither block startup nor
enable AI. Invalid values submitted through the Settings API remain rejected.

When the Stack Referee is enabled, its scope is:

- **Uncertain stacks (recommended):** compositions that remain unresolved after
  deterministic checks settle. This includes terminal incomplete similarity and
  budget-limited compositions, subject to the worker's separate request limits.
  A supported candidate does not become uncertain simply because a people tag
  or another optional fact is missing.
- **All stacks:** also checks supported pending compositions. This costs more AI
  calls and uses the same prompt, provider, validation and result handling.

Both scopes exclude singles, decided history and a stack with a still-current
valid AI check (including a split result). Both wait for outstanding deterministic
work. Changing scope does not change the deterministic grouping algorithm, clear
similarity evidence, change human decisions or rerun valid advice.

The shared selection helper in `src/curate/ai-policy.mjs` implements this scope
contract but does not submit requests. `candidate-supported` is the current
algorithm's support classification; under **Uncertain stacks** it is skipped as
a deliberate cost/coverage choice. It is **not** a guarantee of correct grouping,
an AI check, or a validated exact-image bypass. Unsupported/unknown routes stay
eligible rather than guessing from explanatory text or UI icons. The future
worker must provide current membership, decision and settled-check facts, then
separately enforce provider limits, pause state, budgets and revision validity.

This selective policy is the September 24 owner-approved refinement of the
earlier check-every-group plan. Missing evidence alone should not create an
unbounded repair/retry workflow. Humans can curate provisional stacks.

## Upgrade and rollback

Settings version 8 / persistent-state contract 23 preserve the previously
**effective** keeper preference. During upgrade, if there is no explicit new
Photo Referee setting or nonempty environment preference, the old referee setting is
copied only when both Enrich and Stacks were enabled. The resulting true **or
false** is saved once. Saved overrides take precedence over environment defaults. Empty environment
forwarding (as in Compose) is treated as unspecified; use `false` to opt out.
A later Enrich toggle or restart cannot reinterpret a dormant legacy preference.
Stack Referee defaults off. Existing legacy settings are retained separately;
no historical verdict becomes current preview advice and no AI work starts here.

The standard pre-migration recovery point retains the original settings and
application state. Older builds cannot read version 8 settings; rollback uses
that recovery point on the matching earlier build, not an in-place image-only
downgrade. Synthetic upgrade/restart/restore tests cover this path.

## Durable attempt admission groundwork (PIC-346)

`src/curate/ai-attempts.mjs` stores compact per-role, per-input accounting in
Enrich's existing SQLite database. `src/curate/ai-execution.mjs` adds a shared
execution boundary for future workers. Neither is connected to a live worker;
the preview availability flags remain false. This is a partial implementation
of PIC-346, not the complete AI lifecycle.

- A request has at most two charged invocations: an initial invocation and one
  possible retry. The scheduler must explicitly admit each one. This executor
  never retries by itself. A digest must cover the exact role-relevant input,
  model/configuration and request contract; the adapter owns that construction.
- Role enablement, Stacks, shutdown, current inputs and the external admission
  guard are checked before preparation and immediately before dispatch.
  Preparation adapters receive a checkpoint for use between downloads and
  before fallbacks. Enrich's master switch is not a gate for these new roles.
- The external guard is mandatory, read-only and defaults to deny. It checks
  provider pauses and an already-reserved revision/cohort budget and scheduling
  turn; repeated checkpoints must not make repeated reservations. Merely declaring
  a worker available is insufficient to start a request.
- The attempt is charged immediately before one provider invocation. Crash
  uncertainty keeps the charge, including a crash immediately before dispatch.
  Counts are conservative admission records, not transport or billing metrics.
  Normal repository opening never releases running work. Startup recovery is
  explicit and must happen only after exclusive server ownership is established.
- A persisted running marker prevents simultaneous Curate submissions across
  both roles. One executor also serializes preparation. This is not fair
  scheduling with Enrich or a cross-process background worker system.
- Already-submitted work may finish after a toggle is disabled, if it remains
  applicable. Input changes invalidate it. Strict validation and synchronous
  acceptance happen before success is recorded; acceptance and accounting share
  one database transaction. A stale completion token cannot finish newer work.
  Dependent work needs fresh admission; the executor creates none.
- Only the role, input digest, attempt count, state and current ownership token
  are stored. No raw responses, errors, credentials or photo metadata are stored
  in this ledger. Completed exact inputs cannot be submitted again. No pruning
  or retry-reset API is provided in this slice.

The accepting adapter must use the authoritative repository's applicability
validation, including human decisions and availability. It must not perform
asynchronous writes inside the acceptance transaction. One `submit` callback
must make exactly one provider invocation; validation retries belong to a new
admitted invocation rather than an internal retry loop. Preparation failures
return without a paid attempt and must not be automatically looped by an adapter.
An asynchronous validation/acceptance callback is reported as `adapter-error`,
not a bad model answer. The already-dispatched request remains charged. Handle
this as an integration fault before admitting more work; it is not evidence of
a provider outage. Rejecting an asynchronous acceptance callback cannot cancel
its own later side effects, so acceptance adapters must stay synchronous.

Enrichment schema version 19 / persistent-state contract 24 adds the ledger.
The normal upgrade recovery point is taken first. Existing settings and
human decisions are untouched. Rollback to the earlier schema requires restoring
that recovery point. Synthetic tests cover upgrade, restart, backup and restore,
including a preserved consumed attempt.

## Remaining integration

- **PIC-345 / PIC-372:** connect availability to the actual workers and complete
  the cutover and live migration acceptance. This settings slice does not replay
  decided history or establish eligibility for historical referee results.
- **PIC-346:** connect provider pauses, aggregate revision/cohort budgets,
  settling/coalescing, current-input construction, bounded retention and the
  authoritative applicability adapter before enabling either role. Provider-internal
  validation retries must also be accounted for; the legacy safeguards above are not that new lifecycle.
- **PIC-118:** fair scheduling on shared backends, with independent backends able
  to progress concurrently. The legacy worker still yields to Enrich.
- **PIC-370 / PIC-116:** validated whole-stack composition checks, then keeper
  suggestions using the accepted production quality criteria and multiple
  keepers. Human choices always win. Finished incomplete checks may leave
  eligible suggestions clearly labeled; unfinished checks still wait.

Keep these stages inside the existing provider transports and Curate records.
Do not introduce a second active worker for the same legacy referee queue or a
permanent parallel grouping pipeline. Default-page cutover and release acceptance
remain separate from this configuration groundwork.

### Public names and compatibility

The two optional roles are **Stack Referee** (checks stack composition) and
**Photo Referee** (recommends the best photos within a stack). Recommendations
do not discard photos; the user makes the final decisions. Existing internal
`keeper` role identifiers and `CURATE_KEEPER_REFEREE_ENABLED` remain unchanged
for settings and storage compatibility.
