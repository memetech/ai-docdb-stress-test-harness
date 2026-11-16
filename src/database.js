import { Low } from 'lowdb';
import { TextFile } from 'lowdb/node';
import { performance } from 'node:perf_hooks';

// TextFile retains lowdb's atomic file writer; compact JSON keeps the two
// sections at their requested serialized sizes, without pretty-print overhead.
export function openDatabase(filename, name, metrics, defaultData = null) {
  const file = new TextFile(filename);
  const adapter = {
    async read() {
      const start = performance.now();
      let bytes = 0;
      try {
        const text = await file.read();
        // Low.read() silently retains cached data on null. Required reads must
        // fail if a file disappears instead of querying an old snapshot.
        if (text === null) {
          throw Object.assign(new Error(`${name}: database file is missing`), { code: 'ENOENT' });
        }
        bytes = Buffer.byteLength(text);
        const data = JSON.parse(text);
        if (data === null || typeof data !== 'object' || Array.isArray(data)) {
          throw new Error(`${name}: database document must be a JSON object`);
        }
        return data;
      } finally {
        metrics.recordDatabase('load', name, performance.now() - start, bytes);
      }
    },
    async write(data) {
      const start = performance.now();
      let bytes = 0;
      try {
        const text = JSON.stringify(data);
        bytes = Buffer.byteLength(text);
        await file.write(text);
      } finally {
        metrics.recordDatabase('save', name, performance.now() - start, bytes);
      }
    },
  };
  return { name, db: new Low(adapter, defaultData) };
}
