import assert from 'node:assert/strict';
import test from 'node:test';

import {
  inspectWakeWordModel,
  WakeWordModelValidationError,
} from '../../src/wakeword/modelInspector.mjs';
import { makeWakeWordModelFixture } from './modelFixture.mjs';

test('accepts the one-input openWakeWord tensor contract Pictaria supports', () => {
  const result = inspectWakeWordModel(makeWakeWordModelFixture());
  assert.deepEqual(result.inputShape, [1, 16, 96]);
  assert.deepEqual(result.outputShape, [1, 1]);
  assert.equal(result.featureStack, 'pictaria-openwakeword-v1');
  assert.equal(result.inputFrames, 16);
});

test('rejects non-TFLite, incompatible, oversized-window, and multi-input structures', () => {
  const cases = [
    {
      message: /missing TFL3/,
      mutate(bytes) { bytes.write('NOPE', 4, 'ascii'); },
    },
    {
      message: /shape \[1, frames, 96\]/,
      mutate(bytes) { bytes.writeInt32LE(64, 300); },
    },
    {
      message: /frames between 1 and 120/,
      mutate(bytes) { bytes.writeInt32LE(121, 296); },
    },
    {
      message: /exactly one input/,
      mutate(bytes) { bytes.writeUInt32LE(2, 200); },
    },
    {
      message: /exactly one float32 score/,
      mutate(bytes) { bytes.writeInt32LE(2, 392); },
    },
  ];
  for (const { message, mutate } of cases) {
    const bytes = makeWakeWordModelFixture();
    mutate(bytes);
    assert.throws(() => inspectWakeWordModel(bytes), message);
  }
});

test('corrupt offsets fail as a model validation error rather than escaping as RangeError', () => {
  const bytes = makeWakeWordModelFixture();
  bytes.writeUInt32LE(0xfffffff0, 40);
  assert.throws(
    () => inspectWakeWordModel(bytes),
    (error) => error instanceof WakeWordModelValidationError && /structure is unreadable/.test(error.message),
  );
});

test('rejects an output tensor rank the restored registry cannot retain', () => {
  assert.throws(
    () => inspectWakeWordModel(makeWakeWordModelFixture({ outputShape: Array(17).fill(1) })),
    /exactly one float32 score/,
  );
});
