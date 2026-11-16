import { KEY_STRIDE } from './data.js';
import { readDatabase } from './database.js';

// All raced loads are drained, including failures. The ordered query then
// consumes four cursors across both loaded databases instead of scanning each
// file as a block. Traversal switches below are in memory, not extra file reads.
export async function queryDatabases(databases, boundary, metrics) {
  if (databases.length !== 2 || !Number.isSafeInteger(boundary)) {
    throw new TypeError('A query requires two databases and an integer boundary');
  }
  metrics?.raceStarted();
  try {
    const work = databases.map(async database => {
      const { name, db } = database;
      await readDatabase(database);
      if (!db.data?.random?.records || !db.data?.hamming?.records) {
        throw new Error(`${name}: missing distributions`);
      }
      return { name, random: db.data.random.records, hamming: db.data.hamming.records };
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
    const cursors = snapshots.flatMap(snapshot => ['random', 'hamming'].map(section => ({
      name: snapshot.name, section, records: snapshot[section], index: 0,
    })));
    const traversal = {
      steps: 0, databaseSwitches: 0,
      visits: Object.fromEntries(snapshots.map(({ name }) => [name, { random: 0, hamming: 0 }])),
      firstDatabase: null, lastDatabase: null, preview: [], previewTruncated: false,
    };
    let random = null;
    let hamming = null;

    while (true) {
      let next = null;
      for (const cursor of cursors) {
        const record = cursor.records[cursor.index];
        if (record && (!next || record.key < next.records[next.index].key)) next = cursor;
      }
      if (!next || next.records[next.index].key >= boundary) break;
      const record = next.records[next.index++];
      traversal.steps++;
      traversal.visits[next.name][next.section]++;
      if (traversal.lastDatabase !== null && traversal.lastDatabase !== next.name) {
        traversal.databaseSwitches++;
      }
      traversal.firstDatabase ??= next.name;
      traversal.lastDatabase = next.name;
      if (traversal.preview.length < 16) {
        traversal.preview.push({ database: next.name, section: next.section, key: record.key });
      } else {
        traversal.previewTruncated = true;
      }

      if (next.section === 'random') {
        random = { database: next.name, key: record.key };
        hamming = null;
      } else if (random && record.key > random.key && !hamming) {
        hamming = { database: next.name, key: record.key, rank: record.rank, value: record.value };
      }
    }
    return {
      boundary, pair: random && hamming ? { random, hamming } : null,
      firstDatabase: databases[first.index].name,
      traversal,
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
