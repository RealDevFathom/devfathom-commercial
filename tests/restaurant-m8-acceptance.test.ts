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
    ['tests/restaurant-m8-governance.test.ts'],
  ],
  [
    'restricted-runtime tenant isolation and append-only enforcement',
    ['tests/restaurant-m8-rls.test.ts'],
  ],
] as const;

const ownerDatabaseUrl = process.env.M8_TEST_OWNER_DATABASE_URL;
const runtimeDatabaseUrl =
  process.env.M8_TEST_RUNTIME_DATABASE_URL ?? process.env.TEST_DATABASE_URL;

describe.skipIf(!ownerDatabaseUrl || !runtimeDatabaseUrl)('WHA-100 M8 acceptance battery', () => {
  it('requires separate migration-owner and restricted-runtime database connections', () => {
    expect(process.env.M8_TEST_OWNER_DATABASE_URL).toBeTruthy();
    expect(runtimeDatabaseUrl).toBeTruthy();
    expect(process.env.M8_TEST_OWNER_DATABASE_URL).not.toBe(runtimeDatabaseUrl);
  });

  it.each(contractGroups)(
    '%s',
    (_name, files) => {
      // The QA gate deliberately gives the shared Postgres lane one worker. Preserve that
      // isolation in these child runs instead of re-enabling Vitest's file parallelism.
      const result = spawnSync(
        'bunx',
        ['vitest', 'run', ...files, '--maxWorkers=1', '--no-file-parallelism'],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            DATABASE_URL: runtimeDatabaseUrl,
            TEST_DATABASE_URL: runtimeDatabaseUrl,
            M8_TEST_RUNTIME_DATABASE_URL: runtimeDatabaseUrl,
            M8_TEST_OWNER_DATABASE_URL: ownerDatabaseUrl,
          },
          encoding: 'utf8',
          timeout: 120_000,
        }
      );

      const output = [result.stdout, result.stderr].filter(Boolean).join('\n');
      expect(result.status, output).toBe(0);
      expect(output, output).not.toMatch(/\|\s+\d+ skipped/);
    },
    130_000
  );
});
