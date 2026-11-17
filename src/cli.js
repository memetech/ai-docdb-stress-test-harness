import { runHarness } from './harness.js';

const usage = `Usage: npm start -- [options]
  --databases N        Logical databases (default 2)
  --files N            Total shard files, at least databases (default: databases)
  --read-concurrency N Maximum concurrent query file reads (default 8)
  --records N          Records per section, power of two (default 1024)
  --section-mib N      Size of each section in MiB (default 5)
  --sample-rate N      Fraction of query boundaries (default 0.1)
  --seed N             Reproducible data and query seed (default 24301)
  --interval-ms N      Resource sampling interval (default 25)
  --fault move-shard   Copy a warm shard to another database and remove source
  --fault-query N      Inject at sampled query N (1-based, default last)
  --fault-file FILE    Source shard ID (default file1)
  --fault-destination DB Destination database ID (default next database)
  --out PATH           Parent directory for unique runs (default .runs)
  --help               Show this message`;

const options = {};
const flags = new Map([
  ['--databases', ['databaseCount', Number]],
  ['--files', ['fileCount', Number]],
  ['--read-concurrency', ['readConcurrency', Number]],
  ['--records', ['records', Number]],
  ['--section-mib', ['sectionBytes', value => Math.round(Number(value) * 1024 * 1024)]],
  ['--sample-rate', ['sampleRate', Number]],
  ['--seed', ['seed', Number]],
  ['--interval-ms', ['sampleIntervalMs', Number]],
  ['--fault', ['fault', String]],
  ['--fault-query', ['faultQuery', Number]],
  ['--fault-file', ['faultFile', String]],
  ['--fault-destination', ['faultDestination', String]],
  ['--out', ['outputDirectory', String]],
]);

try {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log(usage);
  } else {
    for (let i = 0; i < args.length; i++) {
      const flag = flags.get(args[i]);
      if (!flag || args[i + 1] === undefined || args[i + 1].startsWith('--')) {
        throw new Error(`Unknown option or missing value: ${args[i]}\n${usage}`);
      }
      options[flag[0]] = flag[1](args[++i]);
    }
    const report = await runHarness(options);
    const { queries, measurements } = report;
    console.log(`${report.status.toUpperCase()}: ${queries.passed}/${queries.selected} sampled queries passed ` +
      `(${queries.population} boundaries, ${report.configuration.sampleRate * 100}% sample)`);
    console.log(`Time: ${measurements.durationMs.toFixed(1)} ms; peak sampled RSS: ` +
      `${(measurements.memory.peak.rss / 1024 / 1024).toFixed(1)} MiB`);
    for (const [name, operations] of Object.entries(measurements.databases)) {
      console.log(`${name}: ${operations.load?.calls ?? 0} loads, ${operations.save?.calls ?? 0} saves, ` +
        `${operations.flush?.calls ?? 0} disk flushes, ${operations.evict?.calls ?? 0} cache evictions`);
    }
    console.log(`Errors: ${measurements.errors.length}; pending races: ${measurements.races.pending}`);
    console.log(`In-memory database switches: ${queries.traversal.databaseSwitches} ` +
      `(file switches: ${queries.traversal.fileSwitches}) across ${queries.traversal.steps} visited records`);
    console.log(`Persisted matches: ${queries.persisted}; retained file caches: ${report.cache.retainedFiles}`);
    if (report.fault) {
      console.log(`Fault: ${report.fault.type}, query ${report.fault.query}, ${report.fault.status}`);
      console.log(`Shard: ${report.fault.sourceFilename ?? report.fault.file} -> ` +
        `${report.fault.destinationFilename ?? report.fault.destinationDatabase}`);
      console.log(`Unrun queries: ${queries.unrun}`);
    }
    console.log(`Report: ${report.reportPath}`);
    if (report.status !== 'passed') {
      for (const error of measurements.errors.slice(0, 5)) console.error(error.message);
      process.exitCode = 1;
    }
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
