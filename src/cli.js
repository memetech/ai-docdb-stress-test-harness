import { runHarness } from './harness.js';
import { parseCliOptions, usage } from './cli-options.js';

try {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log(usage);
  } else {
    const options = parseCliOptions(args);
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
