import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Low } from 'lowdb';
import { generateDocument, KEY_STRIDE } from '../src/data.js';
import { openDatabase, readDatabase, saveAndFlushDatabases, writeDatabase } from '../src/database.js';
import { runHarness } from '../src/harness.js';
import { Metrics } from '../src/metrics.js';
import { documentDigest, mutateAfterQuery, verifyPersistedDatabases } from '../src/mutation.js';
import { queryDatabases } from '../src/query.js';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'lowdb-mutation-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const metrics = new Metrics().start();
  t.after(() => metrics.stop());
  const documents = [0, 1].map(databaseIndex => generateDocument({
    databaseIndex, records: 4, sectionBytes: 2048,
  }));
  const databases = [];
  for (const document of documents) {
    const filename = join(directory, `${document.file}.json`);
    await writeDatabase(openDatabase(filename, document.file, metrics, document,
      { databaseName: document.database }));
    databases.push(openDatabase(filename, document.file, metrics, null,
      { databaseName: document.database }));
  }
  const expectedDigests = new Map(documents.map(document => [document.file, documentDigest(document)]));
  return { documents, databases, metrics, expectedDigests };
}

async function queryAndMutate(state, boundary = 2 * KEY_STRIDE - 1) {
  const result = await queryDatabases(state.databases, boundary, state.metrics);
  result.mutation = mutateAfterQuery(state.databases, result.pair, state.expectedDigests);
  return result;
}

const rejectsMismatch = operation => assert.rejects(operation, error => {
  assert.ok(error instanceof AggregateError);
  assert.equal(error.message, 'Post-mutation verification failed');
  assert.match(error.errors[0].message, /persisted data mismatch/);
  return true;
});

test('repeated query mutations accumulate and survive save, eviction and fresh verification', async t => {
  const state = await fixture(t);
  const expected = structuredClone(state.documents);
  for (let count = 1; count <= 3; count++) {
    const result = await queryAndMutate(state);
    assert.equal(result.mutation.before, count - 1);
    assert.equal(result.mutation.after, count);
    const document = expected.find(document => document.file === result.mutation.file);
    document.random.records.find(record => record.key === result.mutation.key).mutationCount = count;
    await saveAndFlushDatabases(state.databases);
    assert.ok(state.databases.every(database => database.db.data === null));
    assert.deepEqual(await verifyPersistedDatabases(state.databases, state.expectedDigests),
      { verifiedFiles: ['file1', 'file2'] });
    for (const [index, database] of state.databases.entries()) {
      const reader = openDatabase(database.filename, database.name);
      await readDatabase(reader);
      assert.deepEqual(reader.db.data, expected[index]);
    }
    assert.equal(state.metrics.races.pending, 0);
  }
});

test('mutation and persistence wait for a gated losing query read', async t => {
  const state = await fixture(t);
  const gate = Promise.withResolvers();
  const fastFinished = Promise.withResolvers();
  const slowStarted = Promise.withResolvers();
  const [fast, slow] = state.databases;
  const fastRead = fast.db.read.bind(fast.db);
  fast.db.read = async () => {
    await fastRead();
    fastFinished.resolve();
  };
  const slowRead = slow.db.read.bind(slow.db);
  slow.db.read = async () => {
    slowStarted.resolve();
    await gate.promise;
    await slowRead();
  };
  let mutationStarted = false;
  const operation = (async () => {
    const result = await queryDatabases(state.databases, 2 * KEY_STRIDE - 1, state.metrics);
    mutationStarted = true;
    result.mutation = mutateAfterQuery(state.databases, result.pair, state.expectedDigests);
    await saveAndFlushDatabases(state.databases);
    await verifyPersistedDatabases(state.databases, state.expectedDigests);
    return result;
  })();
  try {
    await Promise.all([fastFinished.promise, slowStarted.promise]);
    assert.equal(mutationStarted, false);
    assert.equal(state.metrics.races.pending, 1);
    assert.equal(state.metrics.files.file1.save.calls, 1);
    assert.equal(state.metrics.files.file2.save.calls, 1);
    gate.resolve();
    const result = await operation;
    assert.equal(result.firstFile, 'file1');
    assert.equal(result.mutation.file, 'file2');
    assert.equal(result.mutation.after, 1);
    assert.equal(state.metrics.races.pending, 0);
  } finally {
    gate.resolve();
    await operation;
  }
});

