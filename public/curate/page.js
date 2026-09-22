import { CurateClient, request, decisionSummary } from './client.js';
import { node, thumbnail, photoCard, groupCard, similarityLabel, similarityIndicator } from './photos.js';

const el = (id) => document.getElementById(id);
const client = new CurateClient();
const SORT_PREFERENCE = 'pictaria.curate.sort';
const state = {
  section: 'pending', category: 'all', selected: new Set(), removed: new Map(),
  viewerMode: 'stack', actionContext: null,
  kind: 'all',
  search: '',
  sort: 'oldest',
  view: null,
  groups: [],
  next: null,
  loading: false,
  comparison: null,
  outcomes: {},
  busy: false,
  undo: null,
  syncId: null,
  correctionNext: null,
  photoIndex: 0,
  photoList: [],
  dialogGeneration: 0,
  openFailed: false,
  syncKind: null,
};
let failedPreviews = new Set();
const cards = new Map(), visibleCards = new Set();
const visibility = new IntersectionObserver(entries => {
  for (const entry of entries) {
    const id = entry.target.dataset.groupId;
    entry.isIntersecting ? visibleCards.add(id) : visibleCards.delete(id);
  }
});
function makeCard(group) {
  const card = groupCard(group, g => run(() => compare(g)), {
    decide: (g, outcome) => run(() => quickDecision([g], outcome)),
    select: (g, checked) => { checked ? state.selected.add(g.id) : state.selected.delete(g.id); bulkSelection(); },
    selected: state.selected.has(group.id), decided: state.section === 'decided',
  });
  cards.set(group.id, card);
  visibility.observe(card);
  return card;
}

