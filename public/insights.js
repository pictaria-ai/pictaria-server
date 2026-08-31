const state = {
  polling: null,
  refreshPending: false,
  lastRefreshError: null,
  immichUrl: null,
  snapshot: null,
  browser: null, // { slice, items, nextPage, loading }
  lightboxIndex: -1,
  activeYear: null,
  favoritesTag: null, // { id, value, count } when a tag stands in for Immich favorites
  allTags: null, // lazy-loaded tag list for the favorites/lens popovers
  lens: null, // { type, id, name, label, slice, years: Map } — histogram filter
  constellation: null, // running force-sim state for the people graph
  timeline: null, // { weeks, window: {from,to}, days, selection }
  personCard: null, // { stack: [detail…], seq } — chain-navigable person popup
  placeCard: null, // { seq, loading, detail } — location card popup
  locationGroups: [], // synthetic locations: [{ name, cities }]
};

const DAY_MS = 86_400_000;

function addDays(day, n) {
  const date = new Date(`${day}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + n);
  return date.toISOString().slice(0, 10);
}

function daysBetween(a, b) {
  return Math.round((Date.parse(b) - Date.parse(a)) / DAY_MS);
}

function fmtRange(start, end) {
  const [sy, sm, sd] = start.split('-').map(Number);
  const [ey, em, ed] = end.split('-').map(Number);
  if (start === end) return fmtDay(start);
  if (sy === ey && sm === em) return `${MONTH_NAMES[sm - 1]} ${sd}–${ed}, ${sy}`;
  if (sy === ey) return `${MONTH_NAMES[sm - 1]} ${sd} – ${MONTH_NAMES[em - 1]} ${ed}, ${sy}`;
  return `${fmtDay(start)} – ${fmtDay(end)}`;
}
const el = (id) => document.getElementById(id);

async function api(path, options = {}) {
  const response = await fetch(path, options);
  if (response.status === 401) throw Object.assign(new Error('unauthorized'), { unauthorized: true });
  if (!response.ok && response.status !== 409) {
    let message = `Request failed: ${response.status}`;
    try {
      const body = await response.json();
      if (body?.message) message = body.message;
    } catch { /* keep default */ }
    throw new Error(message);
  }
  return response.json();
}

function toast(message) {
  const node = el('toast');
  node.textContent = message;
  node.classList.add('show');
  setTimeout(() => node.classList.remove('show'), 2600);
}

function showLogin() {
  el('content').hidden = true;
  el('empty').hidden = true;
  el('connStatus').hidden = true;
  window.pictariaGate.show();
}

function fmt(n) {
  return Number(n ?? 0).toLocaleString();
}

function fmtBytes(bytes) {
  if (!bytes) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

function fmtAgo(iso) {
  if (!iso) return '';
  const mins = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (mins < 2) return 'just now';
  if (mins < 90) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 36) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function fmtDay(day) {
  if (!day) return '—';
  const [y, m, d] = day.split('-').map(Number);
  return `${MONTH_NAMES[(m || 1) - 1]} ${d}, ${y}`;
}

function fmtMonthShort(day) {
  if (!day) return '—';
  const [y, m] = day.split('-').map(Number);
  return `${MONTH_NAMES[(m || 1) - 1]} ’${String(y).slice(-2)}`;
}

function fmtMonth(month) {
  if (!month) return '—';
  const [y, m] = month.split('-').map(Number);
  return `${MONTH_NAMES[(m || 1) - 1]} ${y}`;
}

function faceUrl(personId) {
  return `/api/insights/people/${encodeURIComponent(personId)}/thumbnail`;
}

function thumbUrl(assetId, size = 'thumbnail') {
  return `/api/albums/assets/${encodeURIComponent(assetId)}/thumbnail?size=${size}`;
}

// ---------------------------------------------------------------------------
// Slices: every clickable stat becomes one of these. `filters` feeds the
// photo browser; the same filters (minus view-only keys) feed album creation.
// ---------------------------------------------------------------------------

function yearRange(year) {
  return { takenAfter: `${year}-01-01`, takenBefore: `${year}-12-31` };
}

function monthRange(month) {
  const [y, m] = month.split('-').map(Number);
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { takenAfter: `${month}-01`, takenBefore: `${month}-${String(lastDay).padStart(2, '0')}` };
}

function personSliceFor(person) {
  return {
    title: person.name,
    count: person.count ?? null,
    filters: { personIds: [person.id] },
    people: [{ id: person.id, name: person.name }],
  };
}

function pairSliceFor(a, b, count) {
  return {
    title: `${a.name} + ${b.name}`,
    count: count ?? null,
    filters: { personIds: [a.id, b.id] },
    people: [{ id: a.id, name: a.name }, { id: b.id, name: b.name }],
  };
}

// --- synthetic locations (city groups) ---

function groupFor(label) {
  return (state.locationGroups ?? []).find((group) => group.name === label) ?? null;
}

// The filter fragment for a place label: a group's member cities (OR,
// fanned out server-side) or the plain city.
function placeFilters(label, place = null) {
  const members = place?.isGroup ? place.members : groupFor(label)?.cities;
  return members ? { cities: members } : { city: label };
}

// A place name with the synthetic-location marker and a members tooltip.
function placeNameNode(label, place = null) {
  const members = place?.isGroup ? place.members : groupFor(label)?.cities;
  if (!members) return null;
  const span = document.createElement('span');
  span.append(`${label} `);
  const mark = document.createElement('span');
  mark.className = 'grp-mark';
  mark.textContent = '⁕';
  mark.title = `Includes ${members.join(', ')}`;
  span.append(mark);
  return span;
}

// The Immich web app's search page reads its filters from a JSON-encoded
// `query` param, so any slice can deep-link to the same view in Immich.
// A pure single-person slice gets the nicer dedicated person page.
function immichLinkForSlice(filters) {
  if (!state.immichUrl) return null;
  // Immich's search can't express a multi-city OR — no deep link for
  // synthetic locations beyond a single member. Nor can the web UI express
  // an explicit "field is unset" (null) filter — dropping it would link to
  // a much broader search, so no link at all.
  if (Array.isArray(filters.cities) && filters.cities.length > 1) return null;
  if (filters.city === null || filters.country === null) return null;
  const query = {};
  if (Array.isArray(filters.personIds) && filters.personIds.length > 0) query.personIds = filters.personIds;
  if (Array.isArray(filters.tagIds) && filters.tagIds.length > 0) query.tagIds = filters.tagIds;
  if (Array.isArray(filters.cities) && filters.cities.length === 1) query.city = filters.cities[0];
  for (const key of ['city', 'state', 'country', 'make', 'model']) {
    if (filters[key]) query[key] = filters[key];
  }
  if (typeof filters.isFavorite === 'boolean') query.isFavorite = filters.isFavorite;
  if (filters.day) {
    query.takenAfter = `${filters.day}T00:00:00.000Z`;
    query.takenBefore = `${filters.day}T23:59:59.999Z`;
  } else {
    if (filters.takenAfter) query.takenAfter = `${filters.takenAfter}T00:00:00.000Z`;
    if (filters.takenBefore) query.takenBefore = `${filters.takenBefore}T23:59:59.999Z`;
  }
  const keys = Object.keys(query);
  if (keys.length === 0) return null;
  if (keys.length === 1 && query.personIds?.length === 1) {
    return `${state.immichUrl}/people/${encodeURIComponent(query.personIds[0])}`;
  }
  return `${state.immichUrl}/search?query=${encodeURIComponent(JSON.stringify(query))}`;
}

// Hand a slice to the Albums builder prefilled: name, people/tag chips (ids
// with display names), and the plain filter fields. Returns null when the
// slice has nothing the album engine can express (e.g. favorites).
function albumHrefForSlice(slice) {
  const filters = slice.filters;
  // The album engine has no "field is unset" filter — a prefill built from
  // the remaining fields would quietly match far more photos than the slice.
  if (filters.city === null || filters.country === null) return null;
  const prefill = { albumName: slice.title };
  if (Array.isArray(slice.people) && slice.people.length > 0) {
    prefill.people = slice.people;
  } else if (Array.isArray(filters.personIds) && filters.personIds.length > 0) {
    prefill.people = filters.personIds.map((id) => ({ id, name: '' }));
  }
  if (Array.isArray(slice.tags) && slice.tags.length > 0) {
    prefill.tags = slice.tags;
  } else if (Array.isArray(filters.tagIds) && filters.tagIds.length > 0) {
    prefill.tags = filters.tagIds.map((id) => ({ id, name: '', value: '' }));
  }
  for (const key of ['city', 'state', 'country', 'make', 'model']) {
    if (filters[key]) prefill[key] = filters[key];
  }
  if (Array.isArray(filters.cities) && filters.cities.length > 0) {
    prefill.cities = filters.cities;
  }
  if (filters.day) {
    prefill.takenAfter = filters.day;
    prefill.takenBefore = filters.day;
  } else {
    if (filters.takenAfter) prefill.takenAfter = filters.takenAfter;
    if (filters.takenBefore) prefill.takenBefore = filters.takenBefore;
  }
  const hasCriteria = Object.keys(prefill).some((key) => key !== 'albumName');
  return hasCriteria ? `/albums.html#create=${encodeURIComponent(JSON.stringify(prefill))}` : null;
}

function openSlice(slice) {
  state.browser = { slice, items: [], nextPage: 1, loading: false };
  el('modalTitle').textContent = slice.title;
  el('modalSub').textContent = slice.count != null ? `${fmt(slice.count)} items` : '';
  el('photoGrid').replaceChildren();
  el('gridMore').hidden = true;
  const albumHref = albumHrefForSlice(slice);
  el('modalAlbumBtn').hidden = !albumHref;
  if (albumHref) el('modalAlbumBtn').href = albumHref;
  const immichLink = immichLinkForSlice(slice.filters);
  el('modalImmich').hidden = !immichLink;
  if (immichLink) el('modalImmich').href = immichLink;
  // Visible whenever the slice can be enriched; inactive (not hidden) when
  // enrichment is off, so the capability stays discoverable.
  el('modalEnrichBtn').hidden = !slice.filters;
  el('modalEnrichBtn').disabled = state.enrichEnabled !== true;
  el('modalEnrichBtn').textContent = 'Send to Enrich';
  el('modalEnrichBtn').title = state.enrichEnabled === true ? '' : 'Enrichment is off — enable it in Settings → Enrich';
  // Send to Curate needs no AI — always live when the slice has filters.
  el('modalCurateBtn').hidden = !slice.filters;
  el('modalCurateBtn').disabled = false;
  el('modalCurateBtn').textContent = 'Send to Curate';
  el('photoModal').hidden = false;
  document.body.style.overflow = 'hidden';
  void loadGridPage();
  void loadSliceCoverage(state.browser);
}

function closeModal() {
  el('photoModal').hidden = true;
  // A person or location card may still be open underneath — keep the page locked.
  document.body.style.overflow = state.personCard || state.placeCard ? 'hidden' : '';
  state.browser = null;
}

async function loadGridPage() {
  const browser = state.browser;
  if (!browser || browser.loading || browser.nextPage === null) return;
  browser.loading = true;
  el('gridMore').disabled = true;
  try {
    const result = await api('/api/insights/photos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filters: browser.slice.filters, page: browser.nextPage, size: 100 }),
    });
    if (state.browser !== browser) return; // modal was closed or replaced mid-flight
    const startIndex = browser.items.length;
    browser.items.push(...result.items);
    browser.nextPage = result.nextPage;
    const grid = el('photoGrid');
    const pageButtons = [];
    result.items.forEach((item, offset) => {
      const index = startIndex + offset;
      const button = document.createElement('button');
      button.className = 'ph';
      button.type = 'button';
      const img = document.createElement('img');
      img.loading = 'lazy';
      img.src = thumbUrl(item.id);
      img.alt = '';
      button.append(img);
      if (item.type === 'VIDEO') {
        const badge = document.createElement('span');
        badge.className = 'vid';
        badge.textContent = '▶';
        button.append(badge);
      }
      button.addEventListener('click', () => openLightbox(index));
      grid.append(button);
      pageButtons.push({ id: item.id, button });
    });
    void annotateCoverage(browser, pageButtons);
    if (browser.items.length === 0) {
      const none = document.createElement('div');
      none.className = 'freshness';
      none.textContent = 'No photos matched.';
      grid.append(none);
    }
    el('gridMore').hidden = browser.nextPage === null;
  } catch (error) {
    if (error.unauthorized) { showLogin(); return; }
    toast(`Could not load photos: ${error.message}`);
  } finally {
    browser.loading = false;
    el('gridMore').disabled = false;
  }
}

