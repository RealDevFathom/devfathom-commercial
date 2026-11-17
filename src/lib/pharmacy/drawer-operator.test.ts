import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
// The batch re-check, finance postings, counter evidence and the regulatory gate have
// their own suites; this one is about which cash drawer money may go into (DEV-821).
vi.mock('./sale-batch-safety', () => ({ assertSaleBatchesSellable: vi.fn(async () => new Map()) }));
vi.mock('./finance-postings', async () => ({
  ...(await vi.importActual<typeof import('./finance-postings')>('./finance-postings')),
  postTenderEntry: vi.fn(),
  postTenderRefundEntry: vi.fn(),
  postSaleLineEntry: vi.fn(),
}));
vi.mock('./counter-evidence', async () => ({
  ...(await vi.importActual<typeof import('./counter-evidence')>('./counter-evidence')),
  requestCounterEvidence: vi.fn(),
}));
// The counter's operator gate (counterOperatorDenial, shared with the enrolled offline
// counter) stands here for "this person may work the counter of this branch".
const counterGate = vi.hoisted(() => ({
  counterOperatorDenial: vi.fn(async (): Promise<string | null> => null),
}));
vi.mock('./counter-capability', async () => ({
  ...(await vi.importActual<typeof import('./counter-capability')>('./counter-capability')),
  counterOperatorDenial: counterGate.counterOperatorDenial,
}));
vi.mock('./regulatory', async () => ({
  ...(await vi.importActual<typeof import('./regulatory')>('./regulatory')),
  assertStoredPharmacyMayOperate: vi.fn(async () => undefined),
}));

import {
  applyPharmacyTender,
  assertDrawerOperator,
  closePharmacyDrawer,
  drawerOperatingCashierId,
  handoverPharmacyDrawer,
  movementsByOtherThanOperator,
  openPharmacyDrawer,
  refundPharmacyTender,
  resolveOperatingPharmacyDrawer,
} from './settlement';

const scope = { organizationId: 'org-1', branchId: 'branch-1', actorId: 'cashier-1' };
const businessDate = new Date('2026-11-15T00:00:00.000Z');
const manager = { kind: 'COUNTER', actorIsManager: true } as const;
const cashier = { kind: 'COUNTER', actorIsManager: false } as const;

/** Open tills on branch-1: one run by cashier-1, one by a colleague, cashier-2. */
const tills = [
  {
    id: 'drawer-mine',
    organizationId: 'org-1',
    branchId: 'branch-1',
    deviceId: 'device-mine',
    businessDate,
    status: 'OPEN',
    openedByActorId: 'manager-1',
    operatingCashierId: 'cashier-1',
  },
  {
    id: 'drawer-colleague',
    organizationId: 'org-1',
    branchId: 'branch-1',
    deviceId: 'device-colleague',
    businessDate,
    status: 'OPEN',
    openedByActorId: 'cashier-2',
    operatingCashierId: 'cashier-2',
  },
  {
    id: 'drawer-other-branch',
    organizationId: 'org-1',
    branchId: 'branch-2',
    deviceId: 'device-other-branch',
    businessDate,
    status: 'OPEN',
    openedByActorId: 'cashier-1',
    operatingCashierId: 'cashier-1',
  },
];

/** A drawer lookup that honours every key of its `where`, as the database would. */
function findTill({ where }: { where: Record<string, unknown> }) {
  return (
    tills.find((till) =>
      Object.entries(where).every(([key, value]) =>
        value instanceof Date
          ? (till as Record<string, unknown>)[key] instanceof Date &&
            ((till as Record<string, unknown>)[key] as Date).getTime() === value.getTime()
          : (till as Record<string, unknown>)[key] === value
      )
    ) ?? null
  );
}

