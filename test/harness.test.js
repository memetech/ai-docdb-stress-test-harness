import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runHarness } from '../src/harness.js';
import { generateDocument } from '../src/data.js';

const digest = document => createHash('sha256').update(JSON.stringify(document)).digest('hex');
const fileBytes = document => Buffer.byteLength(JSON.stringify(document, null, 2));

async function verifyReport(report, { databaseCount, fileCount, records, sectionBytes, sampleRate }) {
  const selected = Math.ceil(fileCount * records * sampleRate);
  assert.equal(report.status, 'passed');
  assert.equal(report.configuration.databaseCount, databaseCount);
  assert.equal(report.configuration.fileCount, fileCount);
  assert.equal(report.queries.population, fileCount * records);
  for (const field of ['selected', 'attempted', 'completed', 'passed', 'mutated', 'persisted', 'verified']) {
    assert.equal(report.queries[field], selected, field);
  }
  assert.equal(report.queries.failed, 0);
  assert.equal(report.queries.crossFilePairs, fileCount > 1 ? selected : 0);
  assert.equal(new Set(report.queries.results.map(result => result.boundary)).size, selected);
  assert.equal(report.measurements.races.pending, 0);
  assert.equal(report.measurements.races.completed, selected);
  assert.deepEqual(report.measurements.errors, []);
  assert.deepEqual(report.cache, { retainedFiles: 0, retainedNames: [] });
  assert.equal(report.documents.length, fileCount);
  const fileNames = report.documents.map(document => document.file);
  // Rebuild an independent model from the seed, then replay only the intended
  // counter increments. Compare entire final documents, not just report hashes.
  const expected = new Map(Array.from({ length: fileCount }, (_, fileIndex) => {
    const document = generateDocument({
      databaseIndex: fileIndex % databaseCount, databaseCount, fileIndex, fileCount,
      records, sectionBytes, seed: report.configuration.seed,
    });
    return [document.file, document];
  }));
  const expectedIo = new Map(report.documents.map(document => {
    const source = expected.get(document.file);
    assert.equal(document.sha256, digest(source));
    assert.equal(document.fileBytes, fileBytes(source));
    return [document.file, { loadBytes: fileBytes(source), saveBytes: fileBytes(source) }];
  }));
  for (const result of report.queries.results) {
    for (const [file, document] of expected) expectedIo.get(file).loadBytes += fileBytes(document);
    const mutation = result.mutation;
    assert.equal(mutation.file, result.pair.random.file);
    assert.equal(mutation.database, result.pair.random.database);
    assert.equal(mutation.key, result.pair.random.key);
    assert.equal(mutation.section, 'random');
    const record = expected.get(mutation.file).random.records.find(record => record.key === mutation.key);
    assert.equal(mutation.before, record.mutationCount ?? 0);
    assert.equal(mutation.after, mutation.before + 1);
    record.mutationCount = mutation.after;
    for (const [file, document] of expected) {
      expectedIo.get(file).saveBytes += fileBytes(document);
      expectedIo.get(file).loadBytes += fileBytes(document); // fresh verification
    }
  }
  for (const document of report.documents) {
    assert.equal(document.randomBytes, sectionBytes);
    assert.equal(document.hammingBytes, sectionBytes);
    assert.equal(document.randomRecords, records);
    assert.equal(document.hammingRecords, records);
    assert.equal(document.finalFileBytes, (await stat(document.filename)).size);
    assert.ok(document.fileBytes > 2 * sectionBytes);
    const io = report.measurements.files[document.file];
    assert.equal(io.load.calls, 2 * selected + 1); // initial load, query and fresh verification
    assert.equal(io.save.calls, selected + 1); // creation plus each matching query
    assert.equal(io.flush.calls, selected);
    assert.equal(io.evict.calls, 2 * selected); // consulted and verification caches
    assert.equal(io.load.fileBytes, expectedIo.get(document.file).loadBytes);
    assert.equal(io.save.fileBytes, expectedIo.get(document.file).saveBytes);
    const saved = JSON.parse(await readFile(document.filename, 'utf8'));
    assert.equal(saved.file, document.file);
    assert.equal(saved.database, document.database);
    assert.equal(digest(saved), document.finalSha256);
    assert.deepEqual(saved, expected.get(document.file));
  }
  for (let databaseIndex = 0; databaseIndex < databaseCount; databaseIndex++) {
    const name = `db${databaseIndex + 1}`;
    const files = report.documents.filter(document => document.database === name);
    const io = report.measurements.databases[name];
    assert.equal(io.load.calls, files.length * (2 * selected + 1));
    assert.equal(io.save.calls, files.length * (selected + 1));
    assert.equal(io.flush.calls, files.length * selected);
    assert.equal(io.evict.calls, files.length * 2 * selected);
  }
  for (const result of report.queries.results) {
    assert.equal(result.status, 'passed');
    for (const field of ['savedFiles', 'flushedFiles', 'evictedFiles']) {
      assert.equal(result.persistence[field].length, fileCount);
      assert.deepEqual(new Set(result.persistence[field]), new Set(fileNames));
    }
    assert.deepEqual(new Set(result.usedFiles), new Set(fileNames));
    assert.deepEqual(new Set(result.verification.verifiedFiles), new Set(fileNames));
  }
  const traversal = report.queries.traversal;
  assert.equal(traversal.steps,
    report.queries.results.reduce((sum, result) => sum + result.traversal.steps, 0));
  for (const field of ['databaseSwitches', 'fileSwitches']) {
    assert.equal(traversal[field],
      report.queries.results.reduce((sum, result) => sum + result.traversal[field], 0));
  }
  for (const name of new Set(report.documents.map(document => document.database))) {
    for (const section of ['random', 'hamming']) {
      assert.equal(traversal.visits[name][section],
        report.queries.results.reduce((sum, result) => sum + result.traversal.visits[name][section], 0));
      assert.ok(traversal.visits[name][section] > 0);
    }
  }
  for (const file of fileNames) {
    for (const section of ['random', 'hamming']) {
      assert.equal(traversal.fileVisits[file][section], report.queries.results.reduce((sum, result) =>
        sum + result.traversal.fileVisits[file][section], 0));
      assert.ok(traversal.fileVisits[file][section] > 0);
    }
  }
  assert.ok(report.measurements.memory.peak.rss > 0);
  assert.ok(report.queries.timing.p95Ms >= report.queries.timing.medianMs);
  assert.deepEqual(JSON.parse(await readFile(report.reportPath, 'utf8')), report);
}

