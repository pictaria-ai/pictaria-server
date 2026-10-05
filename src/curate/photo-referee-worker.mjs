import { setImmediate } from 'node:timers/promises';
import { fingerprint } from './contracts.mjs';
import { enrichmentProviderConfiguration } from '../enrich/providers.mjs';
import { aiBackendKey } from './ai-limits.mjs';
import { stackRefereeSupport } from './stack-referee-contract.mjs';
import { transientStackPreviewFailure } from './stack-referee-images.mjs';
import { PHOTO_REFEREE_CONTRACT, createPhotoRefereeRequest } from './photo-referee-contract.mjs';
import { layoutPhotoRefereeComparisons, photoRefereeContextLimit } from './photo-referee-plan.mjs';
import { photoRefereeImages } from './photo-referee-images.mjs';
import { photoPartitionAdviceCurrent, photoPartitionMembersCurrent } from './photo-referee-groups.mjs';
import { readPhotoRefereeRecord, savePhotoRefereeAnswer, photoRefereeRecommendations } from './photo-referee-results.mjs';

export const PHOTO_PREVIEW_PAUSE_MS = 3 * 60_000;
export const PHOTO_MODEL_FAILURE_LIMIT = 3;
const MODEL_FAILURE_PREFIX = 'photo-model-failure:';

