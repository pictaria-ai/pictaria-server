const reasons = {
  'preview-cooldown': 'Preview downloads are temporarily paused after an Immich error.',
  'shared-provider': 'Waiting for the shared AI provider.',
  'provider-cooldown': 'The AI provider is temporarily paused after an error.',
  'provider-auth': 'Check the AI provider credentials in Settings.',
  'provider-configuration': 'Check the AI provider configuration in Settings.',
  'provider-interrupted': 'The previous AI request was interrupted. Verify the connection in Settings.',
  'configuration': 'Check the Curate AI provider configuration in Settings.',
  'unknown-capability': 'This model has not been verified for Stack Referee comparisons.',
  'unsupported-provider': 'This provider cannot compare stack photos.',
  'unsupported-size': 'This stack exceeds the evaluated image limit for the selected model.',
  'too-many-images': 'This stack exceeds the 30-photo automatic comparison limit.',
  'input-limit': 'This stack exceeds an automatic comparison limit.',
  'preparation-failed': 'The previews could not be prepared within the download limits.',
  'invalid-answer': 'The model did not return a valid grouping after the allowed attempts.',
  'attempts-finished': 'The allowed automatic attempts for this stack have finished.',
  'photo-limit': 'The automatic request allowance for these photos has been reached.',
};

// Explicit server state only. Neither successful similarity nor Photo Referee
// advice implies that the Stack Referee ran. Unknown reasons stay generic.
export function stackRefereePresentation(status) {
  if (!status || ['off', 'idle', 'skipped', 'updated'].includes(status.state)) return null;
  if (status.state === 'checked') return { title: 'AI checked', phase: 'ai-checked',
    detail: 'The Stack Referee checked this grouping. Photo choices are still yours.' };
  if (status.state === 'checking') return { title: 'Stack Referee checking', phase: 'checking',
    detail: 'The AI is comparing these photos to check the stack composition.' };
  if (status.state === 'waiting') return { title: 'Stack Referee queued', phase: 'waiting',
    detail: reasons[status.reason] ?? 'Waiting for a Stack Referee check.' };
  if (['paused', 'incomplete'].includes(status.state)) return {
    title: status.state === 'paused' ? 'Stack Referee paused' : 'Stack not AI checked', phase: 'limited',
    detail: `${reasons[status.reason] ?? 'The Stack Referee could not finish this check.'} You can still curate these photos.`,
  };
  return null;
}