// Coverage marks for one grid page: ✦ = enriched, ✓ = curated. Done-states
// only — no mark means "not yet", so nothing screams on a fresh library.
async function annotateCoverage(browser, pageButtons) {
  if (pageButtons.length === 0) return;
  let coverage;
  try {
    const body = await api('/api/review/coverage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ assetIds: pageButtons.map((entry) => entry.id) }),
    });
    coverage = body.coverage ?? {};
  } catch {
    return; // marks are a bonus — never block the grid on them
  }
  if (state.browser !== browser) return; // modal closed or replaced mid-flight
  for (const { id, button } of pageButtons) {
    const entry = coverage[id];
    if (!entry) continue;
    if (entry.enriched) {
      const mark = document.createElement('span');
      mark.className = 'cov enr';
      mark.textContent = '✦';
      mark.title = 'Enriched';
      button.append(mark);
    }
    if (entry.curated) {
      const mark = document.createElement('span');
      mark.className = 'cov cur';
      mark.textContent = '✓';
      mark.title = 'Curated';
      button.append(mark);
    }
  }
}

// Whole-slice coverage line in the modal head — the numbers that answer
// "should I send this set to Enrich or Curate?". Lazy: fills in a beat
// after the modal opens; big slices are sampled (first 5,000), honestly.
// The photo count comes from the same image-only search that drives the
// marks — snapshot counts can disagree (videos; day-aggregate slices label
// each day with one city), so the resolver is the modal's source of truth.
async function loadSliceCoverage(browser) {
  el('modalCoverage').textContent = '';
  if (!browser.slice?.filters) return;
  let summary;
  try {
    summary = await api('/api/review/coverage-summary', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filters: browser.slice.filters }),
    });
  } catch {
    return;
  }
  if (state.browser !== browser) return;
  if (!summary.truncated) {
    el('modalSub').textContent = `${fmt(summary.total)} photo${summary.total === 1 ? '' : 's'}`;
    // Carry the corrected count into the slice itself so Send to Enrich's
    // queue estimate matches what a run will actually resolve.
    browser.slice.count = summary.total;
  }
  el('modalCoverage').textContent =
    `· ✦ ${fmt(summary.enriched)} enriched · ✓ ${fmt(summary.curated)} curated`
    + (summary.truncated ? ` (of the first ${fmt(summary.total)} photos)` : '');
}

// --- lightbox ---

function openLightbox(index) {
  state.lightboxIndex = index;
  renderLightbox();
  el('lightbox').hidden = false;
}

function closeLightbox() {
  el('lightbox').hidden = true;
  state.lightboxIndex = -1;
}

function renderLightbox() {
  const item = state.browser?.items[state.lightboxIndex];
  if (!item) return;
  el('lbImg').src = thumbUrl(item.id, 'preview');
  const when = item.takenAt ? fmtDay(String(item.takenAt).slice(0, 10)) : '';
  el('lbCap').textContent = when;
  el('lbImmich').hidden = !state.immichUrl;
  if (state.immichUrl) el('lbImmich').href = `${state.immichUrl}/photos/${encodeURIComponent(item.id)}`;
  el('lbPrev').style.visibility = state.lightboxIndex > 0 ? 'visible' : 'hidden';
  const isLast = state.lightboxIndex >= (state.browser?.items.length ?? 0) - 1 && state.browser?.nextPage === null;
  el('lbNext').style.visibility = isLast ? 'hidden' : 'visible';
}