describe('the operating cashier of a drawer (DEV-821)', () => {
  it('is the named cashier, or the opener of a drawer from before DEV-821', () => {
    expect(drawerOperatingCashierId({ operatingCashierId: 'c-2', openedByActorId: 'm-1' })).toBe(
      'c-2'
    );
    expect(drawerOperatingCashierId({ operatingCashierId: null, openedByActorId: 'm-1' })).toBe(
      'm-1'
    );
  });

  it('admits the operating cashier, a manager or owner, and an enrolled device replay', () => {
    const till = { operatingCashierId: 'cashier-2', openedByActorId: 'manager-1' };
    expect(() => assertDrawerOperator(till, { actorId: 'cashier-2' }, cashier)).not.toThrow();
    expect(() => assertDrawerOperator(till, { actorId: 'manager-1' }, manager)).not.toThrow();
    expect(() =>
      assertDrawerOperator(till, { actorId: 'cashier-1' }, { kind: 'REGISTERED_DEVICE_REPLAY' })
    ).not.toThrow();
  });

  it("refuses a colleague, and fails closed when no operator is given", () => {
    const till = { operatingCashierId: 'cashier-2', openedByActorId: 'cashier-2' };
    expect(() => assertDrawerOperator(till, { actorId: 'cashier-1' }, cashier)).toThrowError(
      expect.objectContaining({ reason: 'DRAWER_NOT_YOURS' })
    );
    expect(() => assertDrawerOperator(till, { actorId: 'cashier-1' })).toThrowError(
      expect.objectContaining({ reason: 'DRAWER_NOT_YOURS' })
    );
    // Even the opener is refused once the till is handed to someone else.
    expect(() =>
      assertDrawerOperator(
        { operatingCashierId: 'cashier-3', openedByActorId: 'cashier-1' },
        { actorId: 'cashier-1' },
        cashier
      )
    ).toThrowError(expect.objectContaining({ reason: 'DRAWER_NOT_YOURS' }));
  });
});

describe('resolveOperatingPharmacyDrawer (DEV-821)', () => {
  const db = () => ({ pharmacyDrawerSession: { findFirst: vi.fn(async (args) => findTill(args)) } });

  it("resolves the caller's own till, scoped to the organization, branch, device and day", async () => {
    const fake = db();
    await expect(
      resolveOperatingPharmacyDrawer(
        fake as never,
        scope,
        { deviceId: 'device-mine', businessDate },
        cashier
      )
    ).resolves.toMatchObject({ id: 'drawer-mine' });
    expect(fake.pharmacyDrawerSession.findFirst).toHaveBeenCalledWith({
      where: {
        organizationId: 'org-1',
        branchId: 'branch-1',
        deviceId: 'device-mine',
        businessDate,
        status: 'OPEN',
      },
    });
  });

  it.each([
    ["a colleague's till on the same branch", 'device-colleague', 'DRAWER_NOT_YOURS'],
    ["a till on another branch", 'device-other-branch', 'DRAWER_NOT_OPEN'],
    ['a forged device id', 'forged-device', 'DRAWER_NOT_OPEN'],
  ])('refuses %s', async (_case, deviceId, reason) => {
    await expect(
      resolveOperatingPharmacyDrawer(db() as never, scope, { deviceId, businessDate }, cashier)
    ).rejects.toMatchObject({ reason });
  });

  it("lets a manager or owner use a colleague's till on the branch, never another branch", async () => {
    await expect(
      resolveOperatingPharmacyDrawer(
        db() as never,
        scope,
        { deviceId: 'device-colleague', businessDate },
        manager
      )
    ).resolves.toMatchObject({ id: 'drawer-colleague' });
    await expect(
      resolveOperatingPharmacyDrawer(
        db() as never,
        scope,
        { deviceId: 'device-other-branch', businessDate },
        manager
      )
    ).rejects.toMatchObject({ reason: 'DRAWER_NOT_OPEN' });
  });
});

