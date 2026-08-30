# Configuration reference

Everything can be configured through environment variables (a `.env` file
works for bare-Node runs; the Docker image reads normal container env), and
most day-to-day values can also be changed at runtime from the Settings page —
those are marked **UI**. A value saved in the UI overrides the environment
until cleared and applies immediately, no restart. The listen address/port,
data paths, and `APP_PASSWORD` are deliberately environment-only.

### Settings map

- **Server** owns the Immich connection.
- **AI Providers** owns reusable provider credentials, endpoints, and
  provider-default model identifiers, separated into Local Models and Cloud
  Models.
- The **Enrich page** chooses the provider for new enrichment runs;
  **Settings → Enrich** owns enrichment behavior, prompts, and taxonomy.
- **Settings → Curate** owns the AI-referee provider/model override and
  other review behavior.
- **Settings → Voice TTS** owns the voice-answer provider, Interesting and
  Ask model choices, and TTS provider/model/voice/output choices. The
  ElevenLabs API key is the one deliberate split: it lives under AI Providers
  with the other credentials but is used only for TTS.

See [Recommended AI models](RECOMMENDED-MODELS.md) for a dated set of practical
starting points. The settings hierarchy does not change the environment
variables below or their precedence: a saved UI value overrides its
environment counterpart until cleared.

## Docker Compose image selection

`PICTARIA_IMAGE_TAG` is consumed by Docker Compose rather than passed into the
Pictaria Server container. Normal installations should leave it unset so the
release Compose file selects its matching image version; set it only when
deliberately testing another published tag.

| Variable | Default | Notes |
| --- | --- | --- |
| `PICTARIA_IMAGE_TAG` | `1.0.0` | Published container image tag selected by `docker-compose.yml`. Image tags omit the `v` used by Git release refs (`1.0.0` versus `v1.0.0`). |

## Required

| Variable | Default | Notes |
| --- | --- | --- |
| `IMMICH_BASE_URL` | — | Server-reachable Immich address over HTTP or HTTPS, e.g. `http://immich.local:2283` or `https://photos.example.com`. It must be the final URL; redirects are rejected. A trailing `/api` is stripped, and a scheme-less address defaults to HTTP. Can also be set on first run from Settings → Server. When Immich lives on another machine, a Tailscale IP or MagicDNS name works anywhere an address does — encrypted end-to-end, no port exposed to the LAN. **UI** |
| `IMMICH_API_KEY` | — | An Immich API key for your account (Immich → Account Settings → API Keys). Full access is not required: the least-privilege checklist — 15 recommended, 14 strict minimum with the opt-in write-backs left off — is in the **Connect Immich** step of [GETTING-STARTED](GETTING-STARTED.md), verified against Immich v2.7.5 and v3.1.0. Granting **All** also works. See [Immich compatibility](IMMICH-COMPATIBILITY.md). **UI** |

### Immich HTTP, HTTPS, and private CAs

`IMMICH_BASE_URL` is the address the Pictaria Server process can reach. Plain
HTTP is normal on a trusted LAN or private VPN. HTTPS with a publicly trusted
certificate works without extra configuration. Certificate validation is
never bypassed.

For HTTPS issued by a private/home CA, make that CA available to Node inside
the container. Add the following entries to the `pictaria` service in your
Compose file, replacing the host path with your CA certificate:

```yaml
services:
  pictaria:
    environment:
      NODE_EXTRA_CA_CERTS: /certs/home-ca.pem
    volumes:
      - ./home-ca.pem:/certs/home-ca.pem:ro
```

Restart the container after changing the CA. Do not use
`NODE_TLS_REJECT_UNAUTHORIZED=0`; that disables certificate validation for
every HTTPS request made by the process.

`IMMICH_PUBLIC_URL` is different: it is the address a browser uses for links
from Pictaria back to Immich. For example, the server might reach Immich over
internal HTTP while browsers use an HTTPS reverse proxy:

```env
IMMICH_BASE_URL=http://immich:2283
IMMICH_PUBLIC_URL=https://photos.example.com
```

Both values should name the Immich root, without a trailing `/api`. Pictaria
normalizes that one trailing segment if supplied.

## Strongly recommended

