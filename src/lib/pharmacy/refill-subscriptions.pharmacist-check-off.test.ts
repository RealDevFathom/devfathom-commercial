import { beforeEach, describe, expect, it, vi } from 'vitest';

// DEV-911: with the owner's pharmacist check switched off, a prescription-only refill cycle is
// not held for a pharmacist; its approval is the owner-switched-off marker. With the check on,
// missing or unreadable, the pharmacist hold applies exactly as before.

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
vi.mock('@/lib/abac', () => ({ can: vi.fn() }));
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

import {
  approveRefillCycle,
  openRefillCycle,
  startRefillCycleCheckout,
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
    policy?: { pharmacistCheckEnabled: boolean; pharmacistCheckPolicyVersion: number } | null;
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
    pharmacyOwnerPolicy: { findUnique: vi.fn(async () => options.policy ?? null) },
  };
  return { db, writes };
}

const OFF = { pharmacistCheckEnabled: false, pharmacistCheckPolicyVersion: 3 };
const ON = { pharmacistCheckEnabled: true, pharmacistCheckPolicyVersion: 4 };
const rx = () => medicine({ otc: false, rx: true });

const awaiting = {
  id: 'cycle-1',
  status: 'AWAITING_PHARMACIST',
  requiresPharmacist: true,
  openedByUserId: 'cashier',
  canonicalUnits: 30,
  approvedByUserId: null,
  approvalPolicy: null,
  approvedAt: null,
  prescriptionLineId: null,
  counterSaleId: null,
  subscription: subscriptionRow,
};
const readiedWhileOff = {
  ...awaiting,
  status: 'RESERVED',
  approvedByUserId: 'cashier',
  approvalPolicy: 'pharmacist-check-off:v3',
  approvedAt: new Date('2026-11-18T08:00:00.000Z'),
};

beforeEach(() => {
  vi.mocked(can).mockReset();
  // A cashier without the dispensing grant.
  vi.mocked(can).mockResolvedValue(false);
  vi.mocked(createSale).mockClear();
  vi.mocked(addReservedSaleLine).mockClear();
});

describe('opening a prescription-only refill cycle', () => {
  it('opens it ready, approved by the owner-switched-off marker, while the check is off', async () => {
    const { db } = fakeDb({ medicine: rx(), policy: OFF });
    await expect(openRefillCycle(db as never, scope, 'sub-1')).resolves.toMatchObject({
      status: 'RESERVED',
      requiresPharmacist: true,
      approvedByUserId: 'cashier',
      approvalPolicy: 'pharmacist-check-off:v3',
      approvedAt: expect.any(Date),
    });
  });

  it.each([
    ['on', ON],
    ['missing', null],
  ])('holds it for the pharmacist while the setting is %s', async (_label, policy) => {
    const { db } = fakeDb({ medicine: rx(), policy });
    await expect(openRefillCycle(db as never, scope, 'sub-1')).resolves.toMatchObject({
      status: 'AWAITING_PHARMACIST',
      requiresPharmacist: true,
    });
  });

  it('holds it for the pharmacist when the setting cannot be read', async () => {
    const { db } = fakeDb({ medicine: rx(), policy: OFF });
    db.pharmacyOwnerPolicy.findUnique.mockRejectedValueOnce(new Error('read failed'));
    await expect(openRefillCycle(db as never, scope, 'sub-1')).resolves.toMatchObject({
      status: 'AWAITING_PHARMACIST',
    });
  });

  it('reads nothing for an over-the-counter cycle', async () => {
    const { db } = fakeDb({ policy: OFF });
    await openRefillCycle(db as never, scope, 'sub-1');
    expect(db.pharmacyOwnerPolicy.findUnique).not.toHaveBeenCalled();
  });
});

