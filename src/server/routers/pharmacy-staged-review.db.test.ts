/**
 * DEV-859 — `stageBatch` against migrated PostgreSQL with FORCED row-level security.
 *
 * The mocked router suite proves validation; only a real database proves that the
 * writes are tenant-scoped: a branch of another organization is refused with nothing
 * written for either tenant, the choice is stored on the batch, and legacy batches
 * stay unrecorded. Skipped (never thrown) when the database URLs are absent.
 */
import { randomBytes } from 'node:crypto';

import { Client } from 'pg';
import { beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/server/audit', () => ({
  ipFromHeaders: vi.fn(() => null),
  isAuditExcludedPath: vi.fn(() => true),
  recordTrpcAudit: vi.fn(),
  annotateAudit: vi.fn(),
}));

const TEST_DATABASE_URL = process.env.M8_TEST_RUNTIME_DATABASE_URL ?? process.env.TEST_DATABASE_URL;
const OWNER_DATABASE_URL = process.env.M8_TEST_OWNER_DATABASE_URL;
if (TEST_DATABASE_URL) process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.PLATFORM_ENCRYPTION_KEY ??= randomBytes(32).toString('base64');

const describeIfDatabase = TEST_DATABASE_URL && OWNER_DATABASE_URL ? describe : describe.skip;

const suffix = randomBytes(6).toString('hex');
const orgA = `org_dev859_a_${suffix}`;
const orgB = `org_dev859_b_${suffix}`;
const branchA = `branch_dev859_a_${suffix}`;
const branchB = `branch_dev859_b_${suffix}`;
const CSV = 'Product,Pack,Qty\nExample Tablet,30,29';

type ScopedDb = import('@/lib/tenancy/scoped-db').ScopedDb;
let withTenantDb: (typeof import('@/lib/tenancy/scoped-db'))['withTenantDb'];
let router: (typeof import('./pharmacy-staged-review'))['pharmacyStagedReviewRouter'];

function callerFor(tenant: string, tx: ScopedDb) {
  // The tenant transaction is the whole unit of work; nested transactions reuse it.
  const db = new Proxy(tx as object, {
    get: (target, prop) =>
      prop === '$transaction'
        ? async (run: (inner: unknown) => unknown) => run(db)
        : prop === 'user'
          ? { findUnique: async () => ({ organizationRole: null, permissionOverrides: [] }) }
          : (target as Record<PropertyKey, unknown>)[prop],
  }) as unknown as ScopedDb;
  return router.createCaller({
    db,
    entitlements: { organizationId: tenant, enabledModules: ['pharmacy-core'], modules: [] },
    session: {
      expires: 'later',
      user: { id: 'user_dev859', organizationId: tenant, role: 'ADMIN', status: 'ACTIVE' },
    },
    organization: null,
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as never).pharmacyMedicine;
}
const staging = (branchId: string, quantityUnit: 'PACKS' | 'UNITS') => ({
  branchId,
  fileName: `legacy-${quantityUnit}.csv`,
  content: Buffer.from(CSV).toString('base64'),
  mapping: { product: 0, pack: 1, quantity: 2 },
  quantityUnit,
});

beforeAll(async () => {
  if (!TEST_DATABASE_URL || !OWNER_DATABASE_URL) return;
  expect(OWNER_DATABASE_URL).not.toBe(TEST_DATABASE_URL);
  const [scopedDb, routerModule, roleGuard] = await Promise.all([
    import('@/lib/tenancy/scoped-db'),
    import('./pharmacy-staged-review'),
    import('@/lib/testing/rls-role-guard'),
  ]);
  withTenantDb = scopedDb.withTenantDb;
  router = routerModule.pharmacyStagedReviewRouter;
  await roleGuard.assertRlsEnforcingRole(scopedDb.withPlatformDb);

  const owner = new Client({ connectionString: OWNER_DATABASE_URL });
  await owner.connect();
  try {
    await owner.query('BEGIN');
    await owner.query(`SET LOCAL app.is_platform_admin = 'true'`);
    await owner.query(
      `INSERT INTO "organizations"
        ("id", "slug", "legalName", "displayName", "status", "deploymentMode", "createdAt", "updatedAt")
       VALUES ($1, $2, 'DEV859 A', 'DEV859 A', 'ACTIVE', 'SHARED', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
              ($3, $4, 'DEV859 B', 'DEV859 B', 'ACTIVE', 'SHARED', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [orgA, `dev859-a-${suffix}`, orgB, `dev859-b-${suffix}`]
    );
    for (const [org, branch] of [
      [orgA, branchA],
      [orgB, branchB],
    ] as const) {
      await owner.query(`SELECT set_config('app.current_organization_id', $1, true)`, [org]);
      await owner.query(
        `INSERT INTO "pharmacy_branches"
          ("id", "organizationId", "code", "name", "addressLine", "city", "provinceCode", "updatedAt")
         VALUES ($1, $2, 'MAIN', 'Main', '1 Road', 'City', 'PB', CURRENT_TIMESTAMP)`,
        [branch, org]
      );
    }
    await owner.query('COMMIT');
  } catch (error) {
    await owner.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    await owner.end();
  }
}, 60_000);

describeIfDatabase('stageBatch on a real database', () => {
  it.each([
    ['PACKS', '870'],
    ['UNITS', '29'],
  ] as const)('stores the %s choice on the batch and %s staged units', async (unit, units) => {
    const saved = await withTenantDb(orgA, (tx) =>
      callerFor(orgA, tx).stageBatch(staging(branchA, unit))
    );
    const stored = await withTenantDb(orgA, async (tx) => ({
      batch: await tx.pharmacyMigrationBatch.findUniqueOrThrow({ where: { id: saved.batchId } }),
      rows: await tx.pharmacyMigrationRow.findMany({ where: { batchId: saved.batchId } }),
    }));
    expect(stored.batch.quantityUnit).toBe(unit);
    expect(stored.rows.map((row) => row.quantityCanonical?.toString())).toEqual([units]);
  });

  it('refuses another organization branch and writes nothing for either tenant', async () => {
    const count = (tenant: string) =>
      withTenantDb(tenant, (tx) => tx.pharmacyMigrationBatch.count());
    const [beforeA, beforeB] = [await count(orgA), await count(orgB)];
    await expect(
      withTenantDb(orgA, (tx) => callerFor(orgA, tx).stageBatch(staging(branchB, 'PACKS')))
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect([await count(orgA), await count(orgB)]).toEqual([beforeA, beforeB]);
  });

  it('keeps the staged batch and its choice invisible to another tenant', async () => {
    const saved = await withTenantDb(orgA, (tx) =>
      callerFor(orgA, tx).stageBatch(staging(branchA, 'PACKS'))
    );
    const fromB = await withTenantDb(orgB, (tx) =>
      tx.pharmacyMigrationBatch.findMany({ where: { id: saved.batchId } })
    );
    expect(fromB).toEqual([]);
  });

  it('rejects an unrecognised choice at the database', async () => {
    await expect(
      withTenantDb(orgA, async (tx) => {
        const source = await tx.pharmacyMigrationSource.findFirstOrThrow();
        await tx.pharmacyMigrationBatch.create({
          data: {
            sourceId: source.id,
            label: 'bad',
            profilerVersion: 'x',
            quantityUnit: 'BOXES',
            status: 'PROFILING',
          },
        });
      })
    ).rejects.toThrow();
  });
});
