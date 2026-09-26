import { curateAiRoleEnabled } from './ai-policy.mjs';
import { AiSchedulingCancelled } from '../ai/scheduler.mjs';
import { aiBackendKey } from './ai-limits.mjs';
import { ProviderRequestError } from '../enrich/providers.mjs';

class AdmissionStopped extends Error {
  constructor(reason) { super(reason); this.reason = reason; }
}

class AdapterContractError extends TypeError {}

function synchronous(value) {
  if (value && typeof value.then === 'function') {
    // Observe rejection as well as fulfillment: a buggy async adapter must not
    // also cause an unhandled rejection after we report its contract error.
    Promise.resolve(value).catch(() => {});
    throw new AdapterContractError('Curate AI validation and acceptance must be synchronous.');
  }
  return value;
}

function failureReason(error, phase) {
  if (error instanceof AdapterContractError) return 'adapter-error';
  if (phase === 'prepare') return 'preparation-failed';
  if (phase === 'validate') return 'invalid-answer';
  if (phase === 'accept') return 'acceptance-failed';
  if (error instanceof ProviderRequestError) {
    if ([401, 403].includes(error.status)) return 'provider-auth';
    if (error.invalidResponse) return 'invalid-answer';
    if (error.infrastructure) return 'provider-unavailable';
    return 'provider-rejected';
  }
  return 'request-failed';
}

// Shared execution boundary for the two future workers (still unavailable).
// It does not select jobs or provide retries. Optional limits are connected by
// shared runtime owner. A scheduler-owned turn, or an explicit read-only admit
// callback in isolated tests, gates preparation and dispatch. Repeated
// preparation checkpoints never charge a call; neither authority defaults on.
export class CurateAiExecution {
  #busy = false;
  #queued = false;
  #turn = null;
  constructor({ attempts, limits, getConfig, availability, stopped = () => false, admit = () => false, scheduler = null }) {
    this.attempts = attempts;
    this.limits = limits;
    this.getConfig = getConfig;
    this.availability = availability;
    this.stopped = stopped;
    this.admit = admit;
    this.scheduler = scheduler;
  }

