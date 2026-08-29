# Activity history

Pictaria Server keeps a local, structured operational history so a household
can answer practical questions such as whether a Frame command was delivered,
which configured model handled a voice request, or when a setting changed. It
is diagnostic history, not analytics: nothing is sent to Pictaria or any other
telemetry service.

Activity is stored in `enrichment.sqlite`, included in normal snapshots, and
available from the authenticated **Activity** page (`/activity.html`). New
operational events are retained for 90 days. Retention is enforced on startup,
daily while the server runs, and on activity reads and writes. The page also
reads the existing Enrich and Curate domain history; those records follow their
own feature retention and can therefore reach further back than 90 days.

The newest events appear first. Category, event type, time, provider, and model
filters apply identically to the page and its JSON/CSV downloads. On-screen
pagination uses an opaque cross-source keyset cursor, so new activity arriving
while the page is open cannot create offset drift. Downloads are deliberately
capped at 5,000 matching events and say when the result was truncated. Every
CSV event row carries `export_truncated` and `export_limit` columns, so the
saved file remains honest outside the browser. CSV fields are neutralized
before download so configured provider or model names cannot become
spreadsheet formulas.

The page also shows a seven-day recognition check whenever Frame has reported
an `unrecognized` voice-command label. This is a count of fixed command labels,
not a transcript, and makes a recognition regression visible without storing
what anyone said.

## Recorded events

The capture layer uses a fixed vocabulary:

| Category | Event | Bounded context |
| --- | --- | --- |
| System | `system.start`, `system.stop` | server version; allowlisted stop reason and exit code |
| Settings | `settings.changed` | names of fields whose persisted override changed |
| Frame | `frame.command` | validated command, optional target device, delivery count |
| Voice | `voice.command` | allowlisted command label, optional device, and the honest `reported` outcome (local execution is not observable) |
| Voice | `voice.tell-me`, `voice.interesting` | success/fallback/failure, and provider/model when resolved; photo ID only for Interesting |
| Voice | `voice.tts` | success/failure and provider/model when resolved |
| Curation | `curation.favorite`, `curation.never-show` | photo ID and success/failure |
| Curation | `curation.discard`, `curation.restore` | aggregate count, single photo ID when applicable, and bounded skip counts |

Curate's manual decisions and Enrich/Curate run history remain authoritative
in their existing domain tables. The Activity UI merges those records at read
time instead of duplicating every decision into the append-only log. Curation
history retains the newest 100,000 decision rows plus each photo's newest
decision, preserving the distinct curated-photo total while bounding repeated
decision churn. Cleanup runs after each additional 10,000 decision rows, so
the retained churn window may temporarily include up to 9,999 newer rows.

The merged read model adds these existing domain records:

| Category | Event | Safe projection |
| --- | --- | --- |
| Enrich | `enrich.photo` | photo ID, outcome, provider, model, timestamp |
| Enrich | `enrich.run` | outcome, provider, model, optional targeted count, timestamp |
| Curation | `curation.decision` | photo ID and allowlisted approve/reject/clear decision |
| Curation | `curation.referee` | photo count, duration, provider, model, timestamp |

Job titles, job errors and logs, prompt/taxonomy payloads, raw or normalized AI
output, captions, decision reasons, and referee notes are never projected into
Activity.

## Deliberately excluded

The activity API exposes typed event methods rather than a generic writer.
Callers cannot pass arbitrary request bodies or provider responses. The log
never stores:

- credentials, API keys, session material, or setting values;
- server/provider URLs;
- voice transcripts, spoken questions, generated answers, or TTS text;
- prompts, image bytes, photo metadata, filenames, or location labels;
- album names or album membership;
- raw HTTP request/response bodies, exception text, or a per-photo display
  firehose.

Unknown voice labels and shutdown reasons are reduced to fixed safe buckets.
Provider and model identifiers are retained because they are needed to explain
configuration, latency, and cost, but credentials and provider errors are not.

## Failure behavior

Activity is best effort. Retention and insert failures produce a server warning
and return control to the action being observed. They do not alter the HTTP
response, roll back an Immich mutation, block settings application, or prevent
shutdown. Reads remain explicit so the Activity page can report an unavailable
store honestly rather than pretending the history is complete.

## API

All Activity routes use the same authentication as the rest of the server:

- `GET /api/activity` — one page (default 50, maximum 200), with optional
  `category`, `type`, `since`, `until`, `provider`, `model`, and opaque
  `cursor` query parameters.
- `GET /api/activity/export?format=json|csv` — the same filters, no cursor,
  capped at 5,000 events.

The read path queries only a page-sized newest-first window from each domain
table and merges those small windows in memory. Timestamp indexes keep default
queries proportional to the requested page rather than to library size.
