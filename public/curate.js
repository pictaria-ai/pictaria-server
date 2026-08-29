const state = {
  view: 'candidates',
  q: '',
  group: 'all',
  offset: 0,
  limit: 100,
  total: 0,
  assets: [],
  selected: new Set(),
  loading: false,
  lightboxIndex: -1,
  compareBurstId: null,
  compareMembers: [],
  compareBestAssetId: null,
  cardCount: 0,
  syncPolling: null,
  loadingPromise: null,
  immichUrl: null,
  // Decisions made this session (per view load): appended pages are filtered
  // against this so a fetch that raced a decision can't resurrect the photo.
  recentlyDecided: new Set(),
};

// Keep this many photos loaded ahead while deciding: when the visible list
// runs below it and the server has more, the next page appends by itself —
// no "Load more" click, no lightbox dead-end mid-queue.
const LOAD_AHEAD = 25;

// Page-size override for tests and power users: /curate.html?limit=5.
{
  const urlLimit = Number(new URLSearchParams(location.search).get('limit'));
  if (urlLimit > 0) state.limit = Math.min(urlLimit, 400);
}

const el = (id) => document.getElementById(id);
const grid = el('grid');
const tabs = el('tabs');

// ---------- API ----------
async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body) headers['content-type'] = 'application/json';
  const response = await fetch(path, { ...options, headers });
  if (response.status === 401) {
    requirePassword();
    throw new Error('App password required — enter it and press Connect');
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload?.error?.message || `Request failed (${response.status})`);
  setConnected(true);
  return payload;
}

// ---------- Loading & rendering ----------
// Returns a promise that settles when THIS load (or the one already in
// flight) finishes — advanceLightbox awaits it to keep the flow moving
// across page boundaries.
function loadAssets(append = false) {
  if (state.loading) return state.loadingPromise ?? Promise.resolve();
  state.loading = true;
  state.loadingPromise = doLoadAssets(append);
  return state.loadingPromise;
}

async function doLoadAssets(append) {
  el('loadMore').disabled = true;
  try {
    const params = new URLSearchParams({ view: state.view, q: state.q, offset: String(state.offset), limit: String(state.limit) });
    if (state.group !== 'all' && state.view !== 'decided') params.set('group', state.group);
    const payload = await api(`/api/review/assets?${params}`);
    state.total = payload.total;
    state.immichUrl = payload.immichUrl || null;
    setEnrichNote(payload.enrichRunning);
    if (!append) {
      state.assets = [];
      state.recentlyDecided.clear();
      closeBurstbox();
    }
    // Append guards for fetches raced by decisions: the server list shifts
    // left as photos are decided, so a page can contain photos already
    // loaded (dupes) or decided while the request was in flight (stale).
    const known = new Map(state.assets.map((asset) => [asset.assetId, asset]));
    // Stack membership regenerates server-side as an enrichment run streams
    // photos in, so a page can carry fresher stack annotations for rows we
    // already hold — refresh them in place or the card chips go stale.
    // Only the burst fields are merged: everything else on a loaded row is
    // still current, and client-side caches (enrichInfo) must survive.
    const BURST_FIELDS = ['burstId', 'burstSize', 'burstAssetIds', 'burstBestAssetId', 'burstPickSource', 'burstMemberStates', 'burstMemberFiles'];
    for (const fresh of payload.assets) {
      const cached = known.get(fresh.assetId);
      if (cached) for (const field of BURST_FIELDS) cached[field] = fresh[field];
    }
    state.assets.push(
      ...payload.assets.filter(
        (asset) => !known.has(asset.assetId) && !state.recentlyDecided.has(asset.assetId),
      ),
    );
    renderTabs(payload);
    renderGrid();
    renderSync(payload.sync);
    state.offset = state.assets.length;
    el('bulkUndo').hidden = state.view !== 'decided';
    // Stacks/singles passes don't apply to the decided list.
    el('groupFilter').hidden = state.view === 'decided';
  } catch (error) {
    toast(error.message, true);
  } finally {
    state.loading = false;
    el('loadMore').disabled = state.offset >= state.total;
  }
}

function renderTabs(payload) {
  const items = [
    ...payload.buckets.map((bucket) => ({ id: bucket.id, label: bucket.label, count: bucket.count, title: bucket.description })),
    { id: 'decided', label: 'Decided', count: payload.decidedCount, title: 'Photos you have already decided' },
  ];
  const nodes = items.map((item) => {
    const button = document.createElement('button');
    button.className = `p-tab ${item.id === state.view ? 'active' : ''}`;
    button.title = item.title || '';
    button.innerHTML = `${escapeHtml(item.label)} <span class="count">${item.count}</span>`;
    button.addEventListener('click', () => {
      state.view = item.id;
      state.offset = 0;
      state.selected.clear();
      updateBulkbar();
      loadAssets(false);
    });
    return button;
  });
  const divider = document.createElement('span');
  divider.className = 'p-tab-divider';
  nodes.splice(nodes.length - 1, 0, divider);
  tabs.replaceChildren(...nodes);
}

