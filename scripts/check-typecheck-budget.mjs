import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * DEV-963: the full type check (`tsc --noEmit`) must fit the standard 8 GB heap with room to
 * spare. On develop at 081cfd1 it used 8.59 GB, 2.47 million types and 8.60 million
 * instantiations, and one more router made it abort. This guard runs the same full check inside
 * the standard allowance and fails when it errors, runs out of memory, or grows past a budget.
 *
 * Run it from the repository root after `bunx prisma generate`:
 *
 *     node scripts/check-typecheck-budget.mjs
 *
 * A budget is raised on purpose, in the same change that needs it, with the new measurement in
 * the pull request. Never raise it to make an unexplained jump pass: find what grew first
 * (`tsc --noEmit --extendedDiagnostics --generateTrace <dir>`), as in DEV-963.
 */

/** The heap every process gets in CI, Docker and the documented commands (MB). */
export const STANDARD_HEAP_MB = 8192;

/**
 * Measured after DEV-963 on a 4-core, 16 GB machine: 7.0 to 7.2 GB used, 2.47 million types,
 * 8.60 million instantiations, 7,915 files. "Memory used" moves by about 0.2 GB between
 * identical runs, so its budget leaves that much above the highest measurement.
 */
export const BUDGET = Object.freeze({
  memoryUsedKB: 7_600_000,
  types: 2_650_000,
  // Before the second pass develop needed 8,866,106 instantiations.
  instantiations: 8_800_000,
  files: 8_600,
});

const METRICS = [
  ['files', /^Files:\s+(\d+)/m],
  ['types', /^Types:\s+(\d+)/m],
  ['instantiations', /^Instantiations:\s+(\d+)/m],
  ['memoryUsedKB', /^Memory used:\s+(\d+)K/m],
  ['totalSeconds', /^Total time:\s+([\d.]+)s/m],
];

/** The figures `tsc --extendedDiagnostics` prints, or `null` for any it did not print. */
export function parseDiagnostics(output) {
  return Object.fromEntries(
    METRICS.map(([key, pattern]) => {
      const match = output.match(pattern);
      return [key, match ? Number(match[1]) : null];
    })
  );
}

/** Every budget the measurement misses or exceeds, as readable lines. Empty when within budget. */
export function budgetViolations(measured, budget = BUDGET) {
  return Object.entries(budget).flatMap(([key, limit]) => {
    const value = measured[key];
    if (value === null || value === undefined) return [`${key}: not reported by tsc`];
    return value > limit
      ? [`${key}: ${value.toLocaleString('en')} > budget ${limit.toLocaleString('en')}`]
      : [];
  });
}

function runTypecheck() {
  const nodeOptions = [process.env.NODE_OPTIONS ?? '', `--max-old-space-size=${STANDARD_HEAP_MB}`]
    .filter(Boolean)
    .join(' ');
  return spawnSync(
    process.execPath,
    [
      'node_modules/typescript/bin/tsc',
      '--noEmit',
      // A warm .tsbuildinfo would skip most of the work and hide growth.
      '--incremental',
      'false',
      '--extendedDiagnostics',
    ],
    {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
      env: { ...process.env, NODE_OPTIONS: nodeOptions },
    }
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = runTypecheck();
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  const measured = parseDiagnostics(output);
  const problems = budgetViolations(measured);
  if (result.status !== 0) {
    const reason = /heap out of memory/.test(output)
      ? `ran out of memory inside the standard ${STANDARD_HEAP_MB} MB heap`
      : `exited with ${result.status ?? result.signal}`;
    problems.unshift(`tsc ${reason}`);
    process.stderr.write(
      output
        .split('\n')
        .filter((line) => /error TS|FATAL/.test(line))
        .slice(0, 40)
        .join('\n') + '\n'
    );
  }
  console.log(
    Object.entries(measured)
      .map(
        ([key, value]) =>
          `${key.padEnd(16)} ${value ?? '-'}${key in BUDGET ? `  (budget ${BUDGET[key]})` : ''}`
      )
      .join('\n')
  );
  if (problems.length > 0) {
    console.error(`Type-check budget exceeded:\n- ${problems.join('\n- ')}`);
    process.exit(1);
  }
  console.log('Type check is within its memory and size budget.');
}
