import { refereeProgress } from './referee-status.js';
import { textTooltip } from './tooltip.js';

export function showRefereeProgress(root, counts, activity, role) {
  const presentation = refereeProgress(counts, activity, role);
  const signature = JSON.stringify(presentation);
  if (root.dataset.signature === signature) return;
  root.dataset.signature = signature;
  root.dataset.phase = presentation.phase;
  root.title = presentation.detail;
  const label = root.querySelector('.referee-progress-label');
  const heading = role === 'photo' ? 'Photo Referee' : 'Stack Referee';
  if (!label.firstElementChild) label.replaceChildren(textTooltip(heading, heading, presentation.detail, `${role}-progress-help`));
  else label.querySelector('.why-content p').textContent = presentation.detail;
  const bar = root.querySelector('progress');
  if (presentation.value === undefined) bar.removeAttribute('value');
  else bar.value = presentation.value;
  bar.setAttribute('aria-valuetext', presentation.text);
  root.querySelector('.referee-progress-copy').textContent = presentation.text;
}
