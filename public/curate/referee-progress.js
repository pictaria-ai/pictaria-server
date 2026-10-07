import { refereeProgress, refereeActivity, photoRefereeActivity } from './referee-status.js';
import { textTooltip } from './tooltip.js';

function element(tag, text, className) {
  const el = document.createElement(tag);
  el.textContent = text;
  if (className) el.className = className;
  return el;
}

export function showRefereeProgress(root, counts, activity, role) {
  const presentation = refereeProgress(counts, activity, role);
  const signature = JSON.stringify(presentation);
  if (root.dataset.signature === signature) return;
  root.dataset.signature = signature;
  root.dataset.phase = presentation.phase;
  const label = root.querySelector('.referee-progress-label');
  const heading = role === 'photo' ? 'Photo Referee' : 'Stack Referee';
  if (!label.firstElementChild) label.replaceChildren(textTooltip(heading, heading, '', `${role}-progress-help`));
  const panel = label.querySelector('.why-content');
  panel.classList.add('referee-progress-details');
  const content = [element('strong', heading), element('p', presentation.status ?? presentation.text, 'referee-detail-status')];
  const detail = (role === 'photo' ? photoRefereeActivity : refereeActivity)(activity);
  if (presentation.phase === 'attention' && detail) content.push(element('p', detail.detail));
  if (presentation.phase === 'off') content.push(element('p', 'Enable in Settings → Curate. Existing suggestions remain available.', 'referee-detail-note'));
  else if (counts?.state === 'ready') {
    const stats = document.createElement('dl');
    for (const [name, value] of [['Remaining', counts.remaining], ['Completed', counts.completed], ['Limited result', counts.incomplete], ['Total pending', counts.total]]) {
      const className = name === 'Total pending' ? 'referee-detail-total' : '';
      stats.append(element('dt', name, className), element('dd', value.toLocaleString(), className));
    }
    content.push(stats, element('p', 'Across all pending stacks, including those outside this view.', 'referee-detail-note'));
    if (counts.incomplete) content.push(element('p', 'Limited results will not retry automatically. You can still curate those photos.', 'referee-detail-note'));
  }
  // Keep the trigger and open popover in place as counts change; only update
  // their text content. No provider text is interpreted as HTML.
  panel.replaceChildren(...content);
  const status = root.querySelector('.referee-progress-status');
  const compact = { 'Counting stacks…': '', 'Waiting for grouping': 'Awaiting grouping', 'Waiting for stack checks': 'Awaiting stack check' };
  status.textContent = compact[presentation.status] ?? presentation.status ?? '';
  status.title = presentation.status ?? '';
  root.querySelector('.referee-progress-copy').textContent = presentation.text;
}
