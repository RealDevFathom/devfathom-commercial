import { beforeEach, describe, expect, it, vi } from 'vitest';

const bookkeeping = vi.hoisted(() => ({ post: vi.fn() }));
vi.mock('./patient-prescriptions', () => ({ auditPatientRead: vi.fn() }));
vi.mock('./bookkeeping', () => ({ postBookkeepingTransaction: bookkeeping.post }));

import { collectKhataPayment, FamilyKhataError, listKhataLedger } from './family-khata';

const scope = { organizationId: 'org_k', branchId: 'branch_k', actorId: 'owner_k' };
const NOW = new Date('2026-11-15T10:00:00.000Z');

describe('DEV-730 Khata ledger list', () => {
  it('lists every active account with balance, limit, last payment and overdue state, largest balance first', async () => {
    const accountFind = vi.fn().mockResolvedValue([
      {
        id: 'fam_a',
        displayName: 'Ahmed household',
        creditLimitMinor: 50_000,
        payer: { displayName: 'Ahmed', phoneLast4: '4567' },
      },
      {
        id: 'fam_b',
        displayName: 'Bilal household',
        creditLimitMinor: 10_000,
        payer: { displayName: 'Bilal', phoneLast4: null },
      },
      {
        id: 'fam_c',
        displayName: 'Clear household',
        creditLimitMinor: 0,
        payer: { displayName: 'Chaudhry', phoneLast4: '1111' },
      },
    ]);
    const groupBy = vi
      .fn()
      .mockResolvedValueOnce([
        { familyAccountId: 'fam_a', kind: 'CHARGE', _sum: { amountMinor: 30_000 } },
        { familyAccountId: 'fam_a', kind: 'PAYMENT', _sum: { amountMinor: 10_000 } },
        { familyAccountId: 'fam_b', kind: 'CHARGE', _sum: { amountMinor: 15_000 } },
        { familyAccountId: 'fam_b', kind: 'DISHONOURED_CHEQUE', _sum: { amountMinor: 5_000 } },
      ])
      .mockResolvedValueOnce([
        { familyAccountId: 'fam_a', _max: { occurredAt: new Date('2026-11-01T09:00:00Z') } },
      ]);
    const eventFind = vi.fn().mockResolvedValue([
      // fam_a: overdue charge fully settled, later charge not yet due.
      {
        id: 'c1',
        familyAccountId: 'fam_a',
        kind: 'CHARGE',
        amountMinor: 10_000,
        dueAt: new Date('2026-10-01'),
        settlesChargeId: null,
      },
      {
        id: 'p1',
        familyAccountId: 'fam_a',
        kind: 'PAYMENT',
        amountMinor: 10_000,
        dueAt: null,
        settlesChargeId: 'c1',
      },
      // fam_b: two overdue unpaid charges; the oldest due date wins.
      {
        id: 'c2',
        familyAccountId: 'fam_b',
        kind: 'CHARGE',
        amountMinor: 5_000,
        dueAt: new Date('2026-10-20'),
        settlesChargeId: null,
      },
      {
        id: 'c3',
        familyAccountId: 'fam_b',
        kind: 'CHARGE',
        amountMinor: 10_000,
        dueAt: new Date('2026-10-05'),
        settlesChargeId: null,
      },
    ]);
    const db = {
      pharmacyFamilyAccount: { findMany: accountFind },
      pharmacyKhataEvent: { groupBy, findMany: eventFind },
    };

    const result = await listKhataLedger(db as never, scope, NOW);

    expect(accountFind).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { organizationId: 'org_k', branchId: 'branch_k', active: true },
      })
    );
    // Refund reversals are credits, not customer payments.
    expect(groupBy.mock.calls[1]![0].where).toMatchObject({
      organizationId: 'org_k',
      branchId: 'branch_k',
      kind: 'PAYMENT',
      NOT: { id: { startsWith: 'khata-refund:' } },
    });
    expect(result.truncated).toBe(false);
    expect(result.accounts).toEqual([
      {
        id: 'fam_a',
        displayName: 'Ahmed household',
        payerName: 'Ahmed',
        phoneLast4: '4567',
        balanceMinor: 20_000,
        creditLimitMinor: 50_000,
        lastPaymentAt: new Date('2026-11-01T09:00:00Z'),
        oldestOverdueAt: null,
      },
      {
        id: 'fam_b',
        displayName: 'Bilal household',
        payerName: 'Bilal',
        phoneLast4: null,
        balanceMinor: 20_000,
        creditLimitMinor: 10_000,
        lastPaymentAt: null,
        oldestOverdueAt: new Date('2026-10-05'),
      },
      {
        id: 'fam_c',
        displayName: 'Clear household',
        payerName: 'Chaudhry',
        phoneLast4: '1111',
        balanceMinor: 0,
        creditLimitMinor: 0,
        lastPaymentAt: null,
        oldestOverdueAt: null,
      },
    ]);
  });

  it('reads no events when the branch has no accounts', async () => {
    const groupBy = vi.fn();
    const db = {
      pharmacyFamilyAccount: { findMany: vi.fn().mockResolvedValue([]) },
      pharmacyKhataEvent: { groupBy, findMany: vi.fn() },
    };
    await expect(listKhataLedger(db as never, scope, NOW)).resolves.toEqual({
      accounts: [],
      truncated: false,
    });
    expect(groupBy).not.toHaveBeenCalled();
  });
});

