/**
 * DEV-859 staged review against migrated PostgreSQL with FORCED row-level security.
 *
 * The mock-based suite proves that `stageBatch` asks for the right scope. These
 * cases prove the database enforces it: an org A admin staging a file against
 * an org B branch is refused, and nothing for org B is written. Synthetic data
 * only. Skipped (never silently passed) when the database URLs are absent.
 */
import { randomBytes } from 'node:crypto';
import { beforeAll, describe, expect, it, vi } from 'vitest';

const TEST_DATABASE_URL = process.env.M8_TEST_RUNTIME_DATABASE_URL ?? process.env.TEST_DATABASE_URL;
const OWNER_DATABASE_URL = process.env.M8_TEST_OWNER_DATABASE_URL;
if (TEST_DATABASE_URL) process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.PLATFORM_ENCRYPTION_KEY ??= randomBytes(32).toString('base64');

const describeIfDatabase = TEST_DATABASE_URL && OWNER_DATABASE_URL ? describe : describe.skip;

vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn(async () => null) }));
vi.mock('@/server/audit', () => ({
  annotateAudit: vi.fn(),
  ipFromHeaders: vi.fn(() => null),
  isAuditExcludedPath: vi.fn(() => true),
  recordTrpcAudit: vi.fn(),
}));

type ScopedDb = import('@/lib/tenancy/scoped-db').ScopedDb;

const suffix = randomBytes(5).toString('hex');
const ORG_A = `dev859_a_${suffix}`;
const ORG_B = `dev859_b_${suffix}`;
const BRANCH_A = `dev859_ba_${suffix}`;
const BRANCH_B = `dev859_bb_${suffix}`;

let withTenantDb: (typeof import('@/lib/tenancy/scoped-db'))['withTenantDb'];
let withPlatformDb: (typeof import('@/lib/tenancy/scoped-db'))['withPlatformDb'];
let pharmacyStagedReviewRouter: typeof import('./pharmacy-staged-review').pharmacyStagedReviewRouter;

function context(db: ScopedDb, organizationId: string) {
  return {
    db,
    entitlements: {
      organizationId,
      enabledModules: ['pharmacy-core'],
      modules: [],
      limits: {},
      seatLimit: 10,
      activeSeats: 1,
    },
    session: {
      expires: 'later',
      user: {
        id: `${organizationId}_admin`,
        role: 'ADMIN',
        status: 'ACTIVE',
        organizationId,
      },
    },
    organization: { id: organizationId },
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as never;
}

const stagingFor = (branchId: string) => ({
  branchId,
  fileName: `synthetic-${suffix}.csv`,
  content: Buffer.from('Product,Pack,Qty\nExample,30,29').toString('base64'),
  mapping: { product: 0, pack: 1, quantity: 2 },
  quantityUnit: 'PACKS' as const,
});

const stagingCaller = (db: ScopedDb, organizationId: string) =>
  pharmacyStagedReviewRouter.createCaller(context(db, organizationId)).pharmacyMedicine;

describeIfDatabase('DEV-859 staged review against PostgreSQL', () => {
  beforeAll(async () => {
    ({ withTenantDb, withPlatformDb } = await import('@/lib/tenancy/scoped-db'));
    ({ pharmacyStagedReviewRouter } = await import('./pharmacy-staged-review'));
    const { assertRlsEnforcingRole } = await import('@/lib/testing/rls-role-guard');
    await assertRlsEnforcingRole(withPlatformDb);

    // Branches are tenant-owned rows, so each one is created through its own tenant path.
    for (const [organizationId, branchId] of [
      [ORG_A, BRANCH_A],
      [ORG_B, BRANCH_B],
    ] as const) {
      await withTenantDb(organizationId, (db) =>
        db.pharmacyBranch.create({
          data: {
            id: branchId,
            organizationId,
            code: branchId,
            name: `Branch ${branchId}`,
            addressLine: '1 Synthetic Road',
            city: 'Lahore',
            provinceCode: 'PB',
          },
        })
      );
    }
  }, 60_000);

  it('stages a batch into the caller’s own branch', async () => {
    const saved = await withTenantDb(ORG_A, (db) =>
      stagingCaller(db, ORG_A).stageBatch(stagingFor(BRANCH_A))
    );
    expect(saved.batchId).toBeTruthy();

    const batch = await withPlatformDb((db) =>
      db.pharmacyMigrationBatch.findFirst({ where: { id: saved.batchId } })
    );
    expect(batch?.organizationId).toBe(ORG_A);
  });

  it('refuses an org B branch from org A and writes nothing for org B', async () => {
    const before = await withPlatformDb((db) =>
      Promise.all([
        db.pharmacyMigrationSource.count({ where: { organizationId: ORG_B } }),
        db.pharmacyMigrationBatch.count({ where: { organizationId: ORG_B } }),
        db.pharmacyMigrationRow.count({ where: { organizationId: ORG_B } }),
      ])
    );

    await expect(
      withTenantDb(ORG_A, (db) => stagingCaller(db, ORG_A).stageBatch(stagingFor(BRANCH_B)))
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    const after = await withPlatformDb((db) =>
      Promise.all([
        db.pharmacyMigrationSource.count({ where: { organizationId: ORG_B } }),
        db.pharmacyMigrationBatch.count({ where: { organizationId: ORG_B } }),
        db.pharmacyMigrationRow.count({ where: { organizationId: ORG_B } }),
      ])
    );
    expect(after).toEqual(before);
  });
});