// The available worker still requires the user's Photo Referee preference and
// Stacks, then the shared lifecycle's readiness, scheduling and budget gates.
export class PhotoRefereeWorker {
  constructor(curate, { capability = () => null } = {}) {
    this.curate = curate; this.lifecycle = curate.aiLifecycle; this.capability = capability; this.cursor = 0;
  }
  enabled() { return this.lifecycle.enabled('keeper'); }
  configuration(provider) {
    const capability = this.capability(provider);
    return { capability, key: fingerprint({ provider: enrichmentProviderConfiguration(provider), capability,
      timeoutMs: provider.timeoutMs ?? null, immich: [this.curate.immich?.baseUrl, this.curate.immich?.apiKey] }) };
  }
  previewsReady() {
    return this.lifecycle.now() >= (this.curate.store.prepare("SELECT value FROM curate_meta WHERE key='photo-preview-retry-at'").get()?.value ?? 0);
  }
  modelFailurePrefix(provider) {
    return MODEL_FAILURE_PREFIX + fingerprint({ provider: enrichmentProviderConfiguration(provider),
      backend: aiBackendKey(provider), contract: PHOTO_REFEREE_CONTRACT, capability: this.capability(provider) }) + ':';
  }
  modelBlocked(provider) {
    return this.curate.store.prepare('SELECT COUNT(*) n FROM curate_meta WHERE key GLOB ?')
      .get(this.modelFailurePrefix(provider) + '*').n >= PHOTO_MODEL_FAILURE_LIMIT;
  }
  modelReady() { try { return !this.modelBlocked(this.lifecycle.resolveProvider()); } catch { return false; } }
  clearPending() {
    for (const [key, job] of this.lifecycle.pending) if (job.snapshot.role === 'keeper') this.lifecycle.pending.delete(key);
  }
  observeAttempt(result, snapshot, prefix) {
    if (!prefix || result.state !== 'failed' || !['provider-rejected', 'invalid-answer'].includes(result.reason)) return;
    this.curate.store.repo.transaction(() => {
      this.curate.store.prepare('DELETE FROM curate_meta WHERE key GLOB ? AND key NOT GLOB ?')
        .run(MODEL_FAILURE_PREFIX + '*', prefix + '*');
      const count = this.curate.store.prepare('SELECT COUNT(*) n FROM curate_meta WHERE key GLOB ?').get(prefix + '*').n;
      if (count < PHOTO_MODEL_FAILURE_LIMIT) this.curate.store.prepare('INSERT OR IGNORE INTO curate_meta VALUES(?,1)')
        .run(prefix + fingerprint([...snapshot.ids].sort()));
    });
    if (!this.modelReady()) this.clearPending();
  }
  capture(group, photoIds) {
    let contextLimit;
    try { contextLimit = photoRefereeContextLimit(group.ids.length, this.capability(this.lifecycle.resolveProvider())); }
    catch { return { state: 'configuration' }; }
    return this.lifecycle.inputs.capture({ role: 'keeper', groupId: group.id, contract: PHOTO_REFEREE_CONTRACT,
      includeContext: true, contextLimit, ...(photoIds ? { photoIds } : {}) });
  }
  saved(group) {
    const current = this.curate.current?.byId.get(group.id);
    if (!current || fingerprint(current.ids) !== fingerprint(group.ids)) return null;
    const record = readPhotoRefereeRecord(this.curate.store, group.ids, { subset: Boolean(current.photoPartition) });
    return record && (current.photoPartition
      ? photoPartitionAdviceCurrent(this.curate.store, record, group.ids)
      : this.lifecycle.inputs.current({ ...record.photoReferee.snapshot,
        material: record.photoReferee.restoredMaterial ?? record.photoReferee.snapshot.material })) ? record : null;
  }
  // Undo has already verified the operation and restored its human tags. Keep
  // the original paid snapshot/provenance immutable; only renew applicability
  // of accepted advice when all other evidence still matches. Group membership
  // is checked on the next read after rebuilding (it may still be absent here).
  restoreAfterUndo(rows) {
    const store = this.curate.store, restored = new Map(), records = new Map();
    store.flushIds(rows.map(row => row.assetId));
    for (const { assetId, restoredHuman } of rows) {
      const tags = store.repo.loadAssetTagsFor([assetId])[assetId] ?? [];
      if (!restoredHuman?.key || fingerprint(tags.filter(t => t.startsWith('frame/')).sort()) !== restoredHuman.tags) continue;
      restored.set(assetId, restoredHuman.key);
      const record = readPhotoRefereeRecord(store, [assetId], { subset: true });
      if (record) records.set(record.photoReferee.snapshot.inputKey, record);
    }
    for (const record of records.values()) {
      const saved = record.photoReferee;
      if (!saved.members) continue;
      store.flushIds([...record.ids, ...saved.snapshot.contextIds]);
      const prior = this.lifecycle.inputs.material(saved.snapshot, { restoredHuman: restored, checkGroup: false });
      if (prior.state === 'current' && fingerprint(prior.material) === (saved.restoredMaterial ?? saved.snapshot.material)) {
        const current = this.lifecycle.inputs.material(saved.snapshot, { checkGroup: false });
        saved.restoredMaterial = fingerprint(current.material);
      }
      // Split siblings may already be decided, so their original full snapshot
      // need not be current. Renew only exactly restored members, under the
      // same source/context checks used to retain the accepted partition.
      if (photoPartitionMembersCurrent(store, record)) {
        saved.members = saved.members.map(member => {
          const [id, , , , human] = member;
          return restored.get(id) === human ? [...member.slice(0, 4), store.photo(id).humanKey] : member;
        });
      }
      const json = JSON.stringify(record);
      // Advice is optional; its storage envelope must never prevent Undo.
      if (Buffer.byteLength(json) > 64 * 1024) continue;
      store.prepare("UPDATE curate_advice SET json=? WHERE role='keeper' AND schema_version=? AND input_key=?")
        .run(json, PHOTO_REFEREE_CONTRACT, fingerprint(saved.members.map(([id, key]) => [id, key])));
    }
  }
  recommendations(group) {
    const record = this.saved(group);
    // Results remain inspectable after role-off. A newly pending prerequisite
    // must not expose an apply-all promise from earlier advice.
    if (!record) return null;
    const result = photoRefereeRecommendations(record, group.ids);
    if (!result) return null;
    const gate = this.gate(group);
    if (gate.state !== 'eligible') { result.canApplyAll = false; result.noneRecommended = false; result.unavailableReason = gate.reason; }
    return result;
  }
  gate(group) {
    group = this.curate.current?.byId.get(group.id) ?? group;
    if (['waiting', 'checking', 'updated'].includes(this.curate.refinement?.groupStatus(group)?.state))
      return { state: 'waiting', reason: 'deterministic-pending' };
    if (group.photoPartition) return { state: 'eligible', checkCoverage: group.photoPartition.checkCoverage };
    if (!this.lifecycle.enabled('stack')) return { state: 'eligible', checkCoverage: 'off' };
    const check = this.curate.stackReferee?.status(group);
    if (check?.state === 'checked') return { state: 'eligible', checkCoverage: 'checked' };
    if (check?.state === 'skipped' && check.reason === 'supported-by-grouping')
      return { state: 'eligible', checkCoverage: 'scope-skipped' };
    if (check?.scope === 'configuration' || check?.state === 'paused' ||
        ['unknown-capability', 'unsupported-provider', 'configuration'].includes(check?.reason))
      return { state: 'paused', reason: 'stack-configuration' };
    if (check?.state === 'incomplete') {
      if (check.reason === 'unsupported-size') {
        try {
          const provider = this.lifecycle.resolveProvider();
          if (stackRefereeSupport(provider, this.capability(provider), group.ids.length).state === 'unsupported-size')
            return { state: 'eligible', checkCoverage: 'unchecked-size' };
        } catch { /* Configuration is not a verified size exception. */ }
        return { state: 'paused', reason: 'stack-configuration' };
      }
      return { state: 'eligible', checkCoverage: 'incomplete' };
    }
    return { state: 'waiting', reason: 'stack-pending' };
  }
  layout(snapshot, provider) {
    const { capability } = this.configuration(provider);
    // The same server-owned capability and configured transport gate both roles.
    const support = stackRefereeSupport(provider, capability, 2);
    if (support.state !== 'ready') return support;
    return layoutPhotoRefereeComparisons({ orderedIds: snapshot.ids, contextIds: snapshot.contextIds, capability });
  }
  blockingStatus(provider) {
    if (this.modelBlocked(provider)) return { state: 'paused', reason: 'model-failures', scope: 'configuration' };
    if (!this.previewsReady()) return { state: 'paused', reason: 'preview-cooldown' };
    const guard = this.curate.store.aiLimits.providerStatus(aiBackendKey(provider));
    if (guard.state === 'paused') return { state: 'paused', reason: `provider-${guard.reason}` };
    if (guard.state === 'cooldown') return { state: 'paused', reason: 'provider-cooldown' };
    if (guard.state === 'busy') return { state: 'waiting', reason: 'shared-provider' };
    return null;
  }
  activeStatus() {
    return this.lifecycle.execution.schedulingStatus().state === 'waiting'
      ? { state: 'waiting', reason: 'shared-provider' } : { state: 'checking' };
  }
  activity() {
    if (!this.enabled()) return { state: 'off' };
    const queued = [...this.lifecycle.pending.values()].filter(j => j.snapshot.role === 'keeper').length;
    if (this.lifecycle.active?.snapshot.role === 'keeper') return { ...this.activeStatus(), queued };
    try {
      const provider = this.lifecycle.resolveProvider();
      const support = stackRefereeSupport(provider, this.capability(provider), 2);
      if (support.state !== 'ready') return { state: 'paused', reason: support.state, scope: 'configuration', queued };
      return { ...(this.blockingStatus(provider) ?? { state: queued ? 'waiting' : 'idle' }), queued };
    } catch { return { state: 'paused', reason: 'configuration', scope: 'configuration', queued }; }
  }
  batchFinished(snapshot, key) {
    if (this.lifecycle.inputs.preparationFailures(snapshot) >= 2) return 'preparation-failed';
    const outcome = this.lifecycle.inputs.outcome(snapshot, key);
    if (outcome) return outcome;
    if (['settled', 'exhausted'].includes(this.curate.store.aiAttempts.eligibility('keeper', snapshot.inputKey))) return 'attempts-finished';
    if (this.curate.store.prepare('SELECT 1 FROM curate_ai_skipped_inputs WHERE role=? AND input_key=?').get('keeper', snapshot.inputKey)) return 'photo-limit';
    return null;
  }
  status(group) {
    const saved = this.saved(group), advice = saved && this.recommendations(group);
    if (advice?.state === 'complete') return { state: 'complete', keepers: advice.keeperIds.length, canApplyAll: advice.canApplyAll, coverage: advice.coverage,
      checkCoverage: advice.checkCoverage, ...(advice.unavailableReason ? { unavailableReason: advice.unavailableReason } : {}),
      completed: advice.batches.length, total: advice.batches.length };
    if (!this.enabled()) return { state: 'off' };
    if (this.curate.current?.byId.get(group.id)?.photoPartition) return { state: 'incomplete', reason: 'comparison-changed' };
    if (!this.curate.current?.byId.has(group.id)) return { state: 'updated' };
    if (group.ids.length < 2) return { state: 'skipped', reason: 'not-pending-stack' };
    const gate = this.gate(group);
    if (gate.state !== 'eligible') return gate;
    const captured = this.capture(group);
    if (captured.state === 'configuration') return { state: 'paused', reason: 'configuration', scope: 'configuration' };
    if (captured.state !== 'captured') return { state: captured.state === 'stale' ? 'updated' : 'incomplete', reason: captured.reason ?? captured.state };
    try {
      const provider = this.lifecycle.resolveProvider(), { key } = this.configuration(provider);
      const layout = this.layout(captured.snapshot, provider);
      if (layout.state !== 'ready') return { state: 'incomplete', reason: layout.state };
      const progress = { completed: advice?.batches.filter(b => b.status === 'valid').length ?? 0, total: layout.requests.length,
        coverage: layout.coverage, checkCoverage: gate.checkCoverage };
      if (saved && saved.photoReferee.configurationKey !== key) return { state: 'incomplete', reason: 'comparison-changed', ...progress };
      const missing = layout.requests.map((r, index) => ({ index, captured: this.capture(group, r.ids) }))
        .filter(r => !saved?.photoReferee.answers[r.index]);
      if (missing.some(r => r.captured.state !== 'captured')) return { state: 'updated' };
      if (missing.some(r => this.lifecycle.active?.snapshot.inputKey === r.captured.snapshot.inputKey)) return { ...this.activeStatus(), ...progress };
      const finished = missing.map(r => this.batchFinished(r.captured.snapshot, key));
      if (finished.every(Boolean)) return { state: 'incomplete', reason: finished[0], ...progress };
      return { ...(this.blockingStatus(provider) ?? { state: 'waiting' }), ...progress };
    } catch { return { state: 'paused', reason: 'configuration', scope: 'configuration' }; }
  }
  async discover() {
    if (!this.enabled() || !this.curate.current) return;
    if (!this.modelReady()) { this.clearPending(); return; }
    if (!this.previewsReady()) return;
    const groups = this.curate.current.groups;
    const priorities = this.curate.refinement?.priorities() ?? new Map();
    const preferred = groups.filter(g => priorities.has(this.curate.current.scopeByMember.get(g.ids[0])?.id)).slice(0, 32);
    const batch = groups.slice(this.cursor, this.cursor + 32);
    this.cursor = this.cursor + 32 >= groups.length ? 0 : this.cursor + 32;
    let slice = performance.now();
    for (const group of new Set([...preferred, ...batch])) {
      if (performance.now() - slice >= 4) { await setImmediate(); slice = performance.now(); }
      if (!this.enabled() || !this.modelReady() || !this.previewsReady()) return;
      if (group.photoPartition || group.ids.length < 2 || this.gate(group).state !== 'eligible' || this.curate.refinement?.isFocused(group.ids)) continue;
      const captured = this.capture(group);
      if (captured.state !== 'captured') continue;
      const saved = this.saved(group);
      if (saved?.photoReferee.answers.every(Boolean)) continue;
      let provider, key, layout;
      try { provider = this.lifecycle.resolveProvider(); key = this.configuration(provider).key; layout = this.layout(captured.snapshot, provider); }
      catch { continue; }
      if (layout.state !== 'ready' || (saved && saved.photoReferee.configurationKey !== key)) continue;
      for (let index = 0; index < layout.requests.length; index++) {
        if (saved?.photoReferee.answers[index]) continue;
        const capture = this.capture(group, layout.requests[index].ids);
        if (capture.state !== 'captured' || this.batchFinished(capture.snapshot, key)) continue;
        await this.lifecycle.offer(this.plan(group, layout, index, preferred.includes(group)));
      }
    }
  }
  plan(group, offeredLayout, index, priority) {
    let validate, plan, key, source, failurePrefix, coverage, transient = false, comparisonChanged = false;
    const sourceKey = () => fingerprint([this.curate.immich?.baseUrl, this.curate.immich?.apiKey]);
    return { role: 'keeper', groupId: group.id, contract: PHOTO_REFEREE_CONTRACT, priority,
      photoIds: offeredLayout.requests[index].ids, includeContext: true,
      contextLimit: photoRefereeContextLimit(group.ids.length, offeredLayout.capability),
      canStart: () => this.previewsReady() && this.modelReady() && this.gate(group).state === 'eligible',
      isCurrent: () => (source === undefined || source === sourceKey()) &&
        (coverage === undefined || this.gate(group).state === 'eligible'),
      prepare: async (checkpoint, { snapshot, provider }) => {
        checkpoint(); transient = false; comparisonChanged = false; source = sourceKey();
        key = this.configuration(provider).key; failurePrefix = this.modelFailurePrefix(provider);
        coverage = this.gate(group).checkCoverage;
        const layout = this.layout(snapshot, provider);
        if (layout.state !== 'ready' || fingerprint(layout.requests) !== fingerprint(offeredLayout.requests)) {
          comparisonChanged = true; throw new Error('Photo Referee request layout changed.');
        }
        const saved = this.saved(group);
        if (saved && saved.photoReferee.configurationKey !== key) {
          comparisonChanged = true; throw new Error('Photo Referee comparison configuration changed.');
        }
        let prepared;
        try {
          prepared = await photoRefereeImages(this.curate.immich, layout, index, () => {
            checkpoint();
            if (this.configuration(provider).key !== key) throw new Error('Photo Referee connection changed.');
          }, this.curate.abort.signal);
        } catch (error) { checkpoint(); transient = transientStackPreviewFailure(error); throw error; }
        plan = prepared.plan;
        if (saved && saved.photoReferee.plan.planKey !== plan.planKey) {
          comparisonChanged = true; throw new Error('Photo Referee renditions changed between batches.');
        }
        const request = createPhotoRefereeRequest({ provider, plan, requestIndex: index, images: prepared.images, inputKey: snapshot.inputKey });
        validate = request.validate;
        return request;
      },
      submit: prepared => prepared.submit(), validate: answer => validate(answer),
      accept: (answer, snapshot) => {
        savePhotoRefereeAnswer(this.curate.store, snapshot, plan, answer, { configurationKey: key, checkCoverage: coverage });
        this.curate.store.prepare('DELETE FROM curate_meta WHERE key GLOB ?').run(MODEL_FAILURE_PREFIX + '*');
      },
      observeAttempt: (result, snapshot) => this.observeAttempt(result, snapshot, failurePrefix),
      finish: (result, snapshot) => {
        if (result.state !== 'failed' || !key) return;
        this.curate.store.repo.transaction(() => {
          if (result.phase === 'prepare' && transient) {
            this.curate.store.prepare(`INSERT INTO curate_meta VALUES('photo-preview-retry-at',?)
              ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(this.lifecycle.now() + PHOTO_PREVIEW_PAUSE_MS);
            if (this.lifecycle.inputs.failPreparation(snapshot) < 2) return;
          }
          this.lifecycle.inputs.settle(snapshot, key, comparisonChanged ? 'comparison-changed' : result.reason);
        });
      },
    };
  }
}
