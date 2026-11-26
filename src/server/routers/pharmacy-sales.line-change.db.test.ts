/**
 * DEV-977B (Counter v2, phase 2A): a bill line's quantity and sale unit are changed, and a line
 * is removed, on the bill itself. Real router and domain, PostgreSQL as a NOSUPERUSER
 * NOBYPASSRLS role with row-level security on. Each change keeps every rule of adding a line:
 * stock sufficiency and FEFO, the Rx grant, controlled and prescription lines, approvals tied to
 * a quantity, held/closed/paid bills, another cashier's bill, another branch and organisation,
 * idempotent retries, the audit trail, and no oversell or lost stock under concurrent writes.
 * Skipped unless TEST_DATABASE_URL is set.
 */
import { randomBytes } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { workspaceToday } from '@/lib/timezone';
import {
  pharmacyRegulatoryFixture,
  retirePharmacyRegulatoryRules,
} from '@/lib/test-support/pharmacy-regulatory';

const databaseUrl = process.env.TEST_DATABASE_URL;
if (databaseUrl) process.env.DATABASE_URL = databaseUrl;
process.env.PLATFORM_ENCRYPTION_KEY ??= randomBytes(32).toString('base64');
const describeIfDatabase = databaseUrl ? describe : describe.skip;

const audit = vi.hoisted(() => ({ calls: [] as Array<Record<string, unknown>> }));
vi.mock('@/server/audit', async () => {
  const actual = await vi.importActual<typeof import('@/server/audit')>('@/server/audit');
  return {
    ...actual,
    recordTrpcAudit: vi.fn(async (input: Record<string, unknown>) => {
      audit.calls.push(input);
    }),
  };
});

const suffix = randomBytes(6).toString('hex');
const ids = {
  org: `org_lc_${suffix}`,
  otherOrg: `org_lc_other_${suffix}`,
  branch: `br_lc_${suffix}`,
  otherBranch: `br_lc_b2_${suffix}`,
  outsiderBranch: `br_lc_out_${suffix}`,
  cashier: `user_lc_cashier_${suffix}`,
  cashierB: `user_lc_cashierb_${suffix}`,
  pharmacist: `user_lc_pharm_${suffix}`,
  manager: `user_lc_mgr_${suffix}`,
  outsider: `user_lc_out_${suffix}`,
};
const rulesId = pharmacyRegulatoryFixture(ids.branch).rules.id;
const otherRulesId = pharmacyRegulatoryFixture(ids.otherBranch).rules.id;
const outsiderRulesId = pharmacyRegulatoryFixture(ids.outsiderBranch).rules.id;
const businessDate = new Date(`${workspaceToday('UTC')}T00:00:00.000Z`);
const deviceFor = (userId: string) => `device-${userId}`;
const key = () => `test:${randomBytes(8).toString('hex')}`;

type ScopedDb = import('@/lib/tenancy/scoped-db').ScopedDb;
type CartLine = {
  saleLineId: string;
  medicineId: string;
  saleUnit: string;
  quantity: number;
  canonicalUnits: number;
  packLevelId?: string;
  canonicalUnitsPerSaleUnit?: number;
  discountMinor: number;
  lineTotalMinor: number;
  allocations: Array<{ inventoryLotId: string; canonicalUnits: number; overridden: boolean }>;
};
type Cart = {
  status: string;
  lines: CartLine[];
  totals: { grossMinor: number; discountMinor: number; netMinor: number; tenderedMinor: number };
};
type SalesCaller = {
  create: (input: { branchId: string; deviceId: string }) => Promise<{ id: string }>;
  addLine: (input: Record<string, unknown>) => Promise<{ line: { id: string } }>;
  changeLine: (input: Record<string, unknown>) => Promise<{
    line: { id: string; quantity: number };
    replacedSaleLineId: string | null;
    replayed: boolean;
    unchanged?: boolean;
  }>;
  removeLine: (
    input: Record<string, unknown>
  ) => Promise<{ saleLineId: string; removed: boolean; replayed: boolean }>;
  counterCart: (input: { branchId: string; saleId: string }) => Promise<Cart>;
  openDrawer: (input: Record<string, unknown>) => Promise<unknown>;
  tender: (input: Record<string, unknown>) => Promise<{ settled: boolean }>;
  transition: (input: Record<string, unknown>) => Promise<unknown>;
};

let withTenantDb: typeof import('@/lib/tenancy/scoped-db').withTenantDb;
let withPlatformDb: typeof import('@/lib/tenancy/scoped-db').withPlatformDb;
let pharmacySalesRouter: typeof import('./pharmacy-sales').pharmacySalesRouter;
let disconnect: (() => Promise<void>) | null = null;

type Item = { medicineId: string; presentationId: string; packLevelId: string };
type StockedItem = Item & { lots: string[] };
/** Prescription-only, 200 units. */
let rx: Item;
let ledger: typeof import('@/lib/pharmacy/stock-ledger');
let locationId: string;
let patientId: string;
let prescriptionLineId: string;

