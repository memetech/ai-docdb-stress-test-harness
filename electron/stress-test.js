import { parseCliOptions, usage } from '../src/cli-options.js';
import { runHarness } from '../src/harness.js';
import { parseArguments } from './arguments.js';

let running = false;

export async function runStressTest(rawArguments) {
  if (running) throw new Error('A stress test is already running.');
  if (typeof rawArguments !== 'string') throw new TypeError('Arguments must be text.');

  const argumentsList = parseArguments(rawArguments);
  if (argumentsList.includes('--help')) return { status: 'help', message: usage };

  running = true;
  try {
    const report = await runHarness(parseCliOptions(argumentsList));
    console.log(`${report.status.toUpperCase()}: ${report.queries.passed}/${report.queries.selected} ` +
      `sampled queries passed`);
    console.log(`Report: ${report.reportPath}`);
    return {
      status: report.status,
      passed: report.queries.passed,
      selected: report.queries.selected,
      reportPath: report.reportPath,
    };
  } finally {
    running = false;
  }
}