function error(error) {
  const target = el('photo-view').open ? el('photo-error') : el('comparison').open
    ? el('comparison-error')
    : el('correction-dialog').open
      ? el('correction-error')
      : el('error');
  target.textContent = error.message || String(error);
  target.hidden = false;
  if (el('comparison').open && !state.comparison) {
    state.openFailed = true;
    el('comparison-state').textContent = '';
  }
  el('comparison-refresh').hidden = !el('comparison').open || Boolean(client.saved.pending);
  el('photo-refresh').hidden = !el('photo-view').open || Boolean(client.saved.pending);
  recovery();
}
function clearErrors() {
  for (const id of ['error', 'comparison-error', 'correction-error', 'photo-error']) {
    el(id).hidden = true;
    el(id).textContent = '';
  }
  el('comparison-refresh').hidden = el('photo-refresh').hidden = true;
}
function run(work) {
  return Promise.resolve().then(work).catch(error);
}
function recovery() {
  el('recovery').hidden = el('photo-recovery').hidden = !client.saved.pending;
  el('photo-retry').disabled = state.busy;
  el('comparison-recovery').hidden = !client.saved.pending;
  el('correction-recovery').hidden = !client.saved.pending;
  el('comparison-retry').disabled = state.busy;
  el('retry-action').disabled = state.busy;
  const locked = state.busy || Boolean(client.saved.pending);
  el('refresh').disabled = locked || state.loading;
  el('show-updates').disabled = locked || state.loading;
  el('search').disabled = locked || state.loading;
  el('sort').disabled = el('category').disabled = locked || state.loading;
  el('corrections').disabled = locked;
  el('more').disabled = locked || state.loading;
  for (const button of document.querySelectorAll('#filters button, #sections button, .group-card button, .group-card input'))
    button.disabled = locked || state.loading;
  for (const input of document.querySelectorAll('#photos [data-keeper], .compare-tools button'))
    input.disabled = locked || !state.comparison || state.comparison.oversized;
  el('undo').disabled = locked;
  selection();
  syncViewer();
  bulkSelection();
}
function selection() {
  const values = Object.values(state.outcomes),
    keep = values.filter((v) => ['approve', 'favorite'].includes(v)).length;
  el('selection-count').textContent = values.length > 1 ? `${keep} of ${values.length} selected to keep` : '';
  el('apply').textContent = state.comparison
    ? decisionSummary(state.outcomes)
    : state.openFailed
      ? 'Refresh to continue'
      : 'Loading comparison…';
  el('apply').classList.toggle('primary', keep > 0);
  if (state.comparison?.oversized) el('apply').textContent = 'Comparison too large';
  el('apply').disabled =
    !state.comparison ||
    state.busy ||
    Boolean(client.saved.pending) ||
    state.comparison.oversized ||
    failedPreviews.size > 0;
}
function closeComparison() {
  state.dialogGeneration++;
  el('photo-view').close();
  el('comparison').close();
  state.comparison = null;
}
async function refresh() {
  if (state.busy || client.saved.pending) return;
  state.loading = true;
  closeComparison();
  clearErrors();
  recovery();
  try {
    const view = await client.open({ kind: state.kind, search: state.search, sort: state.sort, section: state.section, category: state.category });
    state.selected.clear(); state.removed.clear();
    state.view = view;
    state.groups = view.groups;
    state.next = view.nextOffset;
    visibility.disconnect(); visibleCards.clear(); cards.clear();
    el('groups').replaceChildren(...view.groups.map(makeCard));
    showViewStatus(view);
    el('empty').hidden = view.total !== 0;
    el('more').hidden = state.next === null;
    setControls(view);
  } finally {
    state.loading = false;
    recovery();
  }
}
function showViewStatus(view) {
  el('count').textContent = `${state.groups.length} of ${Math.max(0, view.total - state.removed.size)} ${state.section === 'decided' ? 'photos' : 'cards'} shown`;
  el('count').title = 'Each stack is one card. Its full photo count appears on the card.';
  el('updates').hidden = !view.updatesAvailable;
  const refinement = view.refinement;
  el('updates-copy').textContent = refinement?.ready
    ? 'Updated grouping is ready for the highlighted cards.'
    : 'Photo information changed. Refresh to load the latest.';
  el('show-updates').textContent = refinement?.ready ? 'Show updated stacks' : 'Refresh photos';
  const metadata = view.metadata;
  if (state.view?.viewId === view.viewId) state.view.metadata = metadata;
  if (state.comparison) el('metadata-retry').hidden = !metadata?.problem;
  el('metadata').textContent = metadata?.problem
    ? `Photo information refresh paused: ${metadata.problem}`
    : metadata?.state === 'refreshing'
      ? 'Refreshing photo information from Immich. Your open view stays in place.'
      : '';
  el('metadata').hidden = !el('metadata').textContent;
  el('refinement').textContent = refinement?.problem ||
    (refinement?.pending || refinement?.limited
      ? `Similarity checks: ${refinement.checkedGroups} of ${refinement.totalGroups} nearby groups finished. ` +
        (refinement.limited ? 'Some are waiting for a check slot. ' : '') +
        'Marked cards may regroup. You can review other photos while you wait.' : '');
  el('refinement').hidden = !el('refinement').textContent;
  for (const group of view.groups) {
    cards.get(group.id)?.updateSimilarity(group.similarity);
    if (state.comparison?.groupId === group.id) showComparisonSimilarity(group.similarity);
  }
}
function showComparisonSimilarity(status) {
  const text = similarityLabel(status);
  const indicator = similarityIndicator(status);
  const signature = JSON.stringify(status);
  if (el('comparison-similarity').dataset.status === signature) {
    el('comparison-similarity').hidden = !text;
    return;
  }
  el('comparison-similarity').dataset.status = signature;
  el('comparison-similarity').replaceChildren(...(indicator ? [indicator] : []), node('span', text + (status?.state === 'updated'
    ? '. Close this comparison and use Show updated stacks when you’re ready.'
    : text && (status.uncertain || status.state !== 'checked') ? '. This grouping is provisional.' : '')));
  el('comparison-similarity').hidden = !text;
}
async function more() {
  if (state.next === null || state.loading || client.saved.pending) return;
  state.loading = true;
  recovery();
  try {
    const page = await client.page(state.view.viewId, state.next);
    page.groups = page.groups.filter(g => !state.removed.has(g.id));
    state.groups.push(...page.groups);
    state.next = page.nextOffset;
    el('groups').append(...page.groups.map(makeCard));
    showViewStatus(page);
    el('more').hidden = state.next === null;
  } finally {
    state.loading = false;
    recovery();
  }
}
async function compare(group) {
  if (state.busy || client.saved.pending) return;
  clearErrors();
  const generation = ++state.dialogGeneration;
  state.viewerMode = group.memberCount === 1 ? 'single' : 'stack';
  state.comparison = null;
  state.outcomes = {};
  state.openFailed = false;
  failedPreviews = new Set();
  el('preview-errors').hidden = true;
  el('comparison-title').textContent = group.memberCount > 1 ? 'Compare stack' : 'Review photo';
  el('comparison-subtitle').textContent =
    `${group.memberCount} ${group.memberCount === 1 ? 'photo' : 'photos'} in this comparison`;
  el('comparison-help').textContent =
    group.memberCount > 1
      ? 'Click a photo to enlarge it. Select Keep beneath each photo you want. The rest will be marked reviewed when you save.'
      : 'Choose whether to keep this photo. Mark reviewed leaves it out of your keepers without deleting it or marking it Never show.';
  el('select-all').hidden = el('select-none').hidden = el('split').hidden = group.memberCount < 2;
  el('compact-label').hidden = group.memberCount <= 10;
  el('compact').checked = group.memberCount > 10;
  el('photos').classList.toggle('compact', el('compact').checked);
  el('comparison-state').textContent = 'Loading the complete comparison…';
  el('comparison-similarity').hidden = true;
  el('metadata-retry').hidden = true;
  el('photos').replaceChildren();
  el('stack-reason').hidden = true;
  el('stack-reason').open = false;
  el('context').hidden = true;
  el('comparison').showModal();
  recovery();
  const comparison = await client.comparison(state.view.viewId, group.id);
  if (generation !== state.dialogGeneration || !el('comparison').open) return;
  state.comparison = comparison;
  showComparisonSimilarity(comparison.similarity);
  el('stack-reason').hidden = false;
  el('stack-reason').querySelector('summary').textContent = group.memberCount > 1 ? 'Why this stack?' : 'Why this photo is separate';
  el('stack-algorithm').textContent = /^candidate-\d+$/.test(comparison.algorithm)
    ? `Candidate algorithm ${comparison.algorithm.split('-')[1]} · no AI stack check` : 'Grouping from this saved view';
  el('stack-reasons').replaceChildren(...(comparison.reasons ?? []).map(reason => node('li', reason)));
  state.outcomes = comparison.oversized ? {} : Object.fromEntries(comparison.ids.map((id) => [id, 'reviewed']));
  state.photoList = [...comparison.photos, ...comparison.context];
  el('comparison-state').textContent = comparison.oversized
    ? 'This group exceeds the 1,000-photo decision limit. Only the first 50 previews are shown; decisions and corrections are disabled. Turn off stacks in Settings to review these photos individually.'
    : comparison.photos.some((p) => !p.metadata.checkedAt || p.metadata.outcome !== 'refreshed')
      ? 'Some photo information is awaiting refresh. You can still make a manual choice; changed inputs will require a refresh before saving.'
      : '';
  el('metadata-retry').hidden = !state.view.metadata?.problem;
  el('photos').replaceChildren(
    ...comparison.photos.map((photo) =>
      photoCard(photo, {
        outcome: () => state.outcomes[photo.id] || 'reviewed',
        change: (value) => setOutcome(photo.id, value),
        imageState: (ok) => {
          if (state.comparison !== comparison) return;
          ok ? failedPreviews.delete(photo.id) : failedPreviews.add(photo.id);
          el('preview-errors').hidden = !failedPreviews.size;
          selection();
        },
        open: showPhoto,
      }),
    ),
  );
  el('split').hidden = comparison.ids.length < 2;
  el('context').hidden = !comparison.context.length;
  el('context-omitted').hidden = !comparison.contextOmitted;
  el('context-photos').replaceChildren(
    ...comparison.context.map((photo) => photoCard(photo, { readOnly: true, open: showPhoto })),
  );
  recovery();
  if (state.viewerMode === 'single') { el('comparison').close(); showPhoto(comparison.photos[0]); }
}
function showPhoto(photo) {
  if (!photo) return;
  state.photoIndex = state.photoList.findIndex((p) => p.id === photo.id);
  el('photo-title').textContent = photo.filename;
  el('photo-large').src = thumbnail(photo.id);
  el('photo-large').alt = photo.caption || photo.filename;
  el('photo-caption').textContent = photo.caption || '';
  el('photo-date').textContent = photo.capturedAt ? new Date(photo.capturedAt).toLocaleString() : '';
  el('photo-score').textContent = Number.isFinite(photo.frameScore) ? `Enrichment score: ${photo.frameScore.toFixed(2)}` : '';
  el('photo-model').hidden = true;
  el('photo-image-error').hidden = true;
  el('photo-tags').replaceChildren(...(photo.tags || []).map((tag) => node('span', tag)));
  const references = state.viewerMode === 'single' ? state.comparison.context : [];
  el('photo-context').hidden = !references.length;
  el('photo-context-images').replaceChildren(...references.map(reference => {
    const button = node('button', undefined, 'reference-photo');
    const img = node('img'); img.src = thumbnail(reference.id); img.alt = reference.caption || reference.filename;
    button.setAttribute('aria-label', `Inspect already kept photo: ${reference.filename}`);
    button.append(img); button.onclick = () => showPhoto(reference); return button;
  }));
  const base = state.view?.immichUrl;
  el('immich').hidden = !base;
  if (base) el('immich').href = `${base.replace(/\/$/, '')}/photos/${encodeURIComponent(photo.id)}`;
  el('photo-prev').disabled = state.photoIndex <= 0;
  el('photo-next').disabled = state.photoIndex >= state.photoList.length - 1;
  if (!el('photo-view').open) el('photo-view').showModal();
  syncViewer();
  fullCaption(photo);
}
async function fullCaption(photo) {
  try {
    const response = await fetch(`/api/enrich/caption?assetId=${encodeURIComponent(photo.id)}`);
    if (!response.ok) return;
    const info = await response.json();
    if (!el('photo-view').open || state.photoList[state.photoIndex] !== photo) return;
    if (info.caption) el('photo-caption').textContent = info.caption;
    el('photo-model').textContent = info.model ? `Enriched by ${info.provider || ''} · ${info.model}${info.profile ? ` · ${info.profile.name}` : ''}` : '';
    el('photo-model').hidden = !info.model;
  } catch { /* The saved caption remains available. */ }
}
function setOutcome(id, value) {
  if (
    state.busy ||
    client.saved.pending ||
    !state.comparison ||
    state.comparison.oversized ||
    !Object.hasOwn(state.outcomes, id)
  )
    return;
  state.outcomes[id] = value;
  repaintSelection();
  syncViewer();
}
function syncViewer() {
  const photo = state.photoList[state.photoIndex];
  const actionable = Boolean(
    state.comparison && !state.comparison.oversized && photo && Object.hasOwn(state.outcomes, photo.id),
  );
  const single = state.viewerMode === 'single';
  const at = state.groups.findIndex(g => g.id === state.comparison?.groupId);
  el('photo-position').textContent = single ? `${at + 1} of ${state.groups.length} shown cards`
    : `${state.photoIndex + 1} of ${state.photoList.length} photos`;
  el('single-actions').hidden = !single || !actionable;
  el('stack-actions').hidden = single || !actionable;
  el('photo-secondary').hidden = el('photo-keep').hidden = single || !actionable;
  el('photo-readonly').hidden = actionable;
  el('photo-readonly').textContent = photo?.state === 'approved' ? 'Already kept · reference only' : 'Decision unavailable for this comparison';
  el('back-pending-photo').hidden = !single || actionable;
  el('photo-reason').hidden = !single || !actionable || state.section === 'decided';
  el('photo-reasons').replaceChildren(...(state.comparison?.reasons ?? []).map(reason => node('li', reason)));
  const locked = state.busy || state.loading || Boolean(client.saved.pending) || state.comparison?.oversized;
  for (const control of document.querySelectorAll('#photo-keep, #photo-outcome, #photo-remove, [data-photo-action]'))
    control.disabled = locked || !actionable;
  el('photo-prev').disabled = locked || (single ? !actionable || at <= 0 : state.photoIndex <= 0);
  el('photo-next').disabled = locked || (single ? !actionable || at < 0 || at >= state.groups.length - 1 && state.next === null : state.photoIndex >= state.photoList.length - 1);
  for (const button of el('photo-context').querySelectorAll('button')) button.disabled = locked;
  el('back-pending-photo').disabled = locked;
  el('photo-keys').hidden = !actionable;
  el('photo-keys').textContent = single
    ? 'Y keep · F favorite · S reviewed · N never show · Z undo · ← → browse · Esc close. Decisions save immediately.'
    : 'K toggles Keep · ← → browse · Esc returns to comparison. Save your choices there.';
  el('photo-receipt').hidden = !state.undo;
  el('photo-receipt-text').textContent = el('receipt-text').textContent;
  el('photo-undo').disabled = locked || !state.undo;
  if (!actionable) return;
  const value = state.outcomes[photo.id],
    keep = ['approve', 'favorite'].includes(value);
  el('photo-keep').setAttribute('aria-pressed', String(keep));
  el('photo-keep').classList.toggle('primary', keep);
  el('photo-keep').textContent = keep ? '✓ Keep (K)' : 'Keep (K)';
  el('photo-outcome').value = value;
  el('photo-remove').hidden = state.comparison.ids.length < 2;
}
async function action(work, context = null) {
  if (state.busy || client.saved.pending) return;
  state.busy = true;
  state.actionContext = context || (state.comparison ? { ids: [...state.comparison.ids] } : null);
  clearErrors();
  recovery();
  try {
    await accepted(await work());
  } finally {
    state.busy = false;
    recovery();
  }
}
async function accepted({ kind, result }) {
  const context = state.actionContext;
  const undoContext = kind === 'undo' ? state.undo?.ui : null;
  const previousGroup = state.comparison?.groupId;
  const index = state.groups.findIndex(g => g.id === previousGroup);
  closeComparison();
  el('correction-dialog').close();
  state.undo = null;
  let correctionMessage = 'Stack correction saved. Keeper decisions are unchanged.';
  state.syncId = result.operationId || null;
  state.syncKind = kind;
  if (result.undo)
    state.undo = {
      kind: 'undo',
      body: { operationId: result.undo.operationId, kind: 'undo', targetOperationId: result.undo.targetOperationId },
      until: result.undo.expiresAt,
      ui: context,
    };
  if (kind === 'separation') {
    // A replayed receipt describes creation, not the correction's current state.
    const { correction } = await request(`separations?id=${encodeURIComponent(result.id)}`).catch(() => ({
      correction: null,
    }));
    if (!correction) correctionMessage = 'Stack correction recorded. Check Stack corrections for its current status.';
    else if (!correction.active)
      correctionMessage = 'This stack correction has since been reset. Keeper decisions are unchanged.';
    if (correction?.active && correction.revision === result.revision)
      state.undo = {
        kind: 'reset',
        body: { id: correction.id, revision: correction.revision, undo: true },
        until: result.undoUntil,
      };
  }
  el('receipt-text').textContent = result.savedLocally
    ? `${kind === 'undo' ? 'Undid' : 'Saved'} choices for ${result.assetCount} ${result.assetCount === 1 ? 'photo' : 'photos'}.`
    : kind === 'separation'
      ? correctionMessage
      : 'Stack correction reset. Keeper decisions are unchanged.';
  el('receipt').hidden = false;
  el('sync').textContent = result.savedLocally
    ? kind === 'undo'
      ? 'Syncing Undo to Immich…'
      : 'Syncing to Immich…'
    : '';
  el('retry-sync').hidden = true;
  el('undo').hidden = !state.undo || state.undo.until <= Date.now();
  // The accepted result is shown before refreshing, so a failed read cannot
  // turn a saved action into an apparent failure or a second operation.
  state.busy = false;
  if (state.view && kind === 'decision' && context?.ids && state.section === 'pending') {
    const ids = new Set(context.ids);
    const removed = state.groups.map((group,index) => ({group,index})).filter(({group}) => ids.has(group.photos[0].id));
    if (state.undo) state.undo.ui = { ...context, removed, viewId: state.view.viewId };
    for (const {group} of removed) { state.removed.set(group.id, group); state.selected.delete(group.id); }
    state.groups = state.groups.filter(g => !state.removed.has(g.id));
    renderGroups(); showViewStatus(state.view);
    if (context.advance) {
      if (index >= state.groups.length && state.next !== null) await more();
      if (state.groups[index]) await compare(state.groups[index]);
    }
  } else if (state.view && kind === 'undo' && undoContext?.removed && undoContext.viewId === state.view.viewId && state.section === 'pending') {
    for (const {group,index} of undoContext.removed) {
      if (state.removed.delete(group.id)) state.groups.splice(index,0,group);
    }
    renderGroups(); showViewStatus(state.view);
    if (undoContext.advance && undoContext.removed[0]) await compare(undoContext.removed[0].group);
  } else {
    await refresh().catch(error);
    if (context?.advance && state.section === 'decided') {
      const group = state.groups.find(g => context.ids.includes(g.photos[0].id));
      if (group) await compare(group);
    }
  }
  state.actionContext = null;

}
function renderGroups() {
  visibility.disconnect(); visibleCards.clear(); cards.clear();
  el('groups').replaceChildren(...state.groups.map(makeCard));
  el('empty').hidden = state.groups.length > 0 || state.next !== null;
  el('more').hidden = state.next === null;
  recovery();
}
function setControls(view) {
  for (const button of document.querySelectorAll('#sections button')) {
    const active = button.dataset.section === state.section;
    button.classList.toggle('active', active); button.setAttribute('aria-pressed', String(active));
  }
  for (const button of document.querySelectorAll('#filters button')) {
    const active = button.dataset.kind === state.kind;
    button.classList.toggle('active', active); button.setAttribute('aria-pressed', String(active));
  }
  el('filters').hidden = el('category-label').hidden = state.section === 'decided';
  el('empty').textContent = state.section === 'decided' ? 'No decided photos match this view.' : 'No pending photos match this view.';
  el('category').replaceChildren(new Option('All categories','all'), ...(view.categories || []).map(b => new Option(b.label,b.id)));
  el('category').value = state.category;
  bulkSelection();
}
function bulkSelection() {
  const singles = state.groups.filter(g => g.memberCount === 1);
  const locked = state.loading || state.busy || Boolean(client.saved.pending);
  el('bulk-label').hidden = state.section === 'pending' && state.kind === 'stacks';
  el('bulk-label-text').textContent = state.section === 'decided' || state.kind === 'singles' ? 'Select shown photos' : 'Select single photos';
  const count = singles.filter(g => state.selected.has(g.id)).length;
  el('select-shown').checked = count > 0 && count === singles.length;
  el('select-shown').indeterminate = count > 0 && count < singles.length;
  el('select-shown').disabled = locked || !singles.length;
  el('bulk-actions').hidden = count === 0;
  el('bulk-count').textContent = `${count} ${count === 1 ? 'photo' : 'photos'} selected`;
  for (const button of el('bulk-actions').querySelectorAll('button')) button.disabled = locked;
  for (const input of el('groups').querySelectorAll('[data-select]')) input.checked = state.selected.has(input.dataset.select);
}
function quickDecision(groups, outcome) {
  return action(async () => {
    const comparison = await request('selection', { viewId: state.view.viewId, groupIds: groups.map(g => g.id) });
    return client.decide(comparison.id, Object.fromEntries(comparison.ids.map(id => [id,outcome])));
  }, { ids: groups.map(g => g.photos[0].id) });
}
async function stepPhoto(delta) {
  if (state.busy || state.loading || client.saved.pending) return;
  if (state.viewerMode !== 'single') return showPhoto(state.photoList[state.photoIndex + delta]);
  const index = state.groups.findIndex(g => g.id === state.comparison?.groupId) + delta;
  if (index >= state.groups.length && state.next !== null) await more();
  const group = state.groups[index];
  if (group) { el('photo-view').close(); await compare(group); }
}
function decideSingle(outcome) {
  if (state.viewerMode !== 'single' || !state.comparison || state.comparison.ids.length !== 1 ||
      state.comparison.ids[0] !== state.photoList[state.photoIndex]?.id) return;
  const c = state.comparison;
  return action(() => client.decide(c.id, { [c.ids[0]]: outcome }), { ids: [...c.ids], advance: true });
}
async function changeFilter(patch) {
  if (state.busy || state.loading || client.saved.pending) return;
  const previous = { kind: state.kind, section: state.section, category: state.category, search: state.search };
  Object.assign(state,patch);
  try { await refresh(); }
  catch (e) { Object.assign(state,previous); if (state.view) setControls(state.view); el('search').value=state.search; throw e; }
}
function separate(partitions, actionDetails) {
  return action(() =>
    client.mutate(
      'separations',
      { comparisonId: state.comparison.id, partitions, action: actionDetails },
      'separation',
    ),
  );
}

