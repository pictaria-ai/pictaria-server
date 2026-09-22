export function node(tag, text, className) {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
}
export const thumbnail = (id) => `/api/review/thumbnail/${encodeURIComponent(id)}`;

export function photoCard(
  photo,
  { readOnly = false, outcome = () => 'reviewed', change, open, imageState = () => {} },
) {
  const card = node('article', undefined, 'photo-card');
  card.dataset.photoId = photo.id;
  const imageButton = node('button', undefined, 'photo-image');
  imageButton.type = 'button';
  const img = node('img');
  img.src = thumbnail(photo.id);
  img.alt = photo.caption || photo.filename;
  img.loading = 'lazy';
  const badge = node('span', undefined, 'photo-outcome');
  imageButton.append(img, badge);
  const info = node('div', undefined, 'photo-info');
  const file = node('strong', photo.filename, 'filename');
  file.title = photo.filename;
  info.append(file);
  imageButton.dataset.view = photo.id;
  imageButton.setAttribute('aria-label', `View ${photo.filename}`);
  imageButton.onclick = () => open(photo);
  const select = node('button', 'Keep', 'p-btn');
  if (!readOnly) {
    select.dataset.keeper = photo.id;
    select.setAttribute('aria-label', `Keep ${photo.filename}`);
    select.onclick = () => change(['approve', 'favorite'].includes(outcome()) ? 'reviewed' : 'approve');
    info.append(select);
  }
  const imageError = node('span', 'Preview unavailable. Try opening it in Immich.', 'p-muted');
  imageError.hidden = true;
  img.onerror = () => {
    imageError.hidden = false;
    imageState(false);
  };
  img.onload = () => {
    imageError.hidden = true;
    imageState(true);
  };
  info.append(imageError);
  if (readOnly) {
    imageButton.setAttribute('aria-label', `View ${photo.filename}`);
    badge.textContent = 'Already kept';
    imageButton.onclick = () => open(photo);
  }
  card.syncSelection = () => {
    if (readOnly) return;
    const selected = ['approve', 'favorite'].includes(outcome());
    select.setAttribute('aria-pressed', String(selected));
    select.textContent = selected ? '✓ Keep' : 'Keep';
    card.classList.toggle('selected', selected);
    badge.textContent = { approve: '✓ Keep', favorite: '★ Favorite', reviewed: 'Not selected', reject: 'Never show' }[
      outcome()
    ];
  };
  card.syncSelection();
  card.append(imageButton, info);
  return card;
}

export function similarityLabel(status) {
  switch (status?.state) {
    case 'waiting': return 'Waiting for similarity check';
    case 'checking': return `Checking nearby photos · ${status.done} of ${status.total}`;
    case 'paused': return 'Similarity check paused · Refresh to retry';
    case 'limited': return status.total ? 'Waiting for a check slot' : 'Similarity not checked · automatic limit';
    case 'updated': return status.paused ? 'Grouping updated · similarity check paused'
      : status.checking ? 'Grouping updated · checking nearby photos'
      : status.pending ? 'Grouping updated · checks still pending' : 'Updated grouping ready · Refresh to see';
    case 'checked': return status.uncertain ? 'Check complete · similarity uncertain' : 'Similarity checked';
    case 'local': return 'Ready · no similarity search needed';
    case 'unavailable': return 'Similarity not checked';
    default: return '';
  }
}

export function similarityIndicator(status) {
  const label = similarityLabel(status);
  if (!label) return null;
  const state = status.state;
  const phase = status.paused ? 'attention' : state === 'checking' || status.checking ? 'checking'
    : state === 'waiting' || (state === 'updated' && status.pending) ? 'waiting'
    : ['paused', 'limited', 'unavailable'].includes(state) || status.uncertain ? 'attention' : 'done';
  const indicator = node('span', phase === 'done' ? '✓' : phase === 'attention' ? '!' : '', 'similarity-indicator');
  indicator.dataset.phase = phase;
  indicator.setAttribute('role', 'img');
  indicator.setAttribute('aria-label', label);
  indicator.title = label;
  return indicator;
}

export function groupCard(group, open, { decide, select, selected = false, decided = false } = {}) {
  const card = node('article', undefined, 'group-card');
  card.dataset.groupId = group.id;
  const photo = group.photos[0];
  const cover = node('button', undefined, 'cover');
  cover.type = 'button';
  cover.setAttribute('aria-label', group.memberCount > 1 ? `Compare ${group.memberCount} photos: ${photo.caption || photo.filename}` : `View ${photo.caption || photo.filename}`);
  const img = node('img'); img.src = thumbnail(photo.id); img.alt = ''; img.loading = 'lazy';
  const chip = node('span', undefined, 'p-chip');
  const marker = node('span', undefined, 'similarity-marker');
  cover.append(img, chip, marker);
  const caption = node('div', undefined, 'group-caption');
  caption.append(node('span', photo.caption || photo.filename, 'filename'));
  if (photo.capturedAt) caption.append(node('small', new Date(photo.capturedAt).toLocaleDateString()));
  const status = node('small', undefined, 'similarity-status');
  caption.append(status);
  const actions = node('div', undefined, 'card-actions');
  if (group.memberCount > 1) {
    card.classList.add('is-stack');
    const compare = node('button', 'Compare', 'p-btn'); compare.onclick = () => open(group); actions.append(compare);
  } else {
    for (const [value,label] of [['approve','Keep'],['reviewed','Mark reviewed']]) {
      const button = node('button', label, `p-btn${value === 'approve' ? ' primary' : ''}`);
      button.dataset.quick = value; button.onclick = () => decide?.(group,value); actions.append(button);
    }
    const menu = node('details', undefined, 'card-menu'); menu.append(node('summary', 'More', 'p-btn'));
    for (const [value,label] of [['favorite','Favorite'],['reject','Never show']]) {
      const button = node('button',label,'p-btn'); button.onclick = () => decide?.(group,value); menu.append(button);
    }
    actions.append(menu);
    const label = node('label',undefined,'card-selection'), check = node('input');
    check.type = 'checkbox'; check.checked = selected; check.dataset.select = group.id;
    check.setAttribute('aria-label',`Select ${photo.caption || photo.filename}`);
    check.onchange = () => select?.(group,check.checked); label.append(check); card.append(label);
  }
  caption.append(actions);
  card.updateSimilarity = (value) => {
    if (decided) {
      chip.textContent = {approved:'Kept',reviewed:'Reviewed',rejected:'Never show'}[photo.state] || 'Decided';
      status.hidden = true; return;
    }
    group.similarity = value;
    value ??= group.route === 'candidate-unconfirmed' ? { state: 'unavailable' }
      : group.route === 'manual-budget' ? { state: 'limited' }
      : ['candidate-supported', 'single'].includes(group.route) ? { state: 'local' } : null;
    chip.textContent = group.memberCount > 1 ? `${group.memberCount} photos` : 'Single photo';
    const label = similarityLabel(value), indicator = similarityIndicator(value);
    if (status.textContent !== label) status.textContent = label;
    status.hidden = !label || ['local','checked'].includes(value?.state) && !value?.uncertain;
    if (marker.firstChild?.title !== indicator?.title || marker.firstChild?.dataset.phase !== indicator?.dataset.phase)
      marker.replaceChildren(...(indicator ? [indicator] : []));
    card.dataset.similarity = value?.state ?? '';
  };
  card.updateSimilarity(group.similarity);
  cover.onclick = () => open(group);
  card.append(cover, caption);
  // The article itself remains a convenient programmatic entry point; child
  // actions never bubble into opening a second interaction.
  card.onclick = event => { if (event.target === card) open(group); };
  return card;
}
