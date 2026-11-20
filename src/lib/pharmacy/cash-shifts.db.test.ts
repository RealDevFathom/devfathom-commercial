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

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
if (TEST_DATABASE_URL) process.env.DATABASE_URL = TEST_DATABASE_URL;

// The router is called as a signed-in member would call it; only the web identity boundary and the
// audit row write are stubbed, as in pharmacy-sales.drawer-close.db.test.ts.
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
let sales: typeof import('./sales');
let ledger: typeof import('./stock-ledger');
let report: typeof import('./cash-shift-report');
let clock: typeof import('./business-day-clock');
let businessDay: typeof import('./business-day');
let regulatory: typeof import('@/lib/test-support/pharmacy-regulatory');
let devices: typeof import('./offline-devices');
let leases: typeof import('./offline-receipt-leases');

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
  devices = await import('./offline-devices');
  leases = await import('./offline-receipt-leases');
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

const dayClock = (s: Shop) => tenant(s.owner, (db) => clock.readPharmacyDayClock(db, s.owner));

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

/** Another member of the shop's organization, assigned to `branchId` (the shop's by default). */
async function addMember(
  s: Shop,
  id: string,
  grants: readonly string[],
  options: { pin?: string; branchId?: string } = {}
) {
  const credentials = await import('@/lib/restaurant/operator-credentials');
  await tenant(s.owner, async (db) => {
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
    await db.pharmacyBranchAssignment.create({
      data: { userId: id, branchId: options.branchId ?? s.owner.branchId, active: true },
    });
    if (options.pin) {
      const profile = await db.restaurantStaffProfile.create({
        data: { userId: id, displayName: id },
      });
      await db.restaurantOperatorCredential.create({
        data: {
          staffProfileId: profile.id,
          type: 'PIN',
          credentialHash: await credentials.hashOperatorCredential('PIN', options.pin),
        },
      });
    }
  });
  return id;
}