async function corrections(append = false) {
  const page = await request(`separations?offset=${append ? state.correctionNext : 0}`);
  if (!append) el('correction-list').replaceChildren();
  for (const correction of page.corrections) {
    const row = node('div', undefined, 'correction-row');
    row.append(
      node(
        'strong',
        correction.action?.kind === 'remove'
          ? `${correction.action.photo.filename} removed from a stack of ${correction.memberCount}`
          : correction.action?.kind === 'split'
            ? `Split ${correction.memberCount} photos into singles`
            : `${correction.memberCount} photos separated`,
      ),
      node(
        'p',
        correction.photos.map((p) => p.filename).join(' · ') +
          (correction.memberCount > correction.photos.length ? ' · …' : ''),
        'p-muted',
      ),
    );
    const reset = node('button', `Reset correction for ${correction.memberCount} photos`, 'p-btn');
    reset.onclick = () =>
      run(() =>
        action(() => client.mutate('separations/reset', { id: correction.id, revision: correction.revision }, 'reset')),
      );
    row.append(reset);
    el('correction-list').append(row);
  }
  if (!el('correction-list').children.length)
    el('correction-list').append(node('p', 'No active stack corrections.', 'p-muted'));
  state.correctionNext = page.nextOffset;
  el('correction-more').hidden = page.nextOffset === null;
  if (!el('correction-dialog').open) el('correction-dialog').showModal();
}

