/* Navigation and paged history for the dedicated Enrich performance page. */
const performancePage = (() => {
  const el = id => document.getElementById(id);
  const node = (tag, text, cls) => { const n = document.createElement(tag); if (text != null) n.textContent = text; if (cls) n.className = cls; return n; };
  const { provider, status, when, duration, elapsed, rate } = enrichFormat;
  const count = n => Number(n ?? 0).toLocaleString();
  let runs = []; let cursor = null; let total = 0; let loading = false; let ready = false; let selection = 0;
  async function api(path, options = {}) {
    const response = await fetch(path, options);
    if (response.status === 401) window.pictariaGate?.show();
    const body = await response.json().catch(() => null);
    if (!response.ok) { const error = new Error(body?.error?.message ?? `Request failed: ${response.status}`); error.status = response.status; throw error; }
    return body;
  }
  const metrics = createEnrichPerformance({ api, closed(id) {
    if (location.hash === `#run=${id}`) history.replaceState(null, '', '#runs');
  } });
  function renderRuns() {
    const list = el('performanceRuns'); list.replaceChildren();
    for (const run of runs) {
      const row = node('tr'); row.dataset.runId = String(run.id);
      const cell = (label) => { const td = node('td'); td.dataset.label = label; row.append(td); return td; };
      const title = cell('Run'); const link = node('a', run.title || `Run ${run.id}`, 'run-detail-link');
      link.href = `#run=${run.id}`; link.dataset.timingRunId = String(run.timingRunId); link.classList.add('run-photo-details');
      title.append(link, node('div', when(run.startedAt), 'performance-context'));
      const setup = cell('Setup'); setup.append(node('div', [provider(run.provider), run.model].filter(Boolean).join(' · ')),
        node('div', run.profile?.name || 'Profile unavailable', 'performance-context'));
      if (run.inferenceHostLabel) setup.append(node('div', run.inferenceHostLabel, 'performance-context'));
      const outcomes = cell('Photo outcomes'); const c = run.counters;
      outcomes.append(node('div', status(run.status), 'run-status'),
        node('div', enrichFormat.photoOutcomes(c, run.status), 'performance-context'));
      const time = cell('Total time'); time.append(node('div', duration(elapsed(run))));
      if (Number.isFinite(run.throughput?.photosPerMinute)) {
        const throughput = node('div', `${rate(run.throughput.photosPerMinute)} photos/min`, 'performance-context run-throughput');
        throughput.title = 'Successful photos per minute, including downloads, failures, and retry waits.';
        time.append(throughput);
      }
      list.append(row);
    }
    el('runsCount').textContent = total ? `Showing ${count(runs.length)} of ${count(total)} retained runs` : 'No runs yet. Start enrichment from the Enrich page.';
    el('runsMore').hidden = !cursor;
  }
  async function loadRuns(more = false) {
    if (loading) return; loading = true;
    el('runsMore').disabled = true; el('runsRetry').hidden = true;
    try {
      const page = await api(`/api/enrich/runs?limit=20${more && cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      runs = more ? [...runs, ...page.runs.filter(r => !runs.some(old => old.id === r.id))] : page.runs;
      cursor = page.nextCursor; total = page.total; el('runsError').textContent = ''; renderRuns();
    } catch (error) { el('runsError').textContent = `Could not load runs. ${error.message}`; el('runsRetry').hidden = false; el('runsRetry').onclick = () => void loadRuns(more); }
    finally { loading = false; el('runsMore').disabled = false; }
  }
  async function navigate() {
    const seq = ++selection;
    const compare = location.hash === '#compare';
    el('runsView').hidden = compare; el('compareView').hidden = !compare;
    for (const [id, active] of [['runsViewLink', !compare], ['compareViewLink', compare]]) {
      if (active) el(id).setAttribute('aria-current', 'page'); else el(id).removeAttribute('aria-current');
    }
    if (!ready) return;
    const match = location.hash.match(/^#run=(\d+)$/);
    if (!match) { metrics.close(); return; }
    const id = Number(match[1]);
    try {
      // One exact read also handles links to runs beyond the first history page.
      const run = runs.find(r => r.id === id) ?? (await api(`/api/enrich/runs/${match[1]}`)).run;
      if (seq !== selection) return;
      const opener = document.querySelector(`.run-detail-link[href="#run=${id}"]`) ?? el('runsViewLink');
      void metrics.openRun(run, opener);
    } catch (error) {
      if (seq !== selection) return;
      metrics.close();
      el('runsError').textContent = error.status === 404 ? 'This run is no longer available in history.' : `Could not open this run. ${error.message}`;
      el('runsRetry').hidden = false; el('runsRetry').onclick = () => void navigate();
    }
  }
  async function refresh() {
    el('refreshPerformance').disabled = true;
    try { await Promise.all([loadRuns(), metrics.refresh()]); ready = true; await navigate(); }
    finally { el('refreshPerformance').disabled = false; }
  }
  el('runsMore').addEventListener('click', () => void loadRuns(true));
  el('refreshPerformance').addEventListener('click', () => void refresh());
  window.addEventListener('hashchange', () => void navigate());
  void navigate(); void refresh();
  return { refresh, metrics };
})();
