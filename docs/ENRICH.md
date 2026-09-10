# Enrich

AI models look at your photos and propose tags from a controlled taxonomy,
plus a one-sentence caption. AI tags sync to Immich after every successfully
enriched photo. **Send to Curate** optionally adds those photos to human review.
Results are stored in `data/enrichment.sqlite`; if optional caption writeback
is enabled, successful captions are also copied automatically into Immich
descriptions under the rules documented below.

Enrichment is **off by default** (`ENRICH_ENABLED` / Settings → Enrich).
Each run sends the selected rendition to its chosen model, so it takes an
explicit opt-in. LM Studio, local Ollama, and an OpenAI-compatible endpoint
you host keep model requests within infrastructure you operate; cloud
providers receive them through your own provider account. The user-invoked
Voice **Interesting** command is separate
from Enrich and can send a preview plus photo metadata to its selected model
even while enrichment is off.

## The pipeline

For each photo, one *processing run*:

1. Fetch the chosen rendition from Immich (`IMAGE_SOURCE`: `preview` default,
   `thumbnail`, or `original`).
2. Send it to the selected vision model with the system prompt and the
   per-photo prompt (the `{approved_tags}` placeholder is replaced with the
   taxonomy's tag list).
3. Validate the model's JSON against a strict schema derived from the
   taxonomy — unknown tags are rejected, and operator-hosted models get one
   automatic retry with stricter instructions.
4. Map the validated output to `ai/*` tag decisions and store the run
   (latest normalized output, provider/model, and a reference to the saved
   configuration) locally. Raw provider envelopes are not retained.

Every successful dashboard enrichment durably queues its `ai/*` tags for
Immich, whether or not **Send to Curate** is checked. Sync starts while the run
continues; it does not wait for the whole batch. **Send to Curate** controls
review-list membership only. Curate retains authority over human decisions
such as `frame/eligible`, `frame/favorite`, and `frame/never-show`.

Pictaria manages the `ai/*` namespace: re-enrichment adds missing tags and
removes stale ones, including manually added Immich tags inside that prefix.
Tags outside `ai/*` are preserved. The AI-derived `frame/review` marker stays
local and is not published by automatic tag sync. An album/search filtering
on AI tags can now include photos before review; use Curate decision tags
when approval is required.

**Immich tag sync** in Enrich's Status card shows pending/failed photos, the
latest error, and **Retry sync** when intervention is needed. A remote sync
failure does not fail enrichment or repeat an AI call. Enable **Tags** under
**Immich Account Settings → Features** for the API-key account, and grant
`tag.read`, `tag.create`, and `tag.asset`. Fix connection/permission problems
and retry there. Deleted photos are skipped. Turning Enrich off pauses this
queue while preserving pending work; it does not block Curate sync.

AI sync has a separate durable queue with one row per photo and no historical
tag payload. Repeated enrichment coalesces to the newest local result. A
processing-run generation prevents an older in-flight completion or failure
from clearing newer queued work. The same tag-write coordinator serves
Curate and favorite/never-show routes, with human work taking priority between
bounded AI slices (at most 10 photos). It does not interrupt a network request
already in flight. AI backoff never holds the coordinator or consumes the
Curate backlog allowance. Shared verification checks both additions and stale
AI-tag removals, with one settle delay per slice rather than per photo.
Systemic failures pause the AI lane for 30 seconds; photo-specific failures
are parked after five attempts and can be retried from Enrich.

New saved run configurations record `processing.syncAiTags: true`. The older
`applyTags`/`dryRun` fields describe only the separate legacy batch-end write
path, which stays disabled for dashboard runs. Historical configurations are
not rewritten. Background sync time is not part of photo inference timing.

This change uses Enrich schema 12 and persistent-state contract 15. Startup
creates the required pre-migration recovery snapshot; rollback restores that
snapshot. Queue state is included in normal database backup/restore and
resumes idempotently. Upgrade does **not** backfill tags for older enriched
photos. Those photos sync on a subsequent successful enrichment or Curate
decision; a bulk historical-sync action is not included.

## Providers

| Provider | Type | Configure |
| --- | --- | --- |
| `cloud_openai` | Cloud | OpenAI API key + model under Settings → AI Providers |
| `local_lmstudio` | Local | Base URL + the model identifier LM Studio lists under Settings → AI Providers |
| `local_ollama` | Local | Base URL + a vision model as `ollama list` shows it under Settings → AI Providers (no key needed) |
| `openai_compatible` | Operator-chosen | Base URL + model + optional bearer key for llama.cpp and similar servers under Settings → AI Providers |
| `openrouter` | Cloud | API key + model under Settings → AI Providers |
| `cloud_ollama` | Cloud | API key + model under Settings → AI Providers |
| `venice` | Cloud | API key + a vision-capable model under Settings → AI Providers (no default) |

### OpenAI-compatible endpoints and llama.cpp

The generic provider targets servers that accept OpenAI-style
`POST /v1/chat/completions` requests, including multimodal `image_url` data
URLs. Configure the full base URL (normally ending in `/v1`), the exact model
identifier the server accepts, and an optional bearer key under **Settings →
AI Providers**. The server appends `/chat/completions`; do not put that final
route in the base URL.

For Enrich and the Curate referee, Pictaria asks for the broadly supported
`json_object` response mode, describes every expected field with the complete
schema in the prompt, and then applies that same schema locally before
accepting anything. This avoids pretending that every "OpenAI-compatible"
server implements OpenAI or LM Studio's nested strict-schema request in the
same way. A server still needs multimodal image input, JSON-object output,
and—when used for Curate—multiple images per request.

For current llama.cpp, run `llama-server` with a multimodal model and its
projector, use a base such as `http://llama-host:8080/v1`, and leave the key
blank unless the server was started with API-key authentication. llama.cpp's
documented image decoder accepts stb_image formats such as JPEG and PNG, not
Immich's WebP previews, so set **Image source** to `original`. HEIC/RAW
originals may still be unsupported. The voice **Interesting** command always
uses an Immich preview, so choose another voice-answer provider when the
compatible endpoint cannot ingest WebP; text-only **Tell Me** does not have
that image-format constraint.

Thinking-capable models behind compatible endpoints can place a requested
Enrich or Curate JSON answer in their `reasoning_content` response field while
leaving ordinary `content` empty. Pictaria accepts and validates that channel
only for machine-readable requests; Voice and other prose requests always
ignore reasoning content.

Connections and model identifiers live under **Settings → AI Providers**.
Choose the active provider on the **Enrich** page: it is used for every new
run and remembered across page visits and server restarts. `DEFAULT_PROVIDER`
is only the initial/infrastructure fallback when there is no saved choice; it
is not a second day-to-day selector. If a remembered provider later loses its
key, model, or reachable URL, Enrich keeps that selection visible, explains
that it is not configured, and will not start a run until you configure it or
choose another provider.

An OpenRouter model must have both **image input** and **structured outputs**
on at least one currently available endpoint. Pictaria keeps strict structured
output enabled. For `google/gemini-*` models it automatically projects the
generation schema to Gemini's documented JSON Schema subset; Pictaria still
applies the complete taxonomy, string-length, item-count, and numeric checks
locally before accepting an answer. This provider-specific adaptation does not
weaken the validation used for OpenAI or other OpenRouter models.

For a dated, role-by-role starting point drawn from the Pictaria reference
installation, see [Recommended AI models](RECOMMENDED-MODELS.md). It includes
local and cloud choices and the extra multi-image requirement for the Curate
referee.

Venice runs many open models on its own infrastructure and can offer
cloud-scale models without storing your photos or prompts — but that
guarantee is **per model**: only models whose `model_spec.privacy` is
`private` are contractually zero-retention. `anonymized` models withhold
your identity while the provider still sees the content you send, so check
the property in the `/models` response
([privacy docs](https://docs.venice.ai/overview/privacy)) before sending a
library through one.
There is deliberately no default Venice model — their catalog changes quickly
and models differ in what they accept, so pick one from
[their model list](https://docs.venice.ai/models/overview) that supports
**vision and structured output** (`supportsVision` + `supportsResponseSchema`
in the list's capability flags); to also serve as the AI referee it must
accept **multiple images per request** (`supportsMultipleImages`). At the
time of writing `qwen3-vl-235b-a22b` satisfies all three — no promise it
stays in the catalog. Models marked "private" run on Venice's own servers.

### Local Ollama, from zero

Ollama is the easiest operator-hosted path: no third-party cloud model or API
key, and Pictaria's default base URL (`http://127.0.0.1:11434`) matches
Ollama's default port.

**Install.** On a Mac, `brew install ollama` then `brew services start
ollama` gives you a background service that starts at login — no window to
keep open (this is the setup Pictaria is tested against). The desktop app
from [ollama.com](https://ollama.com) works identically if you prefer a menu
bar icon. On Linux, use their install script or your package manager. If
Pictaria runs **in Docker**, remember `127.0.0.1` is the container itself —
use `http://host.docker.internal:11434` as the base URL and see the note on
the Settings field about making Ollama listen beyond localhost (and binding
no wider than needed).

**Pick a model**, pull it, and put the exact tag in Settings → AI Providers →
"Ollama (local) model":

```
ollama pull qwen3-vl:8b
```

| Model | Download | Notes |
| --- | --- | --- |
| `qwen3-vl:8b` | ~6 GB | Tested. Small sibling of the big cloud-hosted Qwen3-VL variants; accurate, appropriately conservative tags. Captions can be clumsier than big-model output. |
| `gemma3:4b` | ~3 GB | Tested. Lightest reasonable choice; fine tags, simpler descriptions. |
| `qwen3-vl:30b` | ~19 GB | The quality upgrade for machines with plenty of unified memory (48 GB+); mixture-of-experts, so faster than its size suggests. |

Any vision model `ollama list` shows will work — Pictaria passes the
response schema as Ollama's native `format` parameter, so output is
grammar-constrained to valid JSON rather than best-effort, and
thinking-native models are handled (if Ollama routes the constrained JSON
into the thinking channel, the server reads it from there).

**What to expect when running against Pictaria:**

- **The first photo of a run is the slowest** — that's Ollama loading the
  model into memory. After a few idle minutes Ollama unloads it again, so
  memory frees itself between runs (and the next run pays the load cost
  once more).
- **Local speed is a different currency**: think roughly half a minute to
  two minutes per photo depending on model and hardware, versus seconds on
  a cloud provider. Runs happen in the background, so slow is fine — just
  size the run's photo budget to the time you have.
- **One resident model at a time.** LM Studio and Ollama each hold
  multi-gigabyte models in memory, and neither knows about the other. If
  you use both, quit one (or eject its model) before a long run with the
  other — otherwise the two compete for the same unified memory and
  everything slows down.
- A failed photo never counts against your library: provider outages and
  timeouts are classified as infrastructure and retried on the next run
  (see "When things go wrong" below).

**Ollama, LM Studio, or another compatible server on another machine (LAN or
Tailscale).** Pointing the base URL at a different machine works — a beefy
desktop can serve models to a small Pictaria host — but two defaults get in
the way:

1. **Model servers often listen on localhost only** out of the box. On the
   serving machine, tell Ollama to listen wider (`OLLAMA_HOST`, per Ollama's
   FAQ for your install method) or flip LM Studio's "serve on local network"
   toggle. Then use that machine's address in the base URL, e.g.
   `http://192.168.1.20:11434`.
2. **Many have no authentication by default**, and every request carries your
   photos in plain HTTP. Anyone who can reach the port can run the models and
   see what you send — so bind no wider than you must, and don't expose these
   ports beyond networks you trust.

Those two points are why **Tailscale is the nicest remote setup**: traffic
is encrypted end-to-end, only your own devices can reach the port, and you
can bind the model server to the tailnet address alone (e.g.
`OLLAMA_HOST=100.x.y.z:11434`) so it isn't offered to the LAN at all. Use
the machine's Tailscale IP or MagicDNS name in the base URL. Latency is
irrelevant next to inference time, and a preview-sized photo per request is
light even on remote links.

## Starting runs

- **Library sweep** — the Enrich page's *Start*: selects newest-first from
  Enrich's local inventory and analyzes up to the *Photos* budget. SQL excludes
  covered, discarded, and failure-limited photos before applying that budget.
  *Only unenriched* (default on) excludes photos with a successful run from
  any model. Each selected photo is checked against Immich before processing.
- **Daily Enrich** — an optional set-it-and-forget-it library sweep under
  **Settings → Enrich**. Choose a local time and daily photo budget; Pictaria
  uses the provider currently selected on the Enrich page, analyzes only
  photos with no successful enrichment, and sends successful results to
  Curate. The browser's current time zone is remembered when the schedule is
  saved, even when Pictaria itself runs in a UTC Docker container. A manual or
  queued run already in progress keeps priority and the daily sweep waits
  quietly. Enabling the schedule after today's chosen time starts that day's
  catch-up promptly. Each attempt appears in **Recent runs** as `Daily Enrich`,
  including a zero-photo run when no eligible photos were found. A run
  that starts but fails is recorded there and waits until the next day rather
  than retrying automatically; after correcting the problem, start a manual
  run if you do not want to wait.

### Library discovery and freshness

The first budgeted sweep builds an Enrich-owned inventory in 1,000-record
metadata pages. It saves each page and publishes only after finishing the
pass. A restart, cancellation, outage, or bounded incomplete pass can resume
from its checkpoint. It does not download images or call the AI provider
during inventory construction. The existing Enrich database holds this
rebuildable cache separately from processing history and human decisions.

Later sweeps query changes with explicit timeline, archive, and hidden
visibility partitions and include retained trash records, then compute
eligibility locally. This works with the inspected v2/v3 search defaults
without requiring locked-library permissions. Only timeline images are
processed, matching the previous library-search scope; this change introduces
no new stack-child exclusion rule. Changing profiles keeps the inventory and
re-evaluates history using the captured inference configuration.

Unknown photo types, visibility values, or non-boolean trash flags make a
record ineligible without blocking the rest of discovery. Missing visibility
in a search row inherits that request's explicit visibility partition. Before
processing, a separate live photo lookup must confirm an image with timeline
visibility and `isTrashed: false`; it never inherits search visibility.
Diagnostics for incomplete eligibility metadata are bounded to one per
refresh and one for live validation per run. Missing IDs or invalid update
timestamps, malformed capture dates, and broken page structure still stop the
refresh without advancing its checkpoint. Corrected records are reconsidered
on a newer source update or full reconciliation.

Each completed refresh advances from the largest source `updatedAt`, never
from Pictaria's clock. The next incremental pass starts one millisecond later
to avoid repeatedly reading a large import sharing the boundary timestamp.
Late arrivals at that exact timestamp, silent access changes, and photos missed
by mutable remote offset pagination are handled by a full reconciliation on
the next sweep after 24 hours. This is eventual discovery, not a remote
snapshot or an instant notification stream. Ordinary newer uploads are found
by the next incremental pass even when their capture dates are old.

Permanent deletions and locked/inaccessible transitions cannot all appear in
search results. A burst of 100 consecutive rejected candidates starts a full
catch-up within the same run. Rejected candidates do not consume the AI photo
budget. Permission/server failures propagate instead of being recorded as
confirmed deletions. Only one catch-up is attempted per run; continuing churn
can still produce an explicit incomplete result.

A refresh is bounded to 2,000 pages and ten minutes, with a checkpoint retained
if either is reached. Candidate validation has a separate bound (at least
10,000, or the requested photo budget plus 1,000). Exhaustion is reported in
run history as **Library discovery is incomplete**, with instructions to run
again; it is never reported as no remaining work. The log records scanned
metadata, candidates, validations, rejections, and elapsed metadata refresh
time (including interrupted refreshes, excluding AI processing and live
candidate lookups). Very large/slow libraries
may need another run to finish construction; Daily Enrich retains its existing
once-per-day attempt policy. Discovery resumes the next time it is invoked.

Changing the Immich URL or API key rebuilds the inventory, preserving Enrich
history and human decisions. A database lease prevents concurrent inventory
writers; a process killed without releasing it can delay a restart by up to
five minutes. Explicit targeted queue/retry jobs keep their existing selection
path. Low-level CLI calls with offsets or no photo budget retain their bounded
metadata-window semantics.

**“Enriched” is per effective inference configuration.** With *Only
unenriched* on, any previous success covers a photo. With it off, Pictaria
skips a photo only when a previous success used the same effective prompts,
provider/model and generation settings, approved vocabulary/output schema,
and image rendition policy. Editing a custom prompt works even if its
`v2-custom` label stays the same. Renaming a version or inference host,
reformatting taxonomy JSON, or editing review policy does not require new AI
calls. An identical setup still skips; this adds no force-rerun mode.

Each execution captures its configuration **before selecting photos**.
Prompts, taxonomy, provider settings, image source, and processing options stay
fixed through photo selection, automatic retries, tag mapping, and history.
Provider/model and operational settings apply at execution start. Queued
profile inputs are captured from the active profile when execution starts. Run all captures one profile revision for the entire batch. Saving an edit never starts work. Cancel and
operational pause controls remain live; changing the Immich connection cancels
an active run and invalidates an in-progress queue resolution, keeping the
queue item available to start again.

Results from before configuration snapshots were introduced have **unknown
configuration identity**. They still count as enriched with *Only unenriched*
on. With it off, their inputs cannot be proven equivalent, so they are
eligible for a later run. Upgrading neither invents their inputs nor replays
photos. The latest successful result per photo remains active for Curate,
captions, and search; existing human decisions remain authoritative.

- **Targeted runs** — in Insights, any photo group (a person, a place, a
  year, a day, a camera…) has *Send to Enrich*. The slice waits in the
  Enrich page **queue** until you run it; the server resolves the filters to
  a concrete asset list at run time (capped at 1,000 per run — a capped
  slice stays queued so running it again walks the rest). Resolution is
  skip-aware: photos your current setup has already enriched, and photos at
  the failure limit, don't occupy the 1,000-photo window, so repeat runs of
  a big slice keep advancing instead of re-scanning the same photos. A
  queued item whose slice has nothing left to analyze retires itself with
  an honest note ("N already enriched, M at the failure limit"), recorded
  in run history, instead of erroring forever. Identical slices queued
  twice dedupe into one entry. The installation has one shared owner and a
  100-item / 512 KiB queue ceiling; one encoded item may use at most 64 KiB.
  That leaves ample room for ordinary 500-city multilingual location groups
  without letting one request consume the entire queue.
  Pending work expires after 30 days, while an active or resolving item is
  protected until it finishes or pauses. These are operational queue bounds,
  not enrichment-history retention.
- **Run all** — chains the queued jobs you confirm in its dialog, one after
  another (each with its own checkbox settings), for overnight batches. The
  chain advances only on clean finishes: a failure or cancel stops it (the
  stop is recorded in run history) and whatever remains stays queued, ready
  for the next Run all.
- **Cancellation** aborts an active AI-provider request immediately. That
  photo is recorded as an infrastructure failure, so it does not consume a
  failure strike and retries automatically the next time the job runs. If
  Pictaria is waiting on an Immich request instead, it stops as soon as that
  request returns. Cancel doubles as pause — a queued job stays in the queue
  unless its run finishes cleanly, and running it again continues where it
  left off (already-enriched photos are skipped).
- **Recent runs** starts with the newest 20 summaries. **Load more** walks
  through all 100 retained summaries without loading their potentially large
  logs; each log is fetched only when you open it. Retry actions remain
  available on older loaded runs and always recalculate which failed photos
  still need work before starting.

### Enrich and Curate are composable

Enriching and reviewing are separate pipelines that compose. Every run has a
**Send to Curate** option (on by default): photos join the Curate review
queue as the run enriches them. Library sweeps send only their new successes;
they do not send the already-enriched library implicitly. Explicit targeted
selections can still send existing results. Photos that fail are never listed — they stay with the queued job and
enter Curate when a later run enriches them, so the review queue only ever
holds photos with real AI signal. Turn the option off to enrich purely for
tags, captions, and albums — Curate never hears about it.

Curate also works entirely **without** enrichment: *Send to Curate* in
Insights puts a slice straight into the review queue. Photos with no AI
signal all land in Candidates.

Membership never resets decisions: sending a slice again is a no-op for
photos you already decided. The one exception is explicit — the nested
**include previously curated** checkbox (off by default) on queued jobs, which
re-analyzes the whole slice and — only after a clean finish — clears your
earlier keep/hide decisions so everything returns for a fresh review.

## Taxonomy, prompts, and the response schema

Choose **View and manage profiles** on Enrich to open the profile list in
Settings. Each profile’s editor shows allowed tags by category, its taxonomy
JSON, and prompt text. For the exact inputs used by an execution, including
the output schema, open **View run settings** from Recent Runs.

Every enrichment request has **two parts**, and only one of them is prose:

1. **The prompt** (system instructions + per-photo message) carries the
   judgment: what makes a photo frame-worthy, how to use the tag list, when
   to prefer one tag over another.
2. **The response schema** is a JSON contract used as the final acceptance
   rule and, where the provider supports the same dialect, sent as a
   structured-output constraint (OpenAI structured outputs, LM Studio's
   `json_schema` mode). The generic compatible provider asks for a JSON object,
   embeds the schema in the prompt, and enforces it again after receipt. The
   contract declares the exact fields every accepted reply must contain. This
   is why captions, quality scores, and screenshot flags appear in results:
   the schema demands them, and its field names and descriptions act as the
   instruction.

The schema's fields and their uses:

| Field | What it feeds |
| --- | --- |
| `caption`, `short_caption` | caption search, Curate cards, optional Immich description writeback |
| `is_photo`, `is_screenshot`, `is_document`, `is_text_heavy` | screening non-photos out of Candidates |
| `has_private_info`, `has_license_plate` | the privacy review bucket |
| `has_people`, `people_count`, `child_present` | people tags and people-aware curation |
| `quality` (four 0–1 scores + blur/dark/low-res flags) | frame-worthiness, star picks, bucket sorting, Best-of ranking |
| `scene`, `subjects`, `activities`, `composition` | free-text context recorded with each run |
| `candidate_tags` (tag + confidence + reason) | becomes the photo's `ai/*` tags after threshold checks |
| `exclusion_reasons` (tag + confidence + reason) | exclusions that keep a photo off the frame |
| `needs_review` | flags the photo for human review |

Caption values must contain the caption itself, without prompt labels such as
`Full caption:` or `Short caption:` and without placeholder text such as
`Full caption here`. Pictaria rejects those small-model template leaks as an
invalid response, so the normal retry and per-photo failure handling apply
instead of storing the label as photo metadata.

**What is editable and what is not.** The taxonomy (which tags the model may
use, thresholds, exclusions) and both prompts are editable in Settings →
Enrichment profiles. The schema's *field list* is fixed: Curate's buckets, the star
picks, caption search, and Best-of ranking all read these fields by name,
so removing one would break the features downstream of it. Editing the
taxonomy already reshapes the schema where it is meant to flex — the tag
lists inside `candidate_tags` and `exclusion_reasons` are generated from
your approved tags on every request.

- **Taxonomy** — `taxonomy/v1.json` (`TAXONOMY_PATH`) seeds the initial
  profile and New profile → Pictaria templates. Edit saved inference taxonomies in profiles.
  The version is a readable label; actual vocabulary determines inference
  identity. Shared live Curate policy remains a separate Settings value.
- **Prompts** — `prompts/` (`PROMPTS_DIR`/`PROMPT_VERSION`) supplies the
  initial and built-in templates. Saved profiles own their explicit text;
  the per-photo template must include `{approved_tags}`. Profile runs use
  a `-profile` prompt label plus durable profile/revision attribution and
  content identity.

## Enrichment profiles

Use **Settings → Enrichment profiles** to keep several named prompt/taxonomy
setups. The profile list marks the active profile used by new Enrich work.
Choose **New profile**, enter a name, and start from the **Pictaria templates** (the configured template files) or a copy of an existing profile.
Creation and editing open a dialog above the profile list. On narrow screens,
the editor fills the screen. The **Starting point** dropdown labels saved profiles as **Copy of [name]**.
Each row’s **⋯** menu offers **Duplicate** and **Archive**
where applicable. Restore profiles from the collapsed **Archived profiles** list.

**Edit** opens one profile at a time: name, **Tags & categories**, then
**AI instructions**. Expand categories to inspect allowed tags; expand
**Edit taxonomy JSON** to change their definitions and thresholds. **General
instructions** is the system prompt; **Photo request template** is the
per-photo prompt and must include `{approved_tags}`.

**Save changes** (or **Create profile**) validates before saving. Optional
**Check configuration** checks format and required fields without sending
photos to a model. Field errors reveal the relevant editor; invalid edits
and stale saves from another window leave the last usable revision intact.
Unsaved edits are marked, and cancelling or leaving asks before discarding
them. Saving closes the dialog and updates the profile list, without changing
the active selection or starting enrichment. Saving edits to the already-active
profile changes the revision used by future runs. Choose the active profile on
Enrich.

On Enrich, use the profile picker to choose a saved setup and **View and
manage profiles** to open the profile list in Settings. Provider and profile
choices share one card. Creation, validation, archiving, and restoration live
in Settings; saving does not navigate to Enrich.

Profiles contain prompts and taxonomy only. Provider/model connections,
image settings, and processing controls remain separate. **Active profile**
on Enrich is saved on the server and shared by browser tabs and sessions.
The picker refreshes from server status and on returning to the page. A stale
start or activation request is rejected so a different profile cannot run
silently. Changing the active profile does not start work.

Library sweeps, individual queued groups, manual retries, and Daily Enrich
capture the active profile’s current revision when execution starts, before
photo selection. **Run all** captures one revision for the entire batch.
Every started execution and its automatic retries keep their captured inputs,
even if the active profile changes, is edited, or is later archived.

Queueing saves only the photo selection. Pending groups use the active profile
when started; they have no profile picker or saved profile pin. Identical
photo selections deduplicate regardless of the active profile. A cancelled
or failed job retains its history; starting it again captures the then-active
profile. Explicit per-job profile overrides are not supported.

To try a different profile on already-enriched photos, turn **Only unenriched**
off for a small manual run or a queued slice. Identical inference inputs still
skip, even if the profile name/revision differs. Keep **incl. previously
curated** off to preserve prior human decisions. The existing optional
reopen action remains the deliberate way to clear decisions for re-review.
There is no automatic routing, quality-comparison dashboard, or force-identical
rerun mode in this workflow.

A photo has one active result: its latest successful enrichment supplies
Curate, caption search, Smart Album ranking, and optional writeback. A failed
attempt leaves the previous success active. Existing writeback rules still
protect descriptions edited by humans. Earlier processing metadata and
configuration attribution remain; superseded normalized outputs are not
retained as a parallel profile-results library. Profile/revision attribution
appears in run history, the saved run settings viewer, and the Curate caption
lightbox. Human decisions remain authoritative.

**Curate policy remains shared and live**, under Settings → Enrich → Live
Curate review policy. It applies to results from every profile. Editing an
inference profile does not replace this global policy. Profile taxonomy
thresholds control tag mapping for new executions, while the shared policy
controls Curate's interpretation of existing scores. Policy-only changes do
not cause AI calls or automatically remap stored tags.
In particular, Curate reads `review` buckets and `hard_exclusion_tags` from
the shared policy in Settings; editing those sections inside an inference
profile does not change Curate.

**Archive** removes a profile from new selections, preserving running jobs
and historical attribution. Restore it through **Archived profiles**.
Activate another profile before archiving the active one. There is no hard delete;
up to 100 profiles, including archived ones, are supported. Revisions are
retained with the enrichment database and can grow as profiles are edited;
each revision has bounded prompt/taxonomy fields. List/status requests return
small metadata only; editor/detail requests load the content separately.

On first upgrade, the effective prompt text and taxonomy (including saved
overrides, with their existing precedence over configured files) are copied
into **My profile**, the initial active profile. When upgrading an earlier v1.2
preview, its saved default becomes the active profile, and pending queue pins
are cleared. Existing queued selections and saved run configurations remain.
An untouched original profile named Default is renamed to My profile using a
new revision; old attribution is retained. Edited, renamed, or archived profiles
keep their names, as does the starter if another My profile already exists.
The old settings values remain on disk for provenance/rollback, but saved
inference profiles then own their content: later environment/file changes do
not overwrite them. **New profile → Pictaria templates** explicitly imports the current
configured files. Legacy prompt writes through Settings are rejected with a
pointer to profiles; `taxonomyJson` continues to own the shared live Curate
policy. Existing human decisions and old unknown configuration identities
are preserved. Profiles, revisions, active choice, and queued selections participate
in the standard SQLite backup and restore.

## When things go wrong

- **Curate says Immich is still missing tags**: first confirm **Tags** is
  enabled under **Immich Account Settings → Features** for the same account
  whose API key Pictaria uses, and confirm the key has `tag.read`,
  `tag.create`, and `tag.asset`. Retry the parked sync entry after correcting
  either setting. If only some photos keep failing, test one owned by the
  API-key account: a shared or otherwise read-only photo can be visible to the
  account without being writable. If an owned photo still fails, confirm only
  one Pictaria Server instance is using the data volume and check the Immich
  and Pictaria logs for the affected request.
- **LM Studio in Docker fails every photo with a WebP message**: Immich
  previews are WebP, which LM Studio cannot ingest. On macOS Pictaria
  converts them automatically (`sips`); inside the Docker image there is no
  converter, so set **Image source** to `original` in Settings → Enrich
  (`IMAGE_SOURCE=original`). Originals are typically JPEG; HEIC originals
  may still be rejected by LM Studio.
- **llama.cpp rejects a preview image**: current llama.cpp multimodal support
  accepts JPEG, PNG, and other stb_image formats, but not WebP. Set **Image
  source** to `original`; if the original is HEIC/RAW, try a compatible JPEG
  source or model server. Pictaria does not transcode generic-provider images.
- **OpenRouter says `404 No endpoints found`**: confirm that the exact current
  model identifier accepts images and advertises structured outputs on an
  available endpoint. OpenRouter model availability and endpoint capabilities
  change independently; an old model slug or a model with no endpoint that
  supports both requirements cannot run Enrich. Pictaria does not silently
  fall back to unconstrained text output. OpenRouter failure messages include
  a bounded provider name plus structured upstream code, status, and message;
  unstructured raw metadata and dedicated request, prompt, image, header, and
  debug fields are ignored, and configured credentials are redacted. If a
  successful envelope has no answer, the diagnostic instead includes bounded
  request and finish metadata. The remaining message text is controlled by the
  upstream provider, so review it before posting it publicly in case that
  provider echoed request content in its message.
- **Rate limits, outages, and timeouts never cost a photo anything.**
  Failures are classified by *whose fault they are*. When a provider reports
  a temporary rate limit (429) or unavailable service (503), Enrich retries
  that same photo twice before moving on. It follows the provider's
  `Retry-After` request between one second and five minutes; without one it
  waits 15 seconds, then 30 seconds. The live run log shows each retry, and
  Cancel interrupts those waits promptly. If two photos exhaust both retries
  without a successful provider response in between, Enrich skips further
  overload waits until the provider responds successfully again. It still
  makes one ordinary attempt per photo so it can detect that recovery.
  That keeps an exhausted quota from stretching the existing fast-failure
  check across more than 20 minutes of requested wait. If both attempts still
  fail — or for another clearly environmental error such as a timeout, dropped
  connection, auth error (401/403), or other 5xx — the result records as an
  **infrastructure failure**: it shows up in the run's failure count, but it is
  never counted against the photo, and the next run over the same slice retries
  every affected photo automatically. Nothing to reset, nothing lost.
  Immich-side network errors and 5xx are treated the same way.
- **A photo that keeps genuinely failing is dropped after two strikes.**
  Failures the provider pins on the request itself — most commonly a
  response the schema rejects (an unparseable answer, too many tags) —
  count against the photo, and after **two** failed runs it is skipped
  with "reached 2 failed run(s)". The allowance is per effective inference
  configuration: a photo gets fresh attempts when model inputs change,
  including a custom prompt edit under an unchanged version label. Legacy
  failures with unknown inputs do not count against a new configuration.
  After upgrading, previously stuck legacy photos therefore leave the
  **Stuck photos** strip and can receive two fresh attempts on subsequent
  sweeps at the default limit, using additional provider calls.
  To re-attempt them under the *same* setup, the Enrich page shows a
  **Stuck photos** strip whenever any exist for the selected provider —
  **Retry** runs exactly those photos with the failure cap off for that
  one run. Their failure history is kept: a photo that fails again stays
  in the strip (with a deeper count), one that succeeds leaves it, and
  the run appears in history as "Retry failed photos". The strip counts
  only photos with no successful enrichment under *any* setup — a photo
  another model already enriched has data and isn't stuck (re-running it
  under the current model is the "Only unenriched" compare workflow, not
  a retry). Retry takes up to 10,000 photos at a time,
  least-recently-attempted first, so an oversized stuck set cycles
  instead of starving its tail. At the
  environment level, raising `MAX_FAILURES_PER_ASSET` above the recorded
  failures (or setting it to `0`, which disables the limit) re-attempts
  them on the next run.
- **A photo that can never succeed can be discarded.** The strip's
  **Details** popup lists each stuck photo with its thumbnail, filename,
  and the failure message that put it there — "Asset media not found"
  (Immich has the record but the media is gone, so the thumbnail renders
  broken too) reads very differently from a model timeout. From there,
  open the photo in Immich to inspect or repair it, retry via the strip,
  or **Discard** it (per photo, or all at once). Discarding is a
  local-only flag: enrichment stops attempting the photo — it leaves the
  stuck set and every future run skips it, counted as "N discarded" in
  run reports — but *nothing is written to Immich*, and display is
  untouched (this is deliberately not `frame/never-show`; enrichment
  exclusion and display exclusion are different decisions). The discard
  is global across providers and models — a broken photo is broken for
  every model — and reversible: every discarded photo is listed under
  **Settings → Discarded Photos** (and in the popup itself) with a
  per-photo **Restore**, the one door back in. Explicit discard and restore
  selections accept at most 1,000 canonical Immich photo IDs per request;
  **Discard all** remains the server-resolved 10,000-photo operation.
- **Provider down**: if the first several photos of a run all fail with
  nothing succeeding, the run aborts with *"provider looks unreachable or
  misconfigured"* rather than failing the entire slice — a dead provider
  (e.g. LM Studio's server not running — the app being open is not the
  same thing) shouldn't spend anyone's strikes. Fix the provider and run
  the job again.
- **Cancel or restart mid-run**: results already produced are saved
  per-photo the moment they finish. A cancelled run leaves its queue item
  in place; a server restart records exactly one *interrupted* run and leaves
  its queue item in place even if abandoned provider work later settles.
  Either way, running the item again continues where it left off.

## Run history

Each modern run in Recent Runs has a **View run settings** button. It opens
that execution’s saved prompts, effective user prompt, output schema,
taxonomy, provider settings, and processing options. The Status card uses
**View run settings** during execution and **View last run settings** afterward,
for the latest run in the current server session. After a restart, use Recent
Runs for historical settings. The viewer leads with profile/revision and
provider/model; full configuration and inference IDs are available under
collapsed **Technical identifiers**. These details are read
on demand through the authenticated
`GET /api/enrich/configurations/:id` endpoint; snapshots are bounded to 16 MiB,
and ordinary run/status responses carry identifiers only. API keys and Immich
credentials are excluded. Custom prompts and taxonomy are user-authored data
stored in the local database and included in backups.

Snapshots are deduplicated and referenced by job summaries and per-photo
processing records. Pruning the newest-100 job summary history never deletes a
snapshot referenced by a photo’s history. The per-photo caption endpoint also
returns its latest successful configuration ID, so those inputs remain
inspectable after their job summary is pruned. Two runs can have different complete
configuration IDs but the same inference ID—for example, after changing only
review thresholds or labels.

**Re-run failed photos** keeps the original provider and uses settings at the
retry’s start, with a new snapshot and a link to its source run. This lets a
corrected prompt fix earlier failures. Automatic retries within an execution
use its frozen configuration. Replaying historical settings exactly and named
profile selection are separate future features.

The Enrich page lists recent runs: what ran (slice title or library sweep),
when, provider + model, taxonomy + prompt versions, counters
(analyzed / ok / failed), and outcome (finished / cancelled / interrupted /
failed). Model
comparisons stay honest — you can always see which model and prompt produced
a batch of tags. Runs with at least one successful photo also show two
end-to-end rates: successful photos per minute and average wall-clock seconds
per successful photo. The rate line also carries its successful-photo sample
size, so a one-photo retry is not presented like a large comparison. These
cover the whole Pictaria path — Immich download,
image preparation, network, model response, and retries — so they are useful
for comparing your own setups but are not pure inference or token speed.
Already-enriched skips are not counted as successes. Failed and cancelled runs
retain their status alongside any rate earned by photos that did finish; a run
with no successful photo shows no rate.

Under **Settings → Enrich**, an optional **Inference host label** (for example,
`M4 Mac mini · LM Studio`) can be saved with each new run. The label is text
you supply: Pictaria does not inspect or infer remote hardware. Each run keeps
the label that applied when it started, so changing it never rewrites earlier
comparisons. Leading, trailing, and repeated whitespace is normalized so the
stored label matches what the run card displays.

The failed counter includes infrastructure failures
(rate limits, timeouts, outages), which don't count against the photos and
retry on the next run — see "When things go wrong" above for the split.

A card with failures that still need work offers **Re-run N failed photos**.
This starts a normal targeted run through the original provider (using that
provider's current connection and model settings) with the selected profile's
current revision at execution start, including both content and
infrastructure failures. The server recalculates the set when you click: a
photo that has since succeeded under any setup, disappeared from Immich, or
been deliberately discarded is left out. The content-failure cap is disabled
for this deliberate retry only, so photos already at the limit get another
chance; the run remains capped at 10,000 photos and records its own history
card. If the original provider is no longer configured, its retry button stays
disabled until its connection details are restored in Settings.

### Run history retention

Settings → Enrich → Run history controls how much history stays available:

- **Run summaries to keep:** 100–1,000 (default 100). The same limit applies
  to timing-run entries in Performance, including configuration attribution,
  overall outcomes and counters. Active timing runs are protected from pruning.
- **Run logs to keep:** diagnostic logs for the newest 0–100 runs (default
  100). Older summaries remain accessible without their logs. Each saved log
  is independently bounded to 500 entries and 256 KiB; 100 logs therefore
  occupy at most 25 MiB of log payload.

Settings overrides `ENRICH_HISTORY_RUNS` / `ENRICH_HISTORY_LOGS`, which override
the built-in defaults. Values must be whole numbers; environment values use
the normal bounded configuration parsing. Lowering either limit prunes at save
time (the UI asks for confirmation) and at startup. New runs also prune
deterministically, newest ID first. API clients changing these settings must
account for the same immediate deletion. Raising a limit cannot recover
already-deleted records; restore an earlier backup to recover that history.

Longer summary history does **not** increase photo/request-detail retention.
Older Performance entries may have incomplete or expired request metrics;
the page identifies this and uses only retained measurements. Per-run overall
counts and throughput remain available from retained job summaries. Failed-run
retry remains available while its summary and relevant processing history
exist, even when its diagnostic log has expired.

Synthetic measurements with 1,000 ordinary job summaries and 100 short logs
used about 0.5 MiB for the database. With 100 near-cap logs it used about
26 MiB. These are fixtures, not an installation-size promise: configuration
snapshots, enrichment results, photo/request details and other application
records have separate storage needs. SQLite may reuse freed pages without
shrinking the database file; retention limits logical records, not file size.

For each photo it keeps the newest normalized enrichment result needed by
Curate and caption search; older run metadata remains, but raw provider
response envelopes and superseded normalized payloads are not retained.

## Photo and provider-request timing

New Enrich work records two separate measurements. **Photo duration** starts
before image download and ends after local result persistence, including
image preparation, validation, all request attempts, and retry waits. It does
not include earlier metadata discovery, queue waiting, or later background
caption/tag synchronization. **Request duration** measures a dispatched HTTP
request through response-body reading and outer JSON decoding, including
upload/network/provider wait. Image encoding and local output validation are
outside this request timer. This is observed request latency, not pure model
inference time or tokens per second.

Durations are nonnegative milliseconds measured with a monotonic clock.
UTC ISO timestamps provide chronology and may move independently when the
system clock changes. A received HTTP response is not automatically a usable
result: only attempts marked `accepted` passed adapter extraction and local
schema/taxonomy validation. Other bounded outcomes are `http_error`,
`transport_error`, `timeout`, `cancelled`, `invalid_response`, `other_error`,
`response_received` (acceptance not established), and `interrupted`.
`running` marks work still in progress. HTTP status is stored when known;
no prompt text, image bytes, raw response bodies, headers, or free-form
errors are stored in timing records.

Every processed photo gets its own execution ID and each actual HTTP request
gets an ordinal within that execution. Validation and overload retries,
including extra requests made inside an adapter, remain separate requests.
Retry waits add to photo duration, not request latency. Existing retry rules
are unchanged: timeouts do not gain an automatic retry from instrumentation;
a later manual rerun has a new execution ID. A successful valid attempt
remains usable even if result persistence fails or the enclosing job later
fails or is cancelled. Latest-success results and human decisions remain
independent of this telemetry.

Skipped photos increment run counters by reason (already succeeded, human
discard, failure limit); they do not create measured executions or requests.
A download failure creates a failed photo execution with no provider attempt.
Cancellation before dispatch also creates no request. Photos excluded during
metadata selection are not executions. These distinctions prevent large
mostly-enriched scans from filling detailed history with zero-work rows.

A confirmed request timeout or cancellation has a measured finish and
elapsed duration. On shutdown or restart, unfinished work instead becomes
`interrupted`, retaining null finish/duration fields. Already completed
requests retain their exact measurements. A response received without
established validation stays `response_received`; it never enters a
successful-request sample. Late completion cannot overwrite interrupted
telemetry. Hard-crash runs remain discoverable in timing history even if no
terminal job summary was written. Older processing rows and logs cannot
supply accurate historical timings and are not backfilled as zero.

### Bounded timing storage and API

`enrich_timing_runs` links to the saved configuration, which retains provider,
model, and immutable profile-revision attribution. Modern job summaries and
active status expose `timingRunId`; a legacy/selection-only job may have none.
`enrich_photo_executions` links to a timing run, asset, and terminal processing
record where available. `enrich_provider_attempts` links to a photo execution.
The timing store is separate from the durable latest-success/results contract.

Retention keeps the configured number of timing runs (100 by default, up to
1,000), up to 10,000 detailed photo
executions, and up to 60,000 individual requests across runs. Photo/request
pruning is batched every 100 inserts (also on the first insert after opening),
so at most 99 additional terminal rows can accrue between passes. Running
work is protected. Deleting a timing run removes its photo/request details;
deleting photo detail removes its requests. Summary `photo_count` and
`attempt_count` are lifetime counts for that timing run, independent of
retained detail. Photo counts exclude skips, which have separate counters.
Timing expiration never deletes enrichment results, configuration snapshots,
profiles, human decisions, or queues. These fixed limits are independent of
job-log storage. See Run history retention above for the shared summary limit
and the independent log cap.

Authenticated read APIs, using the existing run cursor convention:

- `GET /api/enrich/timings` lists retained timing runs, including interrupted
  runs without a job summary; `job_run_id` is nullable.
- `GET /api/enrich/timings/:timingRunId/photos` returns photo execution detail
  plus the run metadata, retained count, and `truncated` coverage flag.
- `GET /api/enrich/timings/photos/:photoExecutionId/attempts` returns request
  detail plus the photo metadata, retained count, and `truncated` flag.

Each response has `items` and a nullable `nextCursor`. Pass that cursor back
with `cursor`; ordering is ascending record ID. HTTP `limit` defaults to 20
and is restricted to 1–50; repository reads clamp to at most 100. Detail fields
use the database's descriptive names (`duration_ms`, `started_at`, `outcome`,
`ordinal`, etc.). Expired/missing detail returns 404. A null `timingRunId`
means no trustworthy timing was recorded, not zero-duration work. Increasing
future retention cannot recover records already expired. Views must account
for `truncated` when interpreting samples or reliability totals.

### Performance comparison and photo details

**Enrich performance** is a dedicated page linked from Recent runs on Enrich
and from the Enrich section in Settings. **Runs** is the default view: a paged
history of run dates, provider/model/profile, photo outcomes, and total time.
Successful photos/minute appears beneath total time when available. Run dates,
status labels, provider names, and duration formats match across views; long
durations use minutes/hours while short requests retain precise seconds.
Enrich keeps compact outcome summaries and existing settings/log/retry actions;
**View details** links directly to the selected run on the performance page.
**Copy** copies the currently displayed run details, including pagination and
retention notices; load more photos/requests first to include additional rows.
Photo links open Immich in a new tab, explained on a separate line in the
scrolling introduction. Only the title and Copy/Close controls stay fixed.
Successful photos with one complete request show Enriched and total photo time
consistently; request timings remain recorded and included in request metrics.
Retries, failures, and incomplete timing retain their request details.
Routine already-enriched photos are omitted from run outcome summaries and
future per-photo logs. Discovery shows “Finding photos to enrich…” before
processing starts; an empty completed selection is described without claiming
the entire library is complete. Targeted runs retain explicit failure-limit
and discarded counts; library discovery filters those candidates in SQL.
Internal skip counters and discovery diagnostics are retained;
existing saved logs are unchanged. Budgeted library sweeps now use the
inventory discovery described above.

The **Compare setups** view starts with the three most recently used setups; **Show all comparisons**
includes every setup within the retained timing window (up to the configured
summary limit, at most 1,000 runs).
Ordering follows recent use, not speed. Each setup shows median successful
request time, successful requests and timeout counts, and overall
successful photos/minute. Request counts read “3 of 5 requests succeeded”
with timeouts separately identified. Profile/revision and host labels are
prominent, with a last-used date on each setup. **More metrics** includes the arithmetic mean,
request outcomes and retry counts, contributing photo/run counts, total
throughput time and successes, and timing coverage. No external metrics
service is needed.

A setup groups the same provider/model, effective inference inputs, profile,
and recorded host label. Changed prompts, vocabulary, model options, or image
settings form a different group. Same-profile revisions with identical
inference inputs can share a group even if their name or review policy changed;
the label/revision shown is from the most recent run. Run size and processing
options do not fragment the comparison. They can affect real-world throughput
and reliability, so use each run's saved settings when investigating a change.
Unknown inference identity or missing job/host attribution stays isolated by
run rather than implying equivalent setups.

Median and mean pool valid, measured `accepted` requests directly, including
those from failed, cancelled, and interrupted runs. They are not averages of
per-run medians or means. Request outcomes and retries describe the same
retained request population; a retry means ordinal greater than one. These
are requests, not unique photos. Sample counts may differ if an accepted
request has no usable duration. Negative, nonfinite, and durations exceeding
JavaScript's safe integer range are excluded; actual measured zero remains a
valid sample and displays as less than 0.01 seconds.

Overall comparison throughput pools successful photo counts and full elapsed
time from completed jobs that actually processed photos. Completed jobs with
zero successes still contribute their time; all-skipped jobs do not. Failed,
cancelled, active, and interrupted jobs do not enter that completed-job cohort,
although their accepted requests still contribute to latency. Throughput is
`total successes / total elapsed time`, never an average of individual run
rates. No completed processing jobs means unavailable throughput; a measured
zero-success cohort shows zero photos/min and unavailable seconds/success.
Individual-run end-to-end rates remain available in the run details, including
for historical runs without granular timing.

Selecting a run opens a dialog with structured **Run** and **Requests** summaries.
Run outcomes, photo counts, duration, and throughput appear once; request outcomes,
retries, median/average successful-request times, and sample sizes are visible
without expansion. Compare setups retains its **More metrics** disclosure.

Each photo shows its total time and individual provider requests directly, without
an accordion. The thumbnail and filename open that photo in Immich in a new tab
when a public Immich URL is configured. Successful requests omit routine HTTP 200
labels; error responses retain their status codes. Retention notices appear when
details are partial, rather than repeating full counts on every complete photo.
Photo and request lists remain paginated at 20 records. The photo response includes
each photo's first 20 requests, avoiding a separate initial HTTP request per photo;
additional requests use the existing paginated attempt endpoint.

The dialog fills the phone screen. Clicking the backdrop, Escape, or Close returns
focus to the invoking action; dragging from inside the dialog to the backdrop does
not dismiss it. Switching runs cancels the old view's requests so a late response
cannot replace the newly selected run.

**View run settings** on Enrich presents AI provider/model, profile/revision, and
image source on separate labeled lines above the immutable saved inputs.

A saved enrichment result and an execution's timing completeness are separate.
An interrupted execution with a saved result shows that enrichment is available
while timing is incomplete; it does not claim the result belongs to that
execution if the exact processing-row link was never written. Expired detail
answers **Timing expired**, while older runs without a timing link say timing
was not recorded. Partial samples show retained counts and explicit warnings.
Successful timing samples never hide recorded timeout/failure counts.

`GET /api/enrich/runs/:id` supplies a single retained run summary for direct
links, without loading logs or scanning intervening history pages. A missing
run returns 404, distinct from a retained run whose timing has expired.
`GET /api/enrich/performance?limit=3` supplies comparisons and timing summaries. Comparison limits are
1–1,000. Its `comparisons` contain setup context and metrics; `runs` contains
summaries up to the configured history limit (100 by default, at most 1,000);
`window` describes the cohort.
Aggregation reads at most 10,100 photo rows and 60,100 requests, accounting for
the timing store's pruning slack. It loads neither logs nor configuration
snapshot blobs. The existing photo detail endpoint additionally returns a
basename-only filename, exact linked result status when available, and whether
the photo has a saved enrichment result. Everything is read-only, computed
from retained SQLite data, and survives process restart without a new schema
or settings migration.

## Writing captions to Immich descriptions

Every enrichment produces a one-sentence caption. With **Settings →
Enrich → Write captions to Immich descriptions** turned on (off by
default), Pictaria copies each caption into the photo's description field in
Immich — so your photos become searchable *in Immich itself* by what's
actually in them, and the description shows up anywhere Immich shows one.
Until that option is enabled, captions remain searchable inside Pictaria but
Immich descriptions intentionally stay blank. After enabling it, use **Write
existing captions now** to backfill captions produced earlier.

The rule is **never knowingly overwrite a human**:

- An **empty** description gets the caption.
- A description **Pictaria wrote earlier** is updated if a newer enrichment
  produced a better caption.
- Anything else is someone's own words and is skipped permanently.

Pictaria reads the current description at its final safe decision point before
every write. Immich's supported API does not offer an atomic conditional
description update, so there is still an unavoidable, very narrow interval
between that check and Immich applying the update. Keep this optional setting
off if even that residual race is unacceptable.

Descriptions live in Immich's database; your original photo files are never
modified, and turning the setting off just stops future writes. New
enrichments queue automatically while the setting is on; **Write existing
captions now** (next to the setting) queues everything enriched before you
turned it on. Writes happen in the background from a durable queue — safe to
restart mid-way, and a Curate decision sync never waits behind them.

Compatibility note: the write uses Immich's `PUT /assets/:id`, which Immich
v3 marks deprecated in favor of an identical PATCH route. The old route
still works on every supported Immich version and the replacement is not yet
published in Immich's API spec, so Pictaria deliberately stays on PUT — the
switch is tracked and will happen once the replacement is public and the
supported-version floor allows it.

## Review data model (Curate)

Two independent axes per photo:

- **Bucket** — what the AI thinks: `candidates`, `should_review`,
  `unlikely` (configurable in the taxonomy's review policy).
- **State** — what the human decided, stored as `frame/*` tags:
  `frame/eligible` (approved), `frame/favorite`, `frame/never-show`
  (rejected), `frame/reviewed`. No `frame/*` tag = undecided, which is what
  the Curate queue shows.

### How a photo picks its bucket

Bucket assignment is **not** a range check on the quality score. Tags gate,
scores sort — a two-step pipeline:

**Step 1 — model proposals become applied tags.** Each enrichment run
proposes `candidate_tags` and `exclusion_reasons`, every entry carrying its
own 0–1 confidence. A proposal only becomes an applied tag when its
confidence clears the taxonomy's threshold:

| Threshold | Default | Gates |
| --- | --- | --- |
| `exclude` | 0.70 | any `ai/exclude/*` tag (screenshot, document, private, blurry, …) |
| `semantic` | 0.75 | ordinary content tags |
| `frame_worthy` | 0.78 | the `ai/quality/frame-worthy` tag specifically |

**Step 2 — applied tags pick the bucket**, evaluated in priority order,
first match wins:

1. **Unlikely** — the photo carries *any* applied `ai/exclude/*` tag.
   Exclusions trump quality: a photo that is both frame-worthy and a
   screenshot lands here.
2. **Candidates** — carries `ai/quality/frame-worthy` (and no exclusion).
3. **Should Review** — the fallback: neither confidently excluded nor
   confidently frame-worthy. Borderline photos live here by construction.

**Scores order, tags decide.** The run also returns numeric quality scores
(`frame_worthy_score` and friends). Those never choose a bucket — they set
the sort order *within* every bucket and feed the reason chips
(`review_low` 0.65 marks "borderline"; `privacy_review_low` 0.45 flags
privacy uncertainty). What gates Candidates is the confidence the model
attached to the frame-worthy *tag proposal*, against the 0.78 bar — which
is why a photo with a respectable score can sit in Should Review: the model
liked it numerically without being confident enough in the frame-worthy
call itself.

Three behaviors layer on top: a Stack appears in its best undecided
member's bucket, so one Candidate lifts its siblings' Stack into
Candidates; human decisions are a separate axis that always outranks
buckets; and undecided Candidates auto-display on the frame while every
other bucket waits for a decision.

All of this is policy, not code: the buckets, matching rules, and
thresholds live in the taxonomy JSON (Settings → Enrich), and
review-policy changes re-bucket Curate immediately without invalidating any
enrichment run.

### Human tags

The `frame/*` tags are the durable record of your review decisions and the
only signal downstream features trust: **`frame/eligible`** — approved; a
manual "show it" that outranks any AI quality or privacy opinion.
**`frame/favorite`** — the Favorite action; always applied together with
`frame/eligible` (a favorite is approved too). **`frame/never-show`** —
rejected; the photo stays off the frame no matter what any model thinks.
**`frame/reviewed`** — seen without approving (what *Skip rest* applies to a
Stack's non-keepers). Approving removes a rejection and vice versa, so the
tags never contradict each other; the *Clear* action removes all four and
returns the photo to undecided.

Membership in the Curate queue is explicit (the review list): photos enter
via *Send to Curate* or an enrich run with *Send to Curate* on — enrichment
alone no longer implies review. Databases that predate the review list
grandfather every already-enriched photo in once, preserving old behavior.
Photos sent without enrichment appear in Candidates marked "not enriched".

Human decisions always win for display eligibility; buckets only organize the
queue. Decisions are recorded locally first (source of truth), then pushed to
Immich by the sync worker.

After a single-photo or Stack decision, the confirmation at the bottom of
Curate offers **Undo (Z)** for five seconds. The decision still applies and
the queue advances immediately; selecting Undo, or pressing `Z`, clears that
most recent decision and returns the affected photo or whole Stack to the
queue. A newer decision replaces the pending Undo. The multi-select bulk bar
keeps its existing deliberate recovery path through the Decided tab.

### Stacks and the AI referee

Photos of the **same moment** are grouped by three signals: capture time
(shots within ~15 seconds always chain; shots up to ~3 minutes apart chain
only when they also look alike, so a long walk shooting a different subject
every minute doesn't glue into one giant group), near-identical thumbhashes
on the same day (re-shoots minutes or hours apart, double-uploads with
different timestamps), and Immich's own duplicate detection. The Curate UI
calls these groups **Stacks** (the queue has Stacks / single-photo tabs so
you can work them as separate passes). Each Stack appears as **one stacked
card** in the queue showing its suggested keeper — the highest frame-worthy scorer
(aesthetic score breaks ties). From the card you can **★ Keep, skip rest**
directly, or open the **compare view** to see every member side by side with
scores and per-photo buttons (`K` keeps the best there too; click any member
to zoom). "Skip rest" marks the others reviewed — never rejected;
near-identical shots of a good moment are redundant, not junk. The star is a
suggestion: every button still works on every photo, and a decision you
already made on a member is never overwritten. Prefer a flat photo-by-photo
queue? Turn grouping off under Settings → Curate.

Thumbhash matching remains exact across every pair on ordinary shooting days
(up to 256 review photos with thumbhashes). An unusually dense import or
timelapse day switches to a deterministic bounded candidate window, with a
hard 250,000-comparison ceiling for the full Curate annotation rebuild.
Byte-identical hashes, capture-time bursts, and Immich duplicate groups still
join independently of that ceiling. The overload behavior can therefore miss
a visually near-identical pair, but cannot create a false-positive Stack or
monopolize the server with quadratic comparison work. Malformed descriptors
or anomalous values above the conservative 64-byte ThumbHash envelope are
ignored for visual matching.

**Stacks are capped at 10 photos.** A "same moment" group that comes out
larger is split into smaller stacks at its largest internal time gaps
(repeatedly, until every piece fits; a 1-photo piece becomes a normal
single card; a run with no meaningful gaps — a same-timestamp import batch,
a fixed-interval timelapse — splits evenly instead). Two reasons. First, the AI referee sends a whole stack to the
model in one multi-image request, and ranking quality degrades past roughly
ten images — an earlier design capped the *referee* instead (at 8) and
silently skipped anything bigger, which left big stacks permanently
unrefereed and made Curate's stack count disagree with the referee's
"remaining" count. With the cap at the grouping layer, every stack the UI
shows is one the referee can judge (one narrow exception: a group whose
images can't fit the referee's byte budget even at thumbnail size is
deferred rather than judged incomplete — see the budget paragraph in the
referee section below). Second, in practice oversized groups are
rarely true bursts — they're walks or events glued together by transitive
time-chaining, and their biggest time gaps are natural seams, so the split
usually lands where a human would put it anyway. The trade-off to know
about: for a genuinely huge burst, the referee ranks each chunk
independently, so "Keep best, skip rest" keeps one photo per chunk rather
than one overall. *This cap-and-chunk behavior is a deliberate first cut and
likely to be revised* — candidates for a future version include refereeing
sub-batches with a winners round (one global pick for any size) and smarter
chain-breaking during grouping itself.

The star has a confidence ladder. With no enrichment there is no star —
groups still stack, and the compare view makes picking fast. With scores, the
highest-scoring member gets a **silver ★**. With the **AI referee** enabled
(Settings → Curate), a model looks at each group *side by side* — something
per-photo scores can't do — and its pick gets a **gold ★** plus a short
why-line under every member in the compare view (including an explicit
"eyes closed" flag). The referee's rules: photos with people beat photos of
the same scene without people unless the people shot is technically bad;
open eyes and sharp faces beat blinks and blur. It runs on its own whenever
enrichment is idle, works through the backlog most-undecided-first (group
size breaks ties), and re-referees a group only if its membership changes. There is deliberately
no start or cancel: enrichment always has priority on the model — starting
an enrich run never waits for the referee (the referee finishes the one
Stack it's judging, which can share the model for a few minutes, then
pauses until the run ends and resumes by itself). Turning the toggle off
in Settings stops it after the in-flight Stack; existing verdicts stay.
Errors are handled the patient way: when a judgment fails — the model
overloaded (429), unreachable, or returning garbage — the strip shows
*"retrying after an error"* with the message. The referee follows a provider's
`Retry-After` guidance up to five minutes, or waits five minutes when no hint
is supplied, before touching the provider again. The stack is **not**
marked judged, so the exact same group is retried once the backoff ends.
Nothing is skipped or lost to a flaky provider; a batch just takes longer.
The activity popup keeps the recent errors if you want the history.

Image bytes are budgeted, not left to luck. One group's request never
exceeds a hard aggregate ceiling — 96 MB of raw image bytes by default,
configurable via `REFEREE_GROUP_BUDGET_MB` (clamped 8–2048) for small
containers; building the provider request multiplies raw bytes by roughly
3.5×, so the ceiling is what keeps one big stack from ballooning a small
box's memory — and no single download may exceed 25 MB. Members are
fetched starting at the configured image size (`IMAGE_SOURCE` — so
preview → thumbnail by default, original → preview → thumbnail only when
originals are configured, thumbnail alone in thumbnail mode), degrading
down the chain as the budget tightens, and when a greedy pass can't fit
everyone, the whole group retries one size tier lower before giving up. A group that can't fit even with every
member at thumbnail size is **deferred**: logged, counted in the Curate
strip ("N stacks deferred — over the photo byte budget"), and left
unjudged rather than judged from an incomplete set. Decide a deferred
stack by hand in the compare view, or raise the budget and restart the
server to retry it (a membership change also makes it retryable). Deferral
is the one case where a stack the UI shows goes unjudged. When a moment contains clearly different subjects —
shots of people and separate shots of just the scenery — the referee assigns
subject groups and Curate shows one stack per subject, each with its own
gold-★ pick (a subject with only one photo becomes a normal single card).
A progress strip at the top of Curate shows the current run — stacks judged
since the queue was last empty vs what's still queued (the bar appears when
work shows up and disappears once the queue drains; the all-time judged
total rides along at the end of the line) — and what the referee is doing
right now, with a **Pause** button next to the bar:
pause when you want the model (or its memory) back for something else — the
Stack being judged finishes first (the strip says so), then the referee idles
until you hit Resume. Pause lasts until you resume or the server restarts;
the Settings toggle remains the durable off switch. The referee provider/model are separate
settings —
a smaller vision model is fine here, since comparing needs less discipline
than tagging. Suggestions only, as always: the referee never decides.

### Curating while an enrichment run is streaming photos in

Curating during a live run is **fully supported and always safe** — every
decision is recorded per photo and is never invalidated, moved, or
reinterpreted by anything a stack does. But it can *look* strange, and it's
worth knowing why. A run sends each photo to Curate the moment its
enrichment finishes, and every arrival regroups the timeline: a growing
"same moment" chain can cross the 10-photo cap and split at its largest
time gap, so **stack counts change, stacks split or regroup, and the
referee re-judges** as membership settles. New arrivals can also form a
stack *around photos you decided long ago* — those show up in the compare
view as dimmed stubs with their outcome (`✓ kept` / `skipped`), which is
the group healing itself, not a photo coming back for re-review. While a
run is active, Curate shows a small note next to the photo counts —
*"Enrich is running — Stacks may change as photos are added"* — so the
movement doesn't read as a glitch.

The same healing covers cancelled runs: cancel a run mid-slice and some
stacks near the edge exist only partially. Whenever the rest of the slice
is enriched — tomorrow, next month — the missing members arrive, the stack
completes itself, your earlier decisions ride along as stubs, and
"Keep best, skip rest" still only ever touches undecided members. The one
real cost of deciding mid-stream is context, not correctness: you may judge
part of a moment before its siblings have arrived. If stable stacks matter
for a big triage session, let the run finish first; otherwise curate away
and expect the queue to breathe a little while enrichment is running.

## Endpoints

- `GET|POST /api/enrich/profiles` — bounded metadata list or create a profile
  with `{ name, systemPrompt, userTemplate, taxonomy }`.
- `GET /api/enrich/profiles/builtin` — current configured template files.
- `POST /api/enrich/profiles/validate` — validate the same create/edit fields
  without saving or dispatching model work.
- `GET|PATCH /api/enrich/profiles/:id` — full current profile or save an edit;
  PATCH also requires `expectedRevisionId` for optimistic concurrency.
- `POST /api/enrich/profiles/active` — activate `{ profileId, expectedActiveRevisionId? }`.
  List responses include `activeProfileId` and active-profile metadata. The
  optional expected revision rejects stale activation requests with 409.
- `POST /api/enrich/profiles/:id/archive` — `{ archived: true|false }`.
- Start routes (manual, queue run, Run all, history retry) accept optional
  `expectedActiveRevisionId` for stale-client protection. They always use the
  active profile and reject `profileId`/`profileRevisionId` overrides. Queue
  insertion also rejects profile overrides. Run-all entries accept `skipAnySuccessful`.
- Failure-limited reads/discard may specify `profileId` for diagnostics; omission
  uses the active profile. This does not activate it or override execution.
- The old per-profile `/default` and per-queue `/profile` mutation endpoints
  return 410 with guidance to use the active-profile workflow.

- `GET /api/enrich/status` — runner state, live counters, log tail, provider
  availability, library stats, `enabled`.
- `GET /api/enrich/runs` — newest-first, stable cursor pages of retained run
  summaries, including a live `retryableFailures` count for each returned
  history card. Accepts `cursor` and `limit` (default 20, maximum 50) and
  returns `{ runs, nextCursor, total }`.
- `POST /api/enrich/runs/:id/retry` — re-evaluate and start a targeted retry
  of that run's content and infrastructure failures that still need work,
  using the original provider's current configuration; accepts optional
  `{ sendToCurate }` (403 when enrichment is off, 404 when history expired,
  409 while another run or queue resolution is active).
- `POST /api/enrich/run` — start a library sweep, or a targeted run with
  `assetIds`; `retryFailureLimited: true` (targeted only) turns the
  per-photo failure cap off for that run (403 when enrichment is off;
  409 while a run is active).
- `GET /api/enrich/failure-limited` (optional `?provider=`) — the stuck
  set behind the Retry strip: `{ count, assetIds, truncated,
  maxFailuresPerAsset, provider, model }` for photos at the failure limit
  under the active setup (no success under any setup; first 10,000,
  least-recently-attempted first). Pure local read.
- `GET /api/enrich/failure-limited/details` (optional `?provider=`) — the
  same stuck set as human-readable rows for the Details popup:
  `{ rows: [{ assetId, originalPath, fileCreatedAt, lastError,
  lastFailedAt }], count, truncated, discarded, immichUrl }` (first 500
  rows; `discarded` is the capped discarded listing below). Pure local
  read.
- `GET /api/enrich/discarded` — discarded photos (newest first, capped at
  500 with an honest `total`/`truncated`), each with its latest failure
  message: `{ assets, total, truncated, immichUrl }`. Pure local read.
- `POST /api/enrich/discarded` — either `{ all: true, provider? }`, which
  resolves the *current* stuck set server-side (up to 10,000, like Retry)
  and discards exactly that, or `{ assetIds }`, which is re-validated
  inside the write itself: a photo with a successful run anywhere is
  refused (`skippedSuccessful` — a stale client snapshot can never lock
  an enriched photo out of future runs), as is one that isn't genuinely
  stuck — marked missing from Immich or without a single content failure
  on record (`skippedNotStuck`; a missing photo that reappears should
  get fresh attempts, since the discard stamp survives `upsertAsset`).
  Local-only; returns `{ discarded, skippedSuccessful, skippedNotStuck,
  assets, total, truncated }`; `all: true` adds `count` and
  `discardTruncated` — the operation's own 10,000-item cap, distinct
  from `truncated`, which always describes the 500-row reference
  listing. An explicit selection is limited to 1,000 canonical lowercase
  Immich UUIDs; an empty, malformed, or oversized id list without `all` is a
  400 and changes nothing.
- `POST /api/enrich/discarded/restore` — `{ assetIds }` → unflag; returns
  `{ restored, assets, total, truncated }`. The same 1,000-ID canonical batch
  boundary applies atomically.
- `POST /api/enrich/cancel` — cancel the run and abort its active provider request.
- `GET|POST /api/enrich/queue`, `POST /api/enrich/queue/:id/run`
  (`{ provider, sendToCurate, reopenDecided, skipAnySuccessful }`),
  `DELETE /api/enrich/queue/:id` — the Send-to-Enrich queue (deleting the
  item behind an active run is refused with 409 `queue_item_running`). Queue
  reads use stable oldest-first cursor pages: `GET` accepts `cursor` and
  `limit` (default 50, maximum 100) and returns `{ items, nextCursor, total }`.
  Mutation responses retain their existing fields and include the same first
  bounded page. Exact duplicate slices remain no-ops even at capacity; new
  work is rejected with `409 enrich_queue_full` or, above the 64 KiB item
  boundary, `413 enrich_queue_item_too_large`.
- `POST /api/enrich/queue/run-all` — chain queued jobs (Run all). Takes a
  `plan` array of `{ id, sendToCurate, reopenDecided }` entries (optional
  `provider`); an empty or missing plan is a 400 `empty_plan`.
- `POST /api/review/send` — add a slice to the Curate review list directly
  (no enrichment; works with enrichment off). Returns
  `{ total, added, alreadyListed, truncated }`.
- `POST /api/review/coverage` — `{ assetIds }` → per-photo
  `{ enriched, curated }` flags (local reads; powers the Insights grid
  marks).
- `POST /api/review/coverage-summary` — `{ filters }` → whole-slice
  `{ total, enriched, curated, truncated }` (slices over 5,000 photos are
  sampled).
- `GET /api/enrich/captions/search` (`?q=…`), `GET /api/enrich/captions/terms`
  — search the local caption index / list its most common terms. Pure local
  reads; work with enrichment off.
- `GET /api/enrich/captions/writeback` — description-writeback status
  (`enabled`, `pending`, `written`, `skipped`, `failed`, `lastError`).
- `POST /api/enrich/captions/writeback/backfill` — queue every enriched
  photo with a caption for description writeback (409 when the setting is
  off).
- `GET /api/enrich/runs` — paged retained run history (newest first; default
  20, maximum 50 per request).
- `GET /api/enrich/runs/:id/log` — one run's full log.
- `GET /api/enrich/caption?assetId=…` — one photo's full stored caption
  (the Curate lightbox uses it).
- `GET /api/enrich/prompts` — selected/active profile prompt text plus
  built-in text; optional `?profileId=`.
- `GET /api/taxonomy` — version, buckets, thresholds, raw source, response-field contract, full tags per
  category, hard exclusions. Optional `?profileId=` selects an inference
  taxonomy; omission returns the shared live Curate policy.
- `GET /api/review/assets`, `POST /api/review/decision`,
  `GET /api/review/sync-status` — the Curate review API. A decision accepts at
  most 1,000 canonical lowercase Immich UUIDs, all still present in the live
  Curate set. Decisions are committed locally with their durable Immich work
  or rejected atomically when the bounded synchronization backlog is full;
  background reconciliation processes photo IDs in 50-photo slices.
  On startup, restored queue entries are bounded and validated before any
  Immich request. Scalar fields that SQLite cannot safely materialize are
  parked inside the database first, and stored tag changes must remain a
  compatible subset of their named decision action. A malformed entry is
  parked with a sanitized diagnostic so later valid decisions can continue.
- `GET /api/review/thumbnail/:id` — authenticated thumbnail proxy for the
  Curate grid and compare view.
- `GET /api/review/sync-dead`, `POST /api/review/sync-dead/retry`,
  `DELETE /api/review/sync-dead/:id` — Immich-sync entries that exhausted
  their retries or failed restored validation: list, retry, dismiss. The
  newest 100 are listed at once;
  unresolved jobs remain durable until they succeed or the owner dismisses
  them explicitly. Retry alone cannot repair a malformed restored entry: it
  will be validated and parked again without contacting Immich. Recover or
  reapply the affected decisions, then dismiss the malformed entry. If its
  photo-ID list is the malformed field, the affected photos may not be
  identifiable from that entry, so verify recent Curate decisions in Immich.
- `GET /api/review/referee/status` — AI referee worker state (enabled,
  working, paused, current group, remaining backlog, deferred-group count,
  verdict stats).
- `GET /api/review/referee/activity` — the referee's recent activity and
  error history (the strip's popup).
- `POST /api/review/referee/pause` — body `{"paused": true|false}`; pause
  is cooperative (the in-flight group finishes) and not persisted across
  restarts.


### Enrich master switch and dependent features

Turning off **Enable AI enrichment** prevents new manual and Daily Enrich runs
and pauses caption writeback. Settings disables Daily Enrich and caption controls
with “Paused while Enrich is off,” preserving their saved preferences. Turning
Enrich back on restores those preferences; the normal Daily Enrich catch-up
rules still apply. An enrichment execution already started keeps its run settings.

Pending caption writes remain queued. A description update already sent to Immich
can finish, but further writes pause, including when Enrich is disabled while
reading a photo's existing description. **Write existing captions now** is also
unavailable while Enrich is off. Existing Immich descriptions are not removed.