describe('a cash sale tender goes only into a till the cashier runs (DEV-821)', () => {
  function saleFixture() {
    let idempotency: Record<string, unknown> | null = null;
    const db = {
      organization: { findUnique: vi.fn().mockResolvedValue({ timezone: 'Asia/Karachi' }) },
      branchRegulatoryProfile: { findFirst: vi.fn().mockResolvedValue(null) },
      pharmacyDailyClose: { findFirst: vi.fn().mockResolvedValue(null) },
      $executeRaw: vi.fn(async (query: { values: unknown[] }) => {
        idempotency = {
          id: 'idem-1',
          commandType: 'tender',
          payloadHash: query.values[5],
          resultPayload: null,
        };
        return 1;
      }),
      $queryRaw: vi
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ receipt_number: 7 }]),
      pharmacyMoneyIdempotencyKey: {
        findUnique: vi.fn(async () => idempotency),
        update: vi.fn(async () => idempotency),
      },
      pharmacySale: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'sale-1',
          status: 'OPEN',
          lines: [
            {
              id: 'line-1',
              organizationId: 'org-1',
              branchId: 'branch-1',
              medicineId: 'medicine-1',
              presentationId: 'presentation-1',
              quantity: 1,
              canonicalUnits: 1,
              unitPriceMinor: 100,
              discountMinor: 0,
              medicine: { organizationId: 'org-1', productName: 'Medicine', strengths: [] },
              presentation: {
                organizationId: 'org-1',
                medicineId: 'medicine-1',
                presentation: 'Tablet',
              },
              allocations: [
                {
                  id: 'allocation-1',
                  organizationId: 'org-1',
                  branchId: 'branch-1',
                  inventoryLotId: 'lot-1',
                  canonicalUnits: 1,
                  lot: {
                    organizationId: 'org-1',
                    branchId: 'branch-1',
                    batch: {
                      organizationId: 'org-1',
                      medicineId: 'medicine-1',
                      batchNumber: 'B1',
                      expiresAt: new Date('2030-01-01'),
                    },
                  },
                },
              ],
            },
          ],
          tenders: [],
        }),
        update: vi.fn().mockResolvedValue({}),
      },
      pharmacyTender: {
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
          id: 'tender-1',
          createdAt: new Date('2026-11-15T09:00:00.000Z'),
          ...data,
        })),
        findFirst: vi.fn().mockResolvedValue({ saleId: 'sale-1' }),
      },
      pharmacyDrawerSession: { findFirst: vi.fn(async (args) => findTill(args)) },
      pharmacyDrawerMovement: { create: vi.fn().mockResolvedValue({}) },
      camera: { findFirst: vi.fn().mockResolvedValue(null) },
      pharmacySaleEvent: { create: vi.fn().mockResolvedValue({}) },
    };
    return db;
  }
  const tender = (deviceId: string) => ({
    saleId: 'sale-1',
    deviceId,
    businessDate,
    type: 'CASH' as const,
    amountMinor: 100,
    cashReceivedMinor: 100,
    idempotencyKey: `cash-${deviceId}`,
  });

  it("refuses cash into a colleague's till before any tender is written", async () => {
    const db = saleFixture();
    await expect(
      applyPharmacyTender(db as never, scope, tender('device-colleague'), undefined, {
        drawerOperator: cashier,
      })
    ).rejects.toMatchObject({ reason: 'DRAWER_NOT_YOURS' });
    expect(db.pharmacyTender.create).not.toHaveBeenCalled();
    expect(db.pharmacyDrawerMovement.create).not.toHaveBeenCalled();
  });

  it('takes cash into the till the cashier runs', async () => {
    const db = saleFixture();
    await expect(
      applyPharmacyTender(db as never, scope, tender('device-mine'), undefined, {
        drawerOperator: cashier,
      })
    ).resolves.toMatchObject({ tenderId: 'tender-1' });
    expect(db.pharmacyTender.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ drawerSessionId: 'drawer-mine', actorId: 'cashier-1' }),
    });
    expect(db.pharmacyDrawerMovement.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ drawerSessionId: 'drawer-mine', kind: 'CASH_SALE' }),
    });
  });

  it("lets a manager or owner take cash into a colleague's till", async () => {
    const db = saleFixture();
    await expect(
      applyPharmacyTender(db as never, scope, tender('device-colleague'), undefined, {
        drawerOperator: manager,
      })
    ).resolves.toMatchObject({ tenderId: 'tender-1' });
    expect(db.pharmacyDrawerMovement.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ drawerSessionId: 'drawer-colleague' }),
    });
  });

  it('refuses a sale tender into a till on another branch, even for a manager', async () => {
    const db = saleFixture();
    await expect(
      applyPharmacyTender(db as never, scope, tender('device-other-branch'), undefined, {
        drawerOperator: manager,
      })
    ).rejects.toMatchObject({ reason: 'DRAWER_NOT_OPEN' });
    expect(db.pharmacyTender.create).not.toHaveBeenCalled();
  });
});

