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

The legacy referee checks Stacks, its existing enable switch, Enrich and
pause/shutdown before preparation, between downloads (including fallbacks),
and before provider submission. It retains the released rule of waiting for
the active Enrich run to finish, even on an independent backend. One burst's
photos can arrive non-contiguously; judging a partial stack would pay for it
again when later members arrive. This temporary readiness rule remains until
the new runtime replaces the legacy worker. A queued legacy group is also
rechecked against pending groups before preparation. Stopping during
preparation creates no verdict, failure or size deferral. A submitted request
can finish; its result keeps the provider/model actually used. Shared scheduling
prevents overlap if a new Enrich run starts during an already-submitted legacy
request on that service. Neither new preview referee is activated here.

## Shared request scheduling (PIC-118)

One server-owned `AiRequestScheduler` is shared by Enrich, the legacy referee,
and the single `CurateAiExecution` instance composed for both future roles.
Scheduling only admits work that its worker considers ready; it does not remove
the legacy referee's wait-for-Enrich rule above. For the new roles, ready work
on a shared resource gives Enrich a turn of **up to ten provider calls or
five minutes, whichever comes first**, followed by one Curate call when it is
waiting. A Curate call is one Stack Referee request or one Photo Referee batch,
not a multi-call chain. These values are internal constants, without Settings
or environment overrides. With no competing eligible work, continue without
artificial pauses.

A turn starts when Enrich first obtains the resource. It spans the intervening
per-photo downloads and local persistence, so those short gaps do not turn
ten calls into one. An already-used turn is not reset when Curate arrives.
At the time threshold, stop starting further Enrich calls; never abort a call
already running. If Enrich is between calls, the deadline releases the resource
without waiting for another photo to become ready. A slow call can exceed
five minutes, so this is not a maximum user wait or an inference timeout.
A completed/cancelled run releases unused time. A failed call also releases
the turn before validation/overload retry work or retry sleeps. Every retry
must reacquire a scheduling turn; it cannot hold the resource through backoff.
Waiting time is outside the measured provider-analysis duration.

Once the preview referees are connected and enabled, an Enrich run on a shared
backend will take longer while eligible Curate work is waiting: each Enrich
turn yields to a multi-photo AI call. This can be noticeable on slow local
models. It is the tradeoff for Curate making progress during a long Enrich run;
an independent backend or no eligible Curate work avoids that contention.

Resource identity comes from the actual pinned adapter's HTTP(S) origin.
Different models, API paths or credentials on that origin are not assumed to
have independent capacity; common loopback aliases are normalized. Different
origins may run concurrently. This cannot discover shared hardware or quotas
behind distinct proxies/host aliases. The resource digest is separate from the
credential-sensitive durable provider-pause digest. No endpoint, credential,
photo metadata or model response is included in public scheduling status.

Curate has at most one active scheduling turn across both roles/backends.
Among ready Curate sessions, at most two preferred comparisons can precede
the oldest waiting session. Role workers own discovery and selection of upcoming
comparisons; the shared lifecycle below handles settling, coalescing and open
comparison attention. It uses a 30-second settling delay and current-input validation,
without inspecting the remaining Enrich queue to predict future stack members.
Longer Enrich turns may reduce repeated judgments when related photos arrive
together, but do not prove a stack is complete. Some repeated work is an accepted
tradeoff for simpler scheduling. Dispatched calls still consume the existing
attempt/per-photo allowances, so a later stack revision may receive no fresh AI
advice if its allowance is exhausted; human curation remains available. The
arbiter does not discover groups or enqueue AI work itself.

Enrich and the existing Curate page distinguish waiting for an AI turn from
running inference. A settings change rechecks queued role controls but does not
move a pinned request to another resource. Shutdown cancels queued work and
boundedly drains active work without preemption for fairness. Scheduling queues
are deliberately in memory; durable attempts and provider protection remain
separate. Restart does not reset their ledgers; recovery requires exclusive server ownership as described below.

