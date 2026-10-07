import { textTooltip } from './tooltip.js';
import { stackStatus, mergeStatus } from './stack-status.js';
import { gridSuggestion } from './suggestions.js';

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

// A human Keep toggle is independent of the Photo Referee's gold star.
export function choiceControls({ label, change, namespace = 'choice' }) {
  const root = node('div', undefined, 'photo-choices');
  root.setAttribute('role', 'group'); root.setAttribute('aria-label', `Choices for ${label}`);
  const keep = node('button', 'Keep', 'p-btn keep-toggle'); keep.type = 'button'; keep.dataset.keepToggle = '';
  const menu = node('details', undefined, 'photo-options');
  const more = node('summary', '⋯', 'p-btn');
  const options = node('div', undefined, 'photo-options-list');
  let current = 'reviewed', locked = false;
  keep.onclick = () => change(['approve', 'favorite'].includes(current) ? 'reviewed' : 'approve');
  more.onclick = event => { if (locked) event.preventDefault(); };
  for (const [value, text, title] of choices.filter(([value]) => value !== 'approve')) {
    const button = node('button', text, `p-btn${value === 'favorite' ? ' gold' : value === 'reject' ? ' danger' : ''}`);
    button.type = 'button'; button.dataset[namespace] = value; button.title = title;
    button.onclick = () => { if (locked) return; change(value); menu.open = false; more.focus({ preventScroll: true }); };
    options.append(button);
  }
  menu.append(more, options); root.append(keep, menu);
  root.addEventListener('keydown', event => {
    if (event.key === 'Escape' && menu.open) { event.preventDefault(); event.stopPropagation(); menu.open = false; more.focus(); }
  });
  return { root, keep, sync(value, disabled = keep.disabled) {
    current = value; locked = disabled;
    const picked = ['approve', 'favorite'].includes(value);
    keep.textContent = picked ? '✓ Keep' : 'Keep'; keep.setAttribute('aria-pressed', String(picked));
    keep.setAttribute('aria-label', `${picked ? 'Kept' : 'Keep'} ${label}${value === 'favorite' ? ' as a favorite' : ''}`);
    more.textContent = value === 'favorite' ? 'Fav ▾' : value === 'reject' ? 'No ▾' : '⋯';
    more.classList.toggle('gold', value === 'favorite'); more.classList.toggle('danger', value === 'reject');
    more.setAttribute('aria-label', `More choices for ${label}. Current: ${outcomeLabel(value)}`);
    more.setAttribute('aria-disabled', String(disabled)); more.tabIndex = disabled ? -1 : 0;
    for (const button of root.querySelectorAll('button')) button.disabled = disabled;
    for (const button of options.children) button.setAttribute('aria-pressed', String(button.dataset[namespace] === value));
  } };
}

