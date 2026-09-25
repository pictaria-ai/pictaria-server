// Browser-side scope and retry protocol. Rendering never owns operation IDs.
const ROOT = '/api/review/curate/';
const KEY = 'pictaria.curate.preview';
export async function request(path, body, { signal } = {}) {
  const response = await fetch(
    ROOT + path,
    { ...(signal ? { signal } : {}), ...(body === undefined
      ? {}
      : {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }) },
  );
  if (response.status === 401) window.pictariaGate?.show();
  const value = await response.json();
  if (!response.ok) {
    const error = new Error(value.error?.message || `Request failed (${response.status}).`);
    error.status = response.status;
    error.code = value.error?.code;
    throw error;
  }
  return value;
}

export class CurateClient {
  constructor({ api = request, storage = sessionStorage } = {}) {
    this.api = api;
    this.storage = storage;
    try {
      this.saved = JSON.parse(storage.getItem(KEY)) || {};
    } catch {
      this.saved = {};
    }
    this.serial = Promise.resolve();
  }
  save(patch) {
    const next = { ...this.saved, ...patch };
    // Save before sending an action: a reload must not lose an uncertain ID.
    this.storage.setItem(KEY, JSON.stringify(next));
    this.saved = next;
  }
  async claimTab() {
    const nonce = `${Date.now()}-${Math.random()}`;
    const tabId = this.saved.tabId || nonce;
    let claimed = false,
      collision = false;
    // sessionStorage is copied when a tab is duplicated. Do not let that copy
    // replace the original tab's live view. Also works on HTTP LAN installs.
    if (typeof BroadcastChannel === 'function') {
      const channel = new BroadcastChannel('pictaria-curate-views');
      channel.onmessage = ({ data }) => {
        if (data.tabId !== tabId || data.nonce === nonce) return;
        if (claimed && !data.owned) channel.postMessage({ tabId, nonce, owned: true });
        else if (data.owned || data.nonce < nonce) collision = true;
      };
      channel.postMessage({ tabId, nonce });
      await new Promise((resolve) => setTimeout(resolve, 160));
      if (collision) channel.close();
      else {
        claimed = true;
        this.channel = channel;
      }
    } else {
      this.save({ tabId: nonce, viewId: null });
      return;
    }
    if (collision) {
      // An inherited unresolved operation is safe to replay, but not a view.
      this.save({ tabId: nonce, viewId: null });
      return this.claimTab();
    }
    this.save({ tabId });
  }
  open(filters) {
    const run = async () => {
      const view = await this.api('groups', { ...filters, replacesViewId: this.saved.viewId || null });
      this.save({ viewId: view.viewId, filters });
      return view;
    };
    const result = this.serial.then(run);
    this.serial = result.catch(() => {});
    return result;
  }
  page(viewId, offset = 0, limit = 50, attention = null) {
    if (attention) return this.api('groups/status', { viewId, offset, limit, ...attention });
    return this.api(`groups?${new URLSearchParams({ viewId, offset, limit })}`);
  }
  comparison(viewId, groupId) {
    const result = this.serial.then(() => this.loadComparison(viewId, groupId));
    this.serial = result.catch(() => {});
    return result;
  }
  async loadComparison(viewId, groupId) {
    const value = await this.api('comparisons', { viewId, groupId });
    // The decision API admits at most 1,000 outcomes. Do not eagerly expand
    // an arbitrarily large checksum/time group into browser DOM and evidence.
    if (value.ids.length > 1000) return { ...value, oversized: true };
    // Complete membership comes from the saved scope, never from the grid.
    let next = value.photoNextOffset;
    while (next !== null) {
      const page = await this.api('comparisons/photos', { comparisonId: value.id, offset: next });
      value.photos.push(...page.photos);
      next = page.nextOffset;
    }
    if (
      value.photos.length !== value.ids.length ||
      new Set(value.photos.map((p) => p.id)).size !== value.ids.length ||
      value.photos.some((p) => !value.ids.includes(p.id))
    )
      throw Error('Could not load the complete comparison. Refresh and try again.');
    return value;
  }
  async decide(comparisonId, outcomes) {
    if (this.saved.pending) throw Error('Resolve the previous action before making another.');
    const { expiresAt, ...operation } = await this.api('operations', { comparisonId, mode: 'manual' });
    return this.mutate('operations/apply', { ...operation, outcomes }, 'decision');
  }
  mutate(path, body, kind) {
    if (this.saved.pending) throw Error('Resolve the previous action before making another.');
    this.save({ pending: { path, body, kind } });
    return this.retry();
  }
  async retry() {
    const pending = this.saved.pending;
    if (!pending) throw Error('No action is awaiting a response.');
    let result;
    try {
      result = await this.api(pending.path, pending.body);
    } catch (error) {
      if (error.status === 409 && pending.path === 'separations/reset') {
        const { correction } = await this.api(`separations?id=${encodeURIComponent(pending.body.id)}`);
        if (correction && !correction.active && correction.revision === pending.body.revision + 1) result = correction;
      }
      if (!result) {
        if (error.status >= 400 && error.status < 500 && ![408, 429].includes(error.status))
          this.save({ pending: null });
        throw error;
      }
    }
    this.save({ pending: null });
    return { kind: pending.kind, result };
  }
}

export function decisionSummary(outcomes) {
  const counts = { approve: 0, reviewed: 0, favorite: 0, reject: 0 };
  for (const value of Object.values(outcomes)) counts[value]++;
  return [['approve', 'Yes'], ['reviewed', 'Skip'], ['favorite', 'Fav'], ['reject', 'No']]
    .filter(([value]) => counts[value]).map(([value, label]) => `${counts[value]} ${label}`).join(' · ');
}
