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
    this.pending = new Map(); this.active = null; this.closed = false; this.priorityTurns = 0;
  }

  enabled(role) { return !this.closed && !this.curate.closed && curateAiRoleEnabled(this.curate.config, role, this.availability); }

  async offer(plan) {
    if (!this.enabled(plan.role)) return { state: 'disabled' };
    for (const name of ['prepare', 'submit', 'validate', 'accept'])
      if (typeof plan[name] !== 'function') throw new TypeError(`Missing Curate AI ${name} adapter.`);
    await this.curate.refresh();
    if (!this.enabled(plan.role)) return { state: 'disabled' };
    const captured = this.inputs.capture(plan);
    if (captured.state !== 'captured') return captured;
    const { snapshot } = captured;
    const key = snapshot.inputKey;
    const existing = this.active?.snapshot.inputKey === key ? this.active : this.pending.get(key);
    if (existing) {
      // Attention may change without changing the input or its settling clock.
      if (typeof plan.priority === 'boolean') existing.plan.priority = plan.priority;
      return { state: existing === this.active ? 'active' : 'queued' };
    }
    // Independent batches of the SAME scope coexist. Revisions replace all
    // overlapping old scope work. Read-only shared context never couples jobs.
    const replaces = old => old.role === snapshot.role && overlaps(old.ids, snapshot.ids) &&
      (old.groupId !== snapshot.groupId || old.scopeMaterial !== snapshot.scopeMaterial || old.contract !== snapshot.contract ||
        overlaps(old.actionable, snapshot.actionable));
    let inheritedPriority = false;
    for (const [id, job] of this.pending) if (replaces(job.snapshot)) {
      inheritedPriority ||= job.plan.priority === true;
      this.pending.delete(id);
    }
    if (this.active && replaces(this.active.snapshot)) {
      inheritedPriority ||= this.active.plan.priority === true;
      this.active.superseded = true;
    }
    const state = this.curate.store.aiAttempts.eligibility(plan.role, key);
    if (!['eligible', 'busy'].includes(state)) return { state };
    if (this.curate.store.prepare('SELECT 1 FROM curate_ai_skipped_inputs WHERE role=? AND input_key=?').get(plan.role, key))
      return { state: 'photo-limit' };
    if (this.pending.size >= MAX_AI_PENDING) return { state: 'queue-full' };
    const priority = typeof plan.priority === 'boolean' ? plan.priority : inheritedPriority;
    this.pending.set(key, { snapshot, plan: { ...plan, priority }, readyAt: this.now() + AI_SETTLE_MS, superseded: false });
    this.execution.scheduler?.refresh();
    return { state: 'queued' };
  }

  runnable(job) {
    if (job.plan.canStart && job.plan.canStart() !== true) return false;
    if (this.curate.refinement?.isFocused(job.snapshot.ids)) return false;
    const group = this.curate.current?.byId.get(job.snapshot.groupId);
    const status = group && this.curate.refinement?.groupStatus(group);
    const settled = !status || !['waiting', 'checking', 'updated'].includes(status.state);
    if (job.snapshot.role === 'stack') return selectStackReferee(this.curate.config, {
      memberCount: group?.ids.length, pending: Boolean(group), deterministicSettled: settled, route: group?.route,
      currentCheck: group?.stackCheck?.state === 'checked',
    }, this.availability).selected;
    return settled;
  }

  // Never await a provider on Curate's metadata/rebuild loop.
  tick() {
    for (const [key, job] of this.pending) if (!this.enabled(job.snapshot.role) || !this.inputs.current(job.snapshot)) this.pending.delete(key);
    this.execution.scheduler?.refresh();
    if (this.closed || this.active) return;
    const ready = [...this.pending.values()].filter(j => j.readyAt <= this.now() && this.runnable(j));
    // Only one job reaches the shared scheduler at a time, so Curate fairness
    // must also apply here: two preferred turns, then the oldest ready job.
    const preferred = this.priorityTurns < 2 && ready.find(j => j.plan.priority === true);
    const job = preferred || ready[0];
    if (!job) return;
    this.priorityTurns = preferred ? this.priorityTurns + 1 : 0;
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
        isCurrent: () => !job.superseded && this.inputs.current(snapshot) && (!plan.isCurrent || plan.isCurrent() === true),
        canStart: () => this.runnable(job),
        recordInput: () => this.inputs.record(snapshot),
        prepare: (checkpoint, provider) => plan.prepare(checkpoint, { snapshot: structuredClone(snapshot), provider }),
        submit: (prepared, provider) => plan.submit(prepared, provider),
        validate: response => plan.validate(response),
        accept: result => plan.accept(result, structuredClone(snapshot)),
      });
      job.result = result;
      // Role-specific protection observes each attempt before another stack or
      // retry can run. Terminal finish alone may come much later in a backlog.
      const observed = plan.observeAttempt?.(result, structuredClone(snapshot));
      if (observed && typeof observed.then === 'function') {
        Promise.resolve(observed).catch(() => {});
        throw new TypeError('Curate AI attempt observation must be synchronous.');
      }
      const retry = result.state === 'failed' && ['submit', 'validate'].includes(result.phase) &&
        this.curate.store.aiAttempts.eligibility(snapshot.role, snapshot.inputKey) === 'eligible';
      const waiting = ['waiting', 'busy', 'provider-busy', 'provider-cooldown', 'provider-changed'].includes(result.state);
      if ((retry || waiting) && !job.superseded && this.pending.size < MAX_AI_PENDING && this.enabled(snapshot.role) && this.inputs.current(snapshot)) {
        job.readyAt = this.now() + (retry ? AI_SETTLE_MS : 1000);
        this.pending.set(snapshot.inputKey, job);
      }
      if (!this.pending.has(snapshot.inputKey) && this.inputs.current(snapshot)) {
        // Terminal worker bookkeeping only; no dependent request is launched.
        // Acceptance itself remains in the executor's transaction above.
        const finished = plan.finish?.(result, structuredClone(snapshot));
        if (finished && typeof finished.then === 'function') {
          Promise.resolve(finished).catch(() => {});
          throw new TypeError('Curate AI completion must be synchronous.');
        }
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