function caller(userId: string, organizationId: string, db: ScopedDb) {
  return pharmacySalesRouter.createCaller({
    db,
    entitlements: {
      organizationId,
      enabledModules: ['pharmacy-counter'],
      modules: [],
      limits: {},
      seatLimit: 10,
      activeSeats: 1,
    },
    session: {
      expires: 'later',
      user: {
        id: userId,
        role: 'EMPLOYEE',
        department: 'LEADERSHIP',
        status: 'ACTIVE',
        organizationId,
      },
    },
    organization: { id: organizationId, vertical: 'PHARMACY' },
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as never) as unknown as SalesCaller;
}

function act<T>(
  userId: string,
  run: (api: SalesCaller, db: ScopedDb) => Promise<T>,
  organizationId = ids.org
) {
  return withTenantDb(organizationId, (db) => run(caller(userId, organizationId, db), db), {
    timeout: 60_000,
    userId,
  });
}

const strip = (item: Item, saleId: string, quantity: number, branchId = ids.branch) => ({
  branchId,
  saleId,
  medicineId: item.medicineId,
  presentationId: item.presentationId,
  packLevelId: item.packLevelId,
  saleUnit: 'STRIP',
  quantity,
  canonicalUnitsPerSaleUnit: 10,
  idempotencyKey: key(),
});
const loose = (item: Item, saleId: string, quantity: number) => ({
  ...strip(item, saleId, quantity),
  saleUnit: 'UNIT',
  canonicalUnitsPerSaleUnit: 1,
});
const change = (
  line: { saleId: string; saleLineId: string },
  item: Item,
  quantity: number,
  unit: 'STRIP' | 'UNIT' = 'STRIP',
  idempotencyKey = key()
) => ({
  branchId: ids.branch,
  saleId: line.saleId,
  saleLineId: line.saleLineId,
  packLevelId: item.packLevelId,
  saleUnit: unit,
  quantity,
  canonicalUnitsPerSaleUnit: unit === 'STRIP' ? 10 : 1,
  idempotencyKey,
});
const remove = (line: { saleId: string; saleLineId: string }, idempotencyKey = key()) => ({
  branchId: ids.branch,
  saleId: line.saleId,
  saleLineId: line.saleLineId,
  idempotencyKey,
});

/** A bill the user opens on their own counter, with the given lines added by the same user. */
async function bill(
  userId: string,
  lines: Array<(saleId: string) => Record<string, unknown>>
): Promise<{ saleId: string; lineIds: string[] }> {
  return act(userId, async (api) => {
    const sale = await api.create({ branchId: ids.branch, deviceId: deviceFor(userId) });
    const lineIds: string[] = [];
    for (const line of lines) lineIds.push((await api.addLine(line(sale.id))).line.id);
    return { saleId: sale.id, lineIds };
  });
}

const cartOf = (saleId: string, userId = ids.manager) =>
  act(userId, (api) => api.counterCart({ branchId: ids.branch, saleId }));

/** Units on hand of a medicine at the branch: the signed sum of every stock movement. */
const onHand = (medicineId: string) =>
  withTenantDb(ids.org, async (db) => {
    const sum = await db.pharmacyStockMovement.aggregate({
      where: { branchId: ids.branch, lot: { batch: { medicineId } } },
      _sum: { quantityUnits: true },
    });
    return sum._sum.quantityUnits ?? 0;
  });

const pay = (userId: string, saleId: string, amountMinor: number) =>
  act(userId, (api) =>
    api.tender({
      branchId: ids.branch,
      saleId,
      deviceId: deviceFor(userId),
      businessDate,
      type: 'CASH',
      amountMinor,
      cashReceivedMinor: amountMinor,
      idempotencyKey: key(),
    })
  );

const totalsOf = (cart: Cart) => ({
  grossMinor: cart.totals.grossMinor,
  discountMinor: cart.totals.discountMinor,
  netMinor: cart.totals.netMinor,
});

/** Every line still on the bill holds exactly the stock its allocations took. */
async function expectStockMatchesBills(medicineId: string, received: number) {
  const units = await withTenantDb(ids.org, async (db) => {
    const lines = await db.pharmacySaleLine.findMany({
      where: { branchId: ids.branch, medicineId, sale: { status: { not: 'VOID' } } },
      select: { canonicalUnits: true },
    });
    return lines.reduce((sum, line) => sum + line.canonicalUnits, 0);
  });
  expect(await onHand(medicineId)).toBe(received - units);
  expect(await onHand(medicineId)).toBeGreaterThanOrEqual(0);
}

let itemCount = 0;
/**
 * A medicine of its own for one test, so its prices and stock never depend on another test.
 * Every lot is received as sealed strips of 10 and broken to loose units, so a strip or a loose
 * tablet can be sold from it. Lots are listed earliest expiry first.
 */
async function stockedItem(
  name: string,
  lots: Array<{ expiresAt: string; units: number; mrp: number }>,
  flags: { rx?: boolean; openedUnits?: number; unitsPerPack?: number } = {}
): Promise<StockedItem> {
  itemCount += 1;
  const tag = `${itemCount}-${suffix}`;
  return withTenantDb(ids.org, async (tx) => {
    const scope = { organizationId: ids.org, branchId: ids.branch, actorId: ids.manager };
    const medicine = await tx.medicine.create({
      data: {
        productName: `${name} ${tag}`,
        productFamily: 'PHARMACEUTICAL',
        rx: flags.rx ?? false,
        otc: !flags.rx,
        saleable: true,
        presentations: { create: { presentation: 'Tablet, 10 per strip' } },
      },
      include: { presentations: true },
    });
    const packLevel = await tx.packLevel.create({
      data: {
        presentationId: medicine.presentations[0]!.id,
        versionGroupId: `strip-${tag}`,
        version: 1,
        level: 'STRIP',
        unitsPerParent: flags.unitsPerPack ?? 10,
        effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
      },
    });
    const lotIds: string[] = [];
    for (const [index, lot] of lots.entries()) {
      const expiresAt = new Date(`${lot.expiresAt}T00:00:00.000Z`);
      const batch = await tx.pharmacyManufacturingBatch.create({
        data: {
          medicineId: medicine.id,
          batchNumber: `B${index}-${tag}`,
          expiresAt,
          expiryPrecision: 'DAY',
        },
      });
      const received = await ledger.receiveLot(tx, scope, {
        manufacturingBatchId: batch.id,
        packLevelId: packLevel.id,
        stockLocationId: locationId,
        unitsPerPack: flags.unitsPerPack ?? 10,
        supplierName: 'Distributor Ltd',
        supplierInvoiceRef: `INV-${index}-${tag}`,
        unitCostMinor: 100,
        printedMrpMinor: lot.mrp,
        receivedExpiresAt: expiresAt,
        receivedExpiryPrecision: 'DAY',
        quantityUnits: lot.units,
        idempotencyKey: `receipt-${index}-${tag}`,
        receivedAt: new Date('2026-02-01T00:00:00.000Z'),
      });
      await ledger.breakPack(tx, scope, {
        inventoryLotId: received.lot.id,
        stockLocationId: locationId,
        requiredLooseUnits: flags.openedUnits ?? lot.units,
        idempotencyKey: `break-${index}-${tag}`,
        at: new Date('2026-02-01T00:00:00.000Z'),
      });
      lotIds.push(received.lot.id);
    }
    return {
      medicineId: medicine.id,
      presentationId: medicine.presentations[0]!.id,
      packLevelId: packLevel.id,
      lots: lotIds,
    };
  });
}

/** Lot A: 30 units at 20.00 a strip, earliest expiry. Lot B: 200 units at 24.00 a strip. */
const twoLots = (name: string) =>
  stockedItem(name, [
    { expiresAt: '2027-06-01', units: 30, mrp: 2000 },
    { expiresAt: '2028-10-01', units: 200, mrp: 2400 },
  ]);
const oneLot = (name: string, units = 200) =>
  stockedItem(name, [{ expiresAt: '2028-01-01', units, mrp: 2000 }]);

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
  for (const [org, branches] of [
    [ids.org, [ids.branch, ids.otherBranch]],
    [ids.otherOrg, [ids.outsiderBranch]],
  ] as const) {
    for (const branch of branches) {
      const { rules } = pharmacyRegulatoryFixture(branch);
      await withPlatformDb((tx) => tx.jurisdictionRuleSet.create({ data: rules }));
    }
    await withPlatformDb((tx) =>
      tx.$executeRawUnsafe(
        `INSERT INTO organizations (id, slug, "legalName", "displayName", vertical, status, "deploymentMode", "createdAt", "updatedAt")
         VALUES ($1, $1, 'Line change', 'Line change', 'PHARMACY', 'ACTIVE', 'SHARED', now(), now())`,
        org
      )
    );
    await withTenantDb(org, async (tx) => {
      await seedDepartments(tx, [org], ['LEADERSHIP']);
      for (const branch of branches) {
        await tx.pharmacyBranch.create({
          data: {
            id: branch,
            code: branch.split('_')[2]!.toUpperCase(),
            name: `Counter ${branch.split('_')[2]}`,
            addressLine: '1 Road',
            city: 'Lahore',
            provinceCode: 'PB',
          },
        });
        await tx.branchRegulatoryProfile.create({
          data: {
            ...pharmacyRegulatoryFixture(branch).profile,
            premises: { addressLine: '1 Road', city: 'Lahore' },
          },
        });
      }
    });
  }
  const users: Array<{ id: string; org: string; branch: string; grants: string[] }> = [
    {
      id: ids.cashier,
      org: ids.org,
      branch: ids.branch,
      // The shipped Cashier template's grants: counter and customer orders.
      grants: ['pharmacy:counter', 'pharmacy:orders'],
    },
    { id: ids.cashierB, org: ids.org, branch: ids.branch, grants: ['pharmacy:counter'] },
    {
      id: ids.pharmacist,
      org: ids.org,
      branch: ids.branch,
      grants: ['pharmacy:counter', 'pharmacy:dispense'],
    },
    {
      id: ids.manager,
      org: ids.org,
      branch: ids.branch,
      grants: ['pharmacy:counter', 'pharmacy:manage', 'pharmacy:discount'],
    },
    {
      id: ids.outsider,
      org: ids.otherOrg,
      branch: ids.outsiderBranch,
      grants: ['pharmacy:counter'],
    },
  ];
  for (const user of users)
    await withTenantDb(user.org, async (tx) => {
      await tx.organizationRole.create({
        data: {
          id: `role_${user.id}`,
          key: `role_${user.id}`,
          name: user.id,
          permissions: {
            create: user.grants.map((capability) => ({ capability, effect: 'ALLOW' as const })),
          },
        },
      });
      await tx.user.create({
        data: {
          id: user.id,
          name: user.id,
          email: `${user.id}@example.test`,
          department: 'LEADERSHIP',
          title: 'Counter',
          organizationRoleId: `role_${user.id}`,
        },
      });
      await tx.pharmacyBranchAssignment.create({
        data: { userId: user.id, branchId: user.branch },
      });
    });
  ledger = await import('@/lib/pharmacy/stock-ledger');
  await withTenantDb(ids.org, async (tx) => {
    const location = await tx.pharmacyStockLocation.create({
      data: { branchId: ids.branch, code: `MAIN-${suffix}`, name: 'Main', kind: 'STORE' },
    });
    locationId = location.id;
  });
  rx = await stockedItem(
    'Amoxicillin 500mg',
    [{ expiresAt: '2028-01-01', units: 200, mrp: 3000 }],
    {
      rx: true,
    }
  );
  await withTenantDb(ids.org, async (tx) => {
    const patient = await tx.pharmacyPatient.create({ data: { displayName: 'Test Patient' } });
    patientId = patient.id;
    const prescriber = await tx.pharmacyPrescriber.create({
      data: { name: 'Dr Test', registrationNumber: `PMDC-${suffix}` },
    });
    const prescription = await tx.prescription.create({
      data: {
        patientId,
        prescriberId: prescriber.id,
        sourceKind: 'PAPER_IMAGE',
        sourceFileRef: `paper:${suffix}`,
        validFrom: new Date(Date.now() - 30 * 86_400_000),
        validUntil: new Date(Date.now() + 365 * 86_400_000),
        authorizedRepeats: 100,
        capturedByUserId: ids.pharmacist,
        lines: {
          create: {
            lineNumber: 1,
            medicineId: rx.medicineId,
            presentationId: rx.presentationId,
            authorizedCanonicalUnits: 100_000,
            directions: 'One tablet a day',
          },
        },
      },
      include: { lines: true },
    });
    prescriptionLineId = prescription.lines[0]!.id;
  });
  for (const userId of [ids.cashier, ids.cashierB, ids.pharmacist, ids.manager])
    await act(userId, (api) =>
      api.openDrawer({
        branchId: ids.branch,
        deviceId: deviceFor(userId),
        businessDate,
        openingFloatMinor: 0,
      })
    );
}, 180_000);

