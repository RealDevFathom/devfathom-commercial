// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { assertRlsEnforcingRole } from '@/lib/testing/rls-role-guard';
import type { TRPCContext } from '../trpc';

vi.mock('server-only', () => ({}));

const url = process.env.TEST_DATABASE_URL;
if (url) process.env.DATABASE_URL = url;
const suite = url ? describe : describe.skip;
const oid = `valuation-${randomUUID()}`;
const main = `${oid}-main`;
const east = `${oid}-east`;
const admin = `${oid}-admin`;
const staff = `${oid}-staff`;
const reports = `${oid}-reports`;
const accounts = `${oid}-accounts`;
const today = new Date();
const offset = (days: number) => new Date(today.getTime() + 86_400_000 * days);

let scoped: typeof import('@/lib/tenancy/scoped-db');
let inventory: typeof import('./pharmacy-inventory');
let finance: typeof import('./pharmacy-finance');
let post: typeof import('@/lib/finance/journal').postJournalEntry;
let receive: typeof import('@/lib/pharmacy/stock-ledger').receiveLot;
let disconnect: (() => Promise<void>) | undefined;
const lotIds = new Map<string, string>();

function context(db: ScopedDb, userId: string) {
  return {
    db,
    entitlements: {
      organizationId: oid,
      enabledModules: ['pharmacy-inventory', 'pharmacy-reports', 'pharmacy-finance'],
    },
    session: {
      user: {
        id: userId,
        role: userId === admin ? 'ADMIN' : 'EMPLOYEE',
        status: 'ACTIVE',
        organizationId: oid,
      },
    },
    organization: { id: oid, vertical: 'PHARMACY', currency: 'PKR' },
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext;
}

const store = (branch: string) => `${branch}-store`;
const quarantine = (branch: string) => `${branch}-held`;

async function ledgerValue(
  db: ScopedDb,
  branchId: string,
  source: string,
  amountMinor: number,
  {
    lotId,
    accountCode = 'INVENTORY',
    occurredAt = offset(-10),
  }: { lotId?: string; accountCode?: 'INVENTORY' | 'INVENTORY_IN_TRANSIT'; occurredAt?: Date } = {}
) {
  return post(
    db,
    { organizationId: oid, actorId: admin },
    {
      sourceKind: 'PHARMACY_OPENING_STOCK',
      sourceId: source,
      description: 'Synthetic inventory valuation',
      occurredAt,
      idempotencyKey: source,
      branchId,
      lines: [
        {
          accountCode,
          side: 'DEBIT',
          amountMinor,
          branchId,
          lotId,
          locationId: lotId ? store(branchId) : null,
        },
        { accountCode: 'OPENING_BALANCE_EQUITY', side: 'CREDIT', amountMinor, branchId },
      ],
    }
  );
}

async function product(db: ScopedDb, name: string, category: string, unitsPerPack: number) {
  const medicine = await db.medicine.create({
    data: {
      productName: name,
      productFamily: 'FRONT_SHOP',
      retailCategory: category,
      presentations: { create: { organizationId: oid, presentation: name } },
    },
    include: { presentations: true },
  });
  const pack = await db.packLevel.create({
    data: {
      presentationId: medicine.presentations[0]!.id,
      versionGroupId: medicine.id,
      version: 1,
      level: unitsPerPack === 1 ? 'UNIT' : 'BOX',
      unitsPerParent: unitsPerPack,
      effectiveFrom: offset(-30),
    },
  });
  return { medicineId: medicine.id, packLevelId: pack.id, unitsPerPack };
}

async function takeStock(
  db: ScopedDb,
  branchId: string,
  label: string,
  item: Awaited<ReturnType<typeof product>>,
  options: {
    days: number;
    qty: number;
    cost: number;
    price: number;
    posted: number;
    held?: number;
  }
) {
  const scope = { organizationId: oid, branchId, actorId: admin };
  const batch = await db.pharmacyManufacturingBatch.create({
    data: { medicineId: item.medicineId, batchNumber: label, expiresAt: offset(options.days) },
  });
  const { lot } = await receive(db, scope, {
    manufacturingBatchId: batch.id,
    unitsPerPack: item.unitsPerPack,
    packLevelId: item.packLevelId,
    stockLocationId: store(branchId),
    supplierName: 'Synthetic supplier',
    supplierInvoiceRef: label,
    unitCostMinor: options.cost,
    printedMrpMinor: options.price,
    receivedExpiresAt: batch.expiresAt!,
    receivedExpiryPrecision: 'DAY',
    quantityUnits: options.qty,
    idempotencyKey: label,
    receivedAt: offset(-10),
    ...(options.held
      ? {
          quarantine: {
            stockLocationId: quarantine(branchId),
            units: options.held,
            idempotencyKey: `${label}-held`,
            reason: 'Synthetic partial hold',
          },
        }
      : {}),
  });
  lotIds.set(label, lot.id);
  if (options.posted) await ledgerValue(db, branchId, label, options.posted, { lotId: lot.id });
  return lot.id;
}

async function stock(userId: string, branchId = main, allBranches = false) {
  return scoped.withTenantDb(oid, (db) =>
    inventory.pharmacyInventoryRouter
      .createCaller(context(db, userId))
      .stockValuation({ branchId, allBranches })
  );
}

beforeAll(async () => {
  if (!url) return;
  scoped = await import('@/lib/tenancy/scoped-db');
  await assertRlsEnforcingRole(scoped.withPlatformDb);
  const { db } = await import('@/lib/db');
  disconnect = () => db.$disconnect();
  inventory = await import('./pharmacy-inventory');
  finance = await import('./pharmacy-finance');
  ({ postJournalEntry: post } = await import('@/lib/finance/journal'));
  ({ receiveLot: receive } = await import('@/lib/pharmacy/stock-ledger'));
  const { seedDepartments } = await import('@/lib/test-support/departments');
  await scoped.withPlatformDb(
    (tx) => tx.$executeRaw`
    INSERT INTO organizations (id, slug, "legalName", "displayName", vertical, status, "deploymentMode", "createdAt", "updatedAt")
    VALUES (${oid}, ${oid}, 'Stock valuation test', 'Stock valuation test', 'PHARMACY', 'ACTIVE', 'SHARED', now(), now())`
  );
  await scoped.withTenantDb(
    oid,
    async (tx) => {
      await seedDepartments(tx, [oid], ['LEADERSHIP']);
      for (const branch of [main, east]) {
        await tx.pharmacyBranch.create({
          data: {
            id: branch,
            code: branch === main ? 'M' : 'E',
            name: branch,
            addressLine: 'Test Road',
            city: 'Lahore',
            provinceCode: 'PB',
          },
        });
        await tx.pharmacyStockLocation.createMany({
          data: [
            {
              id: store(branch),
              branchId: branch,
              code: 'STORE',
              name: 'Stockroom',
              kind: 'STORE',
            },
            {
              id: quarantine(branch),
              branchId: branch,
              code: 'HELD',
              name: 'Set aside',
              kind: 'QUARANTINE',
            },
          ],
        });
      }
      for (const [id, capabilities] of [
        [admin, ['pharmacy:inventory', 'reports:financial', 'reports:operational', 'finance:read']],
        [staff, ['pharmacy:inventory']],
        [reports, ['reports:financial']],
        [accounts, ['finance:read']],
      ] as const) {
        const role = await tx.organizationRole.create({
          data: {
            key: id,
            name: id,
            permissions: {
              create: capabilities.map((capability) => ({ capability, effect: 'ALLOW' })),
            },
          },
        });
        await tx.user.create({
          data: {
            id,
            email: `${id}@example.test`,
            name: id,
            department: 'LEADERSHIP',
            title: 'Synthetic inventory role',
            role: id === admin ? 'ADMIN' : 'EMPLOYEE',
            status: 'ACTIVE',
            organizationRoleId: role.id,
          },
        });
        if (id !== admin)
          await tx.pharmacyBranchAssignment.create({ data: { branchId: main, userId: id } });
      }
      const soap = await product(tx, 'Soap', 'Personal care', 10);
      await takeStock(tx, main, 'soap', soap, {
        days: 10,
        qty: 10,
        held: 2,
        cost: 100,
        price: 3000,
        posted: 1800,
      });
      await takeStock(tx, main, 'cream', await product(tx, 'Cream', 'Personal care', 1), {
        days: 40,
        qty: 1,
        cost: 200,
        price: 700,
        posted: 200,
      });
      await takeStock(tx, main, 'wrap', await product(tx, 'Wrap', 'First aid', 1), {
        days: 75,
        qty: 1,
        cost: 300,
        price: 800,
        posted: 300,
      });
      await takeStock(tx, main, 'gauze', await product(tx, 'Gauze', 'First aid', 1), {
        days: -1,
        qty: 1,
        cost: 400,
        price: 900,
        posted: 400,
      });
      await takeStock(tx, main, 'unknown', await product(tx, 'No recorded cost', 'First aid', 1), {
        days: 1,
        qty: 1,
        cost: 0,
        price: 500,
        posted: 0,
      });
      await takeStock(tx, east, 'soap-east', soap, {
        days: 10,
        qty: 10,
        cost: 100,
        price: 3000,
        posted: 1000,
      });
      await ledgerValue(tx, main, 'without-a-lot', 20);
      await ledgerValue(tx, main, 'future-entry', 730, {
        lotId: lotIds.get('soap'),
        occurredAt: offset(1),
      });

      const packet = await product(tx, 'Packet in transit', 'First aid', 10);
      const moving = await takeStock(tx, main, 'packet', packet, {
        days: 20,
        qty: 10,
        cost: 50,
        price: 2000,
        posted: 0,
      });
      const balances = {
        branchId: main,
        inventoryLotId: moving,
        stockLocationId: store(main),
        actorId: admin,
      };
      await tx.pharmacyStockMovement.createMany({
        data: [
          {
            ...balances,
            organizationId: oid,
            kind: 'TRANSFER_OUT',
            disposition: 'AVAILABLE',
            quantityUnits: -10,
            sealedPackDelta: -1,
            looseUnitDelta: 0,
            idempotencyKey: 'move-out',
            occurredAt: offset(-1),
          },
          {
            ...balances,
            organizationId: oid,
            kind: 'TRANSFER_IN',
            disposition: 'IN_TRANSIT',
            quantityUnits: 10,
            sealedPackDelta: 1,
            looseUnitDelta: 0,
            idempotencyKey: 'move-transit',
            occurredAt: offset(-1),
          },
        ],
      });
      await tx.pharmacyInterbranchTransfer.create({
        data: {
          fromBranchId: main,
          toBranchId: east,
          status: 'DISPATCHED',
          allocatedById: admin,
          dispatchedAt: offset(-1),
          lines: {
            create: {
              sourceBranchId: main,
              sourceLotId: moving,
              sourceStockLocationId: store(main),
              destinationStockLocationId: store(east),
              quantityUnits: 10,
            },
          },
        },
      });
      await ledgerValue(tx, east, 'posted-transit', 500, {
        lotId: moving,
        accountCode: 'INVENTORY_IN_TRANSIT',
      });
    },
    { timeout: 40_000 }
  );
}, 60_000);

afterAll(async () => disconnect?.());

suite('DEV-1044 valuation on PostgreSQL', () => {
  it('uses the same posted valuation as Finance for each cost figure and independently checks price and quantity on the same fixture', async () => {
    const result = await stock(admin);
    const values = result.money!;
    expect(values).not.toBeNull();
    const report = await scoped.withTenantDb(oid, (db) =>
      finance.pharmacyFinanceRouter
        .createCaller(context(db, admin))
        .perpetualValuation({ branchId: main, at: values.asOf })
    );
    const financeCost = (labels: string[]) =>
      report.rows
        .filter((row) => labels.some((label) => lotIds.get(label) === row.lotId))
        .reduce((sum, row) => sum + BigInt(row.valueMinor), BigInt(0));
    expect(values.costMinor).toBe(
      financeCost(['soap', 'cream', 'wrap', 'gauze']) + report.unallocatedValueMinor
    );
    expect(values.costMinor).toBe(BigInt(2720));
    expect(values.unassignedCostMinor).toBe(BigInt(20));
    expect(values.expiringMinor[0]).toBe(financeCost(['soap']));
    expect(values.expiringMinor[1]).toBe(financeCost(['soap', 'cream']));
    expect(values.expiringMinor[2]).toBe(financeCost(['soap', 'cream', 'wrap']));
    expect(values.expiredMinor).toBe(financeCost(['gauze']));
    expect(values.heldMinor).toBe((financeCost(['soap']) * BigInt(2)) / BigInt(12));
    expect(values.categories.map(({ name, costMinor }) => [name, costMinor])).toEqual([
      ['Personal care', financeCost(['soap', 'cream'])],
      ['First aid', financeCost(['wrap', 'gauze'])],
    ]);
    expect(values.topProducts.map(({ name, costMinor }) => [name, costMinor])).toEqual([
      ['Soap', financeCost(['soap'])],
      ['Gauze', financeCost(['gauze'])],
      ['Wrap', financeCost(['wrap'])],
      ['Cream', financeCost(['cream'])],
    ]);
    expect(result.productCount).toBe(5);
    expect(values.sellingMinor).toBe(BigInt(6500));
    expect(values.coveredProductCount).toBe(4);
    expect(values.missingCost).toMatchObject({ count: 1, rows: [{ name: 'No recorded cost' }] });
  });

  it('parcels stock by admitted branch, with in-transit cost and units on the receiving side', async () => {
    const [branch, business, storekeeper, financialReports, readAccounts] = await Promise.all([
      stock(admin, east),
      stock(admin, main, true),
      stock(staff, main, true),
      stock(reports, main, true),
      stock(accounts, main, true),
    ]);
    expect(branch).toMatchObject({
      productCount: 2,
      businessTotal: false,
      money: {
        costMinor: BigInt(1500),
        sellingMinor: BigInt(5000),
        heldMinor: BigInt(500),
        expiringMinor: [BigInt(1500), BigInt(1500), BigInt(1500)],
      },
    });
    const report = await scoped.withTenantDb(oid, (db) =>
      finance.pharmacyFinanceRouter
        .createCaller(context(db, admin))
        .perpetualValuation({ branchId: east, at: branch.money!.asOf })
    );
    expect(branch.money?.costMinor).toBe(
      report.rows.reduce((sum, row) => sum + BigInt(row.valueMinor), report.unallocatedValueMinor)
    );
    expect(business).toMatchObject({
      productCount: 6,
      businessTotal: true,
      money: { costMinor: BigInt(4220), sellingMinor: BigInt(11500), heldMinor: BigInt(800) },
    });
    expect(storekeeper).toEqual({
      productCount: 5,
      businessTotal: false,
      canSeeBusinessTotal: false,
      money: null,
    });
    for (const permitted of [financialReports, readAccounts])
      expect(permitted).toMatchObject({
        productCount: 5,
        businessTotal: false,
        canSeeBusinessTotal: false,
        money: { costMinor: BigInt(2720), canOpenFinanceReport: false },
      });
  });
});
