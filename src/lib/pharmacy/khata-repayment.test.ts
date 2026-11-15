import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('./patient-prescriptions', () => ({ auditPatientRead: vi.fn() }));
vi.mock('./bookkeeping', async (original) => ({
  ...(await original<typeof import('./bookkeeping')>()),
  postBookkeepingTransaction: vi.fn(),
}));

import { postBookkeepingTransaction } from './bookkeeping';
import {
  recordKhataRepayment,
  searchKhataRepaymentAccounts,
  type KhataRepaymentInput,
} from './khata-repayment';

const scope = { organizationId: 'org_k', branchId: 'branch_k', actorId: 'cashier_1' };
const businessDate = new Date('2026-11-15');
const cashInput: KhataRepaymentInput = {
  familyAccountId: 'family_1',
  amountMinor: 3_000,
  tender: 'CASH',
  deviceId: 'device_1',
  businessDate,
  idempotencyKey: 'attempt-1',
};

function fixture(options: { prior?: Record<string, unknown>; closed?: boolean } = {}) {
  const events: Record<string, unknown>[] = [
    { id: 'charge_a', kind: 'CHARGE', amountMinor: 2_000, occurredAt: new Date('2026-10-01') },
    { id: 'charge_b', kind: 'CHARGE', amountMinor: 5_000, occurredAt: new Date('2026-10-05') },
  ];
  const db = {
    $queryRaw: vi.fn().mockResolvedValue([]),
    organization: { findUnique: vi.fn().mockResolvedValue({ currency: 'PKR' }) },
    pharmacyFamilyAccount: {
      findFirst: vi
        .fn()
        .mockResolvedValue({ id: 'family_1', displayName: 'Khan family', active: true }),
      findMany: vi.fn().mockResolvedValue([
        {
          id: 'family_1',
          displayName: 'Khan family',
          creditLimitMinor: 10_000,
          payer: { phoneLast4: '4321' },
        },
      ]),
    },
    pharmacyBookkeepingTransaction: {
      findFirst: vi.fn().mockResolvedValue(options.prior ?? null),
    },
    pharmacyKhataEvent: {
      findMany: vi.fn(async () => events),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        events.push({ id: `payment_${events.length}`, ...data });
        return data;
      }),
      groupBy: vi.fn(async () => {
        const sum = (kind: string) =>
          events
            .filter((event) => event.kind === kind)
            .reduce((total, event) => total + (event.amountMinor as number), 0);
        return [
          { familyAccountId: 'family_1', kind: 'CHARGE', _sum: { amountMinor: sum('CHARGE') } },
          { familyAccountId: 'family_1', kind: 'PAYMENT', _sum: { amountMinor: sum('PAYMENT') } },
        ];
      }),
    },
    pharmacyDrawerSession: {
      findFirst: vi.fn().mockResolvedValue({ id: 'drawer_1', businessDate }),
    },
    pharmacyDailyClose: {
      findFirst: vi.fn().mockResolvedValue(options.closed ? { id: 'close_1' } : null),
    },
    pharmacyDrawerMovement: {
      create: vi.fn().mockResolvedValue({ id: 'movement_1' }),
      findFirst: vi.fn().mockResolvedValue({ drawerSession: { deviceId: 'device_1' } }),
    },
  };
  return db;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(postBookkeepingTransaction).mockResolvedValue({} as never);
});

