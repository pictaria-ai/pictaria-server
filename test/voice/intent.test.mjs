import assert from 'node:assert/strict';
import test from 'node:test';

import { classifyVoiceIntent, normalizeVoiceText, validateVoiceIntentRequest } from '../../src/voice/intent.mjs';

test('normalizes conversational transcripts', () => {
  assert.equal(normalizeVoiceText("Frame, what's the weather?"), 'frame whats the weather');
  assert.equal(normalizeVoiceText("Don't show this again."), 'dont show this again');
});

test('classifies conversational navigation commands', () => {
  assert.deepEqual(classifyVoiceIntent('Frame, go to the next photo'), {
    kind: 'app-command',
    category: 'navigation',
    command: 'next',
    query: null,
    confidence: 'high',
    normalized: 'go to the next photo',
    transcript: 'Frame, go to the next photo',
  });

  assert.equal(classifyVoiceIntent('show me the previous photo').command, 'previous');
});

test('classifies photo metadata questions', () => {
  assert.equal(classifyVoiceIntent('where was this picture taken?').command, 'where');
  assert.equal(classifyVoiceIntent('where is this picture taken?').command, 'where');
  assert.equal(classifyVoiceIntent('what date was this taken?').command, 'when');
  assert.equal(classifyVoiceIntent('interesting').command, 'interesting');
  assert.equal(classifyVoiceIntent('interesting right').command, 'interesting-right');
});

test('classifies targeted photo action commands', () => {
  assert.equal(classifyVoiceIntent('favorite the left photo').command, 'favorite-left');
  assert.equal(classifyVoiceIntent('never show the left photo again').command, 'never-show-left');
  assert.equal(classifyVoiceIntent("don't right").command, 'never-show-right');
});

test('keeps unsupported questions separate from app commands', () => {
  assert.deepEqual(classifyVoiceIntent("what's the weather?"), {
    kind: 'general-query',
    command: null,
    query: 'whats the weather',
    confidence: 'medium',
    normalized: 'whats the weather',
    transcript: "what's the weather?",
  });
});

test('classifies tell questions and refuses bare tells', () => {
  assert.deepEqual(classifyVoiceIntent('frame tell me who painted the mona lisa'), {
    kind: 'ask-question',
    command: 'tell',
    query: 'who painted the mona lisa',
    confidence: 'high',
    normalized: 'tell me who painted the mona lisa',
    transcript: 'frame tell me who painted the mona lisa',
  });
  assert.equal(classifyVoiceIntent('tell how far away is the moon').kind, 'ask-question');
  // A bare "tell me" must not backtrack into asking the question "me".
  assert.equal(classifyVoiceIntent('tell me').kind, 'unknown');
  assert.equal(classifyVoiceIntent('frame tell me').kind, 'unknown');
  assert.equal(classifyVoiceIntent('tell').kind, 'unknown');
});

test('validates voice intent requests', () => {
  assert.deepEqual(validateVoiceIntentRequest({ transcript: ' next ' }), {
    value: { transcript: 'next' },
  });
  assert.deepEqual(validateVoiceIntentRequest({ text: 'when was this taken?' }), {
    value: { transcript: 'when was this taken?' },
  });
  assert.deepEqual(validateVoiceIntentRequest({ transcript: '' }), {
    error: 'Transcript is required.',
  });
});
