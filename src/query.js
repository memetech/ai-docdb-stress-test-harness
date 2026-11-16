import { KEY_STRIDE } from './data.js';
import { readDatabase } from './database.js';

// A stable heap merges two ordered streams per file without scanning every
// cursor for every row. Ties retain file order, then random before Hamming.
class CursorHeap {
  items = [];

  before(a, b) {
    const difference = a.records[a.index].key - b.records[b.index].key;
    return difference < 0 || (difference === 0 && a.order < b.order);
  }

  push(cursor) {
    const items = this.items;
    items.push(cursor);
    let index = items.length - 1;
    while (index > 0) {
      const parent = (index - 1) >>> 1;
      if (!this.before(items[index], items[parent])) break;
      [items[parent], items[index]] = [items[index], items[parent]];
      index = parent;
    }
  }

  pop() {
    const items = this.items;
    const first = items[0];
    const last = items.pop();
    if (items.length) {
      items[0] = last;
      let index = 0;
      while (true) {
        const left = index * 2 + 1;
        const right = left + 1;
        let smallest = index;
        if (left < items.length && this.before(items[left], items[smallest])) smallest = left;
        if (right < items.length && this.before(items[right], items[smallest])) smallest = right;
        if (smallest === index) break;
        [items[index], items[smallest]] = [items[smallest], items[index]];
        index = smallest;
      }
    }
    return first;
  }
}

// Queue reads rather than opening an unbounded number of files. Every outcome
// fulfills, so the race observes actual completion and all failures are drained.
function startReads(databases, concurrency) {
  const completions = [];
  const observed = databases.map(() => new Promise(resolve => completions.push(resolve)));
  let queued = 0;
  const workers = Array.from({ length: Math.min(concurrency, databases.length) }, async () => {
    while (queued < databases.length) {
      const index = queued++;
      const database = databases[index];
      try {
        await readDatabase(database);
        if (!Array.isArray(database.db.data?.random?.records) ||
            !Array.isArray(database.db.data?.hamming?.records)) {
          throw new Error(`${database.name}: missing distributions`);
        }
        completions[index]({ index, value: {
          name: database.name,
          databaseName: database.databaseName ?? database.name,
          includeFile: database.databaseName !== undefined,
          random: database.db.data.random.records,
          hamming: database.db.data.hamming.records,
        } });
      } catch (error) {
        completions[index]({ index, error });
      }
    }
  });
  return { observed, workers };
}

const provenance = snapshot => ({
  database: snapshot.databaseName,
  ...(snapshot.includeFile ? { file: snapshot.name } : {}),
});

