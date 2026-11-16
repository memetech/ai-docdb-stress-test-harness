import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { JSONFile } from 'lowdb/node';
import { openDatabase, readDatabase, saveAndFlushDatabases, writeDatabase } from '../src/database.js';
import { Metrics } from '../src/metrics.js';

async function fixture(t, count = 3) {
  const directory = await mkdtemp(join(tmpdir(), 'lowdb-cache-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const metrics = new Metrics().start();
  t.after(() => metrics.stop());
  const databases = Array.from({ length: count }, (_, index) => openDatabase(
    join(directory, `file${index + 1}.json`), `file${index + 1}`, metrics,
    { value: index }, { databaseName: `db${index % 2 + 1}` },
  ));
  for (const database of databases) await writeDatabase(database);
  return { metrics, databases };
}

test('used shards save, fsync and evict, aggregate by database, and reload through JSONFile', async t => {
  const { metrics, databases } = await fixture(t, 4);
  const used = databases.slice(0, 3);
  for (const [index, database] of used.entries()) {
    assert.ok(database.db.adapter instanceof JSONFile);
    database.db.data.value = index + 10;
  }
  const unusedData = databases[3].db.data;
  const result = await saveAndFlushDatabases(used);
  assert.deepEqual(result, {
    savedFiles: ['file1', 'file2', 'file3'],
    flushedFiles: ['file1', 'file2', 'file3'],
    evictedFiles: ['file1', 'file2', 'file3'],
  });
  assert.equal(databases[3].db.data, unusedData);
  for (const [index, database] of used.entries()) {
    assert.equal(database.db.data, null);
    assert.deepEqual(JSON.parse(await readFile(database.filename, 'utf8')), { value: index + 10 });
    assert.equal(metrics.files[database.name].save.calls, 2); // initial plus matched-query save
    assert.equal(metrics.files[database.name].flush.calls, 1);
    assert.equal(metrics.files[database.name].evict.calls, 1);
    assert.equal(metrics.files[database.name].evict.fileBytes, 0);
    await readDatabase(database);
    assert.deepEqual(database.db.data, { value: index + 10 });
  }
  assert.equal(metrics.databases.db1.flush.calls, 2);
  assert.equal(metrics.databases.db2.flush.calls, 1);
  assert.equal(metrics.files.file4.flush, undefined);
  assert.equal(metrics.files.file4.evict, undefined);
  assert.equal(metrics.stop().files, metrics.files);
});

test('a failed write preserves all used caches and propagates the original error', async t => {
  const { metrics, databases } = await fixture(t);
  const values = databases.map(database => database.db.data);
  const failure = Object.assign(new Error('write failed'), { code: 'EIO' });
  databases[1].db.write = async () => { throw failure; };
  await assert.rejects(saveAndFlushDatabases(databases), error => error === failure);
  databases.forEach((database, index) => {
    assert.equal(database.db.data, values[index]);
    assert.equal(metrics.files[database.name].evict, undefined);
  });
  assert.equal(metrics.files.file1.flush.calls, 1);
  assert.equal(metrics.files.file2.save.calls, 2);
  assert.equal(metrics.files.file2.flush, undefined);
  assert.equal(metrics.files.file3.save.calls, 1);
});

test('a failed file sync preserves every loaded cache and reports the failure', async t => {
  const { metrics, databases } = await fixture(t, 2);
  const values = databases.map(database => database.db.data);
  const write = databases[1].db.write.bind(databases[1].db);
  databases[1].db.write = async () => {
    await write();
    await rm(databases[1].filename);
  };
  await assert.rejects(saveAndFlushDatabases(databases), { code: 'ENOENT' });
  databases.forEach((database, index) => {
    assert.equal(database.db.data, values[index]);
    assert.equal(metrics.files[database.name].flush.calls, 1);
    assert.equal(metrics.files[database.name].evict, undefined);
  });
});

test('unloaded caches are rejected before any save can silently do nothing', async t => {
  const { metrics, databases } = await fixture(t, 2);
  databases[1].db.data = null;
  await assert.rejects(saveAndFlushDatabases(databases), /file2: cannot save an unloaded database/);
  assert.equal(metrics.files.file1.save.calls, 1);
  assert.equal(metrics.files.file1.flush, undefined);
  assert.equal(metrics.files.file1.evict, undefined);
});
