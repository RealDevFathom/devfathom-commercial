/**
 * DEV-937 — a refused request that names another branch is not planted in that
 * branch's audit log. Against migrated PostgreSQL with FORCE row level security,
 * as the NOSUPERUSER / NOBYPASSRLS runtime role.
 *
 * A North cashier and a South cashier each send `saveKhataReminderSettings`
 * naming South, and both are refused. The real tRPC audit middleware records
 * each refusal after the request's transaction rolls back, as the route does.
 * The real audit router then reads them back: South's manager sees only South's
 * own refusal, North's manager sees his cashier's refusal, and the owner sees
 * both. Nothing in `@/lib/abac` or `@/server/audit` is mocked.
 *
 * Fixture rows stay in the disposable database; audit rows are append-only.
 * Skipped unless TEST_DATABASE_URL names that role on a migrated disposable database.
 */
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const databaseUrl = process.env.TEST_DATABASE_URL;
if (databaseUrl) process.env.DATABASE_URL = databaseUrl;
const describeIfDatabase = databaseUrl ? describe : describe.skip;

const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const ids = {
  org: `org_audrf_${suffix}`,
  north: `br_audrf_n_${suffix}`,
  south: `br_audrf_s_${suffix}`,
  ownerRole: `role_audrf_own_${suffix}`,
  managerRole: `role_audrf_mgr_${suffix}`,
  cashierRole: `role_audrf_csh_${suffix}`,
  owner: `user_audrf_own_${suffix}`,
  northManager: `user_audrf_nmgr_${suffix}`,
  southManager: `user_audrf_smgr_${suffix}`,
  northCashier: `user_audrf_ncsh_${suffix}`,
  southCashier: `user_audrf_scsh_${suffix}`,
};

type Person = { id: string; role: 'ADMIN' | 'EMPLOYEE' };
const owner: Person = { id: ids.owner, role: 'ADMIN' };
const northManager: Person = { id: ids.northManager, role: 'ADMIN' };
const southManager: Person = { id: ids.southManager, role: 'ADMIN' };
const northCashier: Person = { id: ids.northCashier, role: 'EMPLOYEE' };
const southCashier: Person = { id: ids.southCashier, role: 'EMPLOYEE' };

const ACTION = 'pharmacySales.saveKhataReminderSettings';

let withTenantDb: typeof import('@/lib/tenancy/scoped-db').withTenantDb;
let withPlatformDb: typeof import('@/lib/tenancy/scoped-db').withPlatformDb;
let flushAuditWritesForTest: typeof import('@/server/audit').flushAuditWritesForTest;
/** Mounted under the app router's names, so paths and recorded actions match it. */
function mount(
  sales: (typeof import('./pharmacy-sales'))['pharmacySalesRouter'],
  audit: (typeof import('./audit'))['auditRouter'],
  router: (typeof import('../trpc'))['router']
) {
  return router({ pharmacySales: sales, audit });
}
let mounted: ReturnType<typeof mount>;
let disconnect: (() => Promise<void>) | null = null;

function context(db: unknown, user: Person) {
  return {
    db,
    entitlements: {
      organizationId: ids.org,
      vertical: 'PHARMACY',
      enabledModules: ['pharmacy-core', 'audit'],
      modules: [],
      limits: {},
      seatLimit: 10,
      activeSeats: 5,
    },
    session: {
      expires: 'later',
      user: {
        id: user.id,
        name: user.id,
        role: user.role,
        department: 'LEADERSHIP',
        status: 'ACTIVE',
        organizationId: ids.org,
      },
    },
    organization: { id: ids.org, vertical: 'PHARMACY' },
    support: null,
    requestMeta: { ip: null, userAgent: null },
    // As the tRPC route runs a request: a refusal is recorded after its
    // transaction rolls back, in a transaction of its own.
    audit: { detail: {} },
  } as unknown as import('../trpc').TRPCContext;
}

