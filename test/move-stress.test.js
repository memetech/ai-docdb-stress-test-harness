import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { runHarness } from '../src/harness.js';

async function outputDirectory(t) {
  const directory = await mkdtemp(join(tmpdir(), 'lowdb-shard-move-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('a copied and removed shard reproduces stale cached reads inside the stress run', async t => {
  const report = await runHarness({
    outputDirectory: await outputDirectory(t), records: 16, sectionBytes: 8192,
    sampleRate: 1, readConcurrency: 1,
    fault: 'move-shard', faultQuery: 3, faultFile: 'file1', faultDestination: 'db2',
  });
  assert.equal(report.status, 'failed');
  const fault = report.fault;
  assert.equal(fault.type, 'move-shard');
  assert.equal(fault.query, 3);
  assert.equal(fault.file, 'file1');
  assert.equal(fault.sourceDatabase, 'db1');
  assert.equal(fault.destinationDatabase, 'db2');
  assert.equal(fault.status, 'reproduced-stale-cache');
  assert.equal(fault.cacheWarm, true);
  assert.equal(fault.sourceCacheRetained, true);
  assert.equal(fault.sourceFileExists, false);
  assert.equal(fault.destinationVerified, true);
  assert.equal(fault.queryOutcome, 'resolved');
  assert.equal(fault.referenceMatched, true,
    'Stale data can still return the correct original pair; it must not conceal the invalid-file read');
  assert.equal(fault.reproduced, true);
  assert.equal(report.queries.selected, 32);
  assert.equal(report.queries.attempted, 3);
  assert.equal(report.queries.completed, 3);
  assert.equal(report.queries.passed, 2);
  assert.equal(report.queries.persisted, 2);
  assert.equal(report.queries.failed, 1);
  assert.equal(report.queries.unrun, 29);
  assert.equal(report.measurements.races.started, 3);
  assert.equal(report.measurements.races.completed, 3);
  assert.equal(report.measurements.races.pending, 0);
  assert.ok(report.measurements.errors.some(error => error.code === 'STALE_SHARD_CACHE'));

  for (const file of ['file1', 'file2']) {
    const counts = report.measurements.files[file];
    assert.equal(counts.save.calls, 3, 'Only creation and the two pre-fault matches may save');
    assert.equal(counts.flush.calls, 2);
    assert.equal(counts.evict.calls, 2);
  }
  assert.equal(report.measurements.files.file1.load.calls, 5,
    'The source must be explicitly warmed again after prior matches evicted their caches');
  assert.equal(report.measurements.files.file2.load.calls, 4);
  assert.equal(report.cache.retainedFiles, 2);
  assert.equal(report.queries.results.at(-1).status, 'failed');
  assert.equal(report.queries.results.at(-1).persistence, undefined);

  await assert.rejects(stat(fault.sourceFilename), error => error.code === 'ENOENT');
  const copied = await readFile(fault.destinationFilename);
  assert.equal(copied.length, fault.bytes);
  assert.equal(createHash('sha256').update(copied).digest('hex'), fault.sha256);
  const original = report.documents.find(document => document.file === 'file1');
  assert.equal(original.filename, fault.sourceFilename);
  assert.equal(createHash('sha256').update(JSON.stringify(JSON.parse(copied))).digest('hex'), original.sha256);
  assert.equal(JSON.parse(copied).database, 'db1', 'The injection copies bytes without rewriting metadata');
  assert.deepEqual(JSON.parse(await readFile(report.reportPath, 'utf8')), report);
});

test('the default move happens at the last sampled query after all earlier queries persist', async t => {
  const report = await runHarness({
    outputDirectory: await outputDirectory(t), records: 2, sectionBytes: 4096,
    sampleRate: 1, fault: 'move-shard',
  });
  assert.equal(report.fault.query, 4);
  assert.equal(report.fault.file, 'file1');
  assert.equal(report.fault.destinationDatabase, 'db2');
  assert.equal(report.fault.reproduced, true);
  assert.equal(report.queries.completed, report.queries.selected);
  assert.equal(report.queries.passed, 3);
  assert.equal(report.queries.failed, 1);
  assert.equal(report.queries.unrun, 0);
  assert.equal(report.measurements.races.pending, 0);
});

test('the CLI exposes shard relocation and exits unsuccessfully while preserving the fault evidence', async t => {
  const exec = promisify(execFile);
  let failure;
  try {
    await exec(process.execPath, ['src/cli.js',
      '--out', await outputDirectory(t), '--databases', '3', '--files', '5',
      '--records', '4', '--section-mib', '0.01', '--sample-rate', '1',
      '--fault', 'move-shard', '--fault-query', '2', '--fault-file', 'file3',
      '--fault-destination', 'db1', '--read-concurrency', '2']);
  } catch (error) {
    failure = error;
  }
  assert.ok(failure, 'The fault run must not be reported as successful');
  assert.equal(failure.code, 1);
  assert.match(failure.stdout, /FAILED: 1\/20 sampled queries passed/);
  const reportPath = /^Report: (.+)$/m.exec(failure.stdout)?.[1];
  assert.ok(reportPath, 'Even an unsuccessful run must publish its local report path');
  const report = JSON.parse(await readFile(reportPath, 'utf8'));
  assert.equal(report.fault.file, 'file3');
  assert.equal(report.fault.sourceDatabase, 'db3');
  assert.equal(report.fault.destinationDatabase, 'db1');
  assert.equal(report.fault.reproduced, true);
  assert.equal(report.queries.unrun, 18);
  assert.equal(report.measurements.races.pending, 0);
  await assert.rejects(stat(report.fault.sourceFilename), error => error.code === 'ENOENT');
  assert.ok((await stat(report.fault.destinationFilename)).isFile());
});

test('invalid shard-move targets and schedules are rejected', async t => {
  const directory = await outputDirectory(t);
  for (const options of [
    { databaseCount: 1, fileCount: 1 },
    { faultFile: 'file3' },
    { faultFile: '../file1' },
    { faultDestination: 'db1' },
    { faultDestination: 'db3' },
    { faultQuery: 0 },
    { faultQuery: 33 },
  ]) {
    await assert.rejects(runHarness({
      outputDirectory: directory, records: 16, sectionBytes: 8192, sampleRate: 1,
      fault: 'move-shard', ...options,
    }), /fault|shard|database|query/i);
  }
});