async function stepLightbox(delta) {
  const browser = state.browser;
  if (!browser) return;
  const next = state.lightboxIndex + delta;
  if (next < 0) return;
  if (next >= browser.items.length) {
    if (browser.nextPage === null) return;
    await loadGridPage();
    if (next >= browser.items.length) return;
  }
  state.lightboxIndex = next;
  renderLightbox();
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function tile(num, label, slice = null) {
  const node = document.createElement('div');
  node.className = 'p-panel tile';
  const numNode = document.createElement('div');
  numNode.className = 'num';
  numNode.textContent = num;
  const lblNode = document.createElement('div');
  lblNode.className = 'lbl';
  lblNode.textContent = label;
  node.append(numNode, lblNode);
  if (slice) {
    node.classList.add('clickable');
    node.title = 'View these photos';
    node.addEventListener('click', () => openSlice(slice));
  }
  return node;
}

function rowLine({ name, count, max, slice = null, avatars = null, personLink = null, linkNode = null, onClick = null, avatarClick = null }) {
  const line = document.createElement('div');
  line.className = 'row-line';
  const fill = document.createElement('div');
  fill.className = 'fill';
  fill.style.width = `${max > 0 ? Math.max(2, Math.round((count / max) * 100)) : 0}%`;
  const txt = document.createElement('div');
  txt.className = 'txt';
  const nameSide = document.createElement('span');
  nameSide.className = 'name-side';
  const makeFace = (personId, small) => {
    const img = document.createElement('img');
    img.className = small ? 'face small' : 'face';
    img.loading = 'lazy';
    img.src = faceUrl(personId);
    img.alt = '';
    if (avatarClick) {
      img.classList.add('linkable');
      img.title = 'Open person card';
      img.addEventListener('click', (event) => {
        event.stopPropagation();
        avatarClick(personId);
      });
    }
    return img;
  };
  if (avatars && avatars.length === 1) {
    nameSide.append(makeFace(avatars[0], false));
  } else if (avatars && avatars.length > 1) {
    const pair = document.createElement('span');
    pair.className = 'facepair';
    for (const personId of avatars) {
      pair.append(makeFace(personId, true));
    }
    nameSide.append(pair);
  }
  if (linkNode) {
    nameSide.append(linkNode);
  } else {
    const nameNode = document.createElement('span');
    nameNode.textContent = name;
    nameSide.append(nameNode);
  }
  if (personLink && state.immichUrl) {
    const anchor = document.createElement('a');
    anchor.className = 'ext-link';
    anchor.href = `${state.immichUrl}/people/${encodeURIComponent(personLink)}`;
    anchor.target = '_blank';
    anchor.rel = 'noopener';
    anchor.title = 'Open in Immich';
    anchor.textContent = '↗';
    anchor.addEventListener('click', (event) => event.stopPropagation());
    nameSide.append(anchor);
  }
  const countNode = document.createElement('span');
  countNode.className = 'n';
  countNode.textContent = fmt(count);
  txt.append(nameSide, countNode);
  line.append(fill, txt);
  if (onClick) {
    line.title = 'See details';
    line.addEventListener('click', onClick);
  } else if (slice) {
    line.title = 'View these photos';
    line.addEventListener('click', () => openSlice(slice));
  }
  return line;
}

function fillRows(id, rows) {
  const box = el(id);
  box.replaceChildren();
  const max = rows.length ? rows[0].count : 0;
  for (const row of rows) {
    box.append(rowLine({ ...row, max }));
  }
  if (rows.length === 0) {
    const none = document.createElement('div');
    none.className = 'freshness';
    none.textContent = 'No data.';
    box.append(none);
  }
}

// --- timeline: where-I-was ribbon with trips ---

async function initTimeline(snapshot) {
  const block = el('timelineBlock');
  if (!snapshot.trips) {
    block.hidden = true;
    return;
  }
  block.hidden = false;
  state.timeline ??= {};
  const tl = state.timeline;
  if (!tl.weeks) {
    try {
      tl.weeks = (await api('/api/insights/timeline')).weeks;
    } catch (error) {
      if (error.unauthorized) { showLogin(); return; }
      block.hidden = true;
      return;
    }
  }
  if (!tl.weeks.length) {
    block.hidden = true;
    return;
  }
  if (!tl.window) {
    const lastDay = tl.weeks[tl.weeks.length - 1].week;
    tl.window = { from: addDays(lastDay, -358), to: addDays(lastDay, 6) };
  }
  drawTimelineOverview();
  await loadTimelineRibbon();
}

// Stable color per place: hash the name to a hue. No home/away assumption —
// wherever you were most just recurs as the most frequent color.
function locColor(label) {
  if (!label) {
    return 'rgba(128, 128, 128, 0.30)';
  }
  let hash = 0;
  for (let i = 0; i < label.length; i += 1) {
    hash = (hash * 31 + label.charCodeAt(i)) >>> 0;
  }
  return `hsl(${hash % 360} 52% 56%)`;
}

// The overview strip shares the histogram's x-axis: one equal-width column
// per snapshot year (matching the flex columns above it, 3px gaps included),
// so the year labels up there serve both charts.
function timelineScale(width) {
  const years = state.snapshot.years.map((entry) => entry.year);
  const gap = 3;
  const colWidth = (width - gap * (years.length - 1)) / years.length;
  const indexByYear = new Map(years.map((year, index) => [year, index]));
  const xForDay = (day) => {
    const year = Number(day.slice(0, 4));
    const index = indexByYear.get(year);
    if (index === undefined) {
      return year < years[0] ? 0 : width;
    }
    const start = Date.parse(`${year}-01-01`);
    const span = Date.parse(`${year + 1}-01-01`) - start;
    return index * (colWidth + gap) + ((Date.parse(day) - start) / span) * colWidth;
  };
  const dayAtX = (x) => {
    const clamped = Math.max(0, Math.min(width - 0.01, x));
    const index = Math.max(0, Math.min(years.length - 1, Math.floor(clamped / (colWidth + gap))));
    const within = Math.max(0, Math.min(1, (clamped - index * (colWidth + gap)) / colWidth));
    const year = years[index];
    const start = Date.parse(`${year}-01-01`);
    const span = Date.parse(`${year + 1}-01-01`) - start;
    return new Date(start + within * span).toISOString().slice(0, 10);
  };
  return { xForDay, dayAtX };
}

function drawTimelineOverview() {
  const tl = state.timeline;
  const canvas = el('tlOverview');
  const dpr = window.devicePixelRatio || 1;
  const width = canvas.clientWidth || canvas.parentElement.clientWidth || 800;
  const height = 44;
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  const styles = getComputedStyle(document.documentElement);
  const accent = styles.getPropertyValue('--p-accent').trim() || '#60AAB0';
  const { xForDay } = timelineScale(width);
  const maxCount = Math.max(1, ...tl.weeks.map((week) => week.count));

  for (const week of tl.weeks) {
    const x = xForDay(week.week);
    const barWidth = Math.max(1, xForDay(addDays(week.week, 7)) - x - 0.4);
    const barHeight = Math.max(2, Math.sqrt(week.count / maxCount) * (height - 6));
    ctx.fillStyle = locColor(week.city);
    ctx.fillRect(x, height - barHeight, barWidth, barHeight);
  }
  // Current window highlight.
  const wx0 = xForDay(tl.window.from);
  const wx1 = xForDay(addDays(tl.window.to, 1));
  ctx.fillStyle = 'rgba(255,255,255,0.09)';
  ctx.fillRect(wx0, 0, Math.max(2, wx1 - wx0), height);
  ctx.strokeStyle = accent;
  ctx.lineWidth = 1;
  ctx.strokeRect(wx0 + 0.5, 0.5, Math.max(2, wx1 - wx0) - 1, height - 1);
  drawTimelineConnector(wx0, wx1, width);
  updateTimelineHead();
}

// Dotted guides from the highlighted window on the strip down to the full
// width of the ribbon — makes "the ribbon is a zoom of that box" visible.
function drawTimelineConnector(wx0, wx1, width) {
  const canvas = el('tlConnect');
  const dpr = window.devicePixelRatio || 1;
  const height = 13;
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  const accent = getComputedStyle(document.documentElement).getPropertyValue('--p-accent').trim() || '#60AAB0';
  ctx.strokeStyle = accent;
  ctx.globalAlpha = 0.55;
  ctx.lineWidth = 1;
  ctx.setLineDash([2, 3]);
  ctx.beginPath();
  ctx.moveTo(wx0 + 0.5, 0);
  ctx.lineTo(0.5, height);
  ctx.moveTo(wx1 - 0.5, 0);
  ctx.lineTo(width - 0.5, height);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;
}

function updateTimelineHead() {
  const tl = state.timeline;
  const head = el('tlHead');
  if (!tl?.window) {
    head.textContent = 'Where you were';
    return;
  }
  const { from, to } = tl.window;
  const year = from.slice(0, 4);
  if (from === `${year}-01-01` && to === `${year}-12-31`) {
    head.textContent = `Where you were in ${year}`;
  } else {
    head.textContent = `Where you were · ${fmtRange(from, to)}`;
  }
}

async function loadTimelineRibbon() {
  const tl = state.timeline;
  const { from, to } = tl.window;
  try {
    const payload = await api(`/api/insights/timeline?from=${from}&to=${to}`);
    tl.days = payload.days;
    tl.places = payload.places ?? null; // absent on servers older than this page
  } catch (error) {
    if (error.unauthorized) { showLogin(); }
    return;
  }
  renderTimelineRibbon();
}

function renderTimelineRibbon() {
  const tl = state.timeline;
  const { from, to } = tl.window;
  const byDay = new Map(tl.days.map((entry) => [entry.day, entry]));
  const total = daysBetween(from, to) + 1;

  // Group consecutive days by place — no home/away assumption; every place
  // gets its own hashed color, so a change of location is a change of color.
  const segments = [];
  for (let i = 0; i < total; i += 1) {
    const day = addDays(from, i);
    const entry = byDay.get(day);
    const kind = !entry ? 'gap' : 'loc';
    const label = entry ? (entry.city || entry.country || 'No location') : null;
    const last = segments[segments.length - 1];
    if (last && last.kind === kind && last.label === label) {
      last.days += 1;
      last.end = day;
      last.count += entry?.count ?? 0;
    } else {
      segments.push({ kind, label, start: day, end: day, days: 1, count: entry?.count ?? 0 });
    }
  }

  const ribbon = el('tlRibbon');
  ribbon.replaceChildren();
  ribbon.style.position = 'relative';
  for (const seg of segments) {
    const node = document.createElement('div');
    node.className = `seg ${seg.kind}`;
    node.style.flexGrow = String(seg.days);
    node.style.flexBasis = '0';
    if (seg.kind === 'loc') {
      node.style.background = seg.label === 'No location' ? 'rgba(128, 128, 128, 0.30)' : locColor(seg.label);
      node.dataset.tip = `${seg.label} — ${fmtRange(seg.start, seg.end)} · ${fmt(seg.count)} photos`;
    } else {
      node.dataset.tip = `No photos — ${fmtRange(seg.start, seg.end)}`;
    }
    if (seg.kind === 'loc' && seg.label !== 'No location'
      && (seg.days / total) * (ribbon.clientWidth || 800) > 54) {
      const label = document.createElement('span');
      label.className = 'seg-label';
      label.textContent = seg.label;
      node.append(label);
    }
    if (seg.count > 0) {
      node.addEventListener('click', () => {
        if (state.timeline.suppressClick) return;
        openSlice({
          title: `${seg.label} · ${fmtRange(seg.start, seg.end)}`,
          count: seg.count,
          filters: { takenAfter: seg.start, takenBefore: seg.end },
        });
      });
    }
    ribbon.append(node);
  }

  // Selection overlay (from a ribbon drag or a trip jump).
  if (tl.selection && tl.selection.from >= from && tl.selection.to <= to) {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:absolute;top:0;bottom:0;pointer-events:none;border:2px solid var(--p-accent);border-radius:6px;background:rgba(255,255,255,0.08);';
    overlay.style.left = `${(daysBetween(from, tl.selection.from) / total) * 100}%`;
    overlay.style.width = `${((daysBetween(tl.selection.from, tl.selection.to) + 1) / total) * 100}%`;
    ribbon.append(overlay);
  }

  const ticks = el('tlTicks');
  ticks.replaceChildren();
  for (let i = 0; i <= 4; i += 1) {
    const tick = document.createElement('span');
    tick.textContent = fmtDay(addDays(from, Math.round((total - 1) * (i / 4))));
    ticks.append(tick);
  }
  renderTimelineRangeBar();
  renderLocationsList();
}

function renderTimelineRangeBar() {
  const tl = state.timeline;
  const bar = el('tlRange');
  if (!tl.selection) {
    bar.hidden = true;
    return;
  }
  const { from, to } = tl.selection;
  const count = tl.days
    .filter((entry) => entry.day >= from && entry.day <= to)
    .reduce((sum, entry) => sum + entry.count, 0);
  tl.selection.count = count;
  el('tlRangeLabel').textContent = `${fmtRange(from, to)} · ${fmt(count)} photos`;
  bar.hidden = false;
}

function setTimelineWindow(from, to) {
  const tl = state.timeline;
  tl.window = { from, to };
  drawTimelineOverview();
  void loadTimelineRibbon();
}

// The list follows the ribbon exactly: every place seen in the current
// window — narrowed further to the drag-selection when one is active —
// with the same color the ribbon uses, ranked by photo count. Clicking
// opens that place's photos within that range.
function renderLocationsList() {
  const tl = state.timeline;
  const box = el('tripsList');
  box.replaceChildren();
  const { from, to } = tl.selection ?? tl.window;
  const locations = new Map();
  if (tl.places) {
    // Per-place truth from the server: each photo counted under its own
    // label (images only), so the number here matches what clicking opens.
    // Days = days the place actually appears, not days it "won". A null
    // label is the server's "no location at all" bucket.
    for (const row of tl.places) {
      if (row.day < from || row.day > to) continue;
      const label = row.label ?? 'No location';
      const isNone = row.label == null;
      const slot = locations.get(label) ?? {
        label,
        isCity: row.isCity,
        isCountry: !isNone && !row.isCity,
        isNone,
        days: 0,
        count: 0,
      };
      slot.days += 1;
      slot.count += row.count;
      locations.set(label, slot);
    }
  } else {
    // Server predates per-place counts: fall back to day-dominant sums.
    for (const entry of tl.days) {
      if (entry.day < from || entry.day > to) continue;
      const label = entry.city || entry.country || 'No location';
      const slot = locations.get(label) ?? {
        label,
        isCity: Boolean(entry.city),
        isCountry: !entry.city && Boolean(entry.country),
        days: 0,
        count: 0,
      };
      slot.days += 1;
      slot.count += entry.count;
      locations.set(label, slot);
    }
  }
  // Every location in the window, no cap and no scroll: a truncated list
  // reads as "that's everywhere I was", which is exactly the wrong lie.
  const ranked = [...locations.values()].sort((a, b) => b.count - a.count);
  for (const loc of ranked) {
    const clickable = loc.isCity || loc.isCountry || loc.isNone;
    const button = document.createElement('button');
    button.type = 'button';
    if (!clickable) button.classList.add('noclick');
    const place = document.createElement('span');
    place.className = 't-place';
    const dot = document.createElement('span');
    dot.className = 't-dot';
    dot.style.background = loc.label === 'No location' ? 'rgba(128, 128, 128, 0.5)' : locColor(loc.label);
    const txt = document.createElement('span');
    txt.className = 'txt';
    txt.textContent = loc.label;
    place.append(dot, txt);
    if (loc.isCity && groupFor(loc.label)) {
      const mark = document.createElement('span');
      mark.className = 'grp-mark';
      mark.textContent = '⁕';
      mark.title = `Includes ${groupFor(loc.label).cities.join(', ')}`;
      place.append(mark);
    }
    const when = document.createElement('span');
    when.className = 't-when';
    when.textContent = `${loc.days}d · ${fmt(loc.count)} photos`;
    button.append(place, when);
    if (clickable) {
      // With per-place counts the list number matches the search this slice
      // runs, so pass it along; the modal still corrects from the resolver
      // if the sweep has drifted. Old servers only have day-dominant sums,
      // which routinely disagree — pass null and let the modal fill it in.
      // Country rows count only city-less photos, so the slice pins
      // city: null (else Immich would return every photo in the country);
      // the "No location" row is city: null + country: null.
      const where = loc.isCity
        ? placeFilters(loc.label)
        : loc.isCountry
          ? { country: loc.label, city: null }
          : { city: null, country: null };
      button.addEventListener('click', () => openSlice({
        title: `${loc.label} · ${fmtRange(from, to)}`,
        count: tl.places ? loc.count : null,
        filters: {
          takenAfter: from,
          takenBefore: to,
          type: 'IMAGE',
          ...where,
        },
      }));
    }
    box.append(button);
  }
  if (ranked.length === 0) {
    const none = document.createElement('div');
    none.className = 'none';
    none.textContent = tl.selection ? 'No photos in this selection.' : 'No photos in this window.';
    box.append(none);
  }
}

// Overview brush + ribbon drag-select.
function wireTimelineInteractions() {
  const canvas = el('tlOverview');
  let brush = null;
  const dayAtOverviewX = (clientX) => {
    const rect = canvas.getBoundingClientRect();
    return timelineScale(rect.width).dayAtX(clientX - rect.left);
  };
  canvas.addEventListener('mousedown', (event) => {
    if (!state.timeline?.weeks) return;
    brush = { start: dayAtOverviewX(event.clientX) };
  });
  window.addEventListener('mousemove', (event) => {
    if (!brush) return;
    brush.end = dayAtOverviewX(event.clientX);
  });
  window.addEventListener('mouseup', (event) => {
    if (!brush) return;
    const start = brush.start;
    const end = dayAtOverviewX(event.clientX);
    brush = null;
    let [from, to] = start <= end ? [start, end] : [end, start];
    if (daysBetween(from, to) < 14) {
      // Treat a click/short brush as "zoom to this calendar year" — the same
      // scope a histogram-bar click gives.
      const year = from.slice(0, 4);
      from = `${year}-01-01`;
      to = `${year}-12-31`;
    }
    state.timeline.selection = null;
    setTimelineWindow(from, to);
  });

  const ribbon = el('tlRibbon');
  let drag = null;
  const dayAtRibbonX = (clientX) => {
    const tl = state.timeline;
    const rect = ribbon.getBoundingClientRect();
    const total = daysBetween(tl.window.from, tl.window.to) + 1;
    const fraction = Math.max(0, Math.min(0.9999, (clientX - rect.left) / rect.width));
    return addDays(tl.window.from, Math.floor(fraction * total));
  };
  ribbon.addEventListener('mousedown', (event) => {
    if (!state.timeline?.days) return;
    drag = { startX: event.clientX, startDay: dayAtRibbonX(event.clientX), moved: false };
  });
  window.addEventListener('mousemove', (event) => {
    if (!drag) return;
    if (Math.abs(event.clientX - drag.startX) > 5) {
      drag.moved = true;
      const tl = state.timeline;
      const a = drag.startDay;
      const b = dayAtRibbonX(event.clientX);
      tl.selection = a <= b ? { from: a, to: b } : { from: b, to: a };
      renderTimelineRibbon();
    }
  });
  window.addEventListener('mouseup', () => {
    if (!drag) return;
    const moved = drag.moved;
    drag = null;
    if (moved) {
      // Swallow the click that follows a drag so segments don't open.
      state.timeline.suppressClick = true;
      setTimeout(() => { state.timeline.suppressClick = false; }, 0);
    }
  });

  // Follow-cursor place tip, like the constellation's.
  ribbon.addEventListener('mousemove', (event) => {
    const seg = event.target.closest('.seg');
    const tip = el('tlTip');
    if (!seg?.dataset.tip || drag?.moved) {
      tip.hidden = true;
      return;
    }
    tip.textContent = seg.dataset.tip;
    tip.hidden = false;
    tip.style.left = `${event.clientX + 14}px`;
    tip.style.top = `${event.clientY + 16}px`;
  });
  ribbon.addEventListener('mouseleave', () => {
    el('tlTip').hidden = true;
  });

  el('tlRangeView').addEventListener('click', () => {
    const selection = state.timeline?.selection;
    if (!selection) return;
    openSlice({
      title: fmtRange(selection.from, selection.to),
      count: selection.count ?? null,
      filters: { takenAfter: selection.from, takenBefore: selection.to },
    });
  });
  el('tlRangeClear').addEventListener('click', () => {
    state.timeline.selection = null;
    renderTimelineRibbon();
  });
}

// --- constellation: force-directed people graph on canvas ---

function renderConstellation(graph) {
  const section = el('constellationSection');
  if (!graph || graph.nodes.length < 2) {
    section.hidden = true;
    state.constellation = null;
    return;
  }
  section.hidden = false;
  const canvas = el('constellation');
  const dpr = window.devicePixelRatio || 1;
  const width = canvas.clientWidth || canvas.parentElement.clientWidth || 900;
  const height = 440;
  canvas.width = width * dpr;
  canvas.height = height * dpr;

  const maxCount = Math.max(...graph.nodes.map((node) => node.count));
  const nodes = graph.nodes.map((node, index) => {
    // Deterministic starting ring so layouts are stable between renders.
    const angle = (index / graph.nodes.length) * Math.PI * 2;
    return {
      ...node,
      // Exponent 0.7 keeps small faces visible while letting the most
      // photographed people clearly dominate.
      radius: 8 + Math.round(24 * Math.pow(node.count / maxCount, 0.7)),
      x: width / 2 + Math.cos(angle) * width * 0.3,
      y: height / 2 + Math.sin(angle) * height * 0.32,
      vx: 0,
      vy: 0,
      pinned: false,
    };
  });
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const maxEdge = Math.max(1, ...graph.edges.map((edge) => edge.count));
  const edges = graph.edges
    .map((edge) => ({ ...edge, source: byId.get(edge.a), target: byId.get(edge.b) }))
    .filter((edge) => edge.source && edge.target);

  const faces = new Map();
  for (const node of nodes) {
    const img = new Image();
    img.src = faceUrl(node.id);
    img.onload = () => { if (state.constellation?.canvas === canvas) draw(); };
    faces.set(node.id, img);
  }

  const sim = { nodes, edges, faces, canvas, width, height, dpr, alpha: 1, dragging: null, hover: null, ego: state.personCard ? sim0Ego() : null };
  sim.draw = () => draw();
  state.constellation = sim;

  function sim0Ego() {
    // A re-render (e.g. after a sweep) while a card is open keeps the spotlight.
    const stack = state.personCard?.stack ?? [];
    return stack[stack.length - 1]?.id ?? null;
  }

  function tick() {
    // Repulsion between every pair, springs along edges, mild centering.
    for (const node of nodes) {
      node.fx = (width / 2 - node.x) * 0.003;
      node.fy = (height / 2 - node.y) * 0.003;
    }
    for (let i = 0; i < nodes.length; i += 1) {
      for (let j = i + 1; j < nodes.length; j += 1) {
        const a = nodes[i];
        const b = nodes[j];
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 1) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; d2 = 1; }
        const force = 1600 / d2;
        const d = Math.sqrt(d2);
        a.fx -= (dx / d) * force;
        a.fy -= (dy / d) * force;
        b.fx += (dx / d) * force;
        b.fy += (dy / d) * force;
      }
    }
    for (const edge of edges) {
      const strength = 0.002 + 0.02 * (Math.log(edge.count + 1) / Math.log(maxEdge + 1));
      const dx = edge.target.x - edge.source.x;
      const dy = edge.target.y - edge.source.y;
      edge.source.fx += dx * strength;
      edge.source.fy += dy * strength;
      edge.target.fx -= dx * strength;
      edge.target.fy -= dy * strength;
    }
    for (const node of nodes) {
      // Pinned nodes stay where the user dropped them but still push and
      // pull everyone else.
      if (node === sim.dragging || node.pinned) continue;
      node.vx = (node.vx + node.fx * sim.alpha) * 0.86;
      node.vy = (node.vy + node.fy * sim.alpha) * 0.86;
      node.x = Math.max(node.radius, Math.min(width - node.radius, node.x + node.vx));
      node.y = Math.max(node.radius, Math.min(height - node.radius, node.y + node.vy));
    }
    sim.alpha = Math.max(0, sim.alpha - 0.004);
  }

  function draw() {
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    const styles = getComputedStyle(document.documentElement);
    const accent = styles.getPropertyValue('--p-accent').trim() || '#60AAB0';
    const muted = styles.getPropertyValue('--p-muted').trim() || '#888';

    // While a person card is open, spotlight that person: their edges and
    // neighbors keep their weight, everyone else fades back.
    const ego = sim.ego ? byId.get(sim.ego) : null;
    const egoIds = ego ? new Set([ego.id]) : null;
    if (ego) {
      for (const edge of edges) {
        if (edge.source === ego) egoIds.add(edge.target.id);
        if (edge.target === ego) egoIds.add(edge.source.id);
      }
    }

    for (const edge of edges) {
      const emphasis = edge === sim.hover?.edge;
      const onEgo = ego && (edge.source === ego || edge.target === ego);
      ctx.strokeStyle = accent;
      ctx.globalAlpha = emphasis ? 0.85
        : ego ? (onEgo ? 0.3 + 0.5 * (edge.count / maxEdge) : 0.03)
          : 0.1 + 0.3 * (edge.count / maxEdge);
      ctx.lineWidth = 1 + 3 * (edge.count / maxEdge);
      ctx.beginPath();
      ctx.moveTo(edge.source.x, edge.source.y);
      ctx.lineTo(edge.target.x, edge.target.y);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    for (const node of nodes) {
      const hovered = node === sim.hover?.node;
      const img = faces.get(node.id);
      ctx.globalAlpha = !egoIds || egoIds.has(node.id) ? 1 : 0.22;
      ctx.save();
      ctx.beginPath();
      ctx.arc(node.x, node.y, node.radius, 0, Math.PI * 2);
      ctx.closePath();
      ctx.clip();
      if (img?.complete && img.naturalWidth > 0) {
        ctx.drawImage(img, node.x - node.radius, node.y - node.radius, node.radius * 2, node.radius * 2);
      } else {
        ctx.fillStyle = muted;
        ctx.fillRect(node.x - node.radius, node.y - node.radius, node.radius * 2, node.radius * 2);
        ctx.fillStyle = '#fff';
        ctx.font = `${node.radius}px sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText((node.name || '?')[0], node.x, node.y);
      }
      ctx.restore();
      ctx.beginPath();
      ctx.arc(node.x, node.y, node.radius, 0, Math.PI * 2);
      ctx.strokeStyle = hovered || node === ego ? accent : 'rgba(128,128,128,0.4)';
      ctx.lineWidth = hovered || node === ego ? 2.5 : 1;
      ctx.stroke();
      ctx.globalAlpha = 1;
      if (node.pinned) {
        ctx.beginPath();
        ctx.arc(node.x, node.y, node.radius + 3.5, 0, Math.PI * 2);
        ctx.strokeStyle = accent;
        ctx.globalAlpha = 0.6;
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 4]);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;
      }
    }
  }

  function frame() {
    if (state.constellation !== sim) return; // superseded by a re-render
    if (sim.alpha > 0 || sim.dragging) {
      tick();
      draw();
    }
    requestAnimationFrame(frame);
  }
  frame();

  // --- interactions ---
  const pos = (event) => {
    const rect = canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };
  const hitNode = (point) => nodes.find((node) => (node.x - point.x) ** 2 + (node.y - point.y) ** 2 <= (node.radius + 2) ** 2);
  const hitEdge = (point) => {
    let best = null;
    for (const edge of edges) {
      const { source: a, target: b } = edge;
      const lengthSq = (b.x - a.x) ** 2 + (b.y - a.y) ** 2;
      if (lengthSq === 0) continue;
      let t = ((point.x - a.x) * (b.x - a.x) + (point.y - a.y) * (b.y - a.y)) / lengthSq;
      t = Math.max(0, Math.min(1, t));
      const dist = Math.hypot(point.x - (a.x + t * (b.x - a.x)), point.y - (a.y + t * (b.y - a.y)));
      if (dist < 5 && (!best || dist < best.dist)) best = { edge, dist };
    }
    return best?.edge ?? null;
  };

  canvas.onmousemove = (event) => {
    const point = pos(event);
    if (sim.dragging) {
      sim.dragging.x = point.x;
      sim.dragging.y = point.y;
      sim.alpha = Math.max(sim.alpha, 0.25);
      return;
    }
    const node = hitNode(point);
    const edge = node ? null : hitEdge(point);
    sim.hover = node || edge ? { node, edge } : null;
    canvas.style.cursor = sim.hover ? 'pointer' : 'default';
    const tip = el('constellationTip');
    if (node) {
      tip.textContent = `${node.name} · ${fmt(node.count)} photos`;
    } else if (edge) {
      const a = byId.get(edge.a);
      const b = byId.get(edge.b);
      tip.textContent = `${a.name} + ${b.name} · ${fmt(edge.count)} together`;
    }
    tip.hidden = !sim.hover;
    if (sim.hover) {
      tip.style.left = `${event.clientX + 14}px`;
      tip.style.top = `${event.clientY + 14}px`;
    }
    draw();
  };
  canvas.onmouseleave = () => {
    sim.hover = null;
    el('constellationTip').hidden = true;
    draw();
  };
  canvas.onmousedown = (event) => {
    const node = hitNode(pos(event));
    if (node) {
      sim.dragging = node;
      sim.dragStart = pos(event);
    }
  };
  canvas.onmouseup = (event) => {
    const point = pos(event);
    const wasDrag = sim.dragging && sim.dragStart
      && Math.hypot(point.x - sim.dragStart.x, point.y - sim.dragStart.y) > 4;
    const dragged = sim.dragging;
    sim.dragging = null;
    if (wasDrag) {
      // A real drag pins the face where it was dropped; double-click releases.
      dragged.pinned = true;
      dragged.vx = 0;
      dragged.vy = 0;
      draw();
      return;
    }
    const node = dragged || hitNode(point);
    if (node) {
      void openPersonCard(node.id);
      return;
    }
    const edge = hitEdge(point);
    if (edge) {
      openSlice(pairSliceFor(byId.get(edge.a), byId.get(edge.b), edge.count));
    }
  };
  canvas.ondblclick = (event) => {
    const node = hitNode(pos(event));
    if (node?.pinned) {
      node.pinned = false;
      sim.alpha = Math.max(sim.alpha, 0.3);
    }
  };
}

// --- person card: one person's hub — photos, span, places, connections ---

function personNameFromSnapshot(personId) {
  const fromGraph = (state.snapshot?.graph?.nodes ?? []).find((node) => node.id === personId);
  return fromGraph?.name
    ?? (state.snapshot?.people ?? []).find((person) => person.id === personId)?.name
    ?? '';
}

// Clicking any face opens this card; clicking a connection's face chains to
// their card (push: true) with the back button walking the trail home.
async function openPersonCard(personId, { push = false } = {}) {
  if (!push || !state.personCard) {
    state.personCard = { stack: [], seq: 0, loading: false };
  }
  const card = state.personCard;
  const top = card.stack[card.stack.length - 1];
  if (!card.loading && top?.id === personId) {
    renderPersonCard(top);
    return;
  }
  card.seq += 1;
  const seq = card.seq;
  showPersonCardShell(personId);
  try {
    const detail = await api(`/api/insights/person/${encodeURIComponent(personId)}`);
    if (state.personCard !== card || card.seq !== seq) return; // superseded or closed
    card.stack.push(detail);
    renderPersonCard(detail);
  } catch (error) {
    if (error.unauthorized) { showLogin(); return; }
    if (state.personCard === card && card.seq === seq) closePersonCard();
    // A server that predates the person endpoint (static files go live
    // before a restart) or a transient failure: fall back to the person's
    // photos rather than a dead end.
    const name = personNameFromSnapshot(personId);
    if (name) {
      openSlice(personSliceFor({ id: personId, name }));
    } else {
      toast(`Could not load person: ${error.message}`);
    }
  }
}

function showPersonCardShell(personId) {
  const card = state.personCard;
  card.loading = true;
  el('pcFace').src = faceUrl(personId);
  el('pcName').textContent = personNameFromSnapshot(personId) || '…';
  el('pcMeta').textContent = 'Loading…';
  el('pcBack').hidden = card.stack.length < 1;
  el('pcView').disabled = true;
  el('pcAlbum').hidden = true;
  el('pcImmich').hidden = true;
  el('pcYearsWrap').hidden = true;
  el('pcConnections').replaceChildren();
  el('pcPlaces').replaceChildren();
  el('personCard').hidden = false;
  document.body.style.overflow = 'hidden';
  setConstellationEgo(personId);
}

function renderPersonCard(detail) {
  const card = state.personCard;
  if (!card) return;
  card.loading = false;
  el('pcBack').hidden = card.stack.length < 2;
  el('pcFace').src = faceUrl(detail.id);
  el('pcName').textContent = detail.name;
  const span = detail.firstDay && detail.lastDay
    ? (detail.firstDay === detail.lastDay ? fmtDay(detail.firstDay) : `${fmtDay(detail.firstDay)} – ${fmtDay(detail.lastDay)}`)
    : '';
  el('pcMeta').textContent = `${fmt(detail.count)} photos${span ? ` · ${span}` : ''}`;

  const slice = personSliceFor(detail);
  const view = el('pcView');
  view.disabled = false;
  view.onclick = () => openSlice(slice);
  const albumHref = albumHrefForSlice(slice);
  el('pcAlbum').hidden = !albumHref;
  if (albumHref) el('pcAlbum').href = albumHref;
  el('pcImmich').hidden = !state.immichUrl;
  if (state.immichUrl) el('pcImmich').href = `${state.immichUrl}/people/${encodeURIComponent(detail.id)}`;

  renderPersonCardYears(detail);

  // Connections: the name side chains to that person's card; the count bar
  // opens the photos the two share.
  const conn = el('pcConnections');
  conn.replaceChildren();
  const maxConn = Math.max(1, ...detail.connections.map((other) => other.count));
  for (const other of detail.connections) {
    const row = document.createElement('div');
    row.className = 'pc-row';
    const who = document.createElement('button');
    who.type = 'button';
    who.className = 'pc-who';
    who.title = `See ${other.name}'s details`;
    const img = document.createElement('img');
    img.className = 'face small';
    img.loading = 'lazy';
    img.src = faceUrl(other.id);
    img.alt = '';
    const nm = document.createElement('span');
    nm.className = 'nm';
    nm.textContent = other.name;
    who.append(img, nm);
    who.addEventListener('click', () => void openPersonCard(other.id, { push: true }));
    const shared = document.createElement('button');
    shared.type = 'button';
    shared.className = 'pc-shared';
    shared.title = `View photos of ${detail.name} + ${other.name}`;
    const fill = document.createElement('span');
    fill.className = 'fill';
    fill.style.width = `${Math.max(5, Math.round((other.count / maxConn) * 100))}%`;
    const n = document.createElement('span');
    n.className = 'n';
    n.textContent = fmt(other.count);
    shared.append(fill, n);
    shared.addEventListener('click', () => openSlice(pairSliceFor(detail, other, other.count)));
    row.append(who, shared);
    conn.append(row);
  }
  if (detail.connections.length === 0) {
    const none = document.createElement('div');
    none.className = 'pc-none';
    none.textContent = 'No shared photos with other named people.';
    conn.append(none);
  }

  const places = el('pcPlaces');
  places.replaceChildren();
  const maxPlace = Math.max(1, ...detail.places.map((place) => place.count));
  for (const place of detail.places) {
    places.append(rowLine({
      name: place.name,
      count: place.count,
      max: maxPlace,
      linkNode: placeNameNode(place.name, place),
      slice: {
        title: `${detail.name} · ${place.name}`,
        count: place.count,
        filters: { personIds: [detail.id], ...placeFilters(place.name, place) },
        people: slice.people,
      },
    }));
  }
  if (detail.places.length === 0) {
    const none = document.createElement('div');
    none.className = 'pc-none';
    none.textContent = 'No location data.';
    places.append(none);
  }

  el('personCard').hidden = false;
  document.body.style.overflow = 'hidden';
  setConstellationEgo(detail.id);
}

// Mini histogram on a card, over the same year domain as the big chart so
// the shape reads as "when this appears in the collection".
function renderMiniYears({ wrapId, boxId, years, sliceForYear }) {
  const wrap = el(wrapId);
  const box = el(boxId);
  box.replaceChildren();
  const domain = state.snapshot?.years ?? [];
  if (domain.length === 0 || years.length === 0) {
    wrap.hidden = true;
    return;
  }
  const byYear = new Map(years.map((entry) => [entry.year, entry.count]));
  const maxYear = Math.max(1, ...years.map((entry) => entry.count));
  for (const { year } of domain) {
    const count = byYear.get(year) ?? 0;
    // Full-height column so even the tiniest bar is an easy hover target.
    const col = document.createElement('div');
    col.className = count > 0 ? 'yb' : 'yb zero';
    const tip = document.createElement('span');
    tip.className = 'tip';
    tip.textContent = `${year}: ${fmt(count)}`;
    const bar = document.createElement('div');
    bar.className = 'b';
    bar.style.height = count > 0 ? `${Math.max(5, Math.round((count / maxYear) * 100))}%` : '2px';
    col.append(tip, bar);
    if (count > 0) {
      col.addEventListener('click', () => openSlice(sliceForYear(year, count)));
    }
    box.append(col);
  }
  wrap.hidden = false;
}

function renderPersonCardYears(detail) {
  renderMiniYears({
    wrapId: 'pcYearsWrap',
    boxId: 'pcYears',
    years: detail.years,
    sliceForYear: (year, count) => ({
      title: `${detail.name} · ${year}`,
      count,
      filters: { personIds: [detail.id], ...yearRange(year) },
      people: [{ id: detail.id, name: detail.name }],
    }),
  });
}

function personCardBack() {
  const card = state.personCard;
  if (!card) return;
  card.seq += 1; // drop any in-flight load
  if (card.loading) {
    const top = card.stack[card.stack.length - 1];
    if (top) {
      renderPersonCard(top);
    } else {
      closePersonCard();
    }
    return;
  }
  if (card.stack.length < 2) return;
  card.stack.pop();
  renderPersonCard(card.stack[card.stack.length - 1]);
}

function setConstellationEgo(personId) {
  const sim = state.constellation;
  if (!sim) return;
  sim.ego = personId;
  sim.draw?.();
}

function closePersonCard() {
  el('personCard').hidden = true;
  state.personCard = null;
  document.body.style.overflow = state.browser || state.placeCard ? 'hidden' : '';
  setConstellationEgo(null);
}

// --- location card: one place's hub — photos, span, people, members ---

async function openPlaceCard(label) {
  const card = { seq: (state.placeCard?.seq ?? 0) + 1 };
  state.placeCard = card;
  el('plcDot').style.background = locColor(label);
  el('plcName').textContent = label;
  el('plcMeta').textContent = 'Loading…';
  el('plcView').disabled = true;
  el('plcAlbum').hidden = true;
  el('plcImmich').hidden = true;
  el('plcYearsWrap').hidden = true;
  el('plcPeople').replaceChildren();
  el('plcMembersWrap').hidden = true;
  el('plcBusiest').hidden = true;
  el('placeCard').hidden = false;
  document.body.style.overflow = 'hidden';
  try {
    const detail = await api(`/api/insights/place?name=${encodeURIComponent(label)}`);
    if (state.placeCard !== card) return;
    renderPlaceCard(detail);
  } catch (error) {
    if (error.unauthorized) { showLogin(); return; }
    if (state.placeCard === card) closePlaceCard();
    // Server without the place endpoint yet (static files go live before a
    // restart): fall back to the photos rather than a dead end.
    openSlice({ title: label, count: null, filters: placeFilters(label) });
  }
}

function renderPlaceCard(detail) {
  el('plcName').replaceChildren();
  el('plcName').append(placeNameNode(detail.name, { isGroup: detail.isGroup, members: detail.cities }) ?? detail.name);
  const span = detail.firstDay && detail.lastDay
    ? (detail.firstDay === detail.lastDay ? fmtDay(detail.firstDay) : `${fmtDay(detail.firstDay)} – ${fmtDay(detail.lastDay)}`)
    : '';
  el('plcMeta').textContent = [
    `${fmt(detail.count)} photos`,
    span,
    !detail.isGroup && detail.country ? detail.country : '',
  ].filter(Boolean).join(' · ');

  const filters = detail.isGroup ? { cities: detail.cities } : { city: detail.name };
  const slice = { title: detail.name, count: detail.count, filters };
  const view = el('plcView');
  view.disabled = false;
  view.onclick = () => openSlice(slice);
  const albumHref = albumHrefForSlice(slice);
  el('plcAlbum').hidden = !albumHref;
  if (albumHref) el('plcAlbum').href = albumHref;
  const immichLink = immichLinkForSlice(filters);
  el('plcImmich').hidden = !immichLink;
  if (immichLink) el('plcImmich').href = immichLink;

  renderMiniYears({
    wrapId: 'plcYearsWrap',
    boxId: 'plcYears',
    years: detail.years,
    sliceForYear: (year, count) => ({
      title: `${detail.name} · ${year}`,
      count,
      filters: { ...filters, ...yearRange(year) },
    }),
  });

  // People here: the name side opens their person card (on top); the count
  // bar opens the photos of that person at this place.
  const box = el('plcPeople');
  box.replaceChildren();
  const maxPerson = Math.max(1, ...detail.people.map((person) => person.count));
  for (const person of detail.people) {
    const row = document.createElement('div');
    row.className = 'pc-row';
    const who = document.createElement('button');
    who.type = 'button';
    who.className = 'pc-who';
    who.title = `See ${person.name}'s details`;
    const img = document.createElement('img');
    img.className = 'face small';
    img.loading = 'lazy';
    img.src = faceUrl(person.id);
    img.alt = '';
    const nm = document.createElement('span');
    nm.className = 'nm';
    nm.textContent = person.name;
    who.append(img, nm);
    who.addEventListener('click', () => void openPersonCard(person.id));
    const shared = document.createElement('button');
    shared.type = 'button';
    shared.className = 'pc-shared';
    shared.title = `View photos of ${person.name} in ${detail.name}`;
    const fill = document.createElement('span');
    fill.className = 'fill';
    fill.style.width = `${Math.max(5, Math.round((person.count / maxPerson) * 100))}%`;
    const n = document.createElement('span');
    n.className = 'n';
    n.textContent = fmt(person.count);
    shared.append(fill, n);
    shared.addEventListener('click', () => openSlice({
      title: `${person.name} · ${detail.name}`,
      count: person.count,
      filters: { personIds: [person.id], ...filters },
      people: [{ id: person.id, name: person.name }],
    }));
    row.append(who, shared);
    box.append(row);
  }
  if (detail.people.length === 0) {
    const none = document.createElement('div');
    none.className = 'pc-none';
    none.textContent = 'No named people counted here.';
    box.append(none);
  }

  // Member cities (groups only), each opening its own photos.
  const membersWrap = el('plcMembersWrap');
  const members = el('plcMembers');
  members.replaceChildren();
  if (detail.isGroup && detail.members?.length) {
    const maxMember = Math.max(1, ...detail.members.map((member) => member.count));
    for (const member of detail.members) {
      members.append(rowLine({
        name: member.name,
        count: member.count,
        max: maxMember,
        slice: { title: member.name, count: member.count, filters: { city: member.name } },
      }));
    }
    membersWrap.hidden = false;
  } else {
    membersWrap.hidden = true;
  }

  const busiest = el('plcBusiest');
  if (detail.busiestDay) {
    busiest.replaceChildren('Busiest day here: ');
    const link = document.createElement('a');
    link.textContent = `${fmtDay(detail.busiestDay.day)} (${fmt(detail.busiestDay.count)} photos)`;
    link.addEventListener('click', () => openSlice({
      title: `${detail.name} · ${fmtDay(detail.busiestDay.day)}`,
      count: null,
      filters: { ...filters, day: detail.busiestDay.day },
    }));
    busiest.append(link);
    busiest.hidden = false;
  } else {
    busiest.hidden = true;
  }
}

function closePlaceCard() {
  el('placeCard').hidden = true;
  state.placeCard = null;
  document.body.style.overflow = state.browser || state.personCard ? 'hidden' : '';
}

// --- favorites tile + tag-definition popover ---

function favoritesTile(totals) {
  const fav = state.favoritesTag;
  let node;
  if (fav) {
    const shortValue = fav.value ? fav.value.replace(/^ai\//, '') : 'tag';
    node = tile(fav.count === null ? '…' : fmt(fav.count), 'Favorites', {
      title: shortValue,
      count: fav.count,
      filters: { tagIds: [fav.id] },
      tags: [{ id: fav.id, name: fav.value, value: fav.value }],
    });
    node.title = `Photos tagged ${fav.value || 'your favorites tag'}`;
  } else {
    node = tile(fmt(totals.favorites), 'Favorites', {
      title: 'Favorites',
      count: totals.favorites,
      filters: { isFavorite: true },
    });
  }
  const gear = document.createElement('button');
  gear.className = 'gear';
  gear.textContent = '⚙';
  gear.title = 'Change what counts as a favorite';
  gear.setAttribute('aria-label', 'Favorites settings');
  gear.addEventListener('click', (event) => {
    event.stopPropagation();
    toggleFavPopover(gear);
  });
  node.append(gear);
  return node;
}

function toggleFavPopover(anchor) {
  const popover = el('favPopover');
  if (!popover.hidden) {
    popover.hidden = true;
    return;
  }
  const rect = anchor.getBoundingClientRect();
  popover.style.top = `${Math.round(rect.bottom + 8)}px`;
  popover.style.left = `${Math.round(Math.min(rect.left, window.innerWidth - 290))}px`;
  el('favCurrent').textContent = state.favoritesTag ? `Now: ${state.favoritesTag.value}` : 'Now: Immich favorites';
  el('favTagSearch').value = '';
  popover.hidden = false;
  renderFavTagResults('');
  el('favTagSearch').focus();
  void ensureTagsLoaded();
}

async function ensureTagsLoaded() {
  if (state.allTags) return;
  try {
    const response = await api('/api/albums/tags');
    state.allTags = (response.tags || []).filter((tag) => tag.id);
    renderFavTagResults(el('favTagSearch').value);
  } catch (error) {
    if (error.unauthorized) { showLogin(); return; }
    toast('Could not load tags from Immich.');
  }
}

function renderFavTagResults(query) {
  const box = el('favTagResults');
  box.replaceChildren();
  if (!state.allTags) {
    const none = document.createElement('div');
    none.className = 'none';
    none.textContent = 'Loading tags…';
    box.append(none);
    return;
  }
  const needle = query.trim().toLowerCase();
  const matches = state.allTags
    .filter((tag) => !needle || (tag.value || tag.name || '').toLowerCase().includes(needle))
    .slice(0, 8);
  for (const tag of matches) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = tag.value || tag.name;
    button.addEventListener('click', () => void setFavoritesTag(tag));
    box.append(button);
  }
  if (matches.length === 0) {
    const none = document.createElement('div');
    none.className = 'none';
    none.textContent = 'No matching tags.';
    box.append(none);
  }
}

async function setFavoritesTag(tag) {
  try {
    const response = await api('/api/insights/favorites-tag', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: tag.id, value: tag.value || tag.name }),
    });
    state.favoritesTag = response.favoritesTag;
    el('favPopover').hidden = true;
    toast(`Favorites now counts photos tagged ${state.favoritesTag.value}.`);
    if (state.snapshot) render(state.snapshot);
  } catch (error) {
    if (error.unauthorized) { showLogin(); return; }
    toast(`Could not set favorites tag: ${error.message}`);
  }
}

