// Single-flight Insights collector: sweeps the library into the local cache,
// gathers people/pair/tag counts, then computes and stores the snapshot.
// Same conventions as EnrichJobRunner: one run at a time, live progress,
// cooperative cancellation between API calls.

import { statfsSync } from 'node:fs';
import { dirname } from 'node:path';

import { awaitDrain } from '../lifecycle.mjs';
import { createTraversalBudget, parseProgressingPage, UpstreamPaginationError } from '../pagination.mjs';
import { isValidCalendarDay, isValidCaptureTimestamp } from './dates.mjs';
import { MAX_INSIGHTS_KNOWN_TAGS, MAX_INSIGHTS_TAG_ID_LENGTH } from './repository.mjs';

const SWEEP_TRAVERSAL_TIMEOUT_MS = 2 * 60 * 60_000;
const PEOPLE_MAX_PAGES = 100;
const PEOPLE_MAX_ITEMS = 50_000;
const PEOPLE_TRAVERSAL_TIMEOUT_MS = 60_000;

export const MAX_INSIGHTS_IDENTIFIER_LENGTH = 128;
export const MAX_INSIGHTS_PEOPLE_PER_ASSET = 100;
export const MAX_INSIGHTS_METADATA_FIELD_BYTES = 4 * 1024;
// Immich's PersonWithFaces response carries roughly twenty structural items
// per recognized face. These per-record ceilings leave useful margin above
// the documented 100-face asset contract and apply to people directory rows,
// without weakening the aggregate sweep budgets below.
export const MAX_INSIGHTS_DECODED_BYTES_PER_ASSET = 128 * 1024;
export const MAX_INSIGHTS_NESTED_ITEMS_PER_ASSET = 4096;
export const MAX_INSIGHTS_NESTED_ITEMS_PER_SWEEP = 20_000_000;
export const MAX_INSIGHTS_DECODED_BYTES_PER_SWEEP = 512 * 1024 * 1024;
export const MAX_INSIGHTS_GENERATED_ROWS_PER_SWEEP = 5_000_000;
export const MIN_INSIGHTS_SWEEP_FREE_BYTES = 256 * 1024 * 1024;
export const INSIGHTS_SWEEP_HEADROOM_MULTIPLIER = 4;
export const INSIGHTS_GENERATED_ROW_ESTIMATE_BYTES = 256;

