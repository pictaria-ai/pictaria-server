// Labels Pictaria Frame is allowed to persist for voice-command usage. The
// reporting endpoint is intentionally label-only, but accepting an arbitrary
// string there would let a buggy client turn a transcript into stored data.
// Cross-product contract: keep this in sync with Pictaria Frame's command
// labels. The contract test below this module pins the current complete set.
const VOICE_USAGE_LABELS = new Set([
  'favorite',
  'favorite-left',
  'favorite-right',
  'interesting',
  'interesting-left',
  'interesting-right',
  'more',
  'more-left',
  'more-right',
  'never-show',
  'never-show-left',
  'never-show-right',
  'next',
  'previous',
  'remote',
  'show-search',
  'tell',
  'time',
  'unrecognized',
  'volume-down',
  'volume-up',
  'weather-today',
  'weather-tomorrow',
  'when',
  'where',
]);

export function normalizeVoiceUsageLabel(value) {
  const label = typeof value === 'string' ? value.trim() : '';
  return VOICE_USAGE_LABELS.has(label) ? label : 'unrecognized';
}
