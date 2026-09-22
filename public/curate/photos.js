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
  const view = node('button', 'View larger', 'p-btn quiet');
  view.dataset.view = photo.id;
  view.setAttribute('aria-label', `View ${photo.filename} larger`);
  view.onclick = () => open(photo);
  info.append(view);
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
  } else {
    imageButton.dataset.keeper = photo.id;
    imageButton.setAttribute('aria-label', `Keep ${photo.filename}`);
    imageButton.onclick = () => change(['approve', 'favorite'].includes(outcome()) ? 'reviewed' : 'approve');
  }
  card.syncSelection = () => {
    if (readOnly) return;
    const selected = ['approve', 'favorite'].includes(outcome());
    imageButton.setAttribute('aria-pressed', String(selected));
    card.classList.toggle('selected', selected);
    badge.textContent = { approve: '✓ Keep', favorite: '★ Favorite', reviewed: 'Click to keep', reject: 'Never show' }[
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

export function groupCard(group, open) {
  const button = node('button', undefined, 'group-card');
  button.dataset.groupId = group.id;
  const photo = group.photos[0];
  const cover = node('div', undefined, 'cover');
  const img = node('img');
  img.src = thumbnail(photo.id);
  img.alt = '';
  img.loading = 'lazy';
  const chip = node('span', undefined, 'p-chip');
  const marker = node('span', undefined, 'similarity-marker');
  cover.append(img, chip, marker);
  const caption = node('div', undefined, 'group-caption');
  caption.append(
    node('strong', group.memberCount > 1 ? 'Compare stack' : 'Review photo'),
    node('span', photo.caption || photo.filename, 'filename'),
    node('small', group.route === 'candidate-unconfirmed' || group.route === 'manual-budget'
      ? 'Time group · similarity unconfirmed' : group.memberCount > 1 ? 'Choose one or more keepers' : 'Choose what to keep'),
  );
  const status = node('small', undefined, 'similarity-status');
  caption.append(status);
  button.updateSimilarity = (value) => {
    group.similarity = value;
    value ??= group.route === 'candidate-unconfirmed' ? { state: 'unavailable' }
      : group.route === 'manual-budget' ? { state: 'limited' }
      : ['candidate-supported', 'single'].includes(group.route) ? { state: 'local' } : null;
    const provisional = value && (value.uncertain || !['checked', 'updated', 'local'].includes(value.state));
    chip.textContent = group.memberCount > 1 ? `${group.memberCount} photos` : provisional ? '1 photo' : 'Single photo';
    const label = similarityLabel(value);
    if (status.textContent !== label) status.textContent = label;
    const indicator = similarityIndicator(value);
    if (marker.firstChild?.title !== indicator?.title || marker.firstChild?.dataset.phase !== indicator?.dataset.phase)
      marker.replaceChildren(...(indicator ? [indicator] : []));
    status.hidden = !status.textContent;
    button.dataset.similarity = value?.state ?? '';
    caption.querySelector('small').hidden = Boolean(status.textContent);
  };
  button.updateSimilarity(group.similarity);
  button.append(cover, caption);
  button.onclick = () => open(group);
  return button;
}