test('default 10 MiB files: all 205 queries mutate, save, flush, evict and verify every shard',
  { timeout: 180_000 }, async t => {
    const outputDirectory = await mkdtemp(join(tmpdir(), 'lowdb-full-test-'));
    t.after(() => rm(outputDirectory, { recursive: true, force: true }));
    const report = await runHarness({ outputDirectory });
    await verifyReport(report, {
      databaseCount: 2, fileCount: 2, records: 1024, sectionBytes: 5 * 1024 * 1024, sampleRate: 0.1,
    });
    assert.ok(report.queries.traversal.databaseSwitches > report.queries.selected);
  });

for (const [databaseCount, fileCount] of [[1, 1], [3, 5]]) {
  test(`${databaseCount} databases across ${fileCount} files persist and reload all matching queries`,
    { timeout: 30_000 }, async t => {
      const outputDirectory = await mkdtemp(join(tmpdir(), 'lowdb-layout-test-'));
      t.after(() => rm(outputDirectory, { recursive: true, force: true }));
      const options = { databaseCount, fileCount, records: 16, sectionBytes: 8192, sampleRate: 1 };
      const report = await runHarness({ outputDirectory, readConcurrency: 2, ...options });
      await verifyReport(report, options);
      if (fileCount === 1) assert.equal(report.queries.traversal.fileSwitches, 0);
      if (fileCount > databaseCount) {
        assert.ok(report.queries.traversal.fileSwitches >= report.queries.traversal.databaseSwitches);
      }
    });
}

test('CLI supports independent database/file counts and rejects invalid layouts', async t => {
  const outputDirectory = await mkdtemp(join(tmpdir(), 'lowdb-cli-test-'));
  t.after(() => rm(outputDirectory, { recursive: true, force: true }));
  const exec = promisify(execFile);
  const { stdout } = await exec(process.execPath, ['src/cli.js',
    '--out', outputDirectory, '--records', '16', '--section-mib', '0.01',
    '--databases', '3', '--files', '5', '--read-concurrency', '2']);
  assert.match(stdout, /PASSED: 8\/8 sampled queries passed/);
  assert.match(stdout, /Errors: 0; pending races: 0/);
  assert.match(stdout, /Mutations: 8; persisted matches: 8; verified mutations: 8/);
  await assert.rejects(exec(process.execPath, ['src/cli.js', '--sample-rate', '0']),
    error => error.code === 1 && /sampleRate/.test(error.stderr));
  await assert.rejects(exec(process.execPath, ['src/cli.js', '--databases', '3', '--files', '2']),
    error => error.code === 1 && /fileCount|files/i.test(error.stderr));
  await assert.rejects(exec(process.execPath, ['src/cli.js', '--read-concurrency', '0']),
    error => error.code === 1 && /readConcurrency|concurrency/i.test(error.stderr));
});
