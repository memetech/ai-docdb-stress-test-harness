import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { evictDatabase, openDatabase, readDatabase } from './database.js';

export const documentDigest = document =>
  createHash('sha256').update(JSON.stringify(document)).digest('hex');

/** Increment the matched random record, keeping a hash of the intended state. */
export function mutateAfterQuery(databases, pair, expectedDigests) {
  // Check the entire loaded document before trusting it to construct
  // the next expected state. This also catches stale reads of earlier updates.
  for (const database of databases) {
    assert.equal(documentDigest(database.db.data), expectedDigests.get(database.name),
      `${database.name}: pre-mutation data mismatch (stale read or corruption)`);
  }
  assert.ok(pair?.random, 'Mutation requires a matched random record');
  const file = pair.random.file ?? pair.random.database;
  const database = databases.find(database => database.name === file);
  assert.ok(database, `Unknown mutation file: ${file}`);
  const document = database.db.data;
  const index = document.random.records.findIndex(record => record.key === pair.random.key);
  assert.ok(index >= 0, `${file}: mutation record not found`);
  const record = document.random.records[index];
  const before = Object.hasOwn(record, 'mutationCount') ? record.mutationCount : 0;
  assert.ok(Number.isSafeInteger(before) && before >= 0 && before < Number.MAX_SAFE_INTEGER,
    `${file}: invalid mutation counter`);
  const after = before + 1;

  // Build the expected document separately, BEFORE changing the live record.
  // Its whole-document hash protects prior updates, other records and shards,
  // payloads, ordering and metadata, not just the new counter.
  const records = document.random.records.map((item, i) =>
    i === index ? { ...item, mutationCount: after } : item);
  const expectedDigest = documentDigest({ ...document, random: { ...document.random, records } });
  record.mutationCount = after;
  expectedDigests.set(file, expectedDigest);
  return {
    database: database.databaseName ?? database.name, file, section: 'random',
    key: record.key, before, after,
  };
}

/** Read through fresh lowdb handles so an old cache cannot satisfy the check. */
export async function verifyPersistedDatabases(databases, expectedDigests) {
  const verifiedFiles = [];
  const errors = [];
  // One verifier at a time bounds additional memory to one shard. All reads
  // finish and their caches are released, including when an earlier check fails.
  for (const database of databases) {
    const verifier = openDatabase(database.filename, database.name, database.metrics, null,
      { databaseName: database.databaseName ?? database.name });
    try {
      await readDatabase(verifier);
      assert.equal(documentDigest(verifier.db.data), expectedDigests.get(database.name),
        `${database.name}: persisted data mismatch (lost update or corruption)`);
      verifiedFiles.push(database.name);
    } catch (error) {
      errors.push(error);
    } finally {
      evictDatabase(verifier);
    }
  }
  if (errors.length) throw new AggregateError(errors, 'Post-mutation verification failed');
  return { verifiedFiles };
}