test('a silently dropped mutation write is detected after eviction', async t => {
  const state = await fixture(t);
  const result = await queryAndMutate(state);
  const target = state.databases.find(database => database.name === result.mutation.file);
  target.db.write = async () => {};
  await saveAndFlushDatabases(state.databases);
  await rejectsMismatch(verifyPersistedDatabases(state.databases, state.expectedDigests));
  // Verification still visits the other shard and releases both fresh caches.
  for (const database of state.databases) {
    assert.equal(state.metrics.files[database.name].load.calls, 2);
    assert.equal(state.metrics.files[database.name].evict.calls, 2);
  }
});

test('a late stale writer losing a previous update is detected', async t => {
  const state = await fixture(t);
  const first = await queryAndMutate(state);
  await saveAndFlushDatabases(state.databases);
  await verifyPersistedDatabases(state.databases, state.expectedDigests);
  // Take a stale snapshot that contains the first update, then perform another.
  const target = state.databases.find(database => database.name === first.mutation.file);
  const stale = openDatabase(target.filename, target.name);
  await readDatabase(stale);
  await queryAndMutate(state);
  await saveAndFlushDatabases(state.databases);
  await writeDatabase(stale);
  await rejectsMismatch(verifyPersistedDatabases(state.databases, state.expectedDigests));
});

test('a stale query snapshot fails before another mutation or save can hide it', async t => {
  const state = await fixture(t);
  const first = await queryAndMutate(state);
  await saveAndFlushDatabases(state.databases);
  await verifyPersistedDatabases(state.databases, state.expectedDigests);
  const result = await queryDatabases(state.databases, 2 * KEY_STRIDE - 1, state.metrics);
  const target = state.databases.find(database => database.name === first.mutation.file);
  target.db.data = structuredClone(state.documents.find(document => document.file === target.name));
  const expectedBefore = new Map(state.expectedDigests);
  await assert.rejects(async () => mutateAfterQuery(state.databases, result.pair, state.expectedDigests),
    /pre-mutation data mismatch/);
  assert.deepEqual(state.expectedDigests, expectedBefore);
  assert.equal(state.metrics.files[target.name].save.calls, 2);
});

for (const corruption of ['other-shard payload', 'record order', 'metadata', 'null', 'missing', 'truncated']) {
  test(`fresh verification detects ${corruption} corruption`, async t => {
    const state = await fixture(t);
    const result = await queryAndMutate(state);
    await saveAndFlushDatabases(state.databases);
    const other = state.databases.find(database => database.name !== result.mutation.file);
    const document = structuredClone(state.documents.find(document => document.file === other.name));
    switch (corruption) {
      case 'other-shard payload':
        document.hamming.records[0].payload = 'corrupt';
        break;
      case 'record order':
        document.random.records.reverse();
        break;
      case 'metadata':
        document.seed++;
        break;
      case 'null':
        await writeFile(other.filename, 'null');
        break;
      case 'missing':
        await rm(other.filename);
        break;
      case 'truncated':
        await writeFile(other.filename, '{"random":');
        break;
    }
    if (!['null', 'missing', 'truncated'].includes(corruption)) {
      await writeFile(other.filename, JSON.stringify(document));
    }
    if (corruption === 'truncated') {
      await assert.rejects(verifyPersistedDatabases(state.databases, state.expectedDigests), error =>
        error instanceof AggregateError && error.errors[0] instanceof SyntaxError);
    } else {
      await rejectsMismatch(verifyPersistedDatabases(state.databases, state.expectedDigests));
    }
    for (const database of state.databases) {
      assert.equal(state.metrics.files[database.name].load.calls, 2);
      assert.equal(state.metrics.files[database.name].evict.calls, 2);
    }
    assert.equal(state.metrics.races.pending, 0);
  });
}

test('the harness reports a failed query when a successful save silently drops its mutation', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'lowdb-mutation-report-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const write = Low.prototype.write;
  t.mock.method(Low.prototype, 'write', async function () {
    if (this.data?.random?.records.some(record => record.mutationCount)) return;
    await write.call(this);
  });
  const report = await runHarness({
    outputDirectory: directory, databaseCount: 1, fileCount: 1,
    records: 2, sectionBytes: 1024, sampleRate: 0.1,
  });
  assert.equal(report.status, 'failed');
  assert.equal(report.queries.failed, 1);
  assert.equal(report.queries.passed, 0);
  assert.equal(report.queries.mutated, 1);
  assert.equal(report.queries.persisted, 1);
  assert.equal(report.queries.verified, 0);
  assert.equal(report.queries.results[0].status, 'failed');
  assert.match(report.queries.results[0].error, /Post-mutation verification failed/);
  assert.match(report.measurements.errors[0].errors[0].message, /lost update or corruption/);
  assert.equal(report.measurements.races.pending, 0);
  assert.equal(report.cache.retainedFiles, 0);
});
