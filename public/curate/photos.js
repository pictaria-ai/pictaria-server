export function node(tag, text, className) {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
}
export const thumbnail = (id) => `/api/review/thumbnail/${encodeURIComponent(id)}`;

export const choices = [
  ['approve', 'Yes', 'Keep for display'],
  ['reviewed', 'Skip', 'Mark reviewed without keeping'],
  ['favorite', 'Fav', 'Keep as a favorite'],
  ['reject', 'No', 'Never show'],
];
export function savedOutcome(photo) {
  return photo?.state === 'approved' ? (photo.favorite || photo.tags?.includes('frame/favorite') ? 'favorite' : 'approve')
    : { reviewed: 'reviewed', rejected: 'reject' }[photo?.state] ?? null;
}
export const outcomeLabel = (value) => choices.find(([key]) => key === value)?.[1] ?? 'Not decided';

export function photoCard(
  photo,
  { readOnly = false, label = 'Photo', outcome = () => 'reviewed', change, open,
    selected = () => false, select, imageState = () => {} },
) {
  const card = node('article', undefined, 'photo-card');
  card.dataset.photoId = photo.id;
  card.tabIndex = readOnly ? -1 : 0;
  card.setAttribute('aria-label', label);
  const imageButton = node('button', undefined, 'photo-image');
  imageButton.type = 'button';
  const img = node('img');
  img.src = thumbnail(photo.id); img.alt = photo.caption || label; img.loading = 'lazy';
  imageButton.append(img);
  imageButton.dataset.view = photo.id;
  imageButton.setAttribute('aria-label', `View ${label}`);
  imageButton.onclick = () => open(photo);
  const info = node('div', undefined, 'photo-info');
  let checkbox;
  if (readOnly) {
    imageButton.append(node('span', 'Already kept', 'photo-outcome'));
  } else {
    const selection = node('label', undefined, 'photo-selection');
    checkbox = node('input'); checkbox.type = 'checkbox'; checkbox.dataset.compareSelect = photo.id;
    checkbox.setAttribute('aria-label', `Check ${label}`);
    checkbox.onchange = () => select?.(checkbox.checked);
    selection.append(checkbox); card.append(selection);
    const actions = node('div', undefined, 'photo-choices');
    actions.setAttribute('role', 'group'); actions.setAttribute('aria-label', `Choices for ${label}`);
    for (const [value, text, title] of choices) {
      const button = node('button', text, `p-btn${value === 'favorite' ? ' gold' : value === 'reject' ? ' danger' : ''}`);
      button.dataset.choice = value; button.title = title;
      if (value === 'approve') button.dataset.keeper = photo.id;
      button.onclick = () => change(value);
      actions.append(button);
    }
    info.append(node('small', label, 'photo-label'), actions, node('small', '', 'draft-outcome'));
  }
  const imageError = node('span', 'Preview unavailable. Try opening it in Immich.', 'p-muted');
  imageError.hidden = true;
  img.onerror = () => { imageError.hidden = false; imageState(false); };
  img.onload = () => { imageError.hidden = true; imageState(true); };
  info.append(imageError);
  card.syncSelection = () => {
    if (readOnly) return;
    info.querySelector('.draft-outcome').textContent = `Draft: ${outcomeLabel(outcome())}`;
    for (const button of info.querySelectorAll('[data-choice]'))
      button.setAttribute('aria-pressed', String(button.dataset.choice === outcome()));
    card.classList.toggle('selected', ['approve', 'favorite'].includes(outcome()));
    card.classList.toggle('batch-selected', selected()); checkbox.checked = selected();
  };
  card.syncSelection();
  card.append(imageButton, info);
  return card;
}

export function groupSimilarity(group, status = group?.similarity) {
  return status ?? (group?.route === 'candidate-unconfirmed' ? { state: 'unavailable' }
    : group?.route === 'manual-budget' ? { state: 'limited' }
    : ['candidate-supported', 'single'].includes(group?.route) ? { state: 'local' } : null);
}
function similarityPhase(status) {
  if (!status) return null;
  if (status.paused || ['incomplete', 'paused', 'limited', 'unavailable'].includes(status.state)) return 'limited';
  if (status.state === 'checking' || status.checking) return 'checking';
  if (status.state === 'waiting' || status.state === 'updated' && status.pending) return 'waiting';
  return status.uncertain ? 'limited' : null;
}
export function similarityLabel(status) {
  switch (similarityPhase(status)) {
    case 'limited': return 'Grouped with limited evidence';
    case 'waiting': return 'Checking similarity · queued';
    case 'checking': return 'Checking similarity' + (Number.isFinite(status.done) && Number.isFinite(status.total)
      ? ` · ${status.done} of ${status.total}` : '');
    default: return ['checked', 'local'].includes(status?.state) ? 'Ready to curate'
      : status?.state === 'updated' ? 'Updated grouping available' : '';
  }
}
export function similarityDetail(status) {
  let detail = '';
  switch (status?.state) {
    case 'waiting': detail = 'These nearby photos are waiting for a check slot.'; break;
    case 'checking': detail = 'Similarity searches are running for these nearby photos.'; break;
    case 'incomplete': detail = 'Similarity checking could not finish.'; break;
    case 'paused': detail = 'Similarity checking is paused.'; break;
    case 'limited': detail = status.total ? 'Saved check storage is full.' : 'These photos reached an automatic checking limit.'; break;
    case 'unavailable': detail = 'Similarity searches are unavailable for this group.'; break;
    case 'checked': detail = status.uncertain
      ? 'Similarity searches finished, but the evidence was inconclusive.' : 'Similarity checking finished.'; break;
    case 'local': detail = 'No similarity search was needed.'; break;
    case 'updated': detail = 'An updated grouping is available. This view keeps its current photos.'; break;
  }
  return [detail, status?.problem].filter(Boolean).join(' ');
}

