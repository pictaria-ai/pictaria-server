import { rankObservation } from './rank-evidence.js';
import { request } from './client.js';
import { node } from './photos.js';

async function stream(body, signal, receive) {
  const response = await fetch('/api/review/curate/lab/ranks/run', { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal });
  if (response.status === 401) window.pictariaGate?.show();
  if (!response.ok) {
    const value = await response.json();
    throw Object.assign(Error(value.error?.message || 'Could not start rank comparison.'), { code: value.error?.code });
  }
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let buffer = '', bytes = 0, finished = false;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 256 * 1024) throw Error('Rank response exceeded its size limit.');
      buffer += decoder.decode(value, { stream: true });
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const event = JSON.parse(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1);
        if (event.type === 'error') throw Object.assign(Error(event.message), { code: event.code });
        if (event.type === 'done') finished = true;
        receive(event);
      }
    }
    if (!finished || buffer.trim()) throw Error('Rank comparison was interrupted. Completed rows are retained.');
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

export class RankComparison {
  constructor({ root, tableRoot, viewId, groupId, photos, onChange, onBusy, onFocus }) {
    Object.assign(this, { root, viewId, groupId, photos, onChange, onBusy, onFocus });
    this.rows = new Map(); this.evidence = new Map();
    this.button = node('button', 'Check selected group', 'p-btn'); this.button.id = 'check-group-ranks';
    this.cancel = node('button', 'Cancel', 'p-btn'); this.cancel.hidden = true;
    this.reset = node('button', 'Reset ranks', 'p-btn quiet');
    this.status = node('p', '', 'p-muted'); this.status.setAttribute('role', 'status');
    this.estimate = node('p', '', 'p-muted lab-small');
    const controls = node('div', undefined, 'compare-tools'); controls.append(this.button, this.cancel, this.reset);
    this.table = node('div', undefined, 'lab-rank-scroll'); this.table.tabIndex = 0;
    this.table.setAttribute('role', 'region'); this.table.setAttribute('aria-label', 'Directional search ranks; scroll to see more columns');
    root.replaceChildren(controls, this.estimate, this.status);
    tableRoot.replaceChildren(this.table);
    this.button.onclick = () => this.run();
    this.cancel.onclick = () => this.controller?.abort();
    this.reset.onclick = () => {
      this.rows.clear(); this.evidence.clear(); this.scope = null;
      this.status.textContent = 'Evidence reset. Valid cached searches may be reused.';
      this.render(); this.onChange(); void this.prepare();
    };
    this.render(); void this.prepare();
  }
  body() {
    return { viewId: this.viewId, groupId: this.groupId, scope: this.scope,
      completed: [...this.rows].filter(([, row]) => row.state !== 'loading').map(([id]) => id) };
  }
  async prepare() {
    if (this.disposed || this.running) return;
    const generation = this.generation = (this.generation || 0) + 1;
    this.button.disabled = true; this.plan = null;
    try {
      const plan = await request('lab/ranks/plan', this.body());
      if (this.disposed || generation !== this.generation) return;
      this.plan = plan; this.scope = plan.scope;
      this.estimate.textContent = `${plan.newSearches} new searches · ${plan.cached} cached${plan.remaining ? ` · ${plan.remaining} left for later` : ''}. At least 2 seconds apart; slower if Immich is busy.`;
      this.button.textContent = this.rows.size ? 'Check remaining references' : 'Check selected group';
      this.button.disabled = plan.newSearches + plan.cached === 0;
    } catch (error) {
      if (this.disposed || generation !== this.generation) return;
      this.estimate.textContent = error.message;
      this.invalidate(error);
    }
  }
  invalidate(error) {
    if (['lab_rank_changed', 'similarity_reference_changed', 'lab_expired'].includes(error.code)) {
      this.rows.clear(); this.evidence.clear(); this.scope = null;
      this.render(); this.onChange();
    }
  }
  async run() {
    if (!this.plan || this.running || this.disposed) return;
    this.running = true; this.generation++;
    this.controller = new AbortController();
    this.button.disabled = true; this.reset.disabled = true; this.cancel.hidden = false;
    this.onBusy(true); this.status.textContent = 'Starting rank comparison…';
    try {
      await stream({ ...this.body(), admission: this.plan.admission }, this.controller.signal, event => {
        if (this.disposed) return;
        if (event.type === 'progress') {
          this.rows.set(event.referenceId, { state: 'loading' });
          this.status.textContent = `${event.completed} of ${event.total} new searches complete · checking Photo ${this.photos.findIndex(p => p.id === event.referenceId) + 1} (may wait for request pacing).`;
        } else if (event.type === 'row') this.rows.set(event.row.referenceId, event.row);
        else if (event.type === 'done') this.status.textContent = event.message;
        this.render();
      });
    } catch (error) {
      if (!this.disposed) {
        this.status.textContent = this.controller.signal.aborted ? 'Cancelled. Completed rows are retained; remaining references are unqueried.' : error.message;
        this.invalidate(error);
      }
    } finally {
      this.running = false;
      if (!this.disposed) {
        for (const [id, row] of this.rows) if (row.state === 'loading') this.rows.delete(id);
        this.evidence = new Map(this.rows);
        this.cancel.hidden = true; this.reset.disabled = false;
        this.render(); this.onBusy(false); this.onChange(); void this.prepare();
      }
    }
  }
  render() {
    if (this.photos.length > 40 || this.photos.length < 2) { this.table.replaceChildren(); return; }
    const table = node('table'), caption = node('caption', 'Row → column: raw rank, then photos outside this time group ranked ahead. — means not returned, not a mismatch.');
    table.append(caption);
    const head = node('thead'), labels = node('tr'); labels.append(node('th', 'Search from ↓ / to →'));
    for (let i = 0; i < this.photos.length; i++) { const th = node('th', String(i + 1)); th.scope = 'col'; labels.append(th); }
    labels.append(node('th', 'Evidence')); head.append(labels); table.append(head);
    const body = node('tbody');
    for (let i = 0; i < this.photos.length; i++) {
      const photo = this.photos[i], row = this.rows.get(photo.id), tr = node('tr'), label = node('th'); label.scope = 'row';
      const button = node('button', `Photo ${i + 1}`, 'p-btn quiet'); button.onclick = () => this.onFocus(photo.id);
      label.append(button); tr.append(label);
      for (const target of this.photos) {
        const observation = rankObservation(row, target.id), rank = observation?.rank;
        const cell = node('td', target.id === photo.id ? '·' : row?.state !== 'complete' ? '?' : rank == null ? '—' : String(rank));
        if (target.id !== photo.id && observation) cell.append(node('small', ` ${observation.outsideAhead} outside`, 'rank-outside'));
        cell.title = target.id === photo.id ? 'Reference itself' : row?.state === 'complete'
          ? rank == null ? `Not in ${row.returned} returned results (maximum ${row.limit}); similarity unknown` : `Raw rank ${rank}; ${observation.outsideAhead} photos outside the selected time group ahead. Not a distance.`
          : row?.state === 'failed' ? row.message : row?.state === 'loading' ? 'Waiting or searching' : 'Unqueried';
        tr.append(cell);
      }
      tr.append(node('td', row?.state === 'complete'
        ? `${row.cached ? 'Cached' : 'Complete'} · ${row.returned}/${row.limit} results · ${new Date(row.checkedAt).toLocaleTimeString()} · ${(row.elapsedMs / 1000).toFixed(2)} s`
        : row?.state === 'failed' ? `Failed: ${row.message}` : row?.state === 'loading' ? 'Waiting / searching…' : 'Unqueried'));
      body.append(tr);
    }
    table.append(body); this.table.replaceChildren(table);
  }
  summary() {
    const number = id => this.photos.findIndex(p => p.id === id) + 1;
    return ['Directional ranks (timeline images; first 50 excluding each reference)', ...this.photos.map(p => {
      const row = this.rows.get(p.id);
      return `Photo ${number(p.id)}: ${row?.state === 'complete'
        ? `${row.cached ? 'cached' : 'complete'}, ${row.returned}/${row.limit} results, ${new Date(row.checkedAt).toISOString()}; ` + row.photos.filter(t => t.id !== p.id).map(t => { const o = rankObservation(row, t.id); return `${number(t.id)}=${o ? `#${o.rank} / ${o.outsideAhead} outside ahead` : 'not returned'}`; }).join(', ')
        : row?.state ?? 'unqueried'}`;
    })].join('\n');
  }
  dispose() { this.disposed = true; this.controller?.abort(); }
}
