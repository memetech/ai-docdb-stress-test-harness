import { runHarness } from './harness.js';

const usage = `Usage: npm start -- [options]
  --records N          Records per section, power of two (default 1024)
  --section-mib N      Size of each section in MiB (default 5)
  --sample-rate N      Fraction of query boundaries (default 0.1)
  --seed N             Reproducible data and query seed (default 24301)
  --interval-ms N      Resource sampling interval (default 25)
  --out PATH           Parent directory for unique runs (default .runs)
  --help               Show this message`;

const options = {};
const flags = new Map([
  ['--records', ['records', Number]],
  ['--section-mib', ['sectionBytes', value => Math.round(Number(value) * 1024 * 1024)]],
  ['--sample-rate', ['sampleRate', Number]],
  ['--seed', ['seed', Number]],
  ['--interval-ms', ['sampleIntervalMs', Number]],
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
      console.log(`${name}: ${operations.load?.calls ?? 0} loads, ${operations.save?.calls ?? 0} saves`);
    }
    console.log(`Errors: ${measurements.errors.length}; pending races: ${measurements.races.pending}`);
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
