/**
 * @vitest-environment node
 *
 * DEV-876: the counter's reads against a REAL migrated PostgreSQL, through the
 * real router, each call in its own tenant transaction the way each HTTP request
 * runs. A cashier holds an active assignment to Main Branch and an inactive one
 * to DHA Branch, both active branches of one organization. Every counter read
 * of DHA is refused by the real assignment query; Main is read; a session ADMIN
 * of the organization still reads DHA; another organization's branch stays
 * invisible.
 *
 * Requires TEST_DATABASE_URL: a disposable, migrated database reached as the
 * restricted runtime role (neither SUPERUSER nor BYPASSRLS — asserted first).
 * Without it the suite reports itself skipped rather than passing vacuously.
 */
import { randomBytes } from 'node:crypto';

import { beforeAll, describe, expect, it, vi } from 'vitest';
import { workspaceToday } from '@/lib/timezone';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
// `@/lib/db` reads DATABASE_URL on first use; everything that reaches it is
// imported inside the suite, after this line.
if (TEST_DATABASE_URL) process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.PLATFORM_ENCRYPTION_KEY ??= randomBytes(32).toString('base64');

vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn(async () => null) }));
vi.mock('@/server/audit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/audit')>()),
  recordTrpcAudit: vi.fn(),
}));

const describeIfDatabase = TEST_DATABASE_URL ? describe : describe.skip;
const suffix = randomBytes(6).toString('hex');
const ORG = `counter_read_a_${suffix}`;
const OTHER_ORG = `counter_read_b_${suffix}`;
const MAIN = `counter_read_main_${suffix}`;
const DHA = `counter_read_dha_${suffix}`;
const FOREIGN = `counter_read_foreign_${suffix}`;
const CASHIER = `counter_read_cashier_${suffix}`;
const OWNER = `counter_read_owner_${suffix}`;
const DEVICE = 'counter-device-1';
const OUTSIDE = { code: 'FORBIDDEN', message: 'Branch is outside your scope.' };
const NOT_IN_WORKSPACE = { code: 'BAD_REQUEST', message: 'That record is not in this workspace.' };

type ScopedDb = import('@/lib/tenancy/scoped-db').ScopedDb;
type Role = 'ADMIN' | 'EMPLOYEE';
let withTenantDb: (typeof import('@/lib/tenancy/scoped-db'))['withTenantDb'];
let withPlatformDb: (typeof import('@/lib/tenancy/scoped-db'))['withPlatformDb'];

