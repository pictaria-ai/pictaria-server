import { curateAiRoleEnabled } from './ai-policy.mjs';
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

// Shared, deliberately unwired execution seam for the two future workers.
// It does not select jobs or provide retries. Optional limits are connected by
// the shared runtime owner; the mandatory read-only admit callback checks the
// scheduler's turn. Repeated preparation checkpoints never charge a call.
// Omit it and no work can start, even when a role is declared available.
export class CurateAiExecution {
  #busy = false;
  constructor({ attempts, limits, getConfig, availability, stopped = () => false, admit = () => false }) {
    this.attempts = attempts;
    this.limits = limits;
    this.getConfig = getConfig;
    this.availability = availability;
    this.stopped = stopped;
    this.admit = admit;
  }

  #reason(job) {
    if (this.stopped()) return 'stopped';
    if (!curateAiRoleEnabled(this.getConfig(), job.role, this.availability)) return 'disabled';
    // All admission/applicability callbacks are synchronous. A Promise cannot
    // accidentally authorize work using a stale answer.
    if (job.isCurrent() !== true) return 'stale';
    const limit = this.limits?.eligibility(job);
    if (limit && limit !== 'eligible') return limit;
    if (this.admit(job) !== true) return 'waiting';
    return null;
  }

  async run(job) {
    job = Object.freeze({ ...job, ...(job.photoIds ? { photoIds: Object.freeze([...job.photoIds]) } : {}) });
    for (const name of ['prepare', 'submit', 'validate', 'accept', 'isCurrent'])
      if (typeof job?.[name] !== 'function') throw new TypeError(`Missing Curate AI ${name} callback.`);
    if (this.#busy) return { state: 'busy' };
    const eligible = this.attempts.eligibility(job.role, job.inputKey);
    if (eligible !== 'eligible') return { state: eligible };
    const reason = this.#reason(job);
    if (reason) {
      if (reason === 'photo-limit') this.limits.settleLimited(job);
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
      const prepared = await job.prepare(checkpoint);
      checkpoint();
      phase = 'submit';
      ticket = this.limits ? this.limits.start(job, this.attempts) : this.attempts.start(job.role, job.inputKey);
      if (ticket.state !== 'started') return { state: ticket.state };
      const response = await job.submit(prepared);
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
      if (error instanceof AdmissionStopped && error.reason === 'photo-limit') this.limits.settleLimited(job);
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
}
