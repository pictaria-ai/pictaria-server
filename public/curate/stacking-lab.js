import { RankComparison } from './rank-comparison.js';
import { combinedPartition, COMBINED_DEFAULTS } from './combined-evidence.js';
import { request } from './client.js';
import { node, thumbnail } from './photos.js';
import { partition, decodeHash, hashDistance, peopleCategory, peopleLabel } from './stacking-model.js';

const el = (id) => document.getElementById(id);
let view, loaded = 0, current, result, focused = null, viewerIndex = 0, requestId = 0;
let currentGroup, refreshing = false, refreshController;
let ranking = null, rankingController, rankingId = 0, rankPanel;
const personLabels = new Map();
const cards = new Map();
const colors = ['#648cea', '#bc8b47', '#4baca0', '#b884c9', '#d17c74', '#8da84e'];
const date = (value) => value === null ? 'Unknown capture date' : new Date(value).toLocaleString();
const seconds = (value) => `${Math.round(value / 100) / 10} s`;
function error(id, message = '') { el(id).textContent = message; el(id).hidden = !message; }

async function build() {
  if (!el('baseline').reportValidity()) return;
  el('build').disabled = true; el('more').disabled = true;
  error('error');
  try {
    const value = await request('lab/views', { gapSeconds: Number(el('baseline-gap').value), sort: el('sort').value });
    view = value; loaded = 0; el('groups').replaceChildren();
    append(value);
  } catch (e) {
    error('error', e.message);
    if (view) { el('baseline-gap').value = view.gapSeconds; el('sort').value = view.sort; }
    else el('count').textContent = 'No time groups loaded. Try building them again.';
  } finally { el('build').disabled = false; el('more').disabled = false; }
}
function append(value) {
  for (const group of value.groups) {
    const button = node('button', undefined, 'group-card');
    button.dataset.groupId = group.id;
    const cover = node('div', undefined, 'cover');
    const img = node('img'); img.src = thumbnail(group.photo.id); img.alt = ''; img.loading = 'lazy';
    cover.append(img, node('span', `${group.memberCount} photo${group.memberCount === 1 ? '' : 's'}`, 'p-chip'));
    const caption = node('div', undefined, 'group-caption');
    caption.append(node('strong', date(group.first)), node('span', group.photo.filename, 'filename'),
      node('small', group.memberCount > 1 ? `${seconds(group.last - group.first)} span · Explore group` : 'Single photo · Inspect evidence'));
    button.append(cover, caption); button.onclick = () => open(group);
    el('groups').append(button);
  }
  loaded += value.groups.length; view.nextOffset = value.nextOffset;
  el('more').hidden = value.nextOffset === null;
  el('count').textContent = `${loaded} of ${value.total} time groups shown · ${value.photoCount} pending photos · ${value.gapSeconds} s starting gap`;
  el('snapshot-note').textContent = `Snapshot of locally cached evidence. Rebuild to include new photos or metadata.${value.unavailable ? ` ${value.unavailable} unavailable photos excluded.` : ''}`;
}

