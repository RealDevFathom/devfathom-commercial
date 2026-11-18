/**
 * DEV-913 — the branch tag on entries whose request names no branch, against
 * migrated PostgreSQL with FORCE row level security, as the NOSUPERUSER /
 * NOBYPASSRLS runtime role.
 *
 * `pharmacyPurchasing.submitRequisition` takes only a requisition id; its entry
 * now carries the requisition's branch, also for a purchaser assigned to that
 * branch (before, only the owner's unassigned access was tagged). The real tRPC
 * audit middleware writes
 * each entry through the request's own tenant transaction (`ctx.audit.db`), and
 * the real audit router reads them back: the owner sees both branches, an
 * administrator assigned to one branch sees that branch and not the other.
 * Nothing in `@/lib/abac` or `@/server/audit` is mocked.
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
  org: `org_audbr_${suffix}`,
  north: `br_audbr_n_${suffix}`,
  south: `br_audbr_s_${suffix}`,
  ownerRole: `role_audbr_own_${suffix}`,
  managerRole: `role_audbr_mgr_${suffix}`,
  owner: `user_audbr_own_${suffix}`,
  northAdmin: `user_audbr_nadm_${suffix}`,
  reqNorth: `req_audbr_n_${suffix}`,
  reqSouth: `req_audbr_s_${suffix}`,
};

type Person = { id: string; role: 'ADMIN' | 'EMPLOYEE' };

let withTenantDb: typeof import('@/lib/tenancy/scoped-db').withTenantDb;
let withPlatformDb: typeof import('@/lib/tenancy/scoped-db').withPlatformDb;
/** Mounted under the app router's names, so paths and recorded actions match it. */
function mount(
  purchasing: (typeof import('./pharmacy-purchasing'))['pharmacyPurchasingRouter'],
  audit: (typeof import('./audit'))['auditRouter'],
  router: (typeof import('../trpc'))['router']
) {
  return router({ pharmacyPurchasing: purchasing, audit });
}
let mounted: ReturnType<typeof mount>;
let disconnect: (() => Promise<void>) | null = null;

