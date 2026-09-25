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
Availability comes from server composition, not user settings or an environment
switch. An on preference is not reported as an active worker while unavailable.

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
Keeper Referee setting or nonempty environment preference, the old referee setting is
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

## Remaining integration

- **PIC-345 / PIC-372:** connect availability to the actual workers and complete
  the cutover and live migration acceptance. This settings slice does not replay
  decided history or establish eligibility for historical referee results.
- **PIC-346:** persisted attempt/admission budgets, provider pauses and result
  applicability for the new roles. Provider-internal validation retries must
  also be accounted for; the legacy safeguards above are not that new lifecycle.
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
