import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_ASK_PROMPT,
  DEFAULT_INTERESTING_PROMPT,
  renderPromptTemplate,
} from '../../src/voice/promptTemplates.mjs';

test('built-in templates carry their placeholders', () => {
  assert.ok(DEFAULT_INTERESTING_PROMPT.includes('{context}'));
  assert.ok(DEFAULT_ASK_PROMPT.includes('{question}'));
});

test('renderPromptTemplate substitutes every occurrence', () => {
  assert.equal(
    renderPromptTemplate('Q: {question} — again: {question}', { question: 'why' }),
    'Q: why — again: why',
  );
});

test('renderPromptTemplate treats values as plain text', () => {
  // A question containing $-patterns or braces must land verbatim — the
  // split/join rendering never re-scans substituted values.
  assert.equal(
    renderPromptTemplate('Q: {question}', { question: 'what does $& mean' }),
    'Q: what does $& mean',
  );
  assert.equal(renderPromptTemplate('Q: {question}', { question: null }), 'Q: ');
});

test('renderPromptTemplate leaves unknown placeholders alone', () => {
  assert.equal(
    renderPromptTemplate('Keep {other} but fill {question}', { question: 'this' }),
    'Keep {other} but fill this',
  );
});