function context(db: unknown, user: Person) {
  return {
    db,
    entitlements: {
      organizationId: ids.org,
      vertical: 'PHARMACY',
      enabledModules: ['pharmacy-core', 'pharmacy-procurement', 'audit'],
      modules: [],
      limits: {},
      seatLimit: 10,
      activeSeats: 2,
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
    // As the tRPC route runs a request: the entry is written in its transaction.
    audit: { detail: {}, db },
  } as unknown as import('../trpc').TRPCContext;
}

type Api = ReturnType<ReturnType<typeof mount>['createCaller']>;
/**
 * The nested caller type of the purchasing router collapses to `never` in tRPC's
 * inference; the router's own caller type is exact, so the nested caller is read
 * through it. At runtime the nested caller is used, so paths are `pharmacyPurchasing.*`.
 */
type PurchasingCaller = ReturnType<
  (typeof import('./pharmacy-purchasing'))['pharmacyPurchasingRouter']['createCaller']
>;
const purchasingOf = (api: Api) => api.pharmacyPurchasing as unknown as PurchasingCaller;

/** One request in its own tenant transaction, the way the tRPC route runs it. */
function act<T>(user: Person, run: (api: Api) => Promise<T>): Promise<T> {
  return withTenantDb(ids.org, (db) => run(mounted.createCaller(context(db, user))), {
    timeout: 60_000,
  });
}

const owner: Person = { id: ids.owner, role: 'ADMIN' };
const northAdmin: Person = { id: ids.northAdmin, role: 'ADMIN' };

beforeAll(async () => {
  if (!databaseUrl) return;
  const scoped = await import('@/lib/tenancy/scoped-db');
  const { seedDepartments } = await import('@/lib/test-support/departments');
  const { PHARMACY_ROLE_TEMPLATES } = await import('@/lib/vertical-catalog');
  const { db } = await import('@/lib/db');
  mounted = mount(
    (await import('./pharmacy-purchasing')).pharmacyPurchasingRouter,
    (await import('./audit')).auditRouter,
    (await import('../trpc')).router
  );
  withTenantDb = scoped.withTenantDb;
  withPlatformDb = scoped.withPlatformDb;
  disconnect = () => db.$disconnect();

  const [role] = await withPlatformDb((tx) =>
    tx.$queryRawUnsafe<Array<{ rolsuper: boolean; rolbypassrls: boolean }>>(
      'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user'
    )
  );
  expect(role).toEqual({ rolsuper: false, rolbypassrls: false });

  await withPlatformDb((tx) =>
    tx.$executeRawUnsafe(
      `INSERT INTO organizations (id, slug, "legalName", "displayName", vertical, status, "deploymentMode", "createdAt", "updatedAt")
       VALUES ($1, $1, 'Audit branches', 'Audit branches', 'PHARMACY', 'ACTIVE', 'SHARED', now(), now())`,
      ids.org
    )
  );

  const address = { addressLine: '1 Road', city: 'Lahore', provinceCode: 'PB' };
  const managerCapabilities = PHARMACY_ROLE_TEMPLATES.find(
    (r) => r.key === 'manager'
  )!.capabilities;
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
        permissions: {
          create: managerCapabilities.map((capability) => ({ capability, effect: 'ALLOW' })),
        },
      },
    });
    for (const [person, roleId] of [
      [owner, ids.ownerRole],
      [northAdmin, ids.managerRole],
    ] as const) {
      await tx.user.create({
        data: {
          id: person.id,
          name: person.id,
          email: `${person.id}@example.test`,
          department: 'LEADERSHIP',
          title: 'Administrator',
          role: person.role,
          status: 'ACTIVE',
          organizationRoleId: roleId,
        },
      });
    }
    await tx.pharmacyBranchAssignment.create({
      data: { userId: ids.northAdmin, branchId: ids.north },
    });
    await tx.pharmacyRequisition.createMany({
      data: [
        {
          id: ids.reqNorth,
          branchId: ids.north,
          reference: `RQ-N-${suffix}`,
          requestedByUserId: ids.northAdmin,
        },
        {
          id: ids.reqSouth,
          branchId: ids.south,
          reference: `RQ-S-${suffix}`,
          requestedByUserId: ids.owner,
        },
      ],
    });
  });

  // The North administrator submits North's requisition at his own branch; the
  // owner submits South's. Each entry is written in the request's transaction.
  await act(northAdmin, (api) =>
    purchasingOf(api).submitRequisition({ requisitionId: ids.reqNorth })
  );
  await act(owner, (api) => purchasingOf(api).submitRequisition({ requisitionId: ids.reqSouth }));
}, 120_000);

afterAll(async () => {
  await disconnect?.();
});

const SUBMIT = 'pharmacyPurchasing.submitRequisition';

describeIfDatabase('DEV-913 branch tags on pharmacy audit entries (runtime role)', () => {
  it('persists the requisition branch on each entry', async () => {
    const rows = await withTenantDb(ids.org, (tx) =>
      tx.auditLog.findMany({
        where: { organizationId: ids.org, action: SUBMIT },
        select: { actorId: true, metadata: true, input: true, outcome: true },
      })
    );
    expect(
      rows.map((row) => [row.actorId, (row.metadata as Record<string, unknown>).branchId]).sort()
    ).toEqual(
      [
        [ids.northAdmin, ids.north],
        [ids.owner, ids.south],
      ].sort()
    );
    for (const row of rows) {
      expect(row.outcome).toBe('SUCCESS');
      // The request itself names no branch: the tag came from the record.
      expect(JSON.stringify(row.input)).not.toContain('br_audbr_');
    }
  });

  it('shows a branch-limited administrator his branch and not another', async () => {
    const page = await act(northAdmin, (api) => api.audit.list({ action: SUBMIT }));
    expect(page.items.map((item) => item.branchId)).toEqual([ids.north]);
    expect(page.items[0]).toMatchObject({ branchName: 'North', actorId: ids.northAdmin });
    await expect(
      act(northAdmin, (api) => api.audit.list({ action: SUBMIT, branchId: ids.south }))
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('shows the owner every branch, and one branch when filtered', async () => {
    const all = await act(owner, (api) => api.audit.list({ action: SUBMIT }));
    expect(all.items.map((item) => item.branchId).sort()).toEqual([ids.north, ids.south].sort());
    const south = await act(owner, (api) =>
      api.audit.list({ action: SUBMIT, branchId: ids.south })
    );
    expect(south.items.map((item) => item.branchId)).toEqual([ids.south]);
  });
});