el('refresh').onclick = () => run(refresh);
el('show-updates').onclick = () => run(refresh);
el('more').onclick = () => run(more);
el('sort').onchange = () =>
  run(async () => {
    if (state.busy || state.loading || client.saved.pending) return;
    const previous = state.sort;
    state.sort = el('sort').value;
    try {
      await refresh();
    } catch (e) {
      // Failed replacement leaves the displayed cards in their previous order.
      state.sort = previous;
      el('sort').value = previous;
      throw e;
    }
    try {
      localStorage.setItem(SORT_PREFERENCE, state.sort);
    } catch {
      /* Preference storage is optional. */
    }
  });
for (const button of document.querySelectorAll('#filters button')) button.onclick = () => run(() => changeFilter({ kind: button.dataset.kind }));
for (const button of document.querySelectorAll('#sections button')) button.onclick = () => run(() => changeFilter({ section: button.dataset.section }));
el('category').onchange = () => run(() => changeFilter({ category: el('category').value }));
let searchTimer;
el('search').oninput = () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => run(() => changeFilter({ search: el('search').value.trim() })),300);
};
el('select-shown').onchange = () => {
  for (const group of state.groups) if (group.memberCount === 1)
    el('select-shown').checked ? state.selected.add(group.id) : state.selected.delete(group.id);
  bulkSelection();
};
el('clear-bulk').onclick = () => { state.selected.clear(); bulkSelection(); };
for (const button of document.querySelectorAll('[data-bulk]')) button.onclick = () => run(() =>
  quickDecision(state.groups.filter(g => state.selected.has(g.id)),button.dataset.bulk));