describe('DEV-730 collect Khata payment', () => {
  const create = vi.fn();
  const queryRaw = vi.fn();
  let priorRows: Array<{ amountMinor: number }>;
  let account: { id: string } | null;

  function db() {
    return {
      $queryRaw: queryRaw,
      pharmacyFamilyAccount: {
        findFirst: vi.fn(async () => account && { ...account, payer: { displayName: 'Ahmed' } }),
      },
      pharmacyKhataEvent: {
        findMany: vi.fn(async (args: { where: { id?: unknown } }) =>
          args.where.id
            ? priorRows
            : [
                {
                  id: 'charge_a',
                  kind: 'CHARGE',
                  amountMinor: 6_000,
                  occurredAt: new Date('2026-10-01'),
                },
              ]
        ),
        groupBy: vi.fn(async () => [
          { kind: 'CHARGE', _sum: { amountMinor: 6_000 } },
          { kind: 'PAYMENT', _sum: { amountMinor: create.mock.calls.length ? 2_500 : 0 } },
        ]),
        create,
      },
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    priorRows = [];
    account = { id: 'fam_a' };
    create.mockImplementation(async ({ data }) => data);
  });

  it('locks the account and posts deterministic, attributable payment allocations', async () => {
    const result = await collectKhataPayment(db() as never, scope, {
      familyAccountId: 'fam_a',
      amountMinor: 2_500,
      method: 'CASH',
      idempotencyKey: 'key-0001',
    });

    expect(queryRaw.mock.calls[0]![0].sql).toContain('FOR UPDATE');
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]![0].data).toMatchObject({
      id: 'khata-collect:fam_a:key-0001:0',
      organizationId: 'org_k',
      branchId: 'branch_k',
      familyAccountId: 'fam_a',
      kind: 'PAYMENT',
      amountMinor: 2_500,
      settlesChargeId: 'charge_a',
      actorId: 'owner_k',
      note: 'Collected · CASH',
    });
    expect(result).toEqual({ replayed: false, paidMinor: 2_500, remainingBalanceMinor: 3_500 });
    // The receivable created by the CREDIT tender posting is cleared in the same transaction.
    expect(bookkeeping.post).toHaveBeenCalledTimes(1);
    expect(bookkeeping.post).toHaveBeenCalledWith(expect.anything(), scope, {
      reference: 'KHATA-key-0001',
      kind: 'CUSTOMER_RECEIPT',
      amountMinor: 2_500,
      occurredAt: expect.any(Date),
      idempotencyKey: 'khata-collect:fam_a:key-0001:receipt',
      counterpartyName: 'Ahmed',
      memo: 'Khata collection · CASH',
      fundingAccount: 'CASH',
      allocations: [
        {
          sourceKind: 'CUSTOMER_KHATA',
          sourceId: 'charge_a',
          sourceReference: 'Khata charge charge_a',
          amountMinor: 2_500,
        },
      ],
    });
  });

  it('posts a non-cash collection to the bank and fails the whole collection when the period is closed', async () => {
    await collectKhataPayment(db() as never, scope, {
      familyAccountId: 'fam_a',
      amountMinor: 1_000,
      method: 'BANK_TRANSFER',
      idempotencyKey: 'key-0004',
    });
    expect(bookkeeping.post.mock.calls[0]![2]).toMatchObject({ fundingAccount: 'BANK' });

    bookkeeping.post.mockRejectedValueOnce(new Error('PERIOD_CLOSED'));
    await expect(
      collectKhataPayment(db() as never, scope, {
        familyAccountId: 'fam_a',
        amountMinor: 1_000,
        method: 'CASH',
        idempotencyKey: 'key-0005',
      })
    ).rejects.toThrow('PERIOD_CLOSED');
  });

  it('replays a retried submission instead of collecting twice', async () => {
    priorRows = [{ amountMinor: 2_500 }];
    const result = await collectKhataPayment(db() as never, scope, {
      familyAccountId: 'fam_a',
      amountMinor: 2_500,
      method: 'CASH',
      idempotencyKey: 'key-0001',
    });
    expect(create).not.toHaveBeenCalled();
    expect(bookkeeping.post).not.toHaveBeenCalled();
    expect(result).toMatchObject({ replayed: true, paidMinor: 2_500 });
  });

  it('refuses more than the open charges', async () => {
    await expect(
      collectKhataPayment(db() as never, scope, {
        familyAccountId: 'fam_a',
        amountMinor: 6_001,
        method: 'CARD',
        idempotencyKey: 'key-0002',
      })
    ).rejects.toMatchObject<Partial<FamilyKhataError>>({ reason: 'PAYMENT_EXCEEDS_BALANCE' });
    expect(create).not.toHaveBeenCalled();
    expect(bookkeeping.post).not.toHaveBeenCalled();
  });

  it('refuses an inactive or other-branch account before any write', async () => {
    account = null;
    await expect(
      collectKhataPayment(db() as never, scope, {
        familyAccountId: 'fam_other',
        amountMinor: 100,
        method: 'CASH',
        idempotencyKey: 'key-0003',
      })
    ).rejects.toMatchObject<Partial<FamilyKhataError>>({ reason: 'ACCOUNT_NOT_FOUND' });
    expect(create).not.toHaveBeenCalled();
  });
});
