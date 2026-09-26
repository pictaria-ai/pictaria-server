// Format deadlines in the browser's timezone, not the server's timezone.
function aiConnectionMessage(status) {
  const deadline = Number.isFinite(status?.retryAt) ? new Date(status.retryAt) : null;
  if (status?.state === 'cooldown' && deadline && Number.isFinite(deadline.getTime())) {
    const when = deadline.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
    return `AI connection is cooling down until ${when}. Eligible work can try again afterward.`;
  }
  return status?.message ?? '';
}
