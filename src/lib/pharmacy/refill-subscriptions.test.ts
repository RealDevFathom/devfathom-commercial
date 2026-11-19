import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// DEV-879: these fixtures model an approver with no approval authenticator, so the PIN is
// checked exactly as before. approval-authenticator.test.ts covers the authenticator path.
vi.mock('@/lib/approval-authenticator', async () => {
  const { verifyOperatorCredential } = await import('@/lib/restaurant/operator-credentials');
  return {
    verifyApprovalSecret: async (
      _db: unknown,
      input: { secret: string; credentialHash: string }
    ) =>
      (await verifyOperatorCredential('PIN', input.secret, input.credentialHash)) ? 'PIN' : null,
  };
});
// The approver rule is `rxReviewSignerDenial`, which also builds the subject from the row.
vi.mock('@/lib/abac', () => ({
  can: vi.fn(),
  subjectFromSession: (user: {
    id: string;
    role?: string | null;
    department?: string | null;
    status?: string | null;
  }) => ({
    id: user.id,
    role: user.role ?? 'EMPLOYEE',
    department: user.department ?? null,
    status: user.status ?? null,
  }),
}));
vi.mock('@/lib/restaurant/operator-credentials', () => ({
  verifyOperatorCredential: vi.fn(),
  isLockedOut: vi.fn(() => false),
  clearLockout: () => ({ failedAttempts: 0 }),
  registerFailedAttempt: () => ({ failedAttempts: 1 }),
}));
vi.mock('./sales', () => ({
  createSale: vi.fn(async () => ({ id: 'sale-1' })),
  addReservedSaleLine: vi.fn(async () => ({ line: { id: 'sale-line-1' } })),
}));

import { can } from '@/lib/abac';
import { verifyOperatorCredential } from '@/lib/restaurant/operator-credentials';

import {
  approveRefillCycle,
  createRefillSubscription,
  isSubscribableMedicine,
  listDueRefillSubscriptionIds,
  openRefillCycle,
  RefillCycleApprovalDenied,
  refillSubscriptionReminder,
  refillSubscriptionReminderDue,
  REFILL_SUBSCRIPTION_DEFAULTS,
  RefillSubscriptionError,
  startRefillCycleCheckout,
  verifyRefillCyclePharmacistPin,
} from './refill-subscriptions';
import { addReservedSaleLine, createSale } from './sales';

const scope = { organizationId: 'org', branchId: 'branch', actorId: 'cashier' };
const DUE = new Date('2026-12-01T05:00:00.000Z');

const otc = { saleable: true, otc: true, rx: false, restricted: false, controlled: false };

function medicine(flags: Partial<typeof otc> = {}) {
  return {
    id: 'med-1',
    productName: 'Metformin 500',
    ...otc,
    ...flags,
    presentations: [{ id: 'pres-1', packLevels: [{ id: 'pack-1' }] }],
  };
}

function lot(availableUnits: number) {
  return {
    inventoryLotId: 'lot-1',
    stockLocationId: 'loc-1',
    organizationId: 'org',
    branchId: 'branch',
    batchState: 'ACTIVE',
    disposition: 'AVAILABLE',
    expiresAt: new Date('2030-01-01T00:00:00.000Z'),
    receivedAt: new Date('2026-01-01T00:00:00.000Z'),
    packLevelId: 'pack-1',
    availableUnits,
    unitsPerPack: 10,
    printedMrpMinor: 50_000,
  };
}

const subscriptionRow = {
  id: 'sub-1',
  organizationId: 'org',
  branchId: 'branch',
  customerId: 'cust-1',
  medicineId: 'med-1',
  presentationId: 'pres-1',
  packLevelId: 'pack-1',
  packsPerCycle: 3,
  cycleDays: 30,
  reminderLeadDays: 3,
  paymentMode: 'KHATA',
  nextDueAt: DUE,
  status: 'ACTIVE',
};

type RxLine = {
  id: string;
  medicineId: string;
  presentationId: string;
  authorizedCanonicalUnits: number;
  prescription: { patientId: string; validFrom: Date; validUntil: Date; authorizedRepeats: number };
  fills: { quantityCanonicalUnits: number }[];
};

/** A prescription line for the subscriber's patient that covers the DUE cycle. */
function rxLine(
  overrides: Partial<Omit<RxLine, 'prescription'>> & {
    prescription?: Partial<RxLine['prescription']>;
  } = {}
): RxLine {
  return {
    id: 'rx-line-1',
    medicineId: 'med-1',
    presentationId: 'pres-1',
    authorizedCanonicalUnits: 180,
    fills: [],
    ...overrides,
    prescription: {
      patientId: 'patient-1',
      validFrom: new Date('2026-11-01T00:00:00.000Z'),
      validUntil: new Date('2027-04-30T00:00:00.000Z'),
      authorizedRepeats: 5,
      ...overrides.prescription,
    },
  };
}

