/**
 * @vitest-environment node
 *
 * DEV-958B: cash shifts against a REAL migrated PostgreSQL, written as the restricted runtime role
 * with row-level security on (the suite first proves the role is neither SUPERUSER nor BYPASSRLS).
 * The unit suites mock the client and cannot see the database guards this phase relies on: the
 * attribution of every tender, refund and drawer movement to the drawer's one open shift, the
 * one-open-shift index, the closed-shift immutability guard, the day-close guard and the expected
 * cash re-check at the close.
 *
 * Requires TEST_DATABASE_URL (scripts/run-pharmacy-db-tests.sh sets it). Without it the suite
 * reports skipped.
 */
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
if (TEST_DATABASE_URL) process.env.DATABASE_URL = TEST_DATABASE_URL;

type ScopedDb = import('@/lib/tenancy/scoped-db').ScopedDb;
type Scope = { organizationId: string; branchId: string; actorId: string };

let withTenantDb: typeof import('@/lib/tenancy/scoped-db').withTenantDb;
let withPlatformDb: typeof import('@/lib/tenancy/scoped-db').withPlatformDb;
let settlement: typeof import('./settlement');
let shifts: typeof import('./cash-shifts');
let dayClose: typeof import('./day-close');
let sales: typeof import('./sales');
let ledger: typeof import('./stock-ledger');
let report: typeof import('./cash-shift-report');
let clock: typeof import('./business-day-clock');
let businessDay: typeof import('./business-day');
let regulatory: typeof import('@/lib/test-support/pharmacy-regulatory');

const describeDatabase = TEST_DATABASE_URL ? describe : describe.skip;
const run = randomUUID().slice(0, 8);
const ruleSetIds: string[] = [];
const MANAGER_PIN = '4826';