async function open(group) {
  const token = ++requestId;
  rankPanel?.dispose(); rankPanel = null;
  refreshController?.abort();
  rankingController?.abort(); rankingId++; ranking = null;
  el('check-ranking').textContent = 'Check similarity ranking';
  el('check-ranking').disabled = group.memberCount < 2;
  el('ranking-status').textContent = group.memberCount < 2 ? 'Choose a group with at least two photos.' : 'Only searches when you click. Results are reused for 10 minutes.';
  refreshing = false;
  currentGroup = group.id; personLabels.clear();
  current = null; cards.clear(); focused = null;
  el('experiment-content').hidden = true;
  el('experiment-title').textContent = `Explore ${group.memberCount} photo${group.memberCount === 1 ? '' : 's'}`;
  el('experiment-subtitle').textContent = 'Loading complete time group…';
  error('experiment-error'); el('experiment').showModal();
  try {
    const value = await request(`lab/comparison?${new URLSearchParams({ viewId: view.viewId, groupId: group.id })}`);
    if (token !== requestId || !el('experiment').open) return;
    current = { ...value, photos: value.photos.map(p => ({ ...p, recognizedIds: null, recognitionStatus: 'loading' })) };
    el('experiment-subtitle').textContent = `${date(value.photos[0].time)} · ${value.photos.length} photos · Testing only`;
    el('experiment-content').hidden = false;
    el('lab-photos').replaceChildren();
    for (const photo of current.photos) {
      const card = node('article', undefined, 'photo-card'); card.dataset.photoId = photo.id;
      const button = node('button', undefined, 'photo-image');
      const image = node('img'); image.src = thumbnail(photo.id); image.alt = photo.filename; image.loading = 'lazy';
      const badge = node('span', '', 'photo-outcome'); button.append(image, badge);
      button.setAttribute('aria-label', `Highlight group containing ${photo.filename}`);
      button.onclick = () => { focused = focused === photo.id ? null : photo.id; renderResult(); };
      const info = node('div', undefined, 'lab-info');
      const file = node('strong', `Photo ${current.photos.indexOf(photo) + 1} · ${photo.filename}`, 'filename'); file.title = photo.filename;
      const facts = node('p', date(photo.time), 'p-muted');
      const people = node('p', `Enrich people: ${peopleLabel(photo)}`, 'lab-people');
      const recognition = node('p', 'Loading recognition data…', 'lab-recognition p-muted');
      const checked = node('p', '', 'lab-checked p-muted');
      const rank = node('p', '', 'lab-ranking'); rank.hidden = true;
      const reason = node('p', '', 'lab-reason'), distance = node('p', '', 'lab-distance p-muted');
      const larger = node('button', 'View larger', 'p-btn quiet');
      larger.onclick = () => showPhoto(current.photos.findIndex(p => p.id === photo.id));
      const failed = node('p', 'Preview unavailable; try Immich.', 'p-muted'); failed.hidden = true;
      image.onerror = () => { failed.hidden = false; };
      info.append(file, facts, people, recognition, checked, rank, reason, distance, larger, failed); card.append(button, info);
      el('lab-photos').append(card); cards.set(photo.id, { card, button, badge, reason, distance, recognition, checked, rank });
    }
    rankPanel = new RankComparison({ root: el('rank-comparison'), tableRoot: el('rank-table'), viewId: view.viewId, groupId: currentGroup,
      photos: current.photos, onChange: recalculate,
      onBusy: busy => { el('check-ranking').disabled = busy || !!ranking || current.photos.length < 2; },
      onFocus: id => { focused = id; renderResult(); } });
    reset();
    void refreshRecognition();
  } catch (e) { if (token === requestId) { error('experiment-error', e.message); el('experiment-subtitle').textContent = 'Could not open this time group.'; } }
}

async function checkRanking() {
  if (!current || current.photos.length < 2) return;
  const token = ++rankingId;
  rankingController?.abort(); rankingController = new AbortController();
  el('check-ranking').disabled = true;
  el('ranking-status').textContent = 'Searching Immich…';
  try {
    const value = await request('lab/ranking', { viewId: view.viewId, groupId: currentGroup }, { signal: rankingController.signal });
    if (token !== rankingId || !el('experiment').open) return;
    ranking = value;
    void rankPanel?.prepare();
    const ranks = new Map(value.photos.map(p => [p.id, p.rank]));
    for (const photo of current.photos) {
      const rank = ranks.get(photo.id), item = cards.get(photo.id);
      item.rank.hidden = false;
      item.rank.textContent = photo.id === value.referenceId ? 'Similarity search reference · earliest photo'
        : rank !== null && rank !== undefined ? `Immich similarity rank: #${rank}`
        : value.returned === value.limit ? `Not in the first ${value.limit} results`
        : `Not in the ${value.returned} returned results`;
    }
    el('ranking-status').textContent = `${value.returned} results · Search took ${(value.elapsedMs / 1000).toFixed(2)} s · Checked ${date(value.checkedAt)}${value.cached ? ' · Reused result' : ''}`;
    el('check-ranking').textContent = 'Ranking checked';
  } catch (e) {
    if (token !== rankingId || !el('experiment').open) return;
    el('ranking-status').textContent = e.message;
    el('check-ranking').disabled = false;
  }
}

