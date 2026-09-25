import { curateAiRoleEnabled } from './ai-policy.mjs';
import { ProviderRequestError } from '../enrich/providers.mjs';

class AdmissionStopped extends Error {
  constructor(reason) { super(reason); this.reason = reason; }
}

function failureReason(error, phase) {
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
// It does not select jobs, provide retries, or implement provider/cohort budgets.
// The mandatory, read-only admit callback checks those remaining controls and
// the scheduler's existing reservation/turn; it must not reserve on each check.
// Omit it and no work can start, even when a role is declared available.
export class CurateAiExecution {
  #busy = false;
  constructor({ attempts, getConfig, availability, stopped = () => false, admit = () => false }) {
    this.attempts = attempts;
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
    if (this.admit(job) !== true) return 'waiting';
    return null;
  }

  async run(job) {
    job = Object.freeze({ ...job });
    for (const name of ['prepare', 'submit', 'validate', 'accept', 'isCurrent'])
      if (typeof job?.[name] !== 'function') throw new TypeError(`Missing Curate AI ${name} callback.`);
    if (this.#busy) return { state: 'busy' };
    const eligible = this.attempts.eligibility(job.role, job.inputKey);
    if (eligible !== 'eligible') return { state: eligible };
    const reason = this.#reason(job);
    if (reason) return { state: reason };
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
      ticket = this.attempts.start(job.role, job.inputKey);
      if (ticket.state !== 'started') return { state: ticket.state };
      const response = await job.submit(prepared);
      // Turning a role off after dispatch does not discard useful paid work.
      // Changed photos/human decisions still invalidate it. No dependent job
      // is created here; it must pass fresh admission through run() separately.
      if (job.isCurrent() !== true) {
        this.attempts.finish(ticket, 'stale');
        return { state: 'stale' };
      }
      phase = 'validate';
      const result = job.validate(response);
      if (result && typeof result.then === 'function') throw new TypeError('AI validation must be synchronous.');
      phase = 'accept';
      // Acceptance and its accounting commit together. The accepting adapter
      // must synchronously revalidate material/human inputs in this transaction.
      this.attempts.repo.transaction(() => {
        if (job.isCurrent() !== true) throw new AdmissionStopped('stale');
        if (!this.attempts.finish(ticket, 'succeeded')) throw new AdmissionStopped('superseded');
        const accepted = job.accept(result);
        if (accepted && typeof accepted.then === 'function') throw new TypeError('AI acceptance must be synchronous.');
      });
      return { state: 'succeeded', attempts: ticket.attempts };
    } catch (error) {
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