export function similarityIndicator(status, { warning = false } = {}) {
  const label = similarityLabel(status);
  // Per-stack limitations are quiet information. Only overall paused work uses a warning.
  const phase = warning ? 'attention' : similarityPhase(status);
  if (!label || !phase) return null;
  const indicator = node('span', phase === 'attention' ? '!' : phase === 'limited' ? 'i' : '', 'similarity-indicator');
  indicator.dataset.phase = phase;
  indicator.setAttribute('role', 'img');
  indicator.title = [label, similarityDetail(status)].filter(Boolean).join('. ');
  indicator.setAttribute('aria-label', indicator.title);
  return indicator;
}

export function groupCard(group, open, { decide, select, selected = false, decided = false, label = 'Photo' } = {}) {
  const card = node('article', undefined, 'group-card');
  card.dataset.groupId = group.id;
  const photo = group.photos[0];
  const cover = node('button', undefined, 'cover');
  cover.type = 'button';
  cover.setAttribute('aria-label', group.memberCount > 1 ? `Compare ${group.memberCount} photos: ${photo.caption || label}` : `View ${photo.caption || label}`);
  const img = node('img'); img.src = thumbnail(photo.id); img.alt = ''; img.loading = 'lazy';
  const chip = node('span', undefined, 'p-chip');
  const marker = node('span', undefined, 'similarity-marker');
  cover.append(img, chip, marker);
  const caption = node('div', undefined, 'group-caption');
  if (photo.caption) {
    const description = node('span', photo.caption, 'photo-caption');
    description.title = photo.caption;
    caption.append(description);
  }
  const meta = node('div', undefined, 'card-meta');
  const date = node('small', photo.capturedAt
    ? new Date(photo.capturedAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '', 'capture-date');
  date.title = date.textContent;
  const status = node('small', undefined, 'similarity-status');
  meta.append(date, status);
  caption.append(meta);
  const actions = node('div', undefined, 'card-actions');
  if (group.memberCount > 1) {
    card.classList.add('is-stack');
    const strip = node('button', undefined, 'stack-strip');
    strip.type = 'button'; strip.setAttribute('aria-label', `Compare ${group.memberCount} photos`);
    for (const member of group.photos.slice(0, 3)) {
      const preview = node('img'); preview.src = thumbnail(member.id); preview.alt = ''; preview.loading = 'lazy';
      strip.append(preview);
    }
    if (group.memberCount > 3) strip.append(node('span', `+${group.memberCount - 3}`));
    strip.onclick = event => { event.stopPropagation(); open(group); }; caption.prepend(strip);
  } else {
    for (const [value,text,title] of choices) {
      const button = node('button', text, `p-btn${value === 'favorite' ? ' gold' : value === 'reject' ? ' danger' : ''}`);
      const current = decided && savedOutcome(photo) === value;
      button.dataset.quick = value; button.title = current ? `Current decision: ${text}` : title;
      button.setAttribute('aria-pressed', String(current));
      button.onclick = () => decide?.(group,value); actions.append(button);
    }
    const selection = node('label',undefined,'card-selection'), check = node('input');
    check.type = 'checkbox'; check.checked = selected; check.dataset.select = group.id;
    check.setAttribute('aria-label',`Check ${photo.caption || label}`);
    check.onchange = () => select?.(group,check.checked); selection.append(check); card.append(selection);
  }
  if (actions.childElementCount) caption.append(actions);
  card.updateSimilarity = (value) => {
    if (decided) {
      chip.hidden = true;
      date.hidden = false;
      status.hidden = true; return;
    }
    group.similarity = value;
    value = groupSimilarity(group, value);
    chip.textContent = group.memberCount > 1 ? `${group.memberCount} photos` : 'Single photo';
    const label = similarityLabel(value);
    const indicator = similarityIndicator(value);
    if (status.textContent !== label) status.textContent = label;
    status.title = label;
    // Progress temporarily replaces the date. Settled/incomplete details stay
    // on the cover icon, so neither status changes nor long labels grow cards.
    const active = indicator && ['waiting', 'checking'].includes(indicator.dataset.phase);
    date.hidden = Boolean(active);
    status.hidden = !active;
    if (marker.firstChild?.title !== indicator?.title || marker.firstChild?.dataset.phase !== indicator?.dataset.phase)
      marker.replaceChildren(...(indicator ? [indicator] : []));
    card.dataset.similarity = value?.state ?? '';
  };
  card.updateSimilarity(group.similarity);
  cover.onclick = () => open(group);
  card.append(cover, caption);
  // The article itself remains a convenient programmatic entry point; child
  // actions never bubble into opening a second interaction.
  card.onclick = event => {
    if (event.target === card || group.memberCount > 1 && caption.contains(event.target)) open(group);
  };
  return card;
}