async function refreshRecognition() {
  if (!current) return;
  const token = ++requestId;
  let refreshError = '';
  refreshController?.abort();
  refreshController = new AbortController();
  refreshing = true;
  el('refresh-recognition').disabled = true;
  el('recognition-status').textContent = `Loading recognition data for ${current.photos.length} photos…`;
  for (const input of document.querySelectorAll('.lab-settings input')) input.disabled = true;
  el('reset').disabled = el('copy').disabled = true;
  for (const item of cards.values()) { item.recognition.textContent = 'Loading recognition data…'; item.checked.textContent = ''; }
  try {
    const refreshed = await request('lab/recognition', { viewId: view.viewId, groupId: currentGroup }, { signal: refreshController.signal });
    if (token !== requestId || !el('experiment').open) return;
    current = refreshed;
  } catch (e) {
    if (token !== requestId || !el('experiment').open) return;
    current = { ...current, photos: current.photos.map(p => ({ ...p, recognizedIds: null,
      recognitionStatus: 'failed', recognitionCheckedAt: null })) };
    refreshError = e.message;
  } finally {
    if (token === requestId && el('experiment').open) {
      refreshing = false;
      el('refresh-recognition').disabled = el('reset').disabled = false;
      for (const input of document.querySelectorAll('.lab-settings input')) input.disabled = false;
      renderRecognition(refreshError); recalculate();
    }
  }
}
function renderRecognition(refreshError = '') {
  const loaded = current.photos.filter(p => p.recognitionStatus === 'loaded').length;
  el('recognition-status').textContent = refreshError || (loaded === current.photos.length
    ? 'Recognition loaded from Immich. Held fixed for this experiment.'
    : `Recognition available for ${loaded} of ${current.photos.length} photos. Missing data won’t force a split. Refresh to retry.`);
  for (const photo of current.photos) {
    for (const id of photo.recognizedIds ?? []) if (!personLabels.has(id)) personLabels.set(id, `Person ${personLabels.size + 1}`);
    const item = cards.get(photo.id);
    item.recognition.textContent = photo.recognitionStatus === 'failed' ? 'Couldn’t load recognition data'
      : photo.recognitionStatus !== 'loaded' ? 'Recognition data not returned by Immich'
      : photo.recognizedIds.length ? `Immich recognized: ${photo.recognizedIds.map(id => personLabels.get(id)).join(', ')} (may be incomplete)`
      : 'No recognized people returned by Immich';
    item.checked.textContent = photo.recognitionCheckedAt ? `Checked ${date(photo.recognitionCheckedAt)}` :
      ({ permission: 'Check Immich access permissions.', connection: 'Could not reach Immich.',
        'not-configured': 'Immich connection not configured.', unavailable: 'Photo unavailable in Immich.',
        interrupted: 'Refresh interrupted or timed out; retry when ready.', changed: 'Photo information changed; refresh to retry.',
        'invalid-response': 'Immich returned unusable photo information.', 'storage-error': 'Could not save photo information.' }[photo.recognitionOutcome] ?? '');
  }
}

