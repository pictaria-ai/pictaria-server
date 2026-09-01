# Insights

Understand your collection: library-wide statistics computed on your own
hardware from data Immich already extracted (EXIF, faces, tags) plus
Pictaria's own enrichment database. Pictaria computes and stores the snapshot
locally. If you configure Geoapify place naming, the home coordinates derived
by the sweep are sent to that provider to resolve a label.

## How it works

The page renders instantly from the **last computed snapshot** (JSON stored in
`data/insights.sqlite`). A background **collector job** recomputes the
snapshot on demand (Refresh button) and automatically when it is older than
`INSIGHTS_REFRESH_HOURS` (default 24).

The collector has four phases, visible in `/api/insights/status`:

1. **assets** — one paged sweep of `/api/search/metadata` (`withExif: true`,
   `withPeople: true`) into local tables, including an asset↔person join
   table. ~115k assets ≈ 116 requests (~6 min with people payloads).
2. **people** — `/api/people` paged for *names* only (a handful of calls);
   per-person counts come from the local join table.
3. **pairs** — co-occurrence is pure SQL over the join table: every pair of
   named people, with no additional Immich API calls.
4. **tags** — per-tag counts via `/api/search/statistics` with `tagIds`.
   Pictaria's enrichment taxonomy tags live under the `ai/` prefix.

All calls are read-only against Immich. Pictaria v1 has been verified against
Immich v2.7.5 and v3.1.0; see [Immich compatibility](IMMICH-COMPATIBILITY.md).
Every server-side traversal also has an aggregate safety budget: the asset
sweep uses its configured page and page-size ceilings with a two-hour elapsed
limit; people collection stops at 100 pages, 50,000 entries, or 60 seconds;
and slice resolution stops at 1,000 upstream calls, 250,000 scanned entries,
or two minutes. Invalid, repeated, and non-progressing Immich page metadata
fails the operation without publishing a partial Insights generation.
The asset sweep retains at most 100 unique people relationships per photo,
along with its fixed EXIF projection, 4 KiB per retained metadata field, 4,096
nested metadata items, and 128 KiB of decoded metadata per asset. A crowd photo
with more than 100 relationships remains in every ordinary photo, date, place,
camera, and storage statistic; Insights keeps the first 100 relationships and
shows a persistent notice that people and pair statistics were truncated for
that photo. Only the bounded person ID Pictaria stores is admitted—not names,
face boxes, or other fields on Immich's `PersonWithFaces` relationship object.
The same structural and byte limits still bound each people-directory record.
Asset and person identifiers are restricted to 128 safe opaque characters. One
refresh may admit at most 20 million nested items, 512 MiB of decoded metadata,
and 5 million generated asset/relationship/people rows. Complete people
retained relationship and complete directory records count toward those
budgets, including hidden and unnamed entries. Every page is fully admitted
before its first staging write; a limit failure drops staging and keeps the
previous snapshot intact.

Insights also reserves filesystem headroom for the overlap between the live
generation, staging tables, the indexed publish copy, and SQLite's WAL. A
refresh requires a 256 MiB floor plus four times its projected decoded text
and generated-row footprint, checked before staging, before each page write,
and before publish. If the volume cannot provide it, the refresh refuses
without touching the live generation; dropping staging is intentionally used
instead of `VACUUM`, which could itself require more temporary disk.

## Endpoints

- `GET /api/insights` — `{ snapshot, status, immichUrl, favoritesTag,
  locationGroups }`; `snapshot` is null until the first run completes.
  `immichUrl` (from `IMMICH_PUBLIC_URL`, falling back to `IMMICH_BASE_URL`)
  powers person deep-links in the UI.
- `POST /api/insights/refresh` — start the collector (409 while running).
- `POST /api/insights/cancel` — cancel a running collector.
- `GET /api/insights/status` — collector phase/progress.
- `GET /api/insights/people` — the full named-people list with counts (the
  lens search dropdown; the snapshot itself carries only the top people).
- `POST /api/insights/photos` — insight → action: run a slice's filters
  (`personIds`, `tagIds`, `city`, `cities`, `state`, `country`,
  `make`/`model`, `takenAfter`/`takenBefore`, `day`, `isFavorite`, `type`)
  against Immich and return a page of assets for the browser grid. `cities`
  (an array) fans out one Immich search per member city for
  synthetic-location groups. `city`, `state`, and `country` also accept an
  explicit `null`, meaning "field is unset" — this is how a country-labeled
  row opens exactly its city-less photos and the "No location" row opens
  photos with no location data at all.
