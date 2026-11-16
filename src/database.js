import { Low } from 'lowdb';
import { JSONFile } from 'lowdb/node';
import { open, stat } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';

export function openDatabase(filename, name, metrics, defaultData = null, { databaseName = name } = {}) {
  return { name, databaseName, filename, metrics, db: new Low(new JSONFile(filename), defaultData) };
}

// Observe calls outside lowdb. Never replace its adapter, parsing, return
// values, or errors. File sizes are observations, not bytes transferred.
async function observe(database, operation, call) {
  const start = performance.now();
  try {
    return await call();
  } finally {
    const durationMs = performance.now() - start;
    if (database.metrics) {
      let fileBytes = 0;
      try {
        fileBytes = (await stat(database.filename)).size;
      } catch {
        // A missing/unreadable size must not change lowdb's result or error.
      }
      database.metrics.recordDatabase(operation, database.databaseName ?? database.name,
        durationMs, fileBytes, database.name);
    }
  }
}

export const readDatabase = database => observe(database, 'load', () => database.db.read());
export const writeDatabase = database => observe(database, 'save', () => database.db.write());

/** Save and sync consulted files before releasing any of their lowdb data. */
export async function saveAndFlushDatabases(databases) {
  const used = [...new Set(databases)];
  for (const database of used) {
    if (database.db.data === null || database.db.data === undefined) {
      throw new Error(`${database.name}: cannot save an unloaded database`);
    }
  }
  const savedFiles = [];
  const flushedFiles = [];
  for (const database of used) {
    await writeDatabase(database);
    savedFiles.push(database.name);
    await observe(database, 'flush', async () => {
      const handle = await open(database.filename, 'r+');
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    });
    flushedFiles.push(database.name);
  }

  // Do not evict even one cache while a write or fsync can still fail. There is
  // no rollback of files already written, but all loaded data remains on error.
  for (const database of used) {
    const start = performance.now();
    database.db.data = null;
    database.metrics?.recordDatabase('evict', database.databaseName ?? database.name,
      performance.now() - start, 0, database.name);
  }
  return { savedFiles, flushedFiles, evictedFiles: used.map(database => database.name) };
}