async function sales(db: ScopedDb, userId: string, role: Role) {
  const { pharmacySalesRouter } = await import('./pharmacy-sales');
  return pharmacySalesRouter.createCaller({
    db,
    entitlements: {
      organizationId: ORG,
      enabledModules: ['pharmacy-core', 'pharmacy-counter'],
      modules: [],
      limits: {},
      seatLimit: 10,
      activeSeats: 2,
    },
    session: {
      expires: 'later',
      user: { id: userId, role, status: 'ACTIVE', organizationId: ORG },
    },
    organization: { id: ORG, vertical: 'PHARMACY' },
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as never);
}
type Caller = Awaited<ReturnType<typeof sales>>;

/** One request by `userId`, in ORG's tenant transaction. */
function as<T>(userId: string, role: Role, run: (caller: Caller) => Promise<T>): Promise<T> {
  return withTenantDb(ORG, async (db) => run(await sales(db, userId, role)), { userId });
}

async function createBranch(organizationId: string, id: string) {
  await withTenantDb(organizationId, (db) =>
    db.pharmacyBranch.create({
      data: {
        id,
        organizationId,
        code: id,
        name: `Branch ${id}`,
        addressLine: '1 Synthetic Road',
        city: 'Lahore',
        provinceCode: 'PB',
      },
    })
  );
}

const reads: Array<[string, (caller: Caller, branchId: string) => Promise<unknown>]> = [
  ['counterSearch', (c, branchId) => c.counterSearch({ branchId, query: 'panadol' })],
  ['customerSnapshot', (c, branchId) => c.customerSnapshot({ branchId, customerId: 'customer-1' })],
  [
    'counterLotOptions',
    (c, branchId) => c.counterLotOptions({ branchId, medicineId: 'medicine-1' }),
  ],
  ['drawerStatus', (c, branchId) => c.drawerStatus({ branchId, deviceId: DEVICE })],
  [
    'tenderOutcome',
    (c, branchId) =>
      c.tenderOutcome({
        branchId,
        saleId: 'sale-1',
        deviceId: DEVICE,
        businessDate: new Date(`${workspaceToday('Asia/Karachi')}T00:00:00.000Z`),
        type: 'CASH',
        amountMinor: 500,
        cashReceivedMinor: 500,
        idempotencyKey: 'tender-1',
      }),
  ],
  [
    'substituteProposals',
    (c, branchId) =>
      c.substituteProposals({
        branchId,
        medicineId: 'medicine-1',
        presentationId: 'presentation-1',
        quantityCanonicalUnits: 10,
      }),
  ],
  [
    'upsellSuggestions',
    (c, branchId) => c.upsellSuggestions({ branchId, medicineIds: ['medicine-1'] }),
  ],
  ['authenticatePack', (c, branchId) => c.authenticatePack({ branchId, payload: '0100' })],
];

describeIfDatabase('pharmacy counter reads and branch assignment, against PostgreSQL', () => {
  beforeAll(async () => {
    const scoped = await import('@/lib/tenancy/scoped-db');
    withTenantDb = scoped.withTenantDb;
    withPlatformDb = scoped.withPlatformDb;
    const { assertRlsEnforcingRole } = await import('@/lib/testing/rls-role-guard');
    const { seedDepartments } = await import('@/lib/test-support/departments');
    await assertRlsEnforcingRole(withPlatformDb);
    await withPlatformDb((db) =>
      db.$executeRawUnsafe(
        `INSERT INTO organizations (id, slug, "legalName", "displayName", vertical, status, "deploymentMode", "createdAt", "updatedAt")
         SELECT id, id, id, id, 'PHARMACY', 'ACTIVE', 'SHARED', now(), now() FROM unnest($1::text[]) AS id`,
        [ORG, OTHER_ORG]
      )
    );
    await createBranch(ORG, MAIN);
    await createBranch(ORG, DHA);
    await createBranch(OTHER_ORG, FOREIGN);
    await withTenantDb(ORG, async (db) => {
      await seedDepartments(db, [ORG], ['LEADERSHIP']);
      for (const [id, role] of [
        [CASHIER, 'EMPLOYEE'],
        [OWNER, 'ADMIN'],
      ] as const) {
        await db.user.create({
          data: {
            id,
            name: id,
            email: `${id}@example.test`,
            department: 'LEADERSHIP',
            title: 'Counter',
            role,
          },
        });
      }
      // Main is the cashier's branch; the DHA assignment was ended. The owner has none.
      await db.pharmacyBranchAssignment.createMany({
        data: [
          { userId: CASHIER, branchId: MAIN },
          { userId: CASHIER, branchId: DHA, active: false },
        ],
      });
    });
  }, 120_000);

  it.each(reads)('%s refuses the cashier at DHA Branch', async (_name, run) => {
    await expect(as(CASHIER, 'EMPLOYEE', (c) => run(c, DHA))).rejects.toMatchObject(OUTSIDE);
  });

  it.each(reads)('%s keeps another organization’s branch out of the workspace', async (_n, run) => {
    await expect(as(CASHIER, 'EMPLOYEE', (c) => run(c, FOREIGN))).rejects.toMatchObject(
      NOT_IN_WORKSPACE
    );
  });

  it('reads the drawer of the cashier’s own branch', async () => {
    await expect(
      as(CASHIER, 'EMPLOYEE', (c) => c.drawerStatus({ branchId: MAIN, deviceId: DEVICE }))
    ).resolves.toEqual({ openDrawer: null, operatingCashier: null });
  });

  it('lets the organization’s session ADMIN read a branch without an assignment', async () => {
    await expect(
      as(OWNER, 'ADMIN', (c) => c.drawerStatus({ branchId: DHA, deviceId: DEVICE }))
    ).resolves.toEqual({ openDrawer: null, operatingCashier: null });
  });
});
