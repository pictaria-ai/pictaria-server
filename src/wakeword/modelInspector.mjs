const TFLITE_IDENTIFIER = 'TFL3';
const TENSOR_TYPE_FLOAT32 = 0;
const EXPECTED_EMBEDDING_DIMENSION = 96;
const MAX_WAKE_INPUT_FRAMES = 120;
export const MAX_WAKE_WORD_SHAPE_DIMENSIONS = 16;

export class WakeWordModelValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'WakeWordModelValidationError';
    this.code = 'invalid_wake_word_model';
  }
}

/**
 * Inspect the small part of the TensorFlow Lite FlatBuffer schema Pictaria
 * relies on. This is intentionally not a general TFLite parser: the Android
 * runtime performs the authoritative interpreter/inference validation before
 * activation, while the server rejects obviously incompatible uploads early.
 */
export function inspectWakeWordModel(modelBytes) {
  const bytes = Buffer.isBuffer(modelBytes) ? modelBytes : Buffer.from(modelBytes ?? []);
  try {
    if (bytes.byteLength < 32) {
      throw new WakeWordModelValidationError('The model file is too small to be a TensorFlow Lite model.');
    }
    if (bytes.subarray(4, 8).toString('ascii') !== TFLITE_IDENTIFIER) {
      throw new WakeWordModelValidationError('The file is not a TensorFlow Lite model (missing TFL3 identifier).');
    }

    const reader = new FlatBufferReader(bytes);
    const model = reader.rootTable();
    const schemaVersion = reader.uint32Field(model, 0, 0);
    if (schemaVersion !== 3) {
      throw new WakeWordModelValidationError(`Unsupported TensorFlow Lite schema version ${schemaVersion}.`);
    }

    const subgraphs = reader.tableVector(model, 2);
    if (subgraphs.length < 1) {
      throw new WakeWordModelValidationError('The model does not contain an inference subgraph.');
    }
    const main = subgraphs.tableAt(0);
    const tensors = reader.tableVector(main, 0);
    const inputs = reader.int32Vector(main, 1);
    const outputs = reader.int32Vector(main, 2);
    if (inputs.length !== 1 || outputs.length !== 1) {
      throw new WakeWordModelValidationError('A wake-word model must have exactly one input and one output.');
    }

    const input = tensors.tableAt(assertTensorIndex(inputs.at(0), tensors.length, 'input'));
    const output = tensors.tableAt(assertTensorIndex(outputs.at(0), tensors.length, 'output'));
    const inputType = reader.uint8Field(input, 1, TENSOR_TYPE_FLOAT32);
    const outputType = reader.uint8Field(output, 1, TENSOR_TYPE_FLOAT32);
    if (inputType !== TENSOR_TYPE_FLOAT32 || outputType !== TENSOR_TYPE_FLOAT32) {
      throw new WakeWordModelValidationError('Wake-word input and output tensors must use float32.');
    }

    const inputShape = reader.int32Vector(input, 0).toArray();
    const outputShape = reader.int32Vector(output, 0).toArray();
    if (
      inputShape.length !== 3
      || inputShape[0] !== 1
      || inputShape[1] < 1
      || inputShape[1] > MAX_WAKE_INPUT_FRAMES
      || inputShape[2] !== EXPECTED_EMBEDDING_DIMENSION
    ) {
      throw new WakeWordModelValidationError(
        `Wake-word input must have shape [1, frames, ${EXPECTED_EMBEDDING_DIMENSION}] `
        + `with frames between 1 and ${MAX_WAKE_INPUT_FRAMES}.`,
      );
    }
    if (outputShape.length < 1
      || outputShape.length > MAX_WAKE_WORD_SHAPE_DIMENSIONS
      || outputShape.some((dimension) => dimension < 1)
      || elementCount(outputShape) !== 1) {
      throw new WakeWordModelValidationError('Wake-word output must contain exactly one float32 score.');
    }

    return {
      embeddingDimension: EXPECTED_EMBEDDING_DIMENSION,
      featureStack: 'pictaria-openwakeword-v1',
      inputFrames: inputShape[1],
      inputShape,
      outputShape,
      runtime: 'openwakeword',
      schemaVersion,
    };
  } catch (error) {
    if (error instanceof WakeWordModelValidationError) {
      throw error;
    }
    throw new WakeWordModelValidationError(
      `The TensorFlow Lite model structure is unreadable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function assertTensorIndex(value, tensorCount, label) {
  if (!Number.isInteger(value) || value < 0 || value >= tensorCount) {
    throw new WakeWordModelValidationError(`The model's ${label} tensor index is invalid.`);
  }
  return value;
}

function elementCount(shape) {
  return shape.reduce((count, dimension) => count * dimension, 1);
}

class FlatBufferReader {
  constructor(bytes) {
    this.bytes = bytes;
  }

  rootTable() {
    const offset = this.uint32(0);
    this.ensure(offset, 4);
    return offset;
  }

  uint8Field(table, fieldIndex, fallback) {
    const address = this.fieldAddress(table, fieldIndex);
    return address === null ? fallback : this.uint8(address);
  }

  uint32Field(table, fieldIndex, fallback) {
    const address = this.fieldAddress(table, fieldIndex);
    return address === null ? fallback : this.uint32(address);
  }

  tableVector(table, fieldIndex) {
    return new TableVector(this, this.vector(table, fieldIndex));
  }

  int32Vector(table, fieldIndex) {
    return new Int32Vector(this, this.vector(table, fieldIndex));
  }

  vector(table, fieldIndex) {
    const field = this.fieldAddress(table, fieldIndex);
    if (field === null) {
      return { data: 0, length: 0 };
    }
    const vector = field + this.uint32(field);
    const length = this.uint32(vector);
    const data = vector + 4;
    this.ensure(data, length * 4);
    return { data, length };
  }

  fieldAddress(table, fieldIndex) {
    this.ensure(table, 4);
    const vtable = table - this.int32(table);
    this.ensure(vtable, 4);
    const vtableLength = this.uint16(vtable);
    const entry = vtable + 4 + fieldIndex * 2;
    if (entry + 2 > vtable + vtableLength) {
      return null;
    }
    const offset = this.uint16(entry);
    if (offset === 0) {
      return null;
    }
    const address = table + offset;
    this.ensure(address, 1);
    return address;
  }

  tableFromOffset(address) {
    const table = address + this.uint32(address);
    this.ensure(table, 4);
    return table;
  }

  uint8(offset) {
    this.ensure(offset, 1);
    return this.bytes.readUInt8(offset);
  }

  uint16(offset) {
    this.ensure(offset, 2);
    return this.bytes.readUInt16LE(offset);
  }

  uint32(offset) {
    this.ensure(offset, 4);
    return this.bytes.readUInt32LE(offset);
  }

  int32(offset) {
    this.ensure(offset, 4);
    return this.bytes.readInt32LE(offset);
  }

  ensure(offset, length) {
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0
      || offset + length > this.bytes.byteLength) {
      throw new RangeError('FlatBuffer offset is outside the file.');
    }
  }
}

class TableVector {
  constructor(reader, vector) {
    this.reader = reader;
    this.data = vector.data;
    this.length = vector.length;
  }

  tableAt(index) {
    if (!Number.isInteger(index) || index < 0 || index >= this.length) {
      throw new RangeError('FlatBuffer table-vector index is out of range.');
    }
    return this.reader.tableFromOffset(this.data + index * 4);
  }
}

class Int32Vector {
  constructor(reader, vector) {
    this.reader = reader;
    this.data = vector.data;
    this.length = vector.length;
  }

  at(index) {
    if (!Number.isInteger(index) || index < 0 || index >= this.length) {
      throw new RangeError('FlatBuffer integer-vector index is out of range.');
    }
    return this.reader.int32(this.data + index * 4);
  }

  toArray() {
    return Array.from({ length: this.length }, (_, index) => this.at(index));
  }
}