afterAll(async () => {
  if (databaseUrl)
    await retirePharmacyRegulatoryRules(withPlatformDb, [rulesId, otherRulesId, outsiderRulesId]);
  await disconnect?.();
});

describeIfDatabase('DEV-977B change and remove a bill line', () => {
  it('changes quantity and unit on the line, with FEFO, stock and money exactly as adding', async () => {
    const otc = await twoLots('Paracetamol');
    const [lotA, lotB] = otc.lots;
    const before = await onHand(otc.medicineId);
    const { saleId, lineIds } = await bill(ids.cashier, [(id) => strip(otc, id, 1)]);
    const target = { saleId, saleLineId: lineIds[0]! };
    // Up: 1 strip -> 2 strips, both from the earliest-expiry lot.
    const up = await act(ids.cashier, (api) => api.changeLine(change(target, otc, 2)));
    expect(up).toMatchObject({ replacedSaleLineId: lineIds[0], replayed: false });
    let cart = await cartOf(saleId);
    expect(cart.lines).toHaveLength(1);
    expect(cart.lines[0]).toMatchObject({ quantity: 2, saleUnit: 'STRIP', canonicalUnits: 20 });
    expect(cart.lines[0]!.allocations).toEqual([
      expect.objectContaining({ inventoryLotId: lotA, canonicalUnits: 20 }),
    ]);
    expect(totalsOf(cart)).toEqual({ grossMinor: 4000, discountMinor: 0, netMinor: 4000 });
    expect(await onHand(otc.medicineId)).toBe(before - 20);
    // A unit change: 2 strips -> 7 loose tablets.
    const unit = await act(ids.cashier, (api) =>
      api.changeLine(change({ saleId, saleLineId: up.line.id }, otc, 7, 'UNIT'))
    );
    cart = await cartOf(saleId);
    expect(cart.lines[0]).toMatchObject({
      saleLineId: unit.line.id,
      saleUnit: 'UNIT',
      quantity: 7,
      canonicalUnits: 7,
      canonicalUnitsPerSaleUnit: 1,
    });
    expect(totalsOf(cart)).toEqual({ grossMinor: 1400, discountMinor: 0, netMinor: 1400 });
    expect(await onHand(otc.medicineId)).toBe(before - 7);
    // Across lots: 4 strips takes lot A's 30 then 10 from lot B, priced per lot.
    const mixed = await act(ids.cashier, (api) =>
      api.changeLine(change({ saleId, saleLineId: unit.line.id }, otc, 4))
    );
    cart = await cartOf(saleId);
    expect(cart.lines[0]!.saleLineId).toBe(mixed.line.id);
    expect(cart.lines[0]!.allocations).toEqual([
      expect.objectContaining({ inventoryLotId: lotA, canonicalUnits: 30 }),
      expect.objectContaining({ inventoryLotId: lotB, canonicalUnits: 10 }),
    ]);
    expect(await onHand(otc.medicineId)).toBe(before - 40);
    // The same quantity and unit changes nothing.
    const same = await act(ids.cashier, (api) =>
      api.changeLine(change({ saleId, saleLineId: mixed.line.id }, otc, 4))
    );
    expect(same).toMatchObject({ unchanged: true, replacedSaleLineId: null });
    expect((await cartOf(saleId)).lines[0]!.saleLineId).toBe(mixed.line.id);
    // Back to zero on the bill: release everything.
    await act(ids.cashier, (api) => api.removeLine(remove({ saleId, saleLineId: mixed.line.id })));
    expect(await onHand(otc.medicineId)).toBe(before);
  });

  it('removes a line, returns its stock and leaves a void record and the audit trail', async () => {
    const otc = await twoLots('Ibuprofen');
    const before = await onHand(otc.medicineId);
    const { saleId, lineIds } = await bill(ids.cashier, [
      (id) => strip(otc, id, 1),
      (id) => loose(otc, id, 3),
    ]);
    audit.calls.length = 0;
    const removed = await act(ids.cashier, (api) =>
      api.removeLine(remove({ saleId, saleLineId: lineIds[0]! }))
    );
    expect(removed).toMatchObject({ saleLineId: lineIds[0], removed: true, replayed: false });
    const cart = await cartOf(saleId);
    expect(cart.lines.map((line) => line.saleLineId)).toEqual([lineIds[1]]);
    expect(totalsOf(cart)).toEqual({ grossMinor: 600, discountMinor: 0, netMinor: 600 });
    expect(await onHand(otc.medicineId)).toBe(before - 3);
    const record = await withTenantDb(ids.org, (db) =>
      db.pharmacySaleLine.findFirstOrThrow({
        where: { id: lineIds[0] },
        select: { sale: { select: { status: true, createdByUserId: true, events: true } } },
      })
    );
    expect(record.sale).toMatchObject({ status: 'VOID', createdByUserId: ids.cashier });
    expect(record.sale.events.map((event) => event.kind).sort()).toEqual(['CREATED', 'VOIDED']);
    expect(record.sale.events.find((event) => event.kind === 'CREATED')!.payload).toMatchObject({
      cause: 'LINE_REMOVED',
      fromSaleId: saleId,
      saleLineId: lineIds[0],
    });
    expect(audit.calls).toEqual([
      expect.objectContaining({ path: 'removeLine', type: 'mutation' }),
    ]);
  });

  it('keeps a changed line in its place on the bill', async () => {
    const otc = await oneLot('Loperamide');
    const { saleId, lineIds } = await bill(ids.cashier, [
      (id) => strip(otc, id, 1),
      (id) => loose(otc, id, 2),
      (id) => strip(otc, id, 3),
    ]);
    const changed = await act(ids.cashier, (api) =>
      api.changeLine(change({ saleId, saleLineId: lineIds[0]! }, otc, 2))
    );
    const cart = await cartOf(saleId);
    expect(cart.lines.map((line) => line.saleLineId)).toEqual([
      changed.line.id,
      lineIds[1],
      lineIds[2],
    ]);
    // The change itself is dated by its own event on the bill.
    const added = await withTenantDb(ids.org, (db) =>
      db.pharmacySaleEvent.findMany({
        where: { saleId, kind: 'LINE_ADDED' },
        orderBy: { occurredAt: 'asc' },
        select: { payload: true },
      })
    );
    expect(added.at(-1)!.payload).toMatchObject({ saleLineId: changed.line.id });
  });

  it('marks a change as a void only when units come off the bill', async () => {
    const otc = await oneLot('Cetirizine');
    const { saleId, lineIds } = await bill(ids.cashier, [(id) => strip(otc, id, 2)]);
    const down = await act(ids.cashier, (api) =>
      api.changeLine(change({ saleId, saleLineId: lineIds[0]! }, otc, 1))
    );
    const up = await act(ids.cashier, (api) =>
      api.changeLine(change({ saleId, saleLineId: down.line.id }, otc, 3))
    );
    const kinds = (saleLineId: string) =>
      withTenantDb(
        ids.org,
        async (db) =>
          (
            await db.pharmacySaleLine.findFirstOrThrow({
              where: { id: saleLineId },
              select: { sale: { select: { status: true, events: { select: { kind: true } } } } },
            })
          ).sale
      );
    expect(await kinds(lineIds[0]!)).toMatchObject({
      status: 'VOID',
      events: expect.arrayContaining([{ kind: 'VOIDED' }]),
    });
    const growth = await kinds(down.line.id);
    expect(growth.status).toBe('VOID');
    expect(growth.events).toEqual([{ kind: 'CREATED' }]);
    expect((await cartOf(saleId)).lines[0]!.saleLineId).toBe(up.line.id);
  });

  it('replays a retried change or removal once, and refuses a key reused for something else', async () => {
    const otc = await oneLot('Famotidine');
    const before = await onHand(otc.medicineId);
    const { saleId, lineIds } = await bill(ids.cashier, [
      (id) => strip(otc, id, 1),
      (id) => strip(otc, id, 1),
    ]);
    const changeKey = key();
    const first = await act(ids.cashier, (api) =>
      api.changeLine(change({ saleId, saleLineId: lineIds[0]! }, otc, 2, 'STRIP', changeKey))
    );
    const retry = await act(ids.cashier, (api) =>
      api.changeLine(change({ saleId, saleLineId: lineIds[0]! }, otc, 2, 'STRIP', changeKey))
    );
    expect(retry).toMatchObject({ replayed: true, line: { id: first.line.id } });
    await expect(
      act(ids.cashier, (api) =>
        api.changeLine(change({ saleId, saleLineId: lineIds[0]! }, otc, 3, 'STRIP', changeKey))
      )
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: 'IDEMPOTENCY_CONFLICT' });
    const removeKey = key();
    await act(ids.cashier, (api) =>
      api.removeLine(remove({ saleId, saleLineId: lineIds[1]! }, removeKey))
    );
    await expect(
      act(ids.cashier, (api) =>
        api.removeLine(remove({ saleId, saleLineId: lineIds[1]! }, removeKey))
      )
    ).resolves.toMatchObject({ replayed: true });
    // A removal key is not a change key, and an add key is not either.
    await expect(
      act(ids.cashier, (api) =>
        api.removeLine(remove({ saleId, saleLineId: first.line.id }, changeKey))
      )
    ).rejects.toMatchObject({ message: 'IDEMPOTENCY_CONFLICT' });
    const added = strip(otc, saleId, 1);
    const addedLine = await act(ids.cashier, (api) => api.addLine(added));
    await expect(
      act(ids.cashier, (api) =>
        api.changeLine(
          change({ saleId, saleLineId: addedLine.line.id }, otc, 2, 'STRIP', added.idempotencyKey)
        )
      )
    ).rejects.toMatchObject({ message: 'IDEMPOTENCY_CONFLICT' });
    const cart = await cartOf(saleId);
    expect(cart.lines.map((line) => line.quantity).sort()).toEqual([1, 2]);
    expect(await onHand(otc.medicineId)).toBe(before - 30);
  });

  it('refuses more than is on hand and leaves the bill and stock untouched', async () => {
    const scarce = await oneLot('Loratadine', 20);
    const before = await onHand(scarce.medicineId);
    const { saleId, lineIds } = await bill(ids.cashier, [(id) => strip(scarce, id, 1)]);
    await expect(
      act(ids.cashier, (api) =>
        api.changeLine(change({ saleId, saleLineId: lineIds[0]! }, scarce, before / 10 + 1))
      )
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    const cart = await cartOf(saleId);
    expect(cart.lines).toEqual([expect.objectContaining({ saleLineId: lineIds[0], quantity: 1 })]);
    expect(await onHand(scarce.medicineId)).toBe(before - 10);
    // Every unit on hand is still sellable on this line.
    const all = await act(ids.cashier, (api) =>
      api.changeLine(change({ saleId, saleLineId: lineIds[0]! }, scarce, before / 10))
    );
    expect(all.line.quantity).toBe(before / 10);
    expect(await onHand(scarce.medicineId)).toBe(0);
    await act(ids.cashier, (api) => api.removeLine(remove({ saleId, saleLineId: all.line.id })));
    expect(await onHand(scarce.medicineId)).toBe(before);
  });

  it('refuses a held, voided, paid or part-paid bill', async () => {
    const otc = await oneLot('Omeprazole');
    const held = await bill(ids.cashier, [(id) => strip(otc, id, 1)]);
    await act(ids.cashier, (api) =>
      api.transition({ branchId: ids.branch, saleId: held.saleId, action: 'hold' })
    );
    const voided = await bill(ids.cashier, [(id) => strip(otc, id, 1)]);
    await act(ids.cashier, (api) =>
      api.transition({
        branchId: ids.branch,
        saleId: voided.saleId,
        action: 'void',
        voidReason: { code: 'WRONG_ITEMS' },
      })
    );
    const paid = await bill(ids.cashier, [(id) => strip(otc, id, 1)]);
    await pay(ids.cashier, paid.saleId, (await cartOf(paid.saleId)).totals.netMinor);
    for (const closed of [held, voided, paid]) {
      const line = { saleId: closed.saleId, saleLineId: closed.lineIds[0]! };
      await expect(
        act(ids.cashier, (api) => api.changeLine(change(line, otc, 2)))
      ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: 'INVALID_STATE' });
      await expect(act(ids.cashier, (api) => api.removeLine(remove(line)))).rejects.toMatchObject({
        code: 'BAD_REQUEST',
        message: 'INVALID_STATE',
      });
    }
    const partPaid = await bill(ids.cashier, [(id) => strip(otc, id, 2)]);
    await pay(ids.cashier, partPaid.saleId, 1000);
    const line = { saleId: partPaid.saleId, saleLineId: partPaid.lineIds[0]! };
    await expect(
      act(ids.cashier, (api) => api.changeLine(change(line, otc, 1)))
    ).rejects.toMatchObject({ message: 'LINE_LOCKED_BY_PAYMENT' });
    await expect(act(ids.cashier, (api) => api.removeLine(remove(line)))).rejects.toMatchObject({
      message: 'LINE_LOCKED_BY_PAYMENT',
    });
    expect((await cartOf(partPaid.saleId)).lines).toHaveLength(1);
  });

  it("refuses another cashier's bill unless a manager, and another branch or organisation", async () => {
    const otc = await oneLot('Metformin');
    const { saleId, lineIds } = await bill(ids.cashier, [
      (id) => strip(otc, id, 1),
      (id) => strip(otc, id, 1),
    ]);
    const line = { saleId, saleLineId: lineIds[0]! };
    await expect(
      act(ids.cashierB, (api) => api.changeLine(change(line, otc, 2)))
    ).rejects.toMatchObject({ code: 'FORBIDDEN', message: 'NOT_BILL_OWNER' });
    await expect(act(ids.cashierB, (api) => api.removeLine(remove(line)))).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'NOT_BILL_OWNER',
    });
    // A manager or owner may correct any bill of the branch, as they may void it.
    const managed = await act(ids.manager, (api) => api.changeLine(change(line, otc, 2)));
    expect(managed.line.quantity).toBe(2);
    // Another branch of the same organisation the user is not assigned to.
    await expect(
      act(ids.cashier, (api) =>
        api.removeLine({
          ...remove({ saleId, saleLineId: lineIds[1]! }),
          branchId: ids.otherBranch,
        })
      )
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    // Another organisation, at its own branch or naming this one.
    for (const branchId of [ids.outsiderBranch, ids.branch])
      await expect(
        act(
          ids.outsider,
          (api) => api.removeLine({ ...remove({ saleId, saleLineId: lineIds[1]! }), branchId }),
          ids.otherOrg
        )
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const cart = await cartOf(saleId);
    expect(cart.lines.map((row) => row.quantity).sort()).toEqual([1, 2]);
  });

  it('keeps the Rx grant, and never changes a prescription or controlled line', async () => {
    const otc = await oneLot('Domperidone');
    const { saleId, lineIds } = await bill(ids.pharmacist, [
      (id) => strip(rx, id, 1),
      (id) => ({ ...strip(rx, id, 1), prescription: { prescriptionLineId, patientId } }),
      (id) => strip(otc, id, 1),
    ]);
    // The pharmacist hands the bill to a manager without the dispensing grant.
    const plainRx = { saleId, saleLineId: lineIds[0]! };
    await expect(
      act(ids.manager, (api) => api.changeLine(change(plainRx, rx, 2)))
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(act(ids.manager, (api) => api.removeLine(remove(plainRx)))).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    // The pharmacist who rang it up may.
    const changed = await act(ids.pharmacist, (api) => api.changeLine(change(plainRx, rx, 2)));
    expect(changed.line.quantity).toBe(2);
    const prescribed = { saleId, saleLineId: lineIds[1]! };
    for (const attempt of <Array<(api: SalesCaller) => Promise<unknown>>>[
      (api: SalesCaller) => api.changeLine(change(prescribed, rx, 2)),
      (api: SalesCaller) => api.removeLine(remove(prescribed)),
    ])
      await expect(act(ids.pharmacist, attempt)).rejects.toMatchObject({
        message: 'LINE_HAS_DISPENSING_RECORD',
      });
    // A controlled medicine's line is never changed or removed here, whatever the grant.
    const controlledLine = { saleId, saleLineId: lineIds[2]! };
    await withTenantDb(ids.org, (db) =>
      db.medicine.update({ where: { id: otc.medicineId }, data: { controlled: true } })
    );
    try {
      for (const attempt of <Array<(api: SalesCaller) => Promise<unknown>>>[
        (api: SalesCaller) => api.changeLine(change(controlledLine, otc, 2)),
        (api: SalesCaller) => api.removeLine(remove(controlledLine)),
      ])
        await expect(act(ids.pharmacist, attempt)).rejects.toMatchObject({
          message: 'LINE_HAS_DISPENSING_RECORD',
        });
    } finally {
      await withTenantDb(ids.org, (db) =>
        db.medicine.update({ where: { id: otc.medicineId }, data: { controlled: false } })
      );
    }
    expect((await cartOf(saleId, ids.pharmacist)).lines.map((line) => line.quantity)).toEqual([
      2, 1, 1,
    ]);
  });

  it('refuses to change a line whose discount was approved for its quantity; removing it is allowed', async () => {
    const otc = await oneLot('Vitamin C');
    const { saleId, lineIds } = await bill(ids.manager, [
      (id) => ({ ...strip(otc, id, 2), discountKind: 'DISCOUNT', discountMinor: 200 }),
    ]);
    const line = { saleId, saleLineId: lineIds[0]! };
    await expect(
      act(ids.manager, (api) => api.changeLine(change(line, otc, 3)))
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'LINE_CHANGE_NEEDS_READD',
    });
    expect(totalsOf(await cartOf(saleId))).toEqual({
      grossMinor: 4000,
      discountMinor: 200,
      netMinor: 3800,
    });
    await act(ids.manager, (api) => api.removeLine(remove(line)));
    expect(totalsOf(await cartOf(saleId))).toEqual({
      grossMinor: 0,
      discountMinor: 0,
      netMinor: 0,
    });
  });

  it("never changes a customer order's or refill's bill, nor an offline counter's sealed sale", async () => {
    const otc = await oneLot('Antacid order');
    const before = await onHand(otc.medicineId);
    const ordered = await bill(ids.cashier, [(id) => strip(otc, id, 2)]);
    const offline = await bill(ids.cashier, [(id) => strip(otc, id, 1)]);
    // A refill cycle's bill carries the server's line key; a manager may see no order rows at all.
    const orderKeyed = await bill(ids.cashier, [
      (id) => ({ ...strip(otc, id, 1), idempotencyKey: `customer-order:order-${suffix}:line-1` }),
    ]);
    const refill = await bill(ids.manager, [
      (id) => ({ ...strip(otc, id, 1), idempotencyKey: `refill-cycle:${suffix}` }),
    ]);
    await withTenantDb(
      ids.org,
      async (db) => {
        // The bill a customer order's checkout opened (customer-ordering.ts) is linked to it.
        const patient = await db.pharmacyPatient.create({ data: { displayName: 'Order patient' } });
        const customer = await db.pharmacyCustomer.create({
          data: { patientId: patient.id, displayName: 'Order customer' },
        });
        await db.pharmacyCustomerOrder.create({
          data: {
            branchId: ids.branch,
            customerId: customer.id,
            placedByUserId: ids.cashier,
            fulfillment: 'COLLECT',
            status: 'READY_FOR_COLLECTION',
            intendedPaymentMethod: 'CASH',
            reservationExpiresAt: new Date(Date.now() + 86_400_000),
            counterSaleId: ordered.saleId,
          },
        });
        // A sale an enrolled counter sealed offline and the server booked names it in the
        // command log (pharmacy-offline.ts settles the command with the sale as serverRef).
        const device = await db.pharmacyRegisteredDevice.create({
          data: {
            branchId: ids.branch,
            name: 'Front counter',
            deviceSecretHash: randomBytes(32).toString('hex'),
            enrolledByActorId: ids.manager,
          },
        });
        await db.pharmacyOfflineCommand.create({
          data: {
            branchId: ids.branch,
            deviceId: device.id,
            sequence: 1,
            idempotencyKey: `offline-${suffix}`,
            action: 'CASH_OTC_SALE',
            payload: {},
            payloadHash: randomBytes(32).toString('hex'),
            clientOriginAt: new Date(),
            status: 'ACCEPTED',
            settledAt: new Date(),
            serverRef: offline.saleId,
          },
        });
      },
      { userId: ids.cashier }
    );
    for (const [target, userId, message] of [
      // The order row names this bill (seen by a user with the orders grant).
      [ordered, ids.cashier, 'LINE_ON_ORDER_BILL'],
      // A bill a checkout filled carries the server's line keys, which refuse the change even
      // for a manager without the orders grant, from whom the order rows are hidden.
      [orderKeyed, ids.manager, 'LINE_ON_ORDER_BILL'],
      [refill, ids.manager, 'LINE_ON_ORDER_BILL'],
      [offline, ids.cashier, 'LINE_ON_OFFLINE_SALE'],
    ] as const) {
      const line = { saleId: target.saleId, saleLineId: target.lineIds[0]! };
      await expect(
        act(userId, (api) => api.changeLine(change(line, otc, 1)))
      ).rejects.toMatchObject({ code: 'BAD_REQUEST', message });
      await expect(act(userId, (api) => api.removeLine(remove(line)))).rejects.toMatchObject({
        code: 'BAD_REQUEST',
        message,
      });
    }
    expect((await cartOf(ordered.saleId)).lines).toEqual([
      expect.objectContaining({ quantity: 2 }),
    ]);
    expect(await onHand(otc.medicineId)).toBe(before - 50);
  });

  it('records the value that came off the bill on the void, not the whole old line', async () => {
    const otc = await oneLot('Antacid void value');
    const { saleId, lineIds } = await bill(ids.cashier, [(id) => strip(otc, id, 3)]);
    const down = await act(ids.cashier, (api) =>
      api.changeLine(change({ saleId, saleLineId: lineIds[0]! }, otc, 1))
    );
    await act(ids.cashier, (api) => api.removeLine(remove({ saleId, saleLineId: down.line.id })));
    const voided = await withTenantDb(ids.org, (db) =>
      db.pharmacySaleEvent.findMany({
        where: { kind: 'VOIDED', payload: { path: ['fromSaleId'], equals: saleId } },
        orderBy: { occurredAt: 'asc' },
        select: { payload: true },
      })
    );
    expect(voided.map((event) => event.payload)).toEqual([
      // Three strips at 20.00 became one: 40.00 came off.
      expect.objectContaining({
        cause: 'LINE_CHANGED',
        saleLineId: lineIds[0],
        replacementSaleLineId: down.line.id,
        voidedMinor: 4000,
      }),
      expect.objectContaining({
        cause: 'LINE_REMOVED',
        saleLineId: down.line.id,
        voidedMinor: 2000,
      }),
    ]);
  });

  it('counts each line in the staff-void signal by the value its own changes took off (DEV-1004)', async () => {
    const { readPharmacyAnomalyFacts } = await import('@/lib/pharmacy/anomaly-signals-operations');
    const today = workspaceToday('UTC');
    const cashierVoids = async () => {
      const { facts } = await withTenantDb(ids.org, (db) =>
        readPharmacyAnomalyFacts(db, { branchIds: [ids.branch], from: today, to: today })
      );
      const row = facts.staffVoid.find((fact) => fact.userId === ids.cashierB);
      return {
        voidEvents: row?.voidEvents ?? 0,
        lineVoids: row?.lineVoids ?? 0,
        lineVoidNetMinor: row?.lineVoidNetMinor ?? 0,
      };
    };
    let expected = await cashierVoids();
    const expectAdded = async (voids: number, minor: number) => {
      expected = {
        voidEvents: expected.voidEvents + voids,
        lineVoids: expected.lineVoids + voids,
        lineVoidNetMinor: expected.lineVoidNetMinor + minor,
      };
      expect(await cashierVoids()).toEqual(expected);
    };
    // A strip of the cheap medicine is PKR 20.00; of the dear one PKR 500.00.
    const cheap = await oneLot('Antacid void signal', 600);
    const dear = await stockedItem('Biologic void signal', [
      { expiresAt: '2028-01-01', units: 60, mrp: 50_000 },
    ]);
    const lineOf = (saleId: string, saleLineId: string) => ({ saleId, saleLineId });

    // 1. 3 strips lowered to 1 and raised back to 3: the line lost nothing.
    const resized = await bill(ids.cashierB, [(id) => strip(cheap, id, 3)]);
    const lowered = await act(ids.cashierB, (api) =>
      api.changeLine(change(lineOf(resized.saleId, resized.lineIds[0]!), cheap, 1))
    );
    await act(ids.cashierB, (api) =>
      api.changeLine(change(lineOf(resized.saleId, lowered.line.id), cheap, 3))
    );
    await expectAdded(0, 0);

    // 2. 3 strips lowered to 1: one void, worth the 2 strips that came off.
    const reduced = await bill(ids.cashierB, [(id) => strip(cheap, id, 3)]);
    await act(ids.cashierB, (api) =>
      api.changeLine(change(lineOf(reduced.saleId, reduced.lineIds[0]!), cheap, 1))
    );
    await expectAdded(1, 4_000);

    // 3. The dear strip removed and the cheap line raised from 1 to 26 strips (worth as much):
    //    the removal still counts in full.
    const swapped = await bill(ids.cashierB, [
      (id) => strip(dear, id, 1),
      (id) => strip(cheap, id, 1),
    ]);
    await act(ids.cashierB, (api) =>
      api.removeLine(remove(lineOf(swapped.saleId, swapped.lineIds[0]!)))
    );
    await act(ids.cashierB, (api) =>
      api.changeLine(change(lineOf(swapped.saleId, swapped.lineIds[1]!), cheap, 26))
    );
    await expectAdded(1, 50_000);

    // 4. The dear strip removed and a new cheap line added: the removal counts in full.
    const replaced = await bill(ids.cashierB, [(id) => strip(dear, id, 1)]);
    await act(ids.cashierB, (api) =>
      api.removeLine(remove(lineOf(replaced.saleId, replaced.lineIds[0]!)))
    );
    await act(ids.cashierB, (api) => api.addLine(strip(cheap, replaced.saleId, 25)));
    await expectAdded(1, 50_000);

    // 5. Five times a strip added and removed again: five voids.
    const cycled = await bill(ids.cashierB, []);
    for (let cycle = 0; cycle < 5; cycle += 1) {
      const added = await act(ids.cashierB, (api) => api.addLine(strip(cheap, cycled.saleId, 1)));
      await act(ids.cashierB, (api) =>
        api.removeLine(remove(lineOf(cycled.saleId, added.line.id)))
      );
    }
    await expectAdded(5, 10_000);
  }, 120_000);

  it('charges each reduction to whoever made it, and only when units come off (DEV-1004)', async () => {
    const { readPharmacyAnomalyFacts } = await import('@/lib/pharmacy/anomaly-signals-operations');
    const today = workspaceToday('UTC');
    const voidsOf = async (userId: string) => {
      const { facts } = await withTenantDb(ids.org, (db) =>
        readPharmacyAnomalyFacts(db, { branchIds: [ids.branch], from: today, to: today })
      );
      const row = facts.staffVoid.find((fact) => fact.userId === userId);
      return {
        voidEvents: row?.voidEvents ?? 0,
        lineVoids: row?.lineVoids ?? 0,
        lineVoidNetMinor: row?.lineVoidNetMinor ?? 0,
      };
    };
    const expected = {
      [ids.cashierB]: await voidsOf(ids.cashierB),
      [ids.manager]: await voidsOf(ids.manager),
    };
    const expectAdded = async (userId: string, voids: number, minor: number) => {
      const before = expected[userId]!;
      expected[userId] = {
        voidEvents: before.voidEvents + voids,
        lineVoids: before.lineVoids + voids,
        lineVoidNetMinor: before.lineVoidNetMinor + minor,
      };
      expect(await voidsOf(userId)).toEqual(expected[userId]);
    };
    const lineOf = (saleId: string, saleLineId: string) => ({ saleId, saleLineId });
    // A strip of 10 at PKR 20.05: its 10 tablets sell for PKR 20.00 in all.
    const odd = await stockedItem('Antacid odd MRP', [
      { expiresAt: '2028-01-01', units: 200, mrp: 2005 },
    ]);
    const otc = await oneLot('Antacid who changed it', 400);

    // 1 strip changed to the same 10 tablets: no unit came off, so no void, although the
    // tablets' prices add up to 5 paisa less.
    const loosened = await bill(ids.cashierB, [(id) => strip(odd, id, 1)]);
    await act(ids.cashierB, (api) =>
      api.changeLine(change(lineOf(loosened.saleId, loosened.lineIds[0]!), odd, 10, 'UNIT'))
    );
    await expectAdded(ids.cashierB, 0, 0);

    // 3 strips changed to 29 tablets: one tablet came off, worth PKR 2.00.
    const trimmed = await bill(ids.cashierB, [(id) => strip(otc, id, 3)]);
    await act(ids.cashierB, (api) =>
      api.changeLine(change(lineOf(trimmed.saleId, trimmed.lineIds[0]!), otc, 29, 'UNIT'))
    );
    await expectAdded(ids.cashierB, 1, 200);

    // The cashier lowers 3 strips to 1, then the manager raises it to 2: the cashier is charged
    // for the 2 strips they took off; the manager's raise takes nothing off and offsets nothing.
    const raisedByManager = await bill(ids.cashierB, [(id) => strip(otc, id, 3)]);
    const loweredByCashier = await act(ids.cashierB, (api) =>
      api.changeLine(change(lineOf(raisedByManager.saleId, raisedByManager.lineIds[0]!), otc, 1))
    );
    await act(ids.manager, (api) =>
      api.changeLine(change(lineOf(raisedByManager.saleId, loweredByCashier.line.id), otc, 2))
    );
    await expectAdded(ids.cashierB, 1, 4_000);
    await expectAdded(ids.manager, 0, 0);

    // The manager lowers 3 strips to 1, then the cashier removes the line: the manager is
    // charged for 2 strips and the cashier for the 1 they removed.
    const removedByCashier = await bill(ids.cashierB, [(id) => strip(otc, id, 3)]);
    const loweredByManager = await act(ids.manager, (api) =>
      api.changeLine(change(lineOf(removedByCashier.saleId, removedByCashier.lineIds[0]!), otc, 1))
    );
    await act(ids.cashierB, (api) =>
      api.removeLine(remove(lineOf(removedByCashier.saleId, loweredByManager.line.id)))
    );
    await expectAdded(ids.manager, 1, 4_000);
    await expectAdded(ids.cashierB, 1, 2_000);
  }, 120_000);

  it('leaves a whole-bill discount given after a change out of the staff-void value (DEV-1004)', async () => {
    const { readPharmacyAnomalyFacts } = await import('@/lib/pharmacy/anomaly-signals-operations');
    const { applyBillDiscount } = await import('@/lib/pharmacy/bill-discount-service');
    const today = workspaceToday('UTC');
    const cashierVoids = async () => {
      const { facts } = await withTenantDb(ids.org, (db) =>
        readPharmacyAnomalyFacts(db, { branchIds: [ids.branch], from: today, to: today })
      );
      const row = facts.staffVoid.find((fact) => fact.userId === ids.cashierB);
      return {
        voidEvents: row?.voidEvents ?? 0,
        lineVoids: row?.lineVoids ?? 0,
        lineVoidNetMinor: row?.lineVoidNetMinor ?? 0,
      };
    };
    await withPlatformDb(
      (db) =>
        db.$executeRaw`UPDATE "organizations" SET "pharmacyBillDiscountEnabled" = true WHERE "id" = ${ids.org}`
    );
    const discountTenPercent = (saleId: string) =>
      withTenantDb(ids.org, (db) =>
        applyBillDiscount(
          db,
          { organizationId: ids.org, branchId: ids.branch, actorId: ids.cashierB },
          {
            saleId,
            request: { kind: 'PERCENT', bps: 1_000 },
            approval: {
              approvedByUserId: ids.manager,
              approvalPolicy: 'MANAGER_APPROVAL',
              selfApproved: false,
            },
          }
        )
      );
    const otc = await oneLot('Antacid bill discount void', 400);
    const before = await cashierVoids();
    // 10 strips raised to 11, then a 10% discount on the whole bill: only goods were added.
    const raised = await bill(ids.cashierB, [(id) => strip(otc, id, 10)]);
    await act(ids.cashierB, (api) =>
      api.changeLine(change({ saleId: raised.saleId, saleLineId: raised.lineIds[0]! }, otc, 11))
    );
    await expect(discountTenPercent(raised.saleId)).resolves.toMatchObject({ status: 'APPLIED' });
    expect(await cashierVoids()).toEqual(before);
    // A line genuinely removed, then a whole-bill discount on what is left: still one void,
    // worth the strip that came off.
    const trimmed = await bill(ids.cashierB, [
      (id) => strip(otc, id, 1),
      (id) => strip(otc, id, 2),
    ]);
    await act(ids.cashierB, (api) =>
      api.removeLine(remove({ saleId: trimmed.saleId, saleLineId: trimmed.lineIds[0]! }))
    );
    await expect(discountTenPercent(trimmed.saleId)).resolves.toMatchObject({ status: 'APPLIED' });
    expect(await cashierVoids()).toEqual({
      voidEvents: before.voidEvents + 1,
      lineVoids: before.lineVoids + 1,
      lineVoidNetMinor: before.lineVoidNetMinor + 2000,
    });
  });

  it('totals after any sequence of changes and removals equal a fresh bill of the same lines', async () => {
    // One lot, at an MRP that does not divide evenly into tablets, so every loose price is
    // rounded: a fresh bill of the same lines then allocates and rounds exactly the same way.
    const otc = await stockedItem('Calcium', [{ expiresAt: '2028-01-01', units: 400, mrp: 1999 }]);
    // A seeded property test: random quantities and units, changes and removals.
    let seed = 977;
    const random = (n: number) => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed % n;
    };
    for (let round = 0; round < 6; round += 1) {
      const { saleId, lineIds } = await bill(ids.cashier, [
        (id) => strip(otc, id, 1 + random(3)),
        (id) => loose(otc, id, 1 + random(9)),
        (id) => strip(otc, id, 1 + random(2)),
      ]);
      let current = [...lineIds];
      for (let step = 0; step < 4; step += 1) {
        const index = random(current.length);
        const target = { saleId, saleLineId: current[index]! };
        if (random(5) === 0 && current.length > 1) {
          await act(ids.cashier, (api) => api.removeLine(remove(target)));
          current = current.filter((_, at) => at !== index);
        } else {
          const unit = random(2) === 0 ? 'STRIP' : 'UNIT';
          const quantity = unit === 'STRIP' ? 1 + random(4) : 1 + random(25);
          const changed = await act(ids.cashier, (api) =>
            api.changeLine(change(target, otc, quantity, unit))
          );
          current[index] = changed.line.id;
        }
      }
      const edited = await cartOf(saleId);
      // Give the edited bill's stock back before ringing the same lines up fresh, so FEFO
      // allocates the fresh bill from the same lots in the same order.
      const finalLines = edited.lines.map((line) => ({
        unit: line.saleUnit as 'STRIP' | 'UNIT',
        quantity: line.quantity,
      }));
      for (const line of edited.lines)
        await act(ids.cashier, (api) =>
          api.removeLine(remove({ saleId, saleLineId: line.saleLineId }))
        );
      const fresh = await bill(
        ids.cashier,
        finalLines.map(
          (line) => (id: string) =>
            line.unit === 'STRIP' ? strip(otc, id, line.quantity) : loose(otc, id, line.quantity)
        )
      );
      const freshCart = await cartOf(fresh.saleId);
      expect(totalsOf(freshCart)).toEqual(totalsOf(edited));
      expect(freshCart.lines.map((line) => line.lineTotalMinor)).toEqual(
        edited.lines.map((line) => line.lineTotalMinor)
      );
      for (const line of freshCart.lines)
        await act(ids.cashier, (api) =>
          api.removeLine(remove({ saleId: fresh.saleId, saleLineId: line.saleLineId }))
        );
    }
  }, 180_000);
});

