/* Enrich timing presentation. Result state, request outcomes, and timing
 * availability stay distinct; all external labels enter through textContent. */
function createEnrichPerformance({ api, changed = () => {} }) {
  const el = id => document.getElementById(id);
  const node = (tag, text, cls) => { const n = document.createElement(tag); if (text != null) n.textContent = text; if (cls) n.className = cls; return n; };
  const number = n => Number(n ?? 0).toLocaleString();
  const duration = ms => {
    if (!Number.isFinite(ms) || ms < 0) return 'Unavailable';
    if (ms === 0) return '<0.01 s';
    if (ms < 1000) return `${Math.max(1, Math.round(ms))} ms`;
    return `${(ms / 1000).toLocaleString(undefined, { maximumFractionDigits: 1 })} s`;
  };
  const rate = n => Number.isFinite(n) ? n.toLocaleString(undefined, { maximumFractionDigits: 2 }) : '—';
  const plural = (n, singular, multiple = `${singular}s`) => `${number(n)} ${n === 1 ? singular : multiple}`;
  const button = (text, action) => { const b = node('button', text, 'p-btn quiet'); b.type = 'button'; b.addEventListener('click', action); return b; };
  const date = value => { const d = new Date(value); return Number.isFinite(d.getTime()) ? d.toLocaleDateString() : 'unknown date'; };
  const providerName = value => ({ local_lmstudio: 'LM Studio', local_ollama: 'Ollama (local)', cloud_ollama: 'Ollama (cloud)', venice: 'Venice', openai: 'OpenAI', openrouter: 'OpenRouter', openai_compatible: 'OpenAI-compatible' }[value] ?? value);
  let returnFocus = null; let returnRunId = null;
  let snapshot = null; let showAll = false; let loading = false; let generation = 0; let controller = null;
  const dialog = el('photoTimingDialog');
  dialog.addEventListener('close', () => {
    // Native close events are queued. An earlier dialog's event must not
    // cancel a different run the user has already opened.
    if (!dialog.open) {
      generation++; controller?.abort();
      const target = returnFocus?.isConnected ? returnFocus : [...document.querySelectorAll('.run-photo-details')].find(b => b.dataset.timingRunId === String(returnRunId));
      target?.focus({ preventScroll: true });
    }
  });
  el('photoTimingClose').addEventListener('click', () => dialog.close());
  el('performanceAll').addEventListener('click', () => { showAll = !showAll; void refresh(); });
  el('performanceRetry').addEventListener('click', () => void refresh());

  function requestSummary(m) {
    return [plural(m.accepted, 'successful request'), m.timeouts ? plural(m.timeouts, 'timeout') : null,
      m.failures ? plural(m.failures, 'other failure') : null, m.cancelled ? `${number(m.cancelled)} cancelled` : null,
      m.interrupted ? `${number(m.interrupted)} interrupted` : null, m.unvalidated ? `${number(m.unvalidated)} not validated` : null,
      m.running ? `${number(m.running)} in progress` : null].filter(Boolean).join(' · ');
  }
  function metricDetails(m) {
    const details = node('details', null, 'performance-more'); details.append(node('summary', 'More metrics'));
    const content = node('div', null, 'performance-explanation');
    content.append(node('p', `Successful requests: median ${duration(m.latency.medianMs)}; average ${duration(m.latency.meanMs)}. Based on ${plural(m.latency.sampleCount, 'measured, accepted request')}.`));
    content.append(node('p', `${requestSummary(m)}. ${plural(m.retries, 'retry request')} among ${plural(m.requests, 'retained request')}. ${plural(m.invalidResponses, 'invalid response')} included in other failures.`));
    content.append(node('p', `These requests came from ${plural(m.retainedPhotos, 'retained photo execution')} across ${plural(m.runCount, 'run')}. ${number(m.failedRuns)} failed, ${number(m.cancelledRuns)} cancelled, ${number(m.interruptedRuns)} interrupted, ${number(m.activeRuns)} in progress. Each photo can have several requests.`));
    content.append(node('p', m.throughputRuns
      ? `Overall throughput: ${rate(m.photosPerMinute)} successful photos/min; ${m.secondsPerPhoto === null ? 'seconds per successful photo unavailable (no successes)' : `${rate(m.secondsPerPhoto)} seconds per successful photo`}. ${plural(m.successfulPhotos, 'successful photo')} over ${duration(m.elapsedMs)} in ${plural(m.throughputRuns, 'completed run')}. Includes download, preparation, failures, and retry waits.`
      : 'Overall throughput is unavailable until a completed run has processed photos. Failed, cancelled, and interrupted runs can still contribute accepted request timings.'));
    if (m.truncated) content.append(node('p', `Partial timing history: ${number(m.requests)} of ${number(m.recordedRequests)} recorded requests and ${number(m.retainedPhotos)} of ${number(m.photoCount)} processed photos remain. Request metrics describe the retained sample.`, 'performance-warning'));
    details.append(content); return details;
  }
  function renderComparisons() {
    const list = el('performanceList'); list.replaceChildren();
    const groups = snapshot?.comparisons ?? [];
    if (!groups.length) {
      list.append(node('p', 'Run enrichment to see successful-request speed, reliability, and overall throughput here.', 'provider-note'));
    }
    for (const group of groups) {
      const card = node('article', null, 'performance-card');
      card.append(node('h3', [providerName(group.provider), group.model].filter(Boolean).join(' · ')));
      card.append(node('div', [group.profileName ? `${group.profileName} · revision ${group.profileRevision}` : 'Saved setup', group.host,
        !group.hostKnown ? 'Host label unavailable' : null].filter(Boolean).join(' · '), 'performance-context'));
      const m = group.metrics; const grid = node('div', null, 'performance-values');
      const value = (label, text, note) => { const n = node('div'); n.append(node('span', label, 'performance-label'), node('strong', text), node('span', note, 'performance-label')); return n; };
      grid.append(value('Typical successful request', m.latency.sampleCount ? duration(m.latency.medianMs) : 'No timing yet', `${plural(m.latency.sampleCount, 'request')} · median`),
        value('Request outcomes', `${number(m.accepted)} successful / ${number(m.requests)}`, m.timeouts ? plural(m.timeouts, 'timeout') : 'No timeouts recorded'),
        value('Overall throughput', m.photosPerMinute === null ? 'Not available' : `${rate(m.photosPerMinute)} photos/min`, `${plural(m.throughputRuns, 'completed run')}`));
      card.append(grid);
      if (m.failures || m.cancelled || m.interrupted || m.unvalidated || m.running) card.append(node('div', requestSummary(m), 'performance-context'));
      if (m.truncated) card.append(node('div', 'Partial timing history', 'performance-warning'));
      card.append(metricDetails(m)); list.append(card);
    }
    const w = snapshot?.window;
    el('performanceWindow').textContent = w?.runCount
      ? `${plural(w.runCount, 'retained run')} · ${date(w.oldestAt)}${date(w.oldestAt) === date(w.newestAt) ? '' : `–${date(w.newestAt)}`}. Recent use first.${w.partial ? ' Some timing details have expired.' : ''}` : '';
    el('performanceAll').hidden = !showAll && (snapshot?.totalComparisons ?? 0) <= 3;
    el('performanceAll').textContent = showAll ? 'Show recent comparisons' : `Show all comparisons (${number(snapshot?.totalComparisons)})`;
  }
  async function refresh() {
    if (loading) return;
    loading = true; el('performanceAll').disabled = true; el('performanceRetry').hidden = true;
    try {
      snapshot = await api(`/api/enrich/performance?limit=${showAll ? 100 : 3}`);
      el('performanceError').textContent = ''; renderComparisons(); changed();
    } catch (error) {
      el('performanceError').textContent = `Could not refresh performance. ${error.message}`;
      el('performanceRetry').hidden = false;
    } finally { loading = false; el('performanceAll').disabled = false; }
  }
  function decorateRun(card, run, actions) {
    const data = snapshot?.runs.find(r => r.timingRunId === run.timingRunId);
    if (data) {
      const m = data.metrics;
      card.append(node('div', `${m.latency.sampleCount ? `Typical successful request: ${duration(m.latency.medianMs)}. ` : ''}${requestSummary(m)}.`, 'detail performance-run-summary'));
      if (m.truncated) card.append(node('div', 'Partial timing history', 'performance-warning'));
      card.append(metricDetails(m));
    } else {
      card.append(node('div', run.timingRunId ? 'Timing summary unavailable' : 'Detailed timing was not recorded for this run.', 'detail'));
    }
    if (run.timingRunId) {
      const b = button('View photo details', () => void openPhotos(run, b)); b.classList.add('run-photo-details'); b.dataset.timingRunId = String(run.timingRunId); actions.prepend(b);
    }
  }
  const outcomeLabel = value => ({ succeeded: 'Enriched', failed: 'Failed', cancelled: 'Cancelled', interrupted: 'Interrupted', running: 'In progress',
    accepted: 'Successful response', timeout: 'Timed out', http_error: 'HTTP error', transport_error: 'Connection error', invalid_response: 'Invalid response',
    response_received: 'Response received; not validated', other_error: 'Other error' }[value] ?? value);

  async function openPhotos(run, opener) {
    returnFocus = opener; returnRunId = run.timingRunId;
    const seq = ++generation; controller?.abort(); controller = new AbortController();
    const signal = controller.signal;
    el('photoTimingTitle').textContent = run.title || 'Photo details';
    const body = el('photoTimingBody'); body.replaceChildren();
    el('photoTimingNote').textContent = 'Photo time includes downloading, retries, and saving results. Expand a photo to inspect its requests.';
    dialog.showModal(); el('photoTimingClose').focus();
    let cursor = null; let pending = false;
    const list = node('div', null, 'timing-photo-list'); const message = node('div', 'Loading photos…', 'provider-note');
    const more = button('Load more photos', () => void load()); more.hidden = true; body.append(message, list, more);
    async function load() {
      if (pending) return; pending = true; more.disabled = true;
      try {
        const page = await api(`/api/enrich/timings/${run.timingRunId}/photos?limit=20${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, { signal });
        if (seq !== generation) return;
        for (const photo of page.items) list.append(photoRow(photo, seq, signal));
        cursor = page.nextCursor; more.textContent = 'Load more photos'; more.hidden = !cursor;
        message.textContent = page.retained
          ? `${plural(list.childElementCount, 'photo')} shown of ${number(page.retained)} retained.${page.truncated ? ' Older photo details have expired.' : ''}`
          : 'No photos were processed in this run. Skipped photos do not have request timings.';
        const skipped = (page.run.skipped_successful ?? 0) + (page.run.skipped_discarded ?? 0) + (page.run.skipped_failure_limit ?? 0);
        if (skipped) message.textContent += ` ${plural(skipped, 'photo')} skipped.`;
        if (!page.retained && page.truncated) message.textContent = 'Photo timing details have expired.';
      } catch (error) {
        if (seq !== generation) return;
        message.textContent = error.status === 404 ? 'Timing expired. The run summary is still available.' : `Could not load photos. ${error.message}`;
        more.textContent = 'Try again'; more.hidden = error.status === 404;
      } finally { if (seq === generation) { pending = false; more.disabled = false; } }
    }
    await load();
  }
  function photoRow(photo, seq, signal) {
    const row = node('details', null, 'timing-photo'); const summary = node('summary');
    const img = node('img'); img.alt = ''; img.loading = 'lazy'; img.src = `/api/review/thumbnail/${encodeURIComponent(photo.asset_id)}`;
    img.addEventListener('error', () => { img.hidden = true; });
    const info = node('span', null, 'timing-photo-info');
    const name = photo.filename || `Photo ${photo.asset_id}`;
    info.append(node('strong', name));
    let result = outcomeLabel(photo.outcome);
    if (photo.outcome === 'interrupted' && photo.savedResultAvailable) result = 'Saved enrichment available · timing interrupted';
    if (photo.resultStatus === 'succeeded') result = 'Enriched';
    info.append(node('span', `${result} · ${plural(photo.attempt_count, 'request')}`, 'performance-context'));
    const time = node('span', validPhotoDuration(photo.duration_ms) ? duration(photo.duration_ms) : photo.outcome === 'running' ? 'In progress' : 'Timing incomplete', 'timing-photo-duration');
    summary.append(img, info, time); row.append(summary);
    const content = node('div', null, 'timing-attempts'); row.append(content);
    let loaded = false; let pending = false; let cursor = null; let shown = 0;
    const notice = node('div', '', 'provider-note'); const list = node('ol'); const more = button('Load more requests', () => void load());
    more.hidden = true; content.append(notice, list, more);
    if (photo.outcome === 'interrupted' && photo.savedResultAvailable) content.prepend(node('p', 'This photo has saved enrichment. This execution’s completion time is unknown; the saved result may be from an earlier run.', 'provider-note'));
    if (photo.error_kind === 'download_error') content.prepend(node('p', 'The image could not be downloaded.', 'provider-note'));
    row.addEventListener('toggle', () => { if (row.open && !loaded) void load(); });
    async function load() {
      if (pending) return; pending = true; more.disabled = true; notice.textContent = 'Loading requests…';
      try {
        const page = await api(`/api/enrich/timings/photos/${photo.id}/attempts?limit=20${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, { signal });
        if (seq !== generation) return;
        for (const attempt of page.items) {
          list.append(node('li', `Request ${attempt.ordinal}${attempt.ordinal > 1 ? ' (retry)' : ''} · ${outcomeLabel(attempt.outcome)}${attempt.http_status ? ` · HTTP ${attempt.http_status}` : ''} · ${duration(attempt.duration_ms)}`));
        }
        shown += page.items.length; loaded = true; cursor = page.nextCursor;
        notice.textContent = page.retained ? `${shown} of ${page.retained} retained requests.${page.truncated ? ' Some request details have expired.' : ''}` : page.truncated ? 'Request timing details have expired.' : 'No provider request was sent.';
        more.textContent = 'Load more requests'; more.hidden = !cursor;
      } catch (error) {
        if (seq !== generation) return;
        notice.textContent = error.status === 404 ? 'Timing expired.' : `Could not load requests. ${error.message}`;
        more.textContent = 'Try again'; more.hidden = error.status === 404;
      } finally { if (seq === generation) { pending = false; more.disabled = false; } }
    }
    return row;
  }
  function validPhotoDuration(value) { return typeof value === 'number' && Number.isFinite(value) && value >= 0; }
  return { refresh, decorateRun };
}