function settings() {
  return { gapMs: Number(el('gap').value) * 1000,
    spanMs: el('use-span').checked ? Number(el('span').value) * 1000 : null,
    thumbhash: el('use-hash').checked, threshold: Number(el('threshold').value), people: el('use-people').checked,
    identities: el('use-identities').checked, ranks: el('use-ranks').checked,
    nearHash: el('use-hash').checked ? Number(el('near-hash').value) : COMBINED_DEFAULTS.nearHash, farHash: el('use-hash').checked ? Number(el('far-hash').value) : COMBINED_DEFAULTS.farHash,
    outsideLimit: el('use-ranks').checked ? Number(el('rank-cutoff').value) : COMBINED_DEFAULTS.outsideLimit, rankContrast: el('use-ranks').checked ? Number(el('rank-contrast').value) : COMBINED_DEFAULTS.rankContrast, combined: el('combined-mode').checked };
}
function reset() {
  el('gap').value = current.gapSeconds; el('gap').max = current.gapSeconds;
  el('span').value = 180; el('threshold').value = 0.1;
  for (const id of ['use-span', 'use-hash', 'use-people', 'use-identities', 'use-ranks', 'combined-mode']) el(id).checked = false;
  el('near-hash').value = COMBINED_DEFAULTS.nearHash; el('far-hash').value = COMBINED_DEFAULTS.farHash;
  el('rank-cutoff').value = COMBINED_DEFAULTS.outsideLimit; el('rank-contrast').value = COMBINED_DEFAULTS.rankContrast;
  focused = null; recalculate();
}
function recalculate() {
  if (!current || refreshing) return;
  const combined = el('combined-mode').checked;
  el('use-ranks').disabled = !combined;
  el('rank-cutoff').disabled = el('rank-contrast').disabled = !combined || !el('use-ranks').checked;
  el('near-hash').disabled = el('far-hash').disabled = !combined || !el('use-hash').checked;
  for (const hint of document.querySelectorAll('.combined-hint')) hint.hidden = !combined;
  el('mode-hint').textContent = combined
    ? el('use-identities').checked ? 'Signals combine; recognized people must still match.' : 'Signals combine; uncertain matches stay provisional.'
    : 'Each enabled rule must pass. Combine evidence to use ranks.';
  for (const hint of document.querySelectorAll('.strict-hint')) hint.hidden = combined;
  el('span').disabled = !el('use-span').checked;
  el('threshold').disabled = combined || !el('use-hash').checked;
  el('threshold-value').textContent = Number(el('threshold').value).toFixed(3);
  if (!el('gap').value || !el('gap').checkValidity() || (el('use-span').checked && (!el('span').value || !el('span').checkValidity())) || (combined && ((el('use-hash').checked && (['near-hash', 'far-hash'].some(id => !el(id).value || !el(id).checkValidity()) || Number(el('near-hash').value) >= Number(el('far-hash').value))) || (el('use-ranks').checked && ['rank-cutoff', 'rank-contrast'].some(id => !el(id).value || !el(id).checkValidity()))))) {
    error('experiment-error', 'Enter valid time limits, ordered ThumbHash bands, and rank limits. Results below still use the previous settings.');
    el('copy').disabled = true; return;
  }
  error('experiment-error'); el('copy').disabled = false;
  result = combined ? combinedPartition(current.photos, settings(), rankPanel?.evidence) : partition(current.photos, settings()); renderResult();
}
function renderResult() {
  if (!result) return;
  const group = focused ? result.byPhoto.get(focused) : null;
  const anchor = current.photos.find((p) => p.id === focused);
  const sizes = result.groups.map((g) => g.length);
  el('result').textContent = `${current.photos.length} photos → ${sizes.length} group${sizes.length === 1 ? '' : 's'} (${sizes.join(' + ')})`;
  el('combined-summary').textContent = result.summaries ? result.summaries.map((text, i) => `Group ${i + 1}: ${text}`).join(' · ') : '';
  const evidence = el('pair-evidence'); evidence.replaceChildren();
  if (result.pair && anchor) {
    evidence.append(node('p', 'Pair evidence for the highlighted photo (arrows follow the photo-number order):', 'p-muted'));
    for (const other of current.photos) if (other.id !== anchor.id) {
      const i = current.photos.indexOf(anchor), j = current.photos.indexOf(other);
      const pair = result.pair(anchor.id, other.id);
      evidence.append(node('p', `Photos ${Math.min(i, j) + 1} ↔ ${Math.max(i, j) + 1}: ${pair.state === 'separate' ? 'separation proposed' : pair.state}. ${pair.reason}. ${pair.notes.join(' · ')}`));
    }
  }
  el('focus-help').textContent = group ? `Group ${group} highlighted. Dimmed photos stay included.` : 'Click a photo to highlight its group.';
  el('clear-focus').disabled = !focused;
  const unknownHash = current.photos.filter((p) => !decodeHash(p.thumbhash)).length;
  const unknownPeople = current.photos.filter((p) => peopleCategory(p) === null).length;
  const noIdentities = current.photos.filter((p) => !p.recognizedIds?.length).length;
  el('evidence-note').textContent = `Missing ThumbHash: ${unknownHash} · Unknown Enrich people categories: ${unknownPeople} · Photos without recognized identities: ${noIdentities}. Photo links open Immich from the larger viewer.`;
  for (const photo of current.photos) {
    const item = cards.get(photo.id), number = result.byPhoto.get(photo.id);
    item.card.style.setProperty('--group-color', colors[(number - 1) % colors.length]);
    item.card.dataset.partition = number;
    item.card.classList.toggle('dimmed', group !== null && number !== group);
    item.card.classList.toggle('anchor', focused === photo.id);
    item.button.setAttribute('aria-pressed', String(focused === photo.id));
    item.badge.textContent = `Group ${number} · ${result.groups[number - 1].length} photo${result.groups[number - 1].length === 1 ? '' : 's'}`;
    item.reason.textContent = [result.reasons.get(photo.id), result.summaries?.[number - 1]].filter(Boolean).join('. ');
    const distance = anchor ? hashDistance(decodeHash(anchor.thumbhash), decodeHash(photo.thumbhash)) : null;
    item.distance.textContent = anchor ? photo.id === anchor.id ? 'Highlighted reference photo' :
      `ThumbHash distance to reference: ${distance === null ? 'unknown' : distance.toFixed(3)}` : '';
  }
}

