/* Navigation and paged history for the dedicated Enrich performance page. */
const performancePage = (() => {
  const el = id => document.getElementById(id);
  const node = (tag, text, cls) => { const n = document.createElement(tag); if (text != null) n.textContent = text; if (cls) n.className = cls; return n; };
  const providers = { local_lmstudio: 'LM Studio', local_ollama: 'Ollama (local)', cloud_ollama: 'Ollama (cloud)', cloud_openai: 'OpenAI', openrouter: 'OpenRouter', venice: 'Venice', openai_compatible: 'OpenAI-compatible' };
  const count = n => Number(n ?? 0).toLocaleString();
  const when = value => { if (!value) return 'Date unavailable'; const d = new Date(value); return Number.isFinite(d.getTime()) ? d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : 'Date unavailable'; };
  const elapsed = run => {
    const ms = run.startedAt && run.finishedAt ? new Date(run.finishedAt) - new Date(run.startedAt) : NaN;
    if (!Number.isFinite(ms) || ms < 0) return 'Unavailable';
    if (ms < 1000) return `${ms} ms`;
    return ms < 60000 ? `${(ms / 1000).toLocaleString(undefined, { maximumFractionDigits: 1 })} s` : `${Math.floor(ms / 60000)}m ${Math.floor(ms % 60000 / 1000)}s`;
  };
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
      const setup = cell('Setup'); setup.append(node('div', [providers[run.provider] ?? run.provider, run.model].filter(Boolean).join(' · ')),
        node('div', run.profile?.name || 'Profile unavailable', 'performance-context'));
      if (run.inferenceHostLabel) setup.append(node('div', run.inferenceHostLabel, 'performance-context'));
      const outcomes = cell('Photo outcomes'); const c = run.counters;
      outcomes.append(node('div', run.status === 'finished' ? 'Completed' : run.status, 'run-status'),
        node('div', c ? `${count(c.succeeded)} successful · ${count(c.failed)} failed` : 'Counts unavailable', 'performance-context'));
      const skipped = (c?.skippedSuccessful ?? 0) + (c?.skippedFailureLimit ?? 0) + (c?.skippedDiscarded ?? 0);
      if (skipped) outcomes.append(node('div', `${count(skipped)} skipped`, 'performance-context'));
      cell('Total time').textContent = elapsed(run); list.append(row);
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
