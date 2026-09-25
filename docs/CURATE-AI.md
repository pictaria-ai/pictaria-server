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
The Enrich dependency remains until an explicit migration preserves previously
inactive settings. This change does not activate AI on the preview page.

## Remaining integration

- **PIC-345 / PIC-372:** separate Stack Referee and Keeper Referee controls,
  shared provider presentation and migration of effective prior preferences.
  Both roles default off; the new roles will be independent of Enrich's switch.
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
