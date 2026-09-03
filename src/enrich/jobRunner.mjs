import { awaitDrain } from '../lifecycle.mjs';
import { runBatch, loadPrompts, emptyCounters } from './runner.mjs';
import { createProvider } from './providers.mjs';
import { configuredSecrets, sanitizeDiagnostic } from '../diagnostics.mjs';

// Single-flight enrichment job runner for the server: one run at a time,
// live progress counters, a bounded log tail, and cancellation that aborts
// provider requests while remaining cooperative at Immich boundaries.

const LOG_TAIL_LIMIT = 500;

export class EnrichJobRunner {
  constructor({ repo, immich, taxonomy, config }) {
    this.repo = repo;
    this.immich = immich;
    this.taxonomy = taxonomy;
    this.config = config;
    this.state = idleState();
    this.runPromise = null;
    this.runLifecycle = null;
    // One-way shutdown latch: a request landing during the drain window
    // must not start a run nobody will drain or record.
    this.stopped = false;
  }

  status() {
    return {
      ...this.state,
      log: [...this.state.log],
      defaults: { provider: this.config.defaultProvider, imageSource: this.config.imageSource },
      available: availableProviders(this.config),
    };
  }

  isRunning() {
    return this.state.running;
  }

  cancel() {
    if (!this.state.running) {
      return false;
    }
    const firstCancellation = !this.state.cancelRequested;
    this.state.cancelRequested = true;
    this.runLifecycle?.providerAbortController.abort();
    if (firstCancellation) {
      this.#log('cancel requested; stopping current photo');
    }
    return true;
  }

  // Shutdown drain: request cancellation (the run checks between photos) and
  // wait for the run promise — bounded, because Immich work does not yet
  // take the run's abort signal. Provider work is aborted immediately. A run
  // that drains in time records itself as
  // 'cancelled' through its own finally; one we give up on is recorded as
  // 'interrupted' here, or it would vanish from run history when the
  // process exits before its finally reaches the database. Per-photo
  // results are already committed either way, and a queued item stays
  // queued. Returns false when the wait gave up.
  async stop(timeoutMs = 3000) {
    this.stopped = true;
    if (!this.state.running) {
      return true;
    }
    this.cancel();
    const drained = await awaitDrain(this.runPromise, timeoutMs);
    if (!drained) {
      try {
        this.recordInterrupted();
      } catch (error) {
        this.#log(`could not record the interrupted run: ${error instanceof Error ? error.message : error}`);
      }
    }
    return drained;
  }