The server also shares durable provider protection with Enrich and the legacy
referee, with explicit verification in Settings → AI Providers. It recovers
interrupted work only after exclusive database ownership. Availability of both
preview roles remains false: the role adapters and their activation acceptance
still precede real requests.

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
  the scheduler’s turn. When connected, `CurateAiLimits` separately checks
  provider pauses and photo allowances; repeated checkpoints do not charge calls. Merely declaring
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
  in this ledger. Completed exact inputs cannot be submitted again. The limits
  layer adds explicit obsolete-record cleanup; there is no per-stack retry-reset
  API.

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

## Bounded provider and photo limits (PIC-346)

The September 25 policy replaces the earlier prototype cohort budget with a
per-photo allowance. `CurateAiLimits`, supplied to the **one shared** executor,
charges each actionable photo at most three times per referee in a rolling
30 minutes. Retries count, including timeouts whose upstream outcome is unknown.
The separate limit of two invocations per unchanged role/input still applies.
Already-kept read-only context does not consume that allowance: reusing the
same references must not deny advice to unrelated stacks. Each Photo Referee
batch charges only its actionable members, not references or other batches.
Model/backend changes do not create a fresh allowance for the same photos.
`photoIds` lists **all** submitted photos; `contextPhotoIds` identifies a unique
subset of at most eight already-kept references. At least one actionable photo
must remain, and the total envelope still includes context (at most 30 images
and the separate provider/byte limits). The authoritative role adapter supplies
and validates this distinction; it is not a client-supplied exemption. Context
remains part of the exact-input identity and read-only in the result contract.

Exact attempt, photo charges and provider ownership are admitted in one SQLite
transaction immediately before dispatch. Checking admission during preparation
is read-only. A comparison denied by its photo limit is durably settled without
AI; expiry, restart or refresh does not make that same input eligible again.
There is no timer, retry loop, repair queue or per-stack reset in this layer.
The scheduler may consider genuinely changed eligible input after settling.

Provider protection uses an opaque digest of the pinned adapter's normalized
endpoint and credentials. Different models on that same connection share the
pause; independent connections can continue. This failure identity is not proof
that different credentials use independent hardware: PIC-118 must arbitrate the
actual shared resource separately. Neither secrets nor URLs are saved.
The first authentication failure pauses the connection. A temporary failure
waits at least 30 seconds, respecting a longer Retry-After, then allows **one**
recovery request. If that request also fails temporarily, stop the current run
and cool down for **15 minutes**, respecting a longer Retry-After. The next
ordinary eligible request may check recovery; another temporary failure renews
that longer cooldown. Only a successful response returns to normal throughput.
Expiry itself does not dispatch work, restart a stopped Enrich run, refund an
input attempt or revisit a settled comparison. A successful response, even one
with invalid answer content, proves connectivity and releases the guard;
invalid answers retain their input attempt charge. Unknown transport faults
pause as configuration/integration failures instead of walking the rest of the
queue.

`providerStatus()` exposes only ready/busy/cooldown/recovery-ready/paused and a
fixed reason. Unconfigured Settings targets and Enrich show a neutral **Not configured**
state, separate from runtime failure pauses. Cooldown messages show the deadline
in the browser's local timezone. Enrich and the legacy referee surface pauses
and explain when the next eligible request can check recovery. Settings → AI Providers shows the selected Enrich and Curate
connections, plus other configured providers available to per-run Enrich
choices, with **Verify connection**. Verification is one scheduled request using
a synthetic PNG and small JSON answer, with the saved provider's inference timeout. It may incur a
provider charge, uses no library photos, and checks basic vision/structured
output connectivity, not multi-image quality or the full Enrich/Curate contract.
Settings must be saved first. Queued verification cancels if those saved inputs
change. Only one verification can wait/run at once; it shares scheduling and
cannot bypass an active owner or an unexpired cooldown. Page/status reads and
settings saves never send test requests.

Verification owns a fresh provider token, so an old success cannot clear a newer
failure. It can explicitly cross a terminal pause. A temporary failure or
interruption while verifying an authentication, configuration or legacy interrupted pause leaves
that original pause in place; it cannot silently enable automatic work. A
temporary verification failure on a connection without such a pause starts the
15-minute cooldown. Explicit verification must pass its small response contract
to clear a pause; a rejected or malformed test shows a configuration/format
warning and stays paused. Ordinary malformed photo/stack answers still do not
pause the provider. The former blind `connectionVerified()` reset hook is
removed. Verification neither refunds
allowances nor enqueues settled inputs. A stopped Enrich job stays queued and
must be run again. Newly eligible legacy work uses its normal polling/backoff;
there is no special repair queue.