beforeAll(async () => {
  if (!TEST_DATABASE_URL) return;
  ({ withTenantDb, withPlatformDb } = await import('@/lib/tenancy/scoped-db'));
  settlement = await import('./settlement');
  shifts = await import('./cash-shifts');
  dayClose = await import('./day-close');
  sales = await import('./sales');
  ledger = await import('./stock-ledger');
  report = await import('./cash-shift-report');
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

/** A fresh organization and branch (shifts on or off), with a manager (PIN) and two cashiers. */
async function shop(label: string, options: { shifts: boolean; toleranceMinor?: number }) {
  const organizationId = `cshift_${label}_${run}`;
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
  const credentials = await import('@/lib/restaurant/operator-credentials');
  const { seedDepartments } = await import('@/lib/test-support/departments');
  const locationId = await tenant(as(manager), async (db) => {
    await db.pharmacyBranch.create({
      data: {
        id: branchId,
        organizationId,
        code: branchId,
        name: `Shift ${label}`,
        addressLine: 'Test',
        city: 'Test',
        provinceCode: 'PB',
        cashShiftsEnabled: options.shifts,
        cashShiftVarianceToleranceMinor: options.toleranceMinor ?? 0,
      },
    });
    await seedDepartments(db, [organizationId], ['LEADERSHIP']);
    for (const [id, grants] of [
      [manager, ['pharmacy:manage', 'pharmacy:counter']],
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
    const profile = await db.restaurantStaffProfile.create({
      data: { userId: manager, displayName: manager },
    });
    await db.restaurantOperatorCredential.create({
      data: {
        staffProfileId: profile.id,
        type: 'PIN',
        credentialHash: await credentials.hashOperatorCredential('PIN', MANAGER_PIN),
      },
    });
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
  return { owner: as(manager), as, manager, cashier, cashier2, locationId, today } satisfies Shop;
}

/** An open bill for one OTC unit at `priceMinor`, with its stock received first. */
async function bill(s: Shop, priceMinor: number, quantity = 1) {
  return tenant(s.owner, async (db) => {
    const org = s.owner.organizationId;
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
    const { lot } = await ledger.receiveLot(db, s.owner, {
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
      quantityUnits: quantity,
      idempotencyKey: randomUUID(),
      receivedAt: new Date('2020-01-01'),
    });
    const sale = await sales.createSale(db, s.owner);
    const { line } = await sales.addSaleLine(db, s.owner, {
      saleId: sale.id,
      medicineId: medicine.id,
      presentationId: presentation.id,
      packLevelId: pack.id,
      saleUnit: 'UNIT',
      quantity,
      canonicalUnitsPerSaleUnit: 1,
      idempotencyKey: randomUUID(),
    });
    return { sale, line, lot };
  });
}

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

const bank = (s: Shop, actor: string, device: string, saleId: string, amountMinor: number) =>
  tenant(s.as(actor), (db) =>
    settlement.applyPharmacyTender(db, s.as(actor), {
      saleId,
      deviceId: device,
      businessDate: s.today,
      type: 'BANK_TRANSFER',
      providerRef: `BANK-${randomUUID().slice(0, 6)}`,
      amountMinor,
      idempotencyKey: randomUUID(),
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

const closeShift = (
  s: Shop,
  actor: string,
  shiftId: string,
  countedCashMinor: number,
  extra: {
    varianceNote?: string;
    approval?: import('./cash-shifts').CashShiftVarianceApproval;
  } = {}
) =>
  tenant(s.as(actor), (db) =>
    shifts.closePharmacyCashShift(
      db,
      s.as(actor),
      { shiftId, countedCashMinor, varianceNote: extra.varianceNote },
      { actorIsManager: actor === s.manager, approval: extra.approval }
    )
  );

const openShift = (
  s: Shop,
  actor: string,
  drawerSessionId: string,
  openingFloatMinor: number,
  openingNote?: string
) =>
  tenant(s.as(actor), (db) =>
    shifts.openPharmacyCashShift(
      db,
      s.as(actor),
      { drawerSessionId, openingFloatMinor, openingNote },
      { actorIsManager: actor === s.manager }
    )
  );

describeDatabase('pharmacy cash shifts on migrated PostgreSQL', () => {
  it('leaves a branch without shifts exactly as before: no shift, no attribution, the same close', async () => {
    const s = await shop('single', { shifts: false });
    const device = `device-${randomUUID()}`;
    const drawer = await openDrawer(s, device, 10_000);
    expect(drawer.cashShifts).toBe(false);
    const a = await bill(s, 300);
    const b = await bill(s, 200);
    await cash(s, s.cashier, device, a.sale.id, 300);
    await bank(s, s.cashier, device, b.sale.id, 200);
    await tenant(s.owner, (db) =>
      settlement.recordPharmacyCashMovement(
        db,
        s.owner,
        {
          drawerSessionId: drawer.id,
          kind: 'PAID_OUT',
          amountMinor: 50,
          reason: 'Milk',
          requireCurrentBusinessDate: true,
        },
        { kind: 'COUNTER', actorIsManager: true }
      )
    );
    const rows = await tenant(s.owner, async (db) => ({
      shifts: await db.pharmacyCashShift.count({ where: { branchId: s.owner.branchId } }),
      tenders: await db.pharmacyTender.findMany({ where: { branchId: s.owner.branchId } }),
      movements: await db.pharmacyDrawerMovement.findMany({
        where: { drawerSessionId: drawer.id },
      }),
    }));
    expect(rows.shifts).toBe(0);
    expect(rows.tenders.map((t) => [t.shiftId, t.lateArrivalShiftId, t.soldAt])).toEqual([
      [null, null, null],
      [null, null, null],
    ]);
    expect(rows.movements.every((m) => m.shiftId === null && m.lateArrivalShiftId === null)).toBe(
      true
    );

    const preview = await tenant(s.owner, (db) => dayClose.readPharmacyClose(db, s.owner, s.today));
    // The preview carries no shift fields at all, and its drawer rows are what they were.
    expect('shifts' in preview).toBe(false);
    expect('lateArrivals' in preview).toBe(false);
    expect('shiftTotals' in preview).toBe(false);
    expect(Object.keys(preview.drawers[0]!).sort()).toEqual(
      [
        'countedMinor',
        'deviceId',
        'expectedMinor',
        'id',
        'openedAt',
        'openedBy',
        'operatingCashier',
        'otherOperatorMovements',
        'status',
      ].sort()
    );
    expect(preview.totals).toMatchObject({
      grossSalesMinor: 500,
      refundTotalMinor: 0,
      netSalesMinor: 500,
      cashExpectedMinor: 10_250,
    });
    const close = await tenant(s.owner, (db) =>
      dayClose.closePharmacyDay(db, s.owner, {
        businessDate: s.today,
        sourceHash: preview.totals.sourceHash,
        counts: [{ drawerSessionId: drawer.id, countedCashMinor: 10_250 }],
        varianceNote: '',
      })
    );
    expect(close).toMatchObject({
      grossSalesMinor: 500,
      cashExpectedMinor: 10_250,
      cashCountedMinor: 10_250,
      cashVarianceMinor: 0,
    });
  });

  it('refuses a paid-in on a drawer left open from an earlier business day', async () => {
    const s = await shop('stale', { shifts: false });
    const yesterday = new Date(s.today.getTime() - 86_400_000);
    const drawer = await tenant(s.owner, (db) =>
      settlement.openPharmacyDrawer(db, s.owner, {
        deviceId: `device-${randomUUID()}`,
        businessDate: yesterday,
        openingFloatMinor: 1_000,
      })
    );
    await expect(
      tenant(s.owner, (db) =>
        settlement.recordPharmacyCashMovement(
          db,
          s.owner,
          {
            drawerSessionId: drawer.id,
            kind: 'PAID_IN',
            amountMinor: 500,
            reason: 'Change',
            requireCurrentBusinessDate: true,
          },
          { kind: 'COUNTER', actorIsManager: true }
        )
      )
    ).rejects.toMatchObject({ reason: 'DRAWER_FROM_EARLIER_DAY' });
    const movements = await tenant(s.owner, (db) =>
      db.pharmacyDrawerMovement.count({ where: { drawerSessionId: drawer.id, kind: 'PAID_IN' } })
    );
    expect(movements).toBe(0);
  });

  it('runs shift close, then day close, and the day adds up to its shifts to the paisa', async () => {
    const s = await shop('flow', { shifts: true, toleranceMinor: 0 });
    const device = `device-${randomUUID()}`;
    const drawer = await openDrawer(s, device, 10_000);
    expect(drawer.cashShifts).toBe(true);
    const [first] = await shiftsOf(s, drawer.id);
    expect(first).toMatchObject({
      sequence: 1,
      status: 'OPEN',
      cashierId: s.cashier,
      openingFloatMinor: 10_000,
    });

    // Shift 1: a cash sale, a bank transfer, a cash refund after a return, a paid-in and a paid-out.
    const a = await bill(s, 300);
    const b = await bill(s, 200);
    const tenderA = await cash(s, s.cashier, device, a.sale.id, 300);
    await bank(s, s.cashier, device, b.sale.id, 200);
    await tenant(s.owner, (db) =>
      sales.returnSaleLine(db, s.owner, {
        saleLineId: a.line.id,
        lotId: a.lot.id,
        canonicalUnits: 1,
        disposition: 'RESTOCK',
        reason: 'Returned unopened',
        integrityDecision: 'Sealed',
        idempotencyKey: randomUUID(),
      })
    );
    await tenant(s.owner, (db) =>
      settlement.refundPharmacyTender(
        db,
        s.owner,
        {
          originalTenderId: (tenderA as { tenderId: string }).tenderId,
          deviceId: device,
          businessDate: s.today,
          amountMinor: 120,
          reason: 'Part refund',
          idempotencyKey: randomUUID(),
        },
        { drawerOperator: { kind: 'COUNTER', actorIsManager: true } }
      )
    );
    for (const [kind, amountMinor] of [
      ['PAID_IN', 500],
      ['PAID_OUT', 80],
    ] as const)
      await tenant(s.owner, (db) =>
        settlement.recordPharmacyCashMovement(
          db,
          s.owner,
          {
            drawerSessionId: drawer.id,
            kind,
            amountMinor,
            reason: kind,
            requireCurrentBusinessDate: true,
          },
          { kind: 'COUNTER', actorIsManager: true }
        )
      );
    const attributed = await tenant(s.owner, async (db) => ({
      tenders: await db.pharmacyTender.findMany({ where: { branchId: s.owner.branchId } }),
      refunds: await db.pharmacyRefund.findMany({ where: { branchId: s.owner.branchId } }),
      movements: await db.pharmacyDrawerMovement.findMany({
        where: { drawerSessionId: drawer.id },
      }),
    }));
    for (const row of [...attributed.tenders, ...attributed.refunds, ...attributed.movements])
      expect(row.shiftId).toBe(first!.id);

    // Expected: 10,000 float + 300 cash sale + 500 in - 120 refund - 80 out = 10,600.
    const sofar = await tenant(s.as(s.cashier), (db) =>
      shifts.readPharmacyCashShiftReport(db, s.as(s.cashier), first!.id, { actorIsManager: false })
    );
    expect(sofar.cash).toEqual({
      openingFloatMinor: 10_000,
      cashSalesMinor: 300,
      cashRefundsMinor: 120,
      paidInMinor: 500,
      paidOutMinor: 80,
      expectedMinor: 10_600,
    });
    expect(sofar.tenders).toEqual([
      { type: 'BANK_TRANSFER', count: 1, amountMinor: 200 },
      { type: 'CASH', count: 1, amountMinor: 300 },
    ]);

    // Another cashier may not close this shift; a short needs a note, then a manager's approval.
    await expect(closeShift(s, s.cashier2, first!.id, 10_550)).rejects.toMatchObject({
      reason: 'DRAWER_NOT_YOURS',
    });
    await expect(closeShift(s, s.cashier, first!.id, 10_550)).rejects.toMatchObject({
      reason: 'SHIFT_NOTE_REQUIRED',
    });
    await expect(
      closeShift(s, s.cashier, first!.id, 10_550, { varianceNote: 'Fifty short' })
    ).rejects.toMatchObject({ reason: 'SHIFT_APPROVAL_REQUIRED' });
    // The shared approval path: a wrong PIN is refused and strikes the manager's credential.
    await expect(
      tenant(s.as(s.cashier), (db) =>
        shifts.authorizeCashShiftVariance(db, s.as(s.cashier), {
          approverId: s.manager,
          pin: '0000',
        })
      )
    ).rejects.toMatchObject({ reason: 'SHIFT_APPROVAL_REQUIRED' });
    const strikes = await tenant(s.owner, (db) =>
      db.restaurantOperatorCredential.findFirstOrThrow({
        where: { staffProfile: { userId: s.manager } },
        select: { failedAttempts: true },
      })
    );
    expect(strikes.failedAttempts).toBe(1);
    // A cashier is no approver, even of their own close.
    await expect(
      tenant(s.as(s.cashier), (db) =>
        shifts.authorizeCashShiftVariance(db, s.as(s.cashier), {
          approverId: s.cashier,
          pin: MANAGER_PIN,
        })
      )
    ).rejects.toMatchObject({ reason: 'SHIFT_APPROVAL_REQUIRED' });
    const approval = await tenant(s.as(s.cashier), (db) =>
      shifts.authorizeCashShiftVariance(db, s.as(s.cashier), {
        approverId: s.manager,
        pin: MANAGER_PIN,
      })
    );
    expect(approval).toMatchObject({ approverId: s.manager, selfApproved: false });
    const closed1 = await closeShift(s, s.cashier, first!.id, 10_550, {
      varianceNote: 'Fifty short',
      approval,
    });
    expect(closed1.report).toMatchObject({
      countedMinor: 10_550,
      varianceMinor: -50,
      varianceNote: 'Fifty short',
      varianceApprovedBy: { id: s.manager },
      cashier: { id: s.cashier },
      closedBy: { id: s.cashier },
    });
    // A replay returns the same close; another count is refused.
    const replay = await closeShift(s, s.cashier, first!.id, 10_550);
    expect(replay.replayed).toBe(true);
    expect(replay.report).toEqual(closed1.report);
    await expect(closeShift(s, s.cashier, first!.id, 10_551)).rejects.toMatchObject({
      reason: 'SHIFT_ALREADY_CLOSED',
    });

    // A closed shift never changes, even written directly as the runtime role.
    await expect(
      tenant(s.owner, (db) =>
        db.pharmacyCashShift.update({
          where: { organizationId_id: { organizationId: s.owner.organizationId, id: first!.id } },
          data: { varianceNote: 'Edited later' },
        })
      )
    ).rejects.toThrow(/PHARMACY_SHIFT_IMMUTABLE/);
    await expect(
      tenant(s.owner, (db) =>
        db.pharmacyCashShift.delete({
          where: { organizationId_id: { organizationId: s.owner.organizationId, id: first!.id } },
        })
      )
    ).rejects.toThrow(/PHARMACY_SHIFT_IMMUTABLE/);

    // Between shifts no money moves on this counter, cash or not.
    const c = await bill(s, 400);
    await expect(cash(s, s.cashier, device, c.sale.id, 400)).rejects.toMatchObject({
      reason: 'SHIFT_NOT_OPEN',
    });
    await expect(bank(s, s.cashier2, device, c.sale.id, 400)).rejects.toMatchObject({
      reason: 'SHIFT_NOT_OPEN',
    });

    // Shift 2: the next cashier counts 20 more than was left; the handover difference needs a note.
    await expect(openShift(s, s.cashier2, drawer.id, 10_570)).rejects.toMatchObject({
      reason: 'SHIFT_NOTE_REQUIRED',
    });
    const second = await openShift(s, s.cashier2, drawer.id, 10_570, 'Found 20 in the tray');
    expect(second.shift).toMatchObject({
      sequence: 2,
      cashierId: s.cashier2,
      openingDifferenceMinor: 20,
    });
    // Replaying the open answers with the same shift; one open shift per drawer.
    const reopened = await openShift(s, s.cashier2, drawer.id, 10_570, 'Found 20 in the tray');
    expect(reopened).toMatchObject({ replayed: true, shift: { id: second.shift.id } });
    await expect(openShift(s, s.manager, drawer.id, 1)).rejects.toMatchObject({
      reason: 'SHIFT_ALREADY_OPEN',
    });
    await expect(
      tenant(s.owner, (db) =>
        db.pharmacyCashShift.create({
          data: {
            organizationId: s.owner.organizationId,
            branchId: s.owner.branchId,
            drawerSessionId: drawer.id,
            deviceId: device,
            businessDate: s.today,
            sequence: 3,
            cashierId: s.manager,
            openedByActorId: s.manager,
            openingFloatMinor: 0,
          },
        })
      )
    ).rejects.toThrow();
    await cash(s, s.cashier2, device, c.sale.id, 400);

    // The day close refuses, plainly, while a shift is open, and so does the database.
    const open = await tenant(s.owner, (db) => dayClose.readPharmacyClose(db, s.owner, s.today));
    await expect(
      tenant(s.owner, (db) =>
        dayClose.closePharmacyDay(db, s.owner, {
          businessDate: s.today,
          sourceHash: open.totals.sourceHash,
          counts: [{ drawerSessionId: drawer.id, countedCashMinor: 10_970 }],
          varianceNote: 'x',
        })
      )
    ).rejects.toMatchObject({ reason: 'SHIFT_OPEN' });
    await expect(
      tenant(s.owner, (db) =>
        settlement.closePharmacyDrawer(db, s.owner, {
          drawerSessionId: drawer.id,
          countedCashMinor: 10_970,
        })
      )
    ).rejects.toMatchObject({ reason: 'SHIFT_OPEN' });
    await expect(
      tenant(s.owner, (db) =>
        db.pharmacyDailyClose.create({
          data: {
            organizationId: s.owner.organizationId,
            branchId: s.owner.branchId,
            businessDate: s.today,
            sequence: 1,
            grossSalesMinor: 0,
            refundTotalMinor: 0,
            netSalesMinor: 0,
            cashExpectedMinor: 0,
            cashCountedMinor: 0,
            cashVarianceMinor: 0,
            sourceHash: 'x'.repeat(64),
            actorId: s.manager,
          },
        })
      )
    ).rejects.toThrow(/PHARMACY_SHIFT_OPEN/);

    // The manager closes the second cashier's shift (the explicit, audited manager step).
    const closed2 = await closeShift(s, s.manager, second.shift.id, 10_970);
    expect(closed2.report).toMatchObject({ varianceMinor: 0, closedBy: { id: s.manager } });
    const audits = await tenant(s.owner, (db) =>
      db.auditLog.findMany({
        where: { targetType: 'PharmacyCashShift', targetId: { in: [first!.id, second.shift.id] } },
        select: { action: true, targetId: true, metadata: true },
        orderBy: { createdAt: 'asc' },
      })
    );
    expect(audits.map((row) => row.action)).toEqual([
      'pharmacy.cashShift.open',
      'pharmacy.cashShift.close',
      'pharmacy.cashShift.open',
      'pharmacy.cashShift.close',
    ]);
    expect(audits[3]!.metadata).toMatchObject({ closedByManagerStep: true });

    // A drawer that runs shifts closes on its last shift's count, never another.
    const preview = await tenant(s.owner, (db) => dayClose.readPharmacyClose(db, s.owner, s.today));
    await expect(
      tenant(s.owner, (db) =>
        dayClose.closePharmacyDay(db, s.owner, {
          businessDate: s.today,
          sourceHash: preview.totals.sourceHash,
          counts: [{ drawerSessionId: drawer.id, countedCashMinor: 10_900 }],
          varianceNote: 'x',
        })
      )
    ).rejects.toMatchObject({ reason: 'SHIFT_COUNT_MISMATCH' });
    const close = await tenant(s.owner, (db) =>
      dayClose.closePharmacyDay(db, s.owner, {
        businessDate: s.today,
        sourceHash: preview.totals.sourceHash,
        counts: [{ drawerSessionId: drawer.id, countedCashMinor: 10_970 }],
        varianceNote: 'Shift 1 fifty short; twenty found at handover',
      })
    );

    // The day equals the sum of its shifts, to the paisa.
    expect(preview.shifts!.map((shift) => shift.sequence)).toEqual([1, 2]);
    expect(preview.shiftTotals!.openShifts).toBe(0);
    expect(close.cashVarianceMinor).toBe(preview.shiftTotals!.cashVarianceMinor);
    expect(close.cashVarianceMinor).toBe(-50 + 20);
    expect(close.cashCountedMinor).toBe(10_970);
    // The Z report's tender lines, type by type, are the shifts' tenders and refunds added up.
    const dayTenders = close.tenderTotals as {
      type: string;
      amountMinor: number;
      refundMinor: number;
    }[];
    const refundsOf = (type: string) =>
      preview.shiftTotals!.refunds.find((t) => t.type === type)?.amountMinor ?? 0;
    expect(dayTenders.map((row) => [row.type, row.amountMinor, row.refundMinor])).toEqual(
      preview.shiftTotals!.tenders.map((t) => [t.type, t.amountMinor, refundsOf(t.type)])
    );
    expect(preview.shiftTotals!.tenders.reduce((n, t) => n + t.amountMinor, 0)).toBe(900);
    expect(preview.shiftTotals!.refunds.reduce((n, t) => n + t.amountMinor, 0)).toBe(
      close.refundTotalMinor
    );
  });

  it('loses or doubles nothing when sales race a shift close', async () => {
    const s = await shop('race', { shifts: true, toleranceMinor: 1_000_000 });
    const device = `device-${randomUUID()}`;
    const drawer = await openDrawer(s, device, 0);
    const [first] = await shiftsOf(s, drawer.id);
    const bills = await Promise.all(Array.from({ length: 8 }, (_, i) => bill(s, 100 + i)));
    // Four sales start; once the first has committed, the close starts while the other three and
    // four more sales are still in flight.
    const early = bills.slice(0, 4).map((b, i) => cash(s, s.cashier, device, b.sale.id, 100 + i));
    await early[0];
    const outcomes = await Promise.allSettled([
      ...early,
      closeShift(s, s.cashier, first!.id, 0, { varianceNote: 'Counted during sales' }),
      ...bills.slice(4).map((b, i) => cash(s, s.cashier, device, b.sale.id, 104 + i)),
    ]);
    const close = outcomes[4]!;
    expect(close.status).toBe('fulfilled');
    const closed = (close as PromiseFulfilledResult<Awaited<ReturnType<typeof closeShift>>>).value;
    const refused = outcomes.filter((o, i) => i !== 4 && o.status === 'rejected');
    for (const outcome of refused)
      expect((outcome as PromiseRejectedResult).reason).toMatchObject({ reason: 'SHIFT_NOT_OPEN' });

    // Every committed sale is in exactly the closed shift, and the frozen report counts them all.
    const tenders = await tenant(s.owner, (db) =>
      db.pharmacyTender.findMany({ where: { branchId: s.owner.branchId } })
    );
    expect(tenders.every((t) => t.shiftId === first!.id)).toBe(true);
    const taken = tenders.reduce((n, t) => n + t.amountMinor, 0);
    expect(closed.report.cash.cashSalesMinor).toBe(taken);
    expect(closed.report.tenderTotalMinor).toBe(taken);
    expect(taken).toBeGreaterThan(0);
    expect(closed.report.varianceMinor).toBe(0 - taken);

    // The refused sales go through in the next shift; nothing is in both or in neither.
    const second = await openShift(s, s.cashier2, drawer.id, 0);
    const paid = new Set(tenders.map((t) => t.saleId));
    for (const [i, b] of bills.entries())
      if (!paid.has(b.sale.id)) await cash(s, s.cashier2, device, b.sale.id, 100 + i);
    const all = await tenant(s.owner, (db) =>
      db.pharmacyTender.findMany({ where: { branchId: s.owner.branchId } })
    );
    expect(all).toHaveLength(8);
    expect(new Set(all.map((t) => t.saleId)).size).toBe(8);
    expect(all.every((t) => t.shiftId === first!.id || t.shiftId === second.shift.id)).toBe(true);
    const inShift = (id: string) =>
      all.filter((t) => t.shiftId === id).reduce((n, t) => n + t.amountMinor, 0);
    expect(inShift(first!.id) + inShift(second.shift.id)).toBe(
      bills.reduce((n, _b, i) => n + 100 + i, 0)
    );
  });

  it("puts an offline sale in the shift it was sold in, or on the day's close once that shift has closed", async () => {
    const s = await shop('offline', { shifts: true, toleranceMinor: 1_000_000 });
    const device = `device-${randomUUID()}`;
    const drawer = await openDrawer(s, device, 0);
    const [first] = await shiftsOf(s, drawer.id);
    // Writes a replayed offline cash sale the way applyPharmacyTender does: the tender carries
    // the signed sale time, and its cash movement the attribution the database gave the tender.
    const replay = (saleId: string, amountMinor: number, soldAt: Date) =>
      tenant(s.as(s.cashier), async (db) => {
        const tender = await db.pharmacyTender.create({
          data: {
            organizationId: s.owner.organizationId,
            branchId: s.owner.branchId,
            saleId,
            type: 'CASH',
            amountMinor,
            cashReceivedMinor: amountMinor,
            changeGivenMinor: 0,
            drawerSessionId: drawer.id,
            businessDate: s.today,
            actorId: s.cashier,
            deviceId: device,
            soldAt,
          },
        });
        await db.pharmacyDrawerMovement.create({
          data: {
            organizationId: s.owner.organizationId,
            drawerSessionId: drawer.id,
            kind: 'CASH_SALE',
            amountMinor,
            actorId: s.cashier,
            ...(tender.shiftId ? { shiftId: tender.shiftId } : {}),
            ...(tender.lateArrivalShiftId ? { lateArrivalShiftId: tender.lateArrivalShiftId } : {}),
          },
        });
        return tender;
      });
    const soldInShift1 = new Date(first!.openedAt.getTime() + 1);
    const early = await bill(s, 150);
    const whileOpen = await replay(early.sale.id, 150, soldInShift1);
    expect(whileOpen).toMatchObject({ shiftId: first!.id, lateArrivalShiftId: null });

    await closeShift(s, s.cashier, first!.id, 250, { varianceNote: 'Offline sale counted' });
    const second = await openShift(s, s.cashier2, drawer.id, 250);
    const late = await bill(s, 100);
    const afterClose = await replay(late.sale.id, 100, soldInShift1);
    // Sold in shift 1, replayed after it closed: a late arrival on shift 1, never in shift 2.
    expect(afterClose).toMatchObject({ shiftId: null, lateArrivalShiftId: first!.id });
    // A movement cannot claim the open shift for a sale the database put on a closed one.
    const forged = await bill(s, 10);
    await expect(
      tenant(s.as(s.cashier), (db) =>
        db.pharmacyDrawerMovement.create({
          data: {
            organizationId: s.owner.organizationId,
            drawerSessionId: drawer.id,
            kind: 'CASH_SALE',
            amountMinor: 10,
            actorId: s.cashier,
            lateArrivalShiftId: second.shift.id,
          },
        })
      )
    ).rejects.toThrow(/PHARMACY_SHIFT_ATTRIBUTION_INVALID/);
    void forged;
    const frozen = await tenant(s.owner, (db) =>
      db.pharmacyCashShift.findFirstOrThrow({ where: { id: first!.id } })
    );
    expect(frozen.expectedCashMinor).toBe(150);

    await closeShift(s, s.cashier2, second.shift.id, 250);
    const preview = await tenant(s.owner, (db) => dayClose.readPharmacyClose(db, s.owner, s.today));
    expect(preview.lateArrivals).toMatchObject({ cashNetMinor: 100, salesCount: 1 });
    // The day's cash variance is the shifts' (shift 1 counted the late sale: +100) less the late
    // arrival the closed shift never expected.
    expect(preview.shiftTotals!.cashVarianceMinor).toBe(100 + 0 - 100);
    const close = await tenant(s.owner, (db) =>
      dayClose.closePharmacyDay(db, s.owner, {
        businessDate: s.today,
        sourceHash: preview.totals.sourceHash,
        counts: [{ drawerSessionId: drawer.id, countedCashMinor: 250 }],
        varianceNote: '',
      })
    );
    expect(close.cashVarianceMinor).toBe(preview.shiftTotals!.cashVarianceMinor);
    expect(report.sumCashShifts).toBeTypeOf('function');
  });

  it("refuses another branch's and another organization's shifts", async () => {
    const s = await shop('scope', { shifts: true });
    const other = await shop('scope2', { shifts: true });
    const drawer = await openDrawer(s, `device-${randomUUID()}`, 0);
    const [first] = await shiftsOf(s, drawer.id);
    // Another organization does not see the shift at all (row-level security).
    const seen = await tenant(other.owner, (db) =>
      db.pharmacyCashShift.count({ where: { id: first!.id } })
    );
    expect(seen).toBe(0);
    // Named under another branch of the same organization, it is not found.
    await expect(
      tenant({ ...s.owner, branchId: other.owner.branchId }, (db) =>
        shifts.closePharmacyCashShift(
          db,
          { ...s.owner, branchId: other.owner.branchId },
          { shiftId: first!.id, countedCashMinor: 0 },
          { actorIsManager: true }
        )
      )
    ).rejects.toMatchObject({ reason: 'SHIFT_NOT_FOUND' });
    await expect(
      tenant(other.owner, (db) =>
        shifts.closePharmacyCashShift(
          db,
          other.owner,
          { shiftId: first!.id, countedCashMinor: 0 },
          { actorIsManager: true }
        )
      )
    ).rejects.toMatchObject({ reason: 'SHIFT_NOT_FOUND' });
  });
});
