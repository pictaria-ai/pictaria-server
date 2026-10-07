const reasons = {
  'preview-cooldown': 'Preview downloads are temporarily paused after an Immich error.',
  'shared-provider': 'Waiting for the shared AI provider.',
  'provider-cooldown': 'The AI provider is temporarily paused after an error.',
  'provider-auth': 'Check the AI provider credentials in Settings.',
  'provider-configuration': 'Check the AI provider configuration in Settings.',
  'provider-interrupted': 'The previous AI request was interrupted. Verify the connection in Settings.',
  'configuration': 'Check the Curate AI provider configuration in Settings.',
  'model-failures': 'The selected model repeatedly failed stack checks. Choose a vision model that compares multiple images in Settings.',
  'unknown-capability': 'Configure a Curate provider and multi-image vision model in Settings.',
  'unsupported-provider': 'This provider cannot compare stack photos.',
};
// Short forms for a process step, after "not possible," or "paused,".
const short = {
  'preview-cooldown': 'previews are paused after an Immich error',
  'shared-provider': 'waiting for the shared AI provider',
  'provider-cooldown': 'the AI provider is paused after an error',
  'provider-auth': 'check the AI provider credentials in Settings',
  'provider-configuration': 'check the AI provider in Settings',
  'provider-interrupted': 'the last AI request was interrupted',
  'configuration': 'check the AI provider in Settings',
  'stack-configuration': 'check the AI provider in Settings',
  'model-failures': 'the model keeps failing, so choose another in Settings',
  'unknown-capability': 'choose a multi-image vision model in Settings',
  'unsupported-provider': 'this provider cannot compare photos',
  'preparation-failed': 'the previews could not be prepared',
  'invalid-answer': 'the model gave no valid answer',
  'attempts-finished': 'the allowed attempts are used up',
  'photo-limit': 'the request allowance for these photos is used up',
  'comparison-changed': 'the comparison inputs or AI settings changed',
  'request-limit': 'too many comparisons for the automatic limit',
  'dense-neighborhood': 'too many nearby photos for automatic comparison',
  'provider-rejected': 'the provider could not complete the comparison',
  'rendition': 'the previews could not be used',
};

// Explicit server state only; unknown reasons stay generic.
export function refereeReasonShort(status, memberCount) {
  if (['unsupported-size', 'input-limit', 'too-many-images'].includes(status?.reason))
    return Number.isInteger(memberCount) && Number.isInteger(status.limit)
      ? `${memberCount} photos is over the ${status.limit}-photo limit` : 'too many photos for one request';
  return short[status?.reason] ?? 'the check could not finish';
}

// Library-wide Stack Referee activity for the page header. Per-stack states
// are in stack-status.js; neither successful similarity nor Photo Referee
// advice implies that the Stack Referee ran.
export function refereeActivity(status) {
  if (!status || ['off', 'idle', 'skipped', 'updated'].includes(status.state)) return null;
  if (status.state === 'checking') return { title: 'Stack Referee checking', phase: 'running',
    detail: 'The AI is comparing photos to check stack composition.' };
  if (status.state === 'waiting') return { title: 'Stack Referee queued', phase: 'queued',
    detail: reasons[status.reason] ?? 'Waiting for a Stack Referee check.' };
  if (['paused', 'incomplete'].includes(status.state)) return { title: 'Stack Referee paused', phase: 'attention',
    detail: `${reasons[status.reason] ?? 'The Stack Referee could not finish its checks.'} You can still curate these photos.` };
  return null;
}

export function photoRefereeActivity(status) {
  const presentation = refereeActivity(status);
  if (!presentation) return null;
  return { ...presentation, title: presentation.title.replace('Stack Referee', 'Photo Referee'),
    detail: status.state === 'checking' ? 'The AI is comparing photos to suggest which ones to keep.'
      : status.reason === 'model-failures' ? 'The selected model repeatedly failed photo comparisons. Choose another multi-image vision model in Settings. You can still curate.'
        : presentation.detail.replaceAll('Stack Referee', 'Photo Referee').replaceAll('stack checks', 'photo comparisons') };
}

// Progress counts come from all pending stacks, independently of the current
// page. Queue lengths and batch counts are intentionally not used here.
export function refereeProgress(counts, activity, role = 'stack') {
  const label = role === 'photo' ? 'Photo Referee' : 'Stack Referee';
  const details = (role === 'photo' ? photoRefereeActivity : refereeActivity)(activity);
  if (counts?.state === 'off' || activity?.state === 'off')
    return { phase: 'off', text: 'Off', detail: `${label} is turned off in Curate Settings.` };
  if (counts?.state !== 'ready') return { phase: 'counting', text: 'Counting stacks…',
    detail: `Counting ${label} work across all pending stacks.` };
  const { total, completed, incomplete, remaining, waitingForGrouping, waitingForStack, paused } = counts;
  const summary = `${completed} of ${total} pending stacks finished successfully.` +
    (incomplete ? ` ${incomplete} finished without a full result and will not be retried automatically.` : '') +
    ' Counts include photos outside this view and can change as photos arrive or stacks split. You can keep curating.';
  if (!remaining) return { phase: 'idle', text: 'Up to date', value: 1, detail: summary };
  let phase = 'queued', status = 'Queued';
  if (details?.phase === 'running') { phase = 'running'; status = 'Working'; }
  else if (paused === remaining || details?.phase === 'attention') { phase = 'attention'; status = 'Paused'; }
  else if (waitingForGrouping === remaining) status = 'Waiting for grouping';
  else if (waitingForGrouping + waitingForStack === remaining) status = 'Waiting for stack checks';
  else if (activity?.reason === 'shared-provider') status = 'Waiting for AI';
  return { phase, text: `${remaining.toLocaleString()} ${remaining === 1 ? 'stack' : 'stacks'} remaining · ${status}`,
    value: (completed + incomplete) / total, detail: [summary, details?.detail].filter(Boolean).join(' ') };
}
