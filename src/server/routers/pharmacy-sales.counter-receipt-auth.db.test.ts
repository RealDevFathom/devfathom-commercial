/**
 * Receipt authorization against PostgreSQL as a NOSUPERUSER NOBYPASSRLS role.
 * Skipped unless TEST_DATABASE_URL names that role on a migrated disposable database.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { runMigrationSql } from '../../../tests/split-sql-statements';

const databaseUrl = process.env.TEST_DATABASE_URL;
if (databaseUrl) process.env.DATABASE_URL = databaseUrl;
const describeIfDatabase = databaseUrl ? describe : describe.skip;

vi.mock('@/server/audit', async () => {
  const actual = await vi.importActual<typeof import('@/server/audit')>('@/server/audit');
  return { ...actual, recordTrpcAudit: vi.fn() };
});

const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const ids = {
  orgA: `org_rcpt_a_${suffix}`,
  orgB: `org_rcpt_b_${suffix}`,
  branchA: `br_rcpt_a_${suffix}`,
  branchB: `br_rcpt_b_${suffix}`,
  branchOther: `br_rcpt_o_${suffix}`,
  roleDispense: `role_rcpt_d_${suffix}`,
  roleReceipt: `role_rcpt_r_${suffix}`,
  roleCashier: `role_rcpt_c_${suffix}`,
  dispenser: `user_rcpt_d_${suffix}`,
  receiptClerk: `user_rcpt_r_${suffix}`,
  cashier: `user_rcpt_c_${suffix}`,
  unassigned: `user_rcpt_u_${suffix}`,
  admin: `user_rcpt_admin_${suffix}`,
  outsider: `user_rcpt_x_${suffix}`,
  legacy: `user_rcpt_legacy_${suffix}`,
  inactive: `user_rcpt_off_${suffix}`,
  closedBranch: `br_rcpt_closed_${suffix}`,
  saleA: `sale_rcpt_a_${suffix}`,
  saleB: `sale_rcpt_b_${suffix}`,
};

type SalesCaller = {
  create: (input: { branchId: string; quotation: boolean }) => Promise<unknown>;
  tender: (input: {
    branchId: string;
    saleId: string;
    deviceId: string;
    businessDate: Date;
    type: 'CASH';
    amountMinor: number;
    idempotencyKey: string;
  }) => Promise<unknown>;
  counterReceipt: (input: { branchId: string; saleId: string }) => Promise<unknown>;
  counterReceiptPrintJob: (input: {
    branchId: string;
    saleId: string;
    locale: 'en' | 'ur';
    reprint: boolean;
  }) => Promise<unknown>;
  lookupReceiptByNumber: (input: { branchId: string; receiptNumber: number }) => Promise<unknown>;
  counterReceiptFormat: (input: { branchId: string }) => Promise<unknown>;
  counterCart: (input: { branchId: string; saleId: string }) => Promise<unknown>;
  returnHistory: (input: { branchId: string; saleId: string }) => Promise<unknown>;
};

let withTenantDb: typeof import('@/lib/tenancy/scoped-db').withTenantDb;
let withPlatformDb: typeof import('@/lib/tenancy/scoped-db').withPlatformDb;
let pharmacySalesRouter: typeof import('./pharmacy-sales').pharmacySalesRouter;
let disconnect: (() => Promise<void>) | null = null;

function caller(
  db: unknown,
  tenantId: string,
  user: { id: string; role: 'ADMIN' | 'EMPLOYEE'; organizationId: string }
): SalesCaller {
  return pharmacySalesRouter.createCaller({
    db,
    entitlements: {
      organizationId: tenantId,
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
    organization: { id: tenantId, vertical: 'PHARMACY' },
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as never) as SalesCaller;
}

async function act<T>(
  organizationId: string,
  user: { id: string; role: 'ADMIN' | 'EMPLOYEE'; organizationId: string },
  run: (api: SalesCaller) => Promise<T>
) {
  return withTenantDb(organizationId, (db) => run(caller(db, organizationId, user)), {
    timeout: 60_000,
  });
}

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

  await withPlatformDb(async (tx) => {
    await tx.$executeRawUnsafe(
      `INSERT INTO organizations (id, slug, "legalName", "displayName", vertical, status, "deploymentMode", "createdAt", "updatedAt")
       VALUES ($1, $1, 'Receipt A', 'Receipt A', 'PHARMACY', 'ACTIVE', 'SHARED', now(), now()),
              ($2, $2, 'Receipt B', 'Receipt B', 'PHARMACY', 'ACTIVE', 'SHARED', now(), now())`,
      ids.orgA,
      ids.orgB
    );
  });

  const branch = {
    addressLine: '1 Road',
    city: 'Lahore',
    provinceCode: 'PB',
  };
  await withTenantDb(ids.orgA, async (tx) => {
    await seedDepartments(tx, [ids.orgA], ['LEADERSHIP']);
    await tx.pharmacyBranch.createMany({
      data: [
        { id: ids.branchA, code: 'A', name: 'Counter A', ...branch },
        { id: ids.branchB, code: 'B', name: 'Counter B', ...branch },
      ],
    });
    for (const role of [
      { id: ids.roleDispense, key: `dispense-${suffix}`, capability: 'pharmacy:dispense' },
      { id: ids.roleReceipt, key: `receipt-${suffix}`, capability: 'pharmacy:receipt' },
      { id: ids.roleCashier, key: `cashier-${suffix}`, capability: 'pharmacy.counter' },
    ]) {
      await tx.organizationRole.create({
        data: {
          id: role.id,
          key: role.key,
          name: role.key,
          permissions: { create: [{ capability: role.capability, effect: 'ALLOW' }] },
        },
      });
    }
    const people = [
      { id: ids.dispenser, roleId: ids.roleDispense, name: 'Dispenser' },
      { id: ids.receiptClerk, roleId: ids.roleReceipt, name: 'Receipt' },
      { id: ids.cashier, roleId: ids.roleCashier, name: 'Cashier' },
      { id: ids.unassigned, roleId: ids.roleDispense, name: 'Unassigned' },
      { id: ids.admin, roleId: ids.roleDispense, name: 'Admin', role: 'ADMIN' as const },
    ];
    for (const person of people) {
      await tx.user.create({
        data: {
          id: person.id,
          name: person.name,
          email: `${person.id}@example.test`,
          department: 'LEADERSHIP',
          title: person.name,
          role: person.role ?? 'EMPLOYEE',
          organizationRoleId: person.roleId,
        },
      });
    }
    await tx.pharmacyBranchAssignment.createMany({
      data: [
        { userId: ids.dispenser, branchId: ids.branchA },
        { userId: ids.receiptClerk, branchId: ids.branchA },
        { userId: ids.cashier, branchId: ids.branchA },
      ],
    });
    await tx.pharmacySale.createMany({
      data: [
        {
          id: ids.saleA,
          branchId: ids.branchA,
          status: 'COMPLETED',
          createdByUserId: ids.dispenser,
          receiptNumber: 7,
          receiptDeviceId: 'device-a',
          businessDate: new Date('2026-10-01T00:00:00.000Z'),
          completedAt: new Date('2026-10-01T08:00:00.000Z'),
        },
        {
          id: ids.saleB,
          branchId: ids.branchB,
          status: 'COMPLETED',
          createdByUserId: ids.dispenser,
          receiptNumber: 7,
          receiptDeviceId: 'device-b',
          businessDate: new Date('2026-10-01T00:00:00.000Z'),
          completedAt: new Date('2026-10-01T08:00:00.000Z'),
        },
      ],
    });
  });

  await withTenantDb(ids.orgB, async (tx) => {
    await seedDepartments(tx, [ids.orgB], ['LEADERSHIP']);
    await tx.pharmacyBranch.create({
      data: { id: ids.branchOther, code: 'O', name: 'Other', ...branch },
    });
    await tx.organizationRole.create({
      data: {
        id: `role_rcpt_out_${suffix}`,
        key: `out-${suffix}`,
        name: 'Outsider',
        permissions: { create: [{ capability: 'pharmacy:dispense', effect: 'ALLOW' }] },
      },
    });
    await tx.user.create({
      data: {
        id: ids.outsider,
        name: 'Outsider',
        email: `${ids.outsider}@example.test`,
        department: 'LEADERSHIP',
        title: 'Outsider',
        organizationRoleId: `role_rcpt_out_${suffix}`,
      },
    });
    await tx.pharmacyBranchAssignment.create({
      data: { userId: ids.outsider, branchId: ids.branchOther },
    });
  });
});

afterAll(async () => {
  await disconnect?.();
});

const dispenser = { id: ids.dispenser, role: 'EMPLOYEE' as const, organizationId: ids.orgA };
const receiptUser = { id: ids.receiptClerk, role: 'EMPLOYEE' as const, organizationId: ids.orgA };

describeIfDatabase('counter receipt authorization against Postgres', () => {
  it('rolls back create and tender denials while preserving their regulatory audits', async () => {
    const admin = { id: ids.admin, role: 'ADMIN' as const, organizationId: ids.orgA };
    const before = await withTenantDb(ids.orgA, (tx) =>
      Promise.all([tx.pharmacySale.count(), tx.pharmacyTender.count()])
    );

    await withPlatformDb((tx) =>
      tx.organization.update({ where: { id: ids.orgA }, data: { status: 'ONBOARDING' } })
    );
    await expect(
      act(ids.orgA, admin, (api) => api.create({ branchId: ids.branchA, quotation: false }))
    ).rejects.toMatchObject({ code: 'FORBIDDEN', message: 'ORGANIZATION_NOT_ACTIVE' });

    await withPlatformDb((tx) =>
      tx.organization.update({ where: { id: ids.orgA }, data: { status: 'ACTIVE' } })
    );
    await expect(
      act(ids.orgA, admin, (api) =>
        api.tender({
          branchId: ids.branchA,
          saleId: ids.saleA,
          deviceId: 'regulatory-test-device',
          businessDate: new Date('2026-10-01T00:00:00.000Z'),
          type: 'CASH',
          amountMinor: 100,
          idempotencyKey: `regulatory-denial-${suffix}`,
        })
      )
    ).rejects.toMatchObject({ code: 'FORBIDDEN', message: 'PROFILE_MISSING' });

    const { flushAuditWritesForTest } = await import('@/server/audit');
    await flushAuditWritesForTest();
    const after = await withTenantDb(ids.orgA, (tx) =>
      Promise.all([
        tx.pharmacySale.count(),
        tx.pharmacyTender.count(),
        tx.auditLog.findMany({
          where: {
            action: 'pharmacy.branch_operation_denied',
            targetId: ids.branchA,
            errorCode: { in: ['ORGANIZATION_NOT_ACTIVE', 'PROFILE_MISSING'] },
          },
          select: { errorCode: true },
        }),
      ])
    );
    expect(after.slice(0, 2)).toEqual(before);
    expect(after[2]).toEqual(
      expect.arrayContaining([
        { errorCode: 'ORGANIZATION_NOT_ACTIVE' },
        { errorCode: 'PROFILE_MISSING' },
      ])
    );
  });

  it('allows the assigned branch and denies the sibling sale, an empty assignment, and another organization', async () => {
    await act(ids.orgA, dispenser, async (api) => {
      await expect(
        api.counterReceipt({ branchId: ids.branchA, saleId: ids.saleA })
      ).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
      await expect(
        api.counterReceiptPrintJob({
          branchId: ids.branchA,
          saleId: ids.saleA,
          locale: 'en',
          reprint: false,
        })
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(
        api.counterReceiptPrintJob({
          branchId: ids.branchA,
          saleId: ids.saleA,
          locale: 'en',
          reprint: true,
        })
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(
        api.lookupReceiptByNumber({ branchId: ids.branchA, receiptNumber: 7 })
      ).resolves.toEqual([expect.objectContaining({ id: ids.saleA, receiptDeviceId: 'device-a' })]);
      await expect(api.counterReceiptFormat({ branchId: ids.branchA })).resolves.toMatchObject({
        revision: 0,
      });

      await expect(
        api.counterReceipt({ branchId: ids.branchB, saleId: ids.saleB })
      ).rejects.toMatchObject({
        code: 'FORBIDDEN',
        message: 'Branch is outside your scope.',
      });
      await expect(
        api.lookupReceiptByNumber({ branchId: ids.branchB, receiptNumber: 7 })
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(
        api.counterReceiptPrintJob({
          branchId: ids.branchB,
          saleId: ids.saleB,
          locale: 'en',
          reprint: true,
        })
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(api.counterReceiptFormat({ branchId: ids.branchB })).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
    });

    await act(ids.orgA, receiptUser, async (api) => {
      await expect(
        api.lookupReceiptByNumber({ branchId: ids.branchA, receiptNumber: 7 })
      ).resolves.toEqual([expect.objectContaining({ id: ids.saleA })]);
    });

    await act(
      ids.orgA,
      { id: ids.unassigned, role: 'EMPLOYEE', organizationId: ids.orgA },
      async (api) => {
        await expect(
          api.counterReceipt({ branchId: ids.branchA, saleId: ids.saleA })
        ).rejects.toMatchObject({ code: 'FORBIDDEN', message: 'Branch is outside your scope.' });
        await expect(api.counterReceiptFormat({ branchId: ids.branchA })).rejects.toMatchObject({
          code: 'FORBIDDEN',
        });
      }
    );

    await act(
      ids.orgA,
      { id: ids.cashier, role: 'EMPLOYEE', organizationId: ids.orgA },
      async (api) => {
        await expect(
          api.lookupReceiptByNumber({ branchId: ids.branchA, receiptNumber: 7 })
        ).resolves.toEqual([
          expect.objectContaining({ id: ids.saleA, receiptDeviceId: 'device-a' }),
        ]);
        await expect(
          api.counterCart({ branchId: ids.branchA, saleId: ids.saleA })
        ).resolves.toMatchObject({ saleId: ids.saleA, lines: [] });
        await expect(
          api.returnHistory({ branchId: ids.branchA, saleId: ids.saleA })
        ).resolves.toMatchObject({ saleId: ids.saleA, lines: [] });
      }
    );

    await act(ids.orgA, { id: ids.admin, role: 'ADMIN', organizationId: ids.orgA }, async (api) => {
      await expect(
        api.lookupReceiptByNumber({ branchId: ids.branchB, receiptNumber: 7 })
      ).resolves.toEqual([expect.objectContaining({ id: ids.saleB })]);
    });
    await withTenantDb(ids.orgA, (tx) =>
      tx.pharmacyBranchAssignment.create({
        data: { userId: ids.admin, branchId: ids.branchA },
      })
    );
    await act(ids.orgA, { id: ids.admin, role: 'ADMIN', organizationId: ids.orgA }, async (api) => {
      await expect(
        api.lookupReceiptByNumber({ branchId: ids.branchB, receiptNumber: 7 })
      ).resolves.toEqual([expect.objectContaining({ id: ids.saleB })]);
    });

    await act(
      ids.orgA,
      { id: ids.outsider, role: 'EMPLOYEE', organizationId: ids.orgB },
      async (api) => {
        await expect(
          api.lookupReceiptByNumber({ branchId: ids.branchA, receiptNumber: 7 })
        ).rejects.toMatchObject({ code: 'FORBIDDEN', message: 'Branch is outside your scope.' });
        await expect(
          api.counterReceipt({ branchId: ids.branchA, saleId: ids.saleA })
        ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      }
    );

    await withTenantDb(ids.orgA, async (tx) => {
      await tx.pharmacyBranch.create({
        data: {
          id: ids.closedBranch,
          code: 'Z',
          name: 'Closed',
          addressLine: '1 Road',
          city: 'Lahore',
          provinceCode: 'PB',
          active: false,
        },
      });
      await tx.user.create({
        data: {
          id: ids.legacy,
          name: 'Legacy cashier',
          email: `${ids.legacy}@example.test`,
          department: 'LEADERSHIP',
          title: 'Cashier',
          organizationRoleId: ids.roleCashier,
        },
      });
      await tx.user.create({
        data: {
          id: ids.inactive,
          name: 'Inactive cashier',
          email: `${ids.inactive}@example.test`,
          department: 'LEADERSHIP',
          title: 'Cashier',
          status: 'INACTIVE',
          organizationRoleId: ids.roleCashier,
        },
      });
    });

    const backfill = readFileSync(
      join(
        process.cwd(),
        'prisma/migrations/20261021133000_pharmacy_branch_assignment_backfill/migration.sql'
      ),
      'utf8'
    );
    await withPlatformDb((tx) => runMigrationSql(tx, backfill));
    await withPlatformDb((tx) => runMigrationSql(tx, backfill));

    const assigned = await withTenantDb(ids.orgA, (tx) =>
      tx.pharmacyBranchAssignment.findMany({
        where: { userId: ids.legacy, active: true },
        select: { branchId: true },
      })
    );
    expect(assigned.map((row) => row.branchId).sort()).toEqual([ids.branchA, ids.branchB].sort());
    const inactiveRows = await withTenantDb(ids.orgA, (tx) =>
      tx.pharmacyBranchAssignment.findMany({
        where: { userId: ids.inactive },
        select: { id: true },
      })
    );
    expect(inactiveRows).toEqual([]);

    await act(
      ids.orgA,
      { id: ids.legacy, role: 'EMPLOYEE', organizationId: ids.orgA },
      async (api) => {
        await expect(
          api.lookupReceiptByNumber({ branchId: ids.branchA, receiptNumber: 7 })
        ).resolves.toEqual([expect.objectContaining({ id: ids.saleA })]);
        await expect(
          api.counterCart({ branchId: ids.branchB, saleId: ids.saleB })
        ).resolves.toMatchObject({ saleId: ids.saleB, lines: [] });
        await expect(
          api.lookupReceiptByNumber({ branchId: ids.closedBranch, receiptNumber: 7 })
        ).rejects.toMatchObject({ code: 'FORBIDDEN', message: 'Branch is outside your scope.' });
      }
    );
  });
});