export function photoCard(
  photo,
  { readOnly = false, label = 'Photo', outcome = () => 'reviewed', change, open,
    selected = () => false, select, imageState = () => {}, suggested = false, assessment = null, inlineReason = false },
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
  const humanPick = node('span', '✓', 'human-pick'); humanPick.setAttribute('role', 'img'); humanPick.setAttribute('aria-label', 'Your pick'); humanPick.hidden = true;
  if (!readOnly) imageButton.append(humanPick);
  const info = node('div', undefined, 'photo-info');
  let checkbox, controls;
  if (readOnly) {
    imageButton.append(node('span', 'Already kept', 'photo-outcome'));
  } else {
    const selection = node('label', undefined, 'photo-selection');
    checkbox = node('input'); checkbox.type = 'checkbox'; checkbox.dataset.compareSelect = photo.id;
    checkbox.setAttribute('aria-label', `Check ${label}`);
    checkbox.onchange = () => select?.(checkbox.checked);
    selection.append(checkbox); card.append(selection);
    controls = choiceControls({ label, change });
    controls.keep.dataset.keeper = photo.id;
    const heading = node('div', undefined, 'photo-info-heading');
    heading.append(node('small', label, 'photo-label'));
    if (assessment) {
      const why = textTooltip(inlineReason ? assessment.reason : 'Why?',
        `Photo Referee · ${suggested ? 'Suggested' : 'Not suggested'} · ${label}`,
        assessment.reason, `photo-advice-${photo.id}`);
      if (inlineReason) why.classList.add('photo-reason-inline');
      heading.append(why);
    }
    info.append(heading, controls.root);
  }
  const imageError = node('span', 'Preview unavailable. Try opening it in Immich.', 'p-muted');
  imageError.hidden = true;
  img.onerror = () => { imageError.hidden = false; imageState(false); };
  img.onload = () => { imageError.hidden = true; imageState(true); };
  info.append(imageError);
  card.syncSelection = () => {
    if (readOnly) return;
    card.dataset.outcome = outcome();
    controls.sync(outcome());
    humanPick.hidden = !['approve', 'favorite'].includes(outcome());
    card.classList.toggle('is-skipped', outcome() === 'reviewed');
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


export function groupCard(group, open, { decide, keepSuggestions, select, selected = false, decided = false, label = 'Photo' } = {}) {
  const card = node('article', undefined, 'group-card');
  card.dataset.groupId = group.id;
  const photo = group.photos[0];
  const cover = node('button', undefined, 'cover');
  cover.type = 'button';
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
  const coverWrap = node('div', undefined, 'cover-wrap');
  coverWrap.append(cover);
  let strip, keepButton, shownSuggestion;
  if (group.memberCount > 1) {
    card.classList.add('is-stack');
    strip = node('button', undefined, 'stack-strip');
    strip.type = 'button'; strip.setAttribute('aria-label', `Compare ${group.memberCount} photos`);
    strip.onclick = event => { event.stopPropagation(); open(group); }; caption.prepend(strip);
    keepButton = node('button', '', 'p-btn stack-accept');
    keepButton.type = 'button'; keepButton.hidden = true;
    keepButton.onclick = event => { event.stopPropagation(); if (shownSuggestion) keepSuggestions?.(group, shownSuggestion); };
    for (const type of ['keydown', 'keyup']) keepButton.addEventListener(type, event => {
      if (['Enter', ' '].includes(event.key) && (event.repeat || event.ctrlKey || event.metaKey || event.altKey)) event.preventDefault();
    });
    coverWrap.append(keepButton);
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
    if (patch.photos) group.photos = patch.photos;
    if (Object.hasOwn(patch, 'suggestedCover')) group.suggestedCover = patch.suggestedCover;
    shownSuggestion = decided ? null : gridSuggestion(group);
    const displayPhoto = shownSuggestion && group.suggestedCover?.id === shownSuggestion.keeperIds[0] ? group.suggestedCover : photo;
    const coverLabel = group.memberCount > 1 ? `Compare ${group.memberCount} photos: ${displayPhoto.caption || label}` : `View ${displayPhoto.caption || label}`;
    if (img.getAttribute('src') !== thumbnail(displayPhoto.id)) img.src = thumbnail(displayPhoto.id);
    description.textContent = description.title = displayPhoto.caption || '';
    if (strip) {
      const others = group.photos.filter(p => !shownSuggestion || p.id !== displayPhoto.id).slice(0, 3);
      const signature = JSON.stringify([others.map(p => p.id), Boolean(shownSuggestion)]);
      if (strip.dataset.signature !== signature) {
        strip.dataset.signature = signature;
        strip.replaceChildren(...others.map(member => {
          const preview = node('img'); preview.src = thumbnail(member.id); preview.alt = ''; preview.loading = 'lazy'; return preview;
        }));
        const extra = group.memberCount - others.length - (shownSuggestion ? 1 : 0);
        if (extra > 0) strip.append(node('span', `+${extra}`));
      }
      keepButton.hidden = !shownSuggestion;
      if (shownSuggestion) {
        const count = shownSuggestion.keeperIds.length;
        const star = node('span', '★', 'keeper-star-icon'); star.setAttribute('aria-hidden', 'true');
        keepButton.replaceChildren(`Keep ${count} `, star);
        keepButton.title = `Keep ${count} suggested ${count === 1 ? 'photo' : 'photos'} and skip the other ${group.memberCount - count}.` +
          (group.photoReferee.coverage === 'within-batches' ? ' Photos were compared in separate batches.' : '') +
          (group.photoReferee.checkCoverage === 'incomplete' ? ' Stack checking finished incomplete.' : '') +
          (group.photoReferee.checkCoverage === 'unchecked-size' ? ' Stack not checked: too large.' : '');
        keepButton.setAttribute('aria-label', keepButton.title);
      }
    }
    const status = stackStatus(group, { decided });
    cover.setAttribute('aria-label', status?.word ? `${status.word}. ${coverLabel}` : coverLabel);
    // The Keep button carries the suggestion count; only grouping status
    // belongs in the card's top-right corner.
    const badge = badgeNode(status);
    const signature = badge?.title ?? '';
    if (marker.dataset.signature !== signature) {
      marker.dataset.signature = signature;
      marker.replaceChildren(...[badge].filter(Boolean));
    }
    card.dataset.badge = status?.badge ?? '';
    card.dataset.similarity = status?.updated ? 'updated' : group.similarity?.state ?? '';
    card.toggleAttribute('data-updated', Boolean(status?.updated));
  };
  card.updateStatus();
  cover.onclick = () => open(group);
  card.append(coverWrap, caption);
  // The article itself remains a convenient programmatic entry point; child
  // actions never bubble into opening a second interaction.
  card.onclick = event => {
    if (event.target === card || group.memberCount > 1 && caption.contains(event.target)) open(group);
  };
  return card;
}
