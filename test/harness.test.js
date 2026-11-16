import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runHarness } from '../src/harness.js';

test('default 10 MiB documents: all 205 sampled cross-file queries execute and pass',
  { timeout: 180_000 }, async t => {
    const outputDirectory = await mkdtemp(join(tmpdir(), 'lowdb-full-test-'));
    t.after(() => rm(outputDirectory, { recursive: true, force: true }));
    const report = await runHarness({ outputDirectory });
    assert.equal(report.status, 'passed');
    assert.equal(report.queries.population, 2048);
    for (const field of ['selected', 'attempted', 'completed', 'passed', 'crossDatabasePairs']) {
      assert.equal(report.queries[field], 205, field);
    }
    assert.equal(report.queries.failed, 0);
    assert.equal(new Set(report.queries.results.map(result => result.boundary)).size, 205);
    assert.equal(report.measurements.races.pending, 0);
    assert.equal(report.measurements.races.completed, 205);
    assert.deepEqual(report.measurements.errors, []);
    for (const document of report.documents) {
      assert.equal(document.randomBytes, 5 * 1024 * 1024);
      assert.equal(document.hammingBytes, 5 * 1024 * 1024);
      assert.equal(document.randomRecords, 1024);
      assert.equal(document.hammingRecords, 1024);
      assert.equal(document.fileBytes, (await stat(document.filename)).size);
      assert.ok(document.fileBytes > 10 * 1024 * 1024);
      const io = report.measurements.databases[document.database];
      assert.equal(io.load.calls, 206); // one fresh load plus one per query
      assert.equal(io.save.calls, 1);
      assert.equal(io.load.fileBytes, 206 * document.fileBytes);
      assert.equal(io.save.fileBytes, document.fileBytes);
    }
    const traversal = report.queries.traversal;
    assert.equal(traversal.steps,
      report.queries.results.reduce((sum, result) => sum + result.traversal.steps, 0));
    assert.equal(traversal.databaseSwitches,
      report.queries.results.reduce((sum, result) => sum + result.traversal.databaseSwitches, 0));
    assert.ok(traversal.databaseSwitches > report.queries.selected);
    for (const document of report.documents) {
      for (const section of ['random', 'hamming']) {
        assert.equal(traversal.visits[document.database][section],
          report.queries.results.reduce((sum, result) =>
            sum + result.traversal.visits[document.database][section], 0));
        assert.ok(traversal.visits[document.database][section] > 0);
      }
    }
    assert.ok(report.measurements.samples.length > 205);
    assert.ok(report.measurements.memory.peak.rss > 0);
    assert.ok(report.queries.timing.p95Ms >= report.queries.timing.medianMs);
    assert.deepEqual(JSON.parse(await readFile(report.reportPath, 'utf8')), report);
  });

test('CLI reports success and rejects invalid arguments with a failing exit status', async t => {
  const outputDirectory = await mkdtemp(join(tmpdir(), 'lowdb-cli-test-'));
  t.after(() => rm(outputDirectory, { recursive: true, force: true }));
  const exec = promisify(execFile);
  const { stdout } = await exec(process.execPath, ['src/cli.js',
    '--out', outputDirectory, '--records', '16', '--section-mib', '0.01']);
  assert.match(stdout, /PASSED: 4\/4 sampled queries passed/);
  assert.match(stdout, /Errors: 0; pending races: 0/);
  await assert.rejects(exec(process.execPath, ['src/cli.js', '--sample-rate', '0']),
    error => error.code === 1 && /sampleRate/.test(error.stderr));
});