el('select-all').onclick = () => {
  for (const id of state.comparison.ids) state.outcomes[id] = 'approve';
  repaintSelection();
};
el('select-none').onclick = () => {
  for (const id of state.comparison.ids) state.outcomes[id] = 'reviewed';
  repaintSelection();
};
function repaintSelection() {
  for (const card of el('photos').children) card.syncSelection();
  selection();
}
el('split').onclick = () =>
  run(() =>
    separate(
      state.comparison.ids.map((id) => [id]),
      { kind: 'split' },
    ),
  );
el('compact').onchange = () => el('photos').classList.toggle('compact', el('compact').checked);
el('apply').onclick = () => run(() => action(() => client.decide(state.comparison.id, { ...state.outcomes })));
el('retry-action').onclick = () =>
  run(async () => {
    if (state.busy) return;
    state.busy = true;
    clearErrors();
    recovery();
    try {
      const pending = client.saved.pending;
      state.actionContext ??= pending?.body?.outcomes ? { ids: Object.keys(pending.body.outcomes) } : null;
      await accepted(await client.retry());
    } finally {
      state.busy = false;
      recovery();
    }
  });
el('comparison-retry').onclick = () => el('retry-action').click();
el('comparison-refresh').onclick = () => run(refresh);
el('preview-retry').onclick = () => {
  for (const card of el('photos').children)
    if (failedPreviews.has(card.dataset.photoId)) {
      const img = card.querySelector('img');
      img.src = `${thumbnail(card.dataset.photoId)}?retry=${Date.now()}`;
    }
};
el('metadata-retry').onclick = () =>
  run(async () => {
    const comparison = state.comparison;
    el('metadata-retry').disabled = true;
    try {
      for (let offset = 0; offset < comparison.ids.length + comparison.contextIds.length; offset += 500)
        await request('metadata/refresh', { comparisonId: comparison.id, offset });
      el('comparison-state').textContent =
        'Photo information refresh requested. Refresh Curate when you’re ready to see any changes.';
    } finally {
      el('metadata-retry').disabled = false;
    }
  });