type Api = ReturnType<ReturnType<typeof mount>['createCaller']>;
type SalesCaller = ReturnType<
  (typeof import('./pharmacy-sales'))['pharmacySalesRouter']['createCaller']
>;
const salesOf = (api: Api) => api.pharmacySales as unknown as SalesCaller;

/** One request in its own tenant transaction, the way the tRPC route runs it. */
function act<T>(user: Person, run: (api: Api) => Promise<T>): Promise<T> {
  return withTenantDb(ids.org, (db) => run(mounted.createCaller(context(db, user))), {
    timeout: 60_000,
  });
}

/** A request naming South that the server refuses, and its entry flushed. */
async function refusedAtSouth(user: Person) {
  await expect(
    act(user, (api) =>
      salesOf(api).saveKhataReminderSettings({
        branchId: ids.south,
        revision: 0,
        settings: {},
      } as never)
    )
  ).rejects.toBeDefined();
  await flushAuditWritesForTest();
}

beforeAll(async () => {
  if (!databaseUrl) return;
  const scoped = await import('@/lib/tenancy/scoped-db');
  const { seedDepartments } = await import('@/lib/test-support/departments');
  const { PHARMACY_ROLE_TEMPLATES } = await import('@/lib/vertical-catalog');
  const { db } = await import('@/lib/db');
  mounted = mount(
    (await import('./pharmacy-sales')).pharmacySalesRouter,
    (await import('./audit')).auditRouter,
    (await import('../trpc')).router
  );
  withTenantDb = scoped.withTenantDb;
  withPlatformDb = scoped.withPlatformDb;
  flushAuditWritesForTest = (await import('@/server/audit')).flushAuditWritesForTest;
  disconnect = () => db.$disconnect();

  const [role] = await withPlatformDb((tx) =>
    tx.$queryRawUnsafe<Array<{ rolsuper: boolean; rolbypassrls: boolean }>>(
      'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user'
    )
  );
  expect(role).toEqual({ rolsuper: false, rolbypassrls: false });
  const [auditTable] = await withPlatformDb((tx) =>
    tx.$queryRawUnsafe<Array<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>>(
      `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'audit_logs'`
    )
  );
  expect(auditTable).toEqual({ relrowsecurity: true, relforcerowsecurity: true });

  await withPlatformDb((tx) =>
    tx.$executeRawUnsafe(
      `INSERT INTO organizations (id, slug, "legalName", "displayName", vertical, status, "deploymentMode", "createdAt", "updatedAt")
       VALUES ($1, $1, 'Audit refusals', 'Audit refusals', 'PHARMACY', 'ACTIVE', 'SHARED', now(), now())`,
      ids.org
    )
  );

  const address = { addressLine: '1 Road', city: 'Lahore', provinceCode: 'PB' };
  const capabilities = (key: string) =>
    PHARMACY_ROLE_TEMPLATES.find((r) => r.key === key)!.capabilities.map((capability) => ({
      capability,
      effect: 'ALLOW' as const,
    }));
  await withTenantDb(ids.org, async (tx) => {
    await seedDepartments(tx, [ids.org], ['LEADERSHIP']);
    await tx.pharmacyBranch.createMany({
      data: [
        { id: ids.north, code: 'N', name: 'North', ...address },
        { id: ids.south, code: 'S', name: 'South', ...address },
      ],
    });
    await tx.organizationRole.create({
      data: {
        id: ids.ownerRole,
        key: 'admin',
        name: 'Organization administrator',
        isSystem: true,
        permissions: { create: [{ capability: '*', effect: 'ALLOW' }] },
      },
    });
    await tx.organizationRole.create({
      data: {
        id: ids.managerRole,
        key: `manager-${suffix}`,
        name: 'Branch manager',
        permissions: { create: capabilities('manager') },
      },
    });
    await tx.organizationRole.create({
      data: {
        id: ids.cashierRole,
        key: `cashier-${suffix}`,
        name: 'Cashier',
        permissions: { create: capabilities('cashier') },
      },
    });
    for (const [person, roleId] of [
      [owner, ids.ownerRole],
      [northManager, ids.managerRole],
      [southManager, ids.managerRole],
      [northCashier, ids.cashierRole],
      [southCashier, ids.cashierRole],
    ] as const) {
      await tx.user.create({
        data: {
          id: person.id,
          name: person.id,
          email: `${person.id}@example.test`,
          department: 'LEADERSHIP',
          title: person.role === 'ADMIN' ? 'Administrator' : 'Cashier',
          role: person.role,
          status: 'ACTIVE',
          organizationRoleId: roleId,
        },
      });
    }
    await tx.pharmacyBranchAssignment.createMany({
      data: [
        { userId: ids.northManager, branchId: ids.north },
        { userId: ids.northCashier, branchId: ids.north },
        { userId: ids.southManager, branchId: ids.south },
        { userId: ids.southCashier, branchId: ids.south },
      ],
    });
  });

  await refusedAtSouth(northCashier);
  await refusedAtSouth(southCashier);
}, 120_000);

