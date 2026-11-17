# lowdb 7.0.1: read() retains loaded data when JSONFile returns null

Status: prepared for upstream submission; this repository does not record a submitted upstream issue.

## Environment

- lowdb 7.0.1, pinned in package-lock.json
- Node.js v24.22.1, npm 11.9.0
- Linux 6.18.57
- Standard `Low` and `JSONFile`, without a custom adapter or library patches

## Documented contract

The [7.0.1 README, db.read()](https://github.com/typicode/lowdb/blob/v7.0.1/README.md#dbread) states:

> Calls `adapter.read()` and sets `db.data`.
>
> **Note:** `JSONFile` and `JSONFileSync` adapters will set `db.data` to `null` if file doesn't exist.

The [db.data documentation](https://github.com/typicode/lowdb/blob/v7.0.1/README.md#dbdata) also says the built-in adapters support types accepted by `JSON.stringify`. JSON `null` is valid JSON.

The tests in this report require the documented resulting value, **not an exception** when the file is missing.

## Minimal reproduction

Run from this repository after `npm ci`:

```sh
node --input-type=module <<'JS'
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Low } from 'lowdb';
import { JSONFile } from 'lowdb/node';

const directory = await mkdtemp(join(tmpdir(), 'lowdb-null-read-'));
try {
  const filename = join(directory, 'db.json');
  const original = { posts: [{ id: 1 }] };
  await writeFile(filename, JSON.stringify(original));
  const db = new Low(new JSONFile(filename), null);
  await db.read();
  assert.deepEqual(db.data, original);

  await rm(filename);
  // To reproduce the JSON-null case instead, replace rm above with:
  // await writeFile(filename, 'null');
  assert.equal(await db.adapter.read(), null);
  await db.read();
  console.log('db.data after read:', db.data);
  assert.equal(db.data, null);
} finally {
  await rm(directory, { recursive: true, force: true });
}
JS
```

Expected: the read completes with `db.data === null`.

Observed: the read resolves, but `db.data` remains `{ posts: [{ id: 1 }] }`; the final assertion fails and the process exits with status 1. Replacing the file with JSON `null` produces the same result.

## Implementation path

[TextFile.read()](https://github.com/typicode/lowdb/blob/v7.0.1/src/adapters/node/TextFile.ts) returns `null` for `ENOENT`. [DataFile.read()](https://github.com/typicode/lowdb/blob/v7.0.1/src/adapters/node/DataFile.ts) propagates that value; parsing the text `null` also yields `null`.

[Low.read()](https://github.com/typicode/lowdb/blob/v7.0.1/src/core/Low.ts) assigns only truthy adapter results:

```js
const data = await this.adapter.read();
if (data) this.data = data;
```

Thus a previously populated `db.data` is retained when the adapter returns `null`. Please clarify whether this is an implementation defect or whether the documentation should describe retention of existing data. Neither reproduction requires `read()` to throw.

## Repository tests and stress reproduction

```sh
node --test test/file-failure.test.js
npm start -- --fault move-shard
```

The focused suite contains two deliberately unhidden contract failures: removal after loading, and reading JSON `null` after loading. A separate malformed-JSON test passes, verifying that actual parse errors are reported after all pending reads settle. No lowdb workaround, skipped assertion, or expected-failure marking is used.

The stress mode warms an existing lowdb instance, copies its shard into another database directory, verifies the copied bytes/SHA-256 and fsyncs the copy, then removes the source. It leaves the original reader and routing in place. The observed reread retains the same object and digest, and a query can still match the original reference despite the source file being absent. The harness reports `STALE_SHARD_CACHE`, drains reads, skips saving, and stops before a later write could recreate the source.

The full-size reproduction completed all 205 sampled queries: 204 passed, and the injected final query failed with exit status 1 and zero pending races. The source remained absent and the destination copy matched its recorded SHA-256.

This finding concerns in-memory state after reading an absent or null backing document. It does not establish spontaneous on-disk corruption or failure of atomic writes. Coordinating shard ownership and retiring old instances during migration remains an application responsibility.