// The grid always re-renders in full: bursts collapse to one stack card, and
// a newly loaded page can add members to an existing stack, so append-only
// rendering would be wrong. A few hundred lazy-loading cards render in ms.
function renderGrid() {
  grid.replaceChildren();
  state.cardCount = 0;
  if (state.assets.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    // An exhausted PAGE is not an exhausted QUEUE: with more matching photos
    // server-side the auto-append is already on its way, and claiming
    // "empty" here is exactly the false "all done" screen this guard prevents.
    empty.textContent = state.view === 'decided'
      ? 'No decisions yet.'
      : state.total > 0 ? 'Loading more…' : 'Queue is empty — nice work.';
    grid.append(empty);
    updateMeta();
    return;
  }
  const renderedBursts = new Set();
  const units = [];
  for (const asset of state.assets) {
    if (asset.burstId && state.view !== 'decided') {
      if (renderedBursts.has(asset.burstId)) continue;
      renderedBursts.add(asset.burstId);
      const members = state.assets.filter((a) => a.burstId === asset.burstId);
      units.push({
        render: () => (members.length > 1 ? renderStackCard(members) : renderCard(members[0])),
        // Referee-judged stacks lead the grid — they're the ones with a
        // verdict waiting, so they shouldn't have to be hunted for.
        gold: members.length > 1 && members.some((m) => m.burstPickSource === 'referee'),
      });
    } else {
      units.push({ render: () => renderCard(asset), gold: false });
    }
  }
  units.sort((a, b) => Number(b.gold) - Number(a.gold)); // stable: keeps queue order within each half
  for (const unit of units) {
    grid.append(unit.render());
    state.cardCount += 1;
  }
  updateMeta();
}

function updateMeta() {
  const base = `${state.assets.length} of ${state.total}`;
  el('meta').textContent = state.cardCount && state.cardCount !== state.assets.length
    ? `${base} photos · ${state.cardCount} card${state.cardCount === 1 ? '' : 's'}`
    : base;
}

// One card for a whole "same moment" group: the suggested keeper's thumbnail
// on a pile-of-photos edge. Deciding stays available without opening it
// (Keep ★), the checkbox selects every member, and clicking opens compare.
function renderStackCard(members) {
  const best = members.find((m) => m.assetId === m.burstBestAssetId) ?? null;
  const rep = best ?? members[0];
  const card = document.createElement('article');
  const allSelected = members.every((m) => state.selected.has(m.assetId));
  card.className = `p-card stack ${allSelected ? 'selected' : ''}`;
  card.dataset.burstId = rep.burstId;

  const edge2 = document.createElement('div');
  edge2.className = 'stack-edge e2';
  const edge1 = document.createElement('div');
  edge1.className = 'stack-edge e1';

  const thumbWrap = document.createElement('div');
  thumbWrap.className = 'card-thumb-wrap';
  const img = document.createElement('img');
  img.className = 'card-thumb';
  img.loading = 'lazy';
  img.alt = '';
  img.src = `/api/review/thumbnail/${encodeURIComponent(rep.assetId)}`;
  img.addEventListener('click', () => openBurstbox(rep));
  thumbWrap.append(img);

  const badge = document.createElement('span');
  const refereed = rep.burstPickSource === 'referee';
  badge.className = `p-badge ${best ? (refereed ? 'gold' : 'silver') : ''}`;
  badge.textContent = `${best ? '★ ' : ''}${members.length} photos`;
  badge.title = best
    ? refereed
      ? 'Same moment — the AI referee compared these side by side and picked this one. Click to compare all.'
      : 'Same moment — showing the highest-scoring photo. Click to compare all.'
    : 'Same moment — click to compare all.';
  thumbWrap.append(badge);

  const check = document.createElement('input');
  check.type = 'checkbox';
  check.className = 'card-check';
  check.checked = allSelected;
  check.title = `Select all ${members.length} photos in this group`;
  check.addEventListener('change', () => {
    for (const member of members) {
      check.checked ? state.selected.add(member.assetId) : state.selected.delete(member.assetId);
    }
    card.classList.toggle('selected', check.checked);
    updateBulkbar();
  });
  thumbWrap.append(check);

  const body = document.createElement('div');
  body.className = 'card-body';
  const file = document.createElement('div');
  file.className = 'card-file';
  file.title = members.map((m) => m.filename).join(', ');
  file.textContent = `${members.length} photos · ${rep.filename || rep.assetId}`;

  const actions = document.createElement('div');
  actions.className = 'card-actions';
  actions.style.gridTemplateColumns = best ? '1fr 1fr' : '1fr';
  const compare = document.createElement('button');
  compare.className = 'p-btn';
  compare.textContent = 'Compare';
  compare.addEventListener('click', () => openBurstbox(rep));
  actions.append(compare);
  if (best) {
    const keep = document.createElement('button');
    keep.className = 'p-btn gold';
    keep.textContent = `★ Keep, skip ${members.length - 1}`;
    keep.title = `Approve the ★ photo, mark the other ${members.length - 1} as reviewed (not rejected)`;
    keep.addEventListener('click', () => keepBest(best));
    actions.append(keep);
  }

  body.append(file, scoreBar(rep.frameScore), chipsRow(rep), actions);
  card.append(edge2, edge1, thumbWrap, body);
  return card;
}

// Stack-mates of `asset` that are still undecided (self included). Falls
// back to the full membership when the payload predates burstMemberStates.
function undecidedStackIds(asset) {
  const ids = asset.burstAssetIds ?? [];
  if (!asset.burstMemberStates) return ids;
  return ids.filter((id) => asset.burstMemberStates[id] === 'undecided');
}