  #reason(job, requireTurn = true) {
    if (this.stopped()) return 'stopped';
    if (!curateAiRoleEnabled(this.getConfig(), job.role, this.availability)) return 'disabled';
    // All admission/applicability callbacks are synchronous. A Promise cannot
    // accidentally authorize work using a stale answer.
    if (job.isCurrent() !== true) return 'stale';
    if (job.canStart && job.canStart() !== true) return 'waiting';
    const limit = this.limits?.eligibility(job);
    // An Enrich call may own this provider right now. Join the scheduler's
    // queue, then require full admission once the turn is actually ours.
    if (limit && limit !== 'eligible'
        && !(limit === 'provider-busy' && this.scheduler && !requireTurn)) return limit;
    if (requireTurn && (this.scheduler ? this.#turn?.ownsTurn() !== true : this.admit(job) !== true)) return 'waiting';
    return null;
  }

  async run(job) {
    if (this.stopped()) return { state: 'stopped' };
    if (!curateAiRoleEnabled(this.getConfig(), job.role, this.availability)) return { state: 'disabled' };
    if (job.resolveProvider) {
      const provider = job.resolveProvider();
      job = { ...job, provider, backendKey: aiBackendKey(provider) };
    }
    if (!this.scheduler) return this.#execute(job);
    if (this.#queued || this.#busy) return { state: 'busy' };
    if (this.stopped()) return { state: 'stopped' };
    if (!curateAiRoleEnabled(this.getConfig(), job.role, this.availability)) return { state: 'disabled' };
    // Copy identity before waiting; the scheduler's turn cannot authorize a
    // different set of photos substituted while Enrich is still running.
    job = Object.freeze({ ...job,
      photoIds: Object.freeze([...(job.photoIds ?? [])]),
      contextPhotoIds: Object.freeze([...(job.contextPhotoIds ?? [])]),
    });
    if (this.limits && job.backendKey !== aiBackendKey(job.provider))
      throw new TypeError('Curate AI provider must match its pinned admission identity.');
    const eligible = this.attempts.eligibility(job.role, job.inputKey);
    if (eligible !== 'eligible') return { state: eligible };
    const reason = this.#reason(job, false);
    if (reason) {
      if (reason === 'photo-limit') this.#settleLimited(job);
      return { state: reason };
    }
    this.#queued = true;
    let session;
    try {
      session = this.scheduler.session(job.provider, 'curate', {
        priority: job.priority === true,
        eligible: () => !this.stopped() && curateAiRoleEnabled(this.getConfig(), job.role, this.availability)
          && job.isCurrent() === true && (!job.canStart || job.canStart() === true),
      });
      this.#turn = session;
      return await session.run(() => {
        // Resolve the saved model when this turn actually begins. A different
        // connection needs a fresh scheduler turn; no preparation has started.
        if (job.resolveProvider) {
          const provider = job.resolveProvider();
          if (aiBackendKey(provider) !== job.backendKey) return { state: 'provider-changed' };
          job = Object.freeze({ ...job, provider });
        }
        return this.#execute(job);
      });
    } catch (error) {
      if (error instanceof AiSchedulingCancelled) return { state: this.scheduler.stopped ? 'stopped' : this.#reason(job, false) ?? 'stopped' };
      throw error;
    } finally {
      session?.close(); this.#turn = null; this.#queued = false;
    }
  }

  schedulingStatus() { return this.#turn?.status() ?? { state: 'idle', reason: null }; }

  async #execute(job) {
    job = Object.freeze({ ...job,
      ...(job.photoIds ? { photoIds: Object.freeze([...job.photoIds]) } : {}),
      ...(job.contextPhotoIds ? { contextPhotoIds: Object.freeze([...job.contextPhotoIds]) } : {}),
    });
    for (const name of ['prepare', 'submit', 'validate', 'accept', 'isCurrent'])
      if (typeof job?.[name] !== 'function') throw new TypeError(`Missing Curate AI ${name} callback.`);
    if (this.#busy) return { state: 'busy' };
    const eligible = this.attempts.eligibility(job.role, job.inputKey);
    if (eligible !== 'eligible') return { state: eligible };
    const reason = this.#reason(job);
    if (reason) {
      if (reason === 'photo-limit') this.#settleLimited(job);
      return { state: reason };
    }
    this.#busy = true;
    let ticket, phase = 'prepare';
    const checkpoint = () => {
      const reason = this.#reason(job);
      if (reason) throw new AdmissionStopped(reason);
    };
    try {
      // Adapters must checkpoint between downloads and before any fallback.
      const prepared = await job.prepare(checkpoint, job.provider);
      checkpoint();
      phase = 'submit';
      ticket = this.attempts.repo.transaction(() => {
        const ticket = this.limits ? this.limits.start(job, this.attempts) : this.attempts.start(job.role, job.inputKey);
        if (ticket.state === 'started' || ticket.state === 'photo-limit') synchronous(job.recordInput?.());
        return ticket;
      });
      if (ticket.state !== 'started') return { state: ticket.state };
      const response = await job.submit(prepared, job.provider);
      this.limits?.finish(ticket);
      // Turning a role off after dispatch does not discard useful paid work.
      // Changed photos/human decisions still invalidate it. No dependent job
      // is created here; it must pass fresh admission through run() separately.
      if (job.isCurrent() !== true) {
        this.attempts.finish(ticket, 'stale');
        return { state: 'stale' };
      }
      phase = 'validate';
      const result = synchronous(job.validate(response));
      phase = 'accept';
      // Acceptance and its accounting commit together. The accepting adapter
      // must synchronously revalidate material/human inputs in this transaction.
      this.attempts.repo.transaction(() => {
        if (job.isCurrent() !== true) throw new AdmissionStopped('stale');
        if (!this.attempts.finish(ticket, 'succeeded')) throw new AdmissionStopped('superseded');
        synchronous(job.accept(result));
      });
      return { state: 'succeeded', attempts: ticket.attempts };
    } catch (error) {
      if (error instanceof AdmissionStopped && error.reason === 'photo-limit') this.#settleLimited(job);
      if (ticket?.state === 'started' && phase === 'submit') this.limits?.finish(ticket, error);
      if (ticket?.state === 'started') this.attempts.finish(ticket, error instanceof AdmissionStopped && error.reason === 'stale' ? 'stale' : 'failed');
      // No raw errors, request objects, keys, photo metadata or responses escape
      // into status. The future provider guard receives failures at transport.
      return error instanceof AdmissionStopped ? { state: error.reason }
        : { state: 'failed', reason: failureReason(error, phase), phase };
    } finally {
      this.#busy = false;
    }
  }

  #settleLimited(job) {
    this.attempts.repo.transaction(() => {
      this.limits.settleLimited(job);
      synchronous(job.recordInput?.());
    });
  }
}
