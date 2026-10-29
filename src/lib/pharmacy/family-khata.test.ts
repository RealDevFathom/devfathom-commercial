import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./patient-prescriptions', () => ({ auditPatientRead: vi.fn() }));

import {
  applyKhataLimitDecision,
  authorizeKhataCharge,
  readKhataBalance,
  readSaleKhataStatement,
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
      $queryRaw: vi.fn(),
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
  const now = new Date('2026-09-29T16:00:00.000Z');
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
  });
  afterEach(() => vi.useRealTimers());
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
      ownerAuthorizedByUserId: scope.actorId,
      ownerReauthenticatedAt: now,
      overrideLimitMinor: 15_000,
    });
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { creditLimitMinor: 15_000 } })
    );
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          kind: 'OVERRIDDEN',
          appliedLimitMinor: 15_000,
          ownerActorId: scope.actorId,
          reasons: {
            reasons: suggestion.reasons,
            ownerAuthorizedByUserId: scope.actorId,
            ownerReauthenticatedAt: now.toISOString(),
            ownerAuthorizedAt: now.toISOString(),
          },
        }),
      })
    );
  });

  it.each([
    ['missing', undefined, scope.actorId],
    ['expired', new Date('2026-09-29T15:54:59.999Z'), scope.actorId],
    ['future', new Date('2026-09-29T16:00:00.001Z'), scope.actorId],
    ['invalid', new Date('invalid'), scope.actorId],
    ['different owner', new Date('2026-09-29T16:00:00.000Z'), 'other-owner'],
  ])('rejects %s reauthentication before any write', async (_name, at, actor) => {
    const update = vi.fn();
    const create = vi.fn();
    await expect(
      applyKhataLimitDecision(
        {
          pharmacyFamilyAccount: { update },
          pharmacyKhataLimitDecision: { create },
        } as never,
        scope,
        {
          familyAccountId: 'family_1',
          suggestion,
          ownerAuthorized: true,
          ownerAuthorizedByUserId: actor,
          ownerReauthenticatedAt: at,
          overrideLimitMinor: 15_000,
        }
      )
    ).rejects.toMatchObject({ reason: 'OWNER_ACTION_REQUIRED' });
    expect(update).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it('accepts reauthentication exactly five minutes old', async () => {
    const update = vi.fn().mockResolvedValue({ creditLimitMinor: 20_000 });
    const create = vi.fn().mockResolvedValue({ kind: 'ACCEPTED' });
    await applyKhataLimitDecision(
      {
        pharmacyFamilyAccount: { update },
        pharmacyKhataLimitDecision: { create },
      } as never,
      scope,
      {
        familyAccountId: 'family_1',
        suggestion,
        ownerAuthorized: true,
        ownerAuthorizedByUserId: scope.actorId,
        ownerReauthenticatedAt: new Date(now.getTime() - 5 * 60_000),
      }
    );
    expect(update).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledOnce();
  });
});

describe('counter Khata ledger gate', () => {
  function fixture() {
    return {
      $queryRaw: vi.fn().mockResolvedValue([]),
      financeJournalEntry: {
        findFirstOrThrow: vi.fn().mockResolvedValue({ id: 'journal-entry-a' }),
      },
      pharmacySale: { findFirst: vi.fn().mockResolvedValue({ customerId: 'customer-a' }) },
      pharmacyFamilyAccount: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: 'family-a',
            displayName: 'Family',
            creditLimitMinor: 1000,
            members: [{ id: 'member-a' }],
          },
        ]),
        update: vi.fn().mockResolvedValue({ creditLimitMinor: 1100 }),
      },
      pharmacyKhataEvent: {
        groupBy: vi.fn().mockResolvedValue([
          { kind: 'CHARGE', _sum: { amountMinor: 1200 } },
          { kind: 'PAYMENT', _sum: { amountMinor: 700 } },
        ]),
        findMany: vi.fn().mockResolvedValue([]),
      },
      pharmacyKhataLimitDecision: { create: vi.fn().mockResolvedValue({}) },
    };
  }
  const input = { saleId: 'sale-a', familyAccountId: 'family-a', amountMinor: 500 };
  it('provides the finance journal lookup used by the Khata flow', async () => {
    const db = fixture();
    await expect(db.financeJournalEntry.findFirstOrThrow()).resolves.toEqual({
      id: 'journal-entry-a',
    });
  });
  it('uses all ledger events and accepts the exact limit without owner authorization', async () => {
    const db = fixture();
    expect(await readKhataBalance(db as never, scope, 'family-a')).toBe(500);
    await authorizeKhataCharge(db as never, scope, input, { authorized: false });
    expect(db.pharmacyKhataLimitDecision.create).not.toHaveBeenCalled();
    expect(db.pharmacyKhataEvent.groupBy).toHaveBeenCalledWith({
      by: ['kind'],
      where: {
        organizationId: scope.organizationId,
        branchId: scope.branchId,
        familyAccountId: 'family-a',
      },
      _sum: { amountMinor: true },
    });
  });
  it.each([
    { authorized: false, passwordAuthenticatedAt: Date.now() },
    { authorized: true, passwordAuthenticatedAt: Date.now() - 301000 },
    { authorized: true },
  ])('rejects over-limit override with insufficient server evidence: %j', async (owner) => {
    const db = fixture();
    await expect(
      authorizeKhataCharge(
        db as never,
        scope,
        { ...input, amountMinor: 600, ownerOverride: true },
        owner
      )
    ).rejects.toMatchObject({ reason: 'OWNER_ACTION_REQUIRED' });
    expect(db.pharmacyFamilyAccount.update).not.toHaveBeenCalled();
  });
  it('records the freshly reauthenticated owner and raised limit', async () => {
    const db = fixture();
    await authorizeKhataCharge(
      db as never,
      scope,
      { ...input, amountMinor: 600, ownerOverride: true },
      { authorized: true, passwordAuthenticatedAt: Date.now() }
    );
    expect(db.pharmacyKhataLimitDecision.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        appliedLimitMinor: 1100,
        ownerActorId: scope.actorId,
        reasons: expect.objectContaining({
          ownerAuthorizedByUserId: scope.actorId,
          ownerAuthorizedAt: expect.any(String),
        }),
      }),
    });
  });
  it('denies an account outside the sale customer membership and does not expose its statement', async () => {
    const db = fixture();
    await expect(
      authorizeKhataCharge(
        db as never,
        scope,
        { ...input, familyAccountId: 'foreign' },
        { authorized: true }
      )
    ).rejects.toMatchObject({ reason: 'ACCOUNT_NOT_FOUND' });
    await expect(
      readSaleKhataStatement(db as never, scope, input.saleId, 'foreign')
    ).rejects.toMatchObject({ reason: 'ACCOUNT_NOT_FOUND' });
    expect(db.pharmacyKhataEvent.findMany).not.toHaveBeenCalled();
  });
  it('blocks an over-limit charge without an explicit override', async () => {
    const db = fixture();
    await expect(
      authorizeKhataCharge(
        db as never,
        scope,
        { ...input, amountMinor: 501 },
        { authorized: true, passwordAuthenticatedAt: Date.now() }
      )
    ).rejects.toMatchObject({ reason: 'CREDIT_LIMIT_EXCEEDED' });
  });
});
