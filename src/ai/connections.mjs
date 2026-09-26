import { createHash } from 'node:crypto';
import { awaitDrain } from '../lifecycle.mjs';
import { aiBackendKey } from '../curate/ai-limits.mjs';
import { createCurateAiProvider } from '../curate/ai-config.mjs';
import { createProvider, enrichmentProviderConfiguration, ProviderRequestError } from '../enrich/providers.mjs';

export function connectionMessage(status) {
  if (status.state === 'busy') return 'AI request in progress.';
  if (status.state === 'cooldown') return 'AI connection is cooling down. Eligible work can try again afterward.';
  if (status.state === 'recovery-ready') return 'The next eligible AI request can check whether the connection has recovered.';
  if (status.state === 'paused') return {
    auth: 'AI connection paused: check the API key, then verify the connection in Settings → AI Providers.',
    configuration: 'AI connection paused: check the provider and model settings, then verify the connection in Settings → AI Providers.',
    interrupted: 'AI recovery was interrupted. Verify the connection in Settings → AI Providers to resume.',
  }[status.reason];
  return 'Ready for AI requests.';
}

export class AiConnectionPaused extends Error {
  constructor(status) {
    super(connectionMessage(status));
    this.code = 'ai_connection_paused';
    this.status = status;
  }
}

// No timer or automatic probes. All real work is admitted by the shared
// scheduler before calling run(); explicit verification acquires its own turn.
export class AiConnections {
  constructor({ limits, scheduler, getConfig, stopped = () => false }) {
    Object.assign(this, { limits, scheduler, getConfig, stopped });
    this.verification = null;
    this.closed = false;
  }

  status(provider) { return this.limits.providerStatus(aiBackendKey(provider)); }

  assertAvailable(provider) {
    const status = this.status(provider);
    if (!['ready', 'recovery-ready'].includes(status.state)) throw new AiConnectionPaused(status);
  }

  async run(provider, submit, { verification = false } = {}) {
    const backendKey = aiBackendKey(provider);
    const ticket = this.limits.startProvider(backendKey, { verification });
    if (ticket.state !== 'started') throw new AiConnectionPaused(this.status(provider));
    let result;
    try { result = await submit(); }
    catch (error) {
      // A deliberately requested connection test must pass its tiny contract
      // before clearing a pause. Ordinary per-photo malformed answers retain
      // their existing non-outage treatment.
      const verificationRejected = verification && error instanceof ProviderRequestError
        && (error.invalidResponse || (!error.infrastructure && !error.cancelled));
      this.limits.finish(ticket, verificationRejected ? new Error('AI verification was rejected.') : error);
      throw error;
    }
    this.limits.finish(ticket);
    return result;
  }

  provider(target) {
    const config = this.getConfig();
    if (target === 'curate') return createCurateAiProvider(config);
    if (target === 'enrich') return createProvider(config.defaultProvider, config.providers[config.defaultProvider]);
    if (this.isTarget(target)) {
      const name = target.slice('provider:'.length);
      return createProvider(name, config.providers[name]);
    }
    throw new TypeError('Unknown AI connection.');
  }

  isTarget(target) {
    return ['enrich', 'curate'].includes(target) || (typeof target === 'string' && target.startsWith('provider:')
      && Object.hasOwn(this.getConfig().providers, target.slice('provider:'.length)));
  }

  describe() {
    const config = this.getConfig();
    // Enrich permits a per-run provider choice. Include other configured
    // providers so their paused connection can be verified without changing
    // the default provider just to gain access to a recovery button.
    const selected = new Set([config.defaultProvider, config.curateRefereeProvider || config.defaultProvider]);
    const extras = Object.keys(config.providers).filter(name => !selected.has(name))
      .map(name => `provider:${name}`).filter(target => { try { this.provider(target); return true; } catch { return false; } });
    return ['enrich', 'curate', ...extras].map(target => {
      try {
        const provider = this.provider(target), status = this.status(provider);
        return { target, provider: provider.providerName, model: provider.modelName, ...status,
          message: connectionMessage(status), verifying: this.verification?.target === target,
          canVerify: !this.closed && !this.stopped() && !this.verification && !['busy', 'cooldown'].includes(status.state) };
      } catch {
        return { target, state: 'not-configured', reason: 'configuration', canVerify: false,
          message: 'Not configured. Complete the provider and model settings before verifying this connection.' };
      }
    });
  }

