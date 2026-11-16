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

function cyclicPayload(cycle, start, length) {
  if (length === 0) return '';
  const offset = start % cycle.length;
  return cycle.repeat(Math.ceil((length + offset) / cycle.length))
    .slice(offset, offset + length);
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
 * minimum-distance cycle. Opposite Hamming ownership forces cross-file pairs.
 */
export function generateDocument({
  databaseIndex,
  sectionBytes = DEFAULT_SECTION_BYTES,
  records = DEFAULT_RECORDS,
  seed = 0x5eed,
} = {}) {
  if (databaseIndex !== 0 && databaseIndex !== 1) {
    throw new RangeError('databaseIndex must be 0 or 1');
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

  const random = makeRandom((seed ^ Math.imul(databaseIndex + 1, 0x9e3779b1)) >>> 0);
  const cycleBits = Math.log2(records);
  const rotation = databaseIndex % cycleBits;
  const randomRecords = [];
  const hammingRecords = [];
  for (let rank = 0; rank < records; rank += 1) {
    randomRecords.push({
      key: (2 * rank + databaseIndex) * KEY_STRIDE
        + Math.floor(random() * (KEY_STRIDE - 2)),
      payload: '',
    });
    hammingRecords.push({
      key: (2 * rank + 1 - databaseIndex) * KEY_STRIDE + KEY_STRIDE - 2,
      rank,
      value: rotate(rank ^ (rank >>> 1), rotation, cycleBits),
      payload: '',
    });
  }
  const cycle = hammingRecords.map(({ value }) => value.toString(2).padStart(cycleBits, '0')).join('');
  const randomSection = fillSection({ records: randomRecords }, sectionBytes,
    (length) => randomDigits(length, random));
  const hammingSection = fillSection({ cycleBits, rotation, records: hammingRecords }, sectionBytes,
    (length, index) => cyclicPayload(cycle, index * cycleBits, length));

  return {
    formatVersion: 1,
    database: `db${databaseIndex + 1}`,
    recordsPerSection: records,
    sectionBytes,
    seed: seed >>> 0,
    random: randomSection,
    hamming: hammingSection,
  };
}
