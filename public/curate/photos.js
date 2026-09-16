export function node(tag, text, className) {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
}
export const thumbnail = (id) => `/api/review/thumbnail/${encodeURIComponent(id)}`;

export function photoCard(
  photo,
  { readOnly = false, outcome = () => 'reviewed', change, remove, open, imageState = () => {} },
) {
  const card = node('article', undefined, 'photo-card');
  card.dataset.photoId = photo.id;
  const imageButton = node('button', undefined, 'photo-image');
  imageButton.type = 'button';
  imageButton.setAttribute('aria-label', `View ${photo.filename}`);
  const img = node('img');
  img.src = thumbnail(photo.id);
  img.alt = photo.caption || photo.filename;
  img.loading = 'lazy';
  imageButton.append(img);
  imageButton.onclick = () => open(photo);
  const info = node('div', undefined, 'photo-info');
  const file = node('strong', photo.filename, 'filename');
  file.title = photo.filename;
  info.append(file);
  if (photo.caption) info.append(node('p', photo.caption, 'caption'));
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
  const repaint = () => {};
  if (readOnly) info.append(node('span', 'Already kept · reference only', 'p-muted'));
  else {
    const keep = node('input');
    keep.type = 'checkbox';
    keep.dataset.keeper = photo.id;
    keep.setAttribute('aria-label', `Keep ${photo.filename}`);
    const label = node('label');
    label.append(keep, node('span', 'Keep this photo'));
    const choice = node('select');
    choice.dataset.outcome = photo.id;
    choice.setAttribute('aria-label', `Decision for ${photo.filename}`);
    const sync = () => {
      const value = outcome(),
        selected = ['approve', 'favorite'].includes(value);
      keep.checked = selected;
      card.classList.toggle('selected', selected);
      choice.replaceChildren(
        ...(selected
          ? [
              ['approve', 'Keep'],
              ['favorite', 'Keep as favorite'],
            ]
          : [
              ['reviewed', 'Mark reviewed'],
              ['reject', 'Never show'],
            ]
        ).map(([value, text]) => {
          const option = node('option', text);
          option.value = value;
          return option;
        }),
      );
      choice.value = value;
    };
    keep.onchange = () => {
      change(keep.checked ? 'approve' : 'reviewed');
      sync();
    };
    choice.onchange = () => {
      change(choice.value);
      sync();
    };
    card.syncSelection = sync;
    info.append(label, choice);
    if (remove) {
      const button = node('button', 'Remove from stack', 'p-btn quiet');
      button.dataset.remove = photo.id;
      button.onclick = remove;
      info.append(button);
    }
    sync();
  }
  card.syncSelection ||= repaint;
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
    node('small', group.memberCount > 1 ? 'Choose one or more keepers' : 'Choose what to keep'),
  );
  button.append(cover, caption);
  button.onclick = () => open(group);
  return button;
}
