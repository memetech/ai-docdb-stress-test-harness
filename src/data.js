export const DEFAULT_SECTION_BYTES = 5 * 1024 * 1024;
export const DEFAULT_RECORDS = 1024;
export const KEY_STRIDE = 2 ** 20;

/** A repeatable uniform PRNG. The returned function produces numbers in [0, 1). */
export function makeRandom(seed = 0x5eed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

export function hammingDistance(a, b) {
  let value = (a ^ b) >>> 0;
  let distance = 0;
  while (value !== 0) {
    value &= value - 1;
    distance += 1;
  }
  return distance;
}

function rotate(value, shift, bits) {
  const mask = (1 << bits) - 1;
  return ((value << shift) | (value >>> (bits - shift))) & mask;
}

function randomDigits(length, random) {
  const bytes = Buffer.allocUnsafe(length);
  for (let index = 0; index < length; index += 1) {
    bytes[index] = 48 + Math.floor(random() * 10);
  }
  return bytes.toString('ascii');
}

export function validateLayout(databaseCount, fileCount) {
  if (!Number.isSafeInteger(databaseCount) || databaseCount < 1) {
    throw new RangeError('databaseCount must be a positive safe integer');
  }
  if (!Number.isSafeInteger(fileCount) || fileCount < databaseCount) {
    throw new RangeError('fileCount must be a safe integer at least databaseCount');
  }
  return { databaseCount, fileCount };
}

function cycleValue(rank, half, railBit) {
  const index = rank < half ? rank : 2 * half - 1 - rank;
  return (index ^ (index >>> 1)) | (rank < half ? 0 : railBit);
}

// Reflect any length of Gray-code path onto a second bit rail. This closes a
// one-bit cycle for every even length, including non-power-of-two file counts.
export function grayValue(rank, length) {
  if (!Number.isSafeInteger(length) || length < 2 || length > 2 ** 30 || length % 2 !== 0) {
    throw new RangeError('Gray cycle length must be even and between 2 and 1073741824');
  }
  if (!Number.isSafeInteger(rank) || rank < 0 || rank >= length) {
    throw new RangeError('Gray rank must be within the cycle');
  }
  const half = length / 2;
  return cycleValue(rank, half, 2 ** Math.ceil(Math.log2(half)));
}

function cyclicPayload(startRank, length, cycleLength, bits, rotation) {
  const half = cycleLength / 2;
  const railBit = 2 ** Math.ceil(Math.log2(half));
  const chunks = [];
  for (let index = 0; index < Math.ceil(length / bits); index += 1) {
    const rank = (startRank + index) % cycleLength;
    chunks.push(rotate(cycleValue(rank, half, railBit), rotation, bits)
      .toString(2).padStart(bits, '0'));
  }
  return chunks.join('').slice(0, length);
}

function fillSection(section, targetBytes, payload) {
  const emptyBytes = Buffer.byteLength(JSON.stringify(section));
  const available = targetBytes - emptyBytes;
  if (available < 0) {
    throw new RangeError(`sectionBytes must be at least ${emptyBytes} for these records`);
  }
  const base = Math.floor(available / section.records.length);
  const remainder = available % section.records.length;
  for (let index = 0; index < section.records.length; index += 1) {
    section.records[index].payload = payload(base + (index < remainder ? 1 : 0), index);
  }
  return section;
}

/**
 * Each JSON section occupies exactly sectionBytes. Records are ordered by key;
 * Gray-code values follow their rank, since sorting the values would break the
 * minimum-distance cycle. Each shard owns interleaved ranks of the same cycle,
 * with the Hamming ownership shifted one file to force cross-file pairs.
 */
export function generateDocument({
  databaseIndex,
  databaseCount = 2,
  fileIndex = databaseIndex,
  fileCount = databaseCount,
  sectionBytes = DEFAULT_SECTION_BYTES,
  records = DEFAULT_RECORDS,
  seed = 0x5eed,
} = {}) {
  validateLayout(databaseCount, fileCount);
  if (!Number.isSafeInteger(fileIndex) || fileIndex < 0 || fileIndex >= fileCount) {
    throw new RangeError('fileIndex must be within fileCount');
  }
  if (!Number.isSafeInteger(databaseIndex) || databaseIndex < 0 || databaseIndex >= databaseCount
      || databaseIndex !== fileIndex % databaseCount) {
    throw new RangeError('databaseIndex must equal fileIndex modulo databaseCount');
  }
  if (!Number.isSafeInteger(records) || records < 2 || records > 2 ** 20
      || (records & (records - 1)) !== 0) {
    throw new RangeError('records must be a power of two between 2 and 1048576');
  }
  if (!Number.isSafeInteger(sectionBytes) || sectionBytes <= 0) {
    throw new RangeError('sectionBytes must be a positive safe integer');
  }
  if (!Number.isSafeInteger(seed)) {
    throw new RangeError('seed must be a safe integer');
  }

  const globalCycleLength = records * fileCount;
  if (!Number.isSafeInteger(globalCycleLength) || globalCycleLength > 2 ** 30) {
    throw new RangeError('records multiplied by fileCount must be at most 1073741824');
  }
  const random = makeRandom((seed ^ Math.imul(fileIndex + 1, 0x9e3779b1)) >>> 0);
  const cycleBits = Math.ceil(Math.log2(globalCycleLength / 2)) + 1;
  const rotation = (seed >>> 0) % cycleBits;
  const rankOffset = (fileIndex + fileCount - 1) % fileCount;
  const randomRecords = [];
  const hammingRecords = [];
  for (let index = 0; index < records; index += 1) {
    randomRecords.push({
      key: (fileCount * index + fileIndex) * KEY_STRIDE
        + Math.floor(random() * (KEY_STRIDE - 2)),
      payload: '',
    });
    const rank = fileCount * index + rankOffset;
    hammingRecords.push({
      key: (rank + 1) * KEY_STRIDE - 2,
      rank,
      value: rotate(grayValue(rank, globalCycleLength), rotation, cycleBits),
      payload: '',
    });
  }
  const randomSection = fillSection({ records: randomRecords }, sectionBytes,
    (length) => randomDigits(length, random));
  const hammingSection = fillSection({
    cycleBits, rotation, globalCycleLength, rankOffset, rankStride: fileCount,
    ...(fileCount === 2 ? { rankParity: rankOffset } : {}), records: hammingRecords,
  }, sectionBytes, (length, index) =>
    cyclicPayload(hammingRecords[index].rank, length, globalCycleLength, cycleBits, rotation));

  return {
    formatVersion: 3,
    database: `db${databaseIndex + 1}`,
    file: `file${fileIndex + 1}`,
    fileIndex,
    fileCount,
    databaseCount,
    recordsPerSection: records,
    sectionBytes,
    seed: seed >>> 0,
    random: randomSection,
    hamming: hammingSection,
  };
}
