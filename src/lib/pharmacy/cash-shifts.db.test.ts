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
import { createHmac, randomBytes, randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
if (TEST_DATABASE_URL) process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.PLATFORM_ENCRYPTION_KEY ??= randomBytes(32).toString('base64');

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

/** DEV-961: an independent RFC 6238 oracle (SHA-1, 6 digits, 30 s). */
function codeAt(secretB32: string, at: Date): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const ch of secretB32) bits += alphabet.indexOf(ch).toString(2).padStart(5, '0');
  const key = Buffer.from(bits.match(/.{8}/g)!.map((byte) => parseInt(byte, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at.getTime() / 30_000)));
  const hmac = createHmac('sha1', key).update(counter).digest();
  const value = hmac.readUInt32BE(hmac[hmac.length - 1] & 0xf) & 0x7fffffff;
  return String(value % 1_000_000).padStart(6, '0');
}

/** A fresh organization and branch (shifts on or off), with a manager (PIN) and two cashiers. */
async function shop(
  label: string,
  options: { shifts: boolean; toleranceMinor?: number; approvalAuthenticator?: boolean }
) {
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
        // DEV-961: these approvals use the manager's fixed PIN, which applies while the owner has
        // the authenticator for approvals turned off; the approval-setting case turns it on.
        requireApprovalAuthenticator: options.approvalAuthenticator ?? false,
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

// Each test seeds its own organization and runs many transactions as the restricted role; under
// the full pharmacy database run they can pass vitest's 5 s default.
describeDatabase('pharmacy cash shifts on migrated PostgreSQL', { timeout: 60_000 }, () => {
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
        shifts.authorizeCashShiftVariance(
          db,
          s.as(s.cashier),
          { shiftId: first!.id, approverId: s.manager, pin: '0000' },
          { actorIsManager: false }
        )
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
        shifts.authorizeCashShiftVariance(
          db,
          s.as(s.cashier),
          { shiftId: first!.id, approverId: s.cashier, pin: MANAGER_PIN },
          { actorIsManager: false }
        )
      )
    ).rejects.toMatchObject({ reason: 'SHIFT_APPROVAL_NEEDS_ANOTHER' });
    await expect(
      tenant(s.as(s.cashier), (db) =>
        shifts.authorizeCashShiftVariance(
          db,
          s.as(s.cashier),
          { shiftId: first!.id, approverId: s.cashier2, pin: MANAGER_PIN },
          { actorIsManager: false }
        )
      )
    ).rejects.toMatchObject({ reason: 'SHIFT_APPROVAL_NOT_ELIGIBLE' });
    const approval = await tenant(s.as(s.cashier), (db) =>
      shifts.authorizeCashShiftVariance(
        db,
        s.as(s.cashier),
        { shiftId: first!.id, approverId: s.manager, pin: MANAGER_PIN },
        { actorIsManager: false }
      )
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
    // Consumes the counter's next leased receipt number for `saleId` the way applyPharmacyTender
    // does: the cursor moves past it and the consumption is recorded, in this transaction.
    const consume = async (db: ScopedDb, saleId: string, soldAt: Date) => {
      const [{ receipt_number }] = await db.$queryRaw<Array<{ receipt_number: number }>>`
        UPDATE pharmacy_receipt_number_leases SET "nextNumber" = "nextNumber" + 1
         WHERE id = ${lease.id} AND "organizationId" = ${s.owner.organizationId}
        RETURNING "nextNumber" - 1 AS receipt_number`;
      await settlement.recordLeasedReceiptConsumption(db, s.owner, {
        leaseId: lease.id,
        deviceId: device,
        receiptNumber: receipt_number!,
        saleId,
        soldAt,
      });
    };
    // Writes a replayed offline cash sale the way applyPharmacyTender does: the transaction consumes
    // the counter's leased receipt number for this sale, the tender carries the signed sale time,
    // and its cash movement the attribution the database gave the tender. With `savepoint`, all of
    // it runs inside a savepoint, as a replay nested in a larger transaction would.
    const replay = (
      saleId: string,
      amountMinor: number,
      soldAt: Date,
      options: { savepoint?: boolean } = {}
    ) =>
      tenant(s.as(s.cashier), async (db) => {
        if (options.savepoint) await db.$executeRaw`SAVEPOINT replay`;
        await consume(db, saleId, soldAt);
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
        if (options.savepoint) await db.$executeRaw`RELEASE SAVEPOINT replay`;
        return tender;
      });
    const soldInShift1 = new Date(first!.openedAt.getTime() + 1);
    const early = await bill(s, 150);
    const whileOpen = await replay(early.sale.id, 150, soldInShift1);
    expect(whileOpen).toMatchObject({ shiftId: first!.id, lateArrivalShiftId: null });

    await closeShift(s, s.cashier, first!.id, 250, { varianceNote: 'Offline sale counted' });
    const second = await openShift(s, s.cashier2, drawer.id, 250);
    const late = await bill(s, 100);
    const afterClose = await replay(late.sale.id, 100, soldInShift1, { savepoint: true });
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
    // A sale time needs a receipt number this transaction really used for this very sale. A
    // cursor "moved" to where it already was records nothing, and cannot be claimed by hand.
    const cashier = s.as(s.cashier);
    const sameTransaction = <T>(work: (db: ScopedDb) => Promise<T>) => tenant(cashier, work);
    const forgedTender = (db: ScopedDb, saleId: string, soldAt: Date, amountMinor = 10) =>
      db.pharmacyTender.create({
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
    await expect(
      sameTransaction(async (db) => {
        await db.$executeRaw`UPDATE pharmacy_receipt_number_leases SET "nextNumber" = "nextNumber"
          WHERE id = ${lease.id} AND "organizationId" = ${s.owner.organizationId}`;
        return forgedTender(db, forged.sale.id, soldInShift1);
      })
    ).rejects.toThrow(refusal);
    await expect(
      sameTransaction(async (db) => {
        await db.$executeRaw`UPDATE pharmacy_receipt_number_leases SET "nextNumber" = "nextNumber"
          WHERE id = ${lease.id} AND "organizationId" = ${s.owner.organizationId}`;
        const [{ next }] = await db.$queryRaw<Array<{ next: number }>>`
          SELECT "nextNumber" AS next FROM pharmacy_receipt_number_leases WHERE id = ${lease.id}`;
        return settlement.recordLeasedReceiptConsumption(db, s.owner, {
          leaseId: lease.id,
          deviceId: device,
          receiptNumber: next! - 1,
          saleId: forged.sale.id,
          soldAt: soldInShift1,
        });
      })
    ).rejects.toThrow(/PHARMACY_RECEIPT_CONSUMPTION_INVALID/);
    // A number really used for another sale does not let this one through, and a used number's
    // consumption is claimed by its own tender once.
    const otherSale = await bill(s, 10);
    await expect(
      sameTransaction(async (db) => {
        await consume(db, otherSale.sale.id, soldInShift1);
        return forgedTender(db, forged.sale.id, soldInShift1);
      })
    ).rejects.toThrow(refusal);
    await expect(
      sameTransaction(async (db) => {
        await consume(db, otherSale.sale.id, soldInShift1);
        await forgedTender(db, otherSale.sale.id, soldInShift1);
        return forgedTender(db, otherSale.sale.id, soldInShift1);
      })
    ).rejects.toThrow(refusal);
    // A replayed late tender's cash lands on the closed shift once; a second movement is refused.
    await expect(
      sameTransaction(async (db) => {
        await consume(db, otherSale.sale.id, soldInShift1);
        const lateTender = await forgedTender(db, otherSale.sale.id, soldInShift1);
        expect(lateTender.lateArrivalShiftId).toBe(first!.id);
        for (let copy = 0; copy < 2; copy += 1)
          await db.pharmacyDrawerMovement.create({
            data: {
              organizationId: s.owner.organizationId,
              drawerSessionId: drawer.id,
              kind: 'CASH_SALE',
              amountMinor: 10,
              actorId: s.cashier,
              lateArrivalShiftId: first!.id,
            },
          });
      })
    ).rejects.toThrow(refusal);
    // A replayed sale's tender settles exactly what the sale owes: 5,000 on a sale of 10 is refused.
    await expect(
      sameTransaction(async (db) => {
        await consume(db, otherSale.sale.id, soldInShift1);
        return forgedTender(db, otherSale.sale.id, soldInShift1, 5_000);
      })
    ).rejects.toThrow(refusal);

    // A phantom lease cannot carry a sale back into the closed shift. The database issues a lease
    // now, by its own clock, only over numbers drawn in the same transaction that no sale carries.
    const org = s.owner.organizationId;
    const branch = s.owner.branchId;
    const allocate = async (db: ScopedDb, count: number) =>
      (
        await db.$queryRaw<Array<{ first: number }>>`
          SELECT pharmacy_allocate_branch_receipt_numbers(${org}::text, ${branch}::text, ${count}::integer) AS first`
      )[0]!.first;
    const phantomLease = async (db: ScopedDb, from: number, to: number) =>
      (
        await db.$queryRaw<Array<{ id: string; issuedAt: Date }>>`
          INSERT INTO pharmacy_receipt_number_leases
            (id, "organizationId", "branchId", "deviceId", "blockStart", "blockEnd", "nextNumber",
             "issuedToActorId", "issuedAt")
          VALUES (${randomUUID()}, ${org}, ${branch}, ${device}, ${from}, ${to}, ${from},
            ${s.cashier}, ${new Date('2000-01-01T00:00:00.000Z')})
          RETURNING id, "issuedAt"`
      )[0]!;
    const before = Date.now() - 60_000;
    // (a) A supplied issue time is ignored: the lease is issued now.
    const fresh = await sameTransaction(async (db) => {
      const first = await allocate(db, 1);
      return phantomLease(db, first, first);
    });
    expect(fresh.issuedAt.getTime()).toBeGreaterThan(before);
    // So the reviewer's phantom lease, issued and consumed in one go, cannot reach shift 1.
    await expect(
      sameTransaction(async (db) => {
        const first = await allocate(db, 1);
        const lease = await phantomLease(db, first, first);
        await db.$executeRaw`UPDATE pharmacy_receipt_number_leases SET "nextNumber" = "nextNumber" + 1
          WHERE id = ${lease.id}`;
        await settlement.recordLeasedReceiptConsumption(db, s.owner, {
          leaseId: lease.id,
          deviceId: device,
          receiptNumber: first,
          saleId: otherSale.sale.id,
          soldAt: soldInShift1,
        });
        await forgedTender(db, otherSale.sale.id, soldInShift1);
      })
    ).rejects.toThrow(/PHARMACY_RECEIPT_CONSUMPTION_INVALID/);
    // (b) Never over a number a sale already carries: an earlier online receipt's number...
    const online = await sameTransaction(async (db) => {
      const number = await allocate(db, 1);
      await db.pharmacySale.create({
        data: {
          organizationId: org,
          branchId: branch,
          status: 'COMPLETED',
          createdByUserId: s.cashier,
          receiptNumber: number,
          receiptDeviceId: 'counter-online',
          businessDate: s.today,
          completedAt: new Date(),
        },
      });
      return number;
    });
    await expect(
      sameTransaction(async (db) => {
        await allocate(db, 2);
        return phantomLease(db, online, online);
      })
    ).rejects.toThrow(/RECEIPT_LEASE_NOT_ALLOCATED/);
    // ...or one a sale took inside the very block just drawn.
    await expect(
      sameTransaction(async (db) => {
        const first = await allocate(db, 2);
        await db.pharmacySale.create({
          data: {
            organizationId: org,
            branchId: branch,
            status: 'COMPLETED',
            createdByUserId: s.cashier,
            receiptNumber: first,
            receiptDeviceId: 'counter-online',
            businessDate: s.today,
            completedAt: new Date(),
          },
        });
        return phantomLease(db, first, first + 1);
      })
    ).rejects.toThrow(/RECEIPT_LEASE_NUMBER_USED/);
    // And only numbers drawn in the same transaction: a block drawn earlier is not a lease.
    const drawnEarlier = await sameTransaction((db) => allocate(db, 3));
    await expect(
      sameTransaction((db) => phantomLease(db, drawnEarlier, drawnEarlier + 2))
    ).rejects.toThrow(/RECEIPT_LEASE_NOT_ALLOCATED/);

    // Only the database's own guards claim a used number's record: not a trigger of the runtime
    // role's own, on a temporary table, however deeply nested.
    await expect(
      sameTransaction(async (db) => {
        await consume(db, otherSale.sale.id, soldInShift1);
        await db.$executeRawUnsafe(`CREATE TEMP TABLE claim_by_hand (x int) ON COMMIT DROP`);
        await db.$executeRawUnsafe(`
          CREATE FUNCTION pg_temp.claim_by_hand() RETURNS trigger LANGUAGE plpgsql AS $fn$
          BEGIN
            UPDATE pharmacy_receipt_number_consumptions SET "tenderId" = 'by-hand'
             WHERE "tenderId" IS NULL;
            RETURN NEW;
          END $fn$`);
        await db.$executeRawUnsafe(`
          CREATE TRIGGER claim_by_hand AFTER INSERT ON pg_temp.claim_by_hand
            FOR EACH ROW EXECUTE FUNCTION pg_temp.claim_by_hand()`);
        await db.$executeRawUnsafe(`INSERT INTO pg_temp.claim_by_hand VALUES (1)`);
      })
    ).rejects.toThrow(/PHARMACY_RECEIPT_CONSUMPTION_IMMUTABLE/);

    // The record of a used number never changes and is never deleted.
    await expect(
      sameTransaction(
        (db) =>
          db.$executeRaw`UPDATE pharmacy_receipt_number_consumptions SET "saleId" = ${forged.sale.id}`
      )
    ).rejects.toThrow(/PHARMACY_RECEIPT_CONSUMPTION_IMMUTABLE/);
    await expect(
      sameTransaction(
        (db) => db.$executeRaw`UPDATE pharmacy_receipt_number_consumptions SET "tenderId" = NULL`
      )
    ).rejects.toThrow(/PHARMACY_RECEIPT_CONSUMPTION_IMMUTABLE/);
    await expect(
      sameTransaction((db) => db.$executeRaw`DELETE FROM pharmacy_receipt_number_consumptions`)
    ).rejects.toThrow(/PHARMACY_RECEIPT_CONSUMPTION_IMMUTABLE/);
    const used = await tenant(s.owner, (db) =>
      db.pharmacyReceiptNumberConsumption.findMany({
        select: { saleId: true, receiptNumber: true, tenderId: true, cashMovementId: true },
        orderBy: { receiptNumber: 'asc' },
      })
    );
    // Only the two genuine replays used numbers; every forgery rolled back with its transaction.
    expect(used.map((row) => [row.saleId, row.receiptNumber - lease.blockStart])).toEqual([
      [early.sale.id, 0],
      [late.sale.id, 1],
    ]);
    expect(used.every((row) => row.tenderId !== null)).toBe(true);
    expect(used[1]!.cashMovementId).not.toBeNull();
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

  it("keeps a receipt lease the database's: issued now in UTC, never backdated, used only later", async () => {
    const s = await shop('lease_floor', { shifts: true, toleranceMinor: 1_000_000 });
    const { device } = await tenant(s.owner, (db) =>
      devices.enrollPharmacyCounter(db, s.owner, { name: 'Counter 1' })
    );
    const issuedAtOf = (id: string) =>
      tenant(s.owner, (db) =>
        db.pharmacyReceiptNumberLease.findFirstOrThrow({
          where: { id },
          select: { issuedAt: true },
        })
      ).then((row) => row.issuedAt);
    // Issued from a session whose time zone is not UTC, it is still stamped in UTC, now.
    const before = Date.now();
    const lease = await tenant(s.owner, async (db) => {
      await db.$executeRawUnsafe(`SET LOCAL TIME ZONE 'Asia/Karachi'`);
      return leases.reserveReceiptNumberBlock(db, s.owner, { deviceId: device.id, size: 5 });
    });
    const issuedAt = await issuedAtOf(lease.id);
    expect(issuedAt.getTime()).toBeGreaterThanOrEqual(before - 60_000);
    expect(issuedAt.getTime()).toBeLessThanOrEqual(Date.now() + 60_000);

    // A genuine lease is never backdated, with its cursor in one statement or in two.
    const cashier = s.as(s.cashier);
    const longAgo = new Date('2000-01-01T00:00:00.000Z');
    await expect(
      tenant(
        cashier,
        (db) => db.$executeRaw`UPDATE pharmacy_receipt_number_leases
          SET "nextNumber" = "nextNumber" + 1, "issuedAt" = ${longAgo} WHERE id = ${lease.id}`
      )
    ).rejects.toThrow(/RECEIPT_LEASE_IMMUTABLE/);
    await expect(
      tenant(cashier, async (db) => {
        await db.$executeRaw`UPDATE pharmacy_receipt_number_leases
          SET "nextNumber" = "nextNumber" + 1 WHERE id = ${lease.id}`;
        await db.$executeRaw`UPDATE pharmacy_receipt_number_leases
          SET "issuedAt" = ${longAgo} WHERE id = ${lease.id}`;
      })
    ).rejects.toThrow(/RECEIPT_LEASE_IMMUTABLE/);
    expect(await issuedAtOf(lease.id)).toEqual(issuedAt);

    // A number is used only from a lease an earlier transaction issued: issuing a lease and using
    // it in one transaction (say one opened before a shift closed) books nothing.
    const drawer = await openDrawer(s, device.id, 0);
    const [shift] = await shiftsOf(s, drawer.id);
    const replay = (db: ScopedDb, leaseId: string, saleId: string) =>
      db.$queryRaw<Array<{ receipt_number: number }>>`
        UPDATE pharmacy_receipt_number_leases SET "nextNumber" = "nextNumber" + 1
         WHERE id = ${leaseId} RETURNING "nextNumber" - 1 AS receipt_number`.then(async (rows) => {
        const soldAt = new Date(Date.now() + 60_000);
        await settlement.recordLeasedReceiptConsumption(db, s.owner, {
          leaseId,
          deviceId: device.id,
          receiptNumber: rows[0]!.receipt_number,
          saleId,
          soldAt,
        });
        return db.pharmacyTender.create({
          data: {
            organizationId: s.owner.organizationId,
            branchId: s.owner.branchId,
            saleId,
            type: 'CASH',
            amountMinor: 10,
            cashReceivedMinor: 10,
            changeGivenMinor: 0,
            drawerSessionId: drawer.id,
            businessDate: s.today,
            actorId: s.cashier,
            deviceId: device.id,
            soldAt,
          },
        });
      });
    const sameTransaction = await bill(s, 10);
    await expect(
      tenant(s.owner, async (db) => {
        const fresh = await leases.reserveReceiptNumberBlock(db, s.owner, {
          deviceId: device.id,
          size: 1,
        });
        return replay(db, fresh.id, sameTransaction.sale.id);
      })
    ).rejects.toThrow(/PHARMACY_RECEIPT_CONSUMPTION_INVALID/);
    // The lease issued earlier serves a later replay as before.
    const later = await bill(s, 10);
    const tender = await tenant(cashier, (db) => replay(db, lease.id, later.sale.id));
    expect(tender).toMatchObject({ shiftId: shift!.id, lateArrivalShiftId: null });
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
    // `actor` is the person closing the shift and counting its cash.
    const managers = new Set([s.manager]);
    const authorize = (shiftId: string, approverId: string, pin: string, actor = s.manager) =>
      tenant(s.as(actor), (db) =>
        shifts.authorizeCashShiftVariance(
          db,
          s.as(actor),
          { shiftId, approverId, pin },
          { actorIsManager: managers.has(actor) }
        )
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

    // A second manager with the approval right but no approval credential cannot approve, so they
    // never count as "another approver" who would block a self-approval.
    const noPin = await addMember(s, `${s.owner.organizationId}_nopin`, ['pharmacy:manage']);
    managers.add(noPin);
    // The only manager who can approve closes their own shift short: nobody else can, so they
    // approve it themselves with a fresh PIN, recorded as a solo approval.
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
    // Someone with the right but no approval PIN is not eligible, whoever types; no guess is spent.
    await expect(authorize(cashiers.id, noPin, '1234', s.cashier)).rejects.toMatchObject({
      reason: 'SHIFT_APPROVAL_NOT_ELIGIBLE',
    });
    await expect(authorize(cashiers.id, s.cashier, MANAGER_PIN, s.cashier)).rejects.toMatchObject({
      reason: 'SHIFT_APPROVAL_NEEDS_ANOTHER',
    });
    expect((await approversFor(cashiers.id, s.cashier)).map((a) => a.id)).toEqual([s.manager]);
    // A manager closing that cashier's shift counts its cash, so they too approve it alone only
    // while nobody else can, and it is recorded as a solo approval.
    expect((await approversFor(cashiers.id)).map((a) => a.id)).toEqual([s.manager]);
    await expect(authorize(cashiers.id, s.manager, MANAGER_PIN)).resolves.toMatchObject({
      approverId: s.manager,
      selfApproved: true,
      policy: shifts.SHIFT_VARIANCE_SOLO_POLICY,
    });
    // Someone who may not close the shift is refused before any PIN is checked: another cashier's
    // guesses cost the manager no strike and no attempt.
    for (let attempt = 1; attempt <= 6; attempt += 1)
      await expect(authorize(cashiers.id, s.manager, '0000', s.cashier2)).rejects.toMatchObject({
        reason: 'DRAWER_NOT_YOURS',
      });
    expect(await credentialOf(s.manager)).toMatchObject({ failedAttempts: 0, lockedUntil: null });
    await expect(authorize(cashiers.id, s.manager, MANAGER_PIN, s.cashier)).resolves.toMatchObject({
      approverId: s.manager,
      selfApproved: false,
    });

    // Once a second manager works at the branch, the first may no longer approve their own shift.
    const second = await addMember(
      s,
      `${s.owner.organizationId}_mgr2`,
      ['pharmacy:manage', 'pharmacy:counter'],
      {
        pin: '7391',
      }
    );
    managers.add(second);
    const ownAgain = await shiftOf(s.manager);
    expect((await approversFor(ownAgain.id)).map((a) => a.id)).toEqual([second]);
    // Nor a cashier's shift they close: the second manager approves it.
    await expect(authorize(cashiers.id, s.manager, MANAGER_PIN)).rejects.toMatchObject({
      reason: 'SHIFT_APPROVAL_NEEDS_ANOTHER',
    });
    expect((await approversFor(cashiers.id)).map((a) => a.id)).toEqual([second]);
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
    // strike, so their own PIN still works for their refunds.
    expect(await credentialOf(second)).toMatchObject({ failedAttempts: 0, lockedUntil: null });
    // The budget is the approver's one budget for PINs typed by others, which purchase approval
    // spends too: it is gone for every such approval, not only for shifts.
    const budgets = await import('@/lib/approver-pin-guess-budget');
    expect(
      (await budgets.spendApproverPinGuessTypedByAnother(s.owner.organizationId, second)).ok
    ).toBe(false);
    const { authenticateRefundPin } = await import('./refund-authorization');
    await expect(
      authenticateRefundPin({
        organizationId: s.owner.organizationId,
        actorId: second,
        pin: '7391',
        action: 'pharmacySales.refund',
      })
    ).resolves.toEqual({ verified: true });
  });

  it('DEV-961: repeated successful named approvals refund their exact PostgreSQL reservations on an unenrolled till', async () => {
    const s = await shop('named_budget', { shifts: true, approvalAuthenticator: false });
    const scope = s.as(s.cashier);
    const { authorizeCounterApproval } = await import('./counter-line-approval');
    const { rateLimitStorageKey } = await import('@/lib/rate-limit');
    const keys = [
      rateLimitStorageKey(
        JSON.stringify(['pharmacy-approval-requester', scope.organizationId, scope.actorId])
      ),
      rateLimitStorageKey(`approver-pin-typed-by-another:${scope.organizationId}:${s.manager}`),
    ];
    const profile = await tenant(s.owner, (db) =>
      db.restaurantStaffProfile.findFirstOrThrow({ where: { userId: s.manager } })
    );
    // Model one previous failure in a live window with a sub-millisecond start.
    await tenant(scope, async (db) => {
      for (const key of keys)
        await db.$executeRaw`INSERT INTO rate_limit_buckets (key, count, "resetAt")
          VALUES (${key}, 1, date_trunc('milliseconds', now()) + interval '15 minutes 0.000321 seconds')`;
    });
    vi.stubEnv('RATE_LIMIT_STORE', 'postgres');
    try {
      for (let i = 0; i < 6; i++)
        await expect(
          tenant(scope, (db) =>
            authorizeCounterApproval(db, scope, 'DISCOUNT', {
              staffProfileId: profile.id,
              pin: MANAGER_PIN,
            })
          )
        ).resolves.toMatchObject({ approvedByUserId: s.manager });
      const { establishToken } = await import('./counter-terminal-session');
      const { device, secret } = await tenant(s.owner, (db) =>
        devices.enrollPharmacyCounter(db, s.owner, { name: 'Named proof fixture' })
      );
      const otherBranchToken = establishToken({
        scope: { ...scope, branchId: 'other' },
        deviceId: device.id,
        deviceSecret: secret,
      });
      for (const token of [
        otherBranchToken,
        (() => {
          vi.useFakeTimers({ toFake: ['Date'] });
          try {
            vi.setSystemTime(Date.now() - 9 * 3_600_000);
            return establishToken({ scope, deviceId: device.id, deviceSecret: secret });
          } finally {
            vi.useRealTimers();
          }
        })(),
      ]) {
        await expect(
          tenant(scope, (db) =>
            authorizeCounterApproval(db, scope, 'DISCOUNT', {
              staffProfileId: profile.id,
              pin: MANAGER_PIN,
              counter: { deviceId: device.id, sessionToken: token },
            })
          )
        ).resolves.toMatchObject({ approvedByUserId: s.manager });
      }
      const tillKey = rateLimitStorageKey(
        JSON.stringify(['pharmacy-approval-counter', scope.organizationId, device.id])
      );
      expect(
        await tenant(
          scope,
          (db) => db.$queryRaw`SELECT count FROM rate_limit_buckets WHERE key = ${tillKey}`
        )
      ).toEqual([]);
      const counts = await tenant(
        scope,
        (db) => db.$queryRaw<{ count: number }[]>`
        SELECT count FROM rate_limit_buckets WHERE key IN (${keys[0]}, ${keys[1]})`
      );
      expect(counts.map((row) => row.count)).toEqual([1, 1]);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('DEV-961: a verified till resolves a unique previous-step code, refuses replay and asks which person on collision', async () => {
    const s = await shop('detect', { shifts: true, approvalAuthenticator: true });
    const { authorizeCounterApproval, CounterApprovalDenied } =
      await import('./counter-line-approval');
    const { CounterApprovalChoice } = await import('./counter-approval-choice');
    const { establishToken } = await import('./counter-terminal-session');
    const { encryptSecret } = await import('@/lib/secret-crypto');
    const { generateTotpSecret } = await import('@/lib/totp');
    const scope = s.as(s.cashier);
    const secret = generateTotpSecret();
    const { device, secret: deviceSecret } = await tenant(s.owner, (db) =>
      devices.enrollPharmacyCounter(db, s.owner, { name: 'Approval till' })
    );
    const enroll = (userId: string) =>
      tenant(s.owner, (db) =>
        db.approvalAuthenticator.create({
          data: { userId, encryptedSecret: encryptSecret(secret), enabledAt: new Date() },
        })
      );
    await enroll(s.manager);
    const sessionFor = (actor: Scope) => ({
      deviceId: device.id,
      sessionToken: establishToken({ scope: actor, deviceId: device.id, deviceSecret }),
    });
    const counter = sessionFor(scope);
    const at = new Date();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(at);
    vi.stubEnv('RATE_LIMIT_STORE', 'postgres');
    try {
      const submit = (pin: string, matchingStaffProfileId?: string, choiceProof?: string) =>
        tenant(scope, (db) =>
          authorizeCounterApproval(db, scope, 'DISCOUNT', { pin, matchingStaffProfileId, choiceProof, counter })
        );
      // An equally capable person with the same synthetic code but no active
      // branch assignment must never appear as a match or cause a collision.
      const inactive = await addMember(s, scope.organizationId + '_inactive', ['pharmacy:manage'], {
        pin: MANAGER_PIN,
      });
      await tenant(s.owner, (db) =>
        db.pharmacyBranchAssignment.updateMany({
          where: { userId: inactive, branchId: scope.branchId },
          data: { active: false },
        })
      );
      await enroll(inactive);
      await expect(
        tenant(scope, (db) =>
          authorizeCounterApproval(db, scope, 'DISCOUNT', {
            pin: codeAt(secret, at),
            counter: { ...counter, sessionToken: 'invalid-fixture' },
          })
        )
      ).rejects.toThrow(/Choose the approver by name/);
      const previous = codeAt(secret, new Date(at.getTime() - 30_000));
      await expect(submit(previous)).resolves.toMatchObject({
        approvedByUserId: s.manager,
        selfApproved: false,
      });
      await expect(submit(previous)).rejects.toBeInstanceOf(CounterApprovalDenied);
      const other = await addMember(s, s.owner.organizationId + '_other', ['pharmacy:manage'], {
        pin: MANAGER_PIN,
      });
      await enroll(other);
      const current = codeAt(secret, at);
      const profiles = await tenant(s.owner, (db) =>
        db.restaurantStaffProfile.findMany({
          where: { userId: { in: [other, s.manager] } },
          select: { id: true, userId: true },
        })
      );
      const choice: unknown = await submit(current).catch((error: unknown) => error);
      expect(choice).toBeInstanceOf(CounterApprovalChoice);
      expect(
        (choice as InstanceType<typeof CounterApprovalChoice>).staffProfileIds.toSorted()
      ).toEqual(profiles.map((p) => p.id).toSorted());
      const second = profiles.find((p) => p.userId === other)!;
      const response = choice as InstanceType<typeof CounterApprovalChoice>;
      const proof = response.choiceProofs[response.staffProfileIds.indexOf(second.id)]!;
      await expect(submit(current, second.id, proof)).rejects.toBeInstanceOf(CounterApprovalDenied);
      const later = new Date(at.getTime() + 30_000);
      vi.setSystemTime(later);
      const nextCode = codeAt(secret, later);
      await expect(submit(nextCode, second.id)).rejects.toBeInstanceOf(CounterApprovalDenied);
      await expect(submit(nextCode, second.id, proof)).resolves.toMatchObject({ approvedByUserId: other });
      const audit = await tenant(s.owner, (db) =>
        db.auditLog.findMany({
          where: { action: 'pharmacy.counterApproval.DISCOUNT' },
          select: { actorId: true, metadata: true, description: true },
        })
      );
      expect(audit.map((row) => row.actorId).sort()).toEqual([s.manager, other].sort());
      for (const value of [previous, current, nextCode, proof, secret, deviceSecret, counter.sessionToken])
        expect(JSON.stringify(audit).includes(value)).toBe(false);
      // Prime the live, independent counters directly. No attempt exercises an unpatched security control.
      const { rateLimit } = await import('@/lib/rate-limit');
      const { MAX_FAILED_ATTEMPTS, LOCKOUT_DURATION_MS } =
        await import('@/lib/restaurant/operator-credentials');
      const { rateLimitStorageKey } = await import('@/lib/rate-limit');
      const { spendApproverPinGuessTypedByAnother } = await import('@/lib/approver-pin-guess-budget');
      const budgetKeys = [s.manager, other].map((id) =>
        rateLimitStorageKey(`approver-pin-typed-by-another:${scope.organizationId}:${id}`)
      );
      await tenant(scope, async (db) => {
        for (const key of budgetKeys)
          await db.$executeRaw`INSERT INTO rate_limit_buckets (key, count, "resetAt")
            VALUES (${key}, ${MAX_FAILED_ATTEMPTS - 1}, now() + interval '15 minutes')
            ON CONFLICT (key) DO UPDATE SET count = EXCLUDED.count, "resetAt" = EXCLUDED."resetAt"`;
      });
      // The two fixture authenticators share a synthetic seed. Pick one known
      // nonmatching input offline and submit it once to check internal accounting.
      const fixtureCodes = [-30_000, 0, 30_000].map((delta) =>
        codeAt(secret, new Date(later.getTime() + delta))
      );
      const nonmatching = ['111111', '222222', '333333', '444444'].find((value) => !fixtureCodes.includes(value))!;
      await expect(submit(nonmatching)).rejects.toBeInstanceOf(CounterApprovalDenied);
      const budgets = await tenant(scope, (db) =>
        db.$queryRaw<{ count: number }[]>`SELECT count FROM rate_limit_buckets
          WHERE key IN (${budgetKeys[0]}, ${budgetKeys[1]})`
      );
      expect(budgets.map(({ count }) => count)).toEqual([MAX_FAILED_ATTEMPTS, MAX_FAILED_ATTEMPTS]);
      for (const id of [s.manager, other])
        expect((await spendApproverPinGuessTypedByAnother(scope.organizationId, id)).ok).toBe(false);
      for (let i = 0; i < MAX_FAILED_ATTEMPTS; i++)
        await rateLimit(
          JSON.stringify(['pharmacy-approval-counter', scope.organizationId, device.id]),
          MAX_FAILED_ATTEMPTS,
          LOCKOUT_DURATION_MS
        );
      const secondRequester = s.as(s.cashier2);
      await expect(
        tenant(secondRequester, (db) =>
          authorizeCounterApproval(db, secondRequester, 'DISCOUNT', {
            pin: current,
            counter: sessionFor(secondRequester),
            staffProfileId: profiles.find((p) => p.userId === s.manager)!.id,
          })
        )
      ).rejects.toBeInstanceOf(CounterApprovalDenied);
      expect(
        await tenant(s.owner, (db) =>
          db.auditLog.count({ where: { action: 'pharmacy.counterApproval.DISCOUNT' } })
        )
      ).toBe(2);
    } finally {
      vi.unstubAllEnvs();
      vi.useRealTimers();
    }
  });

  it('DEV-961: the variance approval and its solo self-approval follow the approval setting; app codes typed by someone else spend the same guess budget as PINs', async () => {
    const { encryptSecret } = await import('@/lib/secret-crypto');
    const { generateTotpSecret } = await import('@/lib/totp');
    const setUp = async (label: string, on: boolean) => {
      const s = await shop(label, { shifts: true, toleranceMinor: 0, approvalAuthenticator: on });
      const secret = generateTotpSecret();
      await tenant(s.owner, (db) =>
        db.approvalAuthenticator.create({
          data: {
            userId: s.manager,
            encryptedSecret: encryptSecret(secret),
            enabledAt: new Date(Date.now() - 86_400_000),
          },
        })
      );
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
      // `actor` is the person closing the shift and counting its cash.
      const authorize = (shiftId: string, pin: string, actor = s.manager) =>
        tenant(s.as(actor), (db) =>
          shifts.authorizeCashShiftVariance(
            db,
            s.as(actor),
            { shiftId, approverId: s.manager, pin },
            { actorIsManager: actor === s.manager }
          )
        );
      const credential = () =>
        tenant(s.owner, (db) =>
          db.restaurantOperatorCredential.findFirstOrThrow({
            where: { staffProfile: { userId: s.manager } },
            select: { failedAttempts: true, lockedUntil: true },
          })
        );
      const resetStrikes = () =>
        tenant(s.owner, (db) =>
          db.restaurantOperatorCredential.updateMany({
            where: { staffProfile: { userId: s.manager } },
            data: { failedAttempts: 0, lockedUntil: null },
          })
        );
      return { s, secret, shiftOf, authorize, credential, resetStrikes };
    };
    // Codes are single use: each accepted one is from a later 30-second step than the one before,
    // and every one is inside the accepted window when typed.
    const previousStep = (secret: string) => codeAt(secret, new Date(Date.now() - 30_000));
    const currentStep = (secret: string) => codeAt(secret, new Date());

    // ON (the default for organizations): the manager's app code, never their permanent PIN.
    const on = await setUp('auth_on', true);
    const ownOn = await on.shiftOf(on.s.manager);
    // The manager is the only approver, so they approve their own shift alone (SOLO).
    await expect(on.authorize(ownOn.id, MANAGER_PIN)).rejects.toMatchObject({
      reason: 'SHIFT_APPROVAL_REFUSED',
    });
    await expect(on.authorize(ownOn.id, previousStep(on.secret))).resolves.toMatchObject({
      approverId: on.s.manager,
      selfApproved: true,
      policy: shifts.SHIFT_VARIANCE_SOLO_POLICY,
    });
    await on.resetStrikes();
    // A cashier types the manager's secret for the cashier's own shift: the PIN is refused, the
    // current code approves it.
    const cashierOn = await on.shiftOf(on.s.cashier);
    await expect(on.authorize(cashierOn.id, MANAGER_PIN, on.s.cashier)).rejects.toMatchObject({
      reason: 'SHIFT_APPROVAL_REFUSED',
    });
    await expect(
      on.authorize(cashierOn.id, currentStep(on.secret), on.s.cashier)
    ).resolves.toMatchObject({ approverId: on.s.manager, selfApproved: false });
    // Wrong codes typed by the cashier spend the manager's one budget for guesses typed by others,
    // exactly as wrong PINs do: refused four times, locked at the fifth, and then even a right
    // entry is refused. The manager's own credential takes no strike.
    for (let attempt = 1; attempt <= 4; attempt += 1)
      await expect(on.authorize(cashierOn.id, '000000', on.s.cashier)).rejects.toMatchObject({
        reason: 'SHIFT_APPROVAL_REFUSED',
      });
    await expect(on.authorize(cashierOn.id, '000000', on.s.cashier)).rejects.toMatchObject({
      reason: 'SHIFT_APPROVAL_LOCKED',
    });
    await expect(
      on.authorize(cashierOn.id, currentStep(on.secret), on.s.cashier)
    ).rejects.toMatchObject({ reason: 'SHIFT_APPROVAL_LOCKED' });
    expect(await on.credential()).toMatchObject({ failedAttempts: 0, lockedUntil: null });
    const budgets = await import('@/lib/approver-pin-guess-budget');
    expect(
      (await budgets.spendApproverPinGuessTypedByAnother(on.s.owner.organizationId, on.s.manager))
        .ok
    ).toBe(false);

    // OFF (the owner turned it off): the manager's permanent PIN, never an app code.
    const off = await setUp('auth_off', false);
    const ownOff = await off.shiftOf(off.s.manager);
    await expect(off.authorize(ownOff.id, currentStep(off.secret))).rejects.toMatchObject({
      reason: 'SHIFT_APPROVAL_REFUSED',
    });
    await expect(off.authorize(ownOff.id, MANAGER_PIN)).resolves.toMatchObject({
      approverId: off.s.manager,
      selfApproved: true,
      policy: shifts.SHIFT_VARIANCE_SOLO_POLICY,
    });
    const cashierOff = await off.shiftOf(off.s.cashier);
    await expect(
      off.authorize(cashierOff.id, currentStep(off.secret), off.s.cashier)
    ).rejects.toMatchObject({ reason: 'SHIFT_APPROVAL_REFUSED' });
    await expect(off.authorize(cashierOff.id, MANAGER_PIN, off.s.cashier)).resolves.toMatchObject({
      approverId: off.s.manager,
      selfApproved: false,
    });
    // The manager's real app code, typed by the cashier while codes are not accepted, still
    // spends the same budget as a wrong PIN: locked at the fifth.
    for (let attempt = 1; attempt <= 4; attempt += 1)
      await expect(
        off.authorize(cashierOff.id, currentStep(off.secret), off.s.cashier)
      ).rejects.toMatchObject({ reason: 'SHIFT_APPROVAL_REFUSED' });
    await expect(
      off.authorize(cashierOff.id, currentStep(off.secret), off.s.cashier)
    ).rejects.toMatchObject({ reason: 'SHIFT_APPROVAL_LOCKED' });
    await expect(off.authorize(cashierOff.id, MANAGER_PIN, off.s.cashier)).rejects.toMatchObject({
      reason: 'SHIFT_APPROVAL_LOCKED',
    });
    expect(await off.credential()).toMatchObject({ failedAttempts: 0, lockedUntil: null });
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