function fakeDb(
  options: {
    medicine?: ReturnType<typeof medicine> | null;
    lots?: ReturnType<typeof lot>[];
    creditLimitMinor?: number;
    cycle?: Record<string, unknown> | null;
    rxLine?: ReturnType<typeof rxLine> | null;
    dayClose?: { id: string; reopen: { id: string } | null } | null;
  } = {}
) {
  const writes: Array<[string, unknown]> = [];
  const record =
    (name: string, result: unknown = {}) =>
    async (input: unknown) => {
      writes.push([name, input]);
      return typeof result === 'function' ? (result as (i: unknown) => unknown)(input) : result;
    };
  const db = {
    $queryRaw: vi.fn(async (query: { sql?: string; strings?: string[] }) => {
      const sql = query.sql ?? query.strings?.join('?') ?? '';
      return sql.includes('pharmacy_stock_balances') ? (options.lots ?? [lot(100)]) : [];
    }),
    medicine: {
      findFirst: async () => (options.medicine === undefined ? medicine() : options.medicine),
    },
    // DEV-631: today's business day, and whether its latest close still stands.
    organization: { findUnique: async () => ({ timezone: 'UTC' }) },
    pharmacyDailyClose: { findFirst: vi.fn(async () => options.dayClose ?? null) },
    pharmacyCustomer: {
      findFirst: async () => ({
        id: 'cust-1',
        patientId: 'patient-1',
        creditLimitMinor: options.creditLimitMinor ?? 0,
      }),
    },
    prescriptionLine: {
      findFirst: vi.fn(
        async ({
          where,
        }: {
          where: { id: string; medicineId: string; presentationId: string };
        }) => {
          const line = options.rxLine === undefined ? rxLine() : options.rxLine;
          return line &&
            line.id === where.id &&
            line.medicineId === where.medicineId &&
            line.presentationId === where.presentationId
            ? line
            : null;
        }
      ),
    },
    pharmacySaleLine: { updateMany: record('saleLine.updateMany', { count: 1 }) },
    pharmacyPharmacistReviewItem: { create: record('reviewItem.create') },
    pharmacyRefillSubscription: {
      findFirst: async () => subscriptionRow,
      create: record('subscription.create', (input: { data: object }) => input.data),
      update: record('subscription.update'),
    },
    pharmacyRefillSubscriptionCycle: {
      findFirst: vi.fn(async ({ include }: { include?: unknown } = {}) =>
        include ? (options.cycle ?? null) : null
      ),
      create: record('cycle.create', (input: { data: object }) => ({
        id: 'cycle-1',
        ...input.data,
      })),
      update: record('cycle.update', (input: { data: object }) => input.data),
    },
    unfulfilledDemandEvent: {
      create: record('demand.create', { id: 'demand-1' }),
      updateMany: record('demand.updateMany', { count: 1 }),
    },
    pharmacyRestockInterest: {
      create: record('interest.create', { id: 'interest-1' }),
      findMany: async () => [{ id: 'interest-1', demandEventId: 'demand-1' }],
      updateMany: record('interest.updateMany', { count: 1 }),
    },
    pharmacyRestockReservation: {
      create: record('reservation.create'),
      updateMany: record('reservation.updateMany', { count: 1 }),
      findMany: async () => [
        { inventoryLotId: 'lot-1', stockLocationId: 'loc-1', reservedUnits: 20 },
        { inventoryLotId: 'lot-2', stockLocationId: 'loc-1', reservedUnits: 10 },
      ],
    },
    pharmacySale: { update: record('sale.update') },
    user: {
      findFirst: async () => ({ id: 'pharmacist', organizationId: 'org', status: 'ACTIVE' }),
    },
    // DEV-941: the pharmacist works at this branch.
    pharmacyBranchAssignment: {
      findFirst: vi.fn(async ({ where }: { where: { userId: string; branchId: string } }) =>
        where.userId === 'pharmacist' && where.branchId === 'branch' ? { branchId: 'branch' } : null
      ),
    },
    restaurantOperatorCredential: {
      findFirst: vi.fn(async () => ({
        id: 'cred-1',
        credentialHash: 'hash',
        staffProfile: {
          status: 'ACTIVE',
          user: { id: 'pharmacist', organizationId: 'org', status: 'ACTIVE' },
        },
      })),
      update: record('credential.update'),
    },
    auditLog: { create: record('audit.create') },
  };
  return { db, writes };
}

