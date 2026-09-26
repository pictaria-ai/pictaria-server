import { CurateAiInputs } from './ai-inputs.mjs';
import { curateAiRoleEnabled, selectStackReferee } from './ai-policy.mjs';

export const AI_SETTLE_MS = 30_000;
export const MAX_AI_PENDING = 32;
const overlaps = (a, b) => a.some(id => b.includes(id));

// A small owner for offered role work, not a discovery/repair queue. Future
// role workers offer current groups; neither expiry nor this class invents work.
export class CurateAiLifecycle {
  constructor({ curate, execution, resolveProvider, availability, now = Date.now }) {
    this.curate = curate; this.execution = execution; this.resolveProvider = resolveProvider;
    this.availability = availability; this.now = now;
    this.inputs = new CurateAiInputs(curate, { now });
    this.pending = new Map(); this.active = null; this.closed = false;
  }

  enabled(role) { return !this.closed && !this.curate.closed && curateAiRoleEnabled(this.curate.config, role, this.availability); }

  async offer(plan) {
    if (!this.enabled(plan.role)) return { state: 'disabled' };
    for (const name of ['prepare', 'submit', 'validate', 'accept'])
      if (typeof plan[name] !== 'function') throw new TypeError(`Missing Curate AI ${name} adapter.`);
    await this.curate.refresh();
    if (!this.enabled(plan.role)) return { state: 'disabled' };
    const snapshot = this.inputs.capture(plan);
    if (!snapshot) return { state: 'stale' };
    const key = snapshot.inputKey;
    if (this.active?.snapshot.inputKey === key) return { state: 'active' };
    if (this.pending.has(key)) return { state: 'queued' };
    // Independent batches of the SAME scope coexist. Revisions replace all
    // overlapping old scope work. Read-only shared context never couples jobs.
    const replaces = old => old.role === snapshot.role && overlaps(old.ids, snapshot.ids) &&
      (old.groupId !== snapshot.groupId || old.scopeMaterial !== snapshot.scopeMaterial || old.contract !== snapshot.contract ||
        overlaps(old.actionable, snapshot.actionable));
    for (const [id, job] of this.pending) if (replaces(job.snapshot)) this.pending.delete(id);
    if (this.active && replaces(this.active.snapshot)) this.active.superseded = true;
    const state = this.curate.store.aiAttempts.eligibility(plan.role, key);
    if (!['eligible', 'busy'].includes(state)) return { state };
    if (this.curate.store.prepare('SELECT 1 FROM curate_ai_skipped_inputs WHERE role=? AND input_key=?').get(plan.role, key))
      return { state: 'photo-limit' };
    if (this.pending.size >= MAX_AI_PENDING) return { state: 'queue-full' };
    this.pending.set(key, { snapshot, plan: { ...plan }, readyAt: this.now() + AI_SETTLE_MS, superseded: false });
    this.execution.scheduler?.refresh();
    return { state: 'queued' };
  }

  runnable(job) {
    if (this.curate.refinement?.isFocused(job.snapshot.ids)) return false;
    const group = this.curate.current?.byId.get(job.snapshot.groupId);
    const status = group && this.curate.refinement?.groupStatus(group);
    const settled = !status || !['waiting', 'checking', 'updated'].includes(status.state);
    if (job.snapshot.role === 'stack') return selectStackReferee(this.curate.config, {
      memberCount: group?.ids.length, pending: Boolean(group), deterministicSettled: settled, route: group?.route,
    }, this.availability).selected;
    return settled;
  }

  // Never await a provider on Curate's metadata/rebuild loop.
  tick() {
    for (const [key, job] of this.pending) if (!this.enabled(job.snapshot.role) || !this.inputs.current(job.snapshot)) this.pending.delete(key);
    this.execution.scheduler?.refresh();
    if (this.closed || this.active) return;
    const job = [...this.pending.values()].find(j => j.readyAt <= this.now() && this.runnable(j));
    if (!job) return;
    this.pending.delete(job.snapshot.inputKey);
    this.active = job;
    job.work = this.run(job).finally(() => { if (this.active === job) this.active = null; });
  }

  async run(job) {
    const { snapshot, plan } = job;
    try {
      const result = await this.execution.run({
        role: snapshot.role, inputKey: snapshot.inputKey,
        photoIds: [...snapshot.actionable, ...snapshot.contextIds], contextPhotoIds: snapshot.contextIds,
        resolveProvider: this.resolveProvider, priority: plan.priority === true,
        isCurrent: () => !job.superseded && this.inputs.current(snapshot),
        canStart: () => this.runnable(job),
        recordInput: () => this.inputs.record(snapshot),
        prepare: (checkpoint, provider) => plan.prepare(checkpoint, { snapshot: structuredClone(snapshot), provider }),
        submit: (prepared, provider) => plan.submit(prepared, provider),
        validate: response => plan.validate(response),
        accept: result => plan.accept(result, structuredClone(snapshot)),
      });
      job.result = result;
      const retry = result.state === 'failed' && ['submit', 'validate'].includes(result.phase) &&
        this.curate.store.aiAttempts.eligibility(snapshot.role, snapshot.inputKey) === 'eligible';
      const waiting = ['waiting', 'busy', 'provider-busy', 'provider-cooldown', 'provider-changed'].includes(result.state);
      if ((retry || waiting) && !job.superseded && this.pending.size < MAX_AI_PENDING && this.enabled(snapshot.role) && this.inputs.current(snapshot)) {
        job.readyAt = this.now() + (retry ? AI_SETTLE_MS : 1000);
        this.pending.set(snapshot.inputKey, job);
      }
      return result;
    } catch {
      // Local adapter/configuration errors do not become an unbounded retry.
      job.result = { state: 'failed', reason: 'adapter-error' };
      return job.result;
    }
  }

  maintain() {
    const protectedKeys = new Set(this.pending.keys());
    if (this.active) protectedKeys.add(this.active.snapshot.inputKey);
    return this.inputs.prune(protectedKeys);
  }

  settingsChanged() { this.tick(); }
  close() { this.closed = true; this.pending.clear(); this.execution.scheduler?.refresh(); }
}
