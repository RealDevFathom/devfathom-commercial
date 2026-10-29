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
  printableSale: `sale_rcpt_print_${suffix}`,
};

type SalesCaller = {
  counterReceipt: (input: { branchId: string; saleId: string }) => Promise<unknown>;
  counterReceiptPrintJob: (input: {
    branchId: string;
    saleId: string;
    locale: 'en' | 'ur';
  }) => Promise<{ status: 'READY'; copyNumber: number; reprint: boolean }>;
  counterReceiptBrowserPrint: (input: {
    branchId: string;
    saleId: string;
    locale: 'en' | 'ur';
  }) => Promise<{ copyNumber: number; reprint: boolean }>;
  counterReceiptBrowserPrintDispatched: (input: {
    branchId: string;
    saleId: string;
    locale: 'en' | 'ur';
    copyNumber: number;
  }) => Promise<{ recorded: true }>;
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
    const medicine = await tx.medicine.create({
      data: {
        productName: `Receipt test medicine ${suffix}`,
        productFamily: 'PHARMACEUTICAL',
        saleable: true,
        presentations: { create: { presentation: 'Tablet' } },
      },
      include: { presentations: true },
    });
    const packLevel = await tx.packLevel.create({
      data: {
        presentationId: medicine.presentations[0]!.id,
        versionGroupId: `receipt-${suffix}`,
        version: 1,
        level: 'UNIT',
        unitsPerParent: 1,
        effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
      },
    });
    await tx.pharmacySale.create({
      data: {
        id: ids.printableSale,
        branchId: ids.branchA,
        status: 'COMPLETED',
        createdByUserId: ids.dispenser,
        receiptNumber: 8,
        receiptDeviceId: 'device-a',
        businessDate: new Date('2026-10-01T00:00:00.000Z'),
        completedAt: new Date('2026-10-01T08:00:00.000Z'),
        lines: {
          create: {
            medicineId: medicine.id,
            presentationId: medicine.presentations[0]!.id,
            packLevelId: packLevel.id,
            saleUnit: 'UNIT',
            quantity: 1,
            canonicalUnitsPerSaleUnit: 1,
            canonicalUnits: 1,
            unitPriceMinor: 100,
            proRataCeilingMinor: 100,
            unitCostMinor: 50,
            idempotencyKey: `receipt-line-${suffix}`,
          },
        },
      },
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
  it('durably allocates one original and sequential marked copies under concurrency', async () => {
    const print = () =>
      act(ids.orgA, dispenser, (api) =>
        api.counterReceiptPrintJob({
          branchId: ids.branchA,
          saleId: ids.printableSale,
          locale: 'en',
        })
      );

    // Use a separate tenant transaction for the first request, then concurrent
    // transactions, matching real request/reload boundaries.
    const first = await print();
    const concurrent = await Promise.all(Array.from({ length: 7 }, () => print()));
    const results = [first, ...concurrent];

    expect(results.map((result) => result.copyNumber).sort((a, b) => a - b)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8,
    ]);
    expect(results.filter((result) => !result.reprint)).toEqual([
      expect.objectContaining({ copyNumber: 1, reprint: false }),
    ]);
    expect(results.filter((result) => result.reprint)).toHaveLength(7);

    const persisted = await withTenantDb(ids.orgA, async (tx) => ({
      state: await tx.pharmacyReceiptPrintState.findUnique({
        where: {
          organizationId_branchId_saleId: {
            organizationId: ids.orgA,
            branchId: ids.branchA,
            saleId: ids.printableSale,
          },
        },
      }),
      dispatches: await tx.pharmacyReceiptPrintDispatch.findMany({
        where: { branchId: ids.branchA, saleId: ids.printableSale },
        orderBy: { copyNumber: 'asc' },
      }),
    }));
    expect(persisted.state?.copyCount).toBe(8);
    expect(persisted.dispatches.map((row) => row.copyNumber)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(persisted.dispatches).toEqual(
      expect.arrayContaining(
        Array.from({ length: 8 }, (_, index) =>
          expect.objectContaining({
            organizationId: ids.orgA,
            branchId: ids.branchA,
            saleId: ids.printableSale,
            copyNumber: index + 1,
            actorId: ids.dispenser,
            locale: 'en',
          })
        )
      )
    );
    expect(persisted.dispatches).toHaveLength(results.length);
  });

  it('records a browser dispatch only after explicit dialog handoff', async () => {
    const browserPrint = () =>
      act(ids.orgA, dispenser, (api) =>
        api.counterReceiptBrowserPrint({
          branchId: ids.branchA,
          saleId: ids.printableSale,
          locale: 'en',
        })
      );

    const first = await browserPrint();
    const afterReload = await browserPrint();
    expect(first).toMatchObject({ copyNumber: 1, reprint: false });
    expect(afterReload).toMatchObject({ copyNumber: 2, reprint: true });

    await expect(
      withTenantDb(ids.orgA, (tx) =>
        tx.pharmacyReceiptPrintDispatch.count({
          where: { branchId: ids.branchA, saleId: ids.printableSale },
        })
      )
    ).resolves.toBe(0);

    for (const allocation of [first, afterReload]) {
      await act(ids.orgA, dispenser, (api) =>
        api.counterReceiptBrowserPrintDispatched({
          branchId: ids.branchA,
          saleId: ids.printableSale,
          locale: 'en',
          copyNumber: allocation.copyNumber,
        })
      );
    }

    const dispatches = await withTenantDb(ids.orgA, (tx) =>
      tx.pharmacyReceiptPrintDispatch.findMany({
        where: { branchId: ids.branchA, saleId: ids.printableSale },
        orderBy: { copyNumber: 'asc' },
      })
    );
    expect(dispatches).toHaveLength(2);
    expect(dispatches.map(({ copyNumber }) => copyNumber)).toEqual([1, 2]);
  });

  it('rejects update and delete of append-only dispatch audit rows', async () => {
    await expect(
      withTenantDb(ids.orgA, (tx) =>
        tx.$executeRawUnsafe(
          'UPDATE "pharmacy_receipt_print_dispatches" SET "locale" = \'ur\' WHERE "organizationId" = $1 AND "branchId" = $2 AND "saleId" = $3',
          ids.orgA,
          ids.branchA,
          ids.printableSale
        )
      )
    ).rejects.toThrow(/append-only/);
    await expect(
      withTenantDb(ids.orgA, (tx) =>
        tx.$executeRawUnsafe(
          'DELETE FROM "pharmacy_receipt_print_dispatches" WHERE "organizationId" = $1 AND "branchId" = $2 AND "saleId" = $3',
          ids.orgA,
          ids.branchA,
          ids.printableSale
        )
      )
    ).rejects.toThrow(/append-only/);
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
        })
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(
        api.counterReceiptPrintJob({
          branchId: ids.branchA,
          saleId: ids.saleA,
          locale: 'en',
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
