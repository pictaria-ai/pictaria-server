import { stackStatus, mergeStatus } from './stack-status.js';

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
    selected = () => false, select, imageState = () => {}, suggested = false, assessment = null },
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
  imageButton.setAttribute('aria-label', `View ${label}${suggested ? ', suggested keeper' : ''}`);
  imageButton.onclick = () => open(photo);
  // A Photo Referee suggestion (PIC-116) puts the gold star on the photo itself.
  if (suggested) { imageButton.append(keeperStar(1, 'Suggested keeper')); card.classList.add('suggested'); }
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
    if (assessment) {
      const reason = node('small', `Photo Referee: ${assessment.reason}`, 'photo-advice');
      reason.title = reason.textContent;
      info.append(reason);
    }
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

// A status badge (stack-status.js); comparisons.css draws each badge's icon.
// Icon-only badges carry their word as an accessible name and tooltip, so
// color is never the only signal.
export function badgeNode(status, { word = false } = {}) {
  if (!status?.badge) return null;
  const badge = node('span', undefined, 'stack-badge');
  badge.dataset.badge = status.badge;
  const icon = node('span', undefined, 'stack-badge-icon');
  icon.setAttribute('aria-hidden', 'true');
  badge.append(icon);
  if (word) badge.append(node('span', status.word, 'stack-badge-word'));
  else {
    if (status.badge === 'ai-checked') badge.append(node('span', 'AI', 'stack-badge-ai'));
    badge.setAttribute('role', 'img');
    badge.setAttribute('aria-label', status.word);
  }
  // The tooltip adds why a step is waiting or limited.
  const notes = (status.steps ?? []).filter(item => ['running', 'queued', 'limited'].includes(item.state))
    .map(item => `${item.name}: ${item.text}.${item.detail ? ` ${item.detail}` : ''}`);
  badge.title = [`${status.word}.`, status.detail, ...notes].filter(Boolean).join(' ');
  return badge;
}
// The Photo Referee's gold star (PIC-116), with a count when more than one.
export function keeperStar(count, label = count > 1 ? `${count} keepers suggested` : 'Keeper suggested') {
  if (!(count > 0)) return null;
  const star = node('span', undefined, 'keeper-star');
  star.append(node('span', '★', 'keeper-star-icon'));
  if (count > 1) star.append(node('span', String(count)));
  star.setAttribute('role', 'img');
  star.setAttribute('aria-label', label);
  star.title = label;
  return star;
}
// The header's library-wide activity: a spinner while working, or a warning.
export function activityIndicator(phase, title) {
  if (!phase) return null;
  const indicator = node('span', phase === 'attention' ? '!' : '', 'activity-indicator');
  indicator.dataset.phase = phase;
  indicator.setAttribute('role', 'img');
  indicator.title = title;
  indicator.setAttribute('aria-label', title);
  return indicator;
}

export function groupCard(group, open, { decide, select, selected = false, decided = false, label = 'Photo' } = {}) {
  const card = node('article', undefined, 'group-card');
  card.dataset.groupId = group.id;
  const photo = group.photos[0];
  const cover = node('button', undefined, 'cover');
  cover.type = 'button';
  const coverLabel = group.memberCount > 1 ? `Compare ${group.memberCount} photos: ${photo.caption || label}` : `View ${photo.caption || label}`;
  const img = node('img'); img.src = thumbnail(photo.id); img.alt = ''; img.loading = 'lazy';
  const marker = node('span', undefined, 'status-marker');
  cover.append(img, marker);
  if (group.memberCount > 1) cover.append(node('span', `${group.memberCount} photos`, 'p-chip stack-count'));
  const caption = node('div', undefined, 'group-caption');
  const description = node('span', photo.caption || '', 'photo-caption');
  description.title = photo.caption || '';
  caption.append(description);
  const meta = node('div', undefined, 'card-meta');
  const date = node('small', photo.capturedAt
    ? new Date(photo.capturedAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '', 'capture-date');
  date.title = date.textContent;
  meta.append(date);
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
  if (actions.childElementCount) caption.prepend(actions);
  // Status refreshes in place at the top right, without repeating the status
  // in the photo count or moving descriptions, dates and controls.
  card.updateStatus = (patch = {}) => {
    mergeStatus(group, patch);
    const status = stackStatus(group, { decided });
    cover.setAttribute('aria-label', status?.word ? `${status.word}. ${coverLabel}` : coverLabel);
    const badge = badgeNode(status), star = keeperStar(status?.keepers);
    const signature = JSON.stringify([badge?.title, status?.keepers]);
    if (marker.dataset.signature !== signature) {
      marker.dataset.signature = signature;
      marker.replaceChildren(...[badge, star].filter(Boolean));
    }
    card.dataset.badge = status?.badge ?? '';
    card.dataset.similarity = status?.updated ? 'updated' : group.similarity?.state ?? '';
    card.toggleAttribute('data-updated', Boolean(status?.updated));
  };
  card.updateStatus();
  cover.onclick = () => open(group);
  card.append(cover, caption);
  // The article itself remains a convenient programmatic entry point; child
  // actions never bubble into opening a second interaction.
  card.onclick = event => {
    if (event.target === card || group.memberCount > 1 && caption.contains(event.target)) open(group);
  };
  return card;
}