describeIfDatabase('DEV-977B concurrent line changes', () => {
  const received = async (medicineId: string) =>
    withTenantDb(ids.org, async (db) => {
      const sum = await db.pharmacyStockMovement.aggregate({
        where: { branchId: ids.branch, kind: 'RECEIPT', lot: { batch: { medicineId } } },
        _sum: { quantityUnits: true },
      });
      return sum._sum.quantityUnits ?? 0;
    });

  it('two changes of one line: one wins, the other finds the line gone, nothing oversold', async () => {
    const scarce = await oneLot('Montelukast', 20);
    const { saleId, lineIds } = await bill(ids.cashier, [(id) => strip(scarce, id, 1)]);
    const line = { saleId, saleLineId: lineIds[0]! };
    const results = await Promise.allSettled([
      act(ids.cashier, (api) => api.changeLine(change(line, scarce, 2))),
      act(ids.cashier, (api) => api.changeLine(change(line, scarce, 1, 'UNIT'))),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const refused = results.find((result) => result.status === 'rejected') as PromiseRejectedResult;
    expect(refused.reason).toMatchObject({ code: 'NOT_FOUND' });
    expect((await cartOf(saleId)).lines).toHaveLength(1);
    await expectStockMatchesBills(scarce.medicineId, await received(scarce.medicineId));
    for (const row of (await cartOf(saleId)).lines)
      await act(ids.cashier, (api) =>
        api.removeLine(remove({ saleId, saleLineId: row.saleLineId }))
      );
  });

  it('two bills growing into the same scarce stock never oversell it', async () => {
    const scarce = await oneLot('Fexofenadine', 30);
    expect(await onHand(scarce.medicineId)).toBe(30);
    const first = await bill(ids.cashier, [(id) => strip(scarce, id, 1)]);
    const second = await bill(ids.cashierB, [(id) => strip(scarce, id, 1)]);
    const results = await Promise.allSettled([
      act(ids.cashier, (api) =>
        api.changeLine(change({ saleId: first.saleId, saleLineId: first.lineIds[0]! }, scarce, 2))
      ),
      act(ids.cashierB, (api) =>
        api.changeLine(change({ saleId: second.saleId, saleLineId: second.lineIds[0]! }, scarce, 2))
      ),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(await onHand(scarce.medicineId)).toBe(0);
    await expectStockMatchesBills(scarce.medicineId, await received(scarce.medicineId));
    for (const [userId, sale] of [
      [ids.cashier, first],
      [ids.cashierB, second],
    ] as const)
      for (const row of (await cartOf(sale.saleId)).lines)
        await act(userId, (api) =>
          api.removeLine(remove({ saleId: sale.saleId, saleLineId: row.saleLineId }))
        );
    expect(await onHand(scarce.medicineId)).toBe(30);
  });

  it.each(['change', 'remove'] as const)(
    '%s against a payment: the bill is paid for exactly what is on it',
    async (kind) => {
      const otc = await oneLot(`Antacid ${kind}`);
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const { saleId, lineIds } = await bill(ids.cashier, [
          (id) => strip(otc, id, 1),
          (id) => strip(otc, id, 1),
        ]);
        const line = { saleId, saleLineId: lineIds[0]! };
        const results = await Promise.allSettled([
          kind === 'change'
            ? act(ids.cashier, (api) => api.changeLine(change(line, otc, 3)))
            : act(ids.cashier, (api) => api.removeLine(remove(line))),
          pay(ids.cashier, saleId, 4000),
        ]);
        const cart = await cartOf(saleId);
        // Whichever committed first, the money matches the lines on the bill.
        expect(cart.totals.tenderedMinor).toBeLessThanOrEqual(cart.totals.netMinor);
        if (results[1].status === 'fulfilled') {
          if (results[0].status === 'fulfilled') {
            // The line changed first; the payment then covered only part of the new total.
            expect(cart.status).toBe('OPEN');
          } else {
            expect(cart.status).toBe('COMPLETED');
            expect(cart.totals).toMatchObject({ netMinor: 4000, tenderedMinor: 4000 });
            expect((results[0] as PromiseRejectedResult).reason).toMatchObject({
              message: expect.stringMatching(/INVALID_STATE|LINE_LOCKED_BY_PAYMENT/),
            });
          }
        } else {
          // The change won; the old amount is now more than the bill (a removal) or the bill
          // was taken. Never paid for lines it no longer has.
          expect(results[0].status).toBe('fulfilled');
        }
        const lineUnits = cart.lines.reduce((sum, row) => sum + row.canonicalUnits, 0);
        const allocated = cart.lines.reduce(
          (sum, row) => sum + row.allocations.reduce((n, part) => n + part.canonicalUnits, 0),
          0
        );
        expect(allocated).toBe(lineUnits);
      }
      await expectStockMatchesBills(otc.medicineId, await received(otc.medicineId));
    },
    120_000
  );

  it('a change and sales of the same medicine on other bills never deadlock', async () => {
    // Several lots, so the change gives back one balance and allocates from others while
    // concurrent sales lock the same balances.
    const otc = await stockedItem('Antacid lock order', [
      { expiresAt: '2027-03-01', units: 20, mrp: 2000 },
      { expiresAt: '2027-09-01', units: 20, mrp: 2000 },
      { expiresAt: '2028-03-01', units: 400, mrp: 2000 },
    ]);
    for (let round = 0; round < 4; round += 1) {
      const target = await bill(ids.cashier, [(id) => strip(otc, id, 3)]);
      const other = await act(ids.cashierB, (api) =>
        api.create({ branchId: ids.branch, deviceId: deviceFor(ids.cashierB) })
      );
      const results = await Promise.allSettled([
        act(ids.cashier, (api) =>
          api.changeLine(change({ saleId: target.saleId, saleLineId: target.lineIds[0]! }, otc, 5))
        ),
        act(ids.cashierB, (api) => api.addLine(strip(otc, other.id, 4))),
        act(ids.cashierB, (api) => api.addLine(strip(otc, other.id, 1))),
      ]);
      for (const result of results)
        expect(result.status === 'rejected' ? String(result.reason) : 'ok').toBe('ok');
    }
    await expectStockMatchesBills(otc.medicineId, await received(otc.medicineId));
  }, 120_000);

  it('a stock move racing a change is refused in plain terms, never with a database error (DEV-1004)', async () => {
    const { PharmacyInventoryError } = await import('@/lib/pharmacy/inventory');
    const shelf = await withTenantDb(ids.org, (tx) =>
      tx.pharmacyStockLocation.create({
        data: { branchId: ids.branch, code: `SHELF-${suffix}`, name: 'Shelf', kind: 'STORE' },
      })
    );
    const scope = { organizationId: ids.org, branchId: ids.branch, actorId: ids.manager };
    for (let round = 0; round < 4; round += 1) {
      // Every unit of the lot is loose (stockedItem breaks the packs); the move asks for one
      // whole strip and five tablets while a bill line grows into the same lot.
      const item = await oneLot(`Antacid move ${round}`, 30);
      const { saleId, lineIds } = await bill(ids.cashier, [(id) => strip(item, id, 1)]);
      const move = () =>
        withTenantDb(ids.org, (db) =>
          ledger.transferStock(db, scope, {
            inventoryLotId: item.lots[0]!,
            fromStockLocationId: locationId,
            toStockLocationId: shelf.id,
            units: 15,
            at: new Date(),
            idempotencyKeyPrefix: key(),
          })
        );
      const grow = () =>
        act(ids.cashier, (api) =>
          api.changeLine(change({ saleId, saleLineId: lineIds[0]! }, item, 2))
        );
      const results = await Promise.allSettled(round % 2 ? [grow(), move()] : [move(), grow()]);
      const moved = results[round % 2 ? 1 : 0]!;
      if (moved.status === 'rejected') {
        expect(moved.reason).toBeInstanceOf(PharmacyInventoryError);
        expect(['INVALID_ARRANGEMENT', 'INSUFFICIENT_STOCK']).toContain(
          (moved.reason as InstanceType<typeof PharmacyInventoryError>).reason
        );
      }
      const grown = results[round % 2 ? 0 : 1]!;
      if (grown.status === 'rejected')
        expect(String(grown.reason)).not.toMatch(/Database error|violates|constraint/i);
      await expectStockMatchesBills(item.medicineId, await received(item.medicineId));
    }
  }, 120_000);

  // Last: it closes the branch's business day for the rest of this file.
  it('refuses a change or removal once the business day is closed for trading', async () => {
    const otc = await oneLot('Antacid closed day');
    const { saleId, lineIds } = await bill(ids.cashier, [(id) => strip(otc, id, 1)]);
    await withTenantDb(ids.org, (db) =>
      db.pharmacyDailyClose.create({
        data: {
          branchId: ids.branch,
          businessDate,
          sequence: 1,
          grossSalesMinor: 0,
          refundTotalMinor: 0,
          netSalesMinor: 0,
          cashExpectedMinor: 0,
          cashCountedMinor: 0,
          cashVarianceMinor: 0,
          sourceHash: `close-${suffix}`,
          actorId: ids.manager,
        },
      })
    );
    const line = { saleId, saleLineId: lineIds[0]! };
    await expect(
      act(ids.cashier, (api) => api.changeLine(change(line, otc, 2)))
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: 'DAY_CLOSED' });
    await expect(act(ids.cashier, (api) => api.removeLine(remove(line)))).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'DAY_CLOSED',
    });
    expect((await cartOf(saleId)).lines).toEqual([
      expect.objectContaining({ saleLineId: lineIds[0], quantity: 1 }),
    ]);
  });
});