function showPhoto(index) {
  viewerIndex = index;
  const photo = current.photos[index];
  el('viewer-title').textContent = photo.filename;
  el('viewer-position').textContent = `${index + 1} of ${current.photos.length}`;
  el('viewer-image').src = thumbnail(photo.id); el('viewer-image').alt = photo.filename;
  el('previous').disabled = index === 0; el('next').disabled = index === current.photos.length - 1;
  el('immich').hidden = true; el('immich').removeAttribute('href');
  try {
    const url = new URL(current.immichUrl);
    if (['http:', 'https:'].includes(url.protocol)) {
      el('immich').href = `${url.href.replace(/\/$/, '')}/photos/${encodeURIComponent(photo.id)}`;
      el('immich').hidden = false;
    }
  } catch { /* No configured public Immich URL. */ }
  if (!el('lab-viewer').open) el('lab-viewer').showModal();
}
el('baseline').onsubmit = (event) => { event.preventDefault(); build(); };
el('more').onclick = async () => {
  el('more').disabled = true; el('build').disabled = true; error('error');
  try { append(await request(`lab/groups?${new URLSearchParams({ viewId: view.viewId, offset: view.nextOffset })}`)); }
  catch (e) { error('error', e.message); }
  finally { el('more').disabled = false; el('build').disabled = false; }
};
for (const input of document.querySelectorAll('.lab-settings input')) input.addEventListener('input', recalculate);
el('reset').onclick = reset;
el('refresh-recognition').onclick = refreshRecognition;
el('check-ranking').onclick = checkRanking;
el('clear-focus').onclick = () => { focused = null; renderResult(); };
el('copy').onclick = async () => {
  const s = settings();
  const rankSummary = ranking ? `\nImmich similarity ranking (earliest reference; timeline images; first 50 excluding reference)\n${el('ranking-status').textContent}\n${current.photos.map((p, i) => `Photo ${i + 1}: ${cards.get(p.id).rank.textContent}`).join('\n')}` : '';
  const hashSummary = !s.thumbhash ? 'off' : s.combined ? `very close ≤ ${s.nearHash.toFixed(3)}, clearly different ≥ ${s.farHash.toFixed(3)}` : `${s.threshold.toFixed(3)} (every pair)`;
  const text = `Stacking lab (experimental)\nStarting gap: ${current.gapSeconds} s\nGap: ${s.gapMs / 1000} s; span: ${s.spanMs === null ? 'unlimited' : s.spanMs / 1000 + ' s'}\nThumbHash: ${hashSummary}; Enrich people categories (none/one/couple/group): ${s.people ? 'on' : 'off'}\nDifferent recognized people (nonempty lists with no identities in common): ${s.identities ? 'on' : 'off'}\n${el('recognition-status').textContent}\n${el('result').textContent}\n${el('evidence-note').textContent.split('. Photo links')[0]}${rankSummary}\nMode: ${s.combined ? 'Combined evidence (experimental)' : 'Individual filters'}; outside photos ahead / minimum contrast: ${s.ranks && s.combined ? `${s.outsideLimit} / ${s.rankContrast}` : 'off'}\n${el('combined-summary').textContent}\n${rankPanel?.summary() ?? ''}\n${[...el('pair-evidence').children].map(p => p.textContent).join('\n')}`;
  try {
    if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
    else {
      const area = node('textarea', text); el('experiment').append(area); area.select();
      const copied = document.execCommand('copy'); area.remove();
      if (!copied) throw Error('Clipboard unavailable.');
    }
    el('copy').textContent = 'Copied'; setTimeout(() => { el('copy').textContent = 'Copy'; }, 2000);
  } catch { error('experiment-error', 'Could not copy the summary in this browser.'); }
};
for (const button of document.querySelectorAll('[data-close]')) button.onclick = () => el(button.dataset.close).close();
for (const dialog of document.querySelectorAll('dialog')) {
  let backdrop = false;
  dialog.addEventListener('pointerdown', (e) => { backdrop = e.target === dialog; });
  dialog.addEventListener('click', (e) => { if (backdrop && e.target === dialog) dialog.close(); });
}
el('experiment').addEventListener('close', () => {
  // Native close events are queued. A quickly reopened dialog owns a new
  // request already; the old close must not cancel that request.
  if (!el('experiment').open) {
    requestId++; refreshController?.abort(); refreshing = false;
    rankingId++; rankingController?.abort(); rankPanel?.dispose();
  }
});
el('previous').onclick = () => showPhoto(viewerIndex - 1);
el('next').onclick = () => showPhoto(viewerIndex + 1);
el('lab-viewer').addEventListener('keydown', (e) => {
  if (e.key === 'ArrowLeft' && viewerIndex > 0) { e.preventDefault(); showPhoto(viewerIndex - 1); }
  if (e.key === 'ArrowRight' && viewerIndex + 1 < current.photos.length) { e.preventDefault(); showPhoto(viewerIndex + 1); }
});
build();
