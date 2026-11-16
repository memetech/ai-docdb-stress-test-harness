import { Low } from 'lowdb';
import { JSONFile } from 'lowdb/node';
import { stat } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';

export function openDatabase(filename, name, metrics, defaultData = null) {
  return { name, filename, metrics, db: new Low(new JSONFile(filename), defaultData) };
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
      database.metrics.recordDatabase(operation, database.name, durationMs, fileBytes);
    }
  }
}

export const readDatabase = database => observe(database, 'load', () => database.db.read());
export const writeDatabase = database => observe(database, 'save', () => database.db.write());