const createInput = {
  customerId: 'cust-1',
  medicineId: 'med-1',
  presentationId: 'pres-1',
  packLevelId: 'pack-1',
  packsPerCycle: 3,
  fulfillment: 'COLLECT' as const,
  paymentMode: 'PREPAY' as const,
  firstDueAt: DUE,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('DEV-73 subscription eligibility and schedule', () => {
  it('accepts Rx and OTC chronic medicine but never controlled or restricted medicine', () => {
    expect(isSubscribableMedicine(otc)).toBe(true);
    const rxOnly: typeof otc = { ...otc, otc: false, rx: true };
    expect(isSubscribableMedicine(rxOnly)).toBe(true);
    expect(isSubscribableMedicine({ ...otc, controlled: true })).toBe(false);
    expect(isSubscribableMedicine({ ...otc, restricted: true })).toBe(false);
    expect(isSubscribableMedicine({ ...otc, saleable: false })).toBe(false);
  });

  it('refuses a controlled medicine on the server', async () => {
    const { db } = fakeDb({ medicine: medicine({ controlled: true }) });
    await expect(createRefillSubscription(db as never, scope, createInput)).rejects.toMatchObject({
      reason: 'ITEM_NOT_SUBSCRIBABLE',
    });
  });

  it('refuses khata for a customer the pharmacy extends no credit to', async () => {
    const { db } = fakeDb({ creditLimitMinor: 0 });
    await expect(
      createRefillSubscription(db as never, scope, { ...createInput, paymentMode: 'KHATA' })
    ).rejects.toMatchObject({ reason: 'KHATA_NOT_AVAILABLE' });
    const allowed = fakeDb({ creditLimitMinor: 500_000 });
    await expect(
      createRefillSubscription(allowed.db as never, scope, {
        ...createInput,
        paymentMode: 'KHATA',
      })
    ).resolves.toMatchObject({ paymentMode: 'KHATA' });
  });

  it('takes cycle length and reminder lead time as configurable values with stated defaults', async () => {
    const { db } = fakeDb();
    await expect(createRefillSubscription(db as never, scope, createInput)).resolves.toMatchObject(
      REFILL_SUBSCRIPTION_DEFAULTS
    );
    await expect(
      createRefillSubscription(db as never, scope, {
        ...createInput,
        cycleDays: 28,
        reminderLeadDays: 5,
      })
    ).resolves.toMatchObject({ cycleDays: 28, reminderLeadDays: 5 });
    await expect(
      createRefillSubscription(db as never, scope, { ...createInput, reminderLeadDays: 30 })
    ).rejects.toMatchObject({ reason: 'INVALID_SCHEDULE' });
  });
});

describe('DEV-73 opening a cycle reserves stock and creates the due order', () => {
  it('holds the cycle units with a DEM-03 reservation and advances the next due date', async () => {
    const { db, writes } = fakeDb();
    const cycle = await openRefillCycle(db as never, scope, 'sub-1');

    expect(cycle).toMatchObject({
      status: 'RESERVED',
      requiresPharmacist: false,
      canonicalUnits: 30,
      dueAt: DUE,
    });
    const byName = (name: string) => writes.filter(([n]) => n === name).map(([, v]) => v);
    expect(byName('interest.create')).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({ campaignKey: 'refill-cycle:cycle-1', quantityUnits: 30 }),
      }),
    ]);
    expect(byName('reservation.create')).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({ inventoryLotId: 'lot-1', reservedUnits: 30 }),
      }),
    ]);
    expect(byName('subscription.update')).toEqual([
      expect.objectContaining({ data: { nextDueAt: new Date('2026-12-31T05:00:00.000Z') } }),
    ]);
  });

  it('opens a prescription-only cycle as awaiting the pharmacist', async () => {
    const { db } = fakeDb({ medicine: medicine({ otc: false, rx: true }) });
    await expect(openRefillCycle(db as never, scope, 'sub-1')).resolves.toMatchObject({
      status: 'AWAITING_PHARMACIST',
      requiresPharmacist: true,
    });
  });

  it('refuses to open a cycle the shelf cannot cover', async () => {
    const { db, writes } = fakeDb({ lots: [lot(12)] });
    await expect(openRefillCycle(db as never, scope, 'sub-1')).rejects.toMatchObject({
      reason: 'INSUFFICIENT_STOCK',
    });
    expect(writes.some(([name]) => name === 'reservation.create')).toBe(false);
  });
});

const COVERING = { prescriptionLineId: 'rx-line-1' };

