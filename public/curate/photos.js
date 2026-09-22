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

export function groupCard(group, open) {
  const button = node('button', undefined, 'group-card');
  button.dataset.groupId = group.id;
  const photo = group.photos[0];
  const cover = node('div', undefined, 'cover');
  const img = node('img');
  img.src = thumbnail(photo.id);
  img.alt = '';
  img.loading = 'lazy';
  cover.append(img, node('span', group.memberCount > 1 ? `${group.memberCount} photos` : 'Single photo', 'p-chip'));
  const caption = node('div', undefined, 'group-caption');
  caption.append(
    node('strong', group.memberCount > 1 ? 'Compare stack' : 'Review photo'),
    node('span', photo.caption || photo.filename, 'filename'),
    node('small', group.route === 'candidate-unconfirmed' || group.route === 'manual-budget'
      ? 'Time group · similarity unconfirmed' : group.memberCount > 1 ? 'Choose one or more keepers' : 'Choose what to keep'),
  );
  button.append(cover, caption);
  button.onclick = () => open(group);
  return button;
}