el('undo').onclick = () =>
  run(() =>
    action(() =>
      client.mutate(
        state.undo.kind === 'undo' ? 'operations/apply' : 'separations/reset',
        state.undo.body,
        state.undo.kind,
      ),
    ),
  );
el('retry-sync').onclick = () =>
  run(async () => {
    await request('operations/retry', { operationId: state.syncId });
    el('sync').textContent = state.syncKind === 'undo' ? 'Syncing Undo to Immich…' : 'Syncing to Immich…';
    el('retry-sync').hidden = true;
  });
el('corrections').onclick = () => run(() => corrections());
el('correction-more').onclick = () => run(() => corrections(true));
el('photo-prev').onclick = () => run(() => stepPhoto(-1));
el('photo-next').onclick = () => run(() => stepPhoto(1));
el('back-comparison').onclick = () => el('photo-view').close();
el('back-pending-photo').onclick = () => showPhoto(state.comparison?.photos[0]);
el('photo-undo').onclick = () => el('undo').click();
el('photo-retry').onclick = () => el('retry-action').click();
el('photo-refresh').onclick = () => run(refresh);
el('photo-large').onerror = () => { el('photo-image-error').hidden = false; };
for (const button of document.querySelectorAll('[data-photo-action]')) button.onclick = () => run(() => decideSingle(button.dataset.photoAction));
el('photo-keep').onclick = () => {
  const id = state.photoList[state.photoIndex]?.id;
  if (id) setOutcome(id, ['approve', 'favorite'].includes(state.outcomes[id]) ? 'reviewed' : 'approve');
};
el('photo-outcome').onchange = () => setOutcome(state.photoList[state.photoIndex].id, el('photo-outcome').value);
el('photo-remove').onclick = () =>
  run(() => {
    const id = state.photoList[state.photoIndex].id;
    el('photo-view').close();
    return separate([[id], state.comparison.ids.filter((member) => member !== id)], { kind: 'remove', assetId: id });
  });