describe('DEV-73 Rx cycle pharmacist approval', () => {
  // The cycle is due 2026-12-01; the pharmacist acts during its reminder window.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-29T06:00:00.000Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const awaiting = {
    id: 'cycle-1',
    branchId: 'branch',
    status: 'AWAITING_PHARMACIST',
    requiresPharmacist: true,
    openedByUserId: 'cashier',
    canonicalUnits: 30,
    approvedByUserId: null,
    approvedAt: null,
    counterSaleId: null,
    subscription: subscriptionRow,
  };

  it('refuses checkout of an Rx cycle no pharmacist has approved', async () => {
    const { db } = fakeDb({ cycle: awaiting });
    await expect(startRefillCycleCheckout(db as never, scope, 'cycle-1')).rejects.toMatchObject({
      reason: 'PHARMACIST_APPROVAL_REQUIRED',
    });
    expect(createSale).not.toHaveBeenCalled();
  });

  it('refuses a PIN that does not belong to a pharmacist, without touching the credential', async () => {
    vi.mocked(can).mockResolvedValue(false);
    const { db, writes } = fakeDb();
    await expect(
      verifyRefillCyclePharmacistPin(db as never, scope, { staffProfileId: 's', pin: '1234' })
    ).resolves.toBeNull();
    expect(writes.some(([name]) => name === 'credential.update')).toBe(false);
    expect(verifyOperatorCredential).not.toHaveBeenCalled();
  });

  it('records a failed attempt for a wrong pharmacist PIN', async () => {
    vi.mocked(can).mockResolvedValue(true);
    vi.mocked(verifyOperatorCredential).mockResolvedValue(false);
    const { db, writes } = fakeDb();
    await expect(
      verifyRefillCyclePharmacistPin(db as never, scope, { staffProfileId: 's', pin: '9999' })
    ).resolves.toBeNull();
    expect(writes).toContainEqual([
      'credential.update',
      { where: { id: 'cred-1' }, data: { failedAttempts: 1 } },
    ]);
  });

  it('approves with a fresh pharmacist PIN and writes the audit record', async () => {
    vi.mocked(can).mockResolvedValue(true);
    vi.mocked(verifyOperatorCredential).mockResolvedValue(true);
    const { db, writes } = fakeDb({ cycle: awaiting });
    const approval = await verifyRefillCyclePharmacistPin(db as never, scope, {
      staffProfileId: 's',
      pin: '1234',
    });
    expect(approval).toEqual({ approvedByUserId: 'pharmacist', credentialId: 'cred-1' });

    await expect(
      approveRefillCycle(db as never, scope, 'cycle-1', approval!, COVERING)
    ).resolves.toMatchObject({
      status: 'RESERVED',
      approvedByUserId: 'pharmacist',
      approvalPolicy: 'PHARMACIST_PIN_REAUTH',
      selfApproved: false,
    });
    expect(writes).toContainEqual([
      'audit.create',
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'pharmacy.refillCycle.pharmacistApproval',
          targetId: 'cycle-1',
          metadata: expect.objectContaining({ pinVerified: true, approverId: 'pharmacist' }),
        }),
      }),
    ]);
  });

  it('lets a solo owner-pharmacist self-approve with their own PIN, recorded as self-approved', async () => {
    vi.mocked(can).mockResolvedValue(true);
    const { db, writes } = fakeDb({ cycle: { ...awaiting, openedByUserId: 'pharmacist' } });
    await expect(
      approveRefillCycle(
        db as never,
        scope,
        'cycle-1',
        { approvedByUserId: 'pharmacist', credentialId: 'cred-1' },
        COVERING
      )
    ).resolves.toMatchObject({ selfApproved: true, status: 'RESERVED' });
    expect(writes).toContainEqual([
      'audit.create',
      expect.objectContaining({
        data: expect.objectContaining({
          metadata: expect.objectContaining({ selfApproved: true }),
        }),
      }),
    ]);
  });

  it('refuses an approver who no longer holds the dispensing capability', async () => {
    vi.mocked(can).mockResolvedValue(false);
    const { db } = fakeDb({ cycle: awaiting });
    await expect(
      approveRefillCycle(
        db as never,
        scope,
        'cycle-1',
        { approvedByUserId: 'pharmacist', credentialId: 'cred-1' },
        COVERING
      )
    ).rejects.toBeInstanceOf(RefillCycleApprovalDenied);
  });

  it('DEV-941: refuses the PIN of a pharmacist not assigned to the cycle’s branch, and writes nothing', async () => {
    vi.mocked(can).mockResolvedValue(true);
    const { db, writes } = fakeDb({ cycle: awaiting });
    db.user.findFirst = async () => ({
      id: 'elsewhere',
      organizationId: 'org',
      status: 'ACTIVE',
    });
    await expect(
      approveRefillCycle(
        db as never,
        scope,
        'cycle-1',
        { approvedByUserId: 'elsewhere', credentialId: 'cred-1' },
        COVERING
      )
    ).rejects.toMatchObject({
      name: 'RefillCycleApprovalDenied',
      reason: 'BRANCH',
      message:
        'This pharmacist is not assigned to this branch. Only a pharmacist assigned to this branch can approve its refills.',
    });
    expect(db.pharmacyBranchAssignment.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organizationId: 'org',
          userId: 'elsewhere',
          branchId: 'branch',
          active: true,
        }),
      })
    );
    expect(writes.some(([name]) => name === 'cycle.update' || name === 'audit.create')).toBe(false);
  });

  it('DEV-941: accepts an organisation admin’s PIN at a branch they hold no assignment to', async () => {
    vi.mocked(can).mockResolvedValue(true);
    const { db } = fakeDb({ cycle: awaiting });
    db.user.findFirst = async () => ({
      id: 'admin',
      organizationId: 'org',
      status: 'ACTIVE',
      role: 'ADMIN',
    });
    await expect(
      approveRefillCycle(
        db as never,
        scope,
        'cycle-1',
        { approvedByUserId: 'admin', credentialId: 'cred-1' },
        COVERING
      )
    ).resolves.toMatchObject({ status: 'RESERVED', approvedByUserId: 'admin' });
  });

  it("DEV-631: refuses checkout while today's business day is closed, before any hold is consumed", async () => {
    vi.mocked(can).mockResolvedValue(true);
    const approved = {
      ...awaiting,
      status: 'RESERVED',
      approvedByUserId: 'pharmacist',
      approvedAt: new Date(),
      prescriptionLineId: 'rx-line-1',
    };
    const { db, writes } = fakeDb({
      cycle: approved,
      medicine: medicine({ rx: true }),
      dayClose: { id: 'close-1', reopen: null },
    });
    await expect(startRefillCycleCheckout(db as never, scope, 'cycle-1')).rejects.toMatchObject({
      reason: 'DAY_CLOSED',
    });
    expect(createSale).not.toHaveBeenCalled();
    expect(addReservedSaleLine).not.toHaveBeenCalled();
    expect(writes.some(([name]) => name === 'reservation.updateMany')).toBe(false);
    expect(writes.some(([name]) => name === 'cycle.update')).toBe(false);
  });

  it('DEV-631: checks out a cycle again once the day is reopened for trading', async () => {
    vi.mocked(can).mockResolvedValue(true);
    const approved = {
      ...awaiting,
      status: 'RESERVED',
      approvedByUserId: 'pharmacist',
      approvedAt: new Date(),
      prescriptionLineId: 'rx-line-1',
    };
    const { db } = fakeDb({
      cycle: approved,
      medicine: medicine({ rx: true }),
      dayClose: { id: 'close-1', reopen: { id: 'reopen-1' } },
    });
    await expect(startRefillCycleCheckout(db as never, scope, 'cycle-1')).resolves.toMatchObject({
      saleId: 'sale-1',
      replayed: false,
    });
  });

  it('hands an approved cycle to the counter with exactly the lots it holds', async () => {
    vi.mocked(can).mockResolvedValue(true);
    const approved = {
      ...awaiting,
      status: 'RESERVED',
      approvedByUserId: 'pharmacist',
      approvedAt: new Date(),
      prescriptionLineId: 'rx-line-1',
    };
    const { db, writes } = fakeDb({ cycle: approved, medicine: medicine({ rx: true }) });
    await expect(startRefillCycleCheckout(db as never, scope, 'cycle-1')).resolves.toEqual({
      saleId: 'sale-1',
      replayed: false,
      paymentMode: 'KHATA',
    });
    expect(addReservedSaleLine).toHaveBeenCalledWith(
      db,
      scope,
      expect.objectContaining({ quantity: 3, canonicalUnitsPerSaleUnit: 10, saleUnit: 'PACK' }),
      expect.objectContaining({
        pharmacistApprovedRx: true,
        allocations: [
          { inventoryLotId: 'lot-1', stockLocationId: 'loc-1', units: 20 },
          { inventoryLotId: 'lot-2', stockLocationId: 'loc-1', units: 10 },
        ],
      })
    );
    expect(writes).toContainEqual([
      'reservation.updateMany',
      expect.objectContaining({ data: expect.objectContaining({ status: 'CONSUMED' }) }),
    ]);
    expect(writes).toContainEqual([
      'sale.update',
      expect.objectContaining({ data: { customerId: 'cust-1' } }),
    ]);
  });

  it('refuses a cashier without the dispensing grant at an Rx checkout', async () => {
    vi.mocked(can).mockResolvedValue(false);
    const approved = {
      ...awaiting,
      status: 'RESERVED',
      approvedByUserId: 'pharmacist',
      approvedAt: new Date(),
      prescriptionLineId: 'rx-line-1',
    };
    const { db } = fakeDb({ cycle: approved, medicine: medicine({ rx: true }) });
    await expect(startRefillCycleCheckout(db as never, scope, 'cycle-1')).rejects.toThrow(
      /pharmacist dispensing permission/
    );
    expect(createSale).not.toHaveBeenCalled();
  });

  describe('a medicine reclassified as prescription-only after the cycle opened', () => {
    const openedAsOtc = {
      ...awaiting,
      status: 'RESERVED',
      requiresPharmacist: false,
    };

    it('refuses checkout until a pharmacist approves', async () => {
      vi.mocked(can).mockResolvedValue(true);
      const { db } = fakeDb({ cycle: openedAsOtc, medicine: medicine({ otc: false, rx: true }) });
      await expect(startRefillCycleCheckout(db as never, scope, 'cycle-1')).rejects.toMatchObject({
        reason: 'PHARMACIST_APPROVAL_REQUIRED',
      });
      expect(createSale).not.toHaveBeenCalled();
    });

    it('takes the same PIN approval, which marks the cycle as prescription-only', async () => {
      vi.mocked(can).mockResolvedValue(true);
      const { db } = fakeDb({ cycle: openedAsOtc, medicine: medicine({ otc: false, rx: true }) });
      await expect(
        approveRefillCycle(
          db as never,
          scope,
          'cycle-1',
          { approvedByUserId: 'pharmacist', credentialId: 'cred-1' },
          COVERING
        )
      ).resolves.toMatchObject({ requiresPharmacist: true, approvedByUserId: 'pharmacist' });
    });

    it('still refuses approval of an OTC cycle that needs none', async () => {
      vi.mocked(can).mockResolvedValue(true);
      const { db } = fakeDb({ cycle: openedAsOtc });
      await expect(
        approveRefillCycle(
          db as never,
          scope,
          'cycle-1',
          { approvedByUserId: 'pharmacist', credentialId: 'cred-1' },
          COVERING
        )
      ).rejects.toMatchObject({ reason: 'INVALID_STATE' });
    });
  });
});

