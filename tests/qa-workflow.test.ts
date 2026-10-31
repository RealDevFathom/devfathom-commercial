// @vitest-environment node
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

const workflow = readFileSync('.github/workflows/qa.yml', 'utf8');
const assertion = workflow
  .split('      - name: Assert automated gate\n')[1]
  ?.match(/node <<'NODE'\n([\s\S]*?)\n          NODE/)?.[1];

const passingReport = {
  numFailedTests: 0,
  numFailedTestSuites: 0,
  numPendingTests: 0,
  numPendingTestSuites: 0,
  numTodoTests: 0,
  numTotalTests: 2,
  numTotalTestSuites: 2,
  numPassedTests: 2,
  numPassedTestSuites: 2,
};

function assertGate(overrides: Partial<typeof passingReport> = {}) {
  if (!assertion) throw new Error('Automated gate assertion script is missing.');
  runInNewContext(assertion, {
    require: (name: string) => {
      if (name !== 'fs') throw new Error(`Unexpected module: ${name}`);
      return {
        readFileSync: (path: string) =>
          path === 'gate/exit-codes.txt'
            ? 'vitest=0\nvitest-cohort=0\nvitest-receipt=0\nvitest-catering=0\n'
            : JSON.stringify({
                ...passingReport,
                ...(path === 'gate/vitest.json' ? overrides : {}),
              }),
      };
    },
    console: { log() {}, error() {} },
    process: {
      exit(code: number) {
        throw new Error(`Gate exited with ${code}`);
      },
    },
  });
}

describe('QA workflow automated gate', () => {
  it('accepts complete passing reports', () => {
    expect(() => assertGate()).not.toThrow();
  });

  it.each([
    { numPendingTests: 1, numPassedTests: 1 },
    { numPendingTestSuites: 1, numPassedTestSuites: 1 },
    { numFailedTests: 1, numPassedTests: 1 },
    { numFailedTestSuites: 1, numPassedTestSuites: 1 },
    { numTodoTests: 1 },
    { numPassedTests: 1 },
    { numPassedTestSuites: 1 },
    { numPendingTests: undefined },
    { numPendingTestSuites: undefined },
  ])('rejects incomplete or failing reports: %j', (overrides) => {
    expect(() => assertGate(overrides)).toThrow('Gate exited with 1');
  });
});
