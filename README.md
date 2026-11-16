# ai-docdb-stress-test-harness

Node.js 22+ lowdb stress test.

```sh
npm ci
npm test
npm start
```

Each database contains 5 MiB of seeded random data and 5 MiB of Hamming data, plus JSON formatting and metadata. Both distributions are split equally across files and interleave by key. One shared, rotated Gray cycle alternates ranks between databases (one-bit changes globally, including wraparound).

Fresh lowdb instances use the standard `JSONFile` adapter. Each query reloads both files once, using `Promise.race` to observe the first completion and waiting for both. It then merges all four ordered streams, switching databases as interleaved records are visited. For boundary `b`, return the maximum random key `r < b` and nearest Hamming floor `r < h < b`. Pairs require opposite files. Lowdb failures are reported without workarounds.

Default: 1,024 records per section; 205 queries sampled without replacement from 2,048 boundaries (10%, rounded up). Pass means every sampled query completes and matches the reference, with no errors or pending races.

Reports in `.runs/run-*/report.json` include each file's distribution sizes/counts, per-query traversal switches and path previews, timing, memory/filesystem samples, load/save calls, errors, and pending races. Traversal switches are in memory; file reads are counted separately. Cached reads can produce zero physical disk reads.

Options: `npm start -- --records 256 --seed 42 --section-mib 5 --sample-rate 0.1 --interval-ms 25`.
