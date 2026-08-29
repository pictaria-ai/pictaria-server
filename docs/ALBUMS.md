# Smart Albums — saved searches that keep real albums fresh

Smart Albums (`/albums.html`) turns a search — structured filters, an
Immich text search, or both — into a **real Immich album** and keeps it
matched to that search on a schedule. The albums are ordinary Immich
albums: Pictaria Frame displays them, the Immich UI opens them, sharing
works. Pictaria's part is the rule that fills them.

## Building a rule

A rule needs an album name and at least one match criterion:

- **Immich Text Search** — Immich's semantic (CLIP) search, e.g.
  "sunset at the beach". Results come back in relevance order, which the
  album keeps unless Best of re-ranks them. Text searches page through
  Immich's ranked results, so previewing or creating one can take 30+
  seconds on a big library.
- **Structured filters** — any combination of: people (match **all**
  or **any**, or **Only this person** to keep photos where the chosen
  person appears alone), tags (**all** or **any**), city/neighborhood,
  state/region, country (cities and countries accept several values,
  matched as OR), camera make and model, and a taken-date range.

The two combine (text search AND filters), with restrictions the
builder rejects with clear messages: the **any**/OR match modes for
multiple people or tags, multiple cities, multiple countries, and
**Only this person** all work only in filter-only rules — no text
search alongside them. Multiple countries also can't be combined with
a city or state (which country would the city belong to?), and **Only
this person** needs exactly one selected person with the **all**
people mode.

Each filter collection accepts up to 25 entries; identifiers are limited to
200 characters, as are names and location/camera values. Ranked searches are
limited to 1,000 characters and album names to 200. Before preview, creation,
or any later run, Pictaria calculates the worst-case people × location × tag ×
page plan and rejects rules that could require more than 500 Immich requests.
This happens before variant expansion, album creation, or other Immich work;
saved rules are checked again on every manual and scheduled run.

**Result Size** defaults to **All Matching Photos**. Filtered and search rules
page until Immich reports a complete result. If the 25-page safety bound is
reached first, Pictaria adds the trustworthy matches found so far but preserves
every existing album member and shows a warning because the full result is not
known. Increase `ALBUMS_MAX_SEARCH_PAGES` if a larger library routinely reaches
that bound. Best of has a hard cap of 5,000. Switch to **Limit** to keep only the
top N (pre-filled 50, up to 5,000). **Preview** runs the exact search and shows
the first results plus honest counts before anything is created.

Creating the rule does the first fill immediately: the Immich album is
created, the current matches are added, and the rule joins **Managed
Albums** with its run stats.

## Three kinds of rule

The mode is picked implicitly by what you fill in:

| Mode | You provided | Order in the album |
| --- | --- | --- |
| Filtered | filters only | Newest first |
| Search | a text search (± filters) | Immich's relevance order |
| **Best of** | a text search (± filters) + the Best of toggle | Your library's own quality signals |

## Best of — confirmed matches, ranked by your library

Immich's semantic search ranks the *whole library* and never says where
the real matches end — so a capped "Top 50" album fills its tail with
noise. **Best of — keep only confirmed matches, ranked by your
library** fixes both halves:

1. **Corroboration.** Each search hit must be confirmed by your own
   enrichment data ([Enrich](ENRICH.md)): an `ai/*` tag whose words
   match the query (loose stemming — plurals collapse and longer words
   prefix-match, so "mountain" claims "mountainside" but "ski" never
   claims "skyline"), or a caption that matches it in the full-text
   index. Photos that aren't enriched yet can't be confirmed —
   they are counted and reported, never guessed at.