Only the exclusive server owner may call `recoverInterrupted(attempts)` before
starting either role. It keeps all charges. An interrupted ordinary request
enters the normal 30-second cooldown and gets at most one recovery request;
an interrupted recovery request enters the 15-minute cooldown. Cancellation and
graceful shutdown during recovery use the same longer cooldown. An interrupted
verification of an authentication/configuration pause retains its original reason.
Repeating startup neither moves that deadline nor refunds attempts. Opening another repository does not
steal live work. `pruneObsolete()` accepts
up to 200 input identities that the lifecycle owner has established are no
longer current/queued or referenced by comparisons, Undo or advice. It waits
out the 30-minute window, never removes a running attempt, and deletes expired
photo charges in bounded passes. No elapsed-time scan may retire current exact
inputs. Paused connections persist; idle healthy guard rows can be discarded
safely. Older attempt rows without age evidence are retained conservatively.

Schema 20 / persistent-state contract 25 adds these compact tables. Upgrade,
restart, backup and restore preserve charges, pauses and settled limited inputs.
Use the pre-migration recovery point for rollback to an older schema.

### Live connection protection and startup

`AiConnections` connects the same durable provider row to server-managed Enrich
and the legacy referee. Ownership starts immediately before each provider call,
after scheduling, and ends before local answer validation. The first shared
failure stops further affected work. Authentication (401/403), unsupported
endpoint/model routing (404/405), and unknown adapter/configuration failures
pause immediately. Ordinary request-specific 400 rejections and malformed model
answers do not globally pause the connection. Model-answer parsing reports a
fixed diagnostic without raw response fragments.

For Enrich 429/503 responses, the existing cancelable same-photo wait follows
the shared cooldown and permits just one recovery request when the wait is at
most five minutes. A longer Retry-After ends the run immediately and retains its
queue item; the connection still honors the full provider deadline. Other shared transport failures stop the run;
the next eligible real request after cooldown can be the one recovery attempt.
If recovery fails temporarily, the run stops without waiting out the new
15-minute (or longer provider-requested) cooldown. A run whose first request is
already the recovery request likewise stops on that failure. After cooldown,
the next manual run, daily scheduled run or eligible referee request can check
recovery normally. A stopped daily run is not automatically restarted that day.
New ordinary Enrich runs do **not** bypass authentication or configuration pauses.
Legacy terminal paused/interrupted rows also require explicit verification:
earlier code discarded their original reason, which could have been an auth or
configuration pause being verified. New interruptions preserve that reason.
Earlier preview records marked paused/unavailable
use their recorded failure time plus 15 minutes, so upgrading/restarting does
not renew the delay; no schema migration is needed.
Untouched photos receive no failed processing record; dispatched infrastructure
failures do not consume their content-failure allowance. Independent connections
remain eligible. The standalone Enrich CLI retains its existing retry policy;
these shared protections belong to the single server runtime.

Before pre-migration backup or opening/recovering application state, the server
claims a separate SQLite lifetime lock next to the canonical Enrich database:
`<database-path>.server-owner.sqlite`. A second server using that path fails
startup, even with a different HTTP port. Normal repository readers and backups
still work. The lock is held until process exit, including bounded shutdown when
an old request has not drained. OS/SQLite locking releases it after a crash;
there is no PID file, timer lease or stale-file deletion. The file contains no
application state, is excluded from Pictaria backups, and must not be removed
while a server is running. It needs the same reliable filesystem locking as the
application database. This is single-server ownership, not multi-node support. Older builds do not
take this lock; stop them before upgrading or reusing their data directory.

After ownership and schema initialization, startup reconciles interrupted
provider and exact-input markers once, without refunding charges. Opening the
repository from a read-only helper does not recover live work. No schema or
persistent-state version changes are needed for this integration: the protection
tables already shipped as schema 20 / contract 25. Both new referee roles remain
unavailable. The shared changing-input integration is described below; role-specific
request/advice applicability still needs integration before activation.

