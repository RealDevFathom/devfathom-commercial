/**
 * DEV-937 — a request that names another branch is not planted in that branch's
 * audit log. Against migrated PostgreSQL with FORCE row level security, as the
 * NOSUPERUSER / NOBYPASSRLS runtime role.
 *
 * A North cashier, a South cashier and North's manager (an ADMIN, who may act at
 * every branch) each send `saveKhataReminderSettings` naming South, and all are
 * refused. The North cashier also creates notes, which succeed, with an extra
 * `branchId` naming South that the procedure does not take: alone, beside a
 * `pharmacyBranchId` naming North, and beside a `scope.branchId` naming North;
 * and a record tagged at North carries the same extra key. The real tRPC audit
 * middleware records each entry after the request's transaction ends, as the
 * route does. The real audit router then reads them back: South's manager sees
 * South's own refusal and the ADMIN's, never the North cashier's entries; North's
 * manager sees his cashier's; the owner sees all. South's inspection pack leaves
 * out every entry recorded away from South. Nothing in `@/lib/abac` or
 * `@/server/audit` is mocked.
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
const NOTE = 'notes.create';
/** Written through the real recorder as a handler noting its target before refusing. */
const TARGETED = 'pharmacySales.saveManualPaymentSettings';
/** Written through the real recorder as a handler that tags its loaded record's branch. */
const TAGGED = 'pharmacyDispensing.recordSubstitution';
const since = new Date();

let withTenantDb: typeof import('@/lib/tenancy/scoped-db').withTenantDb;
let withPlatformDb: typeof import('@/lib/tenancy/scoped-db').withPlatformDb;
let flushAuditWritesForTest: typeof import('@/server/audit').flushAuditWritesForTest;
let inspectionPackAuditQuery: string;
/** Mounted under the app router's names, so paths and recorded actions match it. */
function mount(
  sales: (typeof import('./pharmacy-sales'))['pharmacySalesRouter'],
  notes: (typeof import('./notes'))['notesRouter'],
  audit: (typeof import('./audit'))['auditRouter'],
  router: (typeof import('../trpc'))['router']
) {
  return router({ pharmacySales: sales, notes, audit });
}
let mounted: ReturnType<typeof mount>;
let disconnect: (() => Promise<void>) | null = null;

function context(db: unknown, user: Person) {
  return {
    db,
    entitlements: {
      organizationId: ids.org,
      vertical: 'PHARMACY',
      enabledModules: ['pharmacy-core', 'notes', 'audit'],
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
        revision: -1,
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
    (await import('./notes')).notesRouter,
    (await import('./audit')).auditRouter,
    (await import('../trpc')).router
  );
  withTenantDb = scoped.withTenantDb;
  withPlatformDb = scoped.withPlatformDb;
  const audit = await import('@/server/audit');
  flushAuditWritesForTest = audit.flushAuditWritesForTest;
  inspectionPackAuditQuery = (await import('@/lib/pharmacy/inspection-pack'))
    .INSPECTION_PACK_AUDIT_QUERY;
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
  await refusedAtSouth(northManager);
  // Succeeds: `notes.create` takes no branch, so the extra key is dropped by its schema.
  const createNote = (input: Record<string, unknown>) =>
    act(northCashier, (api) =>
      (api.notes as unknown as { create(input: unknown): Promise<unknown> }).create(input)
    );
  await createNote({ title: 'Shelf note', branchId: ids.south });
  // The same extra key beside the cashier's own branch, given the two ways pharmacy
  // procedures name one: the entry belongs at North, and South must not match it.
  await createNote({ title: 'Pair note', branchId: ids.south, pharmacyBranchId: ids.north });
  await createNote({ title: 'Scope note', branchId: ids.south, scope: { branchId: ids.north } });
  await flushAuditWritesForTest();
  // A handler that tags its loaded record's branch (North), with an extra raw branchId.
  const tagged = { audit: { detail: {} as import('@/server/audit').AuditDetail } };
  (await import('@/server/audit-branch')).annotateAuditBranch(tagged, ids.north);
  await audit.recordTrpcAudit({
    ctx: {
      session: { user: { id: ids.northCashier, name: ids.northCashier, organizationId: ids.org } },
      audit: tagged.audit,
    },
    path: TAGGED,
    type: 'mutation',
    input: { saleLineId: 'line_1', branchId: ids.south },
    outcome: 'SUCCESS',
  });
  await flushAuditWritesForTest();
  // A handler that names its target branch before it refuses.
  await audit.recordTrpcAudit({
    ctx: {
      session: { user: { id: ids.northCashier, name: ids.northCashier, organizationId: ids.org } },
      audit: { detail: { targetType: 'PharmacyBranch', targetId: ids.south } },
    },
    path: TARGETED,
    type: 'mutation',
    input: { branchId: ids.south },
    outcome: 'FAILURE',
    error: new Error('Branch is outside your scope.'),
  });
  await flushAuditWritesForTest();
}, 120_000);

afterAll(async () => {
  await disconnect?.();
});

type Entry = { actorId: string | null; metadata: unknown; input: unknown; outcome: string };
async function entries(action: string): Promise<Map<string | null, Entry>> {
  const rows = await withTenantDb(ids.org, (tx) =>
    tx.auditLog.findMany({
      where: { organizationId: ids.org, action },
      select: { actorId: true, metadata: true, input: true, outcome: true },
    })
  );
  return new Map(rows.map((row) => [row.actorId, row]));
}
const actors = (page: { items: { actorId: string | null }[] }) =>
  page.items.map((item) => item.actorId).sort();

