/** WHA-100 — isolated M8 API/reconciliation/privacy acceptance battery. */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';

import { beforeAll, describe, expect, it } from 'vitest';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
if (!TEST_DATABASE_URL) {
  throw new Error(
    'WHA-100 requires TEST_DATABASE_URL for its real PostgreSQL acceptance gate; refusing to skip DB coverage.'
  );
}

// scoped-db's Prisma client reads DATABASE_URL when first imported. Keep every
// dynamic import below this assignment so the acceptance gate cannot silently
// exercise a different database than the disposable runtime-role database.
process.env.DATABASE_URL = TEST_DATABASE_URL;

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
  beforeAll(async () => {
    const [{ assertRlsEnforcingRole }, { withPlatformDb }] = await Promise.all([
      import('@/lib/testing/rls-role-guard'),
      import('@/lib/tenancy/scoped-db'),
    ]);

    await assertRlsEnforcingRole(withPlatformDb);

    const expectedDatabase = decodeURIComponent(new URL(TEST_DATABASE_URL).pathname.slice(1));
    const sentinelId = `org_wha100_sentinel_${randomBytes(8).toString('hex')}`;

    await withPlatformDb(async (db) => {
      const [identity] = await db.$queryRawUnsafe<
        Array<{
          current_database: string;
          current_user: string;
          rolsuper: boolean;
          rolbypassrls: boolean;
        }>
      >(`
        SELECT current_database(), current_user, rolsuper, rolbypassrls
        FROM pg_roles
        WHERE rolname = current_user
      `);

      expect(identity).toMatchObject({
        current_database: expectedDatabase,
        rolsuper: false,
        rolbypassrls: false,
      });
      expect(identity?.current_user).toBeTruthy();

      await db.organization.create({
        data: {
          id: sentinelId,
          slug: sentinelId.replaceAll('_', '-'),
          legalName: 'WHA-100 acceptance sentinel',
          displayName: 'WHA-100 acceptance sentinel',
          status: 'ACTIVE',
        },
      });

      try {
        const sentinel = await db.organization.findUnique({ where: { id: sentinelId } });
        expect(sentinel?.id).toBe(sentinelId);
      } finally {
        await db.organization.deleteMany({ where: { id: sentinelId } });
      }
    });
  });

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