## Changing inputs and protected cleanup (PIC-346)

The server composes `CurateAiLifecycle` with its existing service, executor and
shared scheduler. This is infrastructure for the upcoming role workers, not an
active source of AI requests. No worker discovers/offers real groups yet, and
both availability flags remain false.

- A role adapter offers a current group and versioned prompt/schema contract,
  optionally selecting an actionable Photo Referee batch. The lifecycle derives
  the authoritative full membership, material/human signatures, separations and
  already-kept context itself. Context remains read-only, at most eight images
  within the 30-image request envelope. Unsupported/dense inputs remain manual.
- An unchanged offer keeps its original 30-second settling deadline. Changed
  inputs replace overlapping queued work and supersede an old active answer.
  There are at most 32 waiting requests and one active Curate request. Separate
  current children after a split and disjoint batches of the same scope may
  coexist; shared context does not tie unrelated stacks together. There is no
  lineage history, persistent work queue or prediction from the Enrich queue.
- Future adapters rediscover current candidates after changes. Stale queued
  inputs are dropped; the lifecycle does not manufacture their replacements.
  The background tick never waits for inference. Recent open-comparison
  attention defers new work, and closing or letting that attention expire allows
  it again. Deterministic checks must finish first. The Stack Referee's current
  uncertain/all policy is rechecked before submission.
- Before each preparation checkpoint and dispatch, and inside the acceptance
  transaction, compare current scope, availability, material inputs, human
  decisions and separations. Related dirty sources and bounded nearby projection
  changes also invalidate old input before the next grouping rebuild. Unrelated
  imports do not invalidate a paid answer. An applicable submitted answer can
  still be accepted after its role is disabled; dependent work needs fresh gates.
- Resolve the saved provider/model at scheduler admission. Changing the connection
  while queued requires a new turn, without spending an attempt; the admitted
  model stays pinned through preparation/submission. Changing Settings alone
  does not invalidate valid advice or reset an input's attempt count.
- One failed submitted/invalid-answer attempt can wait 30 seconds for its one
  remaining attempt, still subject to provider and photo limits. A finished or
  limited input cannot be revived by refresh, restart, toggle or window expiry.
  Authentication/configuration failures stop that offered work. Ordinary queued
  work may wait through a transient provider cooldown; expiry does not recreate
  removed work or create a probe. Adapters must submit exactly once through the
  executor, not wrap calls in Enrich's validation-retry helper.

Schema **21** / persistent-state contract **26** adds `curate_ai_inputs`: a compact
membership/signature reference saved atomically with a charged attempt or a
limited-input settlement. It contains no photos, prompts, credentials or answers.
Only admitted/settled work gets a durable reference; queuing revisions does not
create a history. Startup takes the usual complete pre-migration snapshot.

Once a minute the service examines at most 20 aged references, yielding the
remaining candidates to later passes after a four-millisecond target. A cursor
prevents protected rows from starving others. Cleanup keeps current inputs,
running/queued work, unexpired comparisons/decision operations, outstanding Undo
or sync, and usable advice. It nominates only demonstrably obsolete inputs to
the existing ledger cleanup after the 30-minute window. During a rebuild,
unprojected source changes or Stacks-off, it retains records conservatively.
Older records without authoritative references are retained. Cleanup never
offers work or resets a current exhausted/limited comparison.

Synthetic coverage exercises settling and overlapping replacements, batches and
shared context, queued/preparing/in-flight changes, human decisions and missing
assets, open comparisons, provider changes, bounded retries/churn, protected
cleanup, restart, upgrade and complete backup/restore. Live role-worker and
provider acceptance remains PIC-370/PIC-116 work.

## Remaining integration

- **PIC-345 / PIC-372:** connect availability to the actual workers and complete
  the cutover and live migration acceptance. This settings slice does not replay
  decided history or establish eligibility for historical referee results.
- **PIC-346:** connect the shared lifecycle to each real request/advice adapter and
  verify its applicability and one-call accounting before enabling either role.
  The shared machinery above does not replace role-specific acceptance testing.
- **PIC-118:** request arbitration and shared provider-pause/recovery integration
  are implemented as described above; validate with the new role workers at activation.
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
