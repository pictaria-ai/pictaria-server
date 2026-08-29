/**
 * Minimal FlatBuffer carrying the Model/SubGraph/Tensor fields inspected by
 * the server. It is intentionally not an executable TFLite graph; Android
 * interpreter validation is separately authoritative before activation.
 */
export function makeWakeWordModelFixture({ outputShape = [1, 1] } = {}) {
  const bytes = Buffer.alloc(Math.max(416, 388 + outputShape.length * 4));
  bytes.writeUInt32LE(32, 0);
  bytes.write('TFL3', 4, 'ascii');

  // Model table at 32, vtable at 16: schema version + subgraphs.
  writeVtable(bytes, 16, 16, [4, 0, 8]);
  bytes.writeInt32LE(16, 32);
  bytes.writeUInt32LE(3, 36);
  bytes.writeUInt32LE(24, 40); // subgraphs vector at 64

  bytes.writeUInt32LE(1, 64);
  bytes.writeUInt32LE(28, 68); // SubGraph table at 96

  // SubGraph: tensors, inputs, outputs.
  writeVtable(bytes, 80, 16, [4, 8, 12]);
  bytes.writeInt32LE(16, 96);
  bytes.writeUInt32LE(60, 100); // tensors vector at 160
  bytes.writeUInt32LE(96, 104); // inputs vector at 200
  bytes.writeUInt32LE(108, 108); // outputs vector at 216

  bytes.writeUInt32LE(2, 160);
  bytes.writeUInt32LE(92, 164); // input Tensor at 256
  bytes.writeUInt32LE(184, 168); // output Tensor at 352

  bytes.writeUInt32LE(1, 200);
  bytes.writeInt32LE(0, 204);
  bytes.writeUInt32LE(1, 216);
  bytes.writeInt32LE(1, 220);

  // Input tensor: shape [1, 16, 96], float32 type defaults to enum zero.
  writeVtable(bytes, 240, 12, [4, 0]);
  bytes.writeInt32LE(16, 256);
  bytes.writeUInt32LE(28, 260); // shape vector at 288
  bytes.writeUInt32LE(3, 288);
  bytes.writeInt32LE(1, 292);
  bytes.writeInt32LE(16, 296);
  bytes.writeInt32LE(96, 300);

  // Output tensor: a configurable shape with one float32 score by default.
  writeVtable(bytes, 336, 12, [4, 0]);
  bytes.writeInt32LE(16, 352);
  bytes.writeUInt32LE(28, 356); // shape vector at 384
  bytes.writeUInt32LE(outputShape.length, 384);
  outputShape.forEach((dimension, index) => bytes.writeInt32LE(dimension, 388 + index * 4));

  return bytes;
}

function writeVtable(bytes, offset, objectSize, fieldOffsets) {
  bytes.writeUInt16LE(4 + fieldOffsets.length * 2, offset);
  bytes.writeUInt16LE(objectSize, offset + 2);
  fieldOffsets.forEach((fieldOffset, index) => bytes.writeUInt16LE(fieldOffset, offset + 4 + index * 2));
}