describeIfDatabase('DEV-937 requests naming another branch (runtime role)', () => {
  it('records a refusal at the branch the person may act at, not the one named', async () => {
    const byActor = await entries(ACTION);
    expect(byActor.size).toBe(3);
    for (const row of byActor.values()) {
      expect(row.outcome).toBe('FAILURE');
      // Every request named South.
      expect(row.input).toMatchObject({ branchId: ids.south });
    }
    expect(byActor.get(ids.northCashier)?.metadata).toMatchObject({
      requestedBranchId: ids.south,
      actorBranchIds: [ids.north],
    });
    expect(byActor.get(ids.northCashier)?.metadata).not.toHaveProperty('branchId');
    // South's own cashier, and an ADMIN, whom the counter lets act at every branch.
    for (const actor of [ids.southCashier, ids.northManager]) {
      expect(byActor.get(actor)?.metadata).toMatchObject({ branchId: ids.south });
      expect(byActor.get(actor)?.metadata).not.toHaveProperty('requestedBranchId');
    }
  });

  it('does not place a successful request at a branch it merely named', async () => {
    const notes = await withTenantDb(ids.org, (tx) =>
      tx.auditLog.findMany({
        where: { organizationId: ids.org, action: NOTE },
        select: { metadata: true, input: true, outcome: true },
      })
    );
    const byTitle = new Map(
      notes.map((row) => [(row.input as { title: string }).title, row] as const)
    );
    for (const row of notes) {
      expect(row.outcome).toBe('SUCCESS');
      expect(row.input).toMatchObject({ branchId: ids.south });
    }
    expect(byTitle.get('Shelf note')?.metadata).toEqual({
      requestedBranchId: ids.south,
      actorBranchIds: [ids.north],
    });
    // The declared field wins over the extra bare branchId.
    expect(byTitle.get('Pair note')?.metadata).toEqual({ branchId: ids.north });
    expect(byTitle.get('Scope note')?.metadata).toEqual({ branchId: ids.north });
    // The loaded record's tag stands.
    expect((await entries(TAGGED)).get(ids.northCashier)?.metadata).toEqual({
      branchId: ids.north,
    });
  });

  it("is not shown to the named branch's manager", async () => {
    const page = await act(southManager, (api) => api.audit.list({ action: ACTION }));
    expect(actors(page)).toEqual([ids.northManager, ids.southCashier].sort());
    for (const item of page.items)
      expect(item).toMatchObject({ branchId: ids.south, branchName: 'South' });
    const failures = await act(southManager, (api) =>
      api.audit.list({ action: ACTION, outcome: 'FAILURE', branchId: ids.south })
    );
    expect(actors(failures)).toEqual([ids.northManager, ids.southCashier].sort());
    const cashier = await act(southManager, (api) => api.audit.list({ actorId: ids.northCashier }));
    expect(cashier.items).toEqual([]);
    const atSouth = await act(southManager, (api) => api.audit.list({ branchId: ids.south }));
    expect(actors(atSouth)).toEqual([ids.northManager, ids.southCashier].sort());
    // Every cursor page, one entry at a time.
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await act(southManager, (api) => api.audit.list({ limit: 1, cursor }));
      seen.push(...page.items.map((item) => `${item.actorId}:${item.action}`));
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen.sort()).toEqual(
      [`${ids.northManager}:${ACTION}`, `${ids.southCashier}:${ACTION}`].sort()
    );
    const stats = await act(southManager, (api) => api.audit.stats());
    expect(stats.total).toBe(2);
    const filters = await act(southManager, (api) => api.audit.filters());
    expect(filters.actors.map((actor) => actor.id)).not.toContain(ids.northCashier);
    expect(filters.actions).not.toContain(NOTE);
    expect(filters.actions).not.toContain(TAGGED);
  });

  it("is shown to the manager of the person's own branch", async () => {
    const page = await act(northManager, (api) => api.audit.list({ actorId: ids.northCashier }));
    expect(page.items.map((item) => item.action).sort()).toEqual(
      [ACTION, NOTE, NOTE, NOTE, TAGGED, TARGETED].sort()
    );
    // Recorded at North: the pair, the scope and the tagged record. Moved: the rest.
    expect(page.items.filter((item) => item.branchName === 'North')).toHaveLength(3);
    expect(page.items.filter((item) => item.branchId === null)).toHaveLength(3);
  });

  it('is shown to the owner, who sees every entry', async () => {
    const all = await act(owner, (api) => api.audit.list({ action: ACTION }));
    expect(actors(all)).toEqual([ids.northCashier, ids.northManager, ids.southCashier].sort());
    const south = await act(owner, (api) =>
      api.audit.list({ action: ACTION, branchId: ids.south })
    );
    expect(actors(south)).toEqual([ids.northManager, ids.southCashier].sort());
    const north = await act(owner, (api) => api.audit.list({ branchId: ids.north }));
    expect(north.items.map((item) => item.action).sort()).toEqual(
      [ACTION, NOTE, NOTE, NOTE, TAGGED, TARGETED].sort()
    );
  });

  it("leaves South's inspection pack, even when the request aimed at South", async () => {
    const rows = await withTenantDb(ids.org, (tx) =>
      tx.$queryRawUnsafe<{ record: { actorName: string; action: string } }[]>(
        inspectionPackAuditQuery,
        since,
        new Date(Date.now() + 60_000),
        ids.south
      )
    );
    expect(rows.map((row) => row.record.actorName).sort()).toEqual(
      [ids.northManager, ids.southCashier].sort()
    );
    const targeted = (await entries(TARGETED)).get(ids.northCashier);
    expect(targeted?.metadata).toMatchObject({ requestedBranchId: ids.south });
  });
});
