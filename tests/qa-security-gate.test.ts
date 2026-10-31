// @vitest-environment node
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

const workflow = readFileSync(new URL('../.github/workflows/qa.yml', import.meta.url), 'utf8');
const assertion = workflow
  .split('- name: Assert automated gate')[1]!
  .split("node <<'NODE'\n")[1]!
  .split('\n          NODE')[0]!;
const suites = Object.fromEntries(
  [...assertion.matchAll(/'([^']+\.test\.ts)': (\d+)/g)].map(([, file, minimum]) => [
    file!,
    Number(minimum),
  ])
);

function passingReport() {
  return {
    numFailedTests: 0,
    numFailedTestSuites: 0,
    numTodoTests: 0,
    numPendingTests: 0,
    numPendingTestSuites: 0,
    numTotalTests: 1000,
    numTotalTestSuites: 100,
    numPassedTests: 1000,
    numPassedTestSuites: 100,
    testResults: Object.entries(suites).map(([file, minimum]) => ({
      name: `/workspace/${file}`,
      status: 'passed',
      assertionResults: Array.from({ length: minimum }, () => ({ status: 'passed' })),
    })),
  };
}

function runGate(change?: (report: ReturnType<typeof passingReport>) => void) {
  const report = passingReport();
  change?.(report);
  let exitCode = 0;
  runInNewContext(assertion, {
    require: () => ({
      readFileSync: (file: string) =>
        file.endsWith('exit-codes.txt') ? 'vitest=0' : JSON.stringify(report),
    }),
    console: { log() {}, error() {} },
    process: {
      exit: (code: number) => {
        exitCode = code;
      },
    },
  });
  return exitCode;
}

describe('required authorization and RLS CI evidence', () => {
  it('passes collected security suites', () => {
    expect(Object.keys(suites)).toContain('src/lib/pharmacy/purchasing-security.db.test.ts');
    expect(runGate()).toBe(0);
  });
  it.each(Object.keys(suites))('refuses skipped or missing security evidence for %s', (file) => {
    expect(
      runGate((report) => {
        const suite = report.testResults.find((entry) => entry.name.endsWith(file))!;
        suite.assertionResults[0]!.status = 'pending';
      })
    ).toBe(1);
    expect(
      runGate((report) => {
        report.testResults = report.testResults.filter(
          (entry: { name: string }) => !entry.name.endsWith(file)
        );
      })
    ).toBe(1);
    expect(
      runGate((report) => {
        const suite = report.testResults.find((entry) => entry.name.endsWith(file))!;
        suite.assertionResults.pop();
      })
    ).toBe(1);
  });
});