for (const button of document.querySelectorAll('[data-close]')) button.onclick = () => el(button.dataset.close).close();
for (const dialog of document.querySelectorAll('dialog'))
  dialog.addEventListener('click', (e) => {
    const rect = dialog.getBoundingClientRect();
    if (
      e.target === dialog &&
      (e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom)
    )
      dialog.close();
  });
el('comparison').addEventListener('close', () => {
  // A queued close event may arrive after a new comparison has opened.
  if (!el('comparison').open && state.viewerMode !== 'single') state.dialogGeneration++;
});
document.addEventListener('keydown', (event) => {
  if (!el('photo-view').open || event.target.closest('input,select,textarea,[contenteditable=true]')) return;
  if (event.ctrlKey || event.metaKey || event.altKey || event.repeat) return;
  const key = event.key.toLowerCase();
  if (key === 'z' && state.undo && !el('photo-undo').disabled) { event.preventDefault(); el('photo-undo').click(); return; }
  const outcome = {y:'approve',a:'approve',f:'favorite',s:'reviewed',v:'reviewed',n:'reject',r:'reject'}[key];
  if (state.viewerMode === 'single' && outcome) { event.preventDefault(); run(() => decideSingle(outcome)); return; }
  if (event.key.toLowerCase() === 'k' && !el('photo-keep').hidden && !el('photo-keep').disabled) {
    event.preventDefault();
    el('photo-keep').click();
  }
  if (event.key === 'ArrowRight' && !el('photo-next').disabled) {
    event.preventDefault();
    el('photo-next').click();
  }
  if (event.key === 'ArrowLeft' && !el('photo-prev').disabled) {
    event.preventDefault();
    el('photo-prev').click();
  }
});
window.addEventListener('pagehide', () => client.channel?.close());
window.addEventListener('pageshow', (event) => {
  if (event.persisted) location.reload();
});