- `GET /api/insights/year/:year` — drill-down: months histogram, top
  cities/countries/cameras, busiest day, and per-year counts for the top
  people (all from the local sweep; people via the `asset_people` join
  table).
- `GET /api/insights/year/:year/month/:month` — the year panel's month
  drill: count, top places, and top people for one month (all from the
  local sweep). Month is 1–12; an empty month answers with empty lists,
  not an error.
- `GET /api/insights/lens` — per-year counts for one person/place/tag
  (the histogram lens).
- `GET /api/insights/timeline` — weekly overview (no params) or per-day
  detail (`?from&to`) for the timeline.
- `GET /api/insights/person/:id` — the person card (all local SQL).
- `GET /api/insights/place?name=…` — the location card (city or group).
- `GET /api/insights/cities` — distinct raw cities with counts/centroids,
  for the Settings group editor.
- `GET|PUT /api/insights/location-groups` — read/update synthetic location
  groups (persisted via the settings store; relabels instantly, no resweep).
- `PUT|DELETE /api/insights/favorites-tag` — set/clear the tag that redefines
  the Favorites tile (current value rides along in `GET /api/insights`).
- `GET /api/insights/people/:id/thumbnail` — authenticated proxy for Immich
  person face thumbnails.

Album creation from a slice reuses the Smart Albums engine: the UI posts the
slice filters to `POST /api/albums/jobs`, including `make` and `model` for
camera slices.

## Snapshot shape (abridged)

```json
{
  "generatedAt": "…",
  "peopleTruncation": {
    "assets": 0, "relationshipsOmitted": 0, "perAssetLimit": 100
  },
  "totals": { "photos": 0, "videos": 0, "favorites": 0, "storageBytes": 0,
              "firstTakenAt": "…", "lastTakenAt": "…",
              "peopleNamed": 0, "peopleTotal": 0 },
  "years": [{ "year": 2020, "count": 0 }],
  "people": [{ "id": "…", "name": "…", "count": 0 }],
  "pairs": [{ "aName": "…", "bName": "…", "count": 0 }],
  "places": { "cities": [{ "name": "…", "count": 0 }],
              "countries": [{ "name": "…", "count": 0 }] },
  "cameras": [{ "name": "…", "count": 0 }],
  "tags": [{ "id": "…", "value": "ai/…", "count": 0 }],
  "superlatives": {
    "busiestDay": { "day": "…", "count": 0 },
    "busiestMonth": { "month": "…", "count": 0 },
    "longestGap": { "days": 0, "from": "…", "to": "…" },
    "oldest": { "id": "…", "takenAt": "…", "day": "…", "city": "…", "country": "…" },
    "home": { "lat": 0, "lon": 0, "city": "…", "count": 0 },
    "furthest": { "id": "…", "distanceKm": 0, "city": "…", "country": "…", "day": "…" }
  },
  "darkMatter": { "noLocation": 0, "noCamera": 0, "notEnriched": 0 }
}
```

People carry `id`, pairs carry `aId`/`bId`, tags carry `id`, and cameras carry
`make`/`model` so every row can become a slice (view photos / create album).
"Home" is the densest ~11 km cell of geotagged photos; "furthest" is the
geotagged photo farthest from it.

## From insight to action

Every statistic can lead back to the photos behind it. Photo slices open in a
browser grid with a lightbox and, where the filter can be represented safely,
can create an Immich album through the Smart Albums engine.

Selecting a year opens its month histogram, people, places, cameras, and
busiest day. Selecting a month scopes the year panel and its photo actions to
that month. Records cover the busiest day and month, longest lull, oldest
photo, furthest photo from home, and calculated home base.

Person thumbnails are proxied through Pictaria; supported person rows also link
to the corresponding Immich person page.

## Lenses and constellation

- The `asset_people` join table supports local person counts, shared-photo
  pairs, and per-year or per-month people statistics.
- The Photos-per-year histogram can be filtered through a person, place, or tag
  lens (`GET /api/insights/lens`). Person and place lenses use local SQL; tag
  lenses use bounded Immich statistics calls cached until the next sweep.