describe('checking out a prescription-only refill cycle', () => {
  it('releases a cycle still awaiting the pharmacist once the owner switched the check off', async () => {
    const { db, writes } = fakeDb({ cycle: awaiting, medicine: rx(), policy: OFF });
    await expect(startRefillCycleCheckout(db as never, scope, 'cycle-1')).resolves.toMatchObject({
      saleId: 'sale-1',
    });
    expect(writes).toContainEqual([
      'cycle.update',
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'RESERVED',
          approvedByUserId: 'cashier',
          approvalPolicy: 'pharmacist-check-off:v3',
        }),
      }),
    ]);
    expect(addReservedSaleLine).toHaveBeenCalledWith(
      db,
      scope,
      expect.anything(),
      expect.objectContaining({ pharmacistApprovedRx: true })
    );
  });

  it('checks out a cycle readied while the check is off, by a cashier', async () => {
    const { db } = fakeDb({ cycle: readiedWhileOff, medicine: rx(), policy: OFF });
    await expect(startRefillCycleCheckout(db as never, scope, 'cycle-1')).resolves.toMatchObject({
      saleId: 'sale-1',
    });
  });

  it.each([
    ['on', ON],
    ['missing', null],
  ])(
    'refuses the unapproved cycle exactly as before while the setting is %s',
    async (_l, policy) => {
      const { db } = fakeDb({ cycle: awaiting, medicine: rx(), policy });
      await expect(startRefillCycleCheckout(db as never, scope, 'cycle-1')).rejects.toMatchObject({
        reason: 'PHARMACIST_APPROVAL_REQUIRED',
      });
      expect(createSale).not.toHaveBeenCalled();
    }
  );

  it('hands over a cycle readied while off with no prescription attached', async () => {
    const { db, writes } = fakeDb({ cycle: readiedWhileOff, medicine: rx(), policy: OFF });
    await startRefillCycleCheckout(db as never, scope, 'cycle-1');
    expect(db.prescriptionLine.findFirst).not.toHaveBeenCalled();
    expect(writes.some(([name]) => name === 'reviewItem.create')).toBe(false);
  });

  it('does not stop a pharmacist-approved cycle whose prescription no longer covers it while off', async () => {
    const approvedWithRx = {
      ...readiedWhileOff,
      approvedByUserId: 'pharmacist',
      approvalPolicy: 'PHARMACIST_PIN_REAUTH',
      prescriptionLineId: 'rx-line-1',
    };
    const { db } = fakeDb({ cycle: approvedWithRx, medicine: rx(), rxLine: null, policy: OFF });
    await expect(startRefillCycleCheckout(db as never, scope, 'cycle-1')).resolves.toMatchObject({
      saleId: 'sale-1',
    });
  });

  it('still refuses that uncovered cycle while the check is on', async () => {
    vi.mocked(can).mockResolvedValue(true);
    const approvedWithRx = {
      ...readiedWhileOff,
      approvedByUserId: 'pharmacist',
      approvalPolicy: 'PHARMACIST_PIN_REAUTH',
      prescriptionLineId: 'rx-line-1',
    };
    const { db } = fakeDb({ cycle: approvedWithRx, medicine: rx(), rxLine: null, policy: ON });
    await expect(startRefillCycleCheckout(db as never, scope, 'cycle-1')).rejects.toMatchObject({
      reason: 'PRESCRIPTION_NOT_FOUND',
    });
    expect(createSale).not.toHaveBeenCalled();
  });

  it('refuses a cycle readied while off once the owner turns the check back on', async () => {
    const { db } = fakeDb({ cycle: readiedWhileOff, medicine: rx(), policy: ON });
    await expect(startRefillCycleCheckout(db as never, scope, 'cycle-1')).rejects.toMatchObject({
      reason: 'PHARMACIST_APPROVAL_REQUIRED',
    });
    expect(createSale).not.toHaveBeenCalled();
  });

  it('lets a pharmacist approve a cycle readied while off, so it can go ahead once back on', async () => {
    vi.mocked(can).mockResolvedValue(true);
    const { db } = fakeDb({ cycle: readiedWhileOff, medicine: rx(), policy: ON });
    await expect(
      approveRefillCycle(
        db as never,
        scope,
        'cycle-1',
        { approvedByUserId: 'pharmacist', credentialId: 'cred-1' },
        { prescriptionLineId: 'rx-line-1' }
      )
    ).resolves.toMatchObject({
      status: 'RESERVED',
      approvedByUserId: 'pharmacist',
      approvalPolicy: expect.not.stringMatching(/^pharmacist-check-off:/),
      prescriptionLineId: 'rx-line-1',
    });
  });
});
