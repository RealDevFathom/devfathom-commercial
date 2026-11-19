import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BUDGET,
  STANDARD_HEAP_MB,
  budgetViolations,
  parseDiagnostics,
} from './check-typecheck-budget.mjs';

// The tail of `tsc --noEmit --extendedDiagnostics` on develop at 081cfd1, before DEV-963.
const BEFORE_DEV_963 = `
Files:                         9252
Lines of Library:             53142
Lines of Definitions:       4186601
Types:                      2470913
Instantiations:             8597402
Memory used:               8586699K
Check time:                 158.66s
Total time:                 177.44s
`;

test('reads every budgeted figure from the extended diagnostics', () => {
  assert.deepEqual(parseDiagnostics(BEFORE_DEV_963), {
    files: 9252,
    types: 2470913,
    instantiations: 8597402,
    memoryUsedKB: 8586699,
    totalSeconds: 177.44,
  });
});

test('the type check that aborted before DEV-963 is over budget', () => {
  const problems = budgetViolations(parseDiagnostics(BEFORE_DEV_963));
  assert.ok(
    problems.some((line) => line.startsWith('memoryUsedKB:')),
    problems.join('\n')
  );
  assert.ok(
    problems.some((line) => line.startsWith('files:')),
    problems.join('\n')
  );
});

test('a measurement inside every budget passes', () => {
  assert.deepEqual(
    budgetViolations({
      files: 7915,
      types: 2471018,
      instantiations: 8597753,
      memoryUsedKB: 7101317,
    }),
    []
  );
});

test('growth in instantiations alone fails', () => {
  assert.deepEqual(budgetViolations({ ...BUDGET, instantiations: BUDGET.instantiations + 1 }), [
    `instantiations: ${(BUDGET.instantiations + 1).toLocaleString('en')} > budget ${BUDGET.instantiations.toLocaleString('en')}`,
  ]);
});

test('a figure tsc did not print fails instead of passing silently', () => {
  assert.deepEqual(budgetViolations(parseDiagnostics('error TS2322: nope')), [
    'memoryUsedKB: not reported by tsc',
    'types: not reported by tsc',
    'instantiations: not reported by tsc',
    'files: not reported by tsc',
  ]);
});

test('the memory budget leaves clear room inside the standard heap', () => {
  assert.ok(BUDGET.memoryUsedKB < STANDARD_HEAP_MB * 1024 * 0.93);
});