describe('a cash refund comes out of a till on the branch only (DEV-821)', () => {
  function refundFixture() {
    let payloadHash = '';
    return {
      $executeRaw: vi.fn(async (query: { values: unknown[] }) => {
        payloadHash = String(query.values[5]);
        return 1;
      }),
      $queryRaw: vi.fn().mockResolvedValue([]),
      pharmacyMoneyIdempotencyKey: {
        findUnique: vi.fn(async () => ({ id: 'idem-1', commandType: 'refund', payloadHash })),
        update: vi.fn().mockResolvedValue({}),
      },
      pharmacyTender: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'cash-tender',
          saleId: 'sale-1',
          type: 'CASH',
          amountMinor: 1000,
          refunds: [],
          sale: { customerId: null },
        }),
      },
      pharmacySale: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'sale-1',
          status: 'COMPLETED',
          lines: [
            {
              quantity: 10,
              unitPriceMinor: 100,
              discountMinor: 0,
              canonicalUnits: 10,
              unidentifiedReturnHolds: [],
              returnLines: [{ canonicalUnits: 5 }],
            },
          ],
          refunds: [],
        }),
      },
      pharmacyDrawerSession: { findFirst: vi.fn(async (args) => findTill(args)) },
      pharmacyDailyClose: { findFirst: vi.fn().mockResolvedValue(null) },
      organization: { findUnique: vi.fn().mockResolvedValue({ timezone: 'Asia/Karachi' }) },
      pharmacyRefund: {
        create: vi.fn(async ({ data }) => ({ id: 'refund-1', ...data })),
        findFirst: vi.fn().mockResolvedValue({ saleId: 'sale-1' }),
      },
      pharmacyDrawerMovement: { create: vi.fn().mockResolvedValue({}) },
      camera: { findFirst: vi.fn().mockResolvedValue(null) },
    };
  }
  const refund = (deviceId: string) => ({
    originalTenderId: 'cash-tender',
    deviceId,
    businessDate,
    amountMinor: 100,
    reason: 'Returned medicine',
    idempotencyKey: `refund-${deviceId}`,
  });

  it("refuses a refund out of a colleague's till without a manager decision", async () => {
    const db = refundFixture();
    await expect(
      refundPharmacyTender(db as never, scope, refund('device-colleague'))
    ).rejects.toMatchObject({ reason: 'DRAWER_NOT_YOURS' });
    expect(db.pharmacyRefund.create).not.toHaveBeenCalled();
  });

  it("pays a manager's refund out of any till on the branch, never another branch", async () => {
    const db = refundFixture();
    await expect(
      refundPharmacyTender(db as never, scope, refund('device-colleague'), {
        drawerOperator: manager,
      })
    ).resolves.toMatchObject({ refundId: 'refund-1' });
    expect(db.pharmacyDrawerSession.findFirst).toHaveBeenCalledWith({
      where: expect.objectContaining({ organizationId: 'org-1', branchId: 'branch-1' }),
    });
    await expect(
      refundPharmacyTender(db as never, scope, refund('device-other-branch'), {
        drawerOperator: manager,
      })
    ).rejects.toMatchObject({ reason: 'DRAWER_NOT_OPEN' });
  });
});

