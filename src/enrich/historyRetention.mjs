export const HISTORY_LIMITS = Object.freeze({ defaultRuns: 100, minRuns: 100, maxRuns: 1000, defaultLogs: 100, maxLogs: 100 });

export function historyRetention({ runs = HISTORY_LIMITS.defaultRuns, logs = HISTORY_LIMITS.defaultLogs } = {}) {
  if (!Number.isSafeInteger(runs) || runs < HISTORY_LIMITS.minRuns || runs > HISTORY_LIMITS.maxRuns
      || !Number.isSafeInteger(logs) || logs < 0 || logs > HISTORY_LIMITS.maxLogs) {
    throw new Error('Enrich history requires 100–1,000 run summaries and 0–100 run logs.');
  }
  return { runs, logs };
}
