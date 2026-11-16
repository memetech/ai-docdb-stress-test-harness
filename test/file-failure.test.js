import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { openDatabase, readDatabase, writeDatabase } from '../src/database.js';
import { Metrics } from '../src/metrics.js';
import { queryDatabases } from '../src/query.js';

test('a deleted file cannot reuse loaded data, and a failed race drains the other real read', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'docdb-deleted-file-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const metrics = new Metrics().start();
  t.after(() => metrics.stop());
  const documents = [
    { random: { records: [{ key: 1 }] }, hamming: { records: [{ key: 6, rank: 0, value: 0 }] } },
    { random: { records: [{ key: 5 }] }, hamming: { records: [{ key: 3, rank: 0, value: 0 }] } },
  ];
  const filenames = documents.map((_, index) => join(directory, `db${index + 1}.json`));
  for (const [index, document] of documents.entries()) {
    await writeDatabase(openDatabase(filenames[index], `db${index + 1}`, metrics, document));
  }
  const readers = filenames.map((filename, index) => openDatabase(filename, `db${index + 1}`, metrics));
  await Promise.all(readers.map(reader => readDatabase(reader)));
  assert.deepEqual(readers.map(({ db }) => db.data), documents);
  await rm(filenames[0]);

  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let failedReadFinished;
  const failedRead = new Promise(resolve => { failedReadFinished = resolve; });
  const firstRead = readers[0].db.read.bind(readers[0].db);
  readers[0].db.read = async () => {
    try {
      await firstRead();
    } finally {
      failedReadFinished();
    }
  };
  const secondRead = readers[1].db.read.bind(readers[1].db);
  let secondReadFinished = false;
  readers[1].db.read = async () => {
    await gate;
    await secondRead();
    secondReadFinished = true;
  };

  const operation = metrics.stage('missing-file-query', () => queryDatabases(readers, 7, metrics));
  let settled = false;
  const outcome = operation.then(value => ({ value }), error => ({ error })).finally(() => { settled = true; });
  try {
    await failedRead;
    assert.equal(settled, false);
    assert.equal(secondReadFinished, false);
    assert.equal(metrics.races.pending, 1);
    release();
    const result = await outcome;
    assert.ok(result.error instanceof AggregateError, 'A missing file must fail despite cached lowdb data');
    assert.equal(result.error.errors.length, 1);
    assert.equal(secondReadFinished, true);
    assert.deepEqual(metrics.races, { started: 1, completed: 1, pending: 0, peakPending: 1 });
    assert.equal(metrics.databases.db1.load.calls, 2);
    assert.equal(metrics.databases.db2.load.calls, 2);
    const report = metrics.stop();
    assert.equal(report.errors.length, 1);
    assert.equal(report.stages[0].status, 'failed');
  } finally {
    release();
    await outcome;
  }
});

test('a null JSON document cannot reuse a prior successful lowdb read', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'docdb-null-file-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const metrics = new Metrics().start();
  t.after(() => metrics.stop());
  const filename = join(directory, 'db1.json');
  await writeFile(filename, JSON.stringify({ random: { records: [{ key: 1 }] }, hamming: { records: [] } }));
  const reader = openDatabase(filename, 'db1', metrics);
  await readDatabase(reader);
  await writeFile(filename, 'null');
  await assert.rejects(readDatabase(reader), Error);
  assert.equal(metrics.databases.db1.load.calls, 2);
});