async function clearFavoritesTag() {
  try {
    const response = await api('/api/insights/favorites-tag', { method: 'DELETE' });
    state.favoritesTag = response.favoritesTag;
    el('favPopover').hidden = true;
    toast('Favorites now uses Immich favorites.');
    if (state.snapshot) render(state.snapshot);
  } catch (error) {
    if (error.unauthorized) { showLogin(); return; }
    toast(`Could not reset favorites: ${error.message}`);
  }
}

// Records render as hero tiles (value big, label under it, detail line last)
// so the top of the page is one uniform stat grid.
function record({ label, value, detail, slice = null, mapAt = null, info = null, detailInfo = null, valueTitle = null, detailTitle = null }) {
  const node = document.createElement('div');
  node.className = 'p-panel tile record';
  const k = document.createElement('div');
  k.className = 'k';
  k.textContent = label;
  if (info) {
    const icon = document.createElement('i');
    icon.className = 'info';
    icon.dataset.tip = info;
    icon.textContent = 'i';
    k.append(' ', icon);
  }
  const v = document.createElement('div');
  v.className = 'v';
  v.textContent = value;
  if (valueTitle && valueTitle !== value) v.title = valueTitle;
  const d = document.createElement('div');
  d.className = 'd';
  d.textContent = detail || '';
  if (detailTitle && detailTitle !== detail) d.title = detailTitle;
  if (detailInfo) {
    const icon = document.createElement('i');
    icon.className = 'info';
    icon.dataset.tip = detailInfo;
    icon.textContent = 'i';
    d.append(' ', icon);
  }
  if (mapAt && state.immichUrl) {
    // Immich's map page keeps its position in a maplibre-style URL hash.
    // The link lives in the label row so the detail line stays one line.
    const anchor = document.createElement('a');
    anchor.className = 'ext-link';
    anchor.href = `${state.immichUrl}/map#13/${mapAt.lat.toFixed(4)}/${mapAt.lon.toFixed(4)}`;
    anchor.target = '_blank';
    anchor.rel = 'noopener';
    anchor.textContent = 'map ↗';
    anchor.title = 'Open on the Immich map';
    anchor.addEventListener('click', (event) => event.stopPropagation());
    k.append(anchor);
  }
  node.append(v, k, d);
  if (slice) {
    node.classList.add('clickable');
    node.title = 'View these photos';
    node.addEventListener('click', () => openSlice(slice));
  }
  return node;
}