| Variable | Default | Notes |
| --- | --- | --- |
| `APP_PASSWORD` | — | Protects the whole API and web UI. Blank or missing refuses server startup unless the separate `ALLOW_INSECURE_OPEN=true` escape hatch is set. Failed attempts are delayed ~1s. Programmatic callers send `X-App-Password` or `Authorization: Bearer`; the web UI exchanges the password for an HttpOnly session cookie (30 days) via `POST /api/session`, so the browser never stores the password. Cookie signatures also use a random per-installation secret, preventing a cookie from acting as a password verifier. |
| `ALLOW_INSECURE_OPEN` | `false` | Dangerous explicit opt-in to start without `APP_PASSWORD`. This disables authentication for the entire API and web UI: anyone who can reach the server can browse photos and perform Immich-backed mutations. Browser requests reject foreign/null origins and foreign Fetch Metadata; native clients without browser headers remain supported. Intended only for deliberate isolated-network deployments; the UI shows a standing warning banner. |

## Server

| Variable | Default | Notes |
| --- | --- | --- |
| `HOST` | `0.0.0.0` | Listen address. Bind no wider than you need — e.g. a Tailscale address serves only your own devices; see [Exposing beyond your LAN](../README.md#exposing-beyond-your-lan). | Use `HOST=::` for dual stack support.
| `PORT` | `4080` | Listen port. |
| `SESSION_COOKIE_SECURE` | `false` | Adds the `Secure` attribute to the browser session cookie so it is never sent over plain HTTP. Set to `true` **only** when the server is reached exclusively through an HTTPS reverse proxy — with it on, login over plain `http://` stops working. The proxy must preserve the public `Host` header so cookie-authenticated mutations can pass Pictaria's same-origin check; TLS may still terminate at the proxy. See [Exposing beyond your LAN](../README.md#exposing-beyond-your-lan). |
| `BROWSER_ALLOWED_HOSTS` | *(empty)* | Comma-separated browser-facing hosts or `host:port` authorities allowed to serve the UI, use cookie sessions, and reach the API in deliberate open mode. Add each public custom domain explicitly; IP addresses, single-label LAN names, `.local`, `.home.arpa`, and Tailscale `.ts.net` names work without an entry. Values are hosts, not URLs, and an entry with a port matches only that port. See [Exposing beyond your LAN](../README.md#exposing-beyond-your-lan). |
| `TRUSTED_PROXY_IPS` | *(empty)* | Comma-separated exact IP addresses or CIDRs for reverse proxies allowed to supply `X-Forwarded-For` (for example `127.0.0.1` or `172.16.0.0/12`). Leave empty for direct LAN/VPN access. Configure only addresses that can actually connect directly to Pictaria; never use a catch-all such as `0.0.0.0/0`. Invalid entries refuse startup. Trusted chains are evaluated from right to left so caller-prepended values cannot choose the lockout key. |
| `REQUEST_TIMEOUT_MS` | `60000` | Timeout for outbound Immich requests. |
| `PICTARIA_SUPPORT_PUBLIC_KEY` | *(pinned key)* | Overrides the pinned supporter-key verification key (PEM) — the key-rotation escape hatch, also used by tests. A malformed value makes every supporter key read as invalid; the failure is logged when a key is first checked, not at startup. |
| `IMMICH_PUBLIC_URL` | `IMMICH_BASE_URL` | Browser-facing HTTP or HTTPS Immich root used for deep links in the web UI (person pages, map, search). Set it only when your browser reaches Immich at a different address than the server does—for example, internal HTTP for the container and an HTTPS reverse proxy for browsers. **UI** |

## Storage

All persistent state lives in these files (default directory `./data`; the
Docker image points everything at the `/data` volume).

Pictaria also creates `session-secret` beside `SETTINGS_PATH`, with mode
`0600`. It is internal installation state rather than a configurable secret:
it keeps browser sessions valid across restarts, while changing
`APP_PASSWORD` still invalidates them. If it is lost or regenerated, browsers
must log in again and enabled Smart Album schedules are paused as **Needs
review**; their rules, albums, and manual **Run** action remain available.

| Variable | Default | Notes |
| --- | --- | --- |
| `DATABASE_PATH` | `data/enrichment.sqlite` | Enrichment results and review decisions — the record of truth for curation. |
| `ALBUMS_DATA_FILE` | `data/smart-albums.json` | Smart-album job definitions and run state. |
| `FRAME_DB_PATH` | `data/frame.db` | Frame display ledger (five years of recent display history, with generous per-frame and installation-wide row/byte ceilings) and voice command usage counters — both power the Frame Metrics page (`/metrics.html`). |
| `SETTINGS_PATH` | `data/settings.json` | UI-editable settings overrides and destination-authority bindings for saved credentials. Written with mode `0600`. After restoring to a host whose Immich or configurable AI-provider URL differs, restore the original URL or remove the saved credential and its binding while Pictaria is stopped, then re-enter the credential for the new destination. |
| `INSIGHTS_DB_PATH` | `data/insights.sqlite` | Insights sweep cache and snapshot. Safe to delete; the next sweep rebuilds it. |
| `WAKE_WORD_MODELS_DIR` | `data/wake-word-models` | Custom openWakeWord models and their integrity registry — irreplaceable unless you kept the originals. Included in backups. |

## Enrich (AI photo analysis)

Provider connection details and model identifiers are configured under
Settings → AI Providers. The active enrichment provider is chosen on the
Enrich page; that choice is saved immediately and applies to new runs across
future visits and server restarts. `DEFAULT_PROVIDER` only seeds the choice
when no saved UI selection exists, which makes it useful for initial setup and
infrastructure-as-code deployments rather than as a second day-to-day control.

| Variable | Default | Notes |
| --- | --- | --- |
| `ENRICH_ENABLED` | `false` | Master switch for AI enrichment — off by default because a run sends the selected image rendition to its chosen model. Voice Interesting is a separate, user-invoked model path and does not depend on this switch. Flip Enrich in Settings → Enrich (or here). **UI** |
| `CAPTION_WRITEBACK` | `false` | Copy enrichment captions into Immich's description field, making photos searchable in Immich by their content. Pictaria checks at the final safe point before writing and only fills an empty description or updates its own earlier text; Immich offers no atomic conditional update, so see the precisely documented residual race in [ENRICH.md](ENRICH.md). **UI** |
| `DEFAULT_PROVIDER` | `cloud_openai` | Initial/infrastructure fallback when the Enrich page has no remembered provider. `cloud_openai` \| `local_lmstudio` \| `local_ollama` \| `openrouter` \| `cloud_ollama` \| `venice`. Choosing a provider on Enrich saves a UI override. **UI (Enrich page)** |
| `OPENAI_API_KEY` | *(empty)* | Used by the `cloud_openai` provider, voice photo-Q&A, and TTS. Lives under Settings → AI Providers. **UI** |
| `OPENAI_MODEL` | `gpt-5.5` | Vision model for enrichment. Lives under Settings → AI Providers. **UI** |
| `LMSTUDIO_BASE_URL` | `http://127.0.0.1:1234/v1` | Model inference within infrastructure you operate via LM Studio. **Docker:** inside the container `127.0.0.1` is the container itself — when LM Studio runs on the Docker host, use `http://host.docker.internal:1234/v1` (on Linux, add `extra_hosts: ["host.docker.internal:host-gateway"]` to the service in `docker-compose.yml`). Lives under Settings → AI Providers. **UI** |
| `LMSTUDIO_MODEL` | *(empty)* | Model name as LM Studio reports it. Lives under Settings → AI Providers. **UI** |
| `LMSTUDIO_API_KEY` | `lm-studio` | Rarely needs changing. |
| `LMSTUDIO_MAX_TOKENS` | `2400` | `none` disables the cap. Too low a cap truncates long responses mid-JSON, which shows up as "bad JSON from model" failures. |
| `LMSTUDIO_TEMPERATURE` | `0` | |
| `OLLAMA_LOCAL_BASE_URL` / `OLLAMA_LOCAL_MODEL` | `http://127.0.0.1:11434` / *(empty)* | Model inference within infrastructure you operate via Ollama — no third-party cloud model or API key. Model must be a vision model, named as `ollama list` shows it. Same Docker note as LM Studio: use `http://host.docker.internal:11434` when Ollama runs on the Docker host — and Ollama itself must listen beyond localhost (`OLLAMA_HOST=0.0.0.0:11434`, see [Ollama's FAQ](https://docs.ollama.com/faq)) or the container cannot reach it; that exposes an unauthenticated service to your network, so bind only as wide as needed (a Tailscale-only bind avoids that entirely — see [ENRICH.md](ENRICH.md), "on another machine"). Base URL and model live under Settings → AI Providers. **UI** |
| `OLLAMA_LOCAL_API_KEY` | — | Only for local Ollama behind an authenticating proxy; adds a Bearer header. |
| `OPENROUTER_API_KEY` / `OPENROUTER_MODEL` / `OPENROUTER_BASE_URL` | — / `qwen/qwen3-vl-32b-instruct` / `https://openrouter.ai/api/v1` | Key and model live under Settings → AI Providers. **UI** |
| `OLLAMA_API_KEY` / `OLLAMA_MODEL` / `OLLAMA_BASE_URL` | — / `qwen3.5:cloud` / `https://ollama.com` | Key and model live under Settings → AI Providers. **UI** |
| `VENICE_API_KEY` / `VENICE_MODEL` / `VENICE_BASE_URL` | — / *(empty — no default)* / `https://api.venice.ai/api/v1` | Key and model live under Settings → AI Providers. **UI**. The model must support vision and structured output; the AI referee additionally needs multi-image input (e.g. `qwen3-vl-235b-a22b`). |
| `IMAGE_SOURCE` | `preview` | Which Immich rendition is sent to the model (`preview`, `thumbnail`, or `original`). Immich previews are WebP, which LM Studio cannot ingest — on macOS Pictaria converts them automatically; in Docker set this to `original`. **UI** |
| `MAX_FAILURES_PER_ASSET` | `2` | Give up on an asset after this many failed attempts (per provider + model + prompt + taxonomy setup). `0` disables the limit; raising it above an asset's recorded failures re-attempts it on the next run. Stuck photos can also be retried one run at a time from the Enrich page's **Stuck photos** strip. |
| `TAXONOMY_PATH` | `taxonomy/v1.json` | The shipped tag taxonomy and review-bucket policy. Editable at runtime in Settings → Enrich (the override lives in the settings store and must bump the taxonomy version). |
| `PROMPTS_DIR` / `PROMPT_VERSION` | `prompts` / `v2` | Prompt templates for enrichment. The prompt text itself can be overridden in Settings → Enrich (no env var); runs with an override record prompt version `v2-custom`. |
| `CURATE_BURST_GROUPING` | `true` | Collapse same-moment photos (bursts, re-shoots, duplicates) into stacked cards in the Curate queue. Off = flat photo-by-photo queue. **UI** |
| `CURATE_REFEREE_ENABLED` | `false` | The gold star: an AI model compares each same-moment group side by side and picks the keeper, with a why-line per photo. Runs whenever enrichment is idle; needs `ENRICH_ENABLED`. **UI** |
| `CURATE_REFEREE_PROVIDER` | *(empty)* | Referee provider; empty = follow the provider currently selected on Enrich. Lives under Settings → Curate. **UI** |
| `CURATE_REFEREE_MODEL` | *(empty)* | Referee model; empty = the chosen provider's usual model. It must accept multiple images. Lives under Settings → Curate. **UI** |
| `REFEREE_GROUP_BUDGET_MB` | `96` | Aggregate ceiling (MB) on one referee group's image bytes, every source counted — originals, previews, and thumbnails all degrade to fit it, and a group that can't fit even as thumbnails is deferred rather than exceeding it. Building the provider request costs roughly 3.5× the raw bytes in transient memory, so lower this on small containers (clamped 8–2048). |

## Backups

See [docs/BACKUP.md](BACKUP.md) for the full guide.

| Variable | Default | Notes |
| --- | --- | --- |
| `BACKUP_DIR` | `data/backups` | Snapshot destination. Same-disk by default — point it at a NAS mount or synced folder for real safety. Bare Node uses the host path; Docker uses the container path of a separate bind mount, normally `/backups`. A custom path is adopted once with `bin/backup.mjs --adopt` while the mount is present; after that an absent mount fails visibly instead of writing locally (see [BACKUP.md](BACKUP.md)). Path stays environment-only. |
| `BACKUP_DIR_DEFAULT` | *(unset)* | Image-internal: relocates the *trusted* default destination (the Docker image sets it to `/data/backups`) without making it look user-selected. Users set `BACKUP_DIR`, never this. |
| `BACKUP_ENABLED` | `true` | Automatic snapshots while the server runs. **UI** |
| `BACKUP_INTERVAL_HOURS` | `24` | 1–168. **UI** |
| `BACKUP_KEEP` | `7` | Snapshots retained; older ones are deleted. 1–60. **UI** |

## Voice

| Variable | Default | Notes |
| --- | --- | --- |
| `TTS_PROVIDER` | *(empty = TTS off)* | `openai` or `elevenlabs`. Lives under Settings → Voice TTS. **UI** |
| `OPENAI_TTS_MODEL` | `gpt-4o-mini-tts` | Lives under Settings → Voice TTS. **UI** |
| `OPENAI_TTS_VOICE` | `coral` | Lives under Settings → Voice TTS. **UI** |
| `OPENAI_TTS_SPEED` | `1.17` | 0.5–2. Lives under Settings → Voice TTS. **UI** |
| `OPENAI_TTS_FORMAT` | `mp3` | Audio format returned to the frame; selected under Settings → Voice TTS. **UI** |
| `OPENAI_TTS_INSTRUCTIONS` | *(empty)* | Voice style instructions under Settings → Voice TTS. **UI** |
| `OPENAI_REQUEST_TIMEOUT_MS` | `30000` | Timeout for OpenAI TTS requests. Spoken prose answers use `VOICE_PROSE_TIMEOUT_MS` instead. |
| `ELEVENLABS_API_KEY` | *(empty)* | Credential under Settings → AI Providers; used only for TTS. **UI** |
| `ELEVENLABS_TTS_MODEL` | `eleven_multilingual_v2` | Lives under Settings → Voice TTS. **UI** |
| `ELEVENLABS_VOICE_ID` | *(empty)* | Lives under Settings → Voice TTS. **UI** |
| `ELEVENLABS_OUTPUT_FORMAT` | `mp3_44100_128` | Lives under Settings → Voice TTS. **UI** |
| `ELEVENLABS_REQUEST_TIMEOUT_MS` | `30000` | Timeout for ElevenLabs requests. |
| `VOICE_PROSE_PROVIDER` | `cloud_openai` | Which provider answers the two spoken-prose commands ("what's interesting about this photo", "tell me …"). Any enrichment provider; uses the connection under AI Providers and is chosen under Settings → Voice TTS. **UI** |
| `VOICE_INTERESTING_MODEL` | *(empty)* | Model for "what's interesting about this photo" — must accept images. Empty uses the model that provider is configured with (on OpenAI, `OPENAI_INTERESTING_MODEL`). Lives under Settings → Voice TTS. **UI** |
| `VOICE_ASK_MODEL` | *(empty)* | Model for "tell me …" — text only. Empty uses the model that provider is configured with (on OpenAI, `OPENAI_ASK_MODEL`). Lives under Settings → Voice TTS. **UI** |
| `VOICE_PROSE_TIMEOUT_MS` | `25000` | End-to-end budget for a spoken answer — Immich lookups, the model call, and its one retry all count against it. Deliberately far shorter than the enrichment timeouts (someone is standing there waiting) and accepted between 2 s and 40 s — below 2 s there is no time to reach a model at all, and above 40 s Pictaria Frame abandons "interesting" (45 s) and would discard the answer. When the budget expires Frame speaks a short fallback line; an Immich request already in flight is abandoned rather than cancelled (it finishes under Immich's own timeout and its result is dropped), but no further step is started. **UI** |
| `OPENAI_INTERESTING_MODEL` | `gpt-5.5` | OpenAI's default model for "interesting", used when `VOICE_INTERESTING_MODEL` is empty. |
| `OPENAI_INTERESTING_IMAGE_DETAIL` | `high` | OpenAI-only image fidelity. |
| `OPENAI_INTERESTING_MAX_OUTPUT_TOKENS` | `420` | Answer budget for "interesting". **UI** |
| `OPENAI_ASK_MODEL` | `gpt-5.4-nano` | OpenAI's default model for "tell me …", used when `VOICE_ASK_MODEL` is empty. |
| `OPENAI_ASK_MAX_OUTPUT_TOKENS` | `600` | Raise if spoken answers come through clipped. **UI** |
| `STT_PROVIDER` | *(empty)* | Reserved; speech-to-text runs on-device in Pictaria Frame. |

**Choosing a voice provider.** These two commands talk back, so they are
latency-bound in a way enrichment is not — Pictaria Frame stands silent until
the answer lands, and sending a photo roughly doubles the work. Prefer a
cloud provider unless local inference is genuinely fast (a small vision
model like `gemma3:4b` or `qwen3-vl:8b` can keep up; a 30B will not).
**Venice** is the recommended cloud choice here, with one caveat that
matters: its privacy guarantee is **per model, not per platform**. Pick a
model whose `model_spec.privacy` is `private` — that tier is contractually
zero-retention, so the one call that ships a photo off-box does not leave
it stored with the provider. A model marked `anonymized` only withholds
your identity; the provider still sees the photo. Both properties are in
the `/models` response and in
[Venice's privacy docs](https://docs.venice.ai/overview/privacy). Whatever
you pick, the "interesting" model must be vision-capable — and note that
**LM Studio cannot serve that command outside macOS**: it rejects the WebP
preview the command sends, and converting needs macOS's `sips`, so a Docker
or Linux install should choose a different provider for spoken answers.

The prompts behind the "interesting" and "tell me …" voice answers are
editable in **Settings → Prompts** (settings-only, no environment variables):
load the built-in text, change what answers should emphasize, and save. An
override must keep its `{context}` / `{question}` placeholder — that is where
the server injects the photo metadata or the spoken question — and clearing
the box returns to the built-in prompt. Answers produced by a custom prompt
carry a `-custom` suffix in their `promptVersion`.

## Ambient (weather + location display)

| Variable | Default | Notes |
| --- | --- | --- |
| `WEATHER_DEFAULT_LOCATION` | *(empty)* | Fallback weather place for direct `/api/weather` calls that omit a location — Pictaria Frame always sends its own, so most installs never need this. The city or US ZIP is sent to Open-Meteo for geocoding, followed by a forecast request using the resulting coordinates. No key is required. Env-only. |
| `GEOCODING_PROVIDER` | *(empty = off)* | `geoapify` enables reverse geocoding for location labels and the Insights home-base name. **UI** |
| `GEOAPIFY_API_KEY` | *(empty)* | API key from a free [geoapify.com](https://www.geoapify.com/) account (the free tier is far more than a frame uses). **UI** |
| `GEOCODING_TIMEOUT_MS` | `8000` | |
| `GEOCODING_COORDINATE_PRECISION` | `3` | Rounding for the geocode cache key. |
| `IMMICH_METADATA_WRITEBACK` | `false` | Cache resolved locations back into Immich asset metadata. **UI** |
| `IMMICH_LOCATION_METADATA_KEY` | `pictaria.locationEnrichment` | Metadata key used for that cache. |

## Smart Albums

| Variable | Default | Notes |
| --- | --- | --- |
| `ALBUMS_SEARCH_PAGE_SIZE` | `1000` | Page size for Immich searches (max 1000). |
| `ALBUMS_MAX_SEARCH_PAGES` | `25` | Safety cap per search (range 1–500). |

## Insights

Insights computes everything locally from a periodic sweep of your library.
The defaults are sensible; most people never touch these.

| Variable | Default | Notes |
| --- | --- | --- |
| `INSIGHTS_REFRESH_HOURS` | `24` | Snapshot staleness threshold; checked hourly and shortly after boot. **UI** |
| `INSIGHTS_SWEEP_PAGE_SIZE` | `1000` | Immich page size for the sweep. |
| `INSIGHTS_MAX_SWEEP_PAGES` | `1000` | Safety cap (range 1–10,000; 1M assets at the default). The sweep also has a two-hour aggregate elapsed limit and rejects invalid or non-progressing Immich pagination. |
| `INSIGHTS_TOP_PEOPLE` | `15` | People shown in the leaderboard and year drill-down. |
| `INSIGHTS_MAX_TAG_COUNTS` | `250` | Leaf tags counted per sweep (`0` disables tag stats). |
| `INSIGHTS_STAT_CONCURRENCY` | `4` | Parallelism for the per-tag statistics calls. |
| `INSIGHTS_TRIP_AWAY_KM` | `100` | Distance from home that counts as "away" on the timeline. **UI** |
| `INSIGHTS_TRIP_GAP_DAYS` | `3` | Camera-quiet days tolerated inside one trip. **UI** |
| `INSIGHTS_TRIP_MIN_DAYS` | `2` | Minimum away-days before a run of days is called a trip. **UI** |
| `INSIGHTS_FAVORITES_TAG_ID` / `INSIGHTS_FAVORITES_TAG_VALUE` | *(empty)* | Count a tag as "favorites" instead of Immich hearts. Usually set from the UI (gear on the Favorites tile). **UI** |
