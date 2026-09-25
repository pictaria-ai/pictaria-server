import { CurateClient, request, decisionSummary } from './client.js';
import { comesAfter } from './order.js';
import { explanation } from './explanation.js';
import { PreviewImages } from './preview-images.js';
import { node, thumbnail, photoCard, groupCard, savedOutcome, outcomeLabel, similarityLabel, similarityIndicator } from './photos.js';

const el = (id) => document.getElementById(id);
const client = new CurateClient();
const previews = new PreviewImages();
const SORT_PREFERENCE = 'pictaria.curate.sort';
const state = {
  section: 'pending', category: 'all', selected: new Set(), removed: new Map(),
  viewerMode: 'stack', actionContext: null, continuing: false,
  kind: 'all',
  search: '',
  sort: 'oldest',
  view: null,
  groups: [],
  next: null,
  loading: false,
  comparison: null,
  outcomes: {}, batchPhotos: new Set(), draftTouched: false,
  busy: false,
  undo: null,
  syncId: null,
  updateStatus: null, autoUpdateFailed: false,
  photoIndex: 0,
  photoList: [],
  dialogGeneration: 0,
  openFailed: false,
  opening: null,
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
function makeCard(group, index = 0) {
  const card = groupCard(group, g => run(() => compare(g)), {
    decide: (g, outcome) => run(() => quickDecision([g], outcome)),
    select: (g, checked) => { checked ? state.selected.add(g.id) : state.selected.delete(g.id); bulkSelection(); },
    selected: state.selected.has(group.id), decided: state.section === 'decided',
    label: `Photo ${index + 1}`,
  });
  cards.set(group.id, card);
  visibility.observe(card);
  return card;
}

function error(error) {
  const target = el('photo-view').open ? el('photo-error') : el('comparison').open
    ? el('comparison-error')
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
  for (const id of ['error', 'comparison-error', 'photo-error']) {
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
  el('comparison-retry').disabled = state.busy;
  el('retry-action').disabled = state.busy;
  const locked = state.busy || state.opening || state.continuing || Boolean(client.saved.pending);
  el('refresh').disabled = locked || state.loading;
  el('search').disabled = locked;
  el('sort').disabled = el('category').disabled = locked || state.loading;
  el('more').disabled = locked || state.loading;
  for (const button of document.querySelectorAll('#filters button, #sections button, .group-card button, .group-card input'))
    button.disabled = locked || state.loading || state.autoUpdateFailed;
  for (const input of document.querySelectorAll('#photos [data-choice], #photos [data-compare-select], .compare-tools button:not(.why-trigger)'))
    input.disabled = locked || !state.comparison || state.comparison.oversized;
  el('undo').disabled = locked;
  selection();
  syncViewer();
  bulkSelection();
  resumeSearch();
}
function selection() {
  el('selection-count').textContent = state.comparison ? decisionSummary(state.outcomes) : '';
  el('comparison-bulk').hidden = !state.batchPhotos.size;
  el('comparison-bulk-count').textContent = `${state.batchPhotos.size} checked`;
  el('apply').textContent = state.comparison
    ? 'Save'
    : state.openFailed
      ? 'Refresh to continue'
      : 'Loading comparison…';
  if (state.comparison?.oversized) el('apply').textContent = 'Comparison too large';
  el('apply').disabled =
    !state.comparison ||
    state.busy ||
    state.opening || state.continuing ||
    Boolean(client.saved.pending) ||
    state.comparison.oversized ||
    failedPreviews.size > 0;
  el('apply-next').disabled = el('apply').disabled;
  el('apply-next').hidden = state.section !== 'pending';
}
function closeComparison() {
  state.dialogGeneration++;
  state.opening = null;
  el('photo-loading').hidden = true;
  el('photo-view').close();
  el('comparison').close();
  state.comparison = null;
}
async function refresh({ automatic = false, keepLightbox = false } = {}) {
  if (state.busy || state.loading || client.saved.pending) return;
  const count = automatic ? state.groups.length : 0;
  const scroll = automatic ? scrollContext() : null;
  state.loading = true;
  if (!keepLightbox) closeComparison();
  previews.clear();
  clearErrors();
  recovery();
  try {
    const view = await client.open({ kind: state.kind, search: state.search, sort: state.sort, section: state.section, category: state.category });
    while (view.nextOffset !== null && view.groups.length < count) {
      const page = await client.page(view.viewId, view.nextOffset);
      view.groups.push(...page.groups); view.nextOffset = page.nextOffset;
    }
    state.autoUpdateFailed = false;
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
    if (scroll) restoreScroll(scroll);
  } catch (e) {
    if (automatic) state.autoUpdateFailed = true;
    throw e;
  } finally {
    state.loading = false;
    recovery();
    scheduleUpdates();
  }
}
function showViewStatus(view) {
  const loadedStacks = state.groups.filter(g => g.memberCount > 1).length;
  const removedStacks = [...state.removed.values()].filter(g => g.memberCount > 1).length;
  const stacks = Math.max(0, (view.counts?.stacks ?? loadedStacks) - removedStacks);
  const singles = Math.max(0, (view.counts?.singles ?? view.total - stacks) - state.removed.size + removedStacks);
  const parts = [];
  if (stacks) parts.push(`${loadedStacks} of ${stacks} ${stacks === 1 ? 'stack' : 'stacks'}`);
  if (singles) parts.push(`${state.groups.length - loadedStacks} of ${singles} ${singles === 1 ? 'single photo' : 'single photos'}`);
  el('count').textContent = parts.length ? `${parts.join(' · ')} shown` : '0 photos shown';
  el('count').title = el('count').textContent;
  state.updateStatus = view;
  updateHint();
  const refinement = view.refinement;
  const metadata = view.metadata;
  if (state.view?.viewId === view.viewId) state.view.metadata = metadata;
  if (state.comparison) el('metadata-retry').hidden = !metadata?.problem;
  const paused = refinement?.state === 'paused' || refinement?.state === 'limited';
  const remaining = refinement?.remainingGroups ?? 0;
  const checking = remaining > 0;
  const progress = checking ? ` · ${remaining.toLocaleString()} remaining` : '';
  const status = paused ? `Checks paused${progress}` : checking ? `Checking stacks${progress}`
    : metadata?.problem ? 'Photo information paused'
    : metadata?.state === 'refreshing' ? 'Refreshing photo information' : '';
  el('refinement').textContent = status;
  el('refinement').title = [paused ? refinement?.problem : metadata?.problem,
    checking ? 'Remaining checks across all pending photos, including outside this view. Includes queued and in-progress checks. Each check covers nearby photos that may form more than one stack.' : '',
  ].filter(Boolean).join(' ');
  const activity = paused ? { state: 'paused' } : refinement?.state === 'searching' || metadata?.state === 'refreshing'
    ? { state: 'checking' } : checking ? { state: 'waiting' } : null;
  const indicator = similarityIndicator(activity);
  if (indicator) {
    indicator.title = indicator.ariaLabel = el('refinement').title || (paused ? 'Stack checks paused' : 'Checking pending stacks in the background');
  }
  const slot = el('check-activity');
  if (slot.firstChild?.dataset.phase !== indicator?.dataset.phase) slot.replaceChildren(...(indicator ? [indicator] : []));
  else if (indicator) slot.firstChild.title = slot.firstChild.ariaLabel = indicator.title;
  for (const group of view.groups) {
    cards.get(group.id)?.updateSimilarity(group.similarity);
    if (state.comparison?.groupId === group.id) showComparisonSimilarity(group.similarity);
  }
  scheduleUpdates();
}
function showComparisonSimilarity(status) {
  if (state.comparison) state.comparison.similarity = status;
  // A machine update is for the next view, not an instruction to abandon an
  // inspected comparison. Real scope/input conflicts still use the Save guards.
  if (status?.state === 'updated') status = null;
  const title = status?.state === 'checked' && status.uncertain ? 'Similarity check inconclusive'
    : status?.state === 'checked' ? 'Similarity checked' : similarityLabel(status);
  const detail = (status?.problem ? `${status.problem} ` : '') + (['waiting', 'checking'].includes(status?.state)
      ? 'This stack may change after checking. You can still choose which photos to keep.'
      : status?.uncertain ? 'The evidence is inconclusive. You can still choose which photos to keep.'
        : ['incomplete', 'paused', 'limited', 'unavailable'].includes(status?.state)
          ? 'This stack has not been fully checked. You can still choose which photos to keep.' : '');
  for (const id of ['comparison-similarity','photo-similarity']) {
    const target = el(id);
    target.hidden = (!title && !(state.comparison?.ids.length > 1)) || (id === 'photo-similarity' && state.viewerMode === 'single');
    const signature = JSON.stringify([state.comparison?.id, status]);
    if (target.dataset.status === signature) continue;
    target.dataset.status = signature;
    if (id === 'comparison-similarity') {
      target.replaceChildren(explanation(state.comparison, 'stack-reason', status ? {
        title, detail, indicator: similarityIndicator(status),
      } : null));
      continue;
    }
    const copy = node('div'), heading = node('div', undefined, 'check-heading');
    heading.append(node('strong', title || 'Stack comparison'));
    if (state.comparison?.ids.length > 1)
      heading.append(explanation(state.comparison, 'photo-stack-reason'));
    copy.append(heading);
    if (detail) copy.append(node('p', detail));
    const indicator = similarityIndicator(status);
    target.replaceChildren(...(indicator ? [indicator] : []), copy);
    target.classList.toggle('check-pending', Boolean(detail));
  }
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
  if (state.busy || state.loading || state.opening || state.autoUpdateFailed || client.saved.pending) return;
  clearErrors();
  const generation = ++state.dialogGeneration;
  const single = group.memberCount === 1;
  const keepPhoto = single && el('photo-view').open;
  state.opening = single ? 'single' : 'stack';
  state.viewerMode = group.memberCount === 1 ? 'single' : 'stack';
  state.batchPhotos.clear();
  if (!keepPhoto) state.comparison = null;
  state.outcomes = {};
  state.draftTouched = false;
  state.openFailed = false;
  failedPreviews = new Set();
  el('preview-errors').hidden = true;
  el('comparison-title').textContent = group.memberCount > 1
    ? `Compare stack · ${group.memberCount} photos` : 'Review photo';
  el('select-all').hidden = el('select-none').hidden = group.memberCount < 2;
  el('compact-label').hidden = group.memberCount <= 10;
  el('compact').checked = group.memberCount > 10;
  el('photos').classList.toggle('compact', el('compact').checked);
  el('comparison-state').textContent = 'Loading the complete comparison…';
  el('comparison-similarity').hidden = true;
  el('metadata-retry').hidden = true;
  el('photos').replaceChildren();
  el('context').hidden = true;
  if (single) openLightboxShell();
  else {
    el('photo-view').close();
    el('comparison').showModal();
  }
  recovery();
  try {
    const comparison = await client.comparison(state.view.viewId, group.id);
    if (generation !== state.dialogGeneration) return;
    const preview = single ? await previews.get(comparison.photos[0].id).promise : null;
    if (generation !== state.dialogGeneration || !(single ? el('photo-view') : el('comparison')).open) return;
    state.comparison = comparison;
    showComparisonSimilarity(comparison.similarity);
    state.outcomes = comparison.oversized ? {} : Object.fromEntries(comparison.photos.map(photo =>
      [photo.id, savedOutcome(photo) || 'reviewed']));
    state.photoList = [...comparison.photos, ...comparison.context];
    el('comparison-state').textContent = comparison.oversized
      ? 'This group exceeds the 1,000-photo decision limit. Only the first 50 previews are shown; decisions are disabled. Turn off stacks in Settings to review these photos individually.'
      : comparison.photos.some((p) => !p.metadata.checkedAt || p.metadata.outcome !== 'refreshed')
        ? 'Some photo information is awaiting refresh. You can still make a manual choice; changed inputs will require a refresh before saving.'
        : '';
    el('metadata-retry').hidden = !state.view.metadata?.problem;
    el('photos').replaceChildren(
      ...comparison.photos.map((photo, index) =>
        photoCard(photo, {
          label: `Photo ${index + 1}`,
          selected: () => state.batchPhotos.has(photo.id),
          select: (selected) => {
            selected ? state.batchPhotos.add(photo.id) : state.batchPhotos.delete(photo.id);
            repaintSelection();
          },
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
    el('context').hidden = !comparison.context.length;
    el('context-omitted').hidden = !comparison.contextOmitted;
    el('context-photos').replaceChildren(
      ...comparison.context.map((photo) => photoCard(photo, { readOnly: true, open: showPhoto })),
    );
    recovery();
    if (single) { el('comparison').close(); renderPhoto(comparison.photos[0], preview); }
    else el('photos').firstElementChild?.focus({ preventScroll: true });
  } catch (cause) {
    if (generation === state.dialogGeneration) throw cause;
  } finally {
    if (generation === state.dialogGeneration) {
      state.opening = null;
      el('photo-loading').hidden = true;
      recovery();
    }
  }
}
function openLightboxShell() {
  if (!el('photo-view').open) {
    el('photo-view').classList.add('loading-initial');
    el('photo-view').showModal();
  }
  el('photo-loading').hidden = false;
}
async function showPhoto(photo) {
  if (!photo || state.opening || state.busy || client.saved.pending) return;
  const generation = ++state.dialogGeneration;
  state.opening = 'photo';
  openLightboxShell();
  recovery();
  try {
    const entry = previews.get(photo.id);
    const preview = entry.ready ? entry : await entry.promise;
    if (generation !== state.dialogGeneration || !el('photo-view').open) return;
    renderPhoto(photo, preview);
  } finally {
    if (generation === state.dialogGeneration) {
      state.opening = null;
      el('photo-loading').hidden = true;
      recovery();
    }
  }
}
function renderPhoto(photo, preview) {
  state.photoIndex = state.photoList.findIndex((p) => p.id === photo.id);
  el('photo-title').textContent = 'Photo';
  preview.image.id = 'photo-large';
  preview.image.alt = photo.caption || `Photo ${state.photoIndex + 1}`;
  preview.image.hidden = !preview.ok;
  if (el('photo-large') !== preview.image) el('photo-large').replaceWith(preview.image);
  el('photo-view').classList.remove('loading-initial');
  el('photo-caption').textContent = photo.caption || '';
  el('photo-date').textContent = photo.capturedAt ? new Date(photo.capturedAt).toLocaleString() : '';
  el('photo-score').textContent = Number.isFinite(photo.frameScore) ? `Enrichment score: ${photo.frameScore.toFixed(2)}` : '';
  el('photo-model').hidden = true;
  el('photo-image-error').hidden = preview.ok;
  el('photo-tags').replaceChildren(...(photo.tags || []).map((tag) => node('span', tag)));
  const references = state.viewerMode === 'single' ? state.comparison.context : [];
  el('photo-context').hidden = !references.length;
  el('photo-context-images').replaceChildren(...references.map(reference => {
    const button = node('button', undefined, 'reference-photo');
    const img = node('img'); img.src = thumbnail(reference.id); img.alt = reference.caption || 'Already kept photo';
    button.setAttribute('aria-label', 'Inspect already kept photo');
    button.append(img); button.onclick = () => showPhoto(reference); return button;
  }));
  const base = state.view?.immichUrl;
  el('immich').hidden = !base;
  if (base) el('immich').href = `${base.replace(/\/$/, '')}/photos/${encodeURIComponent(photo.id)}`;
  el('photo-prev').disabled = state.photoIndex <= 0;
  el('photo-next').disabled = state.photoIndex >= state.photoList.length - 1;
  if (!el('photo-view').open) el('photo-view').showModal();
  syncViewer();
  showComparisonSimilarity(state.comparison?.similarity);
  fullCaption(photo);
  const list = state.viewerMode === 'single' ? state.groups : state.photoList;
  const index = state.viewerMode === 'single'
    ? state.groups.findIndex(g => g.id === state.comparison.groupId) : state.photoIndex;
  const neighbors = list.slice(Math.max(0, index - 1), index + 2)
    .map(item => state.viewerMode === 'single' ? item.memberCount === 1 && item.photos[0] : item).filter(Boolean);
  for (const neighbor of neighbors) if (neighbor.id !== photo.id) previews.get(neighbor.id);
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
function setOutcome(id, value) { setOutcomes([id], value); }
function setOutcomes(ids, value) {
  if (state.busy || state.opening || client.saved.pending || !state.comparison || state.comparison.oversized) return;
  for (const id of ids) if (Object.hasOwn(state.outcomes, id)) {
    state.outcomes[id] = value;
    state.draftTouched = true; // An explicit Skip also counts; checking a box does not.
  }
  repaintSelection(); syncViewer();
}
function syncViewer() {
  const photo = state.photoList[state.photoIndex];
  const actionable = Boolean(
    state.comparison && !state.comparison.oversized && photo && Object.hasOwn(state.outcomes, photo.id),
  );
  const single = state.viewerMode === 'single';
  const at = state.groups.findIndex(g => g.id === state.comparison?.groupId);
  const onlyPhotos = state.section === 'decided' || state.kind === 'singles' || state.view?.counts?.stacks === 0;
  const unit = onlyPhotos ? 'photos' : 'items';
  el('photo-position').textContent = single ? `${at + 1} of ${state.groups.length} ${state.next !== null ? 'loaded ' : ''}${unit}`
    : `${state.photoIndex + 1} of ${state.photoList.length} photos`;
  el('single-actions').hidden = !single || !actionable;
  el('stack-actions').hidden = single || !actionable;
  el('photo-keep').hidden = single || !actionable;
  el('photo-readonly').hidden = actionable;
  el('photo-readonly').textContent = photo?.state === 'approved' ? 'Already kept · reference only' : 'Decision unavailable for this comparison';
  el('back-pending-photo').hidden = !single || actionable;
  el('photo-reason').hidden = !single || !actionable || state.section === 'decided';
  if (state.comparison && el('photo-reason').dataset.comparison !== state.comparison.id) {
    el('photo-reason').dataset.comparison = state.comparison.id;
    el('photo-reason').replaceChildren(explanation(state.comparison, 'single-reason'));
  }
  el('photo-outcome').textContent = single || !actionable
    ? `Current: ${outcomeLabel(savedOutcome(photo))}`
    : `Draft: ${outcomeLabel(state.outcomes[photo.id])} · not saved`;
  const locked = state.busy || state.loading || state.opening || state.continuing || Boolean(client.saved.pending) || state.comparison?.oversized;
  for (const control of document.querySelectorAll('[data-stack-choice], [data-photo-action]'))
    control.disabled = locked || !actionable;
  el('photo-prev').disabled = locked || (single ? !actionable || at <= 0 : state.photoIndex <= 0);
  el('photo-next').disabled = locked || (single ? !actionable || at < 0 || at >= state.groups.length - 1 && state.next === null : state.photoIndex >= state.photoList.length - 1);
  for (const button of el('photo-context').querySelectorAll('button')) button.disabled = locked;
  el('back-pending-photo').disabled = locked;
  el('photo-keys').hidden = !actionable;
  el('photo-keys').textContent = single
    ? 'Y Yes · S Skip · F Fav · N No · Z Undo · ← → browse · Esc close. Choices save immediately.'
    : 'Y Yes · S Skip · F Fav · N No: mark & next. ← → browse. Esc returns to comparison. Choices are not saved until you save the stack.';
  syncReceipts();
  for (const button of document.querySelectorAll('[data-photo-action]'))
    button.setAttribute('aria-pressed', String(button.dataset.photoAction === savedOutcome(photo)));
  if (!actionable) return;
  const value = state.outcomes[photo.id];
  for (const button of document.querySelectorAll('[data-stack-choice]'))
    button.setAttribute('aria-pressed', String(button.dataset.stackChoice === value));
}
function syncReceipts() {
  const available = Boolean(state.undo && state.undo.until > Date.now());
  const locked = state.busy || state.loading || state.opening || state.continuing || Boolean(client.saved.pending);
  el('undo').hidden = !available;
  el('undo').disabled = locked || !available;
  for (const prefix of ['photo', 'comparison']) {
    el(`${prefix}-receipt`).hidden = !available;
    el(`${prefix}-receipt-text`).textContent = el('receipt-text').textContent;
    el(`${prefix}-undo`).disabled = locked || !available;
  }
}
async function action(work, context = null) {
  if (state.busy || state.opening || state.continuing || client.saved.pending) return;
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
  const keepPhoto = el('photo-view').open &&
    (kind === 'decision' && context?.advance || kind === 'undo' && state.section === 'pending' &&
      undoContext?.advance && undoContext.viewId === state.view?.viewId);
  if (keepPhoto) state.continuing = true;
  else closeComparison();
  try {
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
      if (!correction) correctionMessage = 'Stack correction recorded. Keeper decisions are unchanged.';
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
    state.actionContext = null;
    if (state.view && kind === 'decision' && context?.ids && state.section === 'pending') {
      const ids = new Set(context.ids);
      const removed = state.groups.map((group,index) => ({group,index})).filter(({group}) => ids.has(group.photos[0].id));
      if (state.undo) state.undo.ui = { ...context, removed, viewId: state.view.viewId };
      for (const {group} of removed) { state.removed.set(group.id, group); state.selected.delete(group.id); }
      state.groups = state.groups.filter(g => !state.removed.has(g.id));
      renderGroups(); showViewStatus(state.view);
      if (context.latest) {
        await continueReview(context.anchor);
      } else if (context.advance) {
        if (index >= state.groups.length && state.next !== null) await more();
        if (state.groups[index] && (!keepPhoto || el('photo-view').open)) await compare(state.groups[index]);
        else closeComparison();
      }
    } else if (state.view && kind === 'undo' && undoContext?.removed && undoContext.viewId === state.view.viewId && state.section === 'pending') {
      for (const {group,index} of undoContext.removed) {
        if (state.removed.delete(group.id)) state.groups.splice(index,0,group);
      }
      renderGroups(); showViewStatus(state.view);
      if (undoContext.advance && undoContext.removed[0]) await compare(undoContext.removed[0].group);
    } else {
      await refresh({ keepLightbox: keepPhoto });
      if (context?.advance && state.section === 'decided') {
        const group = state.groups.find(g => context.ids.includes(g.photos[0].id));
        if (group && (!keepPhoto || el('photo-view').open)) await compare(group);
        else closeComparison();
      }
    }
    state.actionContext = null;
  } catch (cause) {
    if (!keepPhoto) throw cause;
    closeComparison();
    throw Error(`${kind === 'undo' ? 'Choices restored' : 'Choices saved'}. Could not open the next photo: ${cause.message}`);
  } finally {
    if (keepPhoto) {
      state.continuing = false;
      recovery();
    }
  }
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
  const locked = state.loading || state.busy || state.continuing || state.autoUpdateFailed || Boolean(client.saved.pending);
  el('bulk-label').hidden = state.section === 'pending' && state.kind !== 'singles';
  const count = singles.filter(g => state.selected.has(g.id)).length;
  el('select-shown').checked = count > 0 && count === singles.length;
  el('select-shown').indeterminate = count > 0 && count < singles.length;
  el('select-shown').disabled = locked || !singles.length;
  el('bulk-actions').hidden = count === 0;
  el('bulk-count').textContent = `${count} checked`;
  for (const button of el('bulk-actions').querySelectorAll('button')) button.disabled = locked;
  for (const input of el('groups').querySelectorAll('[data-select]')) input.checked = state.selected.has(input.dataset.select);
}
function quickDecision(groups, outcome) {
  if (state.autoUpdateFailed) return;
  return action(async () => {
    const comparison = await request('selection', { viewId: state.view.viewId, groupIds: groups.map(g => g.id) });
    return client.decide(comparison.id, Object.fromEntries(comparison.ids.map(id => [id,outcome])));
  }, { ids: groups.map(g => g.photos[0].id) });
}
async function stepPhoto(delta) {
  if (state.busy || state.loading || state.opening || state.continuing || client.saved.pending) return;
  if (state.viewerMode !== 'single') return showPhoto(state.photoList[state.photoIndex + delta]);
  const index = state.groups.findIndex(g => g.id === state.comparison?.groupId) + delta;
  if (index >= state.groups.length && state.next !== null) await more();
  const group = state.groups[index];
  if (group && el('photo-view').open) await compare(group);
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
  Object.assign(state, { search: el('search').value.trim() }, patch);
  try { await refresh(); }
  catch (e) { Object.assign(state,previous); if (state.view) setControls(state.view); throw e; }
}
// Delay changes until browsing pauses. An open comparison, a selected batch,
// or a pending receipt always owns its current snapshot.
let updateTimer, lastInteraction = 0, lastAutomatic = 0;
function canUpdate() {
  return !document.hidden && !state.busy && !state.loading && !state.continuing && !client.saved.pending &&
    el('search').value.trim() === state.search &&
    !state.selected.size && !document.querySelector('dialog[open], .page-tools[open], .card-menu[open]') &&
    !document.activeElement?.matches('input:not([type=checkbox]),select,textarea,[contenteditable=true]');
}
function updateHint() {
  const available = state.autoUpdateFailed || Boolean(state.updateStatus?.updatesAvailable);
  el('updates').hidden = !available;
  el('updates-copy').textContent = state.autoUpdateFailed ? 'Refresh to load updates'
    : state.updateStatus?.refinement?.ready ? 'Updated stacks available' : 'Photo updates available';
  el('refresh').classList.toggle('updates-ready', available);
  el('refresh').title = available ? 'Load the latest photos and completed grouping checks' : 'Refresh photos';
}
function scheduleUpdates() {
  clearTimeout(updateTimer);
  if (!state.updateStatus?.updatesAvailable || state.autoUpdateFailed || !canUpdate() ||
      state.updateStatus.metadata?.state === 'refreshing') return;
  const wait = Math.max(0, lastInteraction + 1200 - Date.now(), lastAutomatic + 5000 - Date.now());
  updateTimer = setTimeout(() => {
    if (!canUpdate()) return;
    lastAutomatic = Date.now();
    run(async () => {
      try { await refresh({ automatic: true }); }
      catch {
        // Do not spin on a failed read or on an uncertain replacement view.
        // Explicit Refresh safely reconciles the server's replacement lease.
        updateHint();
        throw Error('Could not finish updating photos. Use Refresh to continue.');
      }
    });
  }, wait);
}
function scrollContext() {
  return { y: scrollY, anchors: state.groups.map(group => ({
    id: group.id, photoId: group.photos[0].id,
    top: cards.get(group.id)?.getBoundingClientRect().top,
  })).filter(anchor => Number.isFinite(anchor.top)).sort((a,b) => Math.abs(a.top) - Math.abs(b.top)) };
}
function restoreScroll(context) {
  const byId = new Map(state.groups.map(group => [group.id, group]));
  const byPhoto = new Map(state.groups.map(group => [group.photos[0].id, group]));
  for (const anchor of context.anchors) {
    const group = byId.get(anchor.id) || byPhoto.get(anchor.photoId);
    if (!group) continue;
    window.scrollTo(0, scrollY + cards.get(group.id).getBoundingClientRect().top - anchor.top);
    return;
  }
  window.scrollTo(0, context.y);
}
for (const event of ['pointerdown','keydown','wheel','touchstart']) document.addEventListener(event, () => {
  lastInteraction = Date.now(); scheduleUpdates();
}, { passive: true });
window.addEventListener('scroll', () => { lastInteraction = Date.now(); scheduleUpdates(); }, { passive: true });
document.addEventListener('focusout', () => setTimeout(scheduleUpdates, 0));
document.addEventListener('visibilitychange', scheduleUpdates);
for (const menu of document.querySelectorAll('details')) menu.addEventListener('toggle', scheduleUpdates);
for (const dialog of document.querySelectorAll('dialog')) dialog.addEventListener('close', () => { scheduleUpdates(); resumeSearch(); });

el('toggle-filters').onclick = () => {
  const expanded = el('toggle-filters').getAttribute('aria-expanded') !== 'true';
  el('toggle-filters').setAttribute('aria-expanded', String(expanded));
  document.querySelector('.toolbar').classList.toggle('filters-expanded', expanded);
};
el('refresh').onclick = () => run(() => changeFilter({ search: el('search').value.trim() }));
el('more').onclick = () => run(more);
el('sort').onchange = () =>
  run(async () => {
    if (state.busy || state.loading || client.saved.pending) return;
    const previous = state.sort;
    state.sort = el('sort').value;
    try {
      await changeFilter({});
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
let searchTimer, searchQueued = false;
function scheduleSearch(delay) {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    searchTimer = null;
    // Keep the latest text through a slow view replacement or an open comparison.
    // Do not overlap replacements: each request must replace the last accepted view.
    if (state.loading || el('search').disabled || document.querySelector('dialog[open]')) return;
    searchQueued = false;
    const search = el('search').value.trim();
    if (search !== state.search) run(() => changeFilter({ search }));
  }, delay);
}
function resumeSearch() {
  // Run after filter rollback/error handling settles, without resetting an active debounce.
  if (searchQueued && !searchTimer) scheduleSearch(0);
}
el('search').oninput = () => {
  searchQueued = true;
  scheduleSearch(300);
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
  state.batchPhotos = new Set(Object.keys(state.outcomes));
  repaintSelection();
};
el('select-none').onclick = () => { state.batchPhotos.clear(); repaintSelection(); };
for (const button of document.querySelectorAll('[data-comparison-bulk]')) button.onclick = () =>
  setOutcomes(state.batchPhotos, button.dataset.comparisonBulk);
function repaintSelection() {
  for (const card of el('photos').children) card.syncSelection();
  selection();
}
el('compact').onchange = () => el('photos').classList.toggle('compact', el('compact').checked);
function saveComparison(next = false) {
  if (el('apply').disabled || !state.comparison) return;
  const anchor = state.groups.find(g => g.id === state.comparison.groupId)?.photos[0];
  return action(() => client.decide(state.comparison.id, { ...state.outcomes }), {
    ids: [...state.comparison.ids], latest: next, anchor,
  });
}
async function continueReview(anchor) {
  state.continuing = true;
  try {
    await refresh({ automatic: true });
    let next = anchor && state.groups.find(group => comesAfter(group, anchor, state.sort));
    while (!next && anchor && state.next !== null) {
      await more();
      next = state.groups.find(group => comesAfter(group, anchor, state.sort));
    }
    if (next) await compare(next);
    else el('receipt-text').textContent += ' No more photos ahead in this view.';
  } catch (cause) {
    // This is a read failure after an accepted save, never a failed mutation.
    throw Error(`Choices saved. Could not open the next comparison: ${cause.message}`);
  } finally {
    state.continuing = false;
    recovery();
  }
}
el('apply').onclick = () => run(() => saveComparison());
el('apply-next').onclick = () => run(() => saveComparison(true));
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
el('photo-prev').onclick = () => run(() => stepPhoto(-1));
el('photo-next').onclick = () => run(() => stepPhoto(1));
el('back-comparison').onclick = backToComparison;
el('back-pending-photo').onclick = () => showPhoto(state.comparison?.photos[0]);
el('photo-undo').onclick = el('comparison-undo').onclick = () => el('undo').click();
el('photo-retry').onclick = () => el('retry-action').click();
el('photo-refresh').onclick = () => run(refresh);
for (const button of document.querySelectorAll('[data-photo-action]')) button.onclick = () => run(() => decideSingle(button.dataset.photoAction));
for (const button of document.querySelectorAll('[data-stack-choice]')) button.onclick = () => {
  const photo = state.photoList[state.photoIndex];
  if (photo) setOutcome(photo.id, button.dataset.stackChoice);
};
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
  if (!el('comparison').open && state.viewerMode !== 'single') {
    state.dialogGeneration++;
    if (state.opening === 'stack') { state.opening = null; recovery(); }
  }
});
el('photo-view').addEventListener('close', () => {
  if (!el('photo-view').open && ['single', 'photo'].includes(state.opening)) {
    state.dialogGeneration++;
    state.opening = null;
    el('photo-loading').hidden = true;
    recovery();
  }
});
function backToComparison() {
  el('photo-view').close();
  el('photos').children[state.photoIndex]?.focus({ preventScroll: true });
}
function markAndAdvance(outcome) {
  const photo = state.photoList[state.photoIndex];
  if (!photo || !Object.hasOwn(state.outcomes, photo.id) || el('photo-keep').disabled) return;
  setOutcome(photo.id, outcome);
  const next = state.comparison.photos[state.photoIndex + 1];
  if (next) showPhoto(next);
  else backToComparison(); // Never save implicitly or advance into kept context.
}
document.addEventListener('keydown', (event) => {
  if (event.target.closest('input,select,textarea,[contenteditable=true],.why-tooltip')) return;
  if (event.ctrlKey || event.metaKey || event.altKey || event.repeat || state.busy || state.loading || state.opening || state.continuing || client.saved.pending) return;
  const key = event.key.toLowerCase();
  const outcome = {y:'approve',a:'approve',f:'favorite',s:'reviewed',v:'reviewed',n:'reject',r:'reject'}[key];
  const undo = el('photo-view').open ? el('photo-undo') : el('comparison').open ? el('comparison-undo') : null;
  if (key === 'z' && undo && state.undo?.until > Date.now() && !undo.disabled) {
    event.preventDefault(); undo.click(); return;
  }
  if (el('photo-view').open) {
    if (outcome) {
      event.preventDefault();
      if (state.viewerMode === 'single') run(() => decideSingle(outcome));
      else markAndAdvance(outcome);
      return;
    }
    if (key === 'k' && !el('photo-keep').hidden && !el('photo-keep').disabled) {
      event.preventDefault();
      const id = state.photoList[state.photoIndex]?.id;
      if (id) markAndAdvance(['approve', 'favorite'].includes(state.outcomes[id]) ? 'reviewed' : 'approve');
    }
    if (key === 'arrowright' && !el('photo-next').disabled) { event.preventDefault(); el('photo-next').click(); }
    if (key === 'arrowleft' && !el('photo-prev').disabled) { event.preventDefault(); el('photo-prev').click(); }
    return;
  }
  if (!el('comparison').open || !state.comparison || state.comparison.oversized) return;
  const photos = [...el('photos').children];
  const focused = event.target.closest('#photos .photo-card');
  const index = photos.indexOf(focused);
  if (/^[1-9]$/.test(key) && photos[Number(key)-1]) {
    event.preventDefault(); photos[Number(key)-1].focus(); return;
  }
  if (!focused) return;
  if (outcome) { event.preventDefault(); setOutcome(focused.dataset.photoId, outcome); }
  else if (['arrowleft','arrowright'].includes(key)) {
    event.preventDefault(); photos[index + (key === 'arrowleft' ? -1 : 1)]?.focus();
  } else if (key === 'enter' && event.target === focused) {
    // Enter on an image/button retains its native behavior; only the explicitly
    // focused card with an explicitly marked draft can invoke save-and-next.
    // Automatic initial focus must never turn a stray Enter into a Skip-all save.
    event.preventDefault();
    if (state.draftTouched) run(() => saveComparison(true));
  }
});
window.addEventListener('pagehide', () => client.channel?.close());
window.addEventListener('pageshow', (event) => {
  if (event.persisted) location.reload();
});

// Status stays live. Adopt a new saved view only at a safe, idle boundary.
let polling = false;
setInterval(async () => {
  if (document.hidden || polling || state.loading || state.busy) return;
  polling = true;
  try {
    if (state.view) {
      const id = state.view.viewId;
      // Keep the visible cards (or the opened comparison) current, in a bounded
      // 50-card read. Only status changes; memberships and selections stay put.
      const index = state.comparison && (el('comparison').open || el('photo-view').open)
        ? state.groups.findIndex(g => g.id === state.comparison.groupId)
        : state.groups.findIndex(g => visibleCards.has(g.id));
      const status = await client.page(id, Math.floor(Math.max(0, index) / 50) * 50, 50, {
        visibleGroupIds: [...visibleCards].slice(0, 50),
        comparisonGroupId: (el('comparison').open || el('photo-view').open) ? state.comparison?.groupId ?? null : null,
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
      state.autoUpdateFailed = true;
      clearTimeout(updateTimer);
      el('refresh').classList.add('updates-ready');
      recovery();
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