// Appends into the hero grid, which render() has just rebuilt — the records
// become the grid's second row rather than a separate boxed section.
function renderRecords(superlatives) {
  const box = el('heroTiles');
  if (!superlatives) {
    return;
  }
  const cards = [];
  if (superlatives.oldest) {
    cards.push(record({
      label: 'Oldest photo',
      value: fmtDay(superlatives.oldest.day || String(superlatives.oldest.takenAt).slice(0, 10)),
      detail: [superlatives.oldest.city, superlatives.oldest.country].filter(Boolean).join(', '),
      slice: superlatives.oldest.day ? {
        title: fmtDay(superlatives.oldest.day),
        count: null,
        filters: { day: superlatives.oldest.day },
      } : null,
    }));
  }
  if (superlatives.busiestDay) {
    cards.push(record({
      label: 'Busiest day',
      value: fmtDay(superlatives.busiestDay.day),
      detail: `${fmt(superlatives.busiestDay.count)} photos`,
      slice: {
        title: fmtDay(superlatives.busiestDay.day),
        count: superlatives.busiestDay.count,
        filters: { day: superlatives.busiestDay.day },
      },
    }));
  }
  if (superlatives.busiestMonth) {
    cards.push(record({
      label: 'Busiest month',
      value: fmtMonth(superlatives.busiestMonth.month),
      detail: `${fmt(superlatives.busiestMonth.count)} photos`,
      slice: {
        title: fmtMonth(superlatives.busiestMonth.month),
        count: superlatives.busiestMonth.count,
        filters: monthRange(superlatives.busiestMonth.month),
      },
    }));
  }
  if (superlatives.longestGap) {
    cards.push(record({
      label: 'Longest lull',
      value: `${fmt(superlatives.longestGap.days)} days`,
      detail: `${fmtMonthShort(superlatives.longestGap.from)} → ${fmtMonthShort(superlatives.longestGap.to)}`,
      detailTitle: `${fmtDay(superlatives.longestGap.from)} → ${fmtDay(superlatives.longestGap.to)}`,
    }));
  }
  if (superlatives.home?.city || superlatives.home?.areaLabel) {
    cards.push(record({
      label: 'Home base',
      value: superlatives.home.city || superlatives.home.areaLabel,
      valueTitle: superlatives.home.areaLabel || null,
      detail: `${fmt(superlatives.home.count)} photos`,
      detailInfo: 'The ~10 km area holding your most geotagged photos — deliberately tighter than the whole city, so this count is smaller than the city total under Places.',
      mapAt: { lat: superlatives.home.lat, lon: superlatives.home.lon },
      slice: superlatives.home.city ? {
        title: superlatives.home.city,
        count: null,
        filters: { city: superlatives.home.city },
      } : null,
    }));
  }
  if (superlatives.furthest) {
    const fullPlace = [superlatives.furthest.city, superlatives.furthest.country].filter(Boolean).join(', ');
    cards.push(record({
      label: 'Furthest',
      value: superlatives.furthest.city || fullPlace || `${fmt(superlatives.furthest.distanceKm)} km away`,
      valueTitle: fullPlace || null,
      detail: `${fmt(superlatives.furthest.distanceKm)} km`,
      mapAt: Number.isFinite(superlatives.furthest.lat) ? { lat: superlatives.furthest.lat, lon: superlatives.furthest.lon } : null,
      slice: superlatives.furthest.city ? {
        title: superlatives.furthest.city,
        count: null,
        filters: { city: superlatives.furthest.city },
      } : (superlatives.furthest.day ? {
        title: fmtDay(superlatives.furthest.day),
        count: null,
        filters: { day: superlatives.furthest.day },
      } : null),
    }));
  }
  for (const card of cards) box.append(card);
}

