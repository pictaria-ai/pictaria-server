import { node, badgeNode } from './photos.js';
import { photoAdviceSummary } from './photo-advice.js';
import { evidenceRows, algorithmLabel, MARKS, HOW_STACKS_WORK } from './explanation-copy.js';

const STEP_ICONS = { done: '✓', running: '', queued: '', unsure: '?', limited: 'i', skipped: '–', off: '–' };
export const UPDATED_NOTE = 'A newer grouping is ready; it appears when Curate refreshes.';

// An overlay inside the active dialog: hover, focus or tap never reflows photos.
// `status` (stack-status.js) repeats the badge's word as the verdict.
export function explanation(comparison, prefix, status = null) {
  const title = comparison.ids?.length === 1 ? 'Why this photo?' : 'Why this stack?';
  const wrap = node('span', undefined, 'why-tooltip');
  const trigger = node('button', undefined, 'why-trigger');
  trigger.type = 'button';
  const badge = badgeNode(status, { word: true });
  if (badge) {
    badge.removeAttribute('title');
    trigger.append(badge);
    trigger.classList.add('status-trigger');
  } else trigger.textContent = 'Why?';
  trigger.setAttribute('aria-label', status?.word ? `${status.word}. ${title}` : title);
  trigger.setAttribute('aria-describedby', prefix);
  trigger.setAttribute('aria-expanded', 'false');
  const panel = node('div', undefined, 'why-content');
  panel.id = prefix;
  panel.hidden = true;
  const heading = node('div', undefined, 'why-heading');
  heading.append(node('strong', title));
  if (status?.word) {
    const verdict = node('span', status.word, 'why-verdict');
    verdict.dataset.badge = status.badge;
    heading.append(verdict);
  }
  panel.append(heading);
  if (status?.detail) panel.append(node('p', status.detail, 'why-detail'));
  if (status?.steps?.length) {
    // Grouping → AI check → Keepers, each with its own state.
    const steps = node('ol', undefined, 'why-steps');
    steps.setAttribute('aria-label', 'Checks');
    for (const item of status.steps) {
      const row = node('li');
      row.dataset.state = item.state;
      const icon = node('span', STEP_ICONS[item.state] ?? '', 'why-step-icon');
      icon.setAttribute('aria-hidden', 'true');
      const text = node('span', undefined, 'why-step-text');
      text.append(node('strong', `${item.name}:`), ` ${item.text}`);
      if (item.detail) text.append(node('small', item.detail));
      row.append(icon, text);
      steps.append(row);
    }
    panel.append(steps);
  }
  const rows = node('ul', undefined, 'why-evidence');
  rows.id = `${prefix}s`;
  for (const { mark, signal, value } of evidenceRows(comparison, { steps: Boolean(status?.steps?.length) })) {
    const row = node('li');
    row.dataset.mark = mark;
    const [glyph, meaning] = MARKS[mark];
    const icon = node('span', glyph, 'why-mark');
    icon.setAttribute('role', 'img');
    icon.setAttribute('aria-label', meaning);
    row.append(icon, node('span', signal, 'why-signal'), node('span', value, 'why-value'));
    rows.append(row);
  }
  panel.append(rows);
  const advice = comparison.photoRecommendations;
  if (advice) {
    const section = node('section', undefined, 'why-photo-advice');
    section.append(node('strong', 'Photo Referee'), node('p', photoAdviceSummary(advice)));
    for (const reason of new Set((advice.batches ?? []).filter(b => b.status === 'valid')
      .flatMap(b => b.groups ?? []).map(g => g.reason).filter(Boolean))) section.append(node('p', reason));
    if (advice.provider || advice.model) section.append(node('small', [advice.provider, advice.model].filter(Boolean).join(' · '), 'p-muted'));
    panel.append(section);
  }
  if (status?.updated) panel.append(node('p', UPDATED_NOTE, 'why-updated'));
  const footer = node('p', `${algorithmLabel(comparison)} · `, 'p-muted why-algorithm');
  const docs = node('a', 'How stacks work');
  docs.href = HOW_STACKS_WORK; docs.target = '_blank'; docs.rel = 'noopener';
  footer.append(docs);
  panel.append(footer);
  let pinned = false;
  wrap.dismiss = () => {
    panel.hidden = true;
    pinned = false;
    trigger.setAttribute('aria-expanded', 'false');
  };
  const show = () => {
    panel.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    const rect = trigger.getBoundingClientRect(),
      width = panel.offsetWidth,
      height = panel.offsetHeight;
    panel.style.left = `${Math.max(12, Math.min(rect.left, innerWidth - width - 12))}px`;
    panel.style.top = `${Math.max(12, rect.bottom + height > innerHeight - 12 ? rect.top - height : rect.bottom)}px`;
  };
  wrap.addEventListener('pointerenter', (event) => {
    if (event.pointerType === 'mouse') show();
  });
  wrap.addEventListener('pointerleave', () => {
    if (!pinned && !wrap.contains(document.activeElement)) wrap.dismiss();
  });
  trigger.addEventListener('focus', show);
  wrap.addEventListener('focusout', (event) => {
    if (!wrap.contains(event.relatedTarget)) wrap.dismiss();
  });
  trigger.onclick = () => {
    if (pinned) wrap.dismiss();
    else {
      pinned = true;
      show();
    }
  };
  wrap.append(trigger, panel);
  return wrap;
}
function dismissAll(event) {
  for (const tooltip of document.querySelectorAll('.why-tooltip')) {
    if (event?.target instanceof Node && tooltip.contains(event.target)) continue;
    tooltip.dismiss();
  }
}
document.addEventListener('pointerdown', dismissAll);
document.addEventListener('scroll', dismissAll, true);
window.addEventListener('resize', dismissAll);
document.addEventListener(
  'keydown',
  (event) => {
    if (event.key !== 'Escape' || !document.querySelector('.why-content:not([hidden])')) return;
    dismissAll();
    event.preventDefault();
    event.stopImmediatePropagation();
  },
  true,
);
