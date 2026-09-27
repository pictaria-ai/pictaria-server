import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { crc32, inflateSync } from 'node:zlib';

import { CALIBRATION_VERSION, calibrationImage } from '../../src/embeddings/calibration.mjs';

function chunks(png) {
  const found = [];
  for (let offset = 8; offset < png.length;) {
    const length = png.readUInt32BE(offset);
    const type = png.toString('latin1', offset + 4, offset + 8);
    const data = png.subarray(offset + 8, offset + 8 + length);
    assert.equal(png.readUInt32BE(offset + 8 + length), crc32(png.subarray(offset + 4, offset + 8 + length)), `${type} CRC`);
    found.push({ type, data });
    offset += 12 + length;
  }
  return found;
}

test('the calibration image is a valid, deterministic, non-square PNG', () => {
  const { data, contentType } = calibrationImage();
  assert.equal(contentType, 'image/png');
  assert.deepEqual([...data.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const parts = chunks(data);
  assert.deepEqual(parts.map((part) => part.type), ['IHDR', 'IDAT', 'IEND']);
  const header = parts[0].data;
  assert.deepEqual([header.readUInt32BE(0), header.readUInt32BE(4), header[8], header[9]], [384, 256, 8, 2]);
  assert.equal(calibrationImage().data, data, 'rendered once per process');
});

test('calibration pixels are pinned to the calibration version', () => {
  // Changing any pixel changes every stored space's calibration vector.
  // Update this hash only together with CALIBRATION_VERSION.
  const raw = inflateSync(chunks(calibrationImage().data).find((part) => part.type === 'IDAT').data);
  assert.equal(raw.length, (384 * 3 + 1) * 256);
  assert.equal(CALIBRATION_VERSION, 1);
  assert.equal(createHash('sha256').update(raw).digest('hex'), '1fd4eff559187997a0eda743c9de0ff19152efbba9f5d1902052f535650365de');
  // Both edges carry distinct content that a centre crop removes.
  const at = (x, y) => [...raw.subarray(y * 1153 + 1 + x * 3, y * 1153 + 4 + x * 3)];
  assert.deepEqual(at(48, 128), [220, 30, 30]);
  assert.deepEqual(at(340, 128), [20, 40, 200]);
});