const IMMICH_OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export class InsightsCollector {
  constructor({
    repo,
    immich,
    config,
    enrichRepo = null,
    geocodeHome = null,
    log = () => {},
    sweepBudgetLimits = null,
    diskFreeBytes = null,
  }) {
    this.repo = repo;
    this.immich = immich;
    this.config = config;
    this.enrichRepo = enrichRepo;
    // Optional ({latitude, longitude}) => {label} | null. Names the home-base
    // grid cell at neighborhood level when a geocoding provider is configured.
    this.geocodeHome = geocodeHome;
    this.log = log;
    this.sweepBudgetLimits = sweepBudgetLimits;
    this.diskFreeBytes = diskFreeBytes ?? (
      typeof this.repo.dbPath === 'string'
        ? () => filesystemAvailableBytes(dirname(this.repo.dbPath))
        : () => BigInt(Number.MAX_SAFE_INTEGER) // in-memory/test repository adapters persist no staging file
    );
    this.state = idleState();
    this.timer = null;
    this.bootTimer = null;
    this.soonTimer = null;
    this.runPromise = null;
    this.stopped = false;
  }

  status() {
    const snapshotMeta = this.repo.getMeta('snapshot');
    return {
      ...this.state,
      hasSnapshot: Boolean(snapshotMeta),
      lastGeneratedAt: snapshotMeta?.generatedAt ?? null,
    };
  }

  snapshot() {
    return this.repo.getMeta('snapshot');
  }

  isRunning() {
    return this.state.running;
  }

  cancel() {
    if (!this.state.running) {
      return false;
    }
    this.state.cancelRequested = true;
    return true;
  }

  start() {
    if (this.stopped) {
      throw new Error('The server is shutting down.');
    }
    if (this.state.running) {
      throw new Error('An insights refresh is already in progress.');
    }
    this.state = {
      ...idleState(),
      running: true,
      startedAt: new Date().toISOString(),
    };
    // Stored so stop() can drain the in-flight refresh; #run never rejects.
    this.runPromise = this.#run();
    return this.status();
  }

  // Refresh automatically when the snapshot is missing or stale. Checked
  // hourly; the interval itself is config (INSIGHTS_REFRESH_HOURS). Both
  // timers are owned so stop() can retire them.
  startAutoRefresh() {
    this.timer = setInterval(() => this.checkStaleness(), 3600_000);
    this.timer.unref();
    // First check shortly after boot so a fresh install populates itself.
    this.bootTimer = setTimeout(() => {
      this.bootTimer = null;
      this.checkStaleness();
    }, 30_000);
    this.bootTimer.unref();
  }

  // Nudge from outside — right after Immich settings are applied, so a
  // first-time setup populates Insights in minutes instead of waiting for
  // the next hourly staleness check. Re-armed on every settings apply; only
  // the newest nudge matters, so the previous one is retired.
  checkSoon(delayMs = 2000) {
    if (this.stopped) {
      return;
    }
    if (this.soonTimer) {
      clearTimeout(this.soonTimer);
    }
    this.soonTimer = setTimeout(() => {
      this.soonTimer = null;
      this.checkStaleness();
    }, delayMs);
    this.soonTimer.unref();
  }

  checkStaleness() {
    if (this.stopped || this.state.running) {
      return;
    }
    // Nothing to sweep until Immich is connected — without this a fresh
    // install records a failed run at boot.
    if (!this.immich?.baseUrl || !this.immich?.apiKey) {
      return;
    }
    const snapshot = this.repo.getMeta('snapshot');
    const ageMs = snapshot?.generatedAt ? Date.now() - Date.parse(snapshot.generatedAt) : Infinity;
    if (ageMs > this.config.refreshIntervalHours * 3600_000) {
      this.log('insights snapshot stale; starting refresh');
      try {
        this.start();
      } catch {
        // A run raced in; fine.
      }
    }
  }

  // Shutdown drain: retire every timer, request cancellation (the run checks
  // between phases and between pages), and wait for the in-flight refresh —
  // bounded, so a stalled Immich call can never hang shutdown. Returns false
  // when the wait gave up; staging is dropped by the run's own catch, and
  // the last published generation stays live either way.
  async stop(timeoutMs = 3000) {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.bootTimer) {
      clearTimeout(this.bootTimer);
      this.bootTimer = null;
    }
    if (this.soonTimer) {
      clearTimeout(this.soonTimer);
      this.soonTimer = null;
    }
    this.cancel();
    return awaitDrain(this.runPromise, timeoutMs);
  }

  // Collection never touches the live tables: the sweep fills staging, the
  // derived phases read staging and accumulate in memory, and one publish
  // transaction at the end lands the whole generation — sweep, people,
  // pairs, tags, favorites, snapshot — atomically. Failure or cancellation
  // at ANY earlier point changes nothing live.
  async #run() {
    const startedMs = Date.now();
    const sweepBudget = createInsightsSweepBudget(this.sweepBudgetLimits);
    try {
      const { truncated, metadataOmissions, peopleTruncation } = await this.#sweepAssets(sweepBudget);
      this.#checkCancelled();
      const people = await this.#collectPeople(sweepBudget);
      this.#checkCancelled();
      // Pairs are pure SQL over the just-swapped sweep — derived inside the
      // publish transaction. The phase marker keeps the status API identical.
      this.#setPhase('pairs', {});
      this.#checkCancelled();
      const tags = await this.#collectTags();
      this.#checkCancelled();
      const favoritesTag = await this.#refreshFavoritesTag();
      this.#checkCancelled();
      this.#requireSweepDiskHeadroom(sweepBudget);
      const snapshot = this.#publish({
        startedMs,
        truncated,
        metadataOmissions,
        peopleTruncation,
        people,
        tags,
        favoritesTag,
      });
      if (await this.#labelHomeArea(snapshot)) {
        // Best-effort decoration of the generation just published — a crash
        // between commit and here leaves a complete snapshot, just unlabeled.
        this.repo.setMeta('snapshot', snapshot);
      }
      this.state = {
        ...this.state,
        running: false,
        finishedAt: new Date().toISOString(),
        phase: 'done',
      };
      this.log(`insights refresh complete in ${Math.round((Date.now() - startedMs) / 1000)}s`);
    } catch (error) {
      // An interrupted sweep must never leave half a library behind: drop any
      // staging remnants; the last committed sweep and snapshot stay live.
      try {
        this.repo.abortSweepStaging();
      } catch {
        // Never mask the original failure with a cleanup error.
      }
      const cancelled = error instanceof CancelledError;
      this.state = {
        ...this.state,
        running: false,
        finishedAt: new Date().toISOString(),
        phase: cancelled ? 'cancelled' : 'error',
        error: cancelled ? null : error instanceof Error ? error.message : String(error),
      };
      if (!cancelled) {
        this.log(`insights refresh failed: ${this.state.error}`);
      }
    }
  }

  #checkCancelled() {
    if (this.state.cancelRequested) {
      throw new CancelledError();
    }
  }

  #setPhase(phase, progress = {}) {
    this.state = { ...this.state, phase, progress: { ...this.state.progress, ...progress } };
  }

  // Pages land in staging tables; only a sweep that reaches its natural end
  // (or the page cap, flagged as truncated) is swapped live — by the publish
  // transaction at the end of the run, never here, so a failure in any later
  // phase still leaves the previous generation live.
  async #sweepAssets(sweepBudget) {
    this.#setPhase('assets', { assetsSwept: 0 });
    this.#requireSweepDiskHeadroom(sweepBudget);
    this.repo.beginSweepStaging();
    let page = 1;
    let swept = 0;
    let truncated = false;
    const metadataOmissions = { total: 0, fields: {} };
    const peopleTruncation = {
      assets: 0,
      relationshipsOmitted: 0,
      perAssetLimit: MAX_INSIGHTS_PEOPLE_PER_ASSET,
    };
    const budget = createTraversalBudget({
      label: 'Immich asset sweep',
      maxPages: this.config.maxSweepPages,
      maxItems: this.config.maxSweepPages * this.config.sweepPageSize,
      timeoutMs: SWEEP_TRAVERSAL_TIMEOUT_MS,
    });
    while (page !== null) {
      if (page > this.config.maxSweepPages) {
        truncated = true;
        break;
      }
      this.#checkCancelled();
      budget.beginPage();
      const response = await this.immich.searchMetadata({
        page,
        size: this.config.sweepPageSize,
        withExif: true,
        withPeople: true,
      });
      const items = response?.assets?.items;
      if (!Array.isArray(items)) {
        throw new UpstreamPaginationError('Immich asset sweep returned an invalid items page.');
      }
      if (items.length > this.config.sweepPageSize) {
        throw new UpstreamPaginationError(
          `Immich asset sweep returned more than the requested ${this.config.sweepPageSize} items.`,
        );
      }
      budget.recordItems(items.length);
      // Admit the WHOLE page before its first SQLite write. A rejected item
      // therefore cannot leave a partial page, and the outer run catch drops
      // every earlier staging page while preserving the live generation.
      const rows = items.map((asset) => mapAsset(asset, { budget: sweepBudget }));
      for (const row of rows) {
        for (const field of row.omittedMetadataFields) {
          metadataOmissions.total += 1;
          metadataOmissions.fields[field] = (metadataOmissions.fields[field] ?? 0) + 1;
        }
        if (row.omittedPeopleRelationships > 0) {
          peopleTruncation.assets += 1;
          peopleTruncation.relationshipsOmitted += row.omittedPeopleRelationships;
        }
      }
      this.#requireSweepDiskHeadroom(sweepBudget);
      this.repo.insertAssets(rows, { staging: true });
      swept += items.length;
      this.#setPhase('assets', {
        assetsSwept: swept,
        metadataOmissions: metadataOmissions.total,
        peopleRelationshipsOmitted: peopleTruncation.relationshipsOmitted,
      });
      const nextPage = response?.assets?.nextPage;
      page = parseProgressingPage(nextPage, page, { label: 'Immich asset sweep' });
      if (items.length === 0) {
        break;
      }
    }
    this.log(
      `insights sweep cached ${swept} assets${truncated ? ` (TRUNCATED at ${this.config.maxSweepPages} pages — raise INSIGHTS_MAX_SWEEP_PAGES to cover the whole library)` : ''}`,
    );
    if (metadataOmissions.total > 0) {
      const fields = Object.entries(metadataOmissions.fields)
        .map(([field, count]) => `${field}: ${count}`)
        .join(', ');
      this.log(`insights sweep omitted ${metadataOmissions.total} invalid metadata values (${fields})`);
    }
    if (peopleTruncation.assets > 0) {
      this.log(
        `insights sweep limited people relationships on ${peopleTruncation.assets} asset(s); `
        + `${peopleTruncation.relationshipsOmitted} relationship entries were omitted`,
      );
    }
    return { swept, truncated, metadataOmissions, peopleTruncation };
  }

  // Names come from /people (a handful of paged calls); the counts come from
  // the STAGING sweep join table — the generation being built — so there are
  // no per-person API calls anymore. Nothing is written here: the counted
  // rows land in people_stats inside the publish transaction.
  async #collectPeople(sweepBudget) {
    this.#setPhase('people', { peopleDone: 0, peopleTotal: 0 });
    const namedById = new Map();
    let page = 1;
    let totalPeople = 0;
    const budget = createTraversalBudget({
      label: 'Immich people collection',
      maxPages: PEOPLE_MAX_PAGES,
      maxItems: PEOPLE_MAX_ITEMS,
      timeoutMs: PEOPLE_TRAVERSAL_TIMEOUT_MS,
    });
    while (page !== null) {
      this.#checkCancelled();
      budget.beginPage();
      const response = await this.immich.getPeople({ page, size: 500 });
      const people = response?.people;
      if (!Array.isArray(people) || typeof response?.hasNextPage !== 'boolean') {
        throw new UpstreamPaginationError('Immich people collection returned invalid pagination metadata.');
      }
      if (people.length > 500) {
        throw new UpstreamPaginationError('Immich people collection returned more than the requested 500 items.');
      }
      budget.recordItems(people.length);
      const reportedTotal = response?.total === undefined ? totalPeople : Number(response.total);
      if (!Number.isSafeInteger(reportedTotal) || reportedTotal < 0) {
        throw new UpstreamPaginationError('Immich people collection returned an invalid total.');
      }
      totalPeople = reportedTotal;
      for (const person of people) {
        const measured = measureJsonMetadata(person, 'people directory row', {
          maxItems: MAX_INSIGHTS_NESTED_ITEMS_PER_ASSET,
          maxBytes: MAX_INSIGHTS_DECODED_BYTES_PER_ASSET,
        });
        // Every raw directory row counts, including hidden, unnamed, and
        // duplicate records. Only generated rows dedupe below.
        sweepBudget.admit({
          nestedItems: 1 + measured.items,
          decodedBytes: measured.bytes,
          generatedRows: 0,
        });
        if (person?.name && String(person.name).trim() !== '' && !person.isHidden) {
          const id = requireImmichId(person.id, 'person');
          const name = boundedMetadataString(person.name, 'person name', { required: true, trim: true });
          if (!namedById.has(id)) {
            sweepBudget.admit({
              nestedItems: 0,
              decodedBytes: 0,
              generatedRows: 1,
            });
            namedById.set(id, { id, name });
          }
        }
      }
      if (response.hasNextPage && people.length === 0) {
        throw new UpstreamPaginationError('Immich people collection did not make progress.');
      }
      page = response.hasNextPage ? page + 1 : null;
    }

    const named = [...namedById.values()];
    const counts = this.repo.personCountsFor(named.map((person) => person.id), { staging: true });
    const counted = named
      .map((person) => ({ ...person, assetCount: counts.get(person.id) ?? 0 }))
      .filter((person) => person.assetCount > 0);
    counted.sort((a, b) => b.assetCount - a.assetCount);
    this.#setPhase('people', { peopleDone: counted.length, peopleTotal: named.length });
    this.log(`insights counted ${counted.length} named people (of ${totalPeople} detected)`);
    return { counted, totals: { named: named.length, total: totalPeople } };
  }

  #requireSweepDiskHeadroom(sweepBudget) {
    const { decodedBytes, generatedRows } = sweepBudget.status();
    const projectedBytes = BigInt(decodedBytes) + BigInt(generatedRows) * BigInt(INSIGHTS_GENERATED_ROW_ESTIMATE_BYTES);
    const requiredBytes =
      BigInt(MIN_INSIGHTS_SWEEP_FREE_BYTES) + projectedBytes * BigInt(INSIGHTS_SWEEP_HEADROOM_MULTIPLIER);
    let availableBytes;
    try {
      availableBytes = BigInt(this.diskFreeBytes());
    } catch (error) {
      throw new UpstreamPaginationError(
        `Insights could not verify free space for the staging sweep: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (availableBytes < requiredBytes) {
      throw new UpstreamPaginationError(
        `Insights refresh needs ${requiredBytes} free bytes for live, staging, indexed publish, and WAL headroom; ${availableBytes} are available.`,
      );
    }
  }

  // Returns the tag rows for the publish transaction; writes nothing here.
  async #collectTags() {
    const tags = await this.immich.listTags();
    const knownTagIds = [...new Set(tags
      .map((tag) => String(tag?.id ?? '').trim())
      .filter((id) => id && id.length <= MAX_INSIGHTS_TAG_ID_LENGTH))]
      .slice(0, MAX_INSIGHTS_KNOWN_TAGS);
    if (this.config.maxTagCounts === 0) {
      return { counted: [], knownTagIds };
    }
    // Only leaf tags: a parent's count is implied by its children, and
    // counting every node doubles the API bill for no insight.
    const parents = new Set(tags.map((tag) => tag.parentId).filter(Boolean));
    const leaves = tags.filter((tag) => !parents.has(tag.id)).slice(0, this.config.maxTagCounts);
    this.#setPhase('tags', { tagsDone: 0, tagsTotal: leaves.length });
    const rows = [];
    let done = 0;
    await mapWithConcurrency(leaves, this.config.statConcurrency, async (tag) => {
      this.#checkCancelled();
      const stats = await this.immich.searchStatistics({ tagIds: [tag.id] });
      const count = Number(stats?.total ?? 0);
      if (count > 0) {
        rows.push({ id: tag.id, value: tag.value ?? tag.name, count });
      }
      done += 1;
      if (done % 10 === 0 || done === leaves.length) {
        this.#setPhase('tags', { tagsDone: done });
      }
    });
    rows.sort((a, b) => b.count - a.count);
    return { counted: rows, knownTagIds };
  }

  // Everything the constellation needs, straight from the sweep. Edges below
  // two shared photos are noise (one lucky group shot links strangers).
  #computeGraph() {
    const nodes = this.repo.topPeople(60);
    const nodeIds = new Set(nodes.map((node) => node.id));
    const edges = this.repo.pairsFromSweep(500)
      .filter((pair) => pair.count >= 2 && nodeIds.has(pair.personA) && nodeIds.has(pair.personB))
      .map((pair) => ({ a: pair.personA, b: pair.personB, count: pair.count }));
    return { nodes, edges };
  }

  // Returns true when a label was added, so the caller knows to re-store
  // the snapshot it decorated.
  async #labelHomeArea(snapshot) {
    const home = snapshot.superlatives?.home;
    if (!home || !this.geocodeHome) {
      return false;
    }
    try {
      const area = await this.geocodeHome({ latitude: home.lat, longitude: home.lon });
      if (area?.label) {
        home.areaLabel = area.label;
        return true;
      }
    } catch {
      // Best-effort naming; the city fallback is always available.
    }
    return false;
  }

  // Keep the user-defined favorites tag count fresh alongside the snapshot.
  // The config object is live — settings changes land here without a restart.
  // Returns the meta row for the publish transaction; writes nothing here.
  async #refreshFavoritesTag() {
    const id = this.config.favoritesTagId;
    if (!id) {
      return null;
    }
    const stats = await this.immich.searchStatistics({ tagIds: [id] });
    return {
      id,
      value: this.config.favoritesTagValue || '',
      count: Number(stats?.total ?? 0),
    };
  }

  // The one moment a refresh becomes visible: swap the staged sweep live,
  // replace every derived table, and store the snapshot — all inside a
  // single transaction (the repository's transaction() is re-entrant, so
  // the transactional repo helpers compose). Reads after the swap — pairs,
  // and everything #computeSnapshot aggregates — see the new generation:
  // one process, one connection, so this connection reads its own
  // uncommitted writes. Rollback on any failure leaves generation N live.
  #publish({ startedMs, truncated, metadataOmissions, peopleTruncation, people, tags, favoritesTag }) {
    return this.repo.transaction(() => {
      this.repo.commitSweepStaging();
      this.repo.replacePeople(people.counted);
      this.repo.setMeta('peopleTotals', people.totals);
      this.repo.replacePairs(this.repo.pairsFromSweep(500));
      this.repo.replaceTags(tags.counted);
      this.repo.replaceKnownTagIds(tags.knownTagIds);
      if (favoritesTag) {
        this.repo.setMeta('favoritesTag', favoritesTag);
      }
      const snapshot = this.#computeSnapshot(
        Date.now() - startedMs,
        truncated,
        metadataOmissions,
        peopleTruncation,
      );
      this.repo.setMeta('snapshot', snapshot);
      return snapshot;
    });
  }

  #computeSnapshot(
    sweepDurationMs,
    sweepTruncated = false,
    metadataOmissions = { total: 0, fields: {} },
    peopleTruncation = {
      assets: 0,
      relationshipsOmitted: 0,
      perAssetLimit: MAX_INSIGHTS_PEOPLE_PER_ASSET,
    },
  ) {
    const totals = this.repo.sweepTotals();
    const peopleTotals = this.repo.getMeta('peopleTotals') ?? { named: 0, total: 0 };
    const enrichedTotal = this.enrichRepo ? this.enrichRepo.libraryStats().enrichedTotal : null;
    const darkMatter = this.repo.darkMatter();
    const superlatives = computeSuperlatives(this.repo);
    const trips = computeTrips(this.repo.timelineDays(), superlatives.home, {
      awayKm: this.config.tripAwayKm,
      gapDays: this.config.tripGapDays,
      minDays: this.config.tripMinDays,
    });
    return {
      generatedAt: new Date().toISOString(),
      sweepDurationMs,
      // True when the page cap ended the sweep early: the numbers below
      // describe a bounded slice of the library, not all of it.
      sweepTruncated,
      metadataOmissions,
      peopleTruncation,
      totals: {
        ...totals,
        peopleNamed: peopleTotals.named,
        peopleTotal: peopleTotals.total,
      },
      years: this.repo.yearHistogram(),
      people: this.repo.topPeople(this.config.topPeople),
      pairs: this.repo.topPairs(10),
      places: this.repo.topPlaces(10),
      cameras: this.repo.topCameras(10),
      tags: this.repo.topTags(20),
      graph: this.#computeGraph(),
      superlatives,
      trips,
      darkMatter: {
        ...darkMatter,
        notEnriched: enrichedTotal === null ? null : Math.max(0, totals.photos - enrichedTotal),
      },
    };
  }
}

// Records-book stats derived from the sweep. "Home" is the densest ~11km
// grid cell of geotagged photos; "furthest" is the geotagged photo farthest
// from that cell's centroid.
export function computeSuperlatives(repo) {
  const busiestDays = repo.busiestDays(5);
  const busiestMonths = repo.busiestMonths(5);
  const oldest = repo.oldestAsset();

  let longestGap = null;
  const days = repo.distinctDays();
  for (let i = 1; i < days.length; i += 1) {
    const gapDays = Math.round((Date.parse(days[i]) - Date.parse(days[i - 1])) / 86_400_000) - 1;
    if (gapDays > (longestGap?.days ?? 0)) {
      longestGap = { days: gapDays, from: days[i - 1], to: days[i] };
    }
  }

  let home = null;
  let furthest = null;
  const geo = repo.geoRows();
  if (geo.length > 0) {
    const cells = new Map();
    for (const row of geo) {
      const key = `${row.lat.toFixed(1)},${row.lon.toFixed(1)}`;
      const cell = cells.get(key) ?? { count: 0, latSum: 0, lonSum: 0, cities: new Map() };
      cell.count += 1;
      cell.latSum += row.lat;
      cell.lonSum += row.lon;
      if (row.city) {
        cell.cities.set(row.city, (cell.cities.get(row.city) ?? 0) + 1);
      }
      cells.set(key, cell);
    }
    let best = null;
    for (const cell of cells.values()) {
      if (!best || cell.count > best.count) {
        best = cell;
      }
    }
    const homeLat = best.latSum / best.count;
    const homeLon = best.lonSum / best.count;
    const homeCity = [...best.cities.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    home = { lat: homeLat, lon: homeLon, city: homeCity, count: best.count };
    for (const row of geo) {
      const distanceKm = haversineKm(homeLat, homeLon, row.lat, row.lon);
      if (!furthest || distanceKm > furthest.distanceKm) {
        furthest = {
          id: row.id,
          distanceKm: Math.round(distanceKm),
          city: row.city,
          country: row.country,
          day: row.day,
          lat: row.lat,
          lon: row.lon,
        };
      }
    }
  }

  return {
    busiestDay: busiestDays[0] ?? null,
    busiestDays,
    busiestMonth: busiestMonths[0] ?? null,
    busiestMonths,
    longestGap,
    oldest,
    home,
    furthest,
  };
}

// Group away-from-home days into trips. A trip is a run of days whose photos
// sit farther than awayKm from the home cell; up to gapDays of camera-quiet
// (or geo-less) days may fall inside it, but a day photographed near home
// ends it. Trips with fewer than minDays away-days are day-outings, not trips.
export function computeTrips(days, home, { awayKm = 100, gapDays = 3, minDays = 2 } = {}) {
  const validDays = days.filter((entry) => isValidCalendarDay(entry?.day));
  if (!home || validDays.length === 0) {
    return [];
  }
  const classified = validDays.map((entry) => ({
    ...entry,
    kind: entry.lat === null
      ? 'unknown'
      : haversineKm(home.lat, home.lon, entry.lat, entry.lon) > awayKm ? 'away' : 'home',
    distanceKm: entry.lat === null ? null : Math.round(haversineKm(home.lat, home.lon, entry.lat, entry.lon)),
  }));

  const trips = [];
  let current = null;
  const close = () => {
    if (current && current.awayDays.length >= minDays) {
      trips.push(finalizeTrip(current, validDays));
    }
    current = null;
  };

  for (const entry of classified) {
    if (entry.kind === 'home') {
      close();
      continue;
    }
    if (entry.kind === 'unknown') {
      continue;
    }
    if (current) {
      const gap = Math.round((Date.parse(entry.day) - Date.parse(current.lastAwayDay)) / 86_400_000) - 1;
      if (gap > gapDays) {
        close();
      }
    }
    current ??= { awayDays: [], lastAwayDay: entry.day };
    current.awayDays.push(entry);
    current.lastAwayDay = entry.day;
  }
  close();
  trips.sort((a, b) => (a.start < b.start ? 1 : -1));
  return trips;
}

function finalizeTrip(current, allDays) {
  const start = current.awayDays[0].day;
  const end = current.lastAwayDay;
  const cityCounts = new Map();
  let maxDistanceKm = 0;
  for (const entry of current.awayDays) {
    maxDistanceKm = Math.max(maxDistanceKm, entry.distanceKm ?? 0);
    if (entry.city) {
      const slot = cityCounts.get(entry.city) ?? { count: 0, country: entry.country };
      slot.count += entry.count;
      cityCounts.set(entry.city, slot);
    }
  }
  const topCity = [...cityCounts.entries()].sort((a, b) => b[1].count - a[1].count)[0];
  // Photo count spans the whole trip window, including quiet days inside it.
  const photoCount = allDays
    .filter((entry) => entry.day >= start && entry.day <= end)
    .reduce((sum, entry) => sum + entry.count, 0);
  return {
    start,
    end,
    days: Math.round((Date.parse(end) - Date.parse(start)) / 86_400_000) + 1,
    photoCount,
    city: topCity?.[0] ?? null,
    country: topCity?.[1].country ?? null,
    maxDistanceKm,
  };
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

class CancelledError extends Error {
  constructor() {
    super('insights refresh cancelled');
  }
}

function idleState() {
  return {
    running: false,
    cancelRequested: false,
    startedAt: null,
    finishedAt: null,
    phase: 'idle',
    progress: {},
    error: null,
  };
}

export function createInsightsSweepBudget(limits = null) {
  const maxNestedItems = sweepLimit(
    limits?.maxNestedItems,
    MAX_INSIGHTS_NESTED_ITEMS_PER_SWEEP,
    'nested-item',
  );
  const maxDecodedBytes = sweepLimit(
    limits?.maxDecodedBytes,
    MAX_INSIGHTS_DECODED_BYTES_PER_SWEEP,
    'decoded-byte',
  );
  const maxGeneratedRows = sweepLimit(
    limits?.maxGeneratedRows,
    MAX_INSIGHTS_GENERATED_ROWS_PER_SWEEP,
    'generated-row',
  );
  let nestedItems = 0;
  let decodedBytes = 0;
  let generatedRows = 0;
  return {
    admit({ nestedItems: addItems = 0, decodedBytes: addBytes = 0, generatedRows: addRows = 0 }) {
      for (const [label, value] of [['nested items', addItems], ['decoded bytes', addBytes], ['generated rows', addRows]]) {
        if (!Number.isSafeInteger(value) || value < 0) {
          throw new UpstreamPaginationError(`Immich Insights sweep returned an invalid ${label} charge.`);
        }
      }
      if (nestedItems + addItems > maxNestedItems) {
        throw new UpstreamPaginationError(
          `Immich Insights sweep exceeded its ${maxNestedItems}-nested-item limit.`,
        );
      }
      if (decodedBytes + addBytes > maxDecodedBytes) {
        throw new UpstreamPaginationError(
          `Immich Insights sweep exceeded its ${maxDecodedBytes}-decoded-byte limit.`,
        );
      }
      if (generatedRows + addRows > maxGeneratedRows) {
        throw new UpstreamPaginationError(
          `Immich Insights sweep exceeded its ${maxGeneratedRows}-generated-row limit.`,
        );
      }
      nestedItems += addItems;
      decodedBytes += addBytes;
      generatedRows += addRows;
    },
    status() {
      return { nestedItems, decodedBytes, generatedRows };
    },
  };
}

export function mapAsset(asset, { budget = null } = {}) {
  if (!asset || typeof asset !== 'object' || Array.isArray(asset)) {
    throw new UpstreamPaginationError('Immich asset sweep returned an invalid asset.');
  }
  const id = requireImmichId(asset.id, 'asset');
  const exif = asset.exifInfo ?? {};
  if (!exif || typeof exif !== 'object' || Array.isArray(exif)) {
    throw new UpstreamPaginationError(`Immich asset ${id} returned invalid EXIF metadata.`);
  }
  const rawPeople = asset.people ?? [];
  if (!Array.isArray(rawPeople)) {
    throw new UpstreamPaginationError(`Immich asset ${id} returned invalid people metadata.`);
  }
  let decodedBytes = utf8Bytes(id);
  let nestedItems = 0;

  const type = boundedMetadataString(asset.type ?? 'IMAGE', `type on asset ${id}`, { required: true });
  const rawTakenAt = exif.dateTimeOriginal ?? asset.localDateTime ?? asset.fileCreatedAt ?? null;
  if (rawTakenAt !== null && typeof rawTakenAt !== 'string') {
    throw new UpstreamPaginationError(`Immich asset ${id} returned an invalid capture timestamp.`);
  }
  const boundedTakenAt = boundedMetadataString(
    rawTakenAt,
    `capture time on asset ${id}`,
  );
  // A bounded but semantically impossible camera date does not invalidate an
  // otherwise useful asset. Retain the photo while omitting all derived date
  // fields; protocol-shape and resource-limit violations still fail closed.
  const takenAt = boundedTakenAt !== null && isValidCaptureTimestamp(boundedTakenAt)
    ? boundedTakenAt
    : null;
  const city = boundedMetadataString(exif.city, `city on asset ${id}`);
  const state = boundedMetadataString(exif.state, `state on asset ${id}`);
  const country = boundedMetadataString(exif.country, `country on asset ${id}`);
  const make = boundedMetadataString(exif.make, `camera make on asset ${id}`);
  const model = boundedMetadataString(exif.model, `camera model on asset ${id}`);
  const lens = boundedMetadataString(exif.lensModel, `camera lens on asset ${id}`);
  const omittedMetadataFields = [];
  const fileSize = boundedMetadataNumber(exif.fileSizeInByte, `file size on asset ${id}`, {
    field: 'fileSizeInByte',
    min: 0,
    onOmitted: (field) => omittedMetadataFields.push(field),
  });
  let lat = boundedMetadataNumber(exif.latitude, `latitude on asset ${id}`, {
    field: 'latitude',
    min: -90,
    max: 90,
    onOmitted: (field) => omittedMetadataFields.push(field),
  });
  let lon = boundedMetadataNumber(exif.longitude, `longitude on asset ${id}`, {
    field: 'longitude',
    min: -180,
    max: 180,
    onOmitted: (field) => omittedMetadataFields.push(field),
  });

  decodedBytes += utf8Bytes(type);
  // Only the fixed EXIF projection Insights stores or expands is admitted to
  // the per-asset and aggregate sweep budgets. Immich can legitimately carry
  // large descriptions, profile metadata, and future fields that Insights
  // never reads; measuring those values made an unused field able to abort the
  // entire staged sweep. The field name is charged as well as the bounded
  // value so retained metadata remains fully accounted for.
  for (const [field, value] of [
    ['dateTimeOriginal', boundedTakenAt],
    ['city', city],
    ['state', state],
    ['country', country],
    ['make', make],
    ['model', model],
    ['lensModel', lens],
    ['fileSizeInByte', fileSize],
    ['latitude', lat],
    ['longitude', lon],
  ]) {
    if (value === null) continue;
    nestedItems += 1;
    decodedBytes += utf8Bytes(field) + utf8Bytes(String(value));
  }
  const personIds = [];
  const seenPeople = new Set();
  let omittedPeopleRelationships = 0;
  for (let index = 0; index < rawPeople.length; index += 1) {
    const person = rawPeople[index];
    const candidate = person?.id ?? person?.personId ?? person?.person?.id ?? null;
    if (candidate === null || candidate === undefined || candidate === '') continue;
    const personId = requireImmichId(candidate, `person relationship on asset ${id}`);
    if (seenPeople.has(personId)) continue;
    if (personIds.length >= MAX_INSIGHTS_PEOPLE_PER_ASSET) {
      // The cap bounds relationship rows and pair expansion. Stop inspecting
      // the remainder as soon as the first additional unique relationship is
      // found: unused PersonWithFaces fields must not consume sweep resources
      // or turn a legitimate crowd photo into a whole-library failure.
      omittedPeopleRelationships = rawPeople.length - index;
      break;
    }
    seenPeople.add(personId);
    personIds.push(personId);
    nestedItems += 1;
    decodedBytes += utf8Bytes('personId') + utf8Bytes(personId);
  }
  if (decodedBytes > MAX_INSIGHTS_DECODED_BYTES_PER_ASSET) {
    throw new UpstreamPaginationError(
      `Immich asset ${id} exceeded its ${MAX_INSIGHTS_DECODED_BYTES_PER_ASSET}-decoded-byte limit.`,
    );
  }
  budget?.admit({
    nestedItems,
    decodedBytes,
    generatedRows: 1 + personIds.length,
  });

  const year = takenAt ? Number(takenAt.slice(0, 4)) : null;
  const day = takenAt ? takenAt.slice(0, 10) : null;
  // Cameras without a GPS fix can write 0,0. That pair means "no location",
  // not a photo in the Gulf of Guinea.
  if (lat === 0 && lon === 0) {
    lat = null;
    lon = null;
  }
  return {
    id,
    type,
    takenAt,
    year: Number.isFinite(year) ? year : null,
    day,
    city,
    state,
    country,
    make,
    model,
    lens,
    isFavorite: Boolean(asset.isFavorite),
    isArchived: Boolean(asset.isArchived),
    fileSize,
    lat,
    lon,
    personIds,
    omittedPeopleRelationships,
    omittedMetadataFields,
  };
}

function sweepLimit(value, fallback, label) {
  if (value === null || value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`Insights ${label} sweep limit must be a positive safe integer.`);
  }
  return value;
}

function requireImmichId(value, label) {
  if (typeof value !== 'string' || value.length > MAX_INSIGHTS_IDENTIFIER_LENGTH || !IMMICH_OPAQUE_ID.test(value)) {
    throw new UpstreamPaginationError(`Immich returned an invalid ${label} identifier.`);
  }
  return value;
}

function boundedMetadataString(value, label, { required = false, trim = false } = {}) {
  if (value === null || value === undefined) {
    if (required) throw new UpstreamPaginationError(`Immich returned a missing ${label}.`);
    return null;
  }
  if (!['string', 'number'].includes(typeof value)) {
    throw new UpstreamPaginationError(`Immich returned an invalid ${label}.`);
  }
  const text = trim ? String(value).trim() : String(value);
  if (
    (required && text === '') ||
    text.length > MAX_INSIGHTS_METADATA_FIELD_BYTES ||
    utf8Bytes(text) > MAX_INSIGHTS_METADATA_FIELD_BYTES
  ) {
    throw new UpstreamPaginationError(`Immich returned an oversized or empty ${label}.`);
  }
  return text;
}

function boundedMetadataNumber(value, label, {
  field,
  min = -Infinity,
  max = Infinity,
  onOmitted = () => {},
} = {}) {
  if (value === null || value === undefined) return null;
  if (!['string', 'number'].includes(typeof value)) {
    onOmitted(field);
    return null;
  }
  // Oversized retained input is still a resource-limit violation. Ordinary
  // malformed or out-of-range numeric metadata is instead omitted: Immich has
  // historically emitted values Number() could not use, and one such field
  // must not discard the entire staged library sweep.
  const text = boundedMetadataString(value, label, { trim: true });
  const number = Number(text);
  if (text === '' || !Number.isFinite(number) || number < min || number > max) {
    onOmitted(field);
    return null;
  }
  return number;
}

function boundedMetadataBytes(value, label) {
  const text = String(value);
  if (text.length > MAX_INSIGHTS_METADATA_FIELD_BYTES) {
    throw new UpstreamPaginationError(`Immich returned an oversized ${label}.`);
  }
  const bytes = utf8Bytes(text);
  if (bytes > MAX_INSIGHTS_METADATA_FIELD_BYTES) {
    throw new UpstreamPaginationError(`Immich returned an oversized ${label}.`);
  }
  return bytes;
}

function measureJsonMetadata(value, label, {
  maxItems,
  maxBytes,
  maxDepth = 4,
  itemLimitLabel = 'nested-item',
}) {
  let items = 0;
  let bytes = 0;
  const seen = new WeakSet();
  const addItem = () => {
    items += 1;
    if (items > maxItems) {
      throw new UpstreamPaginationError(`Immich ${label} exceeded its ${maxItems}-${itemLimitLabel} limit.`);
    }
  };
  const addBytes = (entry, entryLabel) => {
    bytes += boundedMetadataBytes(entry, entryLabel);
    if (bytes > maxBytes) {
      throw new UpstreamPaginationError(`Immich ${label} exceeded its ${maxBytes}-decoded-byte limit.`);
    }
  };
  const visit = (entry, depth) => {
    if (entry === null || entry === undefined) return;
    if (['string', 'number', 'boolean'].includes(typeof entry)) {
      addBytes(entry, label);
      return;
    }
    if (typeof entry !== 'object' || depth >= maxDepth || seen.has(entry)) {
      throw new UpstreamPaginationError(`Immich ${label} contained invalid nested metadata.`);
    }
    seen.add(entry);
    if (Array.isArray(entry)) {
      for (const child of entry) {
        addItem();
        visit(child, depth + 1);
      }
      return;
    }
    // for...in stops at the first item beyond the limit without allocating
    // an attacker-sized Object.entries() copy of an already-large payload.
    for (const key in entry) {
      if (!Object.hasOwn(entry, key)) continue;
      addItem();
      addBytes(key, `${label} key`);
      visit(entry[key], depth + 1);
    }
  };
  visit(value, 0);
  return { items, bytes };
}

function filesystemAvailableBytes(path) {
  const stats = statfsSync(path, { bigint: true });
  return stats.bavail * stats.bsize;
}

function utf8Bytes(value) {
  return Buffer.byteLength(value, 'utf8');
}

async function mapWithConcurrency(items, concurrency, work) {
  const queue = [...items];
  const workers = Array.from({ length: Math.max(1, concurrency) }, async () => {
    while (queue.length > 0) {
      const item = queue.shift();
      await work(item);
    }
  });
  await Promise.all(workers);
}
