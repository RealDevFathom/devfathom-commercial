/**
 * Receipt authorization against PostgreSQL as a NOSUPERUSER NOBYPASSRLS role.
 * Skipped unless TEST_DATABASE_URL names that role on a migrated disposable database.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { runMigrationSql } from '../../../tests/split-sql-statements';

const databaseUrl = process.env.TEST_DATABASE_URL;
if (databaseUrl) process.env.DATABASE_URL = databaseUrl;
// The receipt print cutover migration is applied the way `prisma migrate deploy` applies it:
// by the role that owns the schema, never by the restricted runtime role (which has no CREATE).
const ownerUrl = process.env.PHARMACY_TEST_OWNER_DATABASE_URL;
const describeIfDatabase = databaseUrl && ownerUrl ? describe : describe.skip;

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
  counterAdmin: `user_rcpt_cadmin_${suffix}`,
  roleCounterAdmin: `role_rcpt_ca_${suffix}`,
  outsider: `user_rcpt_x_${suffix}`,
  legacy: `user_rcpt_legacy_${suffix}`,
  inactive: `user_rcpt_off_${suffix}`,
  closedBranch: `br_rcpt_closed_${suffix}`,
  saleA: `sale_rcpt_a_${suffix}`,
  saleB: `sale_rcpt_b_${suffix}`,
  saleBOnly: `sale_rcpt_b_only_${suffix}`,
  printableSale: `sale_rcpt_print_${suffix}`,
  browserSale: `sale_rcpt_browser_${suffix}`,
  legacyThermalSale: `sale_rcpt_legacy_thermal_${suffix}`,
  legacyBrowserSale: `sale_rcpt_legacy_browser_${suffix}`,
  untrackedSale: `sale_rcpt_untracked_${suffix}`,
  failedBrowserSale: `sale_rcpt_failed_browser_${suffix}`,
  failedThermalSale: `sale_rcpt_failed_thermal_${suffix}`,
  laterIssuedSale: `sale_rcpt_later_issued_${suffix}`,
};

type SalesCaller = {
  create: (input: { branchId: string; quotation: boolean; deviceId: string }) => Promise<unknown>;
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
  }) => Promise<{ status: 'READY'; copyNumber: number; reprint: boolean }>;
  counterReceiptBrowserPrint: (input: {
    branchId: string;
    saleId: string;
    locale: 'en' | 'ur';
  }) => Promise<{ copyNumber: number; reprint: boolean }>;
  counterReceiptBrowserPrintFailed: (input: {
    branchId: string;
    saleId: string;
    locale: 'en' | 'ur';
  }) => Promise<{ recorded: true }>;
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
      // Tendering needs the canonical counter capability, not only dispense.
      { id: ids.roleCounterAdmin, key: `counter-admin-${suffix}`, capability: 'pharmacy:counter' },
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
      {
        id: ids.counterAdmin,
        roleId: ids.roleCounterAdmin,
        name: 'Counter admin',
        role: 'ADMIN' as const,
      },
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
          completedAt: new Date('2026-10-01T09:00:00.000Z'),
        },
        {
          id: ids.saleBOnly,
          branchId: ids.branchB,
          status: 'COMPLETED',
          createdByUserId: ids.dispenser,
          receiptNumber: 9,
          receiptDeviceId: 'device-b',
          businessDate: new Date('2026-10-01T00:00:00.000Z'),
          completedAt: new Date('2026-10-01T10:00:00.000Z'),
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
    for (const [id, receiptNumber] of [
      [ids.printableSale, 8],
      // Receipt 9 must remain exclusive to branch B for the lookup isolation assertions.
      [ids.browserSale, 10],
      [ids.legacyThermalSale, 11],
      [ids.legacyBrowserSale, 12],
      [ids.untrackedSale, 13],
      [ids.failedBrowserSale, 14],
      [ids.failedThermalSale, 15],
    ] as const) {
      await tx.pharmacySale.create({
        data: {
          id,
          branchId: ids.branchA,
          status: 'COMPLETED',
          createdByUserId: ids.dispenser,
          receiptNumber,
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
              grossMinor: 100,
              proRataCeilingMinor: 100,
              unitCostMinor: 50,
              idempotencyKey: `receipt-line-${id}`,
            },
          },
        },
      });
    }
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
    const admin = { id: ids.counterAdmin, role: 'ADMIN' as const, organizationId: ids.orgA };
    const before = await withTenantDb(ids.orgA, (tx) =>
      Promise.all([tx.pharmacySale.count(), tx.pharmacyTender.count()])
    );

    await withPlatformDb((tx) =>
      tx.organization.update({ where: { id: ids.orgA }, data: { status: 'ONBOARDING' } })
    );
    await expect(
      act(ids.orgA, admin, (api) =>
        api.create({ branchId: ids.branchA, quotation: false, deviceId: 'regulatory-test-device' })
      )
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

    // GRACE is an operating lifecycle state: the lifecycle check passes and the
    // branch profile decides (still missing here).
    await withPlatformDb((tx) =>
      tx.organization.update({ where: { id: ids.orgA }, data: { status: 'GRACE' } })
    );
    try {
      await expect(
        act(ids.orgA, admin, (api) =>
          api.create({
            branchId: ids.branchA,
            quotation: false,
            deviceId: 'regulatory-test-device',
          })
        )
      ).rejects.toMatchObject({ code: 'FORBIDDEN', message: 'PROFILE_MISSING' });
    } finally {
      await withPlatformDb((tx) =>
        tx.organization.update({ where: { id: ids.orgA }, data: { status: 'ACTIVE' } })
      );
    }

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

  it('conservatively seeds legacy receipts at cutover and preserves new original eligibility on rerun', async () => {
    // Simulate receipts issued before the cutover, with no authoritative print state.
    await withTenantDb(ids.orgA, (tx) => tx.pharmacyReceiptPrintState.deleteMany({
      where: { saleId: { in: [ids.legacyThermalSale, ids.legacyBrowserSale, ids.saleB] } },
    }));
    const cutover = readFileSync(join(process.cwd(),
      'prisma/migrations/20261110111300_pharmacy_receipt_print_cutover/migration.sql'), 'utf8');
    // The whole file, with its own transaction and settings, as the schema owner, twice.
    const owner = new pg.Client({ connectionString: ownerUrl });
    await owner.connect();
    try {
      await owner.query(cutover);
      await owner.query(cutover);
    } finally {
      await owner.end();
    }
    const states = await withTenantDb(ids.orgA, (tx) => tx.pharmacyReceiptPrintState.findMany({
      where: { branchId: ids.branchA, saleId: { in: [ids.legacyThermalSale, ids.legacyBrowserSale, ids.printableSale] } },
    }));
    expect(states.find((row) => row.saleId === ids.printableSale)?.copyCount).toBe(0);
    expect(states.find((row) => row.saleId === ids.legacyThermalSale)?.copyCount).toBe(1);
    expect(states.find((row) => row.saleId === ids.legacyBrowserSale)?.copyCount).toBe(1);
    // Migration backfill is not restricted to the operator's assigned branch.
    await expect(withTenantDb(ids.orgA, (tx) => tx.pharmacyReceiptPrintState.findFirst({
      where: { branchId: ids.branchB, saleId: ids.saleB },
    }))).resolves.toMatchObject({ copyCount: 1 });

    // Ordinary tenant access still cannot see another organization's print state.
    await expect(withTenantDb(ids.orgB, (tx) => tx.pharmacyReceiptPrintState.findMany({
      where: { saleId: ids.legacyThermalSale },
    }))).resolves.toEqual([]);

    // A later edit of an already-issued receipt must never reset eligibility,
    // even if its print state is missing. Only new issuance establishes zero.
    await withTenantDb(ids.orgA, async (tx) => {
      await tx.pharmacyReceiptPrintState.deleteMany({
        where: { branchId: ids.branchA, saleId: ids.legacyThermalSale },
      });
      await tx.pharmacySale.update({
        where: { id: ids.legacyThermalSale },
        data: { completedAt: new Date('2026-10-01T08:00:00.000Z') },
      });
      expect(await tx.pharmacyReceiptPrintState.findFirst({
        where: { branchId: ids.branchA, saleId: ids.legacyThermalSale },
      })).toBeNull();
    });
    await expect(act(ids.orgA, dispenser, (api) => api.counterReceiptPrintJob({
      branchId: ids.branchA, saleId: ids.legacyThermalSale, locale: 'en',
    }))).resolves.toMatchObject({ status: 'READY', copyNumber: 2, reprint: true });
    await expect(act(ids.orgA, dispenser, (api) => api.counterReceiptBrowserPrint({
      branchId: ids.branchA, saleId: ids.legacyBrowserSale, locale: 'en',
    }))).resolves.toMatchObject({ copyNumber: 2, reprint: true });
  });

  it('never grants an original to missing state, including concurrent mixed transports', async () => {
    await withTenantDb(ids.orgA, (tx) => tx.pharmacyReceiptPrintState.deleteMany({
      where: { branchId: ids.branchA, saleId: ids.untrackedSale },
    }));
    const input = { branchId: ids.branchA, saleId: ids.untrackedSale, locale: 'en' as const };
    const results = await Promise.all([
      act(ids.orgA, dispenser, (api) => api.counterReceiptPrintJob(input)),
      act(ids.orgA, dispenser, (api) => api.counterReceiptBrowserPrint(input)),
    ]);
    expect(results.map((result) => result.copyNumber).sort()).toEqual([2, 3]);
    expect(results.every((result) => result.reprint)).toBe(true);
    const persisted = await withTenantDb(ids.orgA, (tx) => tx.pharmacyReceiptPrintState.findFirst({
      where: { branchId: ids.branchA, saleId: ids.untrackedSale },
    }));
    expect(persisted?.copyCount).toBe(3);
  });

  it.each(['browser', 'thermal'] as const)(
    'persists a failed browser attempt without consuming the first successful %s copy',
    async (transport) => {
      const saleId = transport === 'browser' ? ids.failedBrowserSale : ids.failedThermalSale;
      const input = { branchId: ids.branchA, saleId, locale: 'en' as const };
      await act(ids.orgA, dispenser, (api) => api.counterReceiptBrowserPrintFailed(input));
      const persisted = await withTenantDb(ids.orgA, async (tx) => ({
        state: await tx.pharmacyReceiptPrintState.findFirst({ where: { saleId } }),
        audit: await tx.auditLog.findMany({
          where: { action: 'pharmacySales.counterReceiptBrowserPrintFailed', targetId: saleId },
        }),
      }));
      expect(persisted.state?.copyCount).toBe(0);
      expect(persisted.audit).toEqual([expect.objectContaining({
        organizationId: ids.orgA, actorId: ids.dispenser, outcome: 'FAILURE',
        errorCode: 'BROWSER_PRINT_NOT_READY', metadata: { branchId: ids.branchA, locale: 'en' },
      })]);
      await expect(act(ids.orgA, dispenser, (api) => transport === 'browser'
        ? api.counterReceiptBrowserPrint(input)
        : api.counterReceiptPrintJob(input)))
        .resolves.toMatchObject({ copyNumber: 1, reprint: false });
      await expect(act(ids.orgA, dispenser, (api) => api.counterReceiptPrintJob(input)))
        .resolves.toMatchObject({ copyNumber: 2, reprint: true });
    }
  );

  it('establishes original eligibility atomically when an open sale is issued after cutover', async () => {
    await withTenantDb(ids.orgA, async (tx) => {
      await tx.pharmacySale.create({ data: {
        id: ids.laterIssuedSale, branchId: ids.branchA, status: 'OPEN', createdByUserId: ids.dispenser,
      } });
      expect(await tx.pharmacyReceiptPrintState.findFirst({
        where: { saleId: ids.laterIssuedSale },
      })).toBeNull();
      await tx.pharmacySale.update({ where: { id: ids.laterIssuedSale }, data: {
        status: 'COMPLETED', receiptNumber: 16, receiptDeviceId: 'device-a',
        businessDate: new Date('2026-10-01T00:00:00.000Z'), completedAt: new Date(),
      } });
      expect(await tx.pharmacyReceiptPrintState.findFirst({
        where: { saleId: ids.laterIssuedSale },
      })).toMatchObject({ copyCount: 0, organizationId: ids.orgA, branchId: ids.branchA });
    });
  });

  it('durably allocates one original and sequential marked copies under concurrency', async () => {
    // A fallback is returned successfully inside an existing tenant transaction.
    // It must not consume the original copy before any job has been delivered.
    await expect(
      act(ids.orgA, dispenser, (api) =>
        api.counterReceiptPrintJob({
          branchId: ids.branchA,
          saleId: ids.printableSale,
          locale: 'ur',
        })
      )
    ).resolves.toMatchObject({ status: 'FALLBACK', fallback: 'BROWSER_OS' });

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
          saleId: ids.browserSale,
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
          where: { branchId: ids.branchA, saleId: ids.browserSale },
        })
      )
    ).resolves.toBe(0);

    for (const allocation of [first, afterReload]) {
      await act(ids.orgA, dispenser, (api) =>
        api.counterReceiptBrowserPrintDispatched({
          branchId: ids.branchA,
          saleId: ids.browserSale,
          locale: 'en',
          copyNumber: allocation.copyNumber,
        })
      );
    }

    const dispatches = await withTenantDb(ids.orgA, (tx) =>
      tx.pharmacyReceiptPrintDispatch.findMany({
        where: { branchId: ids.branchA, saleId: ids.browserSale },
        orderBy: { copyNumber: 'asc' },
      })
    );
    expect(dispatches).toHaveLength(2);
    expect(dispatches.map(({ copyNumber }) => copyNumber)).toEqual([1, 2]);
  });

  it('binds browser dispatch confirmation to the allocating operator and locale', async () => {
    const admin = { id: ids.admin, role: 'ADMIN' as const, organizationId: ids.orgA };
    const allocation = await act(ids.orgA, dispenser, (api) =>
      api.counterReceiptBrowserPrint({
        branchId: ids.branchA,
        saleId: ids.browserSale,
        locale: 'en',
      })
    );
    const confirm = (
      user: typeof dispenser | typeof admin,
      locale: 'en' | 'ur' = 'en'
    ) =>
      act(ids.orgA, user, (api) =>
        api.counterReceiptBrowserPrintDispatched({
          branchId: ids.branchA,
          saleId: ids.browserSale,
          locale,
          copyNumber: allocation.copyNumber,
        })
      );

    // Another authorized operator cannot claim this allocation first.
    await expect(confirm(admin)).rejects.toMatchObject({ code: 'CONFLICT' });
    // The owner cannot rewrite the locale of their own allocation.
    await expect(confirm(dispenser, 'ur')).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(confirm(dispenser)).resolves.toEqual({ recorded: true });
    // A retry after a lost response is an idempotent success, not a second event.
    await expect(confirm(dispenser)).resolves.toEqual({ recorded: true });
    // Once recorded, another operator still cannot claim it.
    await expect(confirm(admin)).rejects.toMatchObject({ code: 'CONFLICT' });

    const [allocations, dispatches] = await withTenantDb(ids.orgA, (tx) =>
      Promise.all([
        tx.pharmacyReceiptPrintAllocation.findMany({
          where: {
            branchId: ids.branchA,
            saleId: ids.browserSale,
            copyNumber: allocation.copyNumber,
          },
        }),
        tx.pharmacyReceiptPrintDispatch.findMany({
          where: {
            branchId: ids.branchA,
            saleId: ids.browserSale,
            copyNumber: allocation.copyNumber,
          },
        }),
      ])
    );
    expect(allocations).toEqual([
      expect.objectContaining({ actorId: ids.dispenser, locale: 'en' }),
    ]);
    expect(dispatches).toEqual([
      expect.objectContaining({ actorId: ids.dispenser, locale: 'en' }),
    ]);

    await expect(
      withTenantDb(ids.orgA, (tx) =>
        tx.$executeRawUnsafe(
          'UPDATE "pharmacy_receipt_print_allocations" SET "actorId" = $4 WHERE "organizationId" = $1 AND "branchId" = $2 AND "saleId" = $3',
          ids.orgA,
          ids.branchA,
          ids.browserSale,
          ids.admin
        )
      )
    ).rejects.toThrow(/append-only/);
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
      // An unassigned active branch reads as "not found" without exposing its receipts.
      await expect(
        api.lookupReceiptByNumber({ branchId: ids.branchB, receiptNumber: 7 })
      ).resolves.toEqual([]);
      const unassignedReceipt = await api.lookupReceiptByNumber({
        branchId: ids.branchA, receiptNumber: 9,
      });
      const missingReceipt = await api.lookupReceiptByNumber({
        branchId: ids.branchA, receiptNumber: 99999,
      });
      expect(unassignedReceipt).toEqual([]);
      expect(unassignedReceipt).toEqual(missingReceipt);
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
      ).resolves.toEqual([
        expect.objectContaining({ id: ids.saleB }),
        expect.objectContaining({ id: ids.saleA }),
      ]);
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
        ).resolves.toEqual([
          expect.objectContaining({ id: ids.saleA, branchId: ids.branchA }),
          expect.objectContaining({ id: ids.saleB, branchId: ids.branchB }),
        ]);
        await expect(
          api.lookupReceiptByNumber({ branchId: ids.branchB, receiptNumber: 7 })
        ).resolves.toEqual([
          expect.objectContaining({ id: ids.saleB, branchId: ids.branchB }),
          expect.objectContaining({ id: ids.saleA, branchId: ids.branchA }),
        ]);
        await expect(
          api.lookupReceiptByNumber({ branchId: ids.branchA, receiptNumber: 9 })
        ).resolves.toEqual([expect.objectContaining({ id: ids.saleBOnly })]);
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
