import { CurateClient, request, decisionSummary } from './client.js';
import { node, thumbnail, photoCard, groupCard } from './photos.js';

const el = (id) => document.getElementById(id);
const client = new CurateClient();
const state = {
  kind: 'all',
  search: '',
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
};
let failedPreviews = new Set();

function error(error) {
  const target = el('comparison').open
    ? el('comparison-error')
    : el('correction-dialog').open
      ? el('correction-error')
      : el('error');
  target.textContent = error.message || String(error);
  target.hidden = false;
  el('comparison-refresh').hidden = !el('comparison').open || Boolean(client.saved.pending);
  recovery();
}
function clearErrors() {
  for (const id of ['error', 'comparison-error', 'correction-error']) {
    el(id).hidden = true;
    el(id).textContent = '';
  }
  el('comparison-refresh').hidden = true;
}
function run(work) {
  return Promise.resolve().then(work).catch(error);
}
function recovery() {
  el('recovery').hidden = !client.saved.pending;
  el('comparison-recovery').hidden = !client.saved.pending;
  el('correction-recovery').hidden = !client.saved.pending;
  el('comparison-retry').disabled = state.busy;
  el('retry-action').disabled = state.busy;
  const locked = state.busy || Boolean(client.saved.pending);
  el('refresh').disabled = locked || state.loading;
  el('search').disabled = locked || state.loading;
  el('corrections').disabled = locked;
  el('more').disabled = locked || state.loading;
  for (const button of document.querySelectorAll('#filters button, .group-card'))
    button.disabled = locked || state.loading;
  for (const input of document.querySelectorAll(
    '#photos input, #photos select, #photos button[data-remove], .compare-tools button',
  ))
    input.disabled = locked || !state.comparison || state.comparison.oversized;
  el('undo').disabled = locked;
  selection();
}
function selection() {
  const values = Object.values(state.outcomes),
    keep = values.filter((v) => ['approve', 'favorite'].includes(v)).length;
  el('selection-count').textContent = `${keep} of ${values.length} selected to keep`;
  el('apply').textContent = state.comparison ? decisionSummary(state.outcomes) : 'Loading comparison…';
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
    const view = await client.open({ kind: state.kind, search: state.search });
    state.view = view;
    state.groups = view.groups;
    state.next = view.nextOffset;
    el('groups').replaceChildren(...view.groups.map((g) => groupCard(g, (g) => run(() => compare(g)))));
    showViewStatus(view);
    el('empty').hidden = view.total !== 0;
    el('more').hidden = state.next === null;
    for (const button of document.querySelectorAll('#filters button'))
      button.classList.toggle('active', button.dataset.kind === state.kind);
  } finally {
    state.loading = false;
    recovery();
  }
}
function showViewStatus(view) {
  el('count').textContent = `${state.groups.length} of ${view.total} comparisons shown`;
  el('updates').hidden = !view.updatesAvailable;
  const metadata = view.metadata;
  if (state.view?.viewId === view.viewId) state.view.metadata = metadata;
  if (state.comparison) el('metadata-retry').hidden = !metadata?.problem;
  el('metadata').textContent = metadata?.problem
    ? `Photo information refresh paused: ${metadata.problem}`
    : metadata?.state === 'refreshing'
      ? 'Refreshing photo information from Immich. Your open view stays in place.'
      : '';
  el('metadata').hidden = !el('metadata').textContent;
}
async function more() {
  if (state.next === null || state.loading || client.saved.pending) return;
  state.loading = true;
  recovery();
  try {
    const page = await client.page(state.view.viewId, state.next);
    state.groups.push(...page.groups);
    state.next = page.nextOffset;
    el('groups').append(...page.groups.map((g) => groupCard(g, (g) => run(() => compare(g)))));
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
  state.comparison = null;
  state.outcomes = {};
  failedPreviews = new Set();
  el('preview-errors').hidden = true;
  el('comparison-title').textContent = group.memberCount > 1 ? 'Compare stack' : 'Review photo';
  el('comparison-subtitle').textContent =
    `${group.memberCount} ${group.memberCount === 1 ? 'photo' : 'photos'} in this comparison`;
  el('comparison-state').textContent = 'Loading the complete comparison…';
  el('metadata-retry').hidden = true;
  el('photos').replaceChildren();
  el('context').hidden = true;
  el('comparison').showModal();
  recovery();
  const comparison = await client.comparison(state.view.viewId, group.id);
  if (generation !== state.dialogGeneration || !el('comparison').open) return;
  state.comparison = comparison;
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
        change: (value) => {
          state.outcomes[photo.id] = value;
          selection();
        },
        imageState: (ok) => {
          if (state.comparison !== comparison) return;
          ok ? failedPreviews.delete(photo.id) : failedPreviews.add(photo.id);
          el('preview-errors').hidden = !failedPreviews.size;
          selection();
        },
        open: showPhoto,
        remove:
          comparison.ids.length > 1
            ? () => run(() => separate([[photo.id], comparison.ids.filter((id) => id !== photo.id)]))
            : null,
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
}
function showPhoto(photo) {
  state.photoIndex = state.photoList.findIndex((p) => p.id === photo.id);
  el('photo-title').textContent = photo.filename;
  el('photo-large').src = thumbnail(photo.id);
  el('photo-large').alt = photo.caption || photo.filename;
  el('photo-caption').textContent = photo.caption || '';
  el('photo-tags').replaceChildren(...(photo.tags || []).map((tag) => node('span', tag)));
  const base = state.view?.immichUrl;
  el('immich').hidden = !base;
  if (base) el('immich').href = `${base.replace(/\/$/, '')}/photos/${encodeURIComponent(photo.id)}`;
  el('photo-prev').disabled = state.photoIndex <= 0;
  el('photo-next').disabled = state.photoIndex >= state.photoList.length - 1;
  if (!el('photo-view').open) el('photo-view').showModal();
}
async function action(work) {
  if (state.busy || client.saved.pending) return;
  state.busy = true;
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
  closeComparison();
  el('correction-dialog').close();
  state.undo = null;
  let correctionMessage = 'Stack correction saved. Keeper decisions are unchanged.';
  state.syncId = result.operationId || null;
  if (result.undo)
    state.undo = {
      kind: 'undo',
      body: { operationId: result.undo.operationId, kind: 'undo', targetOperationId: result.undo.targetOperationId },
      until: result.undo.expiresAt,
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
    ? `Saved choices for ${result.assetCount} ${result.assetCount === 1 ? 'photo' : 'photos'}.`
    : kind === 'separation'
      ? correctionMessage
      : 'Stack correction reset. Keeper decisions are unchanged.';
  el('receipt').hidden = false;
  el('sync').textContent = result.savedLocally ? 'Syncing to Immich…' : '';
  el('retry-sync').hidden = true;
  el('undo').hidden = !state.undo || state.undo.until <= Date.now();
  // The accepted result is shown before refreshing, so a failed read cannot
  // turn a saved action into an apparent failure or a second operation.
  state.busy = false;
  await refresh().catch(error);
}
function separate(partitions) {
  return action(() => client.mutate('separations', { comparisonId: state.comparison.id, partitions }, 'separation'));
}

async function corrections(append = false) {
  const page = await request(`separations?offset=${append ? state.correctionNext : 0}`);
  if (!append) el('correction-list').replaceChildren();
  for (const correction of page.corrections) {
    const row = node('div', undefined, 'correction-row');
    row.append(
      node('strong', `${correction.memberCount} photos separated`),
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
el('more').onclick = () => run(more);
for (const button of document.querySelectorAll('#filters button'))
  button.onclick = () =>
    run(async () => {
      state.kind = button.dataset.kind;
      await refresh();
    });
let searchTimer;
el('search').oninput = () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(
    () =>
      run(async () => {
        state.search = el('search').value.trim();
        await refresh();
      }),
    300,
  );
};
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
el('split').onclick = () => run(() => separate(state.comparison.ids.map((id) => [id])));
el('apply').onclick = () => run(() => action(() => client.decide(state.comparison.id, { ...state.outcomes })));
el('retry-action').onclick = () =>
  run(async () => {
    if (state.busy) return;
    state.busy = true;
    clearErrors();
    recovery();
    try {
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
    el('sync').textContent = 'Syncing to Immich…';
    el('retry-sync').hidden = true;
  });
el('corrections').onclick = () => run(() => corrections());
el('correction-more').onclick = () => run(() => corrections(true));
el('photo-prev').onclick = () => showPhoto(state.photoList[state.photoIndex - 1]);
el('photo-next').onclick = () => showPhoto(state.photoList[state.photoIndex + 1]);
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
  state.dialogGeneration++;
});
document.addEventListener('keydown', (event) => {
  if (!el('photo-view').open || event.target.closest('input,select,textarea')) return;
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
      const status = await client.page(id, 0, 1);
      if (state.view?.viewId === id) showViewStatus(status);
    }
    if (state.syncId) {
      const id = state.syncId;
      const status = await request(`operations/status?operationId=${encodeURIComponent(id)}`);
      if (state.syncId === id) {
        el('sync').textContent = {
          synced: 'Synced to Immich.',
          superseded: 'A newer decision replaced this one.',
          pending: `Syncing to Immich · ${status.pending} remaining`,
          failed: 'Saved locally. Immich sync needs attention.',
        }[status.sync];
        el('retry-sync').hidden = status.sync !== 'failed';
      }
    }
    if (state.undo?.until <= Date.now()) {
      state.undo = null;
      el('undo').hidden = true;
    }
  } catch (e) {
    if (e.code === 'curate_expired') {
      el('updates').hidden = false;
      el('updates').textContent = 'This view expired. Refresh to continue.';
    }
  } finally {
    polling = false;
  }
}, 4000);

run(async () => {
  await client.claimTab();
  state.kind = client.saved.filters?.kind || 'all';
  state.search = client.saved.filters?.search || '';
  el('search').value = state.search;
  if (client.saved.pending) {
    recovery();
    el('count').textContent = 'Resolve the last action to load photos.';
  } else await refresh();
});
