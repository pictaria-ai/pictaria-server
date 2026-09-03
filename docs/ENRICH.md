# Enrich

AI models look at your photos and propose tags from a controlled taxonomy,
plus a one-sentence caption. Proposed tags land in **Curate** for human review.
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
   (raw + normalized output, provider, model, prompt and taxonomy versions)
   locally.

Enrichment runs are always dry runs against Immich. Tags reach Immich only
through Curate decisions, via a durable background sync worker that verifies
and repairs both required additions and required removals after writing. For
that sync, enable **Tags** under **Immich Account Settings → Features** for the
account whose API key Pictaria uses, and grant that key `tag.read`,
`tag.create`, and `tag.asset`.

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

- **Library sweep** — the Enrich page's *Start*: scans newest-first,
  analyzes up to the *Photos* budget (skips don't consume the budget).
  *Only unenriched* (default on) skips photos that already have a
  successful run from any model.

**"Enriched" is per setup**: a photo counts as enriched for a specific
combination of provider + model + prompt version + taxonomy version.
Unchecking *Only unenriched* therefore means "re-enrich whatever my
current setup hasn't processed yet" — photos enriched by an older model
become eligible again, but exact-duplicate re-runs are always skipped
(runs report these as "skipped N already enriched"). Arming a new model,
or customizing the prompt (which stamps runs with the prompt version plus
`-custom` — `v2-custom` today), is what makes re-enrichment happen; the
latest successful run per photo is what Curate and the caption data use.
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
- **Cancellation** is cooperative: the in-flight photo finishes first
  (30–60 s on large local models). Cancel doubles as pause — a queued job
  stays in the queue unless its run finishes cleanly, and running it again
  continues where it left off (already-enriched photos are skipped).
- **Recent runs** starts with the newest 20 summaries. **Load more** walks
  through all 100 retained summaries without loading their potentially large
  logs; each log is fetched only when you open it. Retry actions remain
  available on older loaded runs and always recalculate which failed photos
  still need work before starting.

### Enrich and Curate are composable

Enriching and reviewing are separate pipelines that compose. Every run has a
**Send to Curate** option (on by default): photos join the Curate review
queue as the run enriches them (photos that were already enriched count
too). Photos that fail are never listed — they stay with the queued job and
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

The **Taxonomy & prompt** panel on the Enrich page shows exactly what the
model is told: every approved tag by category, hard exclusions (photos with
these are never auto-shown), confidence thresholds, the response fields the
model must fill in, and the full prompt text.

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

The schema's fields (also listed with their uses on the Enrich page):

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
Enrich. The schema's *field list* is fixed: Curate's buckets, the star
picks, caption search, and Best-of ranking all read these fields by name,
so removing one would break the features downstream of it. Editing the
taxonomy already reshapes the schema where it is meant to flex — the tag
lists inside `candidate_tags` and `exclusion_reasons` are generated from
your approved tags on every request.

- **Taxonomy** — `taxonomy/v1.json` (`TAXONOMY_PATH`). Configuration, not
  code: categories, manual tags, hard exclusions, thresholds, and the review
  bucket policy. Editable in Settings → Enrich without touching files:
  "Load current taxonomy to edit" starts from what is in force, and saving
  applies immediately. Edits must bump the `version` string — a content
  change that keeps the old version is rejected, because run history and
  the skip-already-enriched logic are keyed on it. Bumping the version makes
  every photo eligible for re-enrichment under the new taxonomy;
  already-enriched photos keep their old tags until re-run, and threshold
  changes re-bucket Curate immediately (decisions are never touched).
  Clearing the override returns to the shipped file. Overrides live in the
  settings store on the data volume, so they survive image updates.
- **Prompts** — `prompts/` (`PROMPTS_DIR`/`PROMPT_VERSION`). Both the system
  prompt and the per-photo template can be overridden in Settings →
  Enrich without touching files ("Load built-in text to edit" starts you
  from the shipped prompt). The per-photo override must contain
  `{approved_tags}`. Runs with an override record the prompt version plus
  `-custom` (`v2-custom` on the current prompt), so every result traces
  back to the exact prompt that produced it.

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
  Failures are classified by *whose fault they are*. A provider error that
  is clearly environmental — a timeout or dropped connection, an auth
  error (401/403), a rate limit (429, e.g. "model currently overloaded"),
  or any 5xx — records as an **infrastructure failure**: it shows up in
  the run's failure count, but it is never counted against the photo, and
  the next run over the same slice retries every affected photo
  automatically. Nothing to reset, nothing lost — when a cloud model has
  a bad day and bounces 15% of a run, one re-run later (with "Only
  unenriched" on, the default) mops them all up. Immich-side network
  errors and 5xx are treated the same way.
- **A photo that keeps genuinely failing is dropped after two strikes.**
  Failures the provider pins on the request itself — most commonly a
  response the schema rejects (an unparseable answer, too many tags) —
  count against the photo, and after **two** failed runs it is skipped
  with "reached 2 failed run(s)". The allowance is per *setup* (provider +
  model + prompt version + taxonomy version): a photo one model can't
  handle gets a fresh chance under any other model, prompt, or taxonomy.
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
  in place; a server restart records the run as *interrupted*. Either way,
  running the item again continues where it left off.

## Run history

The Enrich page lists recent runs: what ran (slice title or library sweep),
when, provider + model, taxonomy + prompt versions, counters
(analyzed / ok / failed), and outcome (finished / cancelled / failed). Model
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
provider's current connection and model settings), including both content and
infrastructure failures. The server recalculates the set when you click: a
photo that has since succeeded under any setup, disappeared from Immich, or
been deliberately discarded is left out. The content-failure cap is disabled
for this deliberate retry only, so photos already at the limit get another
chance; the run remains capped at 10,000 photos and records its own history
card. If the original provider is no longer configured, its retry button stays
disabled until its connection details are restored in Settings.

Pictaria retains the newest 100 run summaries and bounded diagnostic logs.
For each photo it keeps the newest normalized enrichment result needed by
Curate and caption search; older run metadata remains, but raw provider
response envelopes and superseded normalized payloads are not retained.

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
*"retrying after an error"* with the message, the referee waits five
minutes before touching the provider again, and the stack is **not**
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
- `POST /api/enrich/cancel` — cooperative cancel.
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
- `GET /api/enrich/prompts` — effective + built-in prompt text, customized
  flags.
- `GET /api/taxonomy` — version, buckets, thresholds, raw source, response-field contract, full tags per
  category, hard exclusions.
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