// --- histogram + lens ---

function renderHistogram() {
  const snapshot = state.snapshot;
  if (!snapshot) return;
  const lens = state.lens;
  const hist = el('histogram');
  hist.replaceChildren();
  const maxYear = Math.max(1, ...snapshot.years.map((y) => y.count));
  const lensMax = lens ? Math.max(1, ...lens.years.values()) : 1;

  for (const { year, count } of snapshot.years) {
    const lensCount = lens ? (lens.years.get(year) ?? 0) : null;
    const col = document.createElement('div');
    col.className = 'col';
    col.dataset.year = String(year);
    col.title = lens
      ? `${year}: ${fmt(lensCount)} of ${fmt(count)} — click to view`
      : `${year}: ${fmt(count)} photos — click to explore`;
    const barWrap = document.createElement('div');
    barWrap.className = 'barwrap';
    const bar = document.createElement('div');
    bar.className = lens ? 'bar ghost' : 'bar';
    bar.style.height = `${Math.max(1, Math.round((count / maxYear) * 100))}%`;
    barWrap.append(bar);
    if (lens && lensCount > 0) {
      // Lens bars scale to the lens's own max: the shape of that story is
      // the point; the ghost bars behind keep the whole-library context.
      const lensBar = document.createElement('div');
      lensBar.className = 'bar lens';
      lensBar.style.height = `${Math.max(2, Math.round((lensCount / lensMax) * 100))}%`;
      barWrap.append(lensBar);
    }
    const tip = document.createElement('span');
    tip.className = 'tip';
    tip.textContent = lens ? `${year}: ${fmt(lensCount)} of ${fmt(count)}` : `${year}: ${fmt(count)}`;
    const yr = document.createElement('div');
    yr.className = 'yr';
    yr.textContent = String(year);
    col.append(tip, barWrap, yr);
    col.addEventListener('click', () => {
      if (lens) {
        if (lensCount > 0) {
          openSlice({
            title: `${lens.label} · ${year}`,
            count: lensCount,
            filters: { ...lens.slice.filters, ...yearRange(year) },
            people: lens.slice.people,
            tags: lens.slice.tags,
          });
        }
        return;
      }
      if (state.activeYear === year) {
        closeYear();
      } else {
        void openYear(year, count);
      }
    });
    hist.append(col);
  }
}

async function applyLens(selection) {
  // selection: { type, id?, name?, label, slice }
  try {
    const params = new URLSearchParams({ type: selection.type });
    if (selection.id) params.set('id', selection.id);
    if (selection.name) params.set('name', selection.name);
    const response = await api(`/api/insights/lens?${params}`);
    state.lens = {
      ...selection,
      years: new Map(response.years.map((entry) => [entry.year, entry.count])),
    };
    closeYear();
    el('lensBtn').textContent = `${selection.label} ▾`;
    el('lensBtn').classList.add('active');
    el('lensPopover').hidden = true;
    renderHistogram();
  } catch (error) {
    if (error.unauthorized) { showLogin(); return; }
    toast(`Could not apply lens: ${error.message}`);
  }
}

function clearLens() {
  state.lens = null;
  el('lensBtn').textContent = 'All photos ▾';
  el('lensBtn').classList.remove('active');
  el('lensPopover').hidden = true;
  renderHistogram();
}

function toggleLensPopover() {
  const popover = el('lensPopover');
  if (!popover.hidden) {
    popover.hidden = true;
    return;
  }
  const rect = el('lensBtn').getBoundingClientRect();
  popover.style.top = `${Math.round(rect.bottom + 8)}px`;
  popover.style.left = `${Math.round(Math.min(rect.left, window.innerWidth - 320))}px`;
  el('lensSearch').value = '';
  popover.hidden = false;
  renderLensResults('');
  el('lensSearch').focus();
  const rerender = () => {
    if (!popover.hidden) renderLensResults(el('lensSearch').value);
  };
  void ensureTagsLoaded().then(rerender);
  void ensureLensDirectoryLoaded().then(rerender);
}

// The snapshot carries only the TOP places and people (10 cities, 10
// countries, a couple dozen people) — enough for the default popover view
// but useless to search: anything below the cutoff simply didn't exist to
// the lens. Load the complete directory once, lazily, when the popover
// first opens. The people endpoint may not exist on an older server; the
// snapshot list quietly remains the fallback for whichever half failed.
async function ensureLensDirectoryLoaded() {
  if (state.lensDirectory) return;
  const directory = {};
  const [cities, people] = await Promise.allSettled([
    api('/api/insights/cities'),
    api('/api/insights/people'),
  ]);
  if (cities.status === 'fulfilled') {
    const groups = new Map();
    const singles = [];
    const countryCounts = new Map();
    for (const row of cities.value.cities ?? []) {
      if (row.country) {
        countryCounts.set(row.country, (countryCounts.get(row.country) ?? 0) + row.count);
      }
      if (row.group) {
        const entry = groups.get(row.group) ?? { members: [], count: 0 };
        entry.members.push(row.name);
        entry.count += row.count;
        groups.set(row.group, entry);
      } else {
        singles.push({
          type: 'city',
          name: row.name,
          label: row.name,
          isGroup: false,
          count: row.count,
          slice: { filters: { city: row.name } },
        });
      }
    }
    const cityCandidates = [
      ...singles,
      ...[...groups.entries()].map(([label, entry]) => ({
        type: 'city',
        name: label,
        label,
        isGroup: true,
        count: entry.count,
        // Member names are searchable too: typing a grouped city's real
        // name should surface the group that answers for it.
        haystack: `${label} ${entry.members.join(' ')}`,
        slice: { filters: { cities: entry.members } },
      })),
    ];
    // The snapshot's country counts include city-less photos; the sums
    // derived here don't. Prefer the exact number where we have it.
    const exactCountry = new Map(
      (state.snapshot?.places?.countries ?? []).map((place) => [place.name, place.count]),
    );
    const countryCandidates = [...countryCounts.entries()].map(([name, count]) => ({
      type: 'country',
      name,
      label: name,
      count: exactCountry.get(name) ?? count,
      slice: { filters: { country: name } },
    }));
    directory.places = [...cityCandidates, ...countryCandidates].sort((a, b) => b.count - a.count);
  } else {
    console.warn('Lens: full city list unavailable', cities.reason);
  }
  if (people.status === 'fulfilled') {
    directory.people = (people.value.people ?? []).map((person) => ({
      type: 'person',
      id: person.id,
      label: person.name,
      count: person.count,
      face: person.id,
      slice: { filters: { personIds: [person.id] }, people: [{ id: person.id, name: person.name }] },
    }));
  }
  state.lensDirectory = directory;
}

