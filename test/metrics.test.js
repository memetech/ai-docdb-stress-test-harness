import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { openDatabase } from '../src/database.js';
import { Metrics } from '../src/metrics.js';

test('metrics observe real adapter IO, errors, memory and drained races over time', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'docdb-metrics-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const metrics = new Metrics({ sampleIntervalMs: 1 }).start();
  t.after(() => metrics.stop());
  const filename = join(directory, 'db1.json');
  const document = { numbers: Array.from({ length: 4096 }, (_, index) => index) };
  const writer = openDatabase(filename, 'db1', metrics, document);
  await metrics.stage('save', () => writer.db.write());

  const readers = [0, 1].map(() => openDatabase(filename, 'db1', metrics));
  await metrics.stage('race', async () => {
    metrics.raceStarted();
    const reads = readers.map(async ({ db }) => {
      await db.read();
      assert.deepEqual(db.data, document);
    });
    try {
      await Promise.race(reads);
    } finally {
      await Promise.allSettled(reads);
      metrics.raceSettled();
    }
    await setTimeout(8);
  });

  // A failed read still counts as an adapter invocation and a failed stage.
  await writeFile(filename, '{invalid JSON');
  await assert.rejects(metrics.stage('corrupt-load', () => readers[0].db.read()), SyntaxError);
  const report = metrics.stop();
  assert.equal(metrics.stop(), report);
  assert.equal(report.errors.length, 1);
  assert.equal(report.errors[0].name, 'SyntaxError');
  assert.deepEqual(report.stages.map(({ name, status }) => ({ name, status })), [
    { name: 'save', status: 'passed' },
    { name: 'race', status: 'passed' },
    { name: 'corrupt-load', status: 'failed' },
  ]);
  assert.deepEqual(report.races, { started: 1, completed: 1, pending: 0, peakPending: 1 });
  assert.equal(report.databases.db1.save.calls, 1);
  assert.equal(report.databases.db1.load.calls, 3);
  const serializedBytes = Buffer.byteLength(JSON.stringify(document));
  assert.equal(report.databases.db1.save.bytes, serializedBytes);
  assert.equal(report.databases.db1.load.bytes, serializedBytes * 2 + Buffer.byteLength('{invalid JSON'));
  assert.ok(report.databases.db1.save.durationMs >= 0);
  assert.ok(report.databases.db1.load.durationMs >= 0);

  assert.equal(report.samples[0].reason, 'start');
  assert.equal(report.samples.at(-1).reason, 'stop');
  assert.ok(report.samples.some(({ reason }) => reason === 'interval'));
  assert.ok(report.samples.some(({ reason, pendingRaces }) =>
    reason === 'database:db1:load' && pendingRaces === 1));
  for (let index = 0; index < report.samples.length; index++) {
    const sample = report.samples[index];
    assert.ok(sample.memory.rss > 0);
    assert.ok(sample.memory.heapUsed > 0);
    assert.ok(sample.memory.rss <= report.memory.peak.rss);
    assert.ok(sample.memory.heapUsed <= report.memory.peak.heapUsed);
    assert.ok(Number.isFinite(sample.io.resourceUsage.fsRead));
    assert.ok(Number.isFinite(sample.io.resourceUsage.fsWrite));
    if (index) assert.ok(sample.elapsedMs >= report.samples[index - 1].elapsedMs);
  }
  if (report.io.delta.linux) {
    assert.ok(report.io.delta.linux.rchar > 0);
    assert.ok(report.io.delta.linux.wchar >= serializedBytes);
    assert.ok(report.io.delta.linux.syscr > 0);
    assert.ok(report.io.delta.linux.syscw > 0);
  }
  assert.ok(report.durationMs >= report.stages.reduce((sum, stage) => sum + stage.durationMs, 0));
});

test('aggregate failures preserve underlying database error details', () => {
  const metrics = new Metrics().start();
  metrics.recordError(new AggregateError([
    Object.assign(new Error('db1: database file is missing'), { code: 'ENOENT' }),
    new SyntaxError('db2: invalid JSON'),
  ], 'Database query failed'));
  const { errors } = metrics.stop();
  assert.equal(errors[0].errors[0].code, 'ENOENT');
  assert.equal(errors[0].errors[0].message, 'db1: database file is missing');
  assert.equal(errors[0].errors[1].name, 'SyntaxError');
});