describe('opening a till for a named cashier (DEV-821)', () => {
  const input = { deviceId: 'device-new', businessDate, openingFloatMinor: 500 };
  const managerScope = { ...scope, actorId: 'manager-1' };
  function fixture(assigned: boolean) {
    counterGate.counterOperatorDenial.mockResolvedValue(assigned ? null : 'branch_forbidden');
    return {
      $queryRaw: vi.fn().mockResolvedValue([]),
      pharmacyDailyClose: { findFirst: vi.fn().mockResolvedValue(null) },
      user: {
        findFirst: vi.fn(async ({ where }: { where: { id: string } }) => ({
          id: where.id,
          role: 'EMPLOYEE',
          department: null,
          status: 'ACTIVE',
        })),
      },
      pharmacyDrawerSession: {
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn(async ({ data }) => ({ id: 'drawer-new', ...data })),
      },
      pharmacyDrawerMovement: { create: vi.fn().mockResolvedValue({}) },
    };
  }

  it('runs the till by its opener unless someone else is named', async () => {
    const db = fixture(true);
    await openPharmacyDrawer(db as never, managerScope, input);
    expect(db.pharmacyDrawerSession.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        openedByActorId: 'manager-1',
        operatingCashierId: 'manager-1',
      }),
    });
    expect(counterGate.counterOperatorDenial).not.toHaveBeenCalled();
  });

  it('lets the opener name a cashier who passes the counter gate of this branch', async () => {
    const db = fixture(true);
    await openPharmacyDrawer(db as never, managerScope, {
      ...input,
      operatingCashierId: 'cashier-1',
    });
    expect(db.user.findFirst).toHaveBeenCalledWith({
      where: { id: 'cashier-1', organizationId: 'org-1' },
      select: { id: true, role: true, department: true, status: true },
    });
    // The counter grant, an active membership with a deny-wins counter ALLOW, and an
    // active assignment to this branch: the same gate the counter itself applies.
    expect(counterGate.counterOperatorDenial).toHaveBeenCalledWith(
      db,
      { id: 'cashier-1', role: 'EMPLOYEE', department: null, status: 'ACTIVE' },
      'org-1',
      'branch-1',
      { source: 'TRPC' }
    );
    expect(db.pharmacyDrawerSession.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        openedByActorId: 'manager-1',
        operatingCashierId: 'cashier-1',
      }),
    });
  });

  it.each([
    ['not on the branch', 'branch_forbidden'],
    ['without the counter capability', 'forbidden'],
  ])('refuses a cashier %s before opening anything', async (_case, denial) => {
    const db = fixture(false);
    counterGate.counterOperatorDenial.mockResolvedValue(denial);
    await expect(
      openPharmacyDrawer(db as never, managerScope, { ...input, operatingCashierId: 'stranger' })
    ).rejects.toMatchObject({ reason: 'CASHIER_NOT_ASSIGNED' });
    expect(db.pharmacyDrawerSession.create).not.toHaveBeenCalled();
    expect(db.pharmacyDrawerMovement.create).not.toHaveBeenCalled();
  });

  it('refuses someone who is not a member of this organization', async () => {
    const db = fixture(true);
    db.user.findFirst.mockResolvedValue(null as never);
    await expect(
      openPharmacyDrawer(db as never, managerScope, { ...input, operatingCashierId: 'outsider' })
    ).rejects.toMatchObject({ reason: 'CASHIER_NOT_ASSIGNED' });
    expect(counterGate.counterOperatorDenial).not.toHaveBeenCalled();
    expect(db.pharmacyDrawerSession.create).not.toHaveBeenCalled();
  });
});

describe('handing an open till to another cashier (DEV-821)', () => {
  const managerScope = { ...scope, actorId: 'manager-1' };
  function fixture(options: { assigned?: boolean; open?: boolean } = {}) {
    const till = { ...tills[0]! };
    counterGate.counterOperatorDenial.mockResolvedValue(
      options.assigned === false ? 'branch_forbidden' : null
    );
    return {
      $queryRaw: vi.fn().mockResolvedValue([]),
      pharmacyDailyClose: { findFirst: vi.fn().mockResolvedValue(null) },
      user: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'cashier-2',
          role: 'EMPLOYEE',
          department: null,
          status: 'ACTIVE',
        }),
      },
      pharmacyDrawerSession: {
        findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
          options.open === false && where.status === 'OPEN' ? null : till
        ),
        update: vi.fn(async ({ data }) => ({ ...till, ...data })),
      },
      pharmacyDrawerHandover: {
        create: vi.fn(async ({ data }) => ({ id: 'handover-1', ...data })),
      },
    };
  }
  const handover = { drawerSessionId: 'drawer-mine', toCashierId: 'cashier-2', reason: ' Shift ' };

  it('records who handed the till to whom and why, then moves the till', async () => {
    const db = fixture();
    const result = await handoverPharmacyDrawer(db as never, managerScope, handover);
    expect(db.pharmacyDrawerHandover.create).toHaveBeenCalledWith({
      data: {
        organizationId: 'org-1',
        drawerSessionId: 'drawer-mine',
        fromCashierId: 'cashier-1',
        toCashierId: 'cashier-2',
        actorId: 'manager-1',
        reason: 'Shift',
      },
    });
    expect(db.pharmacyDrawerSession.update).toHaveBeenCalledWith({
      where: { organizationId_id: { organizationId: 'org-1', id: 'drawer-mine' } },
      data: { operatingCashierId: 'cashier-2' },
    });
    expect(result.handover).toMatchObject({ id: 'handover-1' });
    expect(result.drawer).toMatchObject({ operatingCashierId: 'cashier-2' });
    // Under the same day lock a close takes.
    expect(db.$queryRaw).toHaveBeenCalled();
  });

  it('refuses a cashier who is not on the branch, writing nothing', async () => {
    const db = fixture({ assigned: false });
    await expect(handoverPharmacyDrawer(db as never, managerScope, handover)).rejects.toMatchObject(
      { reason: 'CASHIER_NOT_ASSIGNED' }
    );
    expect(db.pharmacyDrawerHandover.create).not.toHaveBeenCalled();
    expect(db.pharmacyDrawerSession.update).not.toHaveBeenCalled();
  });

  it('refuses a closed till and a handover without a reason', async () => {
    await expect(
      handoverPharmacyDrawer(fixture({ open: false }) as never, managerScope, handover)
    ).rejects.toMatchObject({ reason: 'DRAWER_NOT_OPEN' });
    const db = fixture();
    await expect(
      handoverPharmacyDrawer(db as never, managerScope, { ...handover, reason: '  ' })
    ).rejects.toMatchObject({ reason: 'INVALID_AMOUNT' });
    expect(db.pharmacyDrawerHandover.create).not.toHaveBeenCalled();
  });

  it('records nothing when the till already runs under that cashier', async () => {
    const db = fixture();
    await expect(
      handoverPharmacyDrawer(db as never, managerScope, { ...handover, toCashierId: 'cashier-1' })
    ).resolves.toMatchObject({ handover: null });
    expect(db.pharmacyDrawerHandover.create).not.toHaveBeenCalled();
    expect(db.pharmacyDrawerSession.update).not.toHaveBeenCalled();
  });
});

