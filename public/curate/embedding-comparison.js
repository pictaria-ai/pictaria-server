import { request } from './client.js';
import { node } from './photos.js';

async function stream(body, signal, receive) {
  const response = await fetch('/api/review/curate/lab/embeddings/run', { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal });
  if (response.status === 401) window.pictariaGate?.show();
  if (!response.ok) {
    const value = await response.json();
    throw Object.assign(Error(value.error?.message || 'Could not start computing embeddings.'), { code: value.error?.code });
  }
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let buffer = '', bytes = 0, finished = false;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 256 * 1024) throw Error('Embedding response exceeded its size limit.');
      buffer += decoder.decode(value, { stream: true });
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const event = JSON.parse(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1);
        if (event.type === 'error') throw Object.assign(Error(event.message), { code: event.code });
        if (event.type === 'done') finished = true;
        receive(event);
      }
    }
    if (!finished || buffer.trim()) throw Error('Computing embeddings was interrupted. Completed photos are kept.');
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

// Pairwise cosine similarity from stored Pictaria embeddings for the open
// group. Evidence is held fixed until an explicit pass ends or Reset.
export class EmbeddingComparison {
  constructor({ root, tableRoot, viewId, groupId, photos, onChange, onBusy, onFocus }) {
    Object.assign(this, { root, viewId, groupId, photos, onChange, onBusy, onFocus });
    this.values = new Map(); this.model = null; this.dims = null;
    this.button = node('button', 'Compute embeddings', 'p-btn'); this.button.id = 'compute-embeddings';
    this.cancel = node('button', 'Cancel', 'p-btn'); this.cancel.hidden = true;
    this.status = node('p', '', 'p-muted'); this.status.setAttribute('role', 'status');
    this.estimate = node('p', '', 'p-muted lab-small');
    const controls = node('div', undefined, 'compare-tools'); controls.append(this.button, this.cancel);
    this.table = node('div', undefined, 'lab-rank-scroll'); this.table.tabIndex = 0;
    this.table.setAttribute('role', 'region'); this.table.setAttribute('aria-label', 'Embedding similarity; scroll to see more columns');
    root.replaceChildren(controls, this.estimate, this.status);
    tableRoot.replaceChildren(this.table);
    this.button.onclick = () => this.run();
    this.cancel.onclick = () => this.controller?.abort();
    this.render(); void this.prepare();
  }
  key(a, b) { return a < b ? `${a}\n${b}` : `${b}\n${a}`; }
  // null when either photo lacks a current embedding for this model.
  similarity(a, b) { return this.values.get(this.key(a, b)) ?? null; }
  get evidence() { return { model: this.model, similarity: (a, b) => this.similarity(a, b) }; }
  coverage() {
    const covered = new Set();
    for (const key of this.values.keys()) for (const id of key.split('\n')) covered.add(id);
    return covered.size;
  }
  hold(plan) {
    this.model = plan.model; this.dims = plan.space?.dims ?? null;
    const values = new Map(), ids = plan.similarity.ids;
    let k = 0;
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
      const value = plan.similarity.values[k++];
      if (typeof value === 'number') values.set(this.key(ids[i], ids[j]), value);
    }
    this.values = values;
  }
  async prepare({ adopt = false } = {}) {
    if (this.disposed || this.running) return;
    const generation = this.generation = (this.generation || 0) + 1;
    this.button.disabled = true; this.plan = null;
    try {
      const plan = await request('lab/embeddings/plan', { viewId: this.viewId, groupId: this.groupId });
      if (this.disposed || generation !== this.generation) return;
      this.plan = plan;
      // Opening a group shows stored evidence; later passes replace it only
      // when they end, never mid-pass.
      if (adopt || this.model === null) { this.hold(plan); this.render(); this.onChange(); }
      this.estimate.textContent = !plan.configured
        ? 'Set the Immich machine-learning URL in Settings → Enrich → Image embeddings to compute embeddings.'
        : `${plan.current} of ${plan.total} photos have embeddings from ${plan.model}${plan.space ? ` (${plan.space.dims} dimensions)` : ''}.`
          + (plan.missing ? ` ${plan.newEmbeddings} new in the next pass${plan.remaining ? `, ${plan.remaining} left for later` : ''}; about 0.2–1 s each, no AI calls.`
            : ' Recheck service confirms they still match what the machine-learning service returns now (one request).')
          + (plan.busy ? ' An Enrich run is embedding photos now; try again when it finishes.' : '');
      // Every pass starts by checking the service, so a changed service is
      // noticed even when this group looks fully covered.
      this.button.textContent = !plan.missing ? 'Recheck service' : plan.current ? 'Compute missing embeddings' : 'Compute embeddings';
      this.button.disabled = !plan.configured || plan.busy;
    } catch (error) {
      if (this.disposed || generation !== this.generation) return;
      this.estimate.textContent = error.message;
    }
  }
  async run() {
    if (!this.plan || this.running || this.disposed) return;
    this.running = true; this.generation++;
    this.controller = new AbortController();
    this.button.disabled = true; this.cancel.hidden = false;
    this.onBusy(true); this.status.textContent = 'Starting…';
    const number = id => this.photos.findIndex(p => p.id === id) + 1;
    try {
      await stream({ viewId: this.viewId, groupId: this.groupId, admission: this.plan.admission }, this.controller.signal, event => {
        if (this.disposed) return;
        if (event.type === 'calibrating') this.status.textContent = `Checking ${this.plan.model} on the machine-learning service (a model’s first use downloads it)…`;
        else if (event.type === 'space') this.status.textContent = (event.replacesEarlier
          ? `The service now returns different vectors for ${this.plan.model}, so a new set starts. `
          : event.created ? 'Started a new set of embeddings. ' : '')
          + (event.newEmbeddings ? `${event.newEmbeddings} photo${event.newEmbeddings === 1 ? '' : 's'} to embed…` : 'Every photo is current.');
        else if (event.type === 'progress') this.status.textContent = `${event.completed} of ${event.total} photos embedded · embedding Photo ${number(event.assetId)}…`;
        else if (event.type === 'done') this.status.textContent = event.message;
      });
    } catch (error) {
      if (!this.disposed) this.status.textContent = this.controller.signal.aborted
        ? 'Cancelled. Embeddings already computed are kept.' : error.message;
    } finally {
      this.running = false;
      if (!this.disposed) {
        this.cancel.hidden = true; this.onBusy(false);
        await this.prepare({ adopt: true });
      }
    }
  }
  render() {
    if (this.photos.length < 2) { this.table.replaceChildren(); return; }
    const table = node('table', undefined, 'embedding-matrix'), caption = node('caption', `Cosine similarity of Pictaria embeddings${this.model ? ` (${this.model})` : ''}. Higher is more alike; — means a photo has no embedding yet.`);
    table.append(caption);
    const head = node('thead'), labels = node('tr'); labels.append(node('th', 'Photo'));
    for (let i = 0; i < this.photos.length; i++) { const th = node('th', String(i + 1)); th.scope = 'col'; labels.append(th); }
    head.append(labels); table.append(head);
    const body = node('tbody');
    for (let i = 0; i < this.photos.length; i++) {
      const photo = this.photos[i], tr = node('tr'), label = node('th'); label.scope = 'row';
      const button = node('button', `Photo ${i + 1}`, 'p-btn quiet'); button.onclick = () => this.onFocus(photo.id);
      label.append(button); tr.append(label);
      for (const target of this.photos) {
        const value = target.id === photo.id ? null : this.similarity(photo.id, target.id);
        tr.append(node('td', target.id === photo.id ? '·' : value === null ? '—' : value.toFixed(3)));
      }
      body.append(tr);
    }
    table.append(body); this.table.replaceChildren(table);
  }
  summary() {
    const number = id => this.photos.findIndex(p => p.id === id) + 1;
    const lines = [`Pictaria embeddings (${this.model ?? 'none'}): ${this.coverage()} of ${this.photos.length} photos covered`];
    for (let i = 0; i < this.photos.length; i++) for (let j = i + 1; j < this.photos.length; j++) {
      const value = this.similarity(this.photos[i].id, this.photos[j].id);
      if (value !== null) lines.push(`Photos ${number(this.photos[i].id)} ↔ ${number(this.photos[j].id)}: ${value.toFixed(3)}`);
    }
    return lines.join('\n');
  }
  dispose() { this.disposed = true; this.controller?.abort(); }
}
