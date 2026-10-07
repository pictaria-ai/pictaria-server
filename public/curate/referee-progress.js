import { curateStatus, refereeActivity, photoRefereeActivity } from './referee-status.js';
import { textTooltip } from './tooltip.js';

function element(tag, text, className) {
  const el = document.createElement(tag);
  if (text !== undefined) el.textContent = text;
  if (className) el.className = className;
  return el;
}

export function showCurateStatus(root, view) {
  const status = curateStatus(view);
  if (!root.firstElementChild) {
    const help = textTooltip('', 'Curate activity', '', 'curate-status-details');
    help.classList.add('curate-status-help');
    const trigger = help.querySelector('button');
    trigger.classList.add('curate-status-chip');
    trigger.setAttribute('aria-haspopup', 'dialog');
    trigger.append(element('span', '', 'curate-status-icon'), element('span', '', 'curate-status-copy'), element('span', '', 'curate-status-count'));
    trigger.querySelector('.curate-status-icon').setAttribute('aria-hidden', 'true');
    const panel = help.querySelector('.why-content');
    panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-label', 'Curate activity');
    panel.classList.add('curate-status-details');
    const dismiss = help.dismiss;
    help.dismiss = () => {
      if (panel.contains(document.activeElement) && !trigger.hidden) trigger.focus({ preventScroll: true });
      dismiss();
    };
    const rows = element('div', undefined, 'curate-status-roles');
    for (const [role, name] of [['stack', 'Stack Referee'], ['photo', 'Photo Referee']]) {
      const row = element('div', undefined, 'curate-status-role'); row.dataset.role = role;
      row.append(element('strong', name), element('span', '', 'role-status'), element('span', '', 'role-count'), element('small', '', 'role-detail'));
      rows.append(row);
    }
    const link = element('a', 'AI settings'); link.href = '/settings.html#sec-curate';
    panel.replaceChildren(element('strong', 'Curate activity'), rows,
      element('p', '', 'status-grouping'), element('p', '', 'status-enrich'),
      element('p', 'Counts cover all pending stacks, including outside this view. A stack awaiting both referees is counted once in the chip.', 'status-scope'), link);
    root.append(help);
  }
  const wrap = root.firstElementChild, trigger = wrap.querySelector('button');
  root.dataset.phase = status.phase;
  trigger.hidden = status.phase === 'hidden';
  if (trigger.hidden) wrap.dismiss();
  trigger.setAttribute('aria-label', status.text);
  trigger.querySelector('.curate-status-copy').textContent = status.text;
  trigger.querySelector('.curate-status-count').textContent = status.count === null ? '…' : status.count.toLocaleString();
  trigger.querySelector('.curate-status-icon').textContent = { attention: '!', waiting: '◷', idle: '✓', counting: '◷' }[status.phase] ?? '';
  for (const role of status.roles) {
    const row = root.querySelector(`[data-role=${role.role}]`);
    row.dataset.phase = role.phase;
    row.querySelector('.role-status').textContent = role.status ?? role.text;
    row.querySelector('.role-count').textContent = role.phase === 'off' ? '' : role.counts?.state === 'ready' ? `${role.counts.remaining.toLocaleString()} left` : 'Counting…';
    const details = (role.role === 'photo' ? photoRefereeActivity : refereeActivity)(role.activity);
    row.querySelector('.role-detail').textContent = role.blocker ? details?.detail ?? 'Checks cannot run yet. You can still curate these photos.'
      : role.counts?.incomplete ? `${role.counts.incomplete.toLocaleString()} limited results. You can still curate these photos; checks will not retry automatically.` : '';
  }
  const grouping = root.querySelector('.status-grouping');
  grouping.textContent = view.metadata?.problem ? 'Photo information could not refresh. You can continue curating.'
    : ['paused', 'limited'].includes(view.refinement?.state) ? 'Grouping is paused. You can continue curating.'
      : view.refinement?.remainingGroups > 0 ? `Grouping nearby photos · ${view.refinement.remainingGroups.toLocaleString()} nearby groups left.` : '';
  grouping.hidden = !grouping.textContent;
  const enrich = root.querySelector('.status-enrich');
  enrich.hidden = !view.enrichRunning;
  enrich.textContent = 'Enrich is running. New photos may still join stacks.';
}