function renderCard(asset) {
  const card = document.createElement('article');
  card.className = `p-card ${state.selected.has(asset.assetId) ? 'selected' : ''}`;
  card.dataset.assetId = asset.assetId;

  // A remnant — the last undecided photo of its moment — opens the compare
  // view (its decided siblings show dimmed with their outcomes) instead of
  // the single-photo lightbox: the group is still the context that makes
  // the decision easy, even when history got to the siblings first.
  const remnant = asset.burstSize > 1 && undecidedStackIds(asset).length <= 1;

  const thumbWrap = document.createElement('div');
  thumbWrap.className = 'card-thumb-wrap';
  const img = document.createElement('img');
  img.className = 'card-thumb';
  img.loading = 'lazy';
  img.alt = '';
  img.src = `/api/review/thumbnail/${encodeURIComponent(asset.assetId)}`;
  img.addEventListener('click', () => {
    if (remnant) openBurstbox(asset);
    else openLightbox(state.assets.findIndex((a) => a.assetId === asset.assetId));
  });
  thumbWrap.append(img);
  if (asset.burstSize > 1) {
    const badge = document.createElement('span');
    const isBest = asset.burstBestAssetId === asset.assetId;
    const refereed = asset.burstPickSource === 'referee';
    if (remnant) {
      // No star claim for a remnant: "best of N" promises a comparison the
      // grid can't offer once the siblings are decided. Say what's true.
      badge.className = 'p-badge';
      badge.textContent = `${asset.burstSize - 1} of ${asset.burstSize} decided`;
      badge.title = 'The other photos of this moment are already decided — click to compare against them anyway.';
    } else {
      badge.className = `p-badge ${isBest ? (refereed ? 'gold' : 'silver') : ''}`;
      badge.textContent = isBest ? `★ best of ${asset.burstSize}` : `in a stack of ${asset.burstSize}`;
      badge.title = isBest
        ? refereed
          ? 'The AI referee compared this Stack side by side and picked this photo'
          : 'Highest frame-worthy score in this Stack — suggested keeper'
        : asset.burstBestAssetId
          ? 'Part of a Stack whose other photos are in another tab or already decided; the ★ photo is the suggested keeper'
          : 'Part of a Stack whose other photos are in another tab or already decided (no signal to suggest a best pick)';
    }
    thumbWrap.append(badge);
  }
  const check = document.createElement('input');
  check.type = 'checkbox';
  check.className = 'card-check';
  check.checked = state.selected.has(asset.assetId);
  check.addEventListener('change', () => {
    check.checked ? state.selected.add(asset.assetId) : state.selected.delete(asset.assetId);
    card.classList.toggle('selected', check.checked);
    updateBulkbar();
  });
  thumbWrap.append(check);

  const body = document.createElement('div');
  body.className = 'card-body';
  const file = document.createElement('div');
  file.className = 'card-file';
  file.title = asset.originalPath || '';
  file.textContent = asset.filename || asset.assetId;
  body.append(file, scoreBar(asset.frameScore), chipsRow(asset), cardActions(asset));

  card.append(thumbWrap, body);
  return card;
}

function scoreBar(score) {
  const row = document.createElement('div');
  row.className = 'p-score';
  const value = typeof score === 'number' ? score : null;
  row.innerHTML = `<span>${value === null ? '–' : value.toFixed(2)}</span>
    <span class="p-score-track"><span class="p-score-fill" style="width:${Math.round((value ?? 0) * 100)}%"></span></span>`;
  return row;
}

