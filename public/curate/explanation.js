import { node } from './photos.js';
import { plainReasons } from './explanation-copy.js';

// An overlay inside the active dialog: hover, focus or tap never reflows photos.
export function explanation(comparison, prefix) {
  const title = comparison.ids?.length === 1 ? 'Why this photo?' : 'Why this stack?';
  const wrap = node('span', undefined, 'why-tooltip');
  const trigger = node('button', 'Why?', 'why-trigger');
  trigger.type = 'button';
  trigger.setAttribute('aria-label', title);
  trigger.setAttribute('aria-describedby', prefix);
  const panel = node('div', undefined, 'why-content');
  panel.id = prefix;
  panel.setAttribute('role', 'tooltip');
  panel.hidden = true;
  panel.append(node('strong', title));
  const reasons = node('ul');
  reasons.id = `${prefix}s`;
  reasons.append(...plainReasons(comparison).map((reason) => node('li', reason)));
  panel.append(reasons);
  const details = node('details', undefined, 'why-details');
  details.append(node('summary', 'Technical details'));
  const raw = node('ul');
  raw.append(...(comparison.reasons || []).map(reason => node('li', reason)));
  details.append(raw);
  const algorithm = node(
    'p',
    /^candidate-\d+$/.test(comparison.algorithm)
      ? `Candidate algorithm ${comparison.algorithm.split('-')[1]} · no AI stack check`
      : 'Grouping from this saved view',
    'p-muted',
  );
  details.append(algorithm); panel.append(details);
  let pinned = false;
  wrap.dismiss = () => {
    panel.hidden = true;
    pinned = false;
  };
  const show = () => {
    panel.hidden = false;
    const rect = trigger.getBoundingClientRect(),
      width = panel.offsetWidth,
      height = panel.offsetHeight;
    panel.style.left = `${Math.max(12, Math.min(rect.left, innerWidth - width - 12))}px`;
    panel.style.top = `${Math.max(12, rect.bottom + height > innerHeight - 12 ? rect.top - height : rect.bottom)}px`;
  };
  details.addEventListener('toggle', () => { if (!panel.hidden) show(); });
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
