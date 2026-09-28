import { fingerprint } from './contracts.mjs';
import { setImmediate } from 'node:timers/promises';
import { enrichmentProviderConfiguration } from '../enrich/providers.mjs';
import { selectStackReferee } from './ai-policy.mjs';
import { STACK_REFEREE_CONTRACT, stackRefereeSupport, createStackRefereeRequest } from './stack-referee-contract.mjs';
import { stackRefereeImages } from './stack-referee-images.mjs';
import { saveStackCheck } from './stack-referee-results.mjs';

// Discovery/adaptation for one role. Capability must be supplied by the server,
// never inferred from analyzeImages or accepted from a settings/API payload.
// The production role remains unavailable pending capability/visual acceptance.
export class StackRefereeWorker {
  constructor(curate, { capability = () => null } = {}) {
    this.curate = curate;
    this.lifecycle = curate.aiLifecycle;
    this.capability = capability;
    this.cursor = 0;
  }
  enabled() { return this.lifecycle.enabled('stack'); }
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
  status(group) {
    const current = this.curate.current?.byId.get(group.id);
    if (current?.stackCheck) return current.stackCheck;
    if (!current) return { state: 'updated' };
    if (!this.enabled()) return { state: 'off' };
    const selection = this.selection(group);
    if (!selection.selected) return { state: 'skipped', reason: selection.reason };
    const captured = this.capture(group);
    if (captured.state !== 'captured') return { state: 'incomplete', reason: captured.reason ?? captured.state };
    const { snapshot } = captured;
    if (this.lifecycle.active?.snapshot.inputKey === snapshot.inputKey) return { state: 'checking' };
    if (this.lifecycle.pending.has(snapshot.inputKey)) return { state: 'waiting' };
    try {
      const { key } = this.configuration(this.lifecycle.resolveProvider());
      const reason = this.lifecycle.inputs.outcome(snapshot, key);
      if (reason) return { state: 'incomplete', reason };
      const eligibility = this.curate.store.aiAttempts.eligibility('stack', snapshot.inputKey);
      if (['settled', 'exhausted'].includes(eligibility)) return { state: 'incomplete', reason: 'attempts-finished' };
    } catch { return { state: 'incomplete', reason: 'configuration' }; }
    return { state: 'waiting' };
  }
  async discover() {
    if (!this.enabled() || !this.curate.current) return;
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
      if (!this.enabled()) return;
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
        if (!this.lifecycle.inputs.outcome(snapshot, configuration.key))
          this.lifecycle.inputs.settle(snapshot, configuration.key, support.state);
        continue;
      }
      if (this.lifecycle.inputs.outcome(snapshot, configuration.key)) continue;
      await this.lifecycle.offer(this.plan(group, preferred.includes(group)));
    }
  }
  plan(group, priority) {
    let validate, key, support, source;
    const sourceKey = () => fingerprint([this.curate.immich?.baseUrl, this.curate.immich?.apiKey]);
    return { role: 'stack', groupId: group.id, contract: STACK_REFEREE_CONTRACT, priority,
      isCurrent: () => source === undefined || source === sourceKey(),
      prepare: async (checkpoint, { snapshot, provider }) => {
        checkpoint();
        source = sourceKey();
        const configuration = this.configuration(provider); key = configuration.key;
        support = stackRefereeSupport(provider, configuration.capability, snapshot.ids.length);
        if (support.state !== 'ready') throw new Error('Unsupported Stack Referee input.');
        const images = await stackRefereeImages(this.curate.immich, snapshot.ids, () => {
          checkpoint();
          if (this.configuration(provider).key !== key) throw new Error('Stack Referee connection changed.');
        }, this.curate.abort.signal);
        const request = createStackRefereeRequest({ provider, capability: configuration.capability, images, inputKey: snapshot.inputKey });
        validate = request.validate;
        return request;
      },
      submit: prepared => prepared.submit(), validate: answer => validate(answer),
      accept: (answer, snapshot) => saveStackCheck(this.curate.store, snapshot, answer),
      finish: (result, snapshot) => {
        if (result.state === 'failed' && key) this.lifecycle.inputs.settle(snapshot, key,
          support?.state !== 'ready' ? support.state : result.reason);
      },
    };
  }
}
