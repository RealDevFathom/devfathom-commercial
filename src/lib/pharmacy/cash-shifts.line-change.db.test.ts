/**
 * @vitest-environment node
 *
 * DEV-977B with DEV-958B: changing or removing a bill line on a branch that runs cash shifts,
 * against a REAL migrated PostgreSQL, written as the restricted runtime role with row-level
 * security on (the suite first proves the role is neither SUPERUSER nor BYPASSRLS). The line
 * procedures are called through the router as a signed-in member would call them:
 *   * between shifts a line change or removal is refused, exactly as a payment is, and a bill
 *     that belongs to a closed shift is refused even once the next shift is open;
 *   * a line change never moves cash: the open shift expects the same cash before and after, and
 *     paying the changed bill expects exactly what paying a fresh bill of the same lines does;
 *   * the value a line change voids is counted once: in the one shift it happened in (open and
 *     frozen at its close), in the day close's shift totals, and in the day's void evidence.
 *
 * Requires TEST_DATABASE_URL (scripts/run-pharmacy-db-tests.sh sets it). Without it the suite
 * reports skipped.
 */
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
if (TEST_DATABASE_URL) process.env.DATABASE_URL = TEST_DATABASE_URL;

// Only the web identity boundary and the audit row write are stubbed, as in cash-shifts.db.test.ts.
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn(async () => null) }));
vi.mock('@/server/audit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/audit')>()),
  recordTrpcAudit: vi.fn(),
}));

type ScopedDb = import('@/lib/tenancy/scoped-db').ScopedDb;
type Scope = { organizationId: string; branchId: string; actorId: string };

let withTenantDb: typeof import('@/lib/tenancy/scoped-db').withTenantDb;
let withPlatformDb: typeof import('@/lib/tenancy/scoped-db').withPlatformDb;
let settlement: typeof import('./settlement');
let shifts: typeof import('./cash-shifts');
let dayClose: typeof import('./day-close');
let closeCheck: typeof import('./cash-close-check-operations');
let sales: typeof import('./sales');
let ledger: typeof import('./stock-ledger');
let clock: typeof import('./business-day-clock');
let businessDay: typeof import('./business-day');
let regulatory: typeof import('@/lib/test-support/pharmacy-regulatory');

const describeDatabase = TEST_DATABASE_URL ? describe : describe.skip;
const run = randomUUID().slice(0, 8);
const ruleSetIds: string[] = [];

beforeAll(async () => {
  if (!TEST_DATABASE_URL) return;
  ({ withTenantDb, withPlatformDb } = await import('@/lib/tenancy/scoped-db'));
  settlement = await import('./settlement');
  shifts = await import('./cash-shifts');
  dayClose = await import('./day-close');
  closeCheck = await import('./cash-close-check-operations');
  sales = await import('./sales');
  ledger = await import('./stock-ledger');
  clock = await import('./business-day-clock');
  businessDay = await import('./business-day');
  regulatory = await import('@/lib/test-support/pharmacy-regulatory');
  const { assertRlsEnforcingRole } = await import('@/lib/testing/rls-role-guard');
  await assertRlsEnforcingRole(withPlatformDb);
}, 120_000);

afterAll(async () => {
  if (!TEST_DATABASE_URL) return;
  await regulatory.retirePharmacyRegulatoryRules(withPlatformDb, ruleSetIds);
});

const tenant = <T>(scope: Scope, work: (db: ScopedDb) => Promise<T>) =>
  withTenantDb(scope.organizationId, work, { userId: scope.actorId, timeout: 60_000 });

type Shop = {
  owner: Scope;
  as: (actorId: string) => Scope;
  manager: string;
  cashier: string;
  cashier2: string;
  locationId: string;
  today: Date;
};

/** A fresh organization and branch that runs cash shifts, with a manager and two cashiers. */
async function shop(
  label: string,
  managerAdmission: 'pharmacy:counter' | 'pharmacy:dispense' = 'pharmacy:counter'
): Promise<Shop> {
  const organizationId = `lcshift_${label}_${run}`;
  const branchId = `${organizationId}_branch`;
  const manager = `${organizationId}_manager`;
  const cashier = `${organizationId}_cashier`;
  const cashier2 = `${organizationId}_cashier2`;
  const as = (actorId: string): Scope => ({ organizationId, branchId, actorId });
  await withPlatformDb((db) =>
    db.organization.create({
      data: {
        id: organizationId,
        slug: organizationId,
        legalName: organizationId,
        displayName: organizationId,
        vertical: 'PHARMACY',
        status: 'ACTIVE',
      },
    })
  );
  const { seedDepartments } = await import('@/lib/test-support/departments');
  const locationId = await tenant(as(manager), async (db) => {
    await db.pharmacyBranch.create({
      data: {
        id: branchId,
        organizationId,
        code: branchId,
        name: `Line change ${label}`,
        addressLine: 'Test',
        city: 'Test',
        provinceCode: 'PB',
        cashShiftsEnabled: true,
      },
    });
    await seedDepartments(db, [organizationId], ['LEADERSHIP']);
    for (const [id, grants] of [
      [manager, ['pharmacy:manage', managerAdmission]],
      [cashier, ['pharmacy:counter']],
      [cashier2, ['pharmacy:counter']],
    ] as const) {
      await db.organizationRole.create({
        data: {
          id: `role_${id}`,
          key: `role_${id}`,
          name: id,
          permissions: {
            create: grants.map((capability) => ({ capability, effect: 'ALLOW' as const })),
          },
        },
      });
      await db.user.create({
        data: {
          id,
          name: id,
          email: `${id}@example.test`,
          department: 'LEADERSHIP',
          title: 'Pharmacy staff',
          role: 'EMPLOYEE',
          status: 'ACTIVE',
          organizationRoleId: `role_${id}`,
        },
      });
      await db.pharmacyBranchAssignment.create({ data: { userId: id, branchId, active: true } });
    }
    return (
      await db.pharmacyStockLocation.create({
        data: { organizationId, branchId, code: randomUUID(), name: 'Stock', kind: 'STORE' },
      })
    ).id;
  });
  ruleSetIds.push(
    await regulatory.seedPharmacyRegulatoryProfile(
      withPlatformDb,
      (work) => tenant(as(manager), work),
      branchId
    )
  );
  const today = await tenant(as(manager), async (db) =>
    businessDay.pharmacyBusinessDate(await clock.readPharmacyDayClock(db, as(manager)))
  );
  return { owner: as(manager), as, manager, cashier, cashier2, locationId, today };
}

type BillLine = { id: string; packLevelId: string; medicineId: string };

/**
 * An open bill started by `actor`, one OTC medicine per `[priceMinor, units]` line, each with ten
 * spare units received so a line can grow.
 */
