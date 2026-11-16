import { KEY_STRIDE } from './data.js';

// All raced work is drained, including failures: a fast file is not necessarily
// the file containing the global predecessor or its nearest Hamming floor.
export async function queryDatabases(databases, boundary, metrics) {
  if (databases.length !== 2 || !Number.isSafeInteger(boundary)) {
    throw new TypeError('A query requires two databases and an integer boundary');
  }
  metrics?.raceStarted();
  try {
    const work = databases.map(async ({ name, db }) => {
      await db.read();
      if (!db.data?.random?.records || !db.data?.hamming?.records) {
        throw new Error(`${name}: missing distributions`);
      }
      let predecessor = null;
      for (const record of db.data.random.records) {
        if (record.key < boundary && (predecessor === null || record.key > predecessor.key)) {
          predecessor = { database: name, key: record.key };
        }
      }
      return { name, predecessor, hamming: db.data.hamming.records };
    });
    // Convert rejections to results before racing so every failure is observed.
    const observed = work.map((promise, index) => promise.then(
      value => ({ index, value }), error => ({ index, error }),
    ));
    const first = await Promise.race(observed);
    const results = await Promise.all(observed);
    const errors = results.filter(result => 'error' in result).map(result => result.error);
    if (errors.length) throw new AggregateError(errors, 'Database query failed');
    const snapshots = results.map(result => result.value);
    const random = snapshots.map(result => result.predecessor)
      .filter(Boolean).reduce((best, record) => !best || record.key > best.key ? record : best, null);
    let hamming = null;
    if (random) {
      for (const snapshot of snapshots) {
        for (const record of snapshot.hamming) {
          if (random.key < record.key && record.key < boundary &&
              (!hamming || record.key < hamming.key)) {
            hamming = { database: snapshot.name, key: record.key, rank: record.rank, value: record.value };
          }
        }
      }
    }
    return {
      boundary, pair: random && hamming ? { random, hamming } : null,
      firstDatabase: databases[first.index].name,
    };
  } finally {
    metrics?.raceSettled();
  }
}

// Reference works on the original generated documents, never lowdb's query
// snapshots, and uses sorted lookup rather than the production scans.
export function createReference(documents) {
  const random = documents.flatMap(document => document.random.records.map(({ key }) =>
    ({ database: document.database, key }))).sort((a, b) => a.key - b.key);
  const hamming = documents.flatMap(document => document.hamming.records.map(({ key, rank, value }) =>
    ({ database: document.database, key, rank, value }))).sort((a, b) => a.key - b.key);
  return boundary => {
    const r = random.findLast(record => record.key < boundary);
    const h = r && hamming.find(record => r.key < record.key && record.key < boundary);
    return r && h ? { random: r, hamming: h } : null;
  };
}

export function sampleBoundaries(records, rate, random) {
  const boundaries = Array.from({ length: records * 2 }, (_, index) => (index + 1) * KEY_STRIDE - 1);
  for (let i = boundaries.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [boundaries[i], boundaries[j]] = [boundaries[j], boundaries[i]];
  }
  return boundaries.slice(0, Math.ceil(boundaries.length * rate));
}
