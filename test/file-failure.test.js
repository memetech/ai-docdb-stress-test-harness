import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Low } from 'lowdb';
import { JSONFile } from 'lowdb/node';
import { openDatabase, readDatabase, writeDatabase } from '../src/database.js';
import { Metrics } from '../src/metrics.js';
import { queryDatabases } from '../src/query.js';

test('JSONFile read sets db.data to null after a previously loaded file is removed (documented contract)', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'docdb-deleted-file-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filename = join(directory, 'db.json');
  const document = { posts: [{ id: 1 }] };
  await writeFile(filename, JSON.stringify(document));
  const db = new Low(new JSONFile(filename), null);
  await db.read();
  assert.deepEqual(db.data, document);

  await rm(filename);
  await db.read();
  assert.equal(db.data, null, 'The documented missing-file behavior must invalidate previously loaded data');
});

test('a malformed JSON read reports its error after the other pending read drains', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'docdb-malformed-file-'));
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
  await writeFile(filenames[0], '{invalid JSON');

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

  const operation = metrics.stage('malformed-file-query', () => queryDatabases(readers, 7, metrics));
  let settled = false;
  const outcome = operation.then(value => ({ value }), error => ({ error })).finally(() => { settled = true; });
  try {
    await failedRead;
    assert.equal(settled, false);
    assert.equal(secondReadFinished, false);
    assert.equal(metrics.races.pending, 1);
    release();
    const result = await outcome;
    assert.ok(result.error instanceof AggregateError, 'A malformed JSON read must fail the query');
    assert.equal(result.error.errors.length, 1);
    assert.ok(result.error.errors[0] instanceof SyntaxError);
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

test('JSONFile read updates db.data to a parsed JSON null value', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'docdb-null-file-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filename = join(directory, 'db1.json');
  const document = { posts: [{ id: 1 }] };
  await writeFile(filename, JSON.stringify(document));
  const db = new Low(new JSONFile(filename), null);
  await db.read();
  assert.deepEqual(db.data, document);
  await writeFile(filename, 'null');
  await db.read();
  assert.equal(db.data, null, 'A successful read should replace the old document with the parsed JSON value');
});
