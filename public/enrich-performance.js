/* Enrich timing presentation. Result state, request outcomes, and timing
 * availability stay distinct; all external labels enter through textContent. */
function createEnrichPerformance({ api, changed = () => {}, closed = () => {} }) {
  const el = id => document.getElementById(id);
  const node = (tag, text, cls) => { const n = document.createElement(tag); if (text != null) n.textContent = text; if (cls) n.className = cls; return n; };
  const number = n => Number(n ?? 0).toLocaleString();
  const { duration, rate, when, status, elapsed: runElapsed, provider: providerName } = enrichFormat;
  const plural = (n, singular, multiple = `${singular}s`) => `${number(n)} ${n === 1 ? singular : multiple}`;
  const button = (text, action) => { const b = node('button', text, 'p-btn quiet'); b.type = 'button'; b.addEventListener('click', action); return b; };
  const date = value => when(value, true);
  let returnFocus = null; let returnRunId = null; let returnJobId = null;
  let snapshot = null; let showAll = false; let loading = false; let generation = 0; let controller = null;
  const dialog = el('photoTimingDialog');
  dialog.addEventListener('close', () => {
    // Native close events are queued. An earlier dialog's event must not
    // cancel a different run the user has already opened.
    if (!dialog.open) {
      generation++; controller?.abort();
      const target = returnFocus?.isConnected ? returnFocus : [...document.querySelectorAll('.run-photo-details')].find(b => b.dataset.timingRunId === String(returnRunId));
      target?.focus({ preventScroll: true });
      closed(returnJobId);
    }
  });
  let backdropPress = false;
  const outsideDialog = event => {
    const r = dialog.getBoundingClientRect();
    return event.target === dialog && (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom);
  };
  dialog.addEventListener('pointerdown', event => { backdropPress = outsideDialog(event); });
  dialog.addEventListener('pointercancel', () => { backdropPress = false; });
  dialog.addEventListener('click', event => {
    if (backdropPress && outsideDialog(event)) dialog.close();
    backdropPress = false;
  });
  el('photoTimingClose').addEventListener('click', () => dialog.close());
  let copyReset = null;
  el('photoTimingCopy').addEventListener('click', async () => {
    const seq = generation;
    const text = [el('photoTimingTitle').innerText, el('photoTimingNote').innerText,
      el('photoTimingBody').innerText].filter(Boolean).join('\n\n');
    let copied = false;
    try { await navigator.clipboard.writeText(text); copied = true; }
    catch {
      if (seq !== generation || !dialog.open) return;
      // Keep the fallback inside the modal: the rest of the document is inert.
      const scratch = node('textarea'); scratch.value = text;
      scratch.style.position = 'fixed'; scratch.style.opacity = '0';
      dialog.append(scratch); scratch.select();
      try { copied = document.execCommand('copy'); } catch { /* Report failure. */ }
      scratch.remove(); el('photoTimingCopy').focus({ preventScroll: true });
    }
    if (seq !== generation || !dialog.open) return;
    clearTimeout(copyReset); el('photoTimingCopy').textContent = copied ? 'Copied ✓' : 'Copy failed';
    copyReset = setTimeout(() => { el('photoTimingCopy').textContent = 'Copy'; }, 1600);
  });
  el('performanceAll').addEventListener('click', () => { showAll = !showAll; void refresh(); });
  el('performanceRetry').addEventListener('click', () => void refresh());

  function requestSummary(m) {
    return [m.requests ? `${number(m.accepted)} of ${number(m.requests)} requests succeeded` : 'No requests recorded', m.timeouts ? `${number(m.timeouts)} timed out` : null,
      m.failures ? plural(m.failures, 'other failure') : null, m.cancelled ? `${number(m.cancelled)} cancelled` : null,
      m.interrupted ? `${number(m.interrupted)} interrupted` : null, m.unvalidated ? `${number(m.unvalidated)} not validated` : null,
      m.running ? `${number(m.running)} in progress` : null].filter(Boolean).join(' · ');
  }
  function metricDetails(m) {
    const details = node('details', null, 'performance-more'); details.append(node('summary', 'More metrics'));
    const content = node('div', null, 'performance-explanation');
    content.append(node('p', `Successful requests: median ${duration(m.latency.medianMs)}; average ${duration(m.latency.meanMs)}. Based on ${plural(m.latency.sampleCount, 'measured, accepted request')}.`));
    content.append(node('p', [requestSummary(m) + '.', `${plural(m.requests, 'retained request')}.`, m.retries ? `${plural(m.retries, 'retry request')}.` : null, m.invalidResponses ? `${plural(m.invalidResponses, 'invalid response')} included in other failures.` : null].filter(Boolean).join(' ')));
    content.append(node('p', `These requests came from ${plural(m.retainedPhotos, 'retained photo execution')} across ${plural(m.runCount, 'run')}. ${number(m.failedRuns)} failed, ${number(m.cancelledRuns)} cancelled, ${number(m.interruptedRuns)} interrupted, ${number(m.activeRuns)} in progress. Each photo can have several requests.`));
    content.append(node('p', m.throughputRuns
      ? `Overall throughput: ${rate(m.photosPerMinute)} successful photos/min; ${m.secondsPerPhoto === null ? 'seconds per successful photo unavailable (no successes)' : `${rate(m.secondsPerPhoto)} seconds per successful photo`}. ${plural(m.successfulPhotos, 'successful photo')} over ${duration(m.elapsedMs)} in ${plural(m.throughputRuns, 'completed run')}. Includes download, preparation, failures, and retry waits.`
      : 'Overall throughput is unavailable until a completed run has processed photos. Failed, cancelled, and interrupted runs can still contribute accepted request timings.'));
    if (m.truncated) content.append(node('p', `Some older timing details have expired. ${number(m.requests)} of ${number(m.recordedRequests)} recorded requests and ${number(m.retainedPhotos)} of ${number(m.photoCount)} processed photos remain. Request metrics use these remaining records.`, 'performance-warning'));
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
      const setup = node('div', null, 'performance-setup');
      setup.append(node('span', group.profileName ? `Profile: ${group.profileName} · revision ${group.profileRevision}` : 'Profile unavailable'));
      if (group.host) setup.append(node('span', `Host: ${group.host}`));
      else if (!group.hostKnown) setup.append(node('span', 'Host label unavailable'));
      card.append(setup, node('div', `Last used ${when(group.lastUsedAt)}`, 'performance-context'));

      const m = group.metrics; const grid = node('div', null, 'performance-values');
      const value = (label, text, note) => { const n = node('div'); n.append(node('span', label, 'performance-label'), node('strong', text), node('span', note, 'performance-label')); return n; };
      grid.append(value('Typical successful request', m.latency.sampleCount ? duration(m.latency.medianMs) : 'No timing yet', `${plural(m.latency.sampleCount, 'request')} · median`),
        value('Requests', `${number(m.accepted)} of ${number(m.requests)} requests succeeded`, m.timeouts ? `${number(m.timeouts)} timed out` : 'No timeouts recorded'),
        value('Overall throughput', m.photosPerMinute === null ? 'Not available' : `${rate(m.photosPerMinute)} photos/min`, `${plural(m.throughputRuns, 'completed run')}`));
      card.append(grid);
      if (m.failures || m.cancelled || m.interrupted || m.unvalidated || m.running) card.append(node('div', requestSummary(m), 'performance-context'));
      if (m.truncated) card.append(node('div', 'Some older timing details have expired. Request metrics use the remaining records.', 'performance-warning'));
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
  function runSummary(run) {
    const summary = node('section', null, 'run-detail-summary');
    summary.append(node('p', [providerName(run.provider), run.model, run.profile?.name,
      run.inferenceHostLabel].filter(Boolean).join(' · '), 'performance-context'));
    summary.append(node('p', when(run.startedAt), 'performance-context'));
    const sections = node('div', null, 'run-metric-sections'); summary.append(sections);
    const section = title => {
      const box = node('section'); box.append(node('h3', title));
      const list = node('dl', null, 'run-metrics'); box.append(list); sections.append(box);
      return { box, add(label, value) { list.append(node('dt', label), node('dd', value)); } };
    };
    const c = run.counters; const m = snapshot?.runs.find(r => r.timingRunId === run.timingRunId)?.metrics;
    const runInfo = section('Run'); runInfo.add('Status', status(run.status));
    runInfo.add('Photos', enrichFormat.photoOutcomes(c, run.status));
    runInfo.add('Total time', duration(runElapsed(run)));
    const throughput = Number.isFinite(run.throughput?.photosPerMinute) ? run.throughput : m?.throughputRuns ? m : null;
    runInfo.add('Throughput', throughput ? `${rate(throughput.photosPerMinute)} photos/min${Number.isFinite(throughput.secondsPerPhoto) ? ` · ${rate(throughput.secondsPerPhoto)} s/photo` : ''}` : 'Unavailable');
    runInfo.box.append(node('p', 'Throughput uses successful photos and includes downloads, failures, and retry waits.', 'provider-note'));
    if (m) {
      const requests = section('Requests');
      requests.add('Outcomes', requestSummary(m));
      if (m.invalidResponses) requests.box.append(node('p', `${plural(m.invalidResponses, 'invalid response')} included in other failures.`, 'provider-note'));
      if (m.retries) requests.add('Retries', plural(m.retries, 'request'));
      requests.add('Typical time', duration(m.latency.medianMs));
      requests.add('Average time', duration(m.latency.meanMs));
      requests.box.append(node('p', `Typical is the median. Both times use ${plural(m.latency.sampleCount, 'measured successful request')}.`, 'provider-note'));
      if (m.truncated) summary.append(node('p', `Some older timing details have expired. Request metrics use the remaining ${number(m.requests)} of ${number(m.recordedRequests)} recorded requests and ${number(m.retainedPhotos)} of ${number(m.photoCount)} photo executions.`, 'performance-warning'));
    } else if (run.timingRunId) summary.append(node('p', 'Request summary unavailable.', 'provider-note'));
    if (run.error) summary.append(node('p', String(run.error), 'performance-warning'));
    return summary;
  }
  const outcomeLabel = value => ({ succeeded: 'Enriched', failed: 'Failed', cancelled: 'Cancelled', interrupted: 'Interrupted', running: 'In progress',
    accepted: 'Successful response', timeout: 'Timed out', http_error: 'HTTP error', transport_error: 'Connection error', invalid_response: 'Invalid response',
    response_received: 'Response received; not validated', other_error: 'Other error' }[value] ?? value);

  async function openPhotos(run, opener) {
    backdropPress = false;
    returnFocus = opener; returnRunId = run.timingRunId; returnJobId = run.id;
    const seq = ++generation; controller?.abort(); controller = new AbortController();
    const signal = controller.signal;
    clearTimeout(copyReset); el('photoTimingCopy').textContent = 'Copy';
    el('photoTimingTitle').textContent = run.title || 'Photo details';
    const body = el('photoTimingBody'); body.replaceChildren(runSummary(run));
    el('photoTimingNote').textContent = 'Photo time includes downloading, retries, and saving results. Request time measures each call to the AI provider. Photo links open Immich in a new tab.';
    if (!dialog.open) dialog.showModal(); el('photoTimingClose').focus();
    if (!run.timingRunId) {
      body.append(node('p', 'Detailed timing was not recorded for this run.', 'provider-note'));
      return;
    }
    body.append(node('h3', 'Photos', 'timing-section-title'));
    let cursor = null; let pending = false;
    const list = node('div', null, 'timing-photo-list'); const message = node('div', 'Loading photos…', 'provider-note');
    const more = button('Load more photos', () => void load()); more.hidden = true; body.append(message, list, more);
    async function load() {
      if (pending) return; pending = true; more.disabled = true;
      try {
        const page = await api(`/api/enrich/timings/${run.timingRunId}/photos?limit=20${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, { signal });
        if (seq !== generation) return;
        for (const photo of page.items) list.append(photoRow(photo, page.immichUrl, seq, signal));
        cursor = page.nextCursor; more.textContent = 'Load more photos'; more.hidden = !cursor;
        message.textContent = page.retained
          ? `${plural(list.childElementCount, 'photo')} shown of ${number(page.retained)} retained.${page.truncated ? ' Older photo details have expired.' : ''}`
          : 'No photo timings were recorded for this run.';
        if (!page.retained && page.truncated) message.textContent = 'Photo timing details have expired.';
      } catch (error) {
        if (seq !== generation) return;
        message.textContent = error.status === 404 ? 'Timing expired. The run summary is still available.' : `Could not load photos. ${error.message}`;
        more.textContent = 'Try again'; more.hidden = error.status === 404;
      } finally { if (seq === generation) { pending = false; more.disabled = false; } }
    }
    await load();
  }
  function photoRow(photo, immichUrl, seq, signal) {
    const row = node('article', null, 'timing-photo'); const heading = node('div', null, 'timing-photo-heading');
    const name = photo.filename || `Photo ${photo.asset_id}`;
    let url = null;
    try {
      const candidate = new URL(`${immichUrl.replace(/\/+$/, '')}/photos/${encodeURIComponent(photo.asset_id)}`);
      if (['http:', 'https:'].includes(candidate.protocol)) url = candidate.href;
    } catch { /* No configured public URL: show the photo without a link. */ }
    const link = () => {
      const a = node('a'); a.href = url; a.target = '_blank'; a.rel = 'noopener noreferrer';
      a.title = 'Open in Immich (new tab)'; a.setAttribute('aria-label', `Open ${name} in Immich (new tab)`); return a;
    };
    const img = node('img'); img.alt = ''; img.loading = 'lazy'; img.src = `/api/review/thumbnail/${encodeURIComponent(photo.asset_id)}`;
    const imageWrap = url ? link() : node('span'); imageWrap.className = 'timing-photo-image'; imageWrap.append(img);
    img.addEventListener('error', () => { imageWrap.hidden = true; });
    const info = node('span', null, 'timing-photo-info');
    const title = node('strong', name); if (url) { const a = link(); a.append(title); info.append(a); } else info.append(title);
    let result = outcomeLabel(photo.outcome);
    if (photo.outcome === 'interrupted' && photo.savedResultAvailable) result = 'Saved enrichment available · timing interrupted';
    if (photo.resultStatus === 'succeeded') result = 'Enriched';
    info.append(node('span', result, 'performance-context'));
    const time = node('span', validPhotoDuration(photo.duration_ms) ? `${duration(photo.duration_ms)} total` : photo.outcome === 'running' ? 'In progress' : 'Timing incomplete', 'timing-photo-duration');
    heading.append(imageWrap, info, time); row.append(heading);
    const content = node('div', null, 'timing-attempts'); info.append(content);
    let pending = false; let cursor = null; let shown = 0;
    const notice = node('div', '', 'provider-note'); const list = node('ol'); const more = button('Load more requests', () => void load());
    more.hidden = true; content.append(notice, list, more);
    if (photo.outcome === 'interrupted' && photo.savedResultAvailable) content.prepend(node('p', 'This photo has saved enrichment. This execution’s completion time is unknown; the saved result may be from an earlier run.', 'provider-note'));
    if (photo.error_kind === 'download_error') content.prepend(node('p', 'The image could not be downloaded.', 'provider-note'));
    function render(page) {
      for (const attempt of page.items) {
        const sameTime = !page.truncated && !page.nextCursor && page.retained === 1
          && photo.attempt_count === 1 && validPhotoDuration(photo.duration_ms)
          && validPhotoDuration(attempt.duration_ms) && duration(photo.duration_ms) === duration(attempt.duration_ms);
        // For a single accepted request with the same displayed duration,
        // Enriched + total time already convey the complete visible result.
        if (sameTime && attempt.outcome === 'accepted' && photo.outcome === 'succeeded') continue;
        list.append(node('li', `Request ${attempt.ordinal}${attempt.ordinal > 1 ? ' (retry)' : ''}: ${outcomeLabel(attempt.outcome)}${attempt.http_status && attempt.outcome !== 'accepted' ? ` · HTTP ${attempt.http_status}` : ''}${sameTime ? '' : ` · ${duration(attempt.duration_ms)}`}`));
      }
      shown += page.items.length; cursor = page.nextCursor;
      notice.textContent = page.truncated ? `${shown} of ${page.retained} retained requests shown; some older request details have expired.`
        : cursor ? `${shown} of ${page.retained} requests shown.` : !page.retained ? 'No provider request was sent.' : '';
      if (!page.retained && page.truncated) notice.textContent = 'Request timing details have expired.';
      more.textContent = 'Load more requests'; more.hidden = !cursor;
    }
    async function load() {
      if (pending || seq !== generation) return; pending = true; more.disabled = true;
      try {
        const page = await api(`/api/enrich/timings/photos/${photo.id}/attempts?limit=20${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, { signal });
        if (seq !== generation) return;
        render(page);
      } catch (error) {
        if (seq !== generation) return;
        notice.textContent = error.status === 404 ? 'Timing expired.' : `Could not load requests. ${error.message}`;
        more.textContent = 'Try again'; more.hidden = error.status === 404;
      } finally { if (seq === generation) { pending = false; more.disabled = false; } }
    }
    if (photo.requests) render(photo.requests);
    else notice.textContent = 'Request timing details have expired.';
    return row;
  }
  function validPhotoDuration(value) { return typeof value === 'number' && Number.isFinite(value) && value >= 0; }
  return { refresh, openRun: openPhotos, close: () => { if (dialog.open) dialog.close(); } };
}