function lensCandidates() {
  const snapshot = state.snapshot;
  const people = state.lensDirectory?.people ?? (snapshot.graph?.nodes ?? snapshot.people).map((person) => ({
    type: 'person',
    id: person.id,
    label: person.name,
    count: person.count,
    face: person.id,
    slice: { filters: { personIds: [person.id] }, people: [{ id: person.id, name: person.name }] },
  }));
  const places = state.lensDirectory?.places ?? [
    ...snapshot.places.cities.map((place) => ({
      type: 'city',
      name: place.name,
      label: place.name,
      isGroup: Boolean(place.isGroup),
      count: place.count,
      slice: { filters: placeFilters(place.name, place) },
    })),
    ...snapshot.places.countries.map((place) => ({
      type: 'country',
      name: place.name,
      label: place.name,
      count: place.count,
      slice: { filters: { country: place.name } },
    })),
  ];
  const tags = (state.allTags ?? []).map((tag) => ({
    type: 'tag',
    id: tag.id,
    label: (tag.value || tag.name).replace(/^ai\//, ''),
    count: null,
    slice: {
      filters: { tagIds: [tag.id] },
      tags: [{ id: tag.id, name: tag.value || tag.name, value: tag.value || tag.name }],
    },
  }));
  return { people, places, tags };
}

function renderLensResults(query) {
  const box = el('lensResults');
  box.replaceChildren();
  const needle = query.trim().toLowerCase();
  const { people, places, tags } = lensCandidates();

  const reset = document.createElement('button');
  reset.type = 'button';
  reset.textContent = 'All photos';
  reset.addEventListener('click', clearLens);
  box.append(reset);

  const matches = (c) => !needle || (c.haystack ?? c.label).toLowerCase().includes(needle);
  const groups = [
    ['People', people.filter(matches).slice(0, needle ? 12 : 6)],
    ['Places', places.filter(matches).slice(0, needle ? 8 : 5)],
    ['Tags', tags.filter((c) => needle && c.label.toLowerCase().includes(needle)).slice(0, 8)],
  ];
  let any = false;
  for (const [title, candidates] of groups) {
    if (candidates.length === 0) continue;
    any = true;
    const group = document.createElement('div');
    group.className = 'group';
    group.textContent = title;
    box.append(group);
    for (const candidate of candidates) {
      const button = document.createElement('button');
      button.type = 'button';
      if (candidate.face) {
        const img = document.createElement('img');
        img.className = 'face small linkable';
        img.loading = 'lazy';
        img.src = faceUrl(candidate.face);
        img.alt = '';
        img.title = 'Open person card';
        img.addEventListener('click', (event) => {
          event.stopPropagation();
          el('lensPopover').hidden = true;
          void openPersonCard(candidate.id);
        });
        button.append(img);
      }
      const nameNode = document.createElement('span');
      nameNode.textContent = candidate.label;
      button.append(nameNode);
      if (candidate.isGroup) {
        const mark = document.createElement('span');
        mark.className = 'grp-mark';
        mark.textContent = '⁕';
        button.append(mark);
      }
      if (candidate.count !== null) {
        const countNode = document.createElement('span');
        countNode.className = 'n';
        countNode.textContent = fmt(candidate.count);
        button.append(countNode);
      }
      button.addEventListener('click', () => void applyLens(candidate));
      box.append(button);
    }
  }
  if (!any) {
    const none = document.createElement('div');
    none.className = 'none';
    none.textContent = state.allTags ? 'No matches.' : 'No matches yet — tags are loading…';
    box.append(none);
  }
}

// --- year drill-down ---

async function openYear(year, count) {
  const panel = el('yearPanel');
  state.activeYear = year;
  // Scope the where-you-were ribbon below to the same year.
  if (state.timeline?.weeks) {
    state.timeline.selection = null;
    setTimelineWindow(`${year}-01-01`, `${year}-12-31`);
  }
  for (const col of el('histogram').children) {
    col.classList.toggle('active', Number(col.dataset.year) === year);
  }
  panel.hidden = false;
  panel.replaceChildren();
  const head = document.createElement('div');
  head.className = 'year-panel-head';
  const title = document.createElement('h3');
  title.textContent = String(year);
  const sub = document.createElement('span');
  sub.className = 'sub';
  sub.textContent = `${fmt(count)} items · loading…`;
  const grow = document.createElement('div');
  grow.className = 'p-grow';
  const close = document.createElement('button');
  close.className = 'year-close';
  close.textContent = '×';
  close.setAttribute('aria-label', 'Close year details');
  close.addEventListener('click', closeYear);
  head.append(title, sub, grow, close);
  panel.append(head);

  let detail;
  try {
    detail = await api(`/api/insights/year/${year}`);
  } catch (error) {
    if (error.unauthorized) { showLogin(); return; }
    sub.textContent = `Could not load ${year}: ${error.message}`;
    return;
  }
  if (state.activeYear !== year) return; // another year was opened meanwhile
  sub.textContent = `${fmt(detail.count)} items · ${fmt(detail.favorites)} favorites`;

  const cols = document.createElement('div');
  cols.className = 'year-cols';

  // Months mini-histogram. Clicking a month is an intermediate step: it
  // scopes the ribbon plus the People and Places lists to that month and
  // reveals a "View <month>" button next to "View all of <year>". Clicking
  // the selected month again returns to the year scope.
  let monthBtn = null;
  let selectedMonth = null;
  const monthsBox = document.createElement('div');
  const monthsTitle = document.createElement('h4');
  monthsTitle.textContent = 'By month';
  const months = document.createElement('div');
  months.className = 'months';
  const selectMonth = (month, mcount, mcol) => {
    const cols = months.querySelectorAll('.mcol');
    if (selectedMonth === month) {
      selectedMonth = null;
      for (const col of cols) col.classList.remove('active');
      if (monthBtn) monthBtn.hidden = true;
      if (state.timeline?.weeks) {
        state.timeline.selection = null;
        setTimelineWindow(`${year}-01-01`, `${year}-12-31`);
      }
      renderScopedLists({ people: detail.people, cities: detail.cities, month: null });
      return;
    }
    selectedMonth = month;
    for (const col of cols) col.classList.toggle('active', col === mcol);
    if (monthBtn) {
      monthBtn.hidden = false;
      monthBtn.textContent = `View ${fmtMonth(month)}`;
      monthBtn.onclick = () => openSlice({
        title: fmtMonth(month),
        count: mcount,
        filters: monthRange(month),
      });
    }
    if (state.timeline?.weeks) {
      const range = monthRange(month);
      state.timeline.selection = null;
      setTimelineWindow(range.takenAfter, range.takenBefore);
    }
    void (async () => {
      let mdetail;
      try {
        mdetail = await api(`/api/insights/year/${year}/month/${Number(month.slice(5))}`);
      } catch (error) {
        if (error.unauthorized) { showLogin(); return; }
        // Stale guard: an outcome may only paint while its month is still
        // the selection in the still-open year (rapid clicks resolve out
        // of order) — failures included.
        if (state.activeYear !== year || selectedMonth !== month) return;
        // Endpoint unavailable (say, an old server behind fresh static
        // files, or a transient failure): an explicit month-scoped
        // unavailable state — never another scope's numbers under this
        // month's highlight.
        console.warn(`Month detail unavailable for ${month}`, error);
        renderScopedLists({ people: [], cities: [], month, unavailable: true });
        return;
      }
      if (state.activeYear !== year || selectedMonth !== month) return;
      renderScopedLists({ people: mdetail.people, cities: mdetail.cities, month });
    })();
  };
  const byMonth = new Map(detail.months.map((entry) => [entry.month, entry.count]));
  const maxMonth = Math.max(1, ...detail.months.map((entry) => entry.count));
  for (let m = 1; m <= 12; m += 1) {
    const mcount = byMonth.get(m) ?? 0;
    const month = `${year}-${String(m).padStart(2, '0')}`;
    const mcol = document.createElement('div');
    mcol.className = 'mcol';
    const tip = document.createElement('span');
    tip.className = 'tip';
    tip.textContent = `${MONTH_NAMES[m - 1]}: ${fmt(mcount)}`;
    const mbar = document.createElement('div');
    mbar.className = 'mbar';
    mbar.style.height = `${Math.max(2, Math.round((mcount / maxMonth) * 100))}%`;
    const mlbl = document.createElement('div');
    mlbl.className = 'mlbl';
    mlbl.textContent = MONTH_NAMES[m - 1][0];
    mcol.append(tip, mbar, mlbl);
    if (mcount > 0) {
      mcol.addEventListener('click', () => selectMonth(month, mcount, mcol));
    }
    months.append(mcol);
  }
  monthsBox.append(monthsTitle, months);
  if (detail.busiestDay) {
    const busiest = document.createElement('div');
    busiest.className = 'freshness';
    busiest.style.marginTop = '8px';
    busiest.textContent = `Busiest day: ${fmtDay(detail.busiestDay.day)} (${fmt(detail.busiestDay.count)})`;
    monthsBox.append(busiest);
  }
  cols.append(monthsBox);

  // People and Places live in stable boxes whose contents re-render when
  // the month drill changes scope: year data comes from the detail already
  // in hand, month data from the month endpoint.
  const peopleBox = document.createElement('div');
  const peopleTitle = document.createElement('h4');
  const chips = document.createElement('div');
  chips.className = 'chips';
  peopleBox.append(peopleTitle, chips);
  cols.append(peopleBox);

  const placesBox = document.createElement('div');
  const placesTitle = document.createElement('h4');
  const placeRows = document.createElement('div');
  placeRows.className = 'rows mini-rows';
  placesBox.append(placesTitle, placeRows);
  cols.append(placesBox);

  // month: 'YYYY-MM' scopes both lists (titles, counts, slice links) to
  // that month; null restores the year scope. unavailable: the month's
  // request failed — keep the month-scoped titles but say the data is
  // missing instead of leaving another scope's numbers on screen.
  const renderScopedLists = ({ people, cities, month, unavailable = false }) => {
    const scopeTitle = month ? fmtMonth(month) : String(year);
    const scopeRange = month ? monthRange(month) : yearRange(year);
    const scopeNoun = month ? 'month' : 'year';

    peopleTitle.textContent = month ? `People · ${fmtMonth(month)}` : 'People';
    chips.replaceChildren();
    for (const person of (people ?? []).slice(0, 8)) {
      const chip = document.createElement('button');
      chip.className = 'chip-person';
      chip.type = 'button';
      const img = document.createElement('img');
      img.className = 'face small linkable';
      img.loading = 'lazy';
      img.src = faceUrl(person.id);
      img.alt = '';
      img.title = 'Open person card';
      img.addEventListener('click', (event) => {
        event.stopPropagation();
        void openPersonCard(person.id);
      });
      const nameNode = document.createElement('span');
      nameNode.textContent = person.name;
      const countNode = document.createElement('span');
      countNode.className = 'n';
      countNode.textContent = fmt(person.count);
      chip.append(img, nameNode, countNode);
      chip.addEventListener('click', () => openSlice({
        title: `${person.name} · ${scopeTitle}`,
        count: person.count,
        filters: { personIds: [person.id], ...scopeRange },
        people: [{ id: person.id, name: person.name }],
      }));
      chips.append(chip);
    }
    if ((people ?? []).length === 0) {
      const none = document.createElement('div');
      none.className = 'freshness';
      none.textContent = unavailable
        ? `Couldn't load this month's people.`
        : `No named people counted for this ${scopeNoun}.`;
      chips.append(none);
    }

    placesTitle.textContent = month ? `Places · ${fmtMonth(month)}` : 'Places';
    placeRows.replaceChildren();
    const maxPlace = Math.max(1, ...(cities ?? []).map((entry) => entry.count));
    for (const city of cities ?? []) {
      placeRows.append(rowLine({
        name: city.name,
        count: city.count,
        max: maxPlace,
        linkNode: placeNameNode(city.name, city),
        slice: {
          title: `${city.name} · ${scopeTitle}`,
          count: city.count,
          filters: { ...placeFilters(city.name, city), ...scopeRange },
        },
      }));
    }
    if ((cities ?? []).length === 0) {
      const none = document.createElement('div');
      none.className = 'freshness';
      none.textContent = unavailable
        ? `Couldn't load this month's places.`
        : `No location data for this ${scopeNoun}.`;
      placeRows.append(none);
    }
  };
  renderScopedLists({ people: detail.people, cities: detail.cities, month: null });

  panel.append(cols);

  const actions = document.createElement('div');
  actions.className = 'year-actions';
  const viewBtn = document.createElement('button');
  viewBtn.className = 'p-btn';
  viewBtn.textContent = `View all of ${year}`;
  viewBtn.addEventListener('click', () => openSlice({
    title: String(year),
    count: detail.count,
    filters: yearRange(year),
  }));
  actions.append(viewBtn);
  monthBtn = document.createElement('button');
  monthBtn.className = 'p-btn accent';
  monthBtn.hidden = true;
  actions.append(monthBtn);
  panel.append(actions);
}

function closeYear() {
  state.activeYear = null;
  el('yearPanel').hidden = true;
  el('yearPanel').replaceChildren();
  for (const col of el('histogram').children) {
    col.classList.remove('active');
  }
}

// A truncated sweep silently skews every number on the page, so say so at
// the top, for as long as it is true. No dismiss: hiding the banner while
// the numbers are still partial would turn it into a lie. Injected here
// (not in the HTML) because the flag ships in the snapshot payload.
function renderSweepBanner(snapshot) {
  let banner = el('sweepTruncatedBanner');
  if (!snapshot.sweepTruncated) {
    if (banner) banner.hidden = true;
    return;
  }
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'sweepTruncatedBanner';
    banner.className = 'p-panel';
    banner.setAttribute('role', 'status');
    // Same gold-on-outline treatment as .p-chip.warn, panel-sized.
    banner.style.cssText = 'padding: 10px 16px; margin-bottom: 14px; font-size: 13px; '
      + 'line-height: 1.5; color: var(--p-gold); border-color: #6d5410;';
    el('content').prepend(banner);
  }
  banner.hidden = false;
  banner.textContent = `Insights scanned the first ${fmt(snapshot.totals.assetsSwept)} assets of your library — `
    + 'the sweep stopped at its page cap, so every number below covers only that slice. '
    + 'Raise INSIGHTS_MAX_SWEEP_PAGES in the server environment and refresh to cover everything.';
}

