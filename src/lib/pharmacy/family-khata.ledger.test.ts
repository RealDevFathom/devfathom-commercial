import { describe, expect, it, vi } from 'vitest';

vi.mock('./patient-prescriptions', () => ({ auditPatientRead: vi.fn() }));

import { listKhataLedger } from './family-khata';

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
