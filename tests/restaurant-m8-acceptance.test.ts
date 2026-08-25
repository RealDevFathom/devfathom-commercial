/** WHA-100 — isolated M8 API/reconciliation/privacy acceptance battery. */
import { spawnSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';

const contractGroups = [
  [
    'customer identity, consent, export, anonymization and audit',
    [
      'src/lib/restaurant/customer-privacy.test.ts',
      'src/lib/restaurant/customers.test.ts',
      'src/server/routers/restaurant-customers.test.ts',
    ],
  ],
  [
    'loyalty program, limit, ledger, earn/redeem/refund and FIFO expiry',
    [
      'src/lib/restaurant/loyalty.test.ts',
      'src/lib/restaurant/loyalty-expiry.test.ts',
      'src/lib/restaurant/loyalty-lifecycle.db.test.ts',
      'src/lib/restaurant/refunds.test.ts',
      'src/server/routers/restaurant-loyalty.test.ts',
    ],
  ],
  [
    'scheduler rollup, backfill, rebuild and report privacy/access',
    [
      'src/lib/restaurant/insight-rollups.test.ts',
      'src/lib/restaurant/insights.test.ts',
      'src/lib/restaurant/daily-close.test.ts',
      'src/lib/restaurant/scheduler.test.ts',
      'src/server/routers/restaurant-insights.test.ts',
    ],
  ],
  [
    'strict API governance, capability defaults and database enforcement',
    ['tests/restaurant-m8-governance.test.ts', 'tests/restaurant-m8-rls.test.ts'],
  ],
] as const;

describe('WHA-100 M8 acceptance battery', () => {
  it.each(contractGroups)(
    '%s',
    (_name, files) => {
      const result = spawnSync('bunx', ['vitest', 'run', ...files], {
        cwd: process.cwd(),
        env: process.env,
        encoding: 'utf8',
        timeout: 120_000,
      });

      expect(result.status, [result.stdout, result.stderr].filter(Boolean).join('\n')).toBe(0);
    },
    130_000
  );
});