/** The pharmacy sales procedures as `userId` calls them, in one request's tenant transaction. */
async function asMember<T>(
  s: Shop,
  userId: string,
  run: (
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
      run(
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
    // The shared approval path: a wrong PIN is refused. The cashier typed it, so it does not strike
    // the manager's own credential (which their refunds also use); it spends the approver's budget.
    await expect(
      tenant(s.as(s.cashier), (db) =>
        shifts.authorizeCashShiftVariance(db, s.as(s.cashier), {
          shiftId: first!.id,
          approverId: s.manager,
          pin: '0000',
        })
      )
    ).rejects.toMatchObject({ reason: 'SHIFT_APPROVAL_REFUSED' });
    const strikes = await tenant(s.owner, (db) =>
      db.restaurantOperatorCredential.findFirstOrThrow({
        where: { staffProfile: { userId: s.manager } },
        select: { failedAttempts: true },
      })
    );
    expect(strikes.failedAttempts).toBe(0);
    // A cashier never approves their own shift while someone else can; another cashier never can.
    await expect(
      tenant(s.as(s.cashier), (db) =>
        shifts.authorizeCashShiftVariance(db, s.as(s.cashier), {
          shiftId: first!.id,
          approverId: s.cashier,
          pin: MANAGER_PIN,
        })
      )
    ).rejects.toMatchObject({ reason: 'SHIFT_APPROVAL_NEEDS_ANOTHER' });
    await expect(
      tenant(s.as(s.cashier), (db) =>
        shifts.authorizeCashShiftVariance(db, s.as(s.cashier), {
          shiftId: first!.id,
          approverId: s.cashier2,
          pin: MANAGER_PIN,
        })
      )
    ).rejects.toMatchObject({ reason: 'SHIFT_APPROVAL_NOT_ELIGIBLE' });
    const approval = await tenant(s.as(s.cashier), (db) =>
      shifts.authorizeCashShiftVariance(db, s.as(s.cashier), {
        shiftId: first!.id,
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
    // An enrolled counter with a receipt-number lease, issued before its drawer and first shift.
    const { device: counter, lease } = await tenant(s.owner, async (db) => {
      const { device } = await devices.enrollPharmacyCounter(db, s.owner, { name: 'Counter 1' });
      const block = await leases.reserveReceiptNumberBlock(db, s.owner, {
        deviceId: device.id,
        size: 10,
      });
      return { device, lease: block };
    });
    const device = counter.id;
    const drawer = await openDrawer(s, device, 0);
    const [first] = await shiftsOf(s, drawer.id);
    // Writes a replayed offline cash sale the way applyPharmacyTender does: the transaction consumes
    // the counter's leased receipt number, the tender carries the signed sale time, and its cash
    // movement the attribution the database gave the tender.
    const replay = (saleId: string, amountMinor: number, soldAt: Date) =>
      tenant(s.as(s.cashier), async (db) => {
        await db.$executeRaw`UPDATE pharmacy_receipt_number_leases SET "nextNumber" = "nextNumber" + 1
          WHERE id = ${lease.id} AND "organizationId" = ${s.owner.organizationId}`;
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

    // Nothing else lands on a closed shift, whatever is written by hand as the runtime role.
    const forged = await bill(s, 10);
    const movement = (data: Record<string, unknown>) =>
      tenant(s.as(s.cashier), (db) =>
        db.pharmacyDrawerMovement.create({
          data: {
            organizationId: s.owner.organizationId,
            drawerSessionId: drawer.id,
            actorId: s.cashier,
            amountMinor: 10,
            ...data,
          } as never,
        })
      );
    const refusal = /PHARMACY_SHIFT_ATTRIBUTION_INVALID/;
    // A paid-out, or any cash, named onto the closed shift as a late arrival.
    await expect(
      movement({ kind: 'PAID_OUT', reason: 'Hidden', lateArrivalShiftId: first!.id })
    ).rejects.toThrow(refusal);
    await expect(movement({ kind: 'CASH_SALE', lateArrivalShiftId: first!.id })).rejects.toThrow(
      refusal
    );
    // Or named into the closed shift directly, or a late arrival on the open one.
    await expect(movement({ kind: 'PAID_OUT', reason: 'x', shiftId: first!.id })).rejects.toThrow(
      refusal
    );
    await expect(
      movement({ kind: 'CASH_SALE', lateArrivalShiftId: second.shift.id })
    ).rejects.toThrow(refusal);
    // A tender that names its shift, or carries a sale time with no offline replay behind it.
    const tender = (data: Record<string, unknown>) =>
      tenant(s.as(s.cashier), (db) =>
        db.pharmacyTender.create({
          data: {
            organizationId: s.owner.organizationId,
            branchId: s.owner.branchId,
            saleId: forged.sale.id,
            type: 'CASH',
            amountMinor: 10,
            cashReceivedMinor: 10,
            changeGivenMinor: 0,
            drawerSessionId: drawer.id,
            businessDate: s.today,
            actorId: s.cashier,
            deviceId: device,
            ...data,
          } as never,
        })
      );
    await expect(tender({ lateArrivalShiftId: first!.id })).rejects.toThrow(refusal);
    await expect(tender({ shiftId: first!.id })).rejects.toThrow(refusal);
    await expect(tender({ soldAt: soldInShift1 })).rejects.toThrow(refusal);
    // Nothing of the forgeries was written; the closed shift and its late arrival are as they were.
    const onShift1 = await tenant(s.owner, (db) =>
      db.pharmacyDrawerMovement.findMany({
        where: { OR: [{ shiftId: first!.id }, { lateArrivalShiftId: first!.id }] },
        select: { kind: true, amountMinor: true, shiftId: true },
        orderBy: { createdAt: 'asc' },
      })
    );
    expect(onShift1.map((m) => [m.kind, m.amountMinor, m.shiftId === first!.id])).toEqual([
      ['CASH_SALE', 150, true],
      ['CASH_SALE', 100, false],
    ]);
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

  it('asks no card provider or terminal to charge between shifts', async () => {
    const s = await shop('provider', { shifts: true, toleranceMinor: 1_000_000 });
    const device = `device-${randomUUID()}`;
    const drawer = await openDrawer(s, device, 0);
    const [first] = await shiftsOf(s, drawer.id);
    const execute = vi.fn(async () => ({ approved: true, providerRef: `ref-${randomUUID()}` }));
    const adapter = { name: 'QA_TERMINAL', certified: true, execute };
    const charge = (saleId: string, amountMinor: number) =>
      tenant(s.as(s.cashier), (db) =>
        settlement.applyPharmacyTender(db, s.as(s.cashier), {
          saleId,
          deviceId: device,
          businessDate: s.today,
          type: 'CARD',
          amountMinor,
          idempotencyKey: randomUUID(),
          adapter,
        })
      );
    const a = await bill(s, 300);
    await charge(a.sale.id, 300);
    expect(execute).toHaveBeenCalledTimes(1);

    await closeShift(s, s.cashier, first!.id, 0);
    const b = await bill(s, 200);
    // Between shifts: refused before the provider is asked to move any money.
    await expect(charge(b.sale.id, 200)).rejects.toMatchObject({ reason: 'SHIFT_NOT_OPEN' });
    expect(execute).toHaveBeenCalledTimes(1);
    // The card-terminal preflight stops at the same point, and so before a terminal is sent a charge.
    const { preflightTerminalCharge } = await import('./card-terminal/store');
    await expect(
      tenant(s.as(s.cashier), (db) =>
        preflightTerminalCharge(db, s.as(s.cashier), {
          saleId: b.sale.id,
          deviceId: device,
          businessDate: s.today,
          amountMinor: 200,
          attemptKey: randomUUID(),
          provider: 'QA_TERMINAL',
          terminalId: 'counter-1',
          currency: 'PKR',
        })
      )
    ).rejects.toMatchObject({ reason: 'SHIFT_NOT_OPEN' });
    // Another organization's check is refused outright.
    await expect(
      tenant(s.as(s.cashier), (db) =>
        settlement.requireCashShiftForProvider(
          db,
          { organizationId: 'another-org', branchId: s.owner.branchId },
          { deviceId: device, businessDate: s.today }
        )
      )
    ).rejects.toThrow(/another organization/);

    // The database refuses the terminal attempt itself between shifts, whatever wrote it.
    const attempt = (saleId: string) =>
      tenant(s.as(s.cashier), (db) =>
        db.pharmacyCardTerminalAttempt.create({
          data: {
            organizationId: s.owner.organizationId,
            branchId: s.owner.branchId,
            saleId,
            deviceId: device,
            terminalId: 'counter-1',
            provider: 'QA_TERMINAL',
            attemptKey: randomUUID(),
            amountMinor: 200,
            currency: 'PKR',
            businessDate: s.today,
            actorId: s.cashier,
          },
        })
      );
    await expect(attempt(b.sale.id)).rejects.toThrow(/PHARMACY_SHIFT_NOT_OPEN/);

    const second = await openShift(s, s.cashier2, drawer.id, 0);
    // With a shift open the attempt is written, and the shift cannot close under it.
    const open = await attempt(b.sale.id);
    await expect(closeShift(s, s.cashier2, second.shift.id, 0)).rejects.toMatchObject({
      reason: 'CARD_TERMINAL_PAYMENT_OPEN',
    });
    await tenant(s.owner, (db) =>
      db.pharmacyCardTerminalAttempt.update({
        where: { id: open.id },
        data: { status: 'ABANDONED' },
      })
    );
    await charge(b.sale.id, 200);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('leaves provider charges on a branch without shifts as before', async () => {
    const s = await shop('provider_single', { shifts: false });
    const execute = vi.fn(async () => ({ approved: true, providerRef: `ref-${randomUUID()}` }));
    const a = await bill(s, 300);
    // No drawer open on this counter at all, as a card payment never needed one.
    await tenant(s.as(s.cashier), (db) =>
      settlement.applyPharmacyTender(db, s.as(s.cashier), {
        saleId: a.sale.id,
        deviceId: `device-${randomUUID()}`,
        businessDate: s.today,
        type: 'CARD',
        amountMinor: 300,
        idempotencyKey: randomUUID(),
        adapter: { name: 'QA_TERMINAL', certified: true, execute },
      })
    );
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("lets a Manager without the counter grant close a cashier's shift, read every report and close the day", async () => {
    const s = await shop('manager', { shifts: true, toleranceMinor: 1_000_000 });
    // The ready-made Manager role holds the manage grant, not the counter grant.
    const manager = await addMember(s, `${s.owner.organizationId}_mgr_only`, ['pharmacy:manage']);
    const elsewhere = `${s.owner.organizationId}_elsewhere`;
    await tenant(s.owner, (db) =>
      db.pharmacyBranch.create({
        data: {
          id: elsewhere,
          organizationId: s.owner.organizationId,
          code: elsewhere,
          name: 'Elsewhere',
          addressLine: 'Test',
          city: 'Test',
          provinceCode: 'PB',
          cashShiftsEnabled: true,
        },
      })
    );
    const device = `device-${randomUUID()}`;
    const drawer = await openDrawer(s, device, 10_000);
    const [first] = await shiftsOf(s, drawer.id);
    const a = await bill(s, 300);
    await cash(s, s.cashier, device, a.sale.id, 300);

    // Another cashier, holding only the counter grant, still reaches only their own shift.
    await expect(
      asMember(s, s.cashier2, (api) =>
        api.shiftReport({ branchId: s.owner.branchId, shiftId: first!.id })
      )
    ).rejects.toMatchObject({ code: 'FORBIDDEN', message: 'DRAWER_NOT_YOURS' });

    const sofar = await asMember(s, manager, (api) =>
      api.shiftReport({ branchId: s.owner.branchId, shiftId: first!.id })
    );
    expect(sofar.report).toMatchObject({ status: 'OPEN', cash: { expectedMinor: 10_300 } });
    // Not at a branch they are not assigned to.
    await expect(
      asMember(s, manager, (api) => api.shiftReport({ branchId: elsewhere, shiftId: first!.id }))
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      asMember(s, manager, (api) =>
        api.closeShift({ branchId: elsewhere, shiftId: first!.id, countedCashMinor: 10_300 })
      )
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    const closed = await asMember(s, manager, (api) =>
      api.closeShift({ branchId: s.owner.branchId, shiftId: first!.id, countedCashMinor: 10_300 })
    );
    expect(closed).toMatchObject({
      varianceMinor: 0,
      closedBy: { id: manager },
      cashier: { id: s.cashier },
    });
    const frozen = await asMember(s, manager, (api) =>
      api.shiftReport({ branchId: s.owner.branchId, shiftId: first!.id })
    );
    expect(frozen.report).toMatchObject({ status: 'CLOSED', countedMinor: 10_300 });

    const businessDate = s.today;
    await expect(
      asMember(s, manager, (api) => api.closePreview({ branchId: elsewhere, businessDate }))
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const preview = await asMember(s, manager, (api) =>
      api.closePreview({ branchId: s.owner.branchId, businessDate })
    );
    expect(preview!.shifts!.map((shift) => [shift.sequence, shift.status])).toEqual([
      [1, 'CLOSED'],
    ]);
    const close = await asMember(s, manager, (api) =>
      api.closeDay({
        branchId: s.owner.branchId,
        businessDate,
        sourceHash: preview!.totals.sourceHash,
        counts: [{ drawerSessionId: drawer.id, countedCashMinor: 10_300 }],
        varianceNote: '',
      })
    );
    expect(close).toMatchObject({
      cashCountedMinor: 10_300,
      cashVarianceMinor: 0,
      actorId: manager,
    });
  });

  it('needs a second person for an over or short, and says plainly when an approval is refused', async () => {
    const s = await shop('approvals', { shifts: true, toleranceMinor: 0 });
    const shiftOf = async (cashierId: string) => {
      const drawer = await tenant(s.owner, (db) =>
        settlement.openPharmacyDrawer(db, s.owner, {
          deviceId: `device-${randomUUID()}`,
          businessDate: s.today,
          openingFloatMinor: 1_000,
          operatingCashierId: cashierId,
        })
      );
      return (await shiftsOf(s, drawer.id))[0]!;
    };
    const authorize = (shiftId: string, approverId: string, pin: string, actor = s.manager) =>
      tenant(s.as(actor), (db) =>
        shifts.authorizeCashShiftVariance(db, s.as(actor), { shiftId, approverId, pin })
      );
    const credentialOf = (userId: string) =>
      tenant(s.owner, (db) =>
        db.restaurantOperatorCredential.findFirstOrThrow({
          where: { staffProfile: { userId } },
          select: { failedAttempts: true, lockedUntil: true },
        })
      );
    const approversFor = (shiftId: string, actor = s.manager) =>
      tenant(s.as(actor), (db) => shifts.shiftVarianceApprovers(db, s.as(actor), shiftId));

    // The only manager at the branch closes their own shift short: nobody else can approve, so they
    // approve it themselves with a fresh PIN, recorded as their own approval.
    const own = await shiftOf(s.manager);
    expect((await approversFor(own.id)).map((a) => a.id)).toEqual([s.manager]);
    // Their own wrong PIN strikes their own credential, as at a refund.
    await expect(authorize(own.id, s.manager, '0000')).rejects.toMatchObject({
      reason: 'SHIFT_APPROVAL_REFUSED',
    });
    expect((await credentialOf(s.manager)).failedAttempts).toBe(1);
    const alone = await authorize(own.id, s.manager, MANAGER_PIN);
    expect(alone).toMatchObject({
      approverId: s.manager,
      selfApproved: true,
      policy: shifts.SHIFT_VARIANCE_SOLO_POLICY,
    });
    // A cashier's shift is always approved by someone else: here, that manager.
    const cashiers = await shiftOf(s.cashier);
    await expect(authorize(cashiers.id, s.cashier, MANAGER_PIN, s.cashier)).rejects.toMatchObject({
      reason: 'SHIFT_APPROVAL_NEEDS_ANOTHER',
    });
    expect((await approversFor(cashiers.id, s.cashier)).map((a) => a.id)).toEqual([s.manager]);

    // Once a second manager works at the branch, the first may no longer approve their own shift.
    const second = await addMember(
      s,
      `${s.owner.organizationId}_mgr2`,
      ['pharmacy:manage', 'pharmacy:counter'],
      {
        pin: '7391',
      }
    );
    const ownAgain = await shiftOf(s.manager);
    expect((await approversFor(ownAgain.id)).map((a) => a.id)).toEqual([second]);
    await expect(authorize(ownAgain.id, s.manager, MANAGER_PIN)).rejects.toMatchObject({
      reason: 'SHIFT_APPROVAL_NEEDS_ANOTHER',
    });
    const other = await authorize(ownAgain.id, second, '7391');
    expect(other).toMatchObject({ approverId: second, selfApproved: false });
    // An approval answers for its own shift only.
    await expect(
      tenant(s.as(s.manager), (db) =>
        shifts.closePharmacyCashShift(
          db,
          s.as(s.manager),
          { shiftId: own.id, countedCashMinor: 950, varianceNote: 'Fifty short' },
          { actorIsManager: true, approval: other }
        )
      )
    ).rejects.toMatchObject({ reason: 'SHIFT_APPROVAL_REQUIRED' });
    const closed = await tenant(s.as(s.manager), (db) =>
      shifts.closePharmacyCashShift(
        db,
        s.as(s.manager),
        { shiftId: ownAgain.id, countedCashMinor: 950, varianceNote: 'Fifty short' },
        { actorIsManager: true, approval: other }
      )
    );
    expect(closed.report).toMatchObject({ varianceMinor: -50, varianceApprovedBy: { id: second } });

    // A wrong PIN is refused in so many words; after five, the approver is locked out, and says so.
    for (let attempt = 1; attempt <= 4; attempt += 1)
      await expect(authorize(cashiers.id, second, '0000')).rejects.toMatchObject({
        reason: 'SHIFT_APPROVAL_REFUSED',
      });
    await expect(authorize(cashiers.id, second, '0000')).rejects.toMatchObject({
      reason: 'SHIFT_APPROVAL_LOCKED',
    });
    await expect(authorize(cashiers.id, second, '7391')).rejects.toMatchObject({
      reason: 'SHIFT_APPROVAL_LOCKED',
    });
    // Those guesses were typed by someone else: the second manager's own credential took no
    // strike, so they are not locked out of their refunds, and can still approve at their own
    // counter with their own PIN.
    expect(await credentialOf(second)).toMatchObject({ failedAttempts: 0, lockedUntil: null });
    await expect(authorize(cashiers.id, second, '7391', second)).resolves.toMatchObject({
      approverId: second,
      selfApproved: false,
    });
  });

  it('keeps closed shifts frozen when the day is reopened, and adds the new shifts to the next close', async () => {
    const s = await shop('reopen', { shifts: true, toleranceMinor: 1_000_000 });
    const device = `device-${randomUUID()}`;
    const drawer = await openDrawer(s, device, 1_000);
    const [first] = await shiftsOf(s, drawer.id);
    const a = await bill(s, 300);
    await cash(s, s.cashier, device, a.sale.id, 300);
    await closeShift(s, s.cashier, first!.id, 1_300);
    const preview = await tenant(s.owner, (db) => dayClose.readPharmacyClose(db, s.owner, s.today));
    const firstClose = await tenant(s.owner, (db) =>
      dayClose.closePharmacyDay(db, s.owner, {
        businessDate: s.today,
        sourceHash: preview.totals.sourceHash,
        counts: [{ drawerSessionId: drawer.id, countedCashMinor: 1_300 }],
        varianceNote: '',
      })
    );
    const before = await tenant(s.owner, (db) =>
      db.pharmacyCashShift.findFirstOrThrow({ where: { id: first!.id } })
    );

    await tenant(s.owner, (db) =>
      dayClose.reopenPharmacyDayForTrading(db, s.owner, {
        businessDate: s.today,
        closeId: firstClose.id,
        reason: 'Late customer',
      })
    );
    // Reopening the day never reopens a shift: the closed one cannot change, by any path.
    await expect(closeShift(s, s.manager, first!.id, 1)).rejects.toMatchObject({
      reason: 'SHIFT_ALREADY_CLOSED',
    });
    await expect(
      tenant(s.owner, (db) =>
        db.pharmacyCashShift.update({
          where: { organizationId_id: { organizationId: s.owner.organizationId, id: first!.id } },
          data: { countedCashMinor: 1 },
        })
      )
    ).rejects.toThrow(/PHARMACY_SHIFT_IMMUTABLE/);

    // Trading resumes on a new drawer, whose first shift opens with it.
    const again = await openDrawer(s, device, 1_300);
    const [next] = await shiftsOf(s, again.id);
    const b = await bill(s, 450);
    await cash(s, s.cashier, device, b.sale.id, 450);
    await closeShift(s, s.cashier, next!.id, 1_750);
    const preview2 = await tenant(s.owner, (db) =>
      dayClose.readPharmacyClose(db, s.owner, s.today)
    );
    const secondClose = await tenant(s.owner, (db) =>
      dayClose.closePharmacyDay(db, s.owner, {
        businessDate: s.today,
        sourceHash: preview2.totals.sourceHash,
        counts: [{ drawerSessionId: again.id, countedCashMinor: 1_750 }],
        varianceNote: '',
      })
    );
    const after = await tenant(s.owner, (db) =>
      db.pharmacyCashShift.findFirstOrThrow({ where: { id: first!.id } })
    );
    expect(after).toEqual(before);
    expect(secondClose).toMatchObject({ sequence: 2, supersedesCloseId: firstClose.id });
    expect(preview2.shifts!.map((shift) => [shift.shiftId, shift.status])).toEqual(
      expect.arrayContaining([
        [first!.id, 'CLOSED'],
        [next!.id, 'CLOSED'],
      ])
    );
    // The new close adds both shifts: 750 in cash sales, counted 1,300 + 1,750.
    expect(preview2.shiftTotals!.tenders).toEqual([{ type: 'CASH', count: 2, amountMinor: 750 }]);
    expect(secondClose.cashCountedMinor).toBe(1_300 + 1_750);
    expect(secondClose.cashVarianceMinor).toBe(preview2.shiftTotals!.cashVarianceMinor);
  });

  it('puts a 00:30 sale on a branch whose day ends at 05:00 in the open shift of the day before', async () => {
    const s = await shop('late_night', { shifts: true, toleranceMinor: 1_000_000 });
    // The day-end hour can only move a day that has not begun: 05:00 from the day after tomorrow.
    const day = businessDay.shiftPharmacyDay(businessDay.pharmacyBusinessDay(await dayClock(s)), 2);
    await tenant(s.owner, (db) =>
      db.pharmacyBranch.update({
        where: { id: s.owner.branchId },
        data: {
          businessDayEndsAtHistory: [
            { from: day, hour: 5, actorId: s.manager, at: new Date().toISOString() },
          ],
          businessDayEndsAtRevision: { increment: 1 },
        },
      })
    );
    const dayDate = new Date(`${day}T00:00:00.000Z`);
    const nextDay = businessDay.shiftPharmacyDay(day, 1);
    // 00:30 and 05:30 on the next calendar day, in the organisation's zone (UTC: none is set).
    const halfPastMidnight = new Date(`${nextDay}T00:30:00.000Z`);
    const halfPastFive = new Date(`${nextDay}T05:30:00.000Z`);
    expect(businessDay.pharmacyBusinessDay(await dayClock(s), halfPastMidnight)).toBe(day);
    expect(businessDay.pharmacyBusinessDay(await dayClock(s), halfPastFive)).toBe(nextDay);

    // The application's clock reads that night; the database keeps its own.
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date(`${day}T18:00:00.000Z`));
      const device = `device-${randomUUID()}`;
      const drawer = await tenant(s.owner, (db) =>
        settlement.openPharmacyDrawer(db, s.owner, {
          deviceId: device,
          businessDate: dayDate,
          openingFloatMinor: 1_000,
          operatingCashierId: s.cashier,
        })
      );
      const [evening] = await shiftsOf(s, drawer.id);
      const sale = (amountMinor: number, actor: string) =>
        bill(s, amountMinor).then(({ sale: open }) =>
          tenant(s.as(actor), (db) =>
            settlement.applyPharmacyTender(
              db,
              s.as(actor),
              {
                saleId: open.id,
                deviceId: device,
                businessDate: dayDate,
                type: 'CASH',
                amountMinor,
                cashReceivedMinor: amountMinor,
                idempotencyKey: randomUUID(),
              },
              undefined,
              { requireCurrentBusinessDate: true }
            )
          )
        );
      await sale(300, s.cashier);

      // At 00:30 the evening cashier hands over to the night cashier: same day, same drawer.
      vi.setSystemTime(halfPastMidnight);
      await tenant(s.owner, (db) => settlement.requireTodaysPharmacyDrawer(db, s.owner, drawer));
      await closeShift(s, s.cashier, evening!.id, 1_300);
      const night = await openShift(s, s.cashier2, drawer.id, 1_300);
      expect(night.shift).toMatchObject({ sequence: 2, businessDate: dayDate });
      const paid = await sale(250, s.cashier2);
      const tender = await tenant(s.owner, (db) =>
        db.pharmacyTender.findFirstOrThrow({
          where: { id: (paid as { tenderId: string }).tenderId },
        })
      );
      // The 00:30 sale is the night shift's, on the business day before the calendar date.
      expect(tender).toMatchObject({ shiftId: night.shift.id, businessDate: dayDate });
      // Online, a payment for the next calendar date is refused: that day has not begun.
      await expect(
        tenant(s.owner, (db) =>
          settlement.requireCurrentPharmacyBusinessDate(
            db,
            s.owner,
            new Date(`${nextDay}T00:00:00.000Z`)
          )
        )
      ).rejects.toMatchObject({ reason: 'BUSINESS_DATE_NOT_CURRENT' });

      // After 05:00 the day is over: its drawer takes no more cash.
      vi.setSystemTime(halfPastFive);
      await expect(
        tenant(s.owner, (db) => settlement.requireTodaysPharmacyDrawer(db, s.owner, drawer))
      ).rejects.toMatchObject({ reason: 'DRAWER_FROM_EARLIER_DAY' });
      await expect(sale(100, s.cashier2)).rejects.toMatchObject({
        reason: 'BUSINESS_DATE_NOT_CURRENT',
      });

      const close = await tenant(s.owner, (db) => dayClose.readPharmacyClose(db, s.owner, dayDate));
      expect(
        close.shifts!.map((shift) => [shift.sequence, shift.cashier.id, shift.status])
      ).toEqual([
        [1, s.cashier, 'CLOSED'],
        [2, s.cashier2, 'OPEN'],
      ]);
      expect(close.shiftTotals!.tenders).toEqual([{ type: 'CASH', count: 2, amountMinor: 550 }]);
    } finally {
      vi.useRealTimers();
    }
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