// Poll only status. Never replace displayed cards, membership or selection.
let polling = false;
setInterval(async () => {
  if (document.hidden || polling || state.loading || state.busy) return;
  polling = true;
  try {
    if (state.view) {
      const id = state.view.viewId;
      // Keep the visible cards (or the opened comparison) current, in a bounded
      // 50-card read. Only status changes; memberships and selections stay put.
      const index = state.comparison && el('comparison').open
        ? state.groups.findIndex(g => g.id === state.comparison.groupId)
        : state.groups.findIndex(g => visibleCards.has(g.id));
      const status = await client.page(id, Math.floor(Math.max(0, index) / 50) * 50, 50, {
        visibleGroupIds: [...visibleCards].slice(0, 50),
        comparisonGroupId: el('comparison').open ? state.comparison?.groupId ?? null : null,
      });
      if (state.view?.viewId === id) showViewStatus(status);
    }
    if (state.syncId) {
      const id = state.syncId;
      const status = await request(`operations/status?operationId=${encodeURIComponent(id)}`);
      if (state.syncId === id) {
        el('sync').textContent = {
          synced: state.syncKind === 'undo' ? 'Undo synced to Immich.' : 'Synced to Immich.',
          superseded: 'A newer decision replaced this one.',
          pending: `Syncing ${state.syncKind === 'undo' ? 'Undo ' : ''}to Immich · ${status.pending} remaining`,
          failed:
            state.syncKind === 'undo'
              ? 'Undone locally. Immich sync needs attention.'
              : 'Saved locally. Immich sync needs attention.',
        }[status.sync];
        el('retry-sync').hidden = status.sync !== 'failed';
      }
    }
    if (state.undo?.until <= Date.now()) {
      state.undo = null;
      el('undo').hidden = true;
      syncViewer();
    }
  } catch (e) {
    if (e.code === 'curate_expired') {
      el('updates').hidden = false;
      el('updates-copy').textContent = 'This view expired. Refresh to continue.';
      el('show-updates').textContent = 'Refresh photos';
    }
  } finally {
    polling = false;
  }
}, 4000);

run(async () => {
  await client.claimTab();
  state.kind = client.saved.filters?.kind || 'all';
  state.section = client.saved.filters?.section === 'decided' ? 'decided' : 'pending';
  state.category = client.saved.filters?.category || 'all';
  state.search = client.saved.filters?.search || '';
  el('search').value = state.search;
  state.sort = client.saved.filters?.sort === 'newest' ? 'newest' : 'oldest';
  try {
    const saved = localStorage.getItem(SORT_PREFERENCE);
    if (['oldest', 'newest'].includes(saved)) state.sort = saved;
  } catch {
    /* Keep the tab preference when browser storage is unavailable. */
  }
  el('sort').value = state.sort;
  if (client.saved.pending) {
    recovery();
    el('count').textContent = 'Resolve the last action to load photos.';
  } else await refresh();
});