function renderMetadataOmissionBanner(snapshot) {
  let banner = el('metadataOmissionBanner');
  const omission = snapshot.metadataOmissions;
  const total = Number(omission?.total ?? 0);
  if (!Number.isSafeInteger(total) || total < 1) {
    if (banner) banner.hidden = true;
    return;
  }
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'metadataOmissionBanner';
    banner.className = 'p-panel';
    banner.setAttribute('role', 'status');
    banner.style.cssText = 'padding: 10px 16px; margin-bottom: 14px; font-size: 13px; '
      + 'line-height: 1.5; color: var(--p-gold); border-color: #6d5410;';
    el('content').prepend(banner);
  }
  const labels = {
    fileSizeInByte: 'file size',
    latitude: 'latitude',
    longitude: 'longitude',
  };
  const detail = Object.entries(omission.fields ?? {})
    .filter(([field, count]) => labels[field] && Number.isSafeInteger(count) && count > 0)
    .map(([field, count]) => `${labels[field]}: ${fmt(count)}`)
    .join(', ');
  banner.hidden = false;
  banner.textContent = `Insights left ${fmt(total)} invalid metadata ${total === 1 ? 'value' : 'values'} blank while scanning`
    + `${detail ? ` (${detail})` : ''}. All photos were still counted.`;
}

function render(snapshot) {
  state.snapshot = snapshot;
  el('content').hidden = false;
  el('empty').hidden = true;
  renderSweepBanner(snapshot);
  renderMetadataOmissionBanner(snapshot);

  const t = snapshot.totals;
  const spanYears = t.firstTakenAt && t.lastTakenAt
    ? Math.max(1, new Date(t.lastTakenAt).getFullYear() - new Date(t.firstTakenAt).getFullYear() + 1)
    : null;
  const tiles = el('heroTiles');
  tiles.replaceChildren(
    tile(fmt(t.photos), 'Photos', { title: 'All photos', count: t.photos, filters: { type: 'IMAGE' } }),
    tile(fmt(t.videos), 'Videos', { title: 'All videos', count: t.videos, filters: { type: 'VIDEO' } }),
    tile(spanYears ? `${spanYears} years` : '—', 'Collection span'),
    tile(fmt(t.peopleNamed), 'Named people'),
    favoritesTile(t),
    tile(fmtBytes(t.storageBytes), 'Media size'),
  );

  renderHistogram();
  void initTimeline(snapshot);
  renderConstellation(snapshot.graph);
  renderRecords(snapshot.superlatives);

  fillRows('peopleRows', snapshot.people.map((person) => ({
    name: person.name,
    count: person.count,
    avatars: [person.id],
    personLink: person.id,
    onClick: () => void openPersonCard(person.id),
  })));

  fillRows('pairRows', snapshot.pairs.map((pair) => ({
    name: `${pair.aName} + ${pair.bName}`,
    count: pair.count,
    avatars: pair.aId && pair.bId ? [pair.aId, pair.bId] : null,
    avatarClick: pair.aId && pair.bId ? (personId) => void openPersonCard(personId) : null,
    slice: pair.aId && pair.bId
      ? pairSliceFor({ id: pair.aId, name: pair.aName }, { id: pair.bId, name: pair.bName }, pair.count)
      : null,
  })));

  fillRows('cityRows', snapshot.places.cities.map((place) => ({
    name: place.name,
    count: place.count,
    linkNode: placeNameNode(place.name, place),
    onClick: () => void openPlaceCard(place.name),
  })));

  fillRows('countryRows', snapshot.places.countries.map((place) => ({
    name: place.name,
    count: place.count,
    slice: { title: place.name, count: place.count, filters: { country: place.name } },
  })));

  fillRows('cameraRows', snapshot.cameras.map((camera) => ({
    name: camera.name,
    count: camera.count,
    slice: camera.model ? {
      title: camera.name,
      count: camera.count,
      filters: { ...(camera.make ? { make: camera.make } : {}), model: camera.model },
    } : null,
  })));

  fillRows('tagRows', snapshot.tags.map((tag) => ({
    name: tag.value.replace(/^ai\//, ''),
    count: tag.count,
    slice: tag.id ? {
      title: tag.value.replace(/^ai\//, ''),
      count: tag.count,
      filters: { tagIds: [tag.id] },
      tags: [{ id: tag.id, name: tag.value, value: tag.value }],
    } : null,
  })));

  const dark = el('darkRows');
  dark.replaceChildren();
  const dm = snapshot.darkMatter;
  const darkItems = [
    { name: 'No location data', count: dm.noLocation },
    { name: 'No camera info', count: dm.noCamera },
  ];
  if (dm.notEnriched !== null && dm.notEnriched !== undefined) {
    darkItems.push({ name: 'Not yet enriched by Curate', count: dm.notEnriched, link: '/curate.html' });
  }
  const maxDark = Math.max(1, ...darkItems.map((item) => item.count));
  for (const item of darkItems) {
    let linkNode = null;
    if (item.link) {
      linkNode = document.createElement('a');
      linkNode.href = item.link;
      linkNode.textContent = item.name;
    }
    dark.append(rowLine({ name: item.name, count: item.count, max: maxDark, linkNode }));
  }

  el('freshness').textContent = `Refreshed ${fmtAgo(snapshot.generatedAt)} · ${fmt(t.assetsSwept)} assets scanned`;
}

function describePhase(status) {
  const p = status.progress || {};
  switch (status.phase) {
    case 'assets': return `Scanning library… ${fmt(p.assetsSwept)} assets`;
    case 'people': return `Counting people… ${fmt(p.peopleDone ?? 0)}/${fmt(p.peopleTotal ?? 0)}`;
    case 'pairs': return `Pairing people… ${fmt(p.pairsDone ?? 0)}/${fmt(p.pairsTotal ?? 0)}`;
    case 'tags': return `Counting tags… ${fmt(p.tagsDone ?? 0)}/${fmt(p.tagsTotal ?? 0)}`;
    default: return 'Working…';
  }
}

function renderRefreshStatus(status, { notifyError = false } = {}) {
  const chip = el('runChip');
  chip.hidden = !status.running;
  chip.textContent = status.running ? describePhase(status) : '';
  el('refreshBtn').disabled = Boolean(status.running);

  const message = status.phase === 'error' && status.error
    ? `Refresh failed: ${status.error}`
    : null;
  const errorNode = el('refreshError');
  errorNode.hidden = !message;
  errorNode.textContent = message ?? '';
  if (notifyError && message && message !== state.lastRefreshError) {
    toast(message);
  }
  state.lastRefreshError = message;
}

async function poll() {
  try {
    const status = await api('/api/insights/status');
    renderRefreshStatus(status, { notifyError: true });
    if (status.running) {
      if (!state.polling) {
        state.polling = setInterval(poll, 2500);
      }
      return;
    }
    const shouldReload = Boolean(state.polling) || state.refreshPending;
    if (state.polling) {
      clearInterval(state.polling);
      state.polling = null;
    }
    state.refreshPending = false;
    if (shouldReload) {
      await load();
    }
  } catch {
    // transient; next poll retries
  }
}

async function refresh() {
  state.refreshPending = true;
  renderRefreshStatus({ running: true, phase: 'starting', progress: {} });
  try {
    await api('/api/insights/refresh', { method: 'POST' });
    toast('Refresh started');
    await poll();
  } catch (error) {
    state.refreshPending = false;
    renderRefreshStatus({ running: false, phase: 'error', error: 'Could not start refresh.' });
    if (error.unauthorized) { showLogin(); return; }
    toast('Could not start refresh');
  }
}

async function load() {
  try {
    const { snapshot, status, immichUrl, favoritesTag, locationGroups } = await api('/api/insights');
    state.immichUrl = immichUrl || null;
    state.favoritesTag = favoritesTag || null;
    state.locationGroups = locationGroups || [];
    el('connStatus').hidden = false;
    if (snapshot) {
      render(snapshot);
    } else {
      el('empty').hidden = false;
      el('content').hidden = true;
    }
    renderRefreshStatus(status);
    if (status.running) {
      await poll();
    }
  } catch (error) {
    if (error.unauthorized) { showLogin(); return; }
    toast('Pictaria Server unreachable');
  }
}

el('refreshBtn').addEventListener('click', refresh);
el('firstRunBtn').addEventListener('click', refresh);

// Insights → Enrich funnel: run AI enrichment on exactly this slice. The
// server resolves the filters to asset ids (capped at 1,000 per run;
// already-enriched photos are skipped, so repeat sends walk a big slice).
fetch('/api/health').then((r) => r.json())
  .then((health) => { state.enrichEnabled = health.enrichEnabled === true; })
  .catch(() => {});

el('modalEnrichBtn').addEventListener('click', async () => {
  const slice = state.browser?.slice;
  if (!slice) return;
  el('modalEnrichBtn').disabled = true;
  try {
    const response = await fetch('/api/enrich/queue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: slice.title, filters: slice.filters, estimatedCount: slice.count ?? null }),
    });
    if (response.status === 401) { showLogin(); return; }
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      toast(body?.error?.message ?? 'Could not queue enrichment');
      el('modalEnrichBtn').disabled = false;
      return;
    }
    // Stay disabled with a visible state change so a second press can't
    // double-queue (the server dedupes identical slices as a backstop).
    // Freeze the width first so the shorter label doesn't shift the row.
    el('modalEnrichBtn').style.minWidth = `${el('modalEnrichBtn').offsetWidth}px`;
    el('modalEnrichBtn').textContent = 'Queued ✓';
    toast(body.duplicate
      ? `"${slice.title}" is already queued on the Enrich page`
      : `Queued "${slice.title}" — run it from the Enrich page`);
  } catch {
    toast('Could not queue enrichment');
    el('modalEnrichBtn').disabled = false;
  }
});

// Insights → Curate funnel: put this slice straight into the review queue,
// no AI involved. Photos already decided stay decided (the server only
// lists them; decisions are never reset from here).
el('modalCurateBtn').addEventListener('click', async () => {
  const slice = state.browser?.slice;
  if (!slice) return;
  el('modalCurateBtn').disabled = true;
  try {
    const response = await fetch('/api/review/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filters: slice.filters }),
    });
    if (response.status === 401) { showLogin(); return; }
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      toast(body?.error?.message ?? 'Could not send to Curate');
      el('modalCurateBtn').disabled = false;
      return;
    }
    el('modalCurateBtn').style.minWidth = `${el('modalCurateBtn').offsetWidth}px`;
    el('modalCurateBtn').textContent = 'Sent ✓';
    const extras = [
      body.alreadyListed ? `${body.alreadyListed.toLocaleString()} already there` : null,
      body.truncated ? 'capped at 1,000 — send again for the rest' : null,
    ].filter(Boolean).join('; ');
    toast(`${body.added.toLocaleString()} photo${body.added === 1 ? '' : 's'} added to Curate${extras ? ` (${extras})` : ''}`);
  } catch {
    toast('Could not send to Curate');
    el('modalCurateBtn').disabled = false;
  }
});

el('modalClose').addEventListener('click', closeModal);
el('photoModal').addEventListener('click', (event) => {
  if (event.target === el('photoModal')) closeModal();
});
el('gridMore').addEventListener('click', loadGridPage);

el('pcClose').addEventListener('click', closePersonCard);
el('pcBack').addEventListener('click', personCardBack);
el('personCard').addEventListener('click', (event) => {
  if (event.target === el('personCard')) closePersonCard();
});
el('plcClose').addEventListener('click', closePlaceCard);
el('placeCard').addEventListener('click', (event) => {
  if (event.target === el('placeCard')) closePlaceCard();
});

el('favTagSearch').addEventListener('input', () => renderFavTagResults(el('favTagSearch').value));
el('favUseImmich').addEventListener('click', () => void clearFavoritesTag());
el('lensBtn').addEventListener('click', toggleLensPopover);
wireTimelineInteractions();
el('lensSearch').addEventListener('input', () => renderLensResults(el('lensSearch').value));
document.addEventListener('click', (event) => {
  const popover = el('favPopover');
  if (!popover.hidden && !popover.contains(event.target) && !event.target.closest('.tile .gear')) {
    popover.hidden = true;
  }
  const lensPopover = el('lensPopover');
  if (!lensPopover.hidden && !lensPopover.contains(event.target) && event.target !== el('lensBtn')) {
    lensPopover.hidden = true;
  }
});

el('lbClose').addEventListener('click', closeLightbox);
el('lbPrev').addEventListener('click', () => void stepLightbox(-1));
el('lbNext').addEventListener('click', () => void stepLightbox(1));
el('lightbox').addEventListener('click', (event) => {
  if (event.target === el('lightbox')) closeLightbox();
});

document.addEventListener('keydown', (event) => {
  if (!el('favPopover').hidden && event.key === 'Escape') {
    el('favPopover').hidden = true;
    return;
  }
  if (!el('lensPopover').hidden && event.key === 'Escape') {
    el('lensPopover').hidden = true;
    return;
  }
  if (!el('lightbox').hidden) {
    if (event.key === 'Escape') closeLightbox();
    if (event.key === 'ArrowLeft') void stepLightbox(-1);
    if (event.key === 'ArrowRight') void stepLightbox(1);
    return;
  }
  if (!el('photoModal').hidden && event.key === 'Escape') {
    closeModal();
    return;
  }
  if (state.personCard && event.key === 'Escape') {
    closePersonCard();
    return;
  }
  if (state.placeCard && event.key === 'Escape') {
    closePlaceCard();
    return;
  }
  if (state.activeYear !== null && event.key === 'Escape') {
    closeYear();
  }
});

load();