function chipsRow(asset) {
  const row = document.createElement('div');
  row.className = 'card-chips';
  for (const reason of asset.reasons.slice(0, 2)) row.append(chip(reason, reasonClass(reason)));
  if (state.view === 'decided') for (const tag of asset.frameTags) row.append(chip(tag.replace('frame/', ''), 'accent'));
  for (const tag of asset.aiTags.filter((t) => !t.startsWith('ai/exclude/')).slice(0, 3)) {
    row.append(chip(tag.replace(/^ai\/[a-z]+\//, '')));
  }
  return row;
}

function reasonClass(reason) {
  if (reason.startsWith('privacy?')) return 'warn';
  if (reason.startsWith('excluded') || reason.startsWith('quality')) return 'danger';
  return '';
}

function chip(text, variant = '') {
  const span = document.createElement('span');
  span.className = `p-chip ${variant}`;
  span.title = text;
  span.textContent = text;
  return span;
}

function cardActions(asset, { reserveKeepBest = false } = {}) {
  const row = document.createElement('div');
  row.className = 'card-actions';
  for (const [action, label, cls] of [['favorite', 'Fav', 'gold'], ['approve', 'Yes', 'primary'], ['reviewed', 'Skip', ''], ['reject', 'No', 'danger']]) {
    const button = document.createElement('button');
    button.className = `p-btn ${cls}`;
    button.textContent = label;
    button.addEventListener('click', () => decide(action, [asset.assetId]));
    row.append(button);
  }
  let keepShown = false;
  if (state.view !== 'decided' && asset.burstBestAssetId === asset.assetId) {
    // Only offer the sweep while other members are actually still here —
    // once they're decided (or not loaded), the button would be a no-op.
    const live = new Set(state.assets.map((a) => a.assetId));
    const rest = (asset.burstAssetIds ?? []).filter((id) => id !== asset.assetId && live.has(id));
    if (rest.length > 0) {
      const button = document.createElement('button');
      button.className = 'p-btn gold keep-best';
      button.textContent = `★ Keep, skip ${rest.length}`;
      button.title = `Keep best, skip rest: approve this photo, mark the other ${rest.length} in the group as reviewed (not rejected)`;
      button.addEventListener('click', () => keepBest(asset));
      row.append(button);
      keepShown = true;
    }
  }
  if (reserveKeepBest && !keepShown) {
    // Compare view: every cell reserves the keep-best row so buttons sit at
    // identical heights and never shift when the button appears/disappears.
    const spacer = document.createElement('button');
    spacer.className = 'p-btn keep-best';
    spacer.style.visibility = 'hidden';
    spacer.tabIndex = -1;
    spacer.setAttribute('aria-hidden', 'true');
    spacer.textContent = '·';
    row.append(spacer);
  }
  return row;
}

// "Keep best, skip rest": approve the group's suggested pick, mark the other
// members reviewed — near-identical shots of a good moment aren't junk, just
// redundant, so they're never rejected on the AI's word. Only members still
// undecided on this page are touched: a decision you already made on one
// member (say, a Fav) is never overwritten by the sweep.
async function keepBest(asset) {
  const live = new Set(state.assets.map((a) => a.assetId));
  const best = asset.burstBestAssetId;
  const rest = (asset.burstAssetIds ?? []).filter((id) => id !== best && live.has(id));
  if (!best || !live.has(best) || rest.length === 0) return;
  try {
    await api('/api/review/decision', { method: 'POST', body: JSON.stringify({ action: 'approve', asset_ids: [best] }) });
    const payload = await api('/api/review/decision', { method: 'POST', body: JSON.stringify({ action: 'reviewed', asset_ids: rest }) });
    removeDecided([best, ...rest]);
    renderSync(payload.sync);
    toast(`kept ★, skipped ${rest.length}`);
  } catch (error) {
    toast(error.message, true);
  }
}

// ---------- Decisions ----------
async function decide(action, assetIds) {
  try {
    const payload = await api('/api/review/decision', { method: 'POST', body: JSON.stringify({ action, asset_ids: assetIds }) });
    if (state.view === 'decided') {
      closeLightbox();
      loadAssetsFresh();
    } else {
      removeDecided(assetIds);
    }
    renderSync(payload.sync);
    toast(`${action}: ${assetIds.length} photo${assetIds.length === 1 ? '' : 's'}`);
  } catch (error) {
    toast(error.message, true);
  }
}

function removeDecided(assetIds) {
  if (state.view === 'decided') return;
  const ids = new Set(assetIds);
  state.assets = state.assets.filter((asset) => !ids.has(asset.assetId));
  state.total -= ids.size;
  state.offset = state.assets.length;
  for (const id of ids) {
    state.selected.delete(id);
    state.recentlyDecided.add(id);
  }
  const active = tabs.querySelector('.p-tab.active .count');
  if (active) active.textContent = String(Math.max(0, Number(active.textContent) - ids.size));
  // Full re-render: a removal can shrink a stack, dissolve it to a single
  // card, or empty the grid — surgical DOM removal can't cover those.
  renderGrid();
  updateBulkbar();
  if (state.compareBurstId) renderBurstbox();
  // Keep the queue flowing: when decisions run the loaded list low and the
  // server has more, append the next page before the user reaches the end.
  if (state.assets.length < LOAD_AHEAD && state.offset < state.total) loadAssets(true);
}

function updateBulkbar() {
  el('bulkbar').hidden = state.selected.size === 0;
  el('selectedCount').textContent = `${state.selected.size} selected`;
  const visible = state.assets.map((a) => a.assetId);
  const checked = visible.filter((id) => state.selected.has(id)).length;
  const box = el('selectVisible');
  box.checked = visible.length > 0 && checked === visible.length;
  box.indeterminate = checked > 0 && checked < visible.length;
}

// ---------- Lightbox ----------
// Review rows carry only the short card label; the 2–3 sentence caption and
// the enriching provider/model are fetched one asset at a time when the
// lightbox opens (deliberately kept off the grid payload — see the
// /api/enrich/caption route). Cached per asset; the swap is skipped if the
// user has already moved to another photo.
async function showFullCaption(asset) {
  if (asset.enrichInfo === undefined) {
    asset.enrichInfo = null;
    try {
      const payload = await api(`/api/enrich/caption?assetId=${encodeURIComponent(asset.assetId)}`);
      asset.enrichInfo = payload && (payload.caption || payload.model) ? payload : null;
    } catch {
      asset.enrichInfo = undefined; // retry on next open — likely transient
    }
  }
  if (state.assets[state.lightboxIndex]?.assetId !== asset.assetId) return;
  const info = asset.enrichInfo;
  if (typeof info?.caption === 'string' && info.caption) {
    el('lbCaption').textContent = info.caption;
  }
  const note = info?.model
    ? `enriched by ${String(info.provider ?? '').replace('cloud_', '').replace('local_', '')} · ${info.model}`
    : '';
  el('lbModel').textContent = note;
  el('lbModel').hidden = !note;
}

function openLightbox(index) {
  if (index < 0 || index >= state.assets.length) return;
  state.lightboxIndex = index;
  const asset = state.assets[index];
  el('lbImage').src = `/api/review/thumbnail/${encodeURIComponent(asset.assetId)}`;
  el('lbFile').textContent = asset.filename || asset.assetId;
  el('lbCaption').textContent = asset.caption || '';
  // Clear the previous photo's attribution before the async fetch fills it —
  // a stale "enriched by" note must not carry over while navigating.
  el('lbModel').textContent = '';
  el('lbModel').hidden = true;
  showFullCaption(asset);
  el('lbImmich').hidden = !state.immichUrl;
  if (state.immichUrl) el('lbImmich').href = `${state.immichUrl}/photos/${encodeURIComponent(asset.assetId)}`;
  el('lbScore').replaceChildren(scoreBar(asset.frameScore));
  el('lbReasons').replaceChildren(...asset.reasons.map((reason) => chip(reason, reasonClass(reason))));
  el('lbAiTags').replaceChildren(...asset.aiTags.map((tag) => chip(tag.replace('ai/', ''))));
  el('lbFrameTags').replaceChildren(...(asset.frameTags.length ? asset.frameTags.map((tag) => chip(tag.replace('frame/', ''), 'accent')) : [chip('undecided')]));
  // Stack controls scope to UNDECIDED members only: a stack can carry
  // siblings decided in earlier sessions, and neither "apply to all" nor
  // "keep best" may silently overwrite those decisions. With nothing else
  // undecided, both controls hide — a remnant is decided on its own.
  const undecidedIds = undecidedStackIds(asset);
  const burst = asset.burstSize > 1 && undecidedIds.length > 1;
  el('lbBurst').hidden = !burst;
  if (burst) {
    el('lbBurstLabel').textContent = undecidedIds.length === asset.burstSize
      ? `Apply to all ${asset.burstSize} photos in this Stack`
      : `Apply to the ${undecidedIds.length} undecided photos in this Stack`;
  }
  el('lbBurstApply').checked = false;
  const keepable = burst && state.view !== 'decided' && asset.burstBestAssetId
    && undecidedIds.includes(asset.burstBestAssetId);
  el('lbKeepBest').hidden = !keepable;
  if (keepable) {
    const isBest = asset.burstBestAssetId === asset.assetId;
    el('lbKeepBest').textContent = isBest
      ? `★ (K)eep this, skip ${undecidedIds.length - 1}`
      : `★ (K)eep best, skip rest`;
    el('lbKeepBest').title = isBest
      ? `This is the burst's highest-scoring photo. Approve it; mark the other ${undecidedIds.length - 1} undecided as reviewed (not rejected).`
      : 'Approve the Stack’s ★ highest-scoring photo; mark the other undecided as reviewed (not rejected).';
  }
  el('lightbox').classList.add('open');
}

function closeLightbox() {
  el('lightbox').classList.remove('open');
  state.lightboxIndex = -1;
}

function lightboxDecide(action) {
  const asset = state.assets[state.lightboxIndex];
  if (!asset) return;
  // Never re-decide siblings that already carry a decision (see the
  // lbBurst scoping note in openLightbox).
  const ids = el('lbBurstApply').checked && asset.burstAssetIds ? undecidedStackIds(asset) : [asset.assetId];
  const nextIndex = state.lightboxIndex; // list shrinks; same index = next photo
  decide(action, ids).then(() => {
    if (state.view === 'decided') return;
    if (state.compareBurstId) closeLightbox(); // zoomed from compare: back to it
    else advanceLightbox(nextIndex);
  });
}

function lightboxStep(delta) {
  const asset = state.assets[state.lightboxIndex];
  if (state.compareBurstId && asset) {
    // Zoomed from the compare view: arrows must follow the compare grid's
    // left-to-right layout (capture order) and stay inside the moment.
    // state.assets order is the queue's SCORE order — walking it here made
    // → appear to go backwards whenever the better shot was taken first.
    // Dimmed decided stubs aren't zoomable, so they're skipped.
    const order = (state.compareMembers ?? [])
      .map((member) => member.assetId)
      .filter((id) => state.assets.some((a) => a.assetId === id));
    const at = order.indexOf(asset.assetId);
    const next = at + delta;
    if (at !== -1 && next >= 0 && next < order.length) {
      openLightbox(state.assets.findIndex((a) => a.assetId === order[next]));
    }
    return;
  }
  const next = state.lightboxIndex + delta;
  if (next >= 0 && next < state.assets.length) openLightbox(next);
}

// Advance to whatever now sits at `index` after a decision. If that photo is
// part of a stack with other undecided members on this page, drop into the
// compare view instead of the single-photo lightbox — deciding a stack member
// without seeing its siblings defeats the point of stacking.
async function advanceLightbox(index) {
  if (index >= state.assets.length) {
    // A finished PAGE is not a finished QUEUE: while the server has more
    // matching photos (or an append is in flight), wait for it and keep the
    // flow going instead of dumping the user onto a grid that looks done.
    // The attempt cap is a safety net, not an expected path.
    for (let attempts = 0; index >= state.assets.length && attempts < 20; attempts++) {
      if (!state.loading && state.offset >= state.total) break;
      await loadAssets(true);
    }
    if (index >= state.assets.length) {
      closeLightbox();
      return;
    }
  }
  const next = state.assets[index];
  const inStack = next.burstId && state.view !== 'decided'
    && state.assets.filter((a) => a.burstId === next.burstId).length > 1;
  if (inStack) {
    closeLightbox();
    openBurstbox(next);
  } else {
    openLightbox(index);
  }
}

function lightboxKeepBest() {
  const asset = state.assets[state.lightboxIndex];
  if (!asset || !asset.burstBestAssetId || state.view === 'decided') return;
  const nextIndex = state.lightboxIndex; // list shrinks; same index = next photo
  keepBest(asset).then(() => {
    if (state.compareBurstId) closeLightbox();
    else advanceLightbox(nextIndex);
  });
}

// ---------- Compare view (one "same moment" group side by side) ----------
function openBurstbox(anchor) {
  state.compareBurstId = anchor.burstId;
  // The clicked card is the single source of truth for this compare session:
  // membership, count, and best pick all come from ITS annotation, so the
  // view can never disagree with the card the user just read — even when a
  // streaming enrichment run has re-grouped stacks server-side since this
  // row was fetched. Members map by assetId, never by burstId
  // string: ids regenerate with membership, and matching strings across
  // fetch generations mixed two different stacks into one view.
  state.compareBestAssetId = anchor.burstBestAssetId ?? null;
  // Snapshot the members for this compare session: cells keep their grid
  // positions while decisions are made (a decided photo becomes a dimmed
  // placeholder instead of reflowing every remaining cell into new rows).
  // The snapshot covers the WHOLE moment in capture order: siblings not in
  // this view — decided in an earlier session — ride along as dimmed stubs
  // with their outcome, so a remnant is still judged against its group.
  const byId = new Map(state.assets.map((a) => [a.assetId, a]));
  state.compareMembers = (anchor.burstAssetIds ?? [anchor.assetId]).map(
    (id) =>
      byId.get(id) ?? {
        assetId: id,
        decidedState: anchor.burstMemberStates?.[id],
        filename: anchor.burstMemberFiles?.[id],
      },
  );
  renderBurstbox();
  el('burstbox').classList.add('open');
}

function closeBurstbox() {
  state.compareBurstId = null;
  state.compareMembers = [];
  state.compareBestAssetId = null;
  el('burstbox').classList.remove('open');
}

function renderBurstbox() {
  const live = new Map(state.assets.map((a) => [a.assetId, a]));
  const members = (state.compareMembers ?? []).map((snap) => live.get(snap.assetId) ?? snap);
  const liveMembers = members.filter((member) => live.has(member.assetId));
  if (liveMembers.length === 0) {
    closeBurstbox();
    return;
  }
  // The best pick is pinned at open time (the clicked card's ★): member rows
  // refreshed by a later append may carry a different generation's pick.
  const best = liveMembers.find((m) => m.assetId === state.compareBestAssetId) ?? null;
  el('bbTitle').textContent = liveMembers.length === members.length
    ? `Same moment · ${members.length} photo${members.length === 1 ? '' : 's'}`
    : `Same moment · ${liveMembers.length} of ${members.length} photos left`;
  const dated = members.find((member) => member.capturedAt);
  el('bbSub').textContent = dated ? new Date(dated.capturedAt).toLocaleString() : '';
  // Header buttons hide via visibility so the head never changes height
  // (or wrap layout) mid-session as decisions land.
  const headButton = (id, show, label, onclick) => {
    const button = el(id);
    button.hidden = false;
    button.style.visibility = show ? 'visible' : 'hidden';
    if (show) {
      button.textContent = label;
      button.onclick = onclick;
    }
  };
  const liveIds = liveMembers.map((member) => member.assetId);
  const keepable = Boolean(best) && liveMembers.length >= 2 && state.view !== 'decided';
  // Keep-best acts on the SNAPSHOT (the ★ and members on screen), not on the
  // best row's own annotation — an append may have refreshed that row with a
  // regenerated stack whose membership or pick differs from this view.
  headButton('bbKeepBest', keepable, `★ (K)eep best, skip ${liveMembers.length - 1}`, () =>
    keepBest({ burstBestAssetId: best.assetId, burstAssetIds: liveIds }));
  // Whole-group decisions: handy when a Should Review / Unlikely stack is
  // uniformly good or uniformly skippable.
  const bulkable = liveMembers.length >= 2 && state.view !== 'decided';
  headButton('bbYesAll', bulkable, `Yes to all ${liveIds.length}`, () => decide('approve', liveIds));
  headButton('bbSkipAll', bulkable, `Skip all ${liveIds.length}`, () => decide('reviewed', liveIds));
  el('bbGrid').replaceChildren(
    ...members.map((member) => renderBurstCell(member, member === best, !live.has(member.assetId))),
  );
}

function renderBurstCell(asset, isBest, decided = false) {
  const cell = document.createElement('div');
  cell.className = `bb-cell ${isBest ? 'best' : ''} ${decided ? 'decided' : ''}`;
  const img = document.createElement('img');
  img.loading = 'lazy';
  img.alt = '';
  img.src = `/api/review/thumbnail/${encodeURIComponent(asset.assetId)}`;
  if (!decided) {
    img.title = 'Click to zoom';
    img.addEventListener('click', () => openLightbox(state.assets.findIndex((a) => a.assetId === asset.assetId)));
  }
  cell.append(img);
  const refereed = asset.burstPickSource === 'referee';
  if (isBest) {
    const badge = document.createElement('span');
    badge.className = `p-badge ${refereed ? 'gold' : 'silver'}`;
    badge.textContent = '★ best';
    badge.title = refereed
      ? 'The AI referee compared this group side by side and picked this photo'
      : 'Highest frame-worthy score in this group';
    cell.append(badge);
  }
  if (decided) {
    const badge = document.createElement('span');
    badge.className = 'p-badge';
    // Stubs from earlier sessions carry their outcome; photos decided
    // moments ago in THIS compare session just say decided.
    const outcome = { approved: '✓ kept', reviewed: 'skipped', rejected: 'never show' }[asset.decidedState];
    badge.textContent = outcome ?? '✓ decided';
    cell.append(badge);
  }
  const body = document.createElement('div');
  body.className = 'bb-body';
  const file = document.createElement('div');
  file.className = 'card-file';
  file.title = asset.originalPath || '';
  file.textContent = asset.filename || asset.assetId;
  body.append(file, scoreBar(asset.frameScore));
  if (state.view !== 'decided' && !decided) {
    body.append(cardActions(asset, { reserveKeepBest: true }));
  }
  // The referee's why-line: its short per-photo verdict, plus an explicit
  // flag when it spotted closed eyes. Below the buttons so note length
  // never shifts the buttons out of line across cells.
  if (asset.refereeNote || asset.refereeEyesClosed === 'yes') {
    const why = document.createElement('div');
    why.className = 'bb-why';
    if (asset.refereeEyesClosed === 'yes') {
      const eyes = document.createElement('span');
      eyes.className = 'p-chip warn';
      eyes.textContent = 'eyes closed';
      why.append(eyes);
    }
    if (asset.refereeNote) {
      const note = document.createElement('span');
      note.textContent = asset.refereeNote;
      note.title = asset.refereeNote;
      why.append(note);
    }
    body.append(why);
  }
  cell.append(body);
  return cell;
}

// ---------- Referee status strip ----------
// The referee is Curate's background worker, so its progress lives here:
// a one-line strip above the grid, only when the referee is enabled.
// The bar is scoped to the current RUN — stacks judged since the queue was
// last empty vs what's still queued — because a bar over all-time history
// sits pinned at ~100% forever. The lifetime total rides along as a quiet
// suffix instead.
function agoText(iso) {
  const t = iso ? new Date(iso).getTime() : NaN;
  if (Number.isNaN(t)) return null;
  const mins = Math.floor((Date.now() - t) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

// While an enrichment run streams photos into Curate, stacks regroup as
// members arrive — this note sets that expectation right where the
// counts change. Fed by every assets fetch (instant on load/append) and by
// the 30s referee-status poll (tracks run start/stop while the user only
// looks); both payloads carry enrichRunning.
function setEnrichNote(running) {
  el('metaEnrich').hidden = !running;
}

async function loadRefereeStrip() {
  try {
    const res = await fetch('/api/review/referee/status', { cache: 'no-store' });
    if (!res.ok) throw new Error(String(res.status));
    const st = await res.json();
    setEnrichNote(st.enrichRunning);
    const strip = el('refStrip');
    if (!st.enabled) { strip.hidden = true; return; }
    strip.hidden = false;
    const remaining = typeof st.remaining === 'number' ? st.remaining : null;
    const batchDone = typeof st.batchDone === 'number' ? st.batchDone : 0;
    const runTotal = remaining === null ? null : batchDone + remaining;
    const parts = ['AI referee'];
    if (remaining !== null && remaining > 0) {
      parts.push(`${batchDone} of ${runTotal} stack${runTotal === 1 ? '' : 's'} in current batch`);
    }
    let dot = '';
    if (st.paused && st.working) {
      dot = 'warn';
      parts.push('pausing — finishing the stack being judged, then stopping');
    } else if (st.paused) {
      parts.push('paused — not using the AI model until you resume');
    } else if (st.lastError) {
      dot = 'bad';
      parts.push(`retrying after an error: ${st.lastError}`);
    } else if (st.working) {
      dot = 'ok';
      const mins = st.currentForMs ? Math.floor(st.currentForMs / 60000) : 0;
      const elapsed = st.currentForMs ? (mins >= 1 ? ` · ${mins}m` : ' · <1m') : '';
      parts.push((st.currentSize ? `judging a ${st.currentSize}-photo stack` : 'judging a stack') + elapsed);
    } else if (st.yielding) {
      dot = 'warn';
      parts.push('waiting while enrichment runs');
    } else if (remaining === 0 && !(st.deferredGroups > 0)) {
      dot = 'ok';
      const ago = agoText(st.lastRefereedAt);
      parts.push(ago ? `all caught up · last judged ${ago}` : 'all caught up');
    }
    // Deferred stacks are still-pending work, not "caught up": too big for
    // the photo byte budget even at thumbnail size. Details in Activity.
    if (st.deferredGroups > 0) {
      if (!dot) dot = 'warn';
      parts.push(`${st.deferredGroups} stack${st.deferredGroups === 1 ? '' : 's'} deferred — over the photo byte budget (see Activity)`);
    }
    const allTime = st.groups ?? 0;
    parts.push(`${allTime.toLocaleString()} stack${allTime === 1 ? '' : 's'} judged all-time`);
    el('refDot').className = `p-dot ${dot}`.trim();
    el('refLine').textContent = parts.join(' · ');
    el('refPause').textContent = st.paused ? 'Resume' : 'Pause';
    refPausedNow = Boolean(st.paused);
    // The bar exists only while there is a live queue to drain.
    if (remaining !== null && remaining > 0 && runTotal > 0) {
      el('refProgress').hidden = false;
      el('refBar').style.width = `${Math.min(100, Math.round((batchDone / runTotal) * 100))}%`;
      el('refBarText').textContent = `${batchDone.toLocaleString()} / ${runTotal.toLocaleString()}`;
    } else {
      el('refProgress').hidden = true;
    }
  } catch {
    el('refStrip').hidden = true;
  }
}
let refPausedNow = false;
el('refPause').addEventListener('click', async () => {
  const btn = el('refPause');
  btn.disabled = true;
  try {
    const res = await fetch('/api/review/referee/pause', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paused: !refPausedNow }),
      cache: 'no-store',
    });
    if (!res.ok) throw new Error(String(res.status));
  } catch {
    // The next poll re-syncs the label either way.
  } finally {
    btn.disabled = false;
    loadRefereeStrip();
  }
});

loadRefereeStrip();
setInterval(() => { if (!document.hidden) loadRefereeStrip(); }, 30000);

// Activity popup: recent verdicts (from the durable tables) interleaved
// with recent errors (in-memory, since the last restart).
async function openRefereeActivity() {
  const list = el('refActList');
  list.replaceChildren();
  el('refActPop').hidden = false;
  try {
    const res = await fetch('/api/review/referee/activity', { cache: 'no-store' });
    const data = await res.json();
    const events = [
      ...(data.groups ?? []).map((g) => ({ at: g.refereedAt, kind: 'group', g })),
      ...(data.errors ?? []).map((e) => ({ at: e.at, kind: 'error', e })),
    ].sort((a, b) => String(b.at).localeCompare(String(a.at)));
    if (events.length === 0) {
      const none = document.createElement('div');
      none.className = 'none';
      none.textContent = 'Nothing yet — verdicts and errors will appear here as the referee works.';
      list.append(none);
      return;
    }
    for (const ev of events.slice(0, 30)) {
      const row = document.createElement('div');
      row.className = `row ${ev.kind === 'error' ? 'err' : ''}`;
      const when = document.createElement('span');
      when.className = 'when';
      const d = new Date(ev.at);
      when.textContent = Number.isNaN(d.getTime()) ? '—' : d.toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' });
      const what = document.createElement('span');
      what.className = 'what';
      if (ev.kind === 'group') {
        const secs = ev.g.durationMs ? `${Math.round(ev.g.durationMs / 1000)}s` : null;
        const bits = [`judged a ${ev.g.memberCount}-photo stack`];
        if (ev.g.subjects > 1) bits.push(`split into ${ev.g.subjects} subjects`);
        if (secs) bits.push(secs);
        if (ev.g.model) bits.push(ev.g.model);
        what.textContent = bits.join(' · ');
      } else {
        what.textContent = ev.e.message;
      }
      row.append(when, what);
      list.append(row);
    }
  } catch {
    const none = document.createElement('div');
    none.className = 'none';
    none.textContent = 'Could not load activity.';
    list.append(none);
  }
}
el('refActivity').addEventListener('click', openRefereeActivity);
el('refActClose').addEventListener('click', () => { el('refActPop').hidden = true; });
el('refActPop').addEventListener('click', (e) => { if (e.target === el('refActPop')) el('refActPop').hidden = true; });

// ---------- Sync + enrichment ----------
function renderSync(sync) {
  const pill = el('syncPill');
  if (!sync) return;
  const dead = sync.dead ?? 0;
  pill.onclick = null;
  pill.style.cursor = '';
  pill.title = '';
  if (dead > 0) {
    pill.hidden = false;
    pill.className = 'p-chip danger';
    pill.textContent = `Immich sync: ${dead} job${dead === 1 ? '' : 's'} parked after repeated failures — click to retry`;
    pill.style.cursor = 'pointer';
    pill.title = 'These decisions could not reach Immich (e.g. a deleted photo). Retrying re-queues them.';
    pill.onclick = async () => {
      try {
        const result = await api('/api/review/sync-dead/retry', { method: 'POST', body: '{}' });
        toast(`Re-queued ${result.requeued} sync job${result.requeued === 1 ? '' : 's'}.`);
        renderSync(result.sync);
      } catch (error) {
        toast(error?.message || String(error), true);
      }
    };
  } else if (sync.lastError) {
    pill.hidden = false;
    pill.className = 'p-chip danger';
    pill.textContent = `Immich sync retrying: ${sync.lastError.slice(0, 80)}`;
  } else if (sync.pending > 0) {
    pill.hidden = false;
    pill.className = 'p-chip accent';
    pill.textContent = `Syncing to Immich · ${sync.pending}`;
  } else {
    pill.hidden = true;
  }
  if (sync.pending > 0 && !state.syncPolling) {
    state.syncPolling = setInterval(async () => {
      try {
        const status = await api('/api/review/sync-status');
        renderSync(status);
        if (!status.pending && !status.lastError && !(status.dead ?? 0)) {
          clearInterval(state.syncPolling);
          state.syncPolling = null;
        }
      } catch {
        clearInterval(state.syncPolling);
        state.syncPolling = null;
      }
    }, 2500);
  }
}

function loadAssetsFresh() {
  state.offset = 0;
  loadAssets(false);
}

// ---------- Wiring ----------
el('search').addEventListener('input', () => {
  state.q = el('search').value;
  clearTimeout(el('search')._timer);
  el('search')._timer = setTimeout(loadAssetsFresh, 200);
});
el('loadMore').addEventListener('click', () => loadAssets(true));
document.querySelectorAll('#groupFilter .p-tab').forEach((button) => {
  button.addEventListener('click', () => {
    if (state.group === button.dataset.group) return;
    state.group = button.dataset.group;
    document.querySelectorAll('#groupFilter .p-tab').forEach((b) => b.classList.toggle('active', b === button));
    loadAssetsFresh();
  });
});
el('selectVisible').addEventListener('change', () => {
  const check = el('selectVisible').checked;
  for (const asset of state.assets) check ? state.selected.add(asset.assetId) : state.selected.delete(asset.assetId);
  for (const box of grid.querySelectorAll('.card-check')) {
    box.checked = check;
    box.closest('.p-card').classList.toggle('selected', check);
  }
  updateBulkbar();
});
document.querySelectorAll('[data-bulk]').forEach((button) => {
  button.addEventListener('click', () => decide(button.dataset.bulk, [...state.selected]));
});
function setConnected(connected) {
  el('connStatus').hidden = !connected;
}

function requirePassword() {
  el('connStatus').hidden = true;
  window.pictariaGate.show();
}

el('lbClose').addEventListener('click', closeLightbox);
el('lightbox').addEventListener('click', (event) => {
  if (event.target === el('lightbox') || event.target.classList.contains('lb-stage')) closeLightbox();
});
document.querySelectorAll('[data-lb]').forEach((button) => {
  button.addEventListener('click', () => lightboxDecide(button.dataset.lb));
});
// #lbKeepBest has no data-lb (its action is keepBest, not a plain decision),
// so it needs its own wiring — the K shortcut goes through the same handler.
el('lbKeepBest').addEventListener('click', lightboxKeepBest);
el('bbClose').addEventListener('click', closeBurstbox);
el('burstbox').addEventListener('click', (event) => {
  if (event.target === el('burstbox')) closeBurstbox();
});

document.addEventListener('keydown', (event) => {
  if (event.target.tagName === 'INPUT') return;
  if (event.key === 'Escape') {
    // Innermost layer first: lightbox above compare view above the grid.
    if (state.lightboxIndex !== -1) closeLightbox();
    else if (state.compareBurstId) closeBurstbox();
    return;
  }
  if (state.lightboxIndex === -1) {
    // Compare view open, no lightbox: K keeps the group's best (B = legacy alias).
    if (
      state.compareBurstId &&
      ['k', 'b'].includes(event.key.toLowerCase()) &&
      el('bbKeepBest').style.visibility === 'visible'
    ) {
      el('bbKeepBest').click();
    }
    return;
  }
  // Primary keys match the button labels: (F)av (Y)es (S)kip (N)o (K)eep best.
  // a/r/v/b stay as silent legacy aliases.
  const keys = { a: 'approve', y: 'approve', r: 'reject', n: 'reject', f: 'favorite', s: 'reviewed', v: 'reviewed' };
  if (event.key === 'ArrowRight') lightboxStep(1);
  else if (event.key === 'ArrowLeft') lightboxStep(-1);
  else if (event.key.toLowerCase() === 'k' || event.key.toLowerCase() === 'b') lightboxKeepBest();
  else if (keys[event.key.toLowerCase()]) lightboxDecide(keys[event.key.toLowerCase()]);
});

let toastTimer = null;
function toast(message, isError = false) {
  const node = el('toast');
  node.textContent = message;
  node.className = `p-toast visible ${isError ? 'error' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove('visible'), 2400);
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

async function boot() {
  await loadAssets(false);
}

boot();