  // Called from the process signal handler (SIGTERM/SIGINT — a restart, or
  // docker stop). The async run loop never gets to its finally block, so
  // record the run synchronously here or it vanishes from history. Per-photo
  // results are already committed; a queued item stays queued and resumes.
  recordInterrupted() {
    const lifecycle = this.runLifecycle;
    if (!this.state.running || !lifecycle || lifecycle.terminalRecorded) {
      return false;
    }
    if (!lifecycle.interrupted) {
      lifecycle.interrupted = true;
      lifecycle.terminalStatus = 'interrupted';
      lifecycle.interruptedAt = new Date().toISOString();
      this.#log('server shutting down — run interrupted; results so far are saved and the job stays queued');
    }
    this.#recordTerminal(lifecycle, {
      status: 'interrupted',
      error: null,
      finishedAt: lifecycle.interruptedAt,
    });
    return true;
  }

  #recordTerminal(lifecycle, { status, error, finishedAt }) {
    if (lifecycle.terminalRecorded) return false;
    this.repo.recordJobRun({
      title: this.state.title,
      provider: this.state.provider,
      model: this.state.model,
      promptVersion: this.state.promptVersion,
      taxonomyVersion: this.taxonomy.version,
      inferenceHostLabel: this.state.inferenceHostLabel,
      targeted: this.state.options.targeted,
      status,
      error,
      counters: this.state.counters,
      log: this.state.log,
      startedAt: this.state.startedAt,
      finishedAt,
    });
    lifecycle.terminalRecorded = true;
    lifecycle.terminalStatus = status;
    return true;
  }

  #resolveProvider(requestedProvider) {
    const providerName = requestedProvider || this.config.defaultProvider;
    const providerOptions = this.config.providers[providerName];
    if (!providerOptions) {
      throw new Error(`Unknown provider: ${providerName}`);
    }
    return { providerName, provider: createProvider(providerName, providerOptions) };
  }

  #promptVersion() {
    const overrides = this.config.promptOverrides ?? {};
    return overrides.systemPrompt || overrides.userTemplate
      ? `${this.config.promptVersion}-custom`
      : this.config.promptVersion;
  }

  // Batch filter for skip-aware slice resolution: given asset ids, returns
  // { needy, successful, failureLimited } — the subset a run with these
  // options would actually analyze, plus the dropped ids classified so the
  // caller can review-list the already-enriched ones and report terminal
  // failures honestly. Uses the same run key start() would resolve, so it
  // never drops a photo the run would process; the runner's own per-photo
  // checks stay as the race-safety second layer.
  needsWorkFilter({ provider, skipAnySuccessful = true } = {}) {
    const { providerName, provider: resolved } = this.#resolveProvider(provider);
    const runKey = {
      provider: providerName,
      model: resolved.modelName,
      promptVersion: this.#promptVersion(),
      taxonomyVersion: this.taxonomy.version,
    };
    return (assetIds) => this.repo.assetIdsNeedingWork(assetIds, {
      runKey,
      skipAnySuccessful: skipAnySuccessful !== false,
      maxFailuresPerAsset: this.config.maxFailuresPerAsset,
    });
  }

  // The library-wide stuck set for the Enrich page's retry affordance:
  // photos whose content failures under the active run key reached the
  // limit, with no success covering them since. Resolves the same run key
  // start() would, so the listed ids are exactly what a retry run targets.
  // skipAnySuccessful is deliberately true: a photo enriched under ANY
  // setup has data and isn't "stuck" — re-running it under the current
  // model is the compare workflow (uncheck "Only unenriched"), not this
  // affordance's job.
  failureLimitedSummary({ provider } = {}) {
    const { providerName, provider: resolved } = this.#resolveProvider(provider);
    const runKey = {
      provider: providerName,
      model: resolved.modelName,
      promptVersion: this.#promptVersion(),
      taxonomyVersion: this.taxonomy.version,
    };
    return {
      provider: providerName,
      model: resolved.modelName,
      maxFailuresPerAsset: this.config.maxFailuresPerAsset,
      // Cap matches start()'s assetIds cap so one retry can take the lot.
      ...this.repo.failureLimitedAssetIds({
        runKey,
        maxFailuresPerAsset: this.config.maxFailuresPerAsset,
        skipAnySuccessful: true,
        limit: 10000,
      }),
    };
  }

  // The stuck strip's details popup renders the failureLimitedSummary set as
  // human-readable rows: filename, capture date, and the failure message that
  // put each photo here. It is capped well below the retry cap; a popup past
  // 500 rows is a scrolling exercise, and truncation keeps the count honest.
  failureLimitedDetails({ provider } = {}) {
    const { providerName, provider: resolved } = this.#resolveProvider(provider);
    const runKey = {
      provider: providerName,
      model: resolved.modelName,
      promptVersion: this.#promptVersion(),
      taxonomyVersion: this.taxonomy.version,
    };
    const summary = this.repo.failureLimitedAssetIds({
      runKey,
      maxFailuresPerAsset: this.config.maxFailuresPerAsset,
      skipAnySuccessful: true,
      limit: 500,
    });
    return {
      provider: providerName,
      model: resolved.modelName,
      count: summary.count,
      truncated: summary.truncated,
      rows: this.repo.assetFailureDetails(summary.assetIds, { runKey }),
    };
  }

  // Server-side "Discard all" resolves the CURRENT stuck set under the active
  // run key and discards exactly that. The client never supplies ids, so a
  // stale popup can't discard beyond what is stuck right now, and the details
  // popup's 500-row display cap never limits the operation. It uses the same
  // 10,000 cap as retry; larger sets take a second click, and `truncated`
  // reports that limit.
  discardFailureLimited({ provider } = {}) {
    const { providerName, provider: resolved } = this.#resolveProvider(provider);
    const runKey = {
      provider: providerName,
      model: resolved.modelName,
      promptVersion: this.#promptVersion(),
      taxonomyVersion: this.taxonomy.version,
    };
    const summary = this.repo.failureLimitedAssetIds({
      runKey,
      maxFailuresPerAsset: this.config.maxFailuresPerAsset,
      skipAnySuccessful: true,
      limit: 10000,
    });
    return {
      provider: providerName,
      model: resolved.modelName,
      count: summary.count,
      truncated: summary.truncated,
      ...this.repo.discardAssets(summary.assetIds),
    };
  }

  // A queue item that resolves to nothing runnable never reaches start(),
  // but its outcome still belongs in run history — especially when the
  // removal happens mid Run-all chain, after the HTTP response is gone.
  // Recorded like the zero-analysis run the pre-skip-aware code would have
  // produced: 0 analyzed, with the skip counters carrying the story.
  recordCoveredResolution({ title, provider, covered = 0, failureLimited = 0, discarded = 0 }) {
    const { providerName, provider: resolved } = this.#resolveProvider(provider);
    const now = new Date().toISOString();
    this.repo.recordJobRun({
      title: String(title || 'Photo slice'),
      provider: providerName,
      model: resolved.modelName,
      promptVersion: this.#promptVersion(),
      taxonomyVersion: this.taxonomy.version,
      inferenceHostLabel: this.config.inferenceHostLabel,
      targeted: 0,
      status: 'finished',
      error: null,
      counters: {
        ...emptyCounters(),
        skippedSuccessful: covered,
        skippedFailureLimit: failureLimited,
        skippedDiscarded: discarded,
      },
      log: [
        `${now.slice(11, 19)} nothing left to analyze — ${covered} already enriched` +
          (failureLimited > 0 ? `, ${failureLimited} at the failure limit` : '') +
          (discarded > 0 ? `, ${discarded} discarded` : '') +
          '; removed the queue item',
      ],
      startedAt: now,
      finishedAt: now,
    });
  }

  start(options = {}) {
    if (this.stopped) {
      throw new Error('The server is shutting down.');
    }
    if (this.state.running) {
      throw new Error('An enrichment run is already in progress.');
    }
    const { providerName, provider } = this.#resolveProvider(options.provider);
    const prompts = loadPrompts(this.config.promptsDir, this.config.promptVersion);
    const overrides = this.config.promptOverrides ?? {};
    if (overrides.systemPrompt) prompts.systemPrompt = overrides.systemPrompt;
    if (overrides.userTemplate) prompts.userTemplate = overrides.userTemplate;
    const promptVersion = this.#promptVersion();
    // Targeted mode ("Send to Enrich"): analyze exactly these assets instead
    // of paging the library newest-first.
    const assetIds = Array.isArray(options.assetIds)
      ? [...new Set(options.assetIds.map((id) => String(id || '').trim()).filter(Boolean))].slice(0, 10000)
      : null;
    // Deliberate retry of photos stuck at the content-failure limit: the cap
    // is off for this one run, but only ever for an explicit asset list — a
    // library-wide bypass would re-burn spend on every broken photo at once.
    // Failure history is never cleared: a retry that fails again just deepens
    // the count, and one that succeeds leaves the stuck set naturally.
    const retryFailureLimited = Boolean(options.retryFailureLimited);
    if (retryFailureLimited && !assetIds) {
      throw new Error('Retrying failure-limited photos needs an explicit asset list.');
    }

    this.state = {
      ...idleState(),
      running: true,
      startedAt: new Date().toISOString(),
      provider: providerName,
      model: provider.modelName,
      inferenceHostLabel: this.config.inferenceHostLabel || null,
      promptVersion,
      title: String(
        options.title || (assetIds ? (retryFailureLimited ? 'Retry failed photos' : 'Targeted run') : 'Library sweep'),
      ),
      options: {
        retryFailureLimited,
        retrySourceRunId: Number.isSafeInteger(Number(options.retrySourceRunId)) && Number(options.retrySourceRunId) > 0
          ? Number(options.retrySourceRunId)
          : null,
        limit: clampInt(options.limit, 1, 100000, 100),
        offset: clampInt(options.offset, 0, 10000000, 0),
        skipAnySuccessful: options.skipAnySuccessful !== false,
        maxAnalyzed: options.maxAnalyzed ? clampInt(options.maxAnalyzed, 1, 100000, null) : null,
        imageSource: ['preview', 'thumbnail', 'original'].includes(options.imageSource)
          ? options.imageSource
          : this.config.imageSource,
        targeted: assetIds ? assetIds.length : null,
        // Set for queue runs so the UI can lock that item's Remove button.
        queueItemId: Number.isFinite(Number(options.queueItemId)) ? Number(options.queueItemId) : null,
        sendToCurate: options.sendToCurate !== false,
        reopenDecided: Boolean(options.reopenDecided),
      },
    };
    // Runs once after a clean finish (not failed, not cancelled) — used by
    // the queue's "re-open in Curate" option to clear earlier decisions.
    this.onRunFinished = typeof options.onFinished === 'function' ? options.onFinished : null;
    if (assetIds) {
      this.#log(`targeted run: ${assetIds.length} assets from a slice${options.sliceTruncated ? ' (capped — send again for the rest)' : ''}`);
    }
    if (retryFailureLimited) {
      const source = this.state.options.retrySourceRunId;
      this.#log(source
        ? `retrying failures from run #${source}: the content-failure cap is off for this run; failures still count toward each photo's history`
        : `retrying photos at the failure limit: the ${this.config.maxFailuresPerAsset}-failure cap is off for this run; failures still count toward each photo's history`);
    }
    if (options.reopenDecided) {
      this.#log('when this run finishes, earlier Curate decisions for these photos will be cleared for re-review');
    }

    // Per-run latch: an interruption record written after a timed-out drain
    // remains the sole terminal history row even if abandoned async work
    // later settles. Kept separate from UI state so queue completion cannot
    // accidentally reset it while the old promise unwinds.
    const lifecycle = {
      interrupted: false,
      interruptedAt: null,
      terminalRecorded: false,
      terminalStatus: null,
      providerAbortController: new AbortController(),
    };
    this.runLifecycle = lifecycle;
    // Stored so stop() can drain the in-flight run; #run never rejects.
    this.runPromise = this.#run(provider, prompts, assetIds, lifecycle);
    return this.status();
  }

  async #run(provider, prompts, assetIds, lifecycle) {
    let listed = 0;
    try {
      const { counters, listedForReview } = await runBatch({
        immich: this.immich,
        repo: this.repo,
        provider,
        taxonomy: this.taxonomy,
        systemPrompt: prompts.systemPrompt,
        userTemplate: prompts.userTemplate,
        assetIds,
        limit: this.state.options.limit,
        offset: this.state.options.offset,
        skipAnySuccessful: this.state.options.skipAnySuccessful,
        maxAnalyzed: this.state.options.maxAnalyzed,
        maxFailuresPerAsset: this.state.options.retryFailureLimited ? 0 : this.config.maxFailuresPerAsset,
        retryFailureLimited: this.state.options.retryFailureLimited,
        imageSource: this.state.options.imageSource,
        promptVersion: this.state.promptVersion,
        applyTags: false,
        dryRun: true,
        listForReview: this.state.options.sendToCurate,
        // Read at run start; the background worker also checks the live
        // setting, so a mid-run toggle just pauses the queue, not the run.
        captionWriteback: Boolean(this.config.captionWriteback),
        shouldStop: () => this.state.cancelRequested,
        signal: lifecycle.providerAbortController.signal,
        log: (message) => this.#onProgress(message),
      });
      this.state.counters = counters;
      listed = listedForReview ?? 0;
      this.state.finishedAt = new Date().toISOString();
      this.state.cancelled = this.state.cancelRequested;
      this.#log(this.state.cancelled ? 'run cancelled' : 'run complete');
    } catch (error) {
      this.state.error = this.#diagnostic(error);
      this.state.finishedAt = new Date().toISOString();
      this.#log(`run failed: ${this.state.error}`);
    } finally {
      this.state.running = false;
      this.state.cancelRequested = false;
      try {
        this.#recordTerminal(lifecycle, {
          status: lifecycle.interrupted
            ? 'interrupted'
            : this.state.error
              ? 'failed'
              : this.state.cancelled
                ? 'cancelled'
                : 'finished',
          error: lifecycle.interrupted ? null : this.state.error,
          finishedAt: lifecycle.interrupted ? lifecycle.interruptedAt : this.state.finishedAt,
        });
      } catch (error) {
        this.#log(`could not record run history: ${error instanceof Error ? error.message : error}`);
      }
      // Once interruption has been published, the abandoned promise may
      // only settle and clear in-memory state. It must never remove/advance
      // its queue item or invoke a clean-finish callback after shutdown gave
      // up waiting for it.
      if (lifecycle.interrupted) {
        this.onRunFinished = null;
        return;
      }
      // "Send results to Curate": photos join the review list as they are
      // enriched (or were already enriched) during the run — never on
      // failure, so Curate holds no un-enriched mystery rows. Failed photos
      // stay with the queue item and re-enter when a later run enriches
      // them. Decided photos stay decided — membership never resets
      // decisions.
      if (this.state.options.sendToCurate && this.state.counters) {
        const failed = this.state.counters.failed ?? 0;
        // Honest about the failure limit: a normal run's failures re-enter
        // only until they hit the cap. A deliberate retry can also include
        // first-time or infrastructure failures from a history card, so
        // describe their retry path without claiming they are all capped.
        const failedNote = failed === 0
          ? ''
          : this.state.options.retryFailureLimited
            ? `; ${failed} failed photo(s) stay out — re-run them again from Recent runs if needed`
            : `; ${failed} failed photo(s) stay out and retry on the next run (until they hit the failure limit)`;
        this.#log(`sent to Curate: ${listed} photo(s) newly listed for review${failedNote}`);
      }
      const onFinished = this.onRunFinished;
      this.onRunFinished = null;
      if (onFinished && !this.state.error && !this.state.cancelled) {
        try {
          onFinished();
          if (this.state.options.reopenDecided) {
            this.#log('cleared earlier Curate decisions — these photos are back in the review queue');
          }
        } catch (error) {
          this.#log(`post-run bookkeeping failed: ${error instanceof Error ? error.message : error}`);
        }
      } else if (onFinished) {
        this.#log('run did not finish cleanly — the job stays queued; run it again to continue where it left off');
      }
    }
  }

  #onProgress(message) {
    const match = /^\[(\d+)\/(\d+)\]/.exec(message);
    if (match) {
      this.state.progress = { position: Number(match[1]), total: Number(match[2]) };
    }
    const counterMatch = /^ {2}(tags|failed)/.exec(message);
    if (counterMatch) {
      const key = counterMatch[1] === 'tags' ? 'succeeded' : 'failed';
      this.state.liveCounters[key] += 1;
    }
    this.#log(message);
  }

  #log(message) {
    this.state.log.push(`${new Date().toISOString().slice(11, 19)} ${this.#diagnostic(message)}`);
    if (this.state.log.length > LOG_TAIL_LIMIT) {
      // Keep one visible marker plus the newest entries. The database sink
      // independently reapplies its own byte and entry ceilings.
      this.state.log.splice(0, this.state.log.length - LOG_TAIL_LIMIT + 1);
      this.state.log.unshift('… earlier log entries omitted');
    }
  }

  #diagnostic(value) {
    return sanitizeDiagnostic(value instanceof Error ? value.message : value, {
      secrets: configuredSecrets(this.config, this.immich),
    });
  }
}

function availableProviders(config) {
  const requirements = {
    cloud_openai: (options) => Boolean(options.apiKey),
    local_lmstudio: (options) => Boolean(options.modelName),
    openai_compatible: (options) => Boolean(options.baseUrl && options.modelName),
    openrouter: (options) => Boolean(options.apiKey),
    cloud_ollama: (options) => Boolean(options.apiKey),
    local_ollama: (options) => Boolean(options.modelName),
    // No default model ships for Venice, so both halves are required.
    venice: (options) => Boolean(options.apiKey && options.modelName),
  };
  return Object.entries(config.providers).map(([name, options]) => ({
    name,
    configured: requirements[name]?.(options) ?? false,
    model: options.modelName || null,
  }));
}

function idleState() {
  return {
    running: false,
    cancelRequested: false,
    cancelled: false,
    title: null,
    promptVersion: null,
    startedAt: null,
    finishedAt: null,
    provider: null,
    model: null,
    inferenceHostLabel: null,
    options: null,
    progress: null,
    liveCounters: { succeeded: 0, failed: 0 },
    counters: null,
    error: null,
    log: [],
  };
}

function clampInt(value, min, max, fallback) {
  const parsed = Number.parseInt(value ?? '', 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, parsed));
}