describe('DEV-73 an Rx cycle is held until a valid prescription covers it and a pharmacist signs', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-29T06:00:00.000Z'));
    vi.mocked(can).mockResolvedValue(true);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const awaiting = {
    id: 'cycle-1',
    branchId: 'branch',
    status: 'AWAITING_PHARMACIST',
    requiresPharmacist: true,
    openedByUserId: 'cashier',
    canonicalUnits: 30,
    dueAt: DUE,
    approvedByUserId: null,
    approvedAt: null,
    prescriptionLineId: null,
    counterSaleId: null,
    subscription: subscriptionRow,
  };
  const approval = { approvedByUserId: 'pharmacist', credentialId: 'cred-1' };

  async function refusedApproval(
    options: Parameters<typeof fakeDb>[0],
    prescriptionLineId: string,
    reason: string
  ) {
    const { db, writes } = fakeDb({ cycle: awaiting, ...options });
    await expect(
      approveRefillCycle(db as never, scope, 'cycle-1', approval, { prescriptionLineId })
    ).rejects.toMatchObject({ reason });
    // The cycle stays held: no approval is written and nothing is audited as approved.
    expect(writes.some(([name]) => name === 'cycle.update')).toBe(false);
    expect(writes.some(([name]) => name === 'audit.create')).toBe(false);
  }

  it('refuses a pharmacist PIN approval that names no prescription', async () => {
    await refusedApproval({}, '', 'PRESCRIPTION_REQUIRED');
  });

  it('refuses a prescription line for another medicine or presentation', async () => {
    await refusedApproval(
      { rxLine: rxLine({ medicineId: 'med-2' }) },
      'rx-line-1',
      'PRESCRIPTION_NOT_FOUND'
    );
    await refusedApproval(
      { rxLine: rxLine({ presentationId: 'pres-2' }) },
      'rx-line-1',
      'PRESCRIPTION_NOT_FOUND'
    );
  });

  it("refuses another patient's prescription", async () => {
    await refusedApproval(
      { rxLine: rxLine({ prescription: { patientId: 'patient-2' } }) },
      'rx-line-1',
      'PRESCRIPTION_PATIENT_MISMATCH'
    );
  });

  it('refuses a prescription that is in date today but expires before the cycle is due', async () => {
    await refusedApproval(
      { rxLine: rxLine({ prescription: { validUntil: new Date('2026-11-30T00:00:00.000Z') } }) },
      'rx-line-1',
      'PRESCRIPTION_NOT_IN_DATE'
    );
  });

  it('refuses a prescription that only starts after today', async () => {
    await refusedApproval(
      { rxLine: rxLine({ prescription: { validFrom: new Date('2026-12-01T00:00:00.000Z') } }) },
      'rx-line-1',
      'PRESCRIPTION_NOT_IN_DATE'
    );
  });

  it('refuses a prescription without the quantity or repeats left for the whole cycle', async () => {
    await refusedApproval(
      { rxLine: rxLine({ authorizedCanonicalUnits: 60, fills: [{ quantityCanonicalUnits: 40 }] }) },
      'rx-line-1',
      'PRESCRIPTION_EXHAUSTED'
    );
    await refusedApproval(
      {
        rxLine: rxLine({
          fills: [{ quantityCanonicalUnits: 30 }, { quantityCanonicalUnits: 30 }],
          prescription: { authorizedRepeats: 1 },
        }),
      },
      'rx-line-1',
      'PRESCRIPTION_EXHAUSTED'
    );
  });

  it('releases the cycle only with a covering prescription and records it with the approval', async () => {
    const { db, writes } = fakeDb({ cycle: awaiting });
    await expect(
      approveRefillCycle(db as never, scope, 'cycle-1', approval, COVERING)
    ).resolves.toMatchObject({
      status: 'RESERVED',
      approvedByUserId: 'pharmacist',
      prescriptionLineId: 'rx-line-1',
    });
    expect(writes).toContainEqual([
      'audit.create',
      expect.objectContaining({
        data: expect.objectContaining({
          metadata: expect.objectContaining({ prescriptionLineId: 'rx-line-1', pinVerified: true }),
        }),
      }),
    ]);
  });

  it('refuses checkout of an approved Rx cycle that carries no prescription', async () => {
    const { db } = fakeDb({
      cycle: {
        ...awaiting,
        status: 'RESERVED',
        approvedByUserId: 'pharmacist',
        approvedAt: new Date(),
      },
      medicine: medicine({ otc: false, rx: true }),
    });
    await expect(startRefillCycleCheckout(db as never, scope, 'cycle-1')).rejects.toMatchObject({
      reason: 'PRESCRIPTION_REQUIRED',
    });
    expect(createSale).not.toHaveBeenCalled();
  });

  it('lets a fresh PIN approval replace the prescription of an approved cycle not yet collected', async () => {
    const { db, writes } = fakeDb({
      cycle: {
        ...awaiting,
        status: 'RESERVED',
        approvedByUserId: 'pharmacist',
        approvedAt: new Date(),
        prescriptionLineId: 'rx-line-old',
      },
    });
    await expect(
      approveRefillCycle(db as never, scope, 'cycle-1', approval, COVERING)
    ).resolves.toMatchObject({ status: 'RESERVED', prescriptionLineId: 'rx-line-1' });
    expect(writes.some(([name]) => name === 'audit.create')).toBe(true);
  });

  it('refuses to re-approve a cycle already handed to the counter', async () => {
    await refusedApproval(
      {
        cycle: {
          ...awaiting,
          status: 'CHECKOUT_STARTED',
          approvedByUserId: 'pharmacist',
          approvedAt: new Date(),
          prescriptionLineId: 'rx-line-1',
          counterSaleId: 'sale-1',
        },
      },
      'rx-line-1',
      'INVALID_STATE'
    );
  });

  it('refuses checkout once the approved prescription has run out', async () => {
    const { db } = fakeDb({
      cycle: {
        ...awaiting,
        status: 'RESERVED',
        approvedByUserId: 'pharmacist',
        approvedAt: new Date(),
        prescriptionLineId: 'rx-line-1',
      },
      medicine: medicine({ otc: false, rx: true }),
      rxLine: rxLine({ authorizedCanonicalUnits: 30, fills: [{ quantityCanonicalUnits: 30 }] }),
    });
    await expect(startRefillCycleCheckout(db as never, scope, 'cycle-1')).rejects.toMatchObject({
      reason: 'PRESCRIPTION_EXHAUSTED',
    });
    expect(createSale).not.toHaveBeenCalled();
  });

  it('carries the prescription onto the counter line and queues the pharmacist sign-off', async () => {
    const { db, writes } = fakeDb({
      cycle: {
        ...awaiting,
        status: 'RESERVED',
        approvedByUserId: 'pharmacist',
        approvedAt: new Date(),
        prescriptionLineId: 'rx-line-1',
      },
      medicine: medicine({ otc: false, rx: true }),
    });
    await expect(startRefillCycleCheckout(db as never, scope, 'cycle-1')).resolves.toMatchObject({
      saleId: 'sale-1',
    });
    expect(writes).toContainEqual([
      'saleLine.updateMany',
      expect.objectContaining({
        where: expect.objectContaining({ id: 'sale-line-1' }),
        data: { prescriptionLineId: 'rx-line-1', prescriptionPatientId: 'patient-1' },
      }),
    ]);
    expect(writes).toContainEqual([
      'reviewItem.create',
      {
        data: {
          organizationId: 'org',
          prescriptionLineId: 'rx-line-1',
          saleLineId: 'sale-line-1',
          requestedByUserId: 'cashier',
        },
      },
    ]);
  });

  it('asks nothing of an OTC cycle', async () => {
    const { db, writes } = fakeDb({
      cycle: { ...awaiting, status: 'RESERVED', requiresPharmacist: false },
    });
    await expect(startRefillCycleCheckout(db as never, scope, 'cycle-1')).resolves.toMatchObject({
      saleId: 'sale-1',
    });
    expect(db.prescriptionLine.findFirst).not.toHaveBeenCalled();
    expect(writes.some(([name]) => name === 'reviewItem.create')).toBe(false);
  });
});

