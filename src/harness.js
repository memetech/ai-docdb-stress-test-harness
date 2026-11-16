import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, stat, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { generateDocument, makeRandom, DEFAULT_SECTION_BYTES, DEFAULT_RECORDS } from './data.js';
import { openDatabase } from './database.js';
import { Metrics } from './metrics.js';
import { createReference, queryDatabases, sampleBoundaries } from './query.js';

const digest = document => createHash('sha256').update(JSON.stringify(document)).digest('hex');

export async function runHarness({
  outputDirectory = '.runs', records = DEFAULT_RECORDS,
  sectionBytes = DEFAULT_SECTION_BYTES, sampleRate = 0.1,
  seed = 0x5eed, sampleIntervalMs = 25,
} = {}) {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0 || sampleRate > 1) {
    throw new RangeError('sampleRate must be greater than zero and at most one');
  }
  if (!Number.isInteger(records) || records < 2 || records > 2 ** 20 || (records & (records - 1))) {
    throw new RangeError('records must be a power of two between 2 and 1048576');
  }
  if (!Number.isSafeInteger(sectionBytes) || sectionBytes <= 0 || !Number.isSafeInteger(seed)) {
    throw new RangeError('sectionBytes must be positive and seed must be a safe integer');
  }
  const metrics = new Metrics({ sampleIntervalMs });
  await mkdir(resolve(outputDirectory), { recursive: true });
  const directory = await mkdtemp(join(resolve(outputDirectory), 'run-'));
  const reportPath = join(directory, 'report.json');
  const boundaries = sampleBoundaries(records, sampleRate, makeRandom(seed));
  const report = {
    status: 'failed', directory, reportPath,
    configuration: { recordsPerSection: records, sectionBytes, sampleRate, seed, sampleIntervalMs },
    documents: [],
    queries: {
      population: records * 2, selected: boundaries.length,
      attempted: 0, completed: 0, passed: 0, failed: 0,
      crossDatabasePairs: 0, results: [],
    },
  };
  metrics.start();
  try {
    let documents = await metrics.stage('generate', async () => [0, 1].map(databaseIndex =>
      generateDocument({ databaseIndex, records, sectionBytes, seed })));
    const reference = createReference(documents);
    const expected = boundaries.map(boundary => reference(boundary));
    const digests = documents.map(digest);
    await metrics.stage('save', async () => {
      for (const document of documents) {
        const filename = join(directory, `${document.database}.json`);
        const writer = openDatabase(filename, document.database, metrics, document);
        await writer.db.write();
        report.documents.push({
          database: document.database, filename, fileBytes: (await stat(filename)).size,
          randomBytes: Buffer.byteLength(JSON.stringify(document.random)),
          hammingBytes: Buffer.byteLength(JSON.stringify(document.hamming)),
          sha256: digests[report.documents.length],
        });
      }
    });
    documents = null;
    // Fresh lowdb objects, not the writers or their in-memory documents.
    const readers = report.documents.map(document =>
      openDatabase(document.filename, document.database, metrics));
    await metrics.stage('reload', async () => {
      const results = await Promise.allSettled(readers.map(async (reader, index) => {
        await reader.db.read();
        assert.equal(digest(reader.db.data), digests[index], `${reader.name}: round-trip mismatch`);
      }));
      const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
      if (errors.length) throw new AggregateError(errors, 'Fresh database reload failed');
    });
    await metrics.stage('queries', async () => {
      for (const [index, boundary] of boundaries.entries()) {
        const started = performance.now();
        report.queries.attempted++;
        let result;
        try {
          result = await queryDatabases(readers, boundary, metrics);
          assert.deepEqual(result.pair, expected[index], `Incorrect pair at boundary ${boundary}`);
          assert.ok(result.pair, `Missing pair at boundary ${boundary}`);
          assert.notEqual(result.pair.random.database, result.pair.hamming.database,
            'Generated query must require both databases');
          report.queries.passed++;
          report.queries.crossDatabasePairs++;
          result.status = 'passed';
        } catch (error) {
          metrics.recordError(error);
          report.queries.failed++;
          result = { ...result, boundary, status: 'failed', error: error.message };
        } finally {
          report.queries.completed++;
          report.queries.results.push({ ...result, durationMs: performance.now() - started });
        }
      }
    });
  } catch (error) {
    // stage() records fatal setup/load failures; still persist the measurements.
    if (!metrics.errors.length) metrics.recordError(error);
  } finally {
    report.measurements = metrics.stop();
  }
  const { queries, measurements } = report;
  const durations = queries.results.map(result => result.durationMs).sort((a, b) => a - b);
  const queryStage = measurements.stages.find(stage => stage.name === 'queries');
  queries.timing = durations.length ? {
    minMs: durations[0], maxMs: durations.at(-1),
    meanMs: durations.reduce((sum, value) => sum + value, 0) / durations.length,
    medianMs: durations[Math.ceil(durations.length * 0.5) - 1],
    p95Ms: durations[Math.ceil(durations.length * 0.95) - 1],
    queriesPerSecond: queries.completed / (queryStage.durationMs / 1000),
  } : null;
  report.status = queries.completed === queries.selected && queries.passed === queries.selected &&
    queries.failed === 0 && measurements.errors.length === 0 &&
    measurements.races.pending === 0 && measurements.races.completed === queries.selected
    ? 'passed' : 'failed';
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
  return report;
}
