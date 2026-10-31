// @vitest-environment node
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { expect, it, vi } from 'vitest';

const workflow = readFileSync('.github/workflows/qa.yml', 'utf8');
const assertion = workflow
  .split('      - name: Assert automated gate\n')[1]
  .split("          node <<'NODE'\n")[1]
  .split('\n          NODE')[0]
  .replace(/^          /gm, '');
const lanes = [
  'counter-evidence',
  'growth',
  'platform-concurrency',
  'price-intelligence',
  'returns',
  'boundary-http',
  'growth-ready',
  'growth-sandbox',
];
const passed = {
  numFailedTests: 0,
  numFailedTestSuites: 0,
  numPendingTests: 0,
  numPendingTestSuites: 0,
  numTodoTests: 0,
  numTotalTests: 1,
  numTotalTestSuites: 1,
  numPassedTests: 1,
  numPassedTestSuites: 1,
};

function assertGate(badLane?: string, mode?: 'missing' | 'skipped') {
  const read = vi.fn((path: string) => {
    if (path === 'gate/exit-codes.txt') return 'vitest=0';
    if (path === `gate/vitest-${badLane}.json`) {
      if (mode === 'missing') throw new Error('report missing');
      return JSON.stringify({ ...passed, numPendingTests: 1 });
    }
    return JSON.stringify(passed);
  });
  runInNewContext(assertion, {
    require: () => ({ readFileSync: read }),
    console: { log: vi.fn(), error: vi.fn() },
    process: {
      exit: (code: number) => {
        throw new Error(`exit ${code}`);
      },
    },
  });
}

it('accepts complete passing QA reports', () => {
  expect(() => assertGate()).not.toThrow();
});

it.each(lanes)('rejects missing or skipped %s evidence even when commands exit zero', (lane) => {
  expect(() => assertGate(lane, 'missing')).toThrow('exit 1');
  expect(() => assertGate(lane, 'skipped')).toThrow('exit 1');
});
