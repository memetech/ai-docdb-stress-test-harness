# ai-docdb-stress-test-harness

Node.js 22+ lowdb stress test.

```sh
npm ci
npm test
npm start
```

Each run saves two documents with 5 MiB of seeded random digits and 5 MiB of rotating Gray-code data each, plus JSON metadata. Integer keys are ordered, randomly positioned within fixed slots, and interleave across files; Gray values follow cycle order (one-bit changes, including wraparound).

Fresh lowdb instances reload both files. For each sampled boundary `b`, find the maximum random key `r < b`, then the nearest Hamming floor `r < h < b`. Pairs require opposite files. `Promise.race` observes the first read/query completion; both operations finish before selecting the global pair.

Default: 1,024 records per section; 205 queries sampled without replacement from 2,048 boundaries (10%, rounded up). Pass means every sampled query completes and matches the reference, with no errors or pending races.

Reports in `.runs/run-*/report.json` include per-query/stage timings, memory and filesystem counters over time, load/save calls and bytes, errors, and race counts. Cached reads can produce zero physical disk reads.

Options: `npm start -- --records 256 --seed 42 --section-mib 5 --sample-rate 0.1 --interval-ms 25`.
