import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parseArguments } from '../electron/arguments.js';
import { runStressTest } from '../electron/stress-test.js';

test('parses quoted arguments from the Electron text box', () => {
  assert.deepEqual(
    parseArguments('--records 16 --out "runs with spaces" --fault-file file\\ 1'),
    ['--records', '16', '--out', 'runs with spaces', '--fault-file', 'file 1'],
  );
  assert.throws(() => parseArguments('--out "unfinished'), /unclosed/);
});

test('runs the harness directly from Electron arguments', async t => {
  const outputDirectory = await mkdtemp(join(tmpdir(), 'lowdb-electron-test-'));
  t.after(() => rm(outputDirectory, { recursive: true, force: true }));

  const result = await runStressTest(
    `--databases 1 --files 1 --records 2 --section-mib 0.001 --sample-rate 0.5 --out "${outputDirectory}"`,
  );

  assert.equal(result.status, 'passed');
  assert.equal(result.passed, 1);
  assert.equal(result.selected, 1);
  const report = JSON.parse(await readFile(result.reportPath, 'utf8'));
  assert.equal(report.configuration.databaseCount, 1);
  assert.equal(report.configuration.fileCount, 1);
});