describeIfDatabase('DEV-1049 counter pack opening', () => {
  const stock = (units: number, openedUnits = 0, unitsPerPack = 10) =>
    stockedItem('Synthetic counter pack', [{ expiresAt: '2032-01-01', units, mrp: 2000 }], {
      openedUnits,
      unitsPerPack,
    });
  const history = (item: StockedItem) =>
    withTenantDb(ids.org, (db) =>
      db.pharmacyStockMovement.findMany({
        where: { inventoryLotId: item.lots[0]!, branchId: ids.branch },
        orderBy: { id: 'asc' },
      })
    );
  const balance = (item: StockedItem) =>
    withTenantDb(ids.org, (db) =>
      db.pharmacyStockBalance.findFirstOrThrow({
        where: {
          inventoryLotId: item.lots[0]!,
          stockLocationId: locationId,
          disposition: 'AVAILABLE',
        },
      })
    );
  it.each([
    { quantity: 5, opened: 0, packs: 1, left: 5 },
    { quantity: 23, opened: 0, packs: 3, left: 7 },
    { quantity: 12, opened: 10, packs: 1, left: 8 },
    { quantity: 5, opened: 10, packs: 0, left: 5 },
  ])(
    'sells $quantity with $opened already open and opens $packs packs',
    async ({ quantity, opened, packs, left }) => {
      const item = await stock(40, opened);
      const { saleId, lineIds } = await bill(ids.cashier, [(id) => loose(item, id, quantity)]);
      const movements = await history(item);
      const openedHere = movements.filter((m) => m.reason === 'Pack opened at the counter');
      expect(openedHere).toHaveLength(packs);
      for (const m of openedHere)
        expect(m).toMatchObject({
          counterSaleId: saleId,
          inventoryLotId: item.lots[0],
          actorId: ids.cashier,
          kind: 'BREAK_PACK',
          quantityUnits: 0,
          sealedPackDelta: -1,
          looseUnitDelta: 10,
        });
      expect(movements.filter((m) => m.kind === 'SALE')).toEqual([
        expect.objectContaining({
          quantityUnits: -quantity,
          looseUnitDelta: -quantity,
          sealedPackDelta: 0,
        }),
      ]);
      expect(await balance(item)).toMatchObject({
        onHandUnits: 40 - quantity,
        looseUnits: left,
        sealedPacks: 4 - opened / 10 - packs,
      });
      await act(ids.cashier, (api) => api.removeLine(remove({ saleId, saleLineId: lineIds[0]! })));
      expect(await balance(item)).toMatchObject({
        onHandUnits: 40,
        looseUnits: left + quantity,
        sealedPacks: 4 - opened / 10 - packs,
      });
      expect((await history(item)).find((m) => m.kind === 'ADJUSTMENT')?.reason).toContain(
        'Returned as open units'
      );
    }
  );
  it('opens for strips and a prepayment void returns open units', async () => {
    const item = await stock(30);
    const { saleId } = await bill(ids.cashier, [(id) => strip(item, id, 2)]);
    expect(
      (await history(item)).filter((m) => m.reason === 'Pack opened at the counter')
    ).toHaveLength(2);
    await act(ids.cashier, (api) =>
      api.transition({
        branchId: ids.branch,
        saleId,
        action: 'void',
        voidReason: { code: 'WRONG_ITEMS' },
      })
    );
    expect(await balance(item)).toMatchObject({ onHandUnits: 30, sealedPacks: 1, looseUnits: 20 });
    expect((await history(item)).find((m) => m.kind === 'ADJUSTMENT')?.reason).toContain(
      'Returned as open units'
    );
  });
  it('reports the available units on shortage without writing movements', async () => {
    const item = await stock(10);
    const before = await history(item);
    await expect(bill(ids.cashier, [(id) => loose(item, id, 11)])).rejects.toThrow(
      /10 units available/i
    );
    expect(await history(item)).toEqual(before);
  });
  it('two cashiers competing for the final units can open and sell them only once', async () => {
    const item = await stock(10);
    const attempts = await Promise.allSettled(
      [ids.cashier, ids.cashierB].map((user) => bill(user, [(id) => loose(item, id, 10)]))
    );
    expect(attempts.filter((a) => a.status === 'fulfilled')).toHaveLength(1);
    expect(attempts.find((a) => a.status === 'rejected')).toMatchObject({
      reason: expect.objectContaining({ message: expect.stringMatching(/0 units available/i) }),
    });
    expect(
      (await history(item)).filter((m) => m.reason === 'Pack opened at the counter')
    ).toHaveLength(1);
    expect(await balance(item)).toMatchObject({ onHandUnits: 0, sealedPacks: 0, looseUnits: 0 });
    await expectStockMatchesBills(item.medicineId, 10);
  });
  it('does not break single-unit packs or whole-pack-only catalogue items', async () => {
    const single = await stock(4, 0, 1);
    await bill(ids.cashier, [(id) => loose(single, id, 1)]);
    expect((await history(single)).filter((m) => m.kind === 'BREAK_PACK')).toHaveLength(0);
    const whole = await stock(20);
    await withTenantDb(ids.org, (db) =>
      db.medicine.update({ where: { id: whole.medicineId }, data: { wholePackOnly: true } })
    );
    await expect(bill(ids.cashier, [(id) => loose(whole, id, 1)])).rejects.toThrow();
    await bill(ids.cashier, [(id) => ({ ...strip(whole, id, 1), saleUnit: 'PACK' })]);
    expect(await balance(whole)).toMatchObject({ onHandUnits: 10, sealedPacks: 1, looseUnits: 0 });
    expect((await history(whole)).filter((m) => m.kind === 'BREAK_PACK')).toHaveLength(0);
  });
});