async function billBy(s: Shop, actor: string, lines: readonly [number, number][]) {
  const org = s.owner.organizationId;
  const items = await tenant(s.owner, async (db) => {
    const made = [];
    for (const [priceMinor, units] of lines) {
      const medicine = await db.medicine.create({
        data: {
          organizationId: org,
          productName: randomUUID(),
          productFamily: 'PHARMACEUTICAL',
          saleable: true,
          otc: true,
          presentations: { create: { organizationId: org, presentation: 'Unit' } },
        },
        include: { presentations: true },
      });
      const presentation = medicine.presentations[0]!;
      const pack = await db.packLevel.create({
        data: {
          organizationId: org,
          presentationId: presentation.id,
          versionGroupId: randomUUID(),
          version: 1,
          level: 'UNIT',
          unitsPerParent: 1,
          effectiveFrom: new Date('2020-01-01'),
        },
      });
      const batch = await db.pharmacyManufacturingBatch.create({
        data: {
          organizationId: org,
          medicineId: medicine.id,
          batchNumber: randomUUID(),
          expiresAt: new Date('2031-01-01'),
          expiryPrecision: 'DAY',
        },
      });
      await ledger.receiveLot(db, s.owner, {
        manufacturingBatchId: batch.id,
        packLevelId: pack.id,
        stockLocationId: s.locationId,
        unitsPerPack: 1,
        supplierName: 'QA',
        supplierInvoiceRef: randomUUID(),
        unitCostMinor: 1,
        printedMrpMinor: priceMinor,
        receivedExpiresAt: batch.expiresAt as Date,
        receivedExpiryPrecision: 'DAY',
        quantityUnits: units + 10,
        idempotencyKey: randomUUID(),
        receivedAt: new Date('2020-01-01'),
      });
      made.push({ medicineId: medicine.id, presentationId: presentation.id, packId: pack.id });
    }
    return made;
  });
  return tenant(s.as(actor), async (db) => {
    const sale = await sales.createSale(db, s.as(actor));
    const billLines: BillLine[] = [];
    for (const [index, item] of items.entries()) {
      const { line } = await sales.addSaleLine(db, s.as(actor), {
        saleId: sale.id,
        medicineId: item.medicineId,
        presentationId: item.presentationId,
        packLevelId: item.packId,
        saleUnit: 'UNIT',
        quantity: lines[index]![1],
        canonicalUnitsPerSaleUnit: 1,
        idempotencyKey: randomUUID(),
      });
      billLines.push({ id: line.id, packLevelId: item.packId, medicineId: item.medicineId });
    }
    return { sale, lines: billLines };
  });
}