// Standard lowdb loads race, then all settle before the global ordered query.
// Traversal switches are in memory. Saving/flushing consulted files is a
// separate operation so the harness can validate the match before persisting.
export async function queryDatabases(databases, boundary, metrics, { readConcurrency = 8 } = {}) {
  if (!Array.isArray(databases) || databases.length === 0 || !Number.isSafeInteger(boundary)) {
    throw new TypeError('A query requires at least one database file and an integer boundary');
  }
  if (databases.some(database => typeof database.name !== 'string' || !database.name) ||
      new Set(databases.map(database => database.name)).size !== databases.length) {
    throw new TypeError('Database file names must be nonempty and unique');
  }
  if (!Number.isSafeInteger(readConcurrency) || readConcurrency < 1) {
    throw new RangeError('readConcurrency must be a positive safe integer');
  }
  metrics?.raceStarted();
  try {
    const { observed, workers } = startReads(databases, readConcurrency);
    const first = await Promise.race(observed);
    await Promise.all(workers);
    const results = await Promise.all(observed);
    const errors = results.filter(result => 'error' in result).map(result => result.error);
    if (errors.length) throw new AggregateError(errors, 'Database query failed');
    const snapshots = results.map(result => result.value);
    const heap = new CursorHeap();
    const traversal = {
      steps: 0, databaseSwitches: 0, fileSwitches: 0,
      visits: {}, fileVisits: {},
      firstDatabase: null, lastDatabase: null, firstFile: null, lastFile: null,
      preview: [], previewTruncated: false,
    };
    snapshots.forEach((snapshot, fileIndex) => {
      traversal.visits[snapshot.databaseName] ??= { random: 0, hamming: 0 };
      traversal.fileVisits[snapshot.name] = { random: 0, hamming: 0 };
      ['random', 'hamming'].forEach((section, sectionIndex) => {
        if (snapshot[section].length) heap.push({
          snapshot, section, records: snapshot[section], index: 0, order: fileIndex * 2 + sectionIndex,
        });
      });
    });
    let random = null;
    let hamming = null;

    while (heap.items.length && heap.items[0].records[heap.items[0].index].key < boundary) {
      const cursor = heap.pop();
      const { snapshot, section } = cursor;
      const record = cursor.records[cursor.index++];
      if (cursor.index < cursor.records.length) heap.push(cursor);
      traversal.steps++;
      traversal.visits[snapshot.databaseName][section]++;
      traversal.fileVisits[snapshot.name][section]++;
      if (traversal.lastDatabase !== null && traversal.lastDatabase !== snapshot.databaseName) {
        traversal.databaseSwitches++;
      }
      if (traversal.lastFile !== null && traversal.lastFile !== snapshot.name) traversal.fileSwitches++;
      traversal.firstDatabase ??= snapshot.databaseName;
      traversal.lastDatabase = snapshot.databaseName;
      traversal.firstFile ??= snapshot.name;
      traversal.lastFile = snapshot.name;
      if (traversal.preview.length < 16) {
        traversal.preview.push({ ...provenance(snapshot), section, key: record.key });
      } else {
        traversal.previewTruncated = true;
      }

      if (section === 'random') {
        random = { ...provenance(snapshot), key: record.key };
        hamming = null;
      } else if (random && record.key > random.key && !hamming) {
        hamming = { ...provenance(snapshot), key: record.key, rank: record.rank, value: record.value };
      }
    }
    return {
      boundary, pair: random && hamming ? { random, hamming } : null,
      firstDatabase: snapshots[first.index].databaseName,
      firstFile: snapshots[first.index].name,
      usedFiles: snapshots.map(snapshot => snapshot.name),
      traversal,
    };
  } finally {
    metrics?.raceSettled();
  }
}

// Reference works on the original generated documents, never lowdb's query
// snapshots, and uses sorted lookup rather than the production scans.
export function createReference(documents) {
  const source = document => ({
    database: document.database,
    ...(document.formatVersion >= 3 && document.file ? { file: document.file } : {}),
  });
  const random = documents.flatMap(document => document.random.records.map(({ key }) =>
    ({ ...source(document), key }))).sort((a, b) => a.key - b.key);
  const hamming = documents.flatMap(document => document.hamming.records.map(({ key, rank, value }) =>
    ({ ...source(document), key, rank, value }))).sort((a, b) => a.key - b.key);
  return boundary => {
    const r = random.findLast(record => record.key < boundary);
    const h = r && hamming.find(record => r.key < record.key && record.key < boundary);
    return r && h ? { random: r, hamming: h } : null;
  };
}

export function sampleBoundaries(records, rate, random, fileCount = 2) {
  if (!Number.isSafeInteger(records) || records < 1 || !Number.isSafeInteger(fileCount) || fileCount < 1 ||
      !Number.isSafeInteger(records * fileCount) || records * fileCount > Math.floor(Number.MAX_SAFE_INTEGER / KEY_STRIDE)) {
    throw new RangeError('Sample population must fit positive safe integer file and record counts');
  }
  if (!Number.isFinite(rate) || rate <= 0 || rate > 1 || typeof random !== 'function') {
    throw new RangeError('Sampling requires a fraction greater than zero and at most one, and a random function');
  }
  const boundaries = Array.from({ length: records * fileCount }, (_, index) => (index + 1) * KEY_STRIDE - 1);
  for (let i = boundaries.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [boundaries[i], boundaries[j]] = [boundaries[j], boundaries[i]];
  }
  return boundaries.slice(0, Math.ceil(boundaries.length * rate));
}
