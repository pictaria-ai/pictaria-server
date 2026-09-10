/* Shared display conventions for Enrich history and performance. */
const enrichFormat = (() => {
  const provider = value => ({ local_lmstudio: 'LM Studio', local_ollama: 'Ollama (local)', cloud_ollama: 'Ollama (cloud)', cloud_openai: 'OpenAI', openai: 'OpenAI', openrouter: 'OpenRouter', venice: 'Venice', openai_compatible: 'OpenAI-compatible' }[value] ?? value);
  const status = value => ({ finished: 'Completed', succeeded: 'Enriched', running: 'In progress' }[value]
    ?? (value ? value.charAt(0).toUpperCase() + value.slice(1).replaceAll('_', ' ') : 'Unknown'));
  const when = (value, dateOnly = false) => {
    const d = value ? new Date(value) : null;
    return d && Number.isFinite(d.getTime())
      ? d.toLocaleString(undefined, { dateStyle: 'medium', ...(dateOnly ? {} : { timeStyle: 'short' }) }) : 'Date unavailable';
  };
  const duration = ms => {
    if (!Number.isFinite(ms) || ms < 0) return 'Unavailable';
    if (ms === 0) return '<0.01 s';
    if (ms < 1000) return `${Math.max(1, Math.round(ms))} ms`;
    const seconds = Math.round(ms / 100) / 10;
    if (seconds < 60) return `${seconds.toLocaleString(undefined, { maximumFractionDigits: 1 })} s`;
    const whole = Math.round(seconds);
    const hours = Math.floor(whole / 3600), minutes = Math.floor(whole % 3600 / 60), rest = whole % 60;
    return [hours ? `${hours} hr` : null, minutes ? `${minutes} min` : null, rest ? `${rest} s` : null].filter(Boolean).join(' ');
  };
  const elapsed = run => {
    const ms = run.startedAt && run.finishedAt ? new Date(run.finishedAt) - new Date(run.startedAt) : null;
    return Number.isFinite(ms) && ms >= 0 ? ms : null;
  };
  const rate = value => Number.isFinite(value) ? value.toLocaleString(undefined, { maximumFractionDigits: 2 }) : '—';
  const photoOutcomes = (c, runStatus) => {
    if (!c) return 'Counts unavailable';
    const exceptions = [
      c.skippedFailureLimit > 0 ? `${c.skippedFailureLimit.toLocaleString()} at failure limit` : null,
      c.skippedDiscarded > 0 ? `${c.skippedDiscarded.toLocaleString()} discarded` : null,
    ].filter(Boolean);
    if (!c.analyzed && !c.succeeded && !c.failed && !exceptions.length) {
      return runStatus === 'finished' ? 'No photos needed enrichment in the scanned selection.' : 'No photos were processed.';
    }
    return [`${(c.succeeded ?? 0).toLocaleString()} enriched`,
      c.failed > 0 ? `${c.failed.toLocaleString()} failed` : null, ...exceptions].filter(Boolean).join(' · ');
  };
  return { provider, status, when, duration, elapsed, rate, photoOutcomes };
})();