- The Constellation is a force-directed view of named people. Face nodes scale
  by photo count and edges by shared-photo count; hover for counts, drag to
  untangle, or select a node or edge to open its photos.

## Timeline and trips

"Where I was, over time." A weekly overview strip of the whole collection
(away weeks in accent; drag to zoom), a per-day location ribbon (home /
away-with-place / no-photos segments; click a segment for its photos, drag
across it to select any range), and an auto-detected trips list.

Trip detection runs at snapshot time from the per-day rollup: a day is
"away" when its dominant ~11 km geo cell sits farther than
`INSIGHTS_TRIP_AWAY_KM` (default 100) from home; up to
`INSIGHTS_TRIP_GAP_DAYS` (3) quiet days may fall inside a trip, a
near-home day ends it, and `INSIGHTS_TRIP_MIN_DAYS` (2) filters day
outings. `GET /api/insights/timeline` serves the weekly overview (no
params) or per-day detail (`?from&to`). Time-range slices reuse the
standard photo browser and album handoff (`takenAfter`/`takenBefore`).

## Person cards

Click a face anywhere — constellation, leaderboards, pair avatars, year
chips, lens results — and a person card opens instead of a bare photo grid:
photo count and first/last dates, View photos / Create album / Open in
Immich actions, a mini per-year histogram (bars click through to that
person-year), top places, and the ten people they share the most photos
with. Connection rows navigate: the name chains to *that* person's card
(with back-button history), the count bar opens the photos the two share.
While a card is open the constellation spotlights that person's node and
edges. All data comes from local SQL through
`GET /api/insights/person/:id`.

## Location groups and place cards

**Location groups.** Whether Burlingame "is" San Francisco is a preference,
not a fact — so grouping is user-defined, in Settings → Location Groups: name a
group ("Bay Area"), check its member cities (an "add nearby" helper
pre-checks everything within ~25 km of the checked ones — click again to grow outward), save. The sweep
keeps raw Immich cities; groups live in `settings.json`
(`insights.locationGroups`) and are mirrored into a `city_groups` lookup
table, so every city aggregate relabels at query time — Places leaderboard,
timeline ribbon colors and Locations list, year drill-down, the lens, and
person-card places. No resweep to create, edit, or delete a group; deleting
restores the raw cities. Group labels carry a ⁕ marker with a members
tooltip. Since Immich's search takes a single city, group photo browsing
fans out one search per member city server-side (`cities` slice filter with
an object cursor). Smart Albums supports a cities-OR mode (comma-separated in
the Albums form; `filters.cities`), and Immich deep links are
omitted for multi-city slices.

**Location card.** Click a city or group on the Places board: photo count,
first/last dates, per-year mini histogram, busiest day, the people
photographed there (name → their person card, opened on top; count bar →
that person's photos there), and for groups the member-city breakdown.
`GET /api/insights/place?name=…` — all local SQL.

## Month scoping and honest locations

**Full Locations list.** The timeline's Locations list shows every location
in the selected window (no silent row cap), scoped to whatever the ribbon
shows. Clicking a month bar in the year drill-down scopes the ribbon and
Locations list to that month (with a "View \<Month\> \<Year\>" button for the
month's photos); clicking the selected month again returns to the year.

**Month-scoped People and Places.** Selecting a month
also re-renders the year panel's People and Places lists with that month's
counts — titles carry the scope ("People · May 2019") and the chip/row
slice links open just that month's photos. Deselecting the month restores
the year lists from the year detail already in hand, no refetch. Data comes
from `GET /api/insights/year/:year/month/:month`; a stale-response guard
keeps rapid month clicks from painting an earlier month's answer, and if
the request fails the boxes show a month-scoped "couldn't load" note rather
than another scope's numbers.

**Honest location rows.** A country-labeled row counts photos whose GPS
resolves to a country but no city (national parks, open water) — clicking it
now opens exactly those city-less photos, not everything in the country,
via an explicit `city: null` slice filter (Immich metadata search treats
null as "field is unset"). The "No location" row is clickable too, opening
the window's photos with no location data at all — handy for finding photos
to assign locations to in Immich. Immich deep-links and album handoffs are
suppressed for null-filter slices, since neither can express them.
