import { request } from './client.js';
import { node, thumbnail } from './photos.js';
import { partition, decodeHash, hashDistance, peopleCategory, peopleLabel } from './stacking-model.js';

const el = (id) => document.getElementById(id);
let view, loaded = 0, current, result, focused = null, viewerIndex = 0, requestId = 0;
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
  current = null; cards.clear(); focused = null;
  el('experiment-content').hidden = true;
  el('experiment-title').textContent = `Explore ${group.memberCount} photo${group.memberCount === 1 ? '' : 's'}`;
  el('experiment-subtitle').textContent = 'Loading complete time group…';
  error('experiment-error'); el('experiment').showModal();
  try {
    const value = await request(`lab/comparison?${new URLSearchParams({ viewId: view.viewId, groupId: group.id })}`);
    if (token !== requestId || !el('experiment').open) return;
    current = value;
    el('experiment-subtitle').textContent = `${date(value.photos[0].time)} · ${value.photos.length} photos · Testing only`;
    el('experiment-content').hidden = false;
    el('lab-photos').replaceChildren();
    const personLabels = new Map();
    for (const photo of value.photos) for (const id of photo.recognizedIds ?? []) {
      if (!personLabels.has(id)) personLabels.set(id, `Person ${personLabels.size + 1}`);
    }
    for (const photo of value.photos) {
      const card = node('article', undefined, 'photo-card'); card.dataset.photoId = photo.id;
      const button = node('button', undefined, 'photo-image');
      const image = node('img'); image.src = thumbnail(photo.id); image.alt = photo.filename; image.loading = 'lazy';
      const badge = node('span', '', 'photo-outcome'); button.append(image, badge);
      button.setAttribute('aria-label', `Highlight group containing ${photo.filename}`);
      button.onclick = () => { focused = focused === photo.id ? null : photo.id; renderResult(); };
      const info = node('div', undefined, 'lab-info');
      const file = node('strong', photo.filename, 'filename'); file.title = photo.filename;
      const facts = node('p', date(photo.time), 'p-muted');
      const people = node('p', `Enrich people: ${peopleLabel(photo)}`, 'lab-people');
      const recognized = photo.recognizedIds?.map((id) => personLabels.get(id));
      const recognition = node('p', `Immich recognized: ${recognized === undefined ? 'unknown' :
        recognized.length ? recognized.join(', ') : 'none identified'} (may be incomplete)`, 'lab-recognition p-muted');
      const reason = node('p', '', 'lab-reason'), distance = node('p', '', 'lab-distance p-muted');
      const larger = node('button', 'View larger', 'p-btn quiet');
      larger.onclick = () => showPhoto(value.photos.indexOf(photo));
      const failed = node('p', 'Preview unavailable; try Immich.', 'p-muted'); failed.hidden = true;
      image.onerror = () => { failed.hidden = false; };
      info.append(file, facts, people, recognition, reason, distance, larger, failed); card.append(button, info);
      el('lab-photos').append(card); cards.set(photo.id, { card, button, badge, reason, distance });
    }
    reset();
  } catch (e) { if (token === requestId) { error('experiment-error', e.message); el('experiment-subtitle').textContent = 'Could not open this time group.'; } }
}

function settings() {
  return { gapMs: Number(el('gap').value) * 1000,
    spanMs: el('use-span').checked ? Number(el('span').value) * 1000 : null,
    thumbhash: el('use-hash').checked, threshold: Number(el('threshold').value), people: el('use-people').checked,
    identities: el('use-identities').checked };
}
function reset() {
  el('gap').value = current.gapSeconds; el('gap').max = current.gapSeconds;
  el('span').value = 180; el('threshold').value = 0.1;
  for (const id of ['use-span', 'use-hash', 'use-people', 'use-identities']) el(id).checked = false;
  focused = null; recalculate();
}
function recalculate() {
  if (!current) return;
  el('span').disabled = !el('use-span').checked;
  el('threshold').disabled = !el('use-hash').checked;
  el('threshold-value').textContent = Number(el('threshold').value).toFixed(3);
  if (!el('gap').value || !el('gap').checkValidity() || (el('use-span').checked && (!el('span').value || !el('span').checkValidity()))) {
    error('experiment-error', 'Enter a valid gap and span. Results below still use the previous settings.');
    el('copy').disabled = true; return;
  }
  error('experiment-error'); el('copy').disabled = false;
  result = partition(current.photos, settings()); renderResult();
}
function renderResult() {
  if (!result) return;
  const group = focused ? result.byPhoto.get(focused) : null;
  const anchor = current.photos.find((p) => p.id === focused);
  const sizes = result.groups.map((g) => g.length);
  el('result').textContent = `${current.photos.length} photos → ${sizes.length} group${sizes.length === 1 ? '' : 's'} (${sizes.join(' + ')})`;
  el('focus-help').textContent = group ? `Group ${group} highlighted. Click another photo to compare; dimmed photos are still included.` : 'Click a photo to highlight its proposed group. Dimmed photos stay in the experiment.';
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
    item.reason.textContent = result.reasons.get(photo.id);
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
el('clear-focus').onclick = () => { focused = null; renderResult(); };
el('copy').onclick = async () => {
  const s = settings();
  const text = `Stacking lab (experimental)\nStarting gap: ${current.gapSeconds} s\nGap: ${s.gapMs / 1000} s; span: ${s.spanMs === null ? 'unlimited' : s.spanMs / 1000 + ' s'}\nThumbHash: ${s.thumbhash ? s.threshold.toFixed(3) + ' (every pair)' : 'off'}; Enrich people categories (none/one/couple/group): ${s.people ? 'on' : 'off'}\nDifferent recognized people (nonempty lists with no identities in common): ${s.identities ? 'on' : 'off'}\n${el('result').textContent}\n${el('evidence-note').textContent.split('. Photo links')[0]}`;
  try {
    if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
    else {
      const area = node('textarea', text); el('experiment').append(area); area.select();
      const copied = document.execCommand('copy'); area.remove();
      if (!copied) throw Error('Clipboard unavailable.');
    }
    el('copy').textContent = 'Copied'; setTimeout(() => { el('copy').textContent = 'Copy experiment summary'; }, 2000);
  } catch { error('experiment-error', 'Could not copy the summary in this browser.'); }
};
for (const button of document.querySelectorAll('[data-close]')) button.onclick = () => el(button.dataset.close).close();
for (const dialog of document.querySelectorAll('dialog')) {
  let backdrop = false;
  dialog.addEventListener('pointerdown', (e) => { backdrop = e.target === dialog; });
  dialog.addEventListener('click', (e) => { if (backdrop && e.target === dialog) dialog.close(); });
}
el('experiment').addEventListener('close', () => { requestId++; });
el('previous').onclick = () => showPhoto(viewerIndex - 1);
el('next').onclick = () => showPhoto(viewerIndex + 1);
el('lab-viewer').addEventListener('keydown', (e) => {
  if (e.key === 'ArrowLeft' && viewerIndex > 0) { e.preventDefault(); showPhoto(viewerIndex - 1); }
  if (e.key === 'ArrowRight' && viewerIndex + 1 < current.photos.length) { e.preventDefault(); showPhoto(viewerIndex + 1); }
});
build();