2. **Knowing when to stop.** Collection pages through the search and
   watches the confirmation rate per page. When it collapses — below
   40% or below half the first page's rate, whichever is higher, for
   two consecutive pages — the search has faded into tail noise and
   collection stops. It also stops when Immich runs out of results or
   enough survivors are in hand (3× the cap, bounded at 5,000 —
   headroom so late drops can't starve the album).
3. **Ranking.** Human decisions outrank model scores: Curate favorites
   first, then kept photos, then undecided; photos a human passed over
   sink to the bottom, and `frame/never-show` is out entirely. Ties
   break by frame-worthiness score, then aesthetic score, then the
   Immich heart, then original search order.

Every run records what happened: confirmed count, how many hits weren't
enriched, how many were dropped as unconfirmed or never-show, pages
scanned, and why collection stopped (`exhausted`, `enough`, `faded`, or
the page limit). A Result Size **Limit** is recommended with Best of —
it's the cap that makes "your best 50, not Immich's first 50"
meaningful.

## What a run does

Every run — scheduled or manual — re-syncs the album to exactly what
the rule matches right now:

- New matches are added (in batches of 50).
- Anything in the album that no longer matches comes out: photos whose
  metadata or tags changed, photos that fell below a ranked cap, and
  photos added to the album **by hand in Immich** — the album belongs to
  its rule.
- The rule's card shows the matched, added, and removed counts plus a
  Best of summary (confirmed, unconfirmed dropped, not yet enriched);
  the full run record — skipped counts, warnings, and the complete
  Best of stats — is stored on the rule and returned by the API.
- Reconciliation is fail-closed. Malformed pagination records an error and
  changes no album membership. A trustworthy All-results traversal that reaches
  its page limit is safely additive: matching photos found so far can be added,
  but no existing member is removed. A deliberate Top-N limit or Best-of cutoff
  is still a complete rule-defined selection and reconciles normally.

**Scheduling.** A rule can refresh itself every 1–365 days (default 7).
The scheduler checks every minute for due rules; a failed run records
its error on the card and stays on schedule, so a flaky night doesn't
stop future refreshes. Rules can be paused and resumed, and each rule's
**Run** button starts a sync immediately — a rule already running
(either path) is not started twice.

Schedules are confirmed for the Pictaria installation that created them.
After the upgrade that introduces this safeguard, all previously enabled
schedules require a one-time confirmation. The same is true when Smart Album
state is restored onto another installation or the installation's generated
`session-secret` is lost or regenerated. Automatic runs remain paused and the
rule is marked **Needs review**. Review its target and filters, then choose
**Review & enable** to confirm it locally. The manual **Run** action and the
rule's existing album remain available.

## Blanket exclusions and "never show this photo"

By default every rule blanket-excludes the `frame/never-show` tag — the
tag the "never show this photo" voice or web-remote action applies.
Pictaria Frame independently reads that tag from Immich and excludes the
photo across selected albums, Timeline, Calendar Memories, Show Search,
More From This Day, and remotely selected album rotations. A successful
action also removes the targeted photo from the current rotation right
away; when two portrait photos share the screen, only the named side is
removed. Frame does not have to wait for a smart-album run or album
refresh. See the
[Pictaria Frame guide](https://pictaria.ai/frame-guide#server)
for the complete display behavior.

Smart Albums provide a separate safeguard. On the next run, each managed
album removes photos carrying its blanket-exclusion tags, and the rule never
re-adds them while they remain excluded. This keeps the Immich album itself
aligned with its rule, independently of Pictaria Frame's own enforcement.

**Blanket Exclusion** in the rule builder replaces that default with
your own list of excluded tags (say, a `private` tag). An exclusion tag
that doesn't exist in Immich yet is reported as a warning on the run
rather than silently ignored. Explicitly configuring the list — even to
empty — takes full control: the `frame/never-show` default applies only
while the list was never configured.

## Lifecycle and safety

- **Creation order is deliberate:** the Immich album is created first,
  then the rule record is saved locally — and if that save fails, the
  just-created (still empty) album is deleted again so nothing is
  orphaned. If even that cleanup fails, the log names the orphan album
  so it can be removed by hand. This rollback is the only thing the
  `album.delete` permission is ever used for.
- **A failed first fill self-heals.** The rule record is saved before
  photos are added, so if Immich hiccups partway through the initial
  add, the rule and album stay with the error on the card — and the
  next run (scheduled or **Run**) reconciles membership to the rule.
- **Deleting a rule deletes only Pictaria's rule record.** The Immich
  album — and every photo in it — stays. Remove the album in Immich if
  you no longer want it.
- **Rules live in `data/smart-albums.json`**, written atomically
  (temp file + rename) and quarantined with a `.corrupt` suffix rather
  than half-loaded if the file is ever damaged. It's part of the
  standard [backup](BACKUP.md) snapshot.
- **Immich permissions:** runs use search plus `album.read`,
  `album.create`, `albumAsset.create`, `albumAsset.delete`, and (for
  the creation rollback only) `album.delete` — the exact key checklist
  lives in [Getting started](GETTING-STARTED.md).

## From Insights

The [Insights](INSIGHTS.md) page can turn a slice into an album: where
a number maps to search criteria (a person, place, tag, camera, or date
range), its album link opens the rule builder pre-filled with exactly
that slice, ready to preview and create — same pipeline, same rules.

## Configuration

| Variable | Default | Notes |
| --- | --- | --- |
| `ALBUMS_SEARCH_PAGE_SIZE` | `1000` | Page size for search paging against Immich. |
| `ALBUMS_MAX_SEARCH_PAGES` | `25` | Upper bound on pages fetched per individual search. The complete expanded rule must also fit the fixed 500-request aggregate plan budget. |

Result Size itself is per-rule (default 50, maximum 5000).

## API

Authentication follows the server-wide rule — required whenever
`APP_PASSWORD` is set. Under `/api/albums`:

- `GET /api/albums/jobs` — all rules with their stats.
- `POST /api/albums/jobs` — create a rule (creates the album and does
  the first fill).
- `PATCH /api/albums/jobs/:id` — edit schedule, pause/resume, Result
  Size; shortening an interval reschedules from the last run.
- `DELETE /api/albums/jobs/:id` — delete the rule record (the Immich
  album stays).
- `POST /api/albums/jobs/:id/run` — run now (`409 job_running` if it
  already is).
- `POST /api/albums/preview` — dry-run a search without creating
  anything.
- `GET /api/albums/people?name=` / `GET /api/albums/tags` — pickers for
  the builder.
- `GET /api/albums/assets/:id/thumbnail` — preview thumbnails.
- `GET /api/albums/config` — paging limits and defaults.