/** The pharmacy sales procedures as `userId` calls them, in one request's tenant transaction. */
async function asMember<T>(
  s: Shop,
  userId: string,
  work: (
    caller: ReturnType<
      (typeof import('@/server/routers/pharmacy-sales'))['pharmacySalesRouter']['createCaller']
    >
  ) => Promise<T>
) {
  const { pharmacySalesRouter } = await import('@/server/routers/pharmacy-sales');
  const organizationId = s.owner.organizationId;
  return withTenantDb(
    organizationId,
    (db) =>
      work(
        pharmacySalesRouter.createCaller({
          db,
          entitlements: {
            organizationId,
            enabledModules: ['pharmacy-core', 'pharmacy-counter'],
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
        } as never)
      ),
    { userId, timeout: 60_000 }
  );
}

const changeLine = (
  s: Shop,
  actor: string,
  saleId: string,
  line: BillLine,
  quantity: number,
  deviceId?: string
) =>
  asMember(s, actor, (caller) =>
    caller.changeLine({
      branchId: s.owner.branchId,
      saleId,
      saleLineId: line.id,
      packLevelId: line.packLevelId,
      saleUnit: 'UNIT',
      quantity,
      canonicalUnitsPerSaleUnit: 1,
      idempotencyKey: `test-change:${randomUUID()}`,
      ...(deviceId ? { deviceId } : {}),
    })
  );

const removeLine = (s: Shop, actor: string, saleId: string, line: BillLine, deviceId?: string) =>
  asMember(s, actor, (caller) =>
    caller.removeLine({
      branchId: s.owner.branchId,
      saleId,
      saleLineId: line.id,
      idempotencyKey: `test-remove:${randomUUID()}`,
      ...(deviceId ? { deviceId } : {}),
    })
  );

const openDrawer = (s: Shop, device: string, floatMinor: number) =>
  tenant(s.owner, (db) =>
    settlement.openPharmacyDrawer(db, s.owner, {
      deviceId: device,
      businessDate: s.today,
      openingFloatMinor: floatMinor,
      operatingCashierId: s.cashier,
    })
  );

const shiftsOf = (s: Shop, drawerSessionId: string) =>
  tenant(s.owner, (db) =>
    db.pharmacyCashShift.findMany({ where: { drawerSessionId }, orderBy: { sequence: 'asc' } })
  );

const shiftReport = (s: Shop, shiftId: string) =>
  tenant(s.owner, (db) =>
    shifts.readPharmacyCashShiftReport(db, s.owner, shiftId, { actorIsManager: true })
  );

const closeShift = (s: Shop, actor: string, shiftId: string, countedCashMinor: number) =>
  tenant(s.as(actor), (db) =>
    shifts.closePharmacyCashShift(
      db,
      s.as(actor),
      { shiftId, countedCashMinor },
      { actorIsManager: actor === s.manager }
    )
  );

const openShift = (s: Shop, actor: string, drawerSessionId: string, openingFloatMinor: number) =>
  tenant(s.as(actor), (db) =>
    shifts.openPharmacyCashShift(
      db,
      s.as(actor),
      { drawerSessionId, openingFloatMinor },
      { actorIsManager: actor === s.manager }
    )
  );

const cash = (s: Shop, actor: string, device: string, saleId: string, amountMinor: number) =>
  tenant(s.as(actor), (db) =>
    settlement.applyPharmacyTender(db, s.as(actor), {
      saleId,
      deviceId: device,
      businessDate: s.today,
      type: 'CASH',
      amountMinor,
      cashReceivedMinor: amountMinor,
      idempotencyKey: randomUUID(),
    })
  );

/** The bill's total from its lines, as payment and the close read it. */
const billTotal = (s: Shop, saleId: string) =>
  tenant(s.owner, async (db) =>
    settlement.saleTotalMinor(
      await db.pharmacySaleLine.findMany({
        where: { saleId },
        select: { quantity: true, unitPriceMinor: true, grossMinor: true, discountMinor: true },
      })
    )
  );

/** What a line change or removal could have written that moves cash, for the whole branch. */
const cashRows = (s: Shop, drawerSessionId: string) =>
  tenant(s.owner, async (db) => ({
    tenders: await db.pharmacyTender.findMany({
      where: { branchId: s.owner.branchId },
      select: { id: true, amountMinor: true, shiftId: true },
      orderBy: { id: 'asc' },
    }),
    refunds: await db.pharmacyRefund.count({ where: { branchId: s.owner.branchId } }),
    movements: await db.pharmacyDrawerMovement.findMany({
      where: { drawerSessionId },
      select: { id: true, kind: true, amountMinor: true, shiftId: true },
      orderBy: { id: 'asc' },
    }),
  }));

const lineVoidEvents = (s: Shop) =>
  tenant(s.owner, async (db) =>
    (
      await db.pharmacySaleEvent.findMany({
        where: { branchId: s.owner.branchId, kind: 'VOIDED' },
        select: { saleId: true, payload: true },
      })
    ).map((event) => event.payload as { shiftId?: string; voidedMinor?: number; cause?: string })
  );

// Each test seeds its own organization and runs many transactions as the restricted role.
describeDatabase(
  'bill line changes on a cash-shift branch, on migrated PostgreSQL',
  { timeout: 120_000 },
  () => {
    it('refuses a line change or removal between shifts, as a payment is, and a bill whose shift has closed', async () => {
      const s = await shop('between');
      const device = `device-${randomUUID()}`;
      const drawer = await openDrawer(s, device, 10_000);
      expect(drawer.cashShifts).toBe(true);
      const [first] = await shiftsOf(s, drawer.id);
      expect(first!.cashierId).toBe(s.cashier);
      const started = await billBy(s, s.cashier, [[500, 3]]);
      const line = started.lines[0]!;
      await closeShift(s, s.cashier, first!.id, 10_000);

      // Between shifts: the counter's device, no device at all, and a device with no drawer.
      for (const deviceId of [device, undefined, `device-${randomUUID()}`]) {
        await expect(
          changeLine(s, s.cashier, started.sale.id, line, 1, deviceId)
        ).rejects.toMatchObject({ code: 'CONFLICT', message: 'SHIFT_NOT_OPEN' });
        await expect(
          removeLine(s, s.cashier, started.sale.id, line, deviceId)
        ).rejects.toMatchObject({
          code: 'CONFLICT',
          message: 'SHIFT_NOT_OPEN',
        });
      }
      // The same refusal a payment meets.
      await expect(cash(s, s.cashier, device, started.sale.id, 1_500)).rejects.toMatchObject({
        reason: 'SHIFT_NOT_OPEN',
      });

      // The next shift opens; the bill still belongs to the closed one, for its cashier and a manager.
      const second = await openShift(s, s.cashier2, drawer.id, 10_000);
      for (const actor of [s.cashier, s.manager]) {
        await expect(changeLine(s, actor, started.sale.id, line, 1, device)).rejects.toMatchObject({
          code: 'BAD_REQUEST',
          message: 'LINE_ON_CLOSED_SHIFT',
        });
        await expect(removeLine(s, actor, started.sale.id, line, device)).rejects.toMatchObject({
          code: 'BAD_REQUEST',
          message: 'LINE_ON_CLOSED_SHIFT',
        });
      }

      // Nothing moved: the line is on the bill as it was, no void was recorded, no stock came back.
      const after = await tenant(s.owner, async (db) => ({
        lines: await db.pharmacySaleLine.findMany({ where: { saleId: started.sale.id } }),
        voidRecords: await db.pharmacySale.count({
          where: { branchId: s.owner.branchId, status: 'VOID' },
        }),
        movements: await db.pharmacyStockMovement.aggregate({
          where: { branchId: s.owner.branchId, lot: { batch: { medicineId: line.medicineId } } },
          _sum: { quantityUnits: true },
        }),
      }));
      expect(after.lines.map((row) => [row.id, row.quantity])).toEqual([[line.id, 3]]);
      expect(after.voidRecords).toBe(0);
      expect(after.movements._sum.quantityUnits).toBe(10);
      expect(await lineVoidEvents(s)).toEqual([]);

      // A bill of the open shift changes, and its void names that shift.
      const fresh = await billBy(s, s.cashier2, [[400, 4]]);
      const changed = await changeLine(s, s.cashier2, fresh.sale.id, fresh.lines[0]!, 2, device);
      expect(changed.line.quantity).toBe(2);
      expect(await lineVoidEvents(s)).toEqual([
        expect.objectContaining({
          cause: 'LINE_CHANGED',
          voidedMinor: 800,
          shiftId: second.shift.id,
        }),
      ]);
    });

    it('never moves cash: the open shift expects the same cash, and the changed bill pays in as a fresh one', async () => {
      const s = await shop('cash');
      const device = `device-${randomUUID()}`;
      const drawer = await openDrawer(s, device, 10_000);
      const [shift] = await shiftsOf(s, drawer.id);
      const before = await shiftReport(s, shift!.id);
      const rowsBefore = await cashRows(s, drawer.id);
      expect(before.cash.expectedMinor).toBe(10_000);

      const changedBill = await billBy(s, s.cashier, [
        [700, 4],
        [300, 2],
      ]);
      const [kept, dropped] = changedBill.lines as [BillLine, BillLine];
      const halved = await changeLine(s, s.cashier, changedBill.sale.id, kept, 2, device);
      // A change re-adds the line under a new id; the next change names that line.
      await changeLine(
        s,
        s.cashier,
        changedBill.sale.id,
        { ...kept, id: halved.line.id },
        3,
        device
      );
      await removeLine(s, s.cashier, changedBill.sale.id, dropped, device);

      // No tender, refund or drawer movement, and the shift's figures are exactly as before.
      const during = await shiftReport(s, shift!.id);
      expect(await cashRows(s, drawer.id)).toEqual(rowsBefore);
      expect(during.cash).toEqual(before.cash);
      expect(during.tenders).toEqual([]);
      expect(during.netTakenMinor).toBe(0);
      expect(during.lineVoids).toEqual({ count: 2, valueMinor: 1_400 + 600 });

      // Paid, the changed bill adds exactly what a fresh bill rung up with its final lines adds.
      const changedTotal = await billTotal(s, changedBill.sale.id);
      expect(changedTotal).toBe(3 * 700);
      await cash(s, s.cashier, device, changedBill.sale.id, changedTotal);
      const afterChanged = (await shiftReport(s, shift!.id)).cash.expectedMinor;
      const freshBill = await billBy(s, s.cashier, [[700, 3]]);
      const freshTotal = await billTotal(s, freshBill.sale.id);
      expect(freshTotal).toBe(changedTotal);
      await cash(s, s.cashier, device, freshBill.sale.id, freshTotal);
      const afterFresh = await shiftReport(s, shift!.id);
      expect(afterChanged - before.cash.expectedMinor).toBe(changedTotal);
      expect(afterFresh.cash.expectedMinor - afterChanged).toBe(
        afterChanged - before.cash.expectedMinor
      );
      expect(afterFresh.cash.cashSalesMinor).toBe(2 * changedTotal);
      expect(afterFresh.tenders).toEqual([
        { type: 'CASH', count: 2, amountMinor: 2 * changedTotal },
      ]);
      expect((await cashRows(s, drawer.id)).tenders.every((t) => t.shiftId === shift!.id)).toBe(
        true
      );
      // The line changes' voids are counted, and moved no cash of their own.
      expect(afterFresh.lineVoids).toEqual({ count: 2, valueMinor: 2_000 });
    });

    it('counts the value a line change voids once: in its shift, in the day close and in the day’s voids', async () => {
      const s = await shop('voids');
      const device = `device-${randomUUID()}`;
      const drawer = await openDrawer(s, device, 10_000);
      const [first] = await shiftsOf(s, drawer.id);

      // Shift 1: 4 → 1 unit (1,500 off), a line removed (600 off), then 1 → 3 units (nothing off).
      const one = await billBy(s, s.cashier, [
        [500, 4],
        [300, 2],
      ]);
      const cut = await changeLine(s, s.cashier, one.sale.id, one.lines[0]!, 1, device);
      await removeLine(s, s.cashier, one.sale.id, one.lines[1]!, device);
      await changeLine(s, s.cashier, one.sale.id, { ...one.lines[0]!, id: cut.line.id }, 3, device);
      const oneTotal = await billTotal(s, one.sale.id);
      expect(oneTotal).toBe(1_500);
      await cash(s, s.cashier, device, one.sale.id, oneTotal);
      const firstOpen = await shiftReport(s, first!.id);
      expect(firstOpen.lineVoids).toEqual({ count: 2, valueMinor: 2_100 });
      await closeShift(s, s.cashier, first!.id, firstOpen.cash.expectedMinor);

      // Shift 2: 5 → 2 units (1,200 off).
      const second = await openShift(s, s.cashier2, drawer.id, firstOpen.cash.expectedMinor);
      const two = await billBy(s, s.cashier2, [[400, 5]]);
      await changeLine(s, s.cashier2, two.sale.id, two.lines[0]!, 2, device);
      await cash(s, s.cashier2, device, two.sale.id, await billTotal(s, two.sale.id));

      // Each void names the one shift it happened in.
      const events = await lineVoidEvents(s);
      expect(events.map((e) => [e.shiftId, e.voidedMinor]).sort()).toEqual(
        [
          [first!.id, 1_500],
          [first!.id, 600],
          [second.shift.id, 1_200],
        ].sort()
      );

      // The closed shift's report is frozen with its voids; the open one counts only its own.
      const firstClosed = await shiftReport(s, first!.id);
      expect(firstClosed.status).toBe('CLOSED');
      expect(firstClosed.lineVoids).toEqual({ count: 2, valueMinor: 2_100 });
      expect((await shiftReport(s, second.shift.id)).lineVoids).toEqual({
        count: 1,
        valueMinor: 1_200,
      });

      // The day close adds its shifts' voids once, and the day's void evidence holds each once.
      const expectDay = async () => {
        const preview = await tenant(s.owner, (db) =>
          dayClose.readPharmacyClose(db, s.owner, s.today)
        );
        expect(preview.shiftTotals?.lineVoids).toEqual({ count: 3, valueMinor: 3_300 });
        expect(preview.shifts?.map((shift) => shift.lineVoids)).toEqual([
          { count: 2, valueMinor: 2_100 },
          { count: 1, valueMinor: 1_200 },
        ]);
        const evidence = await tenant(s.owner, (db) =>
          closeCheck.readPharmacyCashCloseCheck(db, s.owner, s.today)
        );
        expect(evidence.totals.voidCount).toBe(3);
        expect(evidence.totals.voidValueMinor).toBe(3_300);
      };
      await expectDay();
      const secondOpen = await shiftReport(s, second.shift.id);
      await closeShift(s, s.cashier2, second.shift.id, secondOpen.cash.expectedMinor);
      // Frozen at the second close, the figures are unchanged.
      await expectDay();
    });
  }
);

describeDatabase('DEV-988 explicit bill line pack check', () => {
  it('records a mismatch, blocks payment and line replacement, and releases only a matching allocated batch', async () => {
    const s = await shop('packcheck');
    const device = 'pack-till';
    await openDrawer(s, device, 0);
    const { sale, lines } = await billBy(s, s.cashier, [[1000, 1]]);
    const line = lines[0]!;
    const check = (payload: string) =>
      asMember(s, s.cashier, (c) =>
        c.checkBillLinePack({
          branchId: s.owner.branchId,
          saleId: sale.id,
          saleLineId: line.id,
          payload,
        })
      );
    expect(await check('unlisted-pack')).toMatchObject({ matched: false });
    await expect(
      tenant(s.as(s.cashier), (db) =>
        db.pharmacyCardTerminalAttempt.create({
          data: {
            organizationId: s.owner.organizationId,
            branchId: s.owner.branchId,
            saleId: sale.id,
            deviceId: device,
            terminalId: 'counter-1',
            provider: 'QA_TERMINAL',
            attemptKey: randomUUID(),
            amountMinor: 1000,
            currency: 'PKR',
            businessDate: s.today,
            actorId: s.cashier,
          },
        })
      )
    ).rejects.toThrow(/PACK_CHECK_REQUIRED/);
    await expect(cash(s, s.cashier, device, sale.id, 1000)).rejects.toThrow(/pack.check/i);
    await expect(changeLine(s, s.cashier, sale.id, line, 2, device)).rejects.toThrow(/pack.check/i);
    const gtin = '01234567890128';
    const batch = await tenant(s.owner, async (db) => {
      const alloc = await db.pharmacySaleLineAllocation.findFirstOrThrow({
        where: { saleLineId: line.id },
        include: { lot: { include: { batch: true, packLevel: true } } },
      });
      await db.medicineBarcode.create({
        data: {
          organizationId: s.owner.organizationId,
          presentationId: alloc.lot.packLevel.presentationId,
          packLevelId: line.packLevelId,
          type: 'GTIN',
          code: gtin,
          normalizedCode: gtin,
        },
      });
      await db.pharmacyManufacturingBatch.update({
        where: { id: alloc.lot.batch.id },
        data: { batchNumber: 'TESTPACK' },
      });
      return 'TESTPACK';
    });
    expect(await check(`(01)${gtin}(10)${batch}(17)310101`)).toMatchObject({
      matched: true,
      batchChecked: true,
    });
    await cash(s, s.cashier, device, sale.id, 1000);
    const checks = await tenant(s.owner, (db) =>
      db.pharmacySaleEvent.findMany({
        where: { saleId: sale.id, kind: 'PACK_CHECK' },
        orderBy: { occurredAt: 'asc' },
      })
    );
    expect(checks.map((row) => row.payload)).toMatchObject([
      { saleLineId: line.id, matched: false },
      { saleLineId: line.id, matched: true },
    ]);
  }, 60000);
});

describeDatabase('DEV-1054 a failed pack check follows the bill and the medicine', () => {
  const GTIN = '01234567890128';
  const device = 'readd-till';

  /** A one-line bill whose medicine has a registered barcode, so a pack can match. */
  async function checkedBill(label: string) {
    const s = await shop(label);
    await openDrawer(s, device, 0);
    const { sale, lines } = await billBy(s, s.cashier, [[1000, 1]]);
    const line = lines[0]!;
    const presentationId = await tenant(s.owner, async (db) => {
      const pack = await db.packLevel.findUniqueOrThrow({ where: { id: line.packLevelId } });
      await db.medicineBarcode.create({
        data: {
          organizationId: s.owner.organizationId,
          presentationId: pack.presentationId,
          packLevelId: pack.id,
          type: 'GTIN',
          code: GTIN,
          normalizedCode: GTIN,
        },
      });
      return pack.presentationId;
    });
    const check = (saleLineId: string, payload: string) =>
      asMember(s, s.cashier, (c) =>
        c.checkBillLinePack({ branchId: s.owner.branchId, saleId: sale.id, saleLineId, payload })
      );
    const add = async (saleId: string, item = { ...line, presentationId }) => {
      const { line: added } = await tenant(s.as(s.cashier), (db) =>
        sales.addSaleLine(db, s.as(s.cashier), {
          saleId,
          medicineId: item.medicineId,
          presentationId: item.presentationId,
          packLevelId: item.packLevelId,
          saleUnit: 'UNIT',
          quantity: 1,
          canonicalUnitsPerSaleUnit: 1,
          idempotencyKey: randomUUID(),
        })
      );
      return added;
    };
    const pay = (saleId: string, amountMinor = 1000) =>
      cash(s, s.cashier, device, saleId, amountMinor);
    const fail = (saleLineId: string) => check(saleLineId, 'synthetic-unmatched-pack');
    const pass = (saleLineId: string) => check(saleLineId, '(01)' + GTIN);
    /** Which of the bill's lines are blocked, by line id. */
    const blocked = async (saleId: string) =>
      Object.fromEntries(
        (
          await tenant(s.owner, (db) =>
            db.pharmacySaleLine.findMany({
              where: { saleId },
              select: { id: true, packCheckBlocked: true },
            })
          )
        ).map((row) => [row.id, row.packCheckBlocked])
      );
    /** A PACK_CHECK event written straight to the table, as a caller that skips the procedure. */
    const rawCheck = (
      saleLineId: string,
      matched: boolean,
      at?: { id: string; occurredAt: Date }
    ) =>
      tenant(s.as(s.cashier), (db) =>
        db.pharmacySaleEvent.create({
          data: {
            ...at,
            organizationId: s.owner.organizationId,
            branchId: s.owner.branchId,
            saleId: sale.id,
            actorId: s.cashier,
            kind: 'PACK_CHECK',
            payload: { saleLineId, scanId: 'synthetic-scan', matched },
          },
        })
      );
    const status = (saleId: string) =>
      tenant(s.owner, (db) =>
        db.pharmacySale.findUniqueOrThrow({ where: { id: saleId }, select: { status: true } })
      );
    return { s, sale, line, add, pay, fail, pass, blocked, rawCheck, status };
  }

  it('blocks a line of the medicine that was already on the bill when the check failed', async () => {
    const { s, sale, line, add, pay, fail, pass, blocked, status } = await checkedBill('twolines');
    const second = await add(sale.id);
    expect(second.packCheckBlocked).toBe(false);
    expect(await fail(line.id)).toMatchObject({ matched: false });
    expect(await blocked(sale.id)).toEqual({ [line.id]: true, [second.id]: true });
    await removeLine(s, s.cashier, sale.id, line, device);
    await expect(pay(sale.id)).rejects.toThrow(/pack.check/i);
    expect(await status(sale.id)).toEqual({ status: 'OPEN' });
    // Only a successful check on the remaining line lets the bill be paid.
    expect(await pass(second.id)).toMatchObject({ matched: true });
    expect(await blocked(sale.id)).toEqual({ [second.id]: false });
    await pay(sale.id);
    expect(await status(sale.id)).toEqual({ status: 'COMPLETED' });
  }, 60_000);

  it('blocks every open line of the medicine when the failed check is written past the procedure', async () => {
    const { s, sale, line, add, pay, rawCheck, blocked } = await checkedBill('rawevent');
    const second = await add(sale.id);
    await rawCheck(line.id, false);
    expect(await blocked(sale.id)).toEqual({ [line.id]: true, [second.id]: true });
    await removeLine(s, s.cashier, sale.id, line, device);
    await expect(pay(sale.id)).rejects.toThrow(/pack.check/i);
  }, 60_000);

  it('clears only the checked line on a successful check', async () => {
    const { s, sale, line, add, pay, fail, pass, blocked, status } = await checkedBill('ownline');
    const second = await add(sale.id);
    expect(await fail(line.id)).toMatchObject({ matched: false });
    expect(await pass(second.id)).toMatchObject({ matched: true });
    expect(await blocked(sale.id)).toEqual({ [line.id]: true, [second.id]: false });
    await expect(pay(sale.id, 2000)).rejects.toThrow(/pack.check/i);
    await removeLine(s, s.cashier, sale.id, line, device);
    await pay(sale.id);
    expect(await status(sale.id)).toEqual({ status: 'COMPLETED' });
  }, 60_000);

  it('leaves a different medicine already on the bill and the medicine on another bill unblocked', async () => {
    const { s, sale, line, add, pay, fail, blocked, status } = await checkedBill('siblings');
    const other = await billBy(s, s.cashier, [[700, 1]]);
    const otherLine = other.lines[0]!;
    const otherPresentationId = await tenant(s.owner, async (db) => {
      const pack = await db.packLevel.findUniqueOrThrow({ where: { id: otherLine.packLevelId } });
      return pack.presentationId;
    });
    const second = await add(sale.id);
    const different = await add(sale.id, { ...otherLine, presentationId: otherPresentationId });
    const elsewhere = await add(other.sale.id);
    expect(await fail(line.id)).toMatchObject({ matched: false });
    expect(await blocked(sale.id)).toEqual({
      [line.id]: true,
      [second.id]: true,
      [different.id]: false,
    });
    expect(await blocked(other.sale.id)).toEqual({ [otherLine.id]: false, [elsewhere.id]: false });
    await pay(other.sale.id, 1700);
    expect(await status(other.sale.id)).toEqual({ status: 'COMPLETED' });
    // Once both lines of the failed medicine are gone, the different medicine pays.
    await removeLine(s, s.cashier, sale.id, line, device);
    await removeLine(s, s.cashier, sale.id, { ...line, id: second.id }, device);
    await pay(sale.id, 700);
    expect(await status(sale.id)).toEqual({ status: 'COMPLETED' });
  }, 60_000);

  it('never leaves an unblocked replacement when another line of the medicine changes quantity', async () => {
    const { s, sale, line, add, pay, fail, blocked } = await checkedBill('qtychange');
    const second = await add(sale.id);
    expect(await fail(line.id)).toMatchObject({ matched: false });
    // The other line is blocked with the checked one, so its change is refused before the line
    // is re-inserted; the line stays as it was, still blocked.
    await expect(
      changeLine(s, s.cashier, sale.id, { ...line, id: second.id }, 2, device)
    ).rejects.toThrow(/PACK_CHECK_REQUIRED/);
    expect(await blocked(sale.id)).toEqual({ [line.id]: true, [second.id]: true });
    await removeLine(s, s.cashier, sale.id, line, device);
    await expect(pay(sale.id)).rejects.toThrow(/pack.check/i);
  }, 60_000);

  it('starts a quantity-change replacement blocked when its line was left unblocked', async () => {
    const { s, sale, line, add, pay, rawCheck, blocked } = await checkedBill('qtyreinsert');
    const second = await add(sale.id);
    await rawCheck(line.id, false);
    // Stored state the triggers never produce: the sibling unblocked under an unresolved failed
    // check. Its replacement must still start blocked, from the event history alone.
    await tenant(s.as(s.cashier), (db) =>
      db.pharmacySaleLine.update({ where: { id: second.id }, data: { packCheckBlocked: false } })
    );
    const changed = await changeLine(s, s.cashier, sale.id, { ...line, id: second.id }, 2, device);
    expect(changed.replacedSaleLineId).toBe(second.id);
    expect(await blocked(sale.id)).toEqual({ [line.id]: true, [changed.line.id]: true });
    await removeLine(s, s.cashier, sale.id, line, device);
    await expect(pay(sale.id, 2000)).rejects.toThrow(/pack.check/i);
  }, 60_000);

  it('orders checks that share a timestamp by event id, and keeps the block unless the pass is later', async () => {
    const occurredAt = new Date();
    const stem = randomUUID().replaceAll('-', '');
    // The successful check has the smaller id: it is not later, so the block stays.
    const kept = await checkedBill('tiekept');
    await kept.rawCheck(kept.line.id, false, { id: `${stem}k2`, occurredAt });
    await kept.rawCheck(kept.line.id, true, { id: `${stem}k1`, occurredAt });
    expect((await kept.add(kept.sale.id)).packCheckBlocked).toBe(true);
    // The successful check has the larger id: it is the later of the two.
    const later = await checkedBill('tielater');
    await later.rawCheck(later.line.id, false, { id: `${stem}l1`, occurredAt });
    await later.rawCheck(later.line.id, true, { id: `${stem}l2`, occurredAt });
    expect((await later.add(later.sale.id)).packCheckBlocked).toBe(false);
  }, 60_000);

  it('refuses payment when the medicine is added again before the blocked line is removed', async () => {
    const { s, sale, line, add, pay, fail } = await checkedBill('readdfirst');
    expect(await fail(line.id)).toMatchObject({ matched: false });
    const again = await add(sale.id);
    expect(again.id).not.toBe(line.id);
    expect(again.packCheckBlocked).toBe(true);
    await removeLine(s, s.cashier, sale.id, line, device);
    await expect(pay(sale.id)).rejects.toThrow(/pack.check/i);
    // Removing and re-adding once more does not launder the failed check either.
    await removeLine(s, s.cashier, sale.id, { ...line, id: again.id }, device);
    const third = await add(sale.id);
    expect(third.packCheckBlocked).toBe(true);
    await expect(pay(sale.id)).rejects.toThrow(/pack.check/i);
    expect(
      await tenant(s.owner, (db) =>
        db.pharmacySale.findUniqueOrThrow({ where: { id: sale.id }, select: { status: true } })
      )
    ).toEqual({ status: 'OPEN' });
  }, 60_000);

  it('still refuses payment when the blocked line is removed before the medicine is added again', async () => {
    const { s, sale, line, add, pay, fail } = await checkedBill('removefirst');
    expect(await fail(line.id)).toMatchObject({ matched: false });
    await removeLine(s, s.cashier, sale.id, line, device);
    expect((await add(sale.id)).packCheckBlocked).toBe(true);
    await expect(pay(sale.id)).rejects.toThrow(/pack.check/i);
  }, 60_000);

  it('takes payment once the line added again passes its own check', async () => {
    const { s, sale, line, add, pay, fail, pass } = await checkedBill('recheck');
    expect(await fail(line.id)).toMatchObject({ matched: false });
    const again = await add(sale.id);
    expect(again.packCheckBlocked).toBe(true);
    await removeLine(s, s.cashier, sale.id, line, device);
    expect(await pass(again.id)).toMatchObject({ matched: true });
    await pay(sale.id);
    expect(
      await tenant(s.owner, (db) =>
        db.pharmacySale.findUniqueOrThrow({ where: { id: sale.id }, select: { status: true } })
      )
    ).toEqual({ status: 'COMPLETED' });
  }, 60_000);

  it('blocks the medicine again when a later check fails after an earlier pass', async () => {
    const { s, sale, line, add, pay, fail, pass } = await checkedBill('failafterpass');
    expect(await pass(line.id)).toMatchObject({ matched: true });
    expect(await fail(line.id)).toMatchObject({ matched: false });
    const again = await add(sale.id);
    expect(again.packCheckBlocked).toBe(true);
    await removeLine(s, s.cashier, sale.id, line, device);
    await expect(pay(sale.id)).rejects.toThrow(/pack.check/i);
  }, 60_000);

  it('leaves a different medicine on the same bill and the same medicine on another bill unblocked', async () => {
    const { s, sale, line, add, pay, fail } = await checkedBill('unaffected');
    // A second medicine, received and first billed on a bill of its own.
    const other = await billBy(s, s.cashier, [[700, 1]]);
    const otherLine = other.lines[0]!;
    const otherPresentationId = await tenant(s.owner, async (db) => {
      const pack = await db.packLevel.findUniqueOrThrow({ where: { id: otherLine.packLevelId } });
      return pack.presentationId;
    });
    expect(await fail(line.id)).toMatchObject({ matched: false });

    // A different medicine added to the bill that holds the failed check.
    const different = await add(sale.id, { ...otherLine, presentationId: otherPresentationId });
    expect(different.packCheckBlocked).toBe(false);
    await removeLine(s, s.cashier, sale.id, line, device);
    await pay(sale.id, 700);

    // The failed medicine on another bill.
    const same = await add(other.sale.id);
    expect(same.packCheckBlocked).toBe(false);
    await pay(other.sale.id, 1700);
    expect(
      await tenant(s.owner, (db) =>
        db.pharmacySale.findMany({
          where: { id: { in: [sale.id, other.sale.id] } },
          select: { status: true },
        })
      )
    ).toEqual([{ status: 'COMPLETED' }, { status: 'COMPLETED' }]);
  }, 60_000);
});

describeDatabase('DEV-977 existing line discount', () => {
  it('requires a verified approval and records the authorized discount against the selected line and its allocations', async () => {
    const s = await shop('discount');
    const device = 'discount-till';
    await openDrawer(s, device, 0);
    const { sale, lines } = await billBy(s, s.cashier, [
      [1000, 2],
      [500, 1],
    ]);
    const input = {
      branchId: s.owner.branchId,
      saleId: sale.id,
      saleLineId: lines[0]!.id,
      deviceId: device,
      discount: { kind: 'PERCENT' as const, bps: 100 },
      requestId: randomUUID(),
    };
    const apply = () => asMember(s, s.cashier, (c) => c.discountBillLine(input));
    await expect(apply()).rejects.toThrow(/approve|approval/i);
    await tenant(s.owner, async (db) => {
      await db.userPermissionOverride.create({
        data: {
          userId: s.cashier,
          capability: 'pharmacy:discount',
          effect: 'ALLOW',
          reason: 'Synthetic line discount test',
        },
      });
    });
    const result = await apply();
    expect(result).toMatchObject({ discountMinor: 20 });
    await expect(apply()).resolves.toMatchObject({ discountMinor: 20 });
    await tenant(s.owner, async (db) => {
      const line = await db.pharmacySaleLine.findUniqueOrThrow({
        where: { id: input.saleLineId },
        include: { allocations: true },
      });
      expect(line).toMatchObject({ discountMinor: 20, approvedByUserId: s.cashier });
      const { saleAllocationMoney } = await import('./sale-line-money');
      expect(saleAllocationMoney(line).map((a) => a.discountMinor)).toEqual([20]);
      expect(line.allocations.map((a) => a.discountMinor)).toEqual([0]);
      expect(await db.pharmacySaleLine.findFirst({ where: { id: lines[1]!.id } })).toMatchObject({
        discountMinor: 0,
      });

      await db.organization.update({
        where: { id: s.owner.organizationId },
        data: { pharmacyBillDiscountEnabled: true },
      });
      const { applyBillDiscount } = await import('./bill-discount-service');
      const wholeBill = await applyBillDiscount(db, s.owner, {
        saleId: sale.id,
        request: { kind: 'AMOUNT', minor: 5 },
        approval: {
          approvedByUserId: s.cashier,
          approvalPolicy: line.approvalPolicy!,
          selfApproved: true,
        },
      });
      expect(wholeBill).toMatchObject({
        status: 'APPLIED',
        excluded: [{ saleLineId: line.id, reason: 'OWN_DISCOUNT' }],
        lines: [{ saleLineId: lines[1]!.id, discountMinor: 5 }],
      });
      expect(await db.pharmacySaleLine.findUniqueOrThrow({ where: { id: line.id } })).toMatchObject(
        {
          discountMinor: 20,
          billDiscountMinor: 0,
        }
      );
    });
  }, 60000);
});

describeDatabase('DEV-977 multi-line returns', () => {
  it('requires the same fresh witness as a single return when a sold medicine becomes controlled', async () => {
    const s = await shop('returnwitness');
    const device = 'return-witness-till';
    await openDrawer(s, device, 0);
    const { sale, lines } = await billBy(s, s.cashier, [
      [1000, 1],
      [500, 1],
    ]);
    await cash(s, s.cashier, device, sale.id, 1500);
    const selected = await tenant(s.owner, async (db) => {
      await db.medicine.update({ where: { id: lines[1]!.medicineId }, data: { controlled: true } });
      await db.userPermissionOverride.create({
        data: {
          userId: s.manager,
          capability: 'pharmacy:dispense',
          effect: 'ALLOW',
          reason: 'Test on-duty pharmacist',
        },
      });
      const allocations = await db.pharmacySaleLineAllocation.findMany({
        where: { saleLineId: { in: lines.map((l) => l.id) } },
      });
      return lines.map((l) => ({
        saleLineId: l.id,
        canonicalUnits: 1,
        lotId: allocations.find((a) => a.saleLineId === l.id)!.inventoryLotId,
        disposition: 'RESTOCK' as const,
        integrityDecision: 'Unopened pack',
      }));
    });
    const reason = 'Wrong items';
    await expect(
      tenant(s.owner, (db) =>
        sales.returnSaleLine(db, s.owner, {
          ...selected[1]!,
          reason,
          idempotencyKey: randomUUID(),
        })
      )
    ).rejects.toThrow(/fresh witness PIN/);
    await expect(
      tenant(s.owner, (db) =>
        sales.returnSaleLines(db, s.owner, {
          saleId: sale.id,
          requestId: randomUUID(),
          reason,
          lines: selected,
        })
      )
    ).rejects.toThrow(/fresh witness PIN/);
    expect(
      await tenant(s.owner, (db) =>
        db.pharmacySaleReturn.count({ where: { originalSaleId: sale.id } })
      )
    ).toBe(0);
  }, 60000);

  it('returns the selected sale lines together, refuses excess units atomically and replays the group once', async () => {
    const s = await shop('returngroup');
    const device = 'returns-till';
    await openDrawer(s, device, 0);
    const { sale, lines } = await billBy(s, s.cashier, [
      [1000, 2],
      [500, 1],
    ]);
    await cash(s, s.cashier, device, sale.id, 2500);
    const lots = await tenant(s.owner, (db) =>
      db.pharmacySaleLineAllocation.findMany({
        where: { saleLineId: { in: lines.map((l) => l.id) } },
      })
    );
    const selected = lines.map((l) => ({
      saleLineId: l.id,
      canonicalUnits: 1,
      lotId: lots.find((a) => a.saleLineId === l.id)!.inventoryLotId,
      disposition: 'RESTOCK' as const,
      integrityDecision: 'Inspected: intact',
    }));
    const input = {
      saleId: sale.id,
      requestId: randomUUID(),
      reason: 'Wrong items',
      lines: selected,
    };
    const run = (items: typeof selected) =>
      tenant(s.owner, (db) => sales.returnSaleLines(db, s.owner, { ...input, lines: items }));
    await expect(run([selected[0]!, { ...selected[1]!, canonicalUnits: 2 }])).rejects.toThrow(
      /RETURN_EXCEEDS_SOLD/
    );
    expect(
      await tenant(s.owner, (db) =>
        db.pharmacySaleReturn.count({ where: { originalSaleId: sale.id } })
      )
    ).toBe(0);
    const result = await run(selected);
    expect(await run(selected)).toMatchObject({ returnId: result.returnId, returnedMinor: 1500 });
    const rows = await tenant(s.owner, (db) =>
      db.pharmacySaleReturnLine.findMany({ where: { returnId: result.returnId } })
    );
    expect(rows.map((r) => r.saleLineId).sort()).toEqual(lines.map((l) => l.id).sort());
    await expect(
      tenant(s.owner, (db) =>
        sales.returnSaleLines(db, s.owner, { ...input, requestId: randomUUID() })
      )
    ).rejects.toThrow(/RETURN_EXCEEDS_SOLD/);
  }, 60000);
});

describeDatabase('reviewed counter invariants', () => {
  async function credential(s: Shop) {
    const { hashOperatorCredential } = await import('@/lib/restaurant/operator-credentials');
    const hash = await hashOperatorCredential('PIN', '3846');
    return tenant(s.owner, async (db) => {
      const profile = await db.restaurantStaffProfile.create({
        data: { userId: s.manager, displayName: 'Synthetic supervisor' },
      });
      await db.restaurantOperatorCredential.create({
        data: { staffProfileId: profile.id, type: 'PIN', credentialHash: hash },
      });
      return profile.id;
    });
  }

  it('commits a wrong approval strike before checking the bill and applies no discount', async () => {
    const s = await shop('reviewstrike');
    const { sale, lines } = await billBy(s, s.cashier, [[1000, 1]]);
    const profile = await credential(s);
    await tenant(s.owner, (db) =>
      db.organization.update({
        where: { id: s.owner.organizationId },
        data: { requireApprovalAuthenticator: false },
      })
    );
    await expect(
      asMember(s, s.cashier, (c) =>
        c.discountBillLine({
          branchId: s.owner.branchId,
          saleId: sale.id,
          saleLineId: 'missing-test-line',
          requestId: randomUUID(),
          discount: { kind: 'AMOUNT', minor: 10 },
          discountApproval: { staffProfileId: profile, pin: '8402' },
        })
      )
    ).rejects.toThrow(/approval|approve/i);
    await tenant(s.owner, async (db) => {
      expect(
        (
          await db.restaurantOperatorCredential.findFirstOrThrow({
            where: { staffProfileId: profile },
          })
        ).failedAttempts
      ).toBe(1);
      expect(
        (await db.pharmacySaleLine.findUniqueOrThrow({ where: { id: lines[0]!.id } })).discountMinor
      ).toBe(0);
      expect(
        await db.pharmacySaleEvent.count({ where: { saleId: sale.id, kind: 'LINE_DISCOUNT' } })
      ).toBe(0);
    });
  });

  it('refuses the same synthetic authenticator code on a second line', async () => {
    const s = await shop('reviewcode');
    const device = 'reviewcode';
    await openDrawer(s, device, 0);
    const { sale, lines } = await billBy(s, s.cashier, [
      [1000, 1],
      [1000, 1],
    ]);
    const profile = await credential(s);
    const { encryptSecret } = await import('@/lib/secret-crypto');
    const { createHmac } = await import('node:crypto');
    // A test-only, 20-byte zero key encodes to 32 base32 A characters.
    await tenant(s.owner, async (db) => {
      await db.organization.update({
        where: { id: s.owner.organizationId },
        data: { requireApprovalAuthenticator: true },
      });
      await db.approvalAuthenticator.create({
        data: {
          organizationId: s.owner.organizationId,
          userId: s.manager,
          encryptedSecret: encryptSecret('A'.repeat(32)),
          enabledAt: new Date(),
        },
      });
    });
    const counter = Buffer.alloc(8);
    counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
    const mac = createHmac('sha1', Buffer.alloc(20)).update(counter).digest();
    const code = String(
      (mac.readUInt32BE(mac[mac.length - 1]! & 15) & 0x7fffffff) % 1000000
    ).padStart(6, '0');
    const give = (id: string) =>
      asMember(s, s.cashier, (c) =>
        c.discountBillLine({
          branchId: s.owner.branchId,
          saleId: sale.id,
          saleLineId: id,
          deviceId: device,
          requestId: randomUUID(),
          discount: { kind: 'AMOUNT', minor: 10 },
          discountApproval: { staffProfileId: profile, pin: code },
        })
      );
    await expect(give(lines[0]!.id)).resolves.toMatchObject({ discountMinor: 10 });
    await expect(give(lines[1]!.id)).rejects.toThrow(/approval|approve/i);
    await tenant(s.owner, async (db) => {
      expect(
        (await db.pharmacySaleLine.findUniqueOrThrow({ where: { id: lines[1]!.id } })).discountMinor
      ).toBe(0);
      expect(
        (
          await db.restaurantOperatorCredential.findFirstOrThrow({
            where: { staffProfileId: profile },
          })
        ).failedAttempts
      ).toBe(1);
    });
  });

  it('refunds the exact discounted value and permits one simultaneous return of the same lines', async () => {
    const s = await shop('reviewrefund', 'pharmacy:dispense');
    const device = 'refund-till';
    await openDrawer(s, device, 0);
    const { sale, lines } = await billBy(s, s.cashier, [
      [1000, 1],
      [500, 1],
    ]);
    await credential(s);
    await tenant(s.owner, async (db) => {
      await db.organization.update({
        where: { id: s.owner.organizationId },
        data: { requireApprovalAuthenticator: false },
      });
      await db.userPermissionOverride.create({
        data: {
          userId: s.cashier,
          capability: 'pharmacy:discount',
          effect: 'ALLOW',
          reason: 'Test discount operator',
        },
      });
    });
    await asMember(s, s.cashier, (c) =>
      c.discountBillLine({
        branchId: s.owner.branchId,
        saleId: sale.id,
        saleLineId: lines[0]!.id,
        deviceId: device,
        requestId: randomUUID(),
        discount: { kind: 'AMOUNT', minor: 23 },
      })
    );
    await cash(s, s.cashier, device, sale.id, 1477);
    const { items, tender } = await tenant(s.owner, async (db) => {
      const allocations = await db.pharmacySaleLineAllocation.findMany({
        where: { saleLineId: { in: lines.map((l) => l.id) } },
      });
      const tender = await db.pharmacyTender.findFirstOrThrow({ where: { saleId: sale.id } });
      return {
        tender,
        items: lines.map((l) => ({
          saleLineId: l.id,
          canonicalUnits: 1,
          lotId: allocations.find((a) => a.saleLineId === l.id)!.inventoryLotId,
          disposition: 'RESTOCK' as const,
          integrityDecision: 'Intact',
        })),
      };
    });
    await expect(
      tenant(s.owner, (db) => sales.quoteSaleLineReturn(db, s.owner, items[0]!))
    ).resolves.toEqual({ valueMinor: 977 });
    await expect(
      tenant(s.owner, (db) => sales.quoteSaleLineReturn(db, s.owner, items[1]!))
    ).resolves.toEqual({ valueMinor: 500 });
    const refund = () =>
      asMember(s, s.manager, (c) =>
        c.returnLines({
          branchId: s.owner.branchId,
          saleId: sale.id,
          requestId: randomUUID(),
          reason: 'Synthetic purchase return',
          managerPin: '3846',
          lines: items,
          refund: {
            originalTenderId: tender.id,
            deviceId: device,
            businessDate: s.today,
            manualCashFallback: false,
          },
        })
      );
    const raced = await Promise.allSettled([refund(), refund()]);
    expect(raced.filter((r) => r.status === 'fulfilled').map((r) => r.value)).toMatchObject([
      { returnedMinor: 1477 },
    ]);
    const refusal = raced.find((r) => r.status === 'rejected');
    expect(refusal?.reason.message).toMatch(/exceed|already returned|remaining/i);
    await tenant(s.owner, async (db) => {
      const returns = await db.pharmacySaleReturn.findMany({ where: { originalSaleId: sale.id } });
      expect(returns).toHaveLength(1);
      expect(await db.pharmacySaleReturnLine.count({ where: { returnId: returns[0]!.id } })).toBe(
        2
      );
      expect(
        await db.pharmacyRefund.findMany({
          where: { originalTenderId: tender.id },
          select: { amountMinor: true },
        })
      ).toEqual([{ amountMinor: 1477 }]);
    });
  });
});

describeDatabase('reviewed pack, demand and discount storage rules', () => {
  it('matches a registered presentation barcode without a pack level or batch', async () => {
    const s = await shop('presentationpack');
    const { sale, lines } = await billBy(s, s.cashier, [[1000, 1]]);
    const line = lines[0]!;
    const gtin = '01234567890128';
    await tenant(s.owner, async (db) => {
      const pack = await db.packLevel.findUniqueOrThrow({ where: { id: line.packLevelId } });
      await db.medicineBarcode.create({
        data: {
          organizationId: s.owner.organizationId,
          presentationId: pack.presentationId,
          type: 'GTIN',
          code: gtin,
          normalizedCode: gtin,
        },
      });
    });
    await expect(
      asMember(s, s.cashier, (c) =>
        c.checkBillLinePack({
          branchId: s.owner.branchId,
          saleId: sale.id,
          saleLineId: line.id,
          payload: '(01)' + gtin,
        })
      )
    ).resolves.toEqual({ matched: true, batchChecked: false });
  }, 60_000);

  it('requires a fresh pack check after removing and re-adding the same medicine, even without an encoded batch', async () => {
    const s = await shop('reviewpack');
    const device = 'recheck';
    await openDrawer(s, device, 0);
    const { sale, lines } = await billBy(s, s.cashier, [[1000, 1]]);
    const line = lines[0]!;
    const check = (saleLineId: string, payload: string) =>
      asMember(s, s.cashier, (c) =>
        c.checkBillLinePack({ branchId: s.owner.branchId, saleId: sale.id, saleLineId, payload })
      );
    const gtin = '01234567890128';
    const presentationId = await tenant(s.owner, async (db) => {
      const p = await db.packLevel.findUniqueOrThrow({ where: { id: line.packLevelId } });
      await db.medicineBarcode.create({
        data: {
          organizationId: s.owner.organizationId,
          presentationId: p.presentationId,
          packLevelId: p.id,
          type: 'GTIN',
          code: gtin,
          normalizedCode: gtin,
        },
      });
      return p.presentationId;
    });
    expect(await check(line.id, 'synthetic-unmatched-pack')).toMatchObject({ matched: false });
    await removeLine(s, s.cashier, sale.id, line, device);
    const { line: next } = await tenant(s.as(s.cashier), (db) =>
      sales.addSaleLine(db, s.as(s.cashier), {
        saleId: sale.id,
        medicineId: line.medicineId,
        presentationId,
        packLevelId: line.packLevelId,
        saleUnit: 'UNIT',
        quantity: 1,
        canonicalUnitsPerSaleUnit: 1,
        idempotencyKey: randomUUID(),
      })
    );
    expect(next.packCheckBlocked).toBe(true);
    await expect(cash(s, s.cashier, device, sale.id, 1000)).rejects.toThrow(/pack.check/i);
    expect(await check(next.id, '(01)' + gtin + '(21)TEST-SERIAL')).toMatchObject({
      matched: true,
      batchChecked: false,
    });
    await cash(s, s.cashier, device, sale.id, 1000);
    expect(
      await tenant(s.owner, (db) =>
        db.pharmacySaleEvent.count({ where: { saleId: sale.id, kind: 'PACK_CHECK' } })
      )
    ).toBe(2);
  });

  it('shares one demand event between the two entry points per bill and medicine', async () => {
    const s = await shop('reviewdemand');
    const { sale, lines } = await billBy(s, s.cashier, [[500, 1]]);
    const input = {
      branchId: s.owner.branchId,
      saleId: sale.id,
      requestedMedicineId: lines[0]!.medicineId,
      requestedText: 'Synthetic request',
      quantity: 2,
      reason: 'STOCKOUT' as const,
    };
    const [asked, shortfall] = await Promise.all([
      asMember(s, s.cashier, (c) => c.recordCounterDemand({ ...input, requestId: randomUUID() })),
      asMember(s, s.cashier, (c) =>
        c.captureDemand({
          ...input,
          saleUnit: 'UNIT',
          inventoryRuleSnapshot: { query: 'Synthetic request' },
        })
      ),
    ]);
    expect(asked.id).toBe(shortfall.id);
    await expect(
      asMember(s, s.cashier, (c) =>
        c.recordCounterDemand({ ...input, requestId: randomUUID(), quantity: 10001 })
      )
    ).rejects.toThrow();
    expect(
      await tenant(s.owner, (db) =>
        db.unfulfilledDemandEvent.count({
          where: { saleId: sale.id, requestedMedicineId: lines[0]!.medicineId },
        })
      )
    ).toBe(1);
  });

  it.each([false, true])(
    'refuses a direct allocation discount on a paid bill (completed=%s)',
    async (completed) => {
      const s = await shop('reviewfreeze' + completed);
      const device = 'freeze';
      await openDrawer(s, device, 0);
      const { sale, lines } = await billBy(s, s.cashier, [[500, 1]]);
      await cash(s, s.cashier, device, sale.id, completed ? 500 : 100);
      const lineId = lines[0]!.id;
      const allocation = await tenant(s.owner, (db) =>
        db.pharmacySaleLineAllocation.findFirstOrThrow({ where: { saleLineId: lineId } })
      );
      await expect(
        tenant(s.owner, (db) =>
          db.pharmacySaleLine.update({
            where: { id: lineId },
            data: {
              lineAllocationDiscounts: { [allocation.id]: 10 },
              discountKind: 'DISCOUNT',
              discountMinor: 10,
              approvedByUserId: s.manager,
              approvalPolicy: 'DISCOUNT_MANAGER_PIN',
            },
          })
        )
      ).rejects.toThrow(/paid or closed/);
    }
  );
});
