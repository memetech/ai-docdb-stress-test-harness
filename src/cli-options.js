export const usage = `Usage: npm start -- [options]
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

export function parseCliOptions(argumentsList) {
  const options = {};
  for (let index = 0; index < argumentsList.length; index++) {
    const flag = flags.get(argumentsList[index]);
    if (!flag || argumentsList[index + 1] === undefined || argumentsList[index + 1].startsWith('--')) {
      throw new Error(`Unknown option or missing value: ${argumentsList[index]}\n${usage}`);
    }
    options[flag[0]] = flag[1](argumentsList[++index]);
  }
  return options;
}
