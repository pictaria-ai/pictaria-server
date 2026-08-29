import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeVoiceUsageLabel } from '../../src/voice/usageLabels.mjs';

test('every current Pictaria Frame command has a stable privacy-safe usage label', () => {
  const labels = [
    'where', 'when', 'interesting', 'interesting-left', 'interesting-right',
    'next', 'previous', 'remote', 'volume-up', 'volume-down', 'more',
    'more-left', 'more-right', 'favorite', 'favorite-left', 'favorite-right',
    'never-show', 'never-show-left', 'never-show-right', 'time',
    'weather-today', 'weather-tomorrow', 'show-search', 'tell', 'unrecognized',
  ];
  for (const label of labels) {
    assert.equal(normalizeVoiceUsageLabel(label), label);
  }
});

test('arbitrary labels are reduced before any usage store sees them', () => {
  assert.equal(normalizeVoiceUsageLabel('private spoken sentence'), 'unrecognized');
  assert.equal(normalizeVoiceUsageLabel(' unknown-client-command '), 'unrecognized');
  assert.equal(normalizeVoiceUsageLabel(null), 'unrecognized');
});
