import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { generateDocument, hammingDistance, makeRandom, KEY_STRIDE } from '../src/data.js';
import { createReference, queryDatabases, sampleBoundaries } from '../src/query.js';
import { Metrics } from '../src/metrics.js';

const fixture = (databaseIndex, seed = 123) => generateDocument({
  databaseIndex, records: 16, sectionBytes: 8192, seed,
});

function fakeDatabase(name, random, hamming, read = async () => {}) {
  return {
    name,
    db: {
      read,
      data: {
        random: { records: random.map(key => ({ key })) },
        hamming: { records: hamming.map((key, rank) => ({ key, rank, value: rank })) },
      },
    },
  };
}

test('sections have exact byte budgets and seeded content is reproducible', () => {
  const document = fixture(0);
  assert.equal(Buffer.byteLength(JSON.stringify(document.random)), 8192);
  assert.equal(Buffer.byteLength(JSON.stringify(document.hamming)), 8192);
  assert.deepEqual(document, fixture(0));
  assert.notDeepEqual(document.random, fixture(0, 124).random);
  const digits = document.random.records.map(record => record.payload).join('');
  assert.match(digits, /^\d+$/);
  assert.equal(new Set(digits).size, 10);
  const cycle = document.hamming.records.map(({ value }) => value.toString(2).padStart(4, '0')).join('');
  assert.ok(document.hamming.records[0].payload.startsWith(cycle));
  assert.match(document.hamming.records[0].payload, /^[01]+$/);
});

test('ordered sections interleave ownership across both files', () => {
  const documents = [fixture(0), fixture(1)];
  for (const [databaseIndex, document] of documents.entries()) {
    for (const [rank, record] of document.random.records.entries()) {
      const slot = (2 * rank + databaseIndex) * KEY_STRIDE;
      assert.ok(record.key >= slot && record.key < slot + KEY_STRIDE - 2);
    }
    for (const [rank, record] of document.hamming.records.entries()) {
      assert.equal(record.key, (2 * rank + 1 - databaseIndex) * KEY_STRIDE + KEY_STRIDE - 2);
    }
  }
  for (const section of ['random', 'hamming']) {
    for (const document of documents) {
      const keys = document[section].records.map(record => record.key);
      assert.ok(keys.every((key, index) => index === 0 || key > keys[index - 1]));
    }
    const owners = documents.flatMap(document => document[section].records.map(({ key }) =>
      ({ key, owner: document.database }))).sort((a, b) => a.key - b.key);
    assert.ok(owners.every((record, index) => index === 0 || record.owner !== owners[index - 1].owner));
  }
});

test('rotated Gray values visit every state and every edge, including wrap, changes one bit', () => {
  const documents = [fixture(0), fixture(1)];
  for (const document of documents) {
    const values = document.hamming.records.map(record => record.value);
    assert.equal(new Set(values).size, 16);
    assert.deepEqual([...values].sort((a, b) => a - b), Array.from({ length: 16 }, (_, i) => i));
    for (let i = 0; i < values.length; i++) {
      assert.equal(hammingDistance(values[i], values[(i + 1) % values.length]), 1);
    }
  }
  assert.deepEqual(documents[0].hamming.records.slice(0, 4).map(record => record.value), [0, 1, 3, 2]);
  assert.deepEqual(documents[1].hamming.records.slice(0, 4).map(record => record.value), [0, 2, 6, 4]);
});

test('10% sampling is reproducible, rounded up, and without replacement', () => {
  const sample = sampleBoundaries(1024, 0.1, makeRandom(45));
  assert.equal(sample.length, 205);
  assert.equal(new Set(sample).size, sample.length);
  assert.deepEqual(sample, sampleBoundaries(1024, 0.1, makeRandom(45)));
  assert.notDeepEqual(sample, sampleBoundaries(1024, 0.1, makeRandom(46)));
  assert.ok(sample.every(boundary => boundary >= KEY_STRIDE - 1 &&
    boundary <= 2048 * KEY_STRIDE - 1 && (boundary + 1) % KEY_STRIDE === 0));
});

test('all generated boundaries return the independently calculated cross-file pair', async () => {
  const documents = [fixture(0), fixture(1)];
  let reads = 0;
  const databases = documents.map(document => ({
    name: document.database,
    db: { data: document, async read() { reads++; } },
  }));
  const reference = createReference(documents);
  const boundaries = sampleBoundaries(16, 1, makeRandom(1));
  for (const boundary of boundaries) {
    const { pair } = await queryDatabases(databases, boundary);
    assert.deepEqual(pair, reference(boundary));
    assert.ok(pair);
    assert.notEqual(pair.random.database, pair.hamming.database);
    assert.ok(pair.random.key < pair.hamming.key && pair.hamming.key < boundary);
  }
  assert.equal(reads, boundaries.length * 2);
});

test('a fast race completion cannot hide the slow database containing the global maximum', async () => {
  const metrics = new Metrics().start();
  let slowCompleted = false;
  try {
    const result = await queryDatabases([
      fakeDatabase('fast', [1], [6]),
      fakeDatabase('slow', [5], [3], async () => {
        await delay(10);
        slowCompleted = true;
      }),
    ], 7, metrics);
    assert.equal(result.firstDatabase, 'fast');
    assert.equal(slowCompleted, true);
    assert.deepEqual(result.pair, {
      random: { database: 'slow', key: 5 },
      hamming: { database: 'fast', key: 6, rank: 0, value: 0 },
    });
    assert.equal(metrics.races.started, 1);
    assert.equal(metrics.races.completed, 1);
    assert.equal(metrics.races.pending, 0);
  } finally {
    metrics.stop();
  }
});

test('failed races drain both rejections and leave no pending work', async () => {
  const metrics = new Metrics().start();
  let slowCompleted = false;
  const first = new Error('first read failed');
  const second = new Error('second read failed');
  try {
    await assert.rejects(queryDatabases([
      fakeDatabase('fast', [1], [2], async () => { throw first; }),
      fakeDatabase('slow', [4], [6], async () => {
        await delay(10);
        slowCompleted = true;
        throw second;
      }),
    ], 7, metrics), error => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(error.errors, [first, second]);
      return true;
    });
    assert.equal(slowCompleted, true);
    assert.deepEqual(metrics.races, { started: 1, completed: 1, pending: 0, peakPending: 1 });
  } finally {
    metrics.stop();
  }
});

test('queries use strict boundaries and select the nearest floor, with explicit no-match results', async () => {
  const databases = [fakeDatabase('db1', [1, 8], [4]), fakeDatabase('db2', [2, 9], [5])];
  assert.deepEqual((await queryDatabases(databases, 8)).pair, {
    random: { database: 'db2', key: 2 },
    hamming: { database: 'db1', key: 4, rank: 0, value: 0 },
  });
  assert.equal((await queryDatabases(databases, 4)).pair, null);
  assert.equal((await queryDatabases(databases, 2)).pair, null);
  assert.equal((await queryDatabases(databases, 1)).pair, null);
  assert.equal((await queryDatabases(databases, 9)).pair, null);
});
