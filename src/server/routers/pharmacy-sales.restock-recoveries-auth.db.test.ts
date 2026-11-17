/**
 * DEV-884: linkRestockRecoveries authorization against PostgreSQL as a NOSUPERUSER
 * NOBYPASSRLS role. Skipped unless TEST_DATABASE_URL names that role on a migrated
 * disposable database.
 */
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const databaseUrl = process.env.TEST_DATABASE_URL;
if (databaseUrl) process.env.DATABASE_URL = databaseUrl;
const describeIfDatabase = databaseUrl ? describe : describe.skip;

vi.mock('@/server/audit', async () => {
  const actual = await vi.importActual<typeof import('@/server/audit')>('@/server/audit');
  return { ...actual, recordTrpcAudit: vi.fn() };
});

const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const ids = {
  org: `org_lrr_${suffix}`,
  branchA: `br_lrr_a_${suffix}`,
  branchB: `br_lrr_b_${suffix}`,
  roleCounter: `role_lrr_c_${suffix}`,
  roleNone: `role_lrr_n_${suffix}`,
  roleDeny: `role_lrr_d_${suffix}`,
  counter: `user_lrr_c_${suffix}`,
  noCapability: `user_lrr_n_${suffix}`,
  denied: `user_lrr_d_${suffix}`,
  otherBranch: `user_lrr_o_${suffix}`,
  soloOwner: `user_lrr_s_${suffix}`,
};

type Actor = { id: string; role: 'ADMIN' | 'EMPLOYEE'; organizationId: string };
type LinkCaller = {
  linkRestockRecoveries: (input: { branchId: string }) => Promise<unknown[]>;
};

let withTenantDb: typeof import('@/lib/tenancy/scoped-db').withTenantDb;
let withPlatformDb: typeof import('@/lib/tenancy/scoped-db').withPlatformDb;
let pharmacySalesRouter: typeof import('./pharmacy-sales').pharmacySalesRouter;
let disconnect: (() => Promise<void>) | null = null;

function caller(db: unknown, user: Actor): LinkCaller {
  return pharmacySalesRouter.createCaller({
    db,
    entitlements: {
      organizationId: ids.org,
      enabledModules: ['pharmacy-counter'],
      modules: [],
      limits: {},
      seatLimit: 10,
      activeSeats: 1,
    },
    session: {
      expires: 'later',
      user: {
        id: user.id,
        role: user.role,
        department: 'LEADERSHIP',
        status: 'ACTIVE',
        organizationId: user.organizationId,
      },
    },
    organization: { id: ids.org, vertical: 'PHARMACY' },
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as never) as unknown as LinkCaller;
}

const act = <T>(user: Actor, run: (api: LinkCaller) => Promise<T>) =>
  withTenantDb(ids.org, (db) => run(caller(db, user)), { timeout: 60_000 });

const actor = (id: string, role: Actor['role'] = 'EMPLOYEE'): Actor => ({
  id,
  role,
  organizationId: ids.org,
});

beforeAll(async () => {
  if (!databaseUrl) return;
  const scoped = await import('@/lib/tenancy/scoped-db');
  const sales = await import('./pharmacy-sales');
  const { seedDepartments } = await import('@/lib/test-support/departments');
  const { db } = await import('@/lib/db');
  withTenantDb = scoped.withTenantDb;
  withPlatformDb = scoped.withPlatformDb;
  pharmacySalesRouter = sales.pharmacySalesRouter;
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
       VALUES ($1, $1, 'Restock Link', 'Restock Link', 'PHARMACY', 'ACTIVE', 'SHARED', now(), now())`,
      ids.org
    )
  );

  const branch = { addressLine: '1 Road', city: 'Lahore', provinceCode: 'PB' };
  await withTenantDb(ids.org, async (tx) => {
    await seedDepartments(tx, [ids.org], ['LEADERSHIP']);
    await tx.pharmacyBranch.createMany({
      data: [
        { id: ids.branchA, code: 'A', name: 'Counter A', ...branch },
        { id: ids.branchB, code: 'B', name: 'Counter B', ...branch },
      ],
    });
    const roles = [
      { id: ids.roleCounter, key: `counter-${suffix}`, rules: [['pharmacy:counter', 'ALLOW']] },
      { id: ids.roleNone, key: `none-${suffix}`, rules: [['pharmacy:dispense', 'ALLOW']] },
      {
        id: ids.roleDeny,
        key: `deny-${suffix}`,
        rules: [
          ['pharmacy:counter', 'ALLOW'],
          ['pharmacy.counter', 'DENY'],
        ],
      },
    ] as const;
    for (const r of roles) {
      await tx.organizationRole.create({
        data: {
          id: r.id,
          key: r.key,
          name: r.key,
          permissions: {
            create: r.rules.map(([capability, effect]) => ({ capability, effect })),
          },
        },
      });
    }
    const people = [
      { id: ids.counter, roleId: ids.roleCounter, role: 'EMPLOYEE' as const },
      { id: ids.noCapability, roleId: ids.roleNone, role: 'EMPLOYEE' as const },
      { id: ids.denied, roleId: ids.roleDeny, role: 'EMPLOYEE' as const },
      { id: ids.otherBranch, roleId: ids.roleCounter, role: 'EMPLOYEE' as const },
      { id: ids.soloOwner, roleId: ids.roleCounter, role: 'ADMIN' as const },
    ];
    for (const p of people) {
      await tx.user.create({
        data: {
          id: p.id,
          name: p.id,
          email: `${p.id}@example.test`,
          department: 'LEADERSHIP',
          title: p.id,
          role: p.role,
          organizationRoleId: p.roleId,
        },
      });
    }
    await tx.pharmacyBranchAssignment.createMany({
      data: [
        { userId: ids.counter, branchId: ids.branchA },
        { userId: ids.noCapability, branchId: ids.branchA },
        { userId: ids.denied, branchId: ids.branchA },
        { userId: ids.otherBranch, branchId: ids.branchB },
      ],
    });
  });
});

afterAll(async () => {
  await disconnect?.();
});

describeIfDatabase('linkRestockRecoveries authorization against Postgres', () => {
  it.each([
    ['no counter capability', () => actor(ids.noCapability)],
    ['a DENY on a counter capability alias', () => actor(ids.denied)],
    ['assignment only to another branch', () => actor(ids.otherBranch)],
  ])('refuses a member with %s', async (_label, who) => {
    await expect(
      act(who(), (api) => api.linkRestockRecoveries({ branchId: ids.branchA }))
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('refuses a user from a different tenant', async () => {
    await expect(
      act({ id: ids.counter, role: 'EMPLOYEE', organizationId: `other_${suffix}` }, (api) =>
        api.linkRestockRecoveries({ branchId: ids.branchA })
      )
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('lets an assigned counter member run it', async () => {
    await expect(
      act(actor(ids.counter), (api) => api.linkRestockRecoveries({ branchId: ids.branchA }))
    ).resolves.toEqual([]);
  });

  it('lets a solo owner without a branch assignment run it', async () => {
    await expect(
      act(actor(ids.soloOwner, 'ADMIN'), (api) =>
        api.linkRestockRecoveries({ branchId: ids.branchA })
      )
    ).resolves.toEqual([]);
  });
});
