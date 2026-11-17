# ai-docdb-stress-test-harness

Node.js 22+ lowdb stress test.

```sh
npm ci
npm test
npm start
```

`--databases N --files M` distributes M shard files round-robin across N logical databases (M >= N >= 1). Each file uses the standard lowdb `JSONFile` adapter and contains 5 MiB of random data and 5 MiB of Hamming data, plus JSON formatting/metadata. Both distributions interleave across files. One shared Gray cycle has one-bit transitions, including wraparound, for any supported file count.

Each query reloads every shard (bounded by `--read-concurrency`, default 8), observes the first completion with `Promise.race`, waits for all reads, and merges the ordered streams. For boundary `b`, return maximum random key `r < b` and nearest Hamming floor `r < h < b`. After a verified match, save every shard read by that query, `fsync` each file, then release all used lowdb data from memory. Failed saves/flushes fail the query and retain its caches; there are no adapter workarounds. Eviction does not clear the OS page cache or force JavaScript garbage collection.

Default: 2 databases, 2 files, 1,024 records per section; 205 queries sampled from 2,048 boundaries (10%, rounded up). Pass requires every sampled query to match the reference, save/flush/evict all used shards, and leave no errors, pending races, or retained caches. The missing-file and JSON-`null` contract tests assert `db.data === null` and currently fail in lowdb 7.0.1; see the [upstream report draft](LOWDB_UPSTREAM_REPORT.md).

Reports in `.runs/run-*/report.json` include per-file and logical-database load/save/flush/eviction counters, traversal switches, timings, memory/filesystem samples, and failures. Traversal switches are in memory; cached reads may produce zero physical disk reads.

Example: `npm start -- --databases 3 --files 7 --records 256 --section-mib 5 --sample-rate 0.1 --read-concurrency 4`.

Inject a cross-database shard move: `npm start -- --fault move-shard --fault-query 25 --fault-file file1 --fault-destination db2`. The default fault query is the last sampled query. It warms the existing lowdb cache, exclusively copies the shard into the destination database directory, verifies its bytes/SHA-256 and fsyncs it, then removes the source. The byte copy retains the original JSON metadata and routing so this tests a stale reader, rather than implementing shard migration. A resolved query using retained source data fails with `STALE_SHARD_CACHE` and exit status 1. The run drains reads and stops before saving or eviction, preserves both disk/cache evidence, and reports unrun queries. Standard `JSONFile` behavior is unchanged.