describe('close reports flag cash moved by anyone but the till cashier (DEV-821)', () => {
  const at = (minute: number) => new Date(Date.UTC(2026, 10, 15, 9, minute));
  const movement = (id: string, kind: string, actorId: string, minute: number) => ({
    id,
    kind,
    amountMinor: 100,
    actorId,
    createdAt: at(minute),
  });

  it("follows the handovers and leaves out the open and the close", () => {
    const flagged = movementsByOtherThanOperator(
      { operatingCashierId: 'cashier-2', openedByActorId: 'manager-1' },
      [
        movement('float', 'OPENING_FLOAT', 'manager-1', 0),
        movement('own-sale', 'CASH_SALE', 'cashier-1', 5),
        movement('colleague-sale', 'CASH_SALE', 'cashier-2', 10),
        movement('manager-payout', 'PAID_OUT', 'manager-1', 20),
        movement('after-handover', 'CASH_SALE', 'cashier-2', 40),
        movement('late-old-cashier', 'PAID_IN', 'cashier-1', 50),
        movement('count', 'CLOSING_COUNT', 'manager-1', 59),
      ],
      [{ fromCashierId: 'cashier-1', toCashierId: 'cashier-2', createdAt: at(30) }]
    );
    expect(flagged.map((m) => m.id)).toEqual([
      'colleague-sale',
      'manager-payout',
      'late-old-cashier',
    ]);
  });

  it('flags nothing on a till only its cashier used', () => {
    expect(
      movementsByOtherThanOperator(
        { operatingCashierId: null, openedByActorId: 'cashier-1' },
        [movement('sale', 'CASH_SALE', 'cashier-1', 5)],
        []
      )
    ).toEqual([]);
  });

  it('returns the flagged movements with the drawer-close result', async () => {
    const db = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      pharmacyDailyClose: { findFirst: vi.fn().mockResolvedValue(null) },
      pharmacyDrawerSession: {
        findFirst: vi.fn().mockResolvedValue({
          ...tills[0],
          movements: [
            movement('own', 'CASH_SALE', 'cashier-1', 5),
            movement('colleague', 'CASH_SALE', 'cashier-2', 6),
          ],
          handovers: [],
        }),
        update: vi.fn(async ({ data }) => ({ ...tills[0], ...data })),
      },
      pharmacyDrawerMovement: { create: vi.fn().mockResolvedValue({}) },
    };
    const result = await closePharmacyDrawer(db as never, scope, {
      drawerSessionId: 'drawer-mine',
      countedCashMinor: 200,
    });
    expect(result.otherOperatorMovements.map((m) => m.id)).toEqual(['colleague']);
    expect(db.pharmacyDrawerSession.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ include: { movements: true, handovers: true } })
    );
  });
});

beforeEach(() => {
  vi.clearAllMocks();
  counterGate.counterOperatorDenial.mockResolvedValue(null);
});
