import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, stat, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { generateDocument, makeRandom, validateLayout, DEFAULT_SECTION_BYTES, DEFAULT_RECORDS } from './data.js';
import { openDatabase, readDatabase, writeDatabase, saveAndFlushDatabases } from './database.js';
import { Metrics } from './metrics.js';
import { createReference, queryDatabases, sampleBoundaries } from './query.js';

const digest = document => createHash('sha256').update(JSON.stringify(document)).digest('hex');

export async function runHarness({
  outputDirectory = '.runs', records = DEFAULT_RECORDS,
  sectionBytes = DEFAULT_SECTION_BYTES, sampleRate = 0.1,
  seed = 0x5eed, sampleIntervalMs = 25,
  databaseCount = 2, fileCount = databaseCount, readConcurrency = 8,
} = {}) {
  validateLayout(databaseCount, fileCount);
  if (!Number.isSafeInteger(readConcurrency) || readConcurrency < 1) {
    throw new RangeError('readConcurrency must be a positive integer');
  }
  if (!Number.isFinite(sampleRate) || sampleRate <= 0 || sampleRate > 1) {
    throw new RangeError('sampleRate must be greater than zero and at most one');
  }
  if (!Number.isInteger(records) || records < 2 || records > 2 ** 20 || (records & (records - 1))) {
    throw new RangeError('records must be a power of two between 2 and 1048576');
  }
  if (records * fileCount > 2 ** 30) {
    throw new RangeError('records * fileCount must not exceed 1073741824');
  }
  if (!Number.isSafeInteger(sectionBytes) || sectionBytes <= 0 || !Number.isSafeInteger(seed)) {
    throw new RangeError('sectionBytes must be positive and seed must be a safe integer');
  }
  const metrics = new Metrics({ sampleIntervalMs });
  await mkdir(resolve(outputDirectory), { recursive: true });
  const directory = await mkdtemp(join(resolve(outputDirectory), 'run-'));
  const reportPath = join(directory, 'report.json');
  const boundaries = sampleBoundaries(records, sampleRate, makeRandom(seed), fileCount);
  let readers = [];
  const report = {
    status: 'failed', directory, reportPath,
    configuration: {
      adapter: 'JSONFile', databaseCount, fileCount, readConcurrency,
      recordsPerSection: records, sectionBytes, sampleRate, seed, sampleIntervalMs,
    },
    documents: [],
    cache: { retainedFiles: 0, retainedNames: [] },
    queries: {
      population: records * fileCount, selected: boundaries.length,
      attempted: 0, completed: 0, passed: 0, failed: 0,
      crossDatabasePairs: 0, crossFilePairs: 0, persisted: 0, results: [],
      traversal: { steps: 0, databaseSwitches: 0, fileSwitches: 0, visits: {}, fileVisits: {} },
    },
  };
  metrics.start();
  try {
    let documents = await metrics.stage('generate', async () =>
      Array.from({ length: fileCount }, (_, fileIndex) => generateDocument({
        databaseIndex: fileIndex % databaseCount, databaseCount,
        fileIndex, fileCount, records, sectionBytes, seed,
      })));
    const reference = createReference(documents);
    const expected = boundaries.map(boundary => reference(boundary));
    const digests = documents.map(digest);
    await metrics.stage('save', async () => {
      for (const document of documents) {
        const databaseDirectory = join(directory, document.database);
        await mkdir(databaseDirectory, { recursive: true });
        const filename = join(databaseDirectory, `${document.file}.json`);
        const writer = openDatabase(filename, document.file, metrics, document,
          { databaseName: document.database });
        await writeDatabase(writer);
        report.documents.push({
          database: document.database, file: document.file, filename, fileBytes: (await stat(filename)).size,
          randomBytes: Buffer.byteLength(JSON.stringify(document.random)),
          hammingBytes: Buffer.byteLength(JSON.stringify(document.hamming)),
          randomRecords: document.random.records.length,
          hammingRecords: document.hamming.records.length,
          sha256: digests[report.documents.length],
        });
      }
    });
    documents = null;
    // Fresh lowdb objects, not the writers or their in-memory documents.
    readers = report.documents.map(document =>
      openDatabase(document.filename, document.file, metrics, null,
        { databaseName: document.database }));
    await metrics.stage('reload', async () => {
      const errors = [];
      for (let offset = 0; offset < readers.length; offset += readConcurrency) {
        const results = await Promise.allSettled(readers.slice(offset, offset + readConcurrency)
          .map(async (reader, index) => {
            await readDatabase(reader);
            assert.equal(digest(reader.db.data), digests[offset + index], `${reader.name}: round-trip mismatch`);
          }));
        errors.push(...results.filter(result => result.status === 'rejected').map(result => result.reason));
      }
      if (errors.length) throw new AggregateError(errors, 'Fresh database reload failed');
    });
    await metrics.stage('queries', async () => {
      for (const [index, boundary] of boundaries.entries()) {
        const started = performance.now();
        report.queries.attempted++;
        let result;
        try {
          result = await queryDatabases(readers, boundary, metrics, { readConcurrency });
          const totals = report.queries.traversal;
          totals.steps += result.traversal.steps;
          totals.databaseSwitches += result.traversal.databaseSwitches;
          totals.fileSwitches += result.traversal.fileSwitches;
          for (const collection of ['visits', 'fileVisits']) {
            for (const [name, visits] of Object.entries(result.traversal[collection])) {
              const target = totals[collection][name] ??= { random: 0, hamming: 0 };
              target.random += visits.random;
              target.hamming += visits.hamming;
            }
          }
          assert.deepEqual(result.pair, expected[index], `Incorrect pair at boundary ${boundary}`);
          assert.ok(result.pair, `Missing pair at boundary ${boundary}`);
          if (fileCount > 1) {
            assert.notEqual(result.pair.random.file, result.pair.hamming.file,
              'Generated query must require different files');
          }
          const used = readers.filter(reader => result.usedFiles.includes(reader.name));
          assert.equal(used.length, result.usedFiles.length, 'Unknown file in query usage');
          result.persistence = await saveAndFlushDatabases(used);
          assert.ok(used.every(reader => reader.db.data === null), 'Used caches were not evicted');
          report.queries.persisted++;
          report.queries.passed++;
          report.queries.crossDatabasePairs += Number(result.pair.random.database !== result.pair.hamming.database);
          report.queries.crossFilePairs += Number(result.pair.random.file !== result.pair.hamming.file);
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
    report.cache.retainedNames = readers.filter(reader => reader.db.data !== null).map(reader => reader.name);
    report.cache.retainedFiles = report.cache.retainedNames.length;
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
    queries.failed === 0 && queries.persisted === queries.selected &&
    report.cache.retainedFiles === 0 && measurements.errors.length === 0 &&
    measurements.races.pending === 0 && measurements.races.completed === queries.selected
    ? 'passed' : 'failed';
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
  return report;
}