describe('K4 counter khata repayment (DEV-731)', () => {
  it('pays cash into the open drawer, settles charges oldest-first and posts a customer receipt', async () => {
    const db = fixture();
    const slip = await recordKhataRepayment(db as never, scope, cashInput);

    expect(db.pharmacyDrawerSession.findFirst).toHaveBeenCalledWith({
      where: {
        organizationId: 'org_k',
        branchId: 'branch_k',
        deviceId: 'device_1',
        businessDate,
        status: 'OPEN',
      },
      select: { id: true },
    });
    expect(db.pharmacyDrawerMovement.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        organizationId: 'org_k',
        drawerSessionId: 'drawer_1',
        kind: 'PAID_IN',
        amountMinor: 3_000,
        reason: `Khata payment ${slip.receiptReference}`,
        actorId: 'cashier_1',
      }),
    });
    expect(db.pharmacyKhataEvent.create.mock.calls.map(([call]) => call.data)).toMatchObject([
      { kind: 'PAYMENT', settlesChargeId: 'charge_a', amountMinor: 2_000 },
      { kind: 'PAYMENT', settlesChargeId: 'charge_b', amountMinor: 1_000 },
    ]);
    expect(postBookkeepingTransaction).toHaveBeenCalledWith(
      db,
      scope,
      expect.objectContaining({
        kind: 'CUSTOMER_RECEIPT',
        amountMinor: 3_000,
        reference: slip.receiptReference,
        fundingAccount: 'CASH',
        memo: 'Khata payment · CASH',
        allocations: [
          expect.objectContaining({
            sourceKind: 'CUSTOMER_KHATA',
            sourceId: 'family_1',
            amountMinor: 3_000,
          }),
        ],
      })
    );
    expect(slip).toMatchObject({
      receiptReference: expect.stringMatching(/^KP-[0-9A-F]{16}$/),
      accountName: 'Khan family',
      amountMinor: 3_000,
      tender: 'CASH',
      balanceAfterMinor: 4_000,
      currency: 'PKR',
      replayed: false,
    });
  });

  it('records a non-cash repayment against the bank without touching the drawer', async () => {
    const db = fixture();
    await recordKhataRepayment(db as never, scope, {
      ...cashInput,
      tender: 'RAAST',
      deviceId: undefined,
      payerReference: 'TXN-88231',
    });
    expect(db.pharmacyDrawerMovement.create).not.toHaveBeenCalled();
    expect(postBookkeepingTransaction).toHaveBeenCalledWith(
      db,
      scope,
      expect.objectContaining({ fundingAccount: 'BANK', bankReference: 'TXN-88231' })
    );
  });

  it('refuses cash without an open drawer and non-cash without a payer reference before writing', async () => {
    const db = fixture();
    await expect(
      recordKhataRepayment(db as never, scope, { ...cashInput, deviceId: undefined })
    ).rejects.toMatchObject({ reason: 'DRAWER_NOT_OPEN' });
    await expect(
      recordKhataRepayment(db as never, scope, {
        ...cashInput,
        tender: 'BANK_TRANSFER',
        deviceId: undefined,
        payerReference: '  ',
      })
    ).rejects.toMatchObject({ reason: 'REFERENCE_REQUIRED' });
    expect(db.$queryRaw).not.toHaveBeenCalled();
    expect(db.pharmacyKhataEvent.create).not.toHaveBeenCalled();
    expect(postBookkeepingTransaction).not.toHaveBeenCalled();
  });

  it('refuses a payment larger than the balance owed', async () => {
    const db = fixture();
    await expect(
      recordKhataRepayment(db as never, scope, { ...cashInput, amountMinor: 7_001 })
    ).rejects.toMatchObject({ reason: 'PAYMENT_EXCEEDS_BALANCE' });
    expect(db.pharmacyKhataEvent.create).not.toHaveBeenCalled();
    expect(postBookkeepingTransaction).not.toHaveBeenCalled();
  });

  it('refuses an account that is not active on this branch', async () => {
    const db = fixture();
    db.pharmacyFamilyAccount.findFirst.mockResolvedValue(null);
    await expect(recordKhataRepayment(db as never, scope, cashInput)).rejects.toMatchObject({
      reason: 'ACCOUNT_NOT_FOUND',
    });
    expect(db.pharmacyDrawerMovement.create).not.toHaveBeenCalled();
  });

  it('refuses new money on an inactive account but still replays a recorded payment', async () => {
    const db = fixture();
    db.pharmacyFamilyAccount.findFirst.mockResolvedValue({
      id: 'family_1',
      displayName: 'Khan family',
      active: false,
    });
    await expect(recordKhataRepayment(db as never, scope, cashInput)).rejects.toMatchObject({
      reason: 'ACCOUNT_NOT_FOUND',
    });
    expect(db.pharmacyDrawerMovement.create).not.toHaveBeenCalled();
    expect(db.pharmacyKhataEvent.create).not.toHaveBeenCalled();

    db.pharmacyBookkeepingTransaction.findFirst.mockResolvedValue({
      kind: 'CUSTOMER_RECEIPT',
      branchId: 'branch_k',
      reference: 'KP-0000000000',
      amountMinor: 3_000,
      memo: 'Khata payment · CASH',
      bankReference: null,
      occurredAt: new Date('2026-11-15T06:00:00.000Z'),
      currency: 'PKR',
      allocations: [{ sourceId: 'family_1' }],
    });
    await expect(recordKhataRepayment(db as never, scope, cashInput)).resolves.toMatchObject({
      receiptReference: 'KP-0000000000',
      replayed: true,
    });
  });

  it('refuses cash on a closed business day', async () => {
    const db = fixture({ closed: true });
    await expect(recordKhataRepayment(db as never, scope, cashInput)).rejects.toMatchObject({
      reason: 'DAY_CLOSED',
    });
    expect(db.pharmacyDrawerMovement.create).not.toHaveBeenCalled();
    expect(db.pharmacyKhataEvent.create).not.toHaveBeenCalled();
  });

  it('replays a retried submit without taking the money twice', async () => {
    const first = fixture();
    const slip = await recordKhataRepayment(first as never, scope, cashInput);
    const posted = vi.mocked(postBookkeepingTransaction).mock.calls[0]![2];
    vi.clearAllMocks();

    const prior = {
      kind: 'CUSTOMER_RECEIPT',
      branchId: 'branch_k',
      counterpartyName: 'Khan family',
      reference: posted.reference,
      amountMinor: 3_000,
      memo: posted.memo,
      bankReference: null,
      occurredAt: posted.occurredAt,
      currency: 'PKR',
      allocations: [{ sourceId: 'family_1' }],
    };
    const retry = fixture({ prior });
    const replay = await recordKhataRepayment(retry as never, scope, cashInput);
    expect(replay).toMatchObject({ receiptReference: slip.receiptReference, replayed: true });
    expect(retry.pharmacyBookkeepingTransaction.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { organizationId: 'org_k', idempotencyKey: posted.idempotencyKey },
      })
    );
    expect(retry.pharmacyDrawerMovement.create).not.toHaveBeenCalled();
    expect(retry.pharmacyKhataEvent.create).not.toHaveBeenCalled();
    expect(postBookkeepingTransaction).not.toHaveBeenCalled();

    await expect(
      recordKhataRepayment(fixture({ prior }) as never, scope, { ...cashInput, amountMinor: 100 })
    ).rejects.toMatchObject({ reason: 'IDEMPOTENCY_CONFLICT' });
    await expect(
      recordKhataRepayment(fixture({ prior }) as never, scope, {
        ...cashInput,
        deviceId: 'device_2',
      })
    ).rejects.toMatchObject({ reason: 'IDEMPOTENCY_CONFLICT' });
  });

  it('refuses a replay whose payer reference changed', async () => {
    const prior = {
      kind: 'CUSTOMER_RECEIPT',
      branchId: 'branch_k',
      counterpartyName: 'Khan family',
      reference: 'KP-0000000000',
      amountMinor: 3_000,
      memo: 'Khata payment · RAAST',
      bankReference: 'TXN-1',
      occurredAt: new Date('2026-11-15T06:00:00.000Z'),
      currency: 'PKR',
      allocations: [{ sourceId: 'family_1' }],
    };
    const nonCash = { ...cashInput, tender: 'RAAST' as const, deviceId: undefined };
    await expect(
      recordKhataRepayment(fixture({ prior }) as never, scope, {
        ...nonCash,
        payerReference: 'TXN-2',
      })
    ).rejects.toMatchObject({ reason: 'IDEMPOTENCY_CONFLICT' });
    await expect(
      recordKhataRepayment(fixture({ prior }) as never, scope, {
        ...nonCash,
        payerReference: 'TXN-1',
      })
    ).resolves.toMatchObject({ receiptReference: 'KP-0000000000', replayed: true });
  });

  it('replays the slip as recorded, not with a later name or balance', async () => {
    const occurredAt = new Date('2026-11-15T06:00:00.000Z');
    const db = fixture({
      prior: {
        kind: 'CUSTOMER_RECEIPT',
        branchId: 'branch_k',
        counterpartyName: 'Khan family',
        reference: 'KP-0000000000',
        amountMinor: 3_000,
        memo: 'Khata payment · CASH',
        bankReference: null,
        occurredAt,
        currency: 'PKR',
        allocations: [{ sourceId: 'family_1' }],
      },
    });
    db.pharmacyFamilyAccount.findFirst.mockResolvedValue({
      id: 'family_1',
      displayName: 'Renamed family',
      active: true,
    });
    const slip = await recordKhataRepayment(db as never, scope, cashInput);
    expect(slip.accountName).toBe('Khan family');
    expect(db.pharmacyKhataEvent.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ occurredAt: { lte: occurredAt } }),
      })
    );
  });

  it('lists active branch accounts with their full-ledger balance', async () => {
    const db = fixture();
    await expect(searchKhataRepaymentAccounts(db as never, scope, '4321')).resolves.toEqual([
      {
        id: 'family_1',
        displayName: 'Khan family',
        creditLimitMinor: 10_000,
        phoneLast4: '4321',
        balanceMinor: 7_000,
      },
    ]);
    expect(db.pharmacyKhataEvent.groupBy).toHaveBeenCalledTimes(1);
    expect(db.pharmacyKhataEvent.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        by: ['familyAccountId', 'kind'],
        where: expect.objectContaining({ familyAccountId: { in: ['family_1'] } }),
      })
    );
    expect(db.pharmacyFamilyAccount.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          organizationId: 'org_k',
          branchId: 'branch_k',
          active: true,
          OR: [
            { displayName: { contains: '4321', mode: 'insensitive' } },
            { payer: { phoneLast4: '4321' } },
          ],
        },
      })
    );
  });
});
