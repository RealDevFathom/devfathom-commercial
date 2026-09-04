import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./patient-prescriptions', () => ({ auditPatientRead: vi.fn() }));

import {
  applyKhataLimitDecision,
  calculateKhataHealthSuggestion,
  FamilyKhataError,
  readFamilyMemberDispensing,
  settleFamilyKhata,
} from './family-khata';

const scope = { organizationId: 'org_family', branchId: 'branch_main', actorId: 'owner_1' };

describe('CRM-L02 family privacy and khata settlement', () => {
  beforeEach(() => vi.clearAllMocks());

  it('NEGATIVE: member A cannot read member B dispensing history', async () => {
    const findMany = vi.fn();
    const db = {
      pharmacyFamilyMember: {
        findFirst: vi.fn().mockResolvedValue({ customer: { patientId: 'patient_a' } }),
      },
      prescription: { findMany },
    };

    await expect(
      readFamilyMemberDispensing(db as never, scope, {
        familyAccountId: 'family_1',
        memberId: 'member_a',
        patientId: 'patient_b',
      })
    ).rejects.toEqual(
      expect.objectContaining<Partial<FamilyKhataError>>({
        reason: 'CROSS_MEMBER_CLINICAL_ACCESS',
      })
    );
    expect(findMany).not.toHaveBeenCalled();
  });

  it('settles one family payment oldest-first across charges from multiple members', async () => {
    const create = vi.fn(async ({ data }) => ({
      id: `payment_${create.mock.calls.length}`,
      ...data,
    }));
    const db = {
      pharmacyKhataEvent: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: 'charge_a',
            kind: 'CHARGE',
            amountMinor: 4_000,
            occurredAt: new Date('2026-07-01'),
          },
          {
            id: 'charge_b',
            kind: 'CHARGE',
            amountMinor: 6_000,
            occurredAt: new Date('2026-07-02'),
          },
        ]),
        create,
      },
    };

    const result = await settleFamilyKhata(db as never, scope, {
      familyAccountId: 'family_1',
      amountMinor: 7_000,
      occurredAt: new Date('2026-07-10'),
    });

    expect(result).toMatchObject({ paidMinor: 7_000, remainingBalanceMinor: 3_000 });
    expect(create.mock.calls.map(([call]) => call.data)).toMatchObject([
      { settlesChargeId: 'charge_a', amountMinor: 4_000 },
      { settlesChargeId: 'charge_b', amountMinor: 3_000 },
    ]);
  });
});

describe('CRM-L04 explainable health suggestion', () => {
  const suggestion = calculateKhataHealthSuggestion(
    [
      {
        id: 'charge_1',
        kind: 'CHARGE',
        amountMinor: 20_000,
        occurredAt: new Date('2026-06-01'),
        dueAt: new Date('2026-06-15'),
      },
      {
        id: 'payment_1',
        kind: 'PAYMENT',
        amountMinor: 20_000,
        occurredAt: new Date('2026-06-11'),
        settlesChargeId: 'charge_1',
      },
    ],
    10_000,
    new Date('2026-06-01'),
    new Date('2026-06-30')
  );

  it('states the estimate method, window, metrics and reasons', () => {
    expect(suggestion).toMatchObject({
      score: 100,
      method: 'KHATA_HEALTH_V1',
      suggestedLimitMinor: 20_000,
      metrics: { chargeCount: 1, overdueChargeCount: 0, averageDaysToPay: 10 },
    });
    expect(suggestion.reasons).toContain('Average 10 day(s) to pay');
  });

  it('NEGATIVE: suggestion alone never changes the limit; owner action is required', async () => {
    const update = vi.fn();
    const create = vi.fn();
    const db = {
      pharmacyFamilyAccount: { update },
      pharmacyKhataLimitDecision: { create },
    };

    await expect(
      applyKhataLimitDecision(db as never, scope, {
        familyAccountId: 'family_1',
        suggestion,
        ownerAuthorized: false,
      })
    ).rejects.toEqual(
      expect.objectContaining<Partial<FamilyKhataError>>({
        reason: 'OWNER_ACTION_REQUIRED',
      })
    );
    expect(update).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it('applies either the accepted suggestion or an explicit owner override', async () => {
    const update = vi.fn().mockResolvedValue({ creditLimitMinor: 15_000 });
    const create = vi.fn().mockResolvedValue({ kind: 'OVERRIDDEN' });
    const db = {
      pharmacyFamilyAccount: { update },
      pharmacyKhataLimitDecision: { create },
    };

    await applyKhataLimitDecision(db as never, scope, {
      familyAccountId: 'family_1',
      suggestion,
      ownerAuthorized: true,
      overrideLimitMinor: 15_000,
    });
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { creditLimitMinor: 15_000 } })
    );
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ kind: 'OVERRIDDEN', appliedLimitMinor: 15_000 }),
      })
    );
  });
});