afterAll(async () => {
  await disconnect?.();
});

describeIfDatabase('DEV-937 refused requests naming another branch (runtime role)', () => {
  it('records the refusal at the branch the person works at, not the one named', async () => {
    const rows = await withTenantDb(ids.org, (tx) =>
      tx.auditLog.findMany({
        where: { organizationId: ids.org, action: ACTION },
        select: { actorId: true, metadata: true, input: true, outcome: true },
      })
    );
    expect(rows).toHaveLength(2);
    const byActor = new Map(rows.map((row) => [row.actorId, row]));
    for (const row of rows) {
      expect(row.outcome).toBe('FAILURE');
      // Both requests named South.
      expect(row.input).toMatchObject({ branchId: ids.south });
    }
    expect(byActor.get(ids.northCashier)?.metadata).toMatchObject({
      requestedBranchId: ids.south,
      actorBranchIds: [ids.north],
    });
    expect(byActor.get(ids.northCashier)?.metadata).not.toHaveProperty('branchId');
    expect(byActor.get(ids.southCashier)?.metadata).toMatchObject({ branchId: ids.south });
    expect(byActor.get(ids.southCashier)?.metadata).not.toHaveProperty('requestedBranchId');
  });

  it("is not shown to the named branch's manager", async () => {
    const page = await act(southManager, (api) => api.audit.list({ action: ACTION }));
    expect(page.items.map((item) => item.actorId)).toEqual([ids.southCashier]);
    expect(page.items[0]).toMatchObject({ branchId: ids.south, branchName: 'South' });
    const failures = await act(southManager, (api) =>
      api.audit.list({ action: ACTION, outcome: 'FAILURE', branchId: ids.south })
    );
    expect(failures.items.map((item) => item.actorId)).toEqual([ids.southCashier]);
  });

  it("is shown to the manager of the person's own branch", async () => {
    const page = await act(northManager, (api) => api.audit.list({ action: ACTION }));
    expect(page.items.map((item) => item.actorId)).toEqual([ids.northCashier]);
    expect(page.items[0]).toMatchObject({ branchId: null, branchName: null });
  });

  it('is shown to the owner, who sees every refusal', async () => {
    const all = await act(owner, (api) => api.audit.list({ action: ACTION }));
    expect(all.items.map((item) => item.actorId).sort()).toEqual(
      [ids.northCashier, ids.southCashier].sort()
    );
    const south = await act(owner, (api) =>
      api.audit.list({ action: ACTION, branchId: ids.south })
    );
    expect(south.items.map((item) => item.actorId)).toEqual([ids.southCashier]);
    const north = await act(owner, (api) =>
      api.audit.list({ action: ACTION, branchId: ids.north })
    );
    expect(north.items.map((item) => item.actorId)).toEqual([ids.northCashier]);
  });
});
