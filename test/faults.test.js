import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { moveShardFile } from '../src/faults.js';

async function paths(t) {
  const directory = await mkdtemp(join(tmpdir(), 'lowdb-shard-move-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await Promise.all(['db1', 'db2'].map(name => mkdir(join(directory, name))));
  return {
    sourceFilename: join(directory, 'db1', 'file1.json'),
    destinationFilename: join(directory, 'db2', 'file1.json'),
  };
}

test('shard move verifies and flushes a byte-identical copy before removing the source', async t => {
  const filenames = await paths(t);
  const content = JSON.stringify({ database: 'db1', values: Array.from({ length: 30_000 }, (_, i) => i) });
  await writeFile(filenames.sourceFilename, content);
  const result = await moveShardFile(filenames);
  assert.deepEqual(result, {
    ...filenames,
    sourceRemoved: true,
    destinationVerified: true,
    bytes: Buffer.byteLength(content),
    sha256: createHash('sha256').update(content).digest('hex'),
    durationMs: result.durationMs,
  });
  assert.ok(result.durationMs >= 0);
  assert.equal(await readFile(filenames.destinationFilename, 'utf8'), content);
  await assert.rejects(stat(filenames.sourceFilename), { code: 'ENOENT' });
});

test('an existing destination fails without deleting or overwriting either shard', async t => {
  const filenames = await paths(t);
  await writeFile(filenames.sourceFilename, '{"source":true}');
  await writeFile(filenames.destinationFilename, '{"destination":true}');
  await assert.rejects(moveShardFile(filenames), { code: 'EEXIST' });
  assert.equal(await readFile(filenames.sourceFilename, 'utf8'), '{"source":true}');
  assert.equal(await readFile(filenames.destinationFilename, 'utf8'), '{"destination":true}');
});

test('a same-file move is rejected without changing the source', async t => {
  const { sourceFilename } = await paths(t);
  await writeFile(sourceFilename, '{"source":true}');
  await assert.rejects(moveShardFile({ sourceFilename, destinationFilename: sourceFilename }), /different files/);
  assert.equal(await readFile(sourceFilename, 'utf8'), '{"source":true}');
});

test('a failed copy leaves the source intact', async t => {
  const filenames = await paths(t);
  await writeFile(filenames.sourceFilename, '{"source":true}');
  await assert.rejects(moveShardFile({
    ...filenames, destinationFilename: join(filenames.destinationFilename, 'missing', 'file.json'),
  }), { code: 'ENOENT' });
  assert.equal(await readFile(filenames.sourceFilename, 'utf8'), '{"source":true}');
});