describe('DEV-73 reminder text', () => {
  it('names only the due date, never the medicine', () => {
    const reminder = refillSubscriptionReminder({ id: 'cycle-1', dueAt: DUE });
    expect(reminder).toEqual({
      dueDate: '2026-12-01',
      dedupeKey: 'refill-subscription:cycle-1',
      template: 'refillReminder',
      parameters: ['2026-12-01'],
      sms: { kind: 'REFILL_REMINDER', dueDate: '2026-12-01' },
    });
    expect(JSON.stringify(reminder)).not.toMatch(/metformin|med-1/i);
  });

  it('is due only inside the subscription’s own lead window', () => {
    expect(refillSubscriptionReminderDue({ dueAt: DUE }, 3, new Date('2026-11-27T00:00:00Z'))).toBe(
      false
    );
    expect(refillSubscriptionReminderDue({ dueAt: DUE }, 3, new Date('2026-11-29T00:00:00Z'))).toBe(
      true
    );
    expect(refillSubscriptionReminderDue({ dueAt: DUE }, 3, DUE)).toBe(false);
  });
});

it('exposes typed refusals', () => {
  expect(new RefillSubscriptionError('INVALID_STATE').reason).toBe('INVALID_STATE');
});

describe('DEV-943: "open due cycles now" uses the shop’s day', () => {
  // Due at 12:00 UTC on 22 Nov (the console's due-date form), with a three-day lead:
  // the cycle's opening day is 19 Nov.
  const subscription = {
    id: 'sub-due',
    nextDueAt: new Date('2026-11-22T12:00:00.000Z'),
    reminderLeadDays: 3,
  };
  function dueDb(timezone: string | null) {
    const findMany = vi.fn(async () => [subscription]);
    const findUnique = vi.fn(async () => ({ timezone }));
    return {
      db: {
        $queryRaw: vi.fn(async () => []),
        organization: { findUnique },
        pharmacyRefillSubscription: { findMany },
      },
      findMany,
      findUnique,
    };
  }

  it.each([
    // 19:30 UTC on 18 Nov is already 00:30 on 19 Nov in Karachi: the opening day has come.
    ['Asia/Karachi', '2026-11-18T19:30:00.000Z', ['sub-due']],
    // 18:59 UTC is still 23:59 on 18 Nov in Karachi: not yet.
    ['Asia/Karachi', '2026-11-18T18:59:00.000Z', []],
    // A UTC organisation's day still turns at UTC midnight.
    ['UTC', '2026-11-18T19:30:00.000Z', []],
    ['UTC', '2026-11-19T00:00:00.000Z', ['sub-due']],
    [null, '2026-11-18T19:30:00.000Z', []],
  ])('in %s at %s opens %j', async (timezone, now, expected) => {
    const { db, findMany, findUnique } = dueDb(timezone);
    await expect(listDueRefillSubscriptionIds(db as never, scope, new Date(now))).resolves.toEqual(
      expected
    );
    // The zone is the caller's own organisation's, never an input.
    expect(findUnique).toHaveBeenCalledWith({
      where: { id: scope.organizationId },
      select: { timezone: true },
    });
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organizationId: scope.organizationId,
          branchId: scope.branchId,
          status: 'ACTIVE',
        }),
      })
    );
  });

  it('matches the scheduled job: the same subscriptions open on the same shop day', async () => {
    const { refillCycleOpensBy } = await import('./refill-subscription-rules');
    for (const now of ['2026-11-18T18:59:00.000Z', '2026-11-18T19:30:00.000Z']) {
      const { db } = dueDb('Asia/Karachi');
      const ids = await listDueRefillSubscriptionIds(db as never, scope, new Date(now));
      expect(ids.includes('sub-due')).toBe(
        refillCycleOpensBy(subscription, 'Asia/Karachi', new Date(now))
      );
    }
  });
});
