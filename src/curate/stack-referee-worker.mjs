import { fingerprint } from './contracts.mjs';
import { setImmediate } from 'node:timers/promises';
import { enrichmentProviderConfiguration } from '../enrich/providers.mjs';
import { selectStackReferee } from './ai-policy.mjs';
import { STACK_REFEREE_CONTRACT, stackRefereeSupport, createStackRefereeRequest } from './stack-referee-contract.mjs';
import { stackRefereeImages, transientStackPreviewFailure } from './stack-referee-images.mjs';
import { saveStackCheck, stackCheckCurrent } from './stack-referee-results.mjs';
import { aiBackendKey } from './ai-limits.mjs';

export const STACK_PREVIEW_PAUSE_MS = 3 * 60_000;

// Discovery/adaptation for one role. Capability must be supplied by the server,
// never inferred from analyzeImages or accepted from a settings/API payload.
// Role preference and registered model capability gate production requests.
export class StackRefereeWorker {
  constructor(curate, { capability = () => null } = {}) {
    this.curate = curate;
    this.lifecycle = curate.aiLifecycle;
    this.capability = capability;
    this.cursor = 0;
  }
  enabled() { return this.lifecycle.enabled('stack'); }
  previewsReady() {
    const until = this.curate.store.prepare("SELECT value FROM curate_meta WHERE key='stack-preview-retry-at'").get()?.value ?? 0;
    return this.lifecycle.now() >= until;
  }
  configuration(provider) {
    const capability = this.capability(provider);
    return { capability, key: fingerprint({ provider: enrichmentProviderConfiguration(provider), capability,
      immich: [this.curate.immich?.baseUrl, this.curate.immich?.apiKey] }) };
  }
  selection(group) {
    const status = this.curate.refinement?.groupStatus(group);
    return selectStackReferee(this.curate.config, { memberCount: group.ids.length, pending: true,
      deterministicSettled: !['waiting', 'checking', 'updated'].includes(status?.state),
      currentCheck: group.stackCheck?.state === 'checked', route: group.route,
    }, this.lifecycle.availability);
  }
  capture(group) { return this.lifecycle.inputs.capture({ role: 'stack', groupId: group.id, contract: STACK_REFEREE_CONTRACT }); }
  blockingStatus(provider) {
    if (!this.previewsReady()) return { state: 'paused', reason: 'preview-cooldown' };
    const guard = this.curate.store.aiLimits.providerStatus(aiBackendKey(provider));
    if (guard.state === 'paused') return { state: 'paused', reason: `provider-${guard.reason}` };
    if (guard.state === 'cooldown') return { state: 'paused', reason: 'provider-cooldown' };
    if (guard.state === 'busy') return { state: 'waiting', reason: 'shared-provider' };
    return null;
  }
  activeStatus() {
    const scheduling = this.lifecycle.execution.schedulingStatus();
    return scheduling.state === 'waiting' ? { state: 'waiting', reason: 'shared-provider' } : { state: 'checking' };
  }
  activity() {
    if (!this.enabled()) return { state: 'off' };
    const active = this.lifecycle.active?.snapshot.role === 'stack';
    const queued = [...this.lifecycle.pending.values()].filter(job => job.snapshot.role === 'stack').length;
    if (!active && !queued) return this.previewsReady() ? { state: 'idle' } : { state: 'paused', reason: 'preview-cooldown' };
    if (active) return { ...this.activeStatus(), queued };
    try { return { ...(this.blockingStatus(this.lifecycle.resolveProvider()) ?? { state: 'waiting' }), queued }; }
    catch { return { state: 'paused', reason: 'configuration', queued }; }
  }
  status(group) {
    const current = this.curate.current?.byId.get(group.id);
    if (current?.stackCheck) return stackCheckCurrent(this.curate.store, current.stackCheck)
      ? current.stackCheck : { state: 'updated' };
    if (!this.enabled()) return { state: 'off' };
    if (!current) return { state: 'updated' };
    const selection = this.selection(group);
    if (!selection.selected) return { state: 'skipped', reason: selection.reason };
    const captured = this.capture(group);
    if (captured.state === 'stale') return { state: 'updated' };
    if (captured.state !== 'captured') return { state: 'incomplete', reason: captured.reason ?? captured.state };
    const { snapshot } = captured;
    try {
      const provider = this.lifecycle.resolveProvider(), { key, capability } = this.configuration(provider);
      const support = stackRefereeSupport(provider, capability, snapshot.ids.length);
      if (support.state !== 'ready') return { state: 'incomplete', reason: support.state };
      if (this.lifecycle.inputs.preparationFailures(snapshot) >= 2) return { state: 'incomplete', reason: 'preparation-failed' };
      const reason = this.lifecycle.inputs.outcome(snapshot, key);
      if (reason) return { state: 'incomplete', reason };
      if (this.lifecycle.active?.snapshot.inputKey === snapshot.inputKey) return this.activeStatus();
      const eligibility = this.curate.store.aiAttempts.eligibility('stack', snapshot.inputKey);
      if (['settled', 'exhausted'].includes(eligibility)) return { state: 'incomplete', reason: 'attempts-finished' };
      if (this.curate.store.prepare('SELECT 1 FROM curate_ai_skipped_inputs WHERE role=? AND input_key=?').get('stack', snapshot.inputKey))
        return { state: 'incomplete', reason: 'photo-limit' };
      const blocked = this.blockingStatus(provider);
      if (blocked) return blocked;
    } catch { return { state: 'incomplete', reason: 'configuration' }; }
    return { state: 'waiting' };
  }
  async discover() {
    if (!this.enabled() || !this.curate.current || !this.previewsReady()) return;
    const groups = this.curate.current.groups;
    if (!groups.length) return;
    const priorities = this.curate.refinement?.priorities() ?? new Map();
    const preferred = groups.filter(g => priorities.has(this.curate.current.scopeByMember.get(g.ids[0])?.id)).slice(0, 32);
    // Rotate background coverage even when early groups are unsupported/settled.
    const batch = groups.slice(this.cursor, this.cursor + 32);
    this.cursor = this.cursor + 32 >= groups.length ? 0 : this.cursor + 32;
    let slice = performance.now();
    for (const group of new Set([...preferred, ...batch])) {
      if (performance.now() - slice >= 4) { await setImmediate(); slice = performance.now(); }
      if (!this.enabled() || !this.previewsReady()) return;
      if (!this.selection(group).selected || this.curate.refinement?.isFocused(group.ids)) continue;
      const captured = this.capture(group);
      if (captured.state !== 'captured') continue;
      const { snapshot } = captured;
      let provider, configuration;
      try { provider = this.lifecycle.resolveProvider(); configuration = this.configuration(provider); }
      catch { continue; } // Shared provider settings/guard owns configuration errors.
      const support = stackRefereeSupport(provider, configuration.capability, group.ids.length);
      if (support.state !== 'ready') {
        this.lifecycle.pending.delete(snapshot.inputKey);
        continue;
      }
      if (this.lifecycle.inputs.preparationFailures(snapshot) >= 2 || this.lifecycle.inputs.outcome(snapshot, configuration.key)) continue;
      await this.lifecycle.offer(this.plan(group, preferred.includes(group)));
    }
  }
  plan(group, priority) {
    let validate, key, support, source, transient = false;
    const sourceKey = () => fingerprint([this.curate.immich?.baseUrl, this.curate.immich?.apiKey]);
    return { role: 'stack', groupId: group.id, contract: STACK_REFEREE_CONTRACT, priority,
      canStart: () => this.previewsReady(),
      isCurrent: () => source === undefined || source === sourceKey(),
      prepare: async (checkpoint, { snapshot, provider }) => {
        checkpoint();
        transient = false;
        source = sourceKey();
        const configuration = this.configuration(provider); key = configuration.key;
        support = stackRefereeSupport(provider, configuration.capability, snapshot.ids.length);
        if (support.state !== 'ready') throw new Error('Unsupported Stack Referee input.');
        let images;
        try {
          images = await stackRefereeImages(this.curate.immich, snapshot.ids, () => {
            checkpoint();
            if (this.configuration(provider).key !== key) throw new Error('Stack Referee connection changed.');
          }, this.curate.abort.signal);
        } catch (error) {
          // Shutdown, role-off and changed inputs are cancellation, not failed
          // downloads. Recheck before classifying a wrapped network/abort error.
          checkpoint();
          transient = transientStackPreviewFailure(error);
          throw error;
        }
        const request = createStackRefereeRequest({ provider, capability: configuration.capability, images, inputKey: snapshot.inputKey });
        validate = request.validate;
        return request;
      },
      submit: prepared => prepared.submit(), validate: answer => validate(answer),
      accept: (answer, snapshot) => saveStackCheck(this.curate.store, snapshot, answer),
      finish: (result, snapshot) => {
        if (result.state !== 'failed' || !key || support?.state !== 'ready') return;
        this.curate.store.repo.transaction(() => {
          if (result.phase === 'prepare' && transient) {
            // One shared pause gates discovery AND queued work, even after a
            // restart. A single meta value avoids a per-stack recovery queue.
            this.curate.store.prepare(`INSERT INTO curate_meta VALUES('stack-preview-retry-at',?)
              ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(this.lifecycle.now() + STACK_PREVIEW_PAUSE_MS);
            if (this.lifecycle.inputs.failPreparation(snapshot) < 2) return;
          }
          this.lifecycle.inputs.settle(snapshot, key, result.reason);
        });
      },
    };
  }
}