  async verify(target) {
    if (!this.isTarget(target)) throw new TypeError('Unknown AI connection.');
    if (this.closed || this.stopped() || this.verification) return { verified: false, message: 'Another check is running or the server is stopping.' };
    let provider;
    try { provider = this.provider(target); }
    catch { return { verified: false, message: 'Complete the saved provider and model settings first.' }; }
    // Pin the full saved inference configuration. Changing Settings while this
    // waits cancels the queued test instead of silently testing another model.
    const signature = p => createHash('sha256').update(JSON.stringify([aiBackendKey(p), enrichmentProviderConfiguration(p), p.timeoutMs])).digest('hex');
    const expected = signature(provider);
    const current = () => {
      try { return !this.closed && !this.stopped() && signature(this.provider(target)) === expected; }
      catch { return false; }
    };
    const controller = new AbortController();
    // Use the saved provider timeout for inference (local models can be slow).
    // Shutdown cancels both scheduling waits and the active transport.
    const session = this.scheduler.session(provider, 'curate', { signal: controller.signal, eligible: current });
    const verification = { target, controller, promise: null };
    this.verification = verification;
    verification.promise = (async () => {
      try {
        await session.run(() => this.run(provider, async () => {
          const result = await provider.analyzeImage(VERIFICATION_IMAGE, { signal: controller.signal,
            systemPrompt: 'This is a connection test. Return only the requested JSON.',
            userPrompt: 'Return {"ok":true}. The image is a synthetic test image.',
            jsonSchema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false },
          });
          if (result.normalizedOutput?.ok !== true || Object.keys(result.normalizedOutput).length !== 1)
            throw new ProviderRequestError('The test answer did not match the requested format.', { status: 200, invalidResponse: true });
        }, { verification: true }));
        return { verified: true, message: 'Connection verified. Eligible AI work can continue; stopped Enrich jobs can be run again.' };
      } catch (error) {
        if (error instanceof AiConnectionPaused) return { verified: false, message: error.message };
        if (error?.invalidResponse) return { verified: false, message: 'The provider answered, but not in the requested format. The connection remains paused; check that the model supports images and structured output, then verify again.' };
        if (controller.signal.aborted || !current()) return { verified: false, message: 'Verification timed out, was interrupted, or the saved settings changed.' };
        const status = this.status(provider);
        return { verified: false, message: status.state === 'ready'
          ? 'The provider rejected the verification request. Check the saved provider and model settings.'
          : connectionMessage(status) };
      } finally {
        session.close();
        if (this.verification === verification) this.verification = null;
      }
    })();
    return verification.promise;
  }

  stop(timeoutMs = 3000) {
    this.closed = true;
    this.verification?.controller.abort();
    return awaitDrain(this.verification?.promise, timeoutMs);
  }
}

// A tiny synthetic PNG, never a library photo. Ordinary provider response/body
// limits still apply. This test is one explicit model call and may incur cost.
const VERIFICATION_IMAGE = Object.freeze({ mimeType: 'image/png',
  data: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAIAAAACACAIAAABMXPacAAABK0lEQVR4nO3RMQ0AAAjAMPxrQxQyerAqWLLZUKMDvmsA1gCsAVgDsAZgDcAagDUAawDWAKwBWAOwBmANwBqANQBrANYArAFYA7AGYA3AGoA1AGsA1gCsAVgDsAZgDcAagDUAawDWAKwBWAOwBmANwBqANQBrANYArAFYA7AGYA3AGoA1AGsA1gCsAVgDsAZgDcAagDUAawDWAKwBWAOwBmANwBqANQBrANYArAFYA7AGYA3AGoA1AGsA1gCsAVgDsAZgDcAagDUAawDWAKwBWAOwBmANwBqANQBrANYArAFYA7AGYA3AGoA1AGsA1gCsAVgDsAZgDcAagDUAawDWAKwBWAOwBmANwBqANQBrANYArAFYA7AGYA3AGoA1AGsA1gCsAVgDsAZgDcAO0NEI+Cdr8YoAAAAASUVORK5CYII=', 'base64') });
