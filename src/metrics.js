import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';

const linuxIoKeys = [
  'rchar', 'wchar', 'syscr', 'syscw', 'read_bytes', 'write_bytes',
  'cancelled_write_bytes',
];

function readIo() {
  const usage = process.resourceUsage();
  let linux = null;
  if (process.platform === 'linux') {
    try {
      const entries = readFileSync('/proc/self/io', 'utf8').trim().split('\n')
        .map((line) => line.split(':').map((part) => part.trim()));
      const values = Object.fromEntries(entries);
      linux = Object.fromEntries(linuxIoKeys.map((key) => [key, Number(values[key])]));
    } catch {
      // /proc can be unavailable in a sandbox; resourceUsage remains portable.
    }
  }
  return { resourceUsage: { fsRead: usage.fsRead, fsWrite: usage.fsWrite }, linux };
}

function subtract(after, before) {
  if (!after || !before) return null;
  return Object.fromEntries(Object.keys(after).map((key) => [key, after[key] - before[key]]));
}

function describeError(error, depth = 0) {
  return {
    name: error?.name ?? 'Error',
    message: error?.message ?? String(error),
    ...(error?.code === undefined ? {} : { code: String(error.code) }),
    ...(depth < 5 && error instanceof AggregateError
      ? { errors: error.errors.map(nested => describeError(nested, depth + 1)) } : {}),
    ...(depth < 5 && error?.cause
      ? { cause: describeError(error.cause, depth + 1) } : {}),
  };
}

/** IO measurements are process-wide; database file sizes are observed separately. */
export class Metrics {
  constructor({ sampleIntervalMs = 25, maxSamples = 20_000 } = {}) {
    if (!Number.isFinite(sampleIntervalMs) || sampleIntervalMs < 1) {
      throw new RangeError('sampleIntervalMs must be at least 1');
    }
    if (!Number.isInteger(maxSamples) || maxSamples < 2) {
      throw new RangeError('maxSamples must be an integer of at least 2');
    }
    this.sampleIntervalMs = sampleIntervalMs;
    this.maxSamples = maxSamples;
    this.samples = [];
    this.samplesDropped = 0;
    this.stages = [];
    this.databases = {};
    this.files = {};
    this.races = { started: 0, completed: 0, pending: 0, peakPending: 0 };
    this.errors = [];
    this.peakMemory = {};
    this.startedAt = null;
    this.timer = null;
    this.result = null;
  }

  start() {
    if (this.startedAt !== null) return this;
    this.startedAt = performance.now();
    this.initialSample = this.sample('start');
    this.timer = setInterval(() => this.sample('interval'), this.sampleIntervalMs);
    this.timer.unref();
    return this;
  }

  sample(reason) {
    if (this.startedAt === null || this.result) return null;
    const sample = {
      elapsedMs: performance.now() - this.startedAt,
      reason,
      memory: process.memoryUsage(),
      io: readIo(),
      pendingRaces: this.races.pending,
    };
    for (const [key, value] of Object.entries(sample.memory)) {
      this.peakMemory[key] = Math.max(this.peakMemory[key] ?? 0, value);
    }
    if (this.samples.length === this.maxSamples) {
      this.samples.shift();
      this.samplesDropped += 1;
    }
    this.samples.push(sample);
    return sample;
  }

  async stage(name, fn) {
    if (this.startedAt === null) this.start();
    const started = performance.now();
    this.sample(`stage:${name}:start`);
    const stage = { name, startedMs: started - this.startedAt, durationMs: 0, status: 'passed' };
    try {
      return await fn();
    } catch (error) {
      stage.status = 'failed';
      this.recordError(error);
      throw error;
    } finally {
      stage.durationMs = performance.now() - started;
      this.stages.push(stage);
      this.sample(`stage:${name}:end`);
    }
  }

  recordDatabase(operation, database, durationMs, fileBytes = 0, fileName = database) {
    for (const [groups, name] of [[this.databases, database], [this.files, fileName]]) {
      const group = groups[name] ??= {};
      const entry = group[operation] ??= { calls: 0, durationMs: 0, fileBytes: 0 };
      entry.calls += 1;
      entry.durationMs += durationMs;
      entry.fileBytes += fileBytes;
    }
    this.sample(`database:${fileName}:${operation}`);
  }

  raceStarted() {
    this.races.started += 1;
    this.races.pending += 1;
    this.races.peakPending = Math.max(this.races.peakPending, this.races.pending);
  }

  raceSettled() {
    if (this.races.pending === 0) throw new Error('Cannot settle a race that was not started');
    this.races.completed += 1;
    this.races.pending -= 1;
  }

  recordError(error) {
    this.errors.push({
      elapsedMs: this.startedAt === null ? 0 : performance.now() - this.startedAt,
      ...describeError(error),
    });
  }

  stop() {
    if (this.result) return this.result;
    if (this.startedAt === null) this.start();
    clearInterval(this.timer);
    const finalSample = this.sample('stop');
    this.result = {
      durationMs: performance.now() - this.startedAt,
      stages: this.stages,
      memory: {
        initial: this.initialSample.memory,
        final: finalSample.memory,
        peak: this.peakMemory,
      },
      io: {
        initial: this.initialSample.io,
        final: finalSample.io,
        delta: {
          resourceUsage: subtract(finalSample.io.resourceUsage, this.initialSample.io.resourceUsage),
          linux: subtract(finalSample.io.linux, this.initialSample.io.linux),
        },
        notes: [
          'IO counters cover this process, including measurement overhead, up to stop().',
          'Linux rchar/wchar are requested bytes; read_bytes/write_bytes reflect storage IO and can be zero for cached reads.',
          'Database fileBytes sums file sizes observed after lowdb calls, including failed calls; it does not measure transferred bytes.',
          'File-size observations use stat outside lowdb and do not alter its adapter or behavior.',
          'Flush calls fsync each saved file; eviction releases lowdb data references, not the operating system page cache.',
          'Intervals can be delayed by synchronous work; stage and database boundaries are sampled too.',
        ],
      },
      databases: this.databases,
      files: this.files,
      races: this.races,
      errors: this.errors,
      sampleIntervalMs: this.sampleIntervalMs,
      samplesDropped: this.samplesDropped,
      samples: this.samples,
    };
    return this.result;
  }
}
