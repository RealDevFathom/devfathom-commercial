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
        overrideReason: 'Customer emergency',
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
      ownerAuthorizedByUserId: 'manager_1',
      ownerReauthenticatedAt: now,
      overrideReason: 'Customer has approved terms',
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
          ownerActorId: 'manager_1',
          reasons: {
            reasons: suggestion.reasons,
            ownerAuthorizedByUserId: 'manager_1',
            ownerReauthenticatedAt: now.toISOString(),
            ownerAuthorizedAt: now.toISOString(),
            overrideReason: 'Customer has approved terms',
          },
        }),
      })
    );
  });

  it.each([
    ['missing', undefined, 'manager_1'],
    ['expired', new Date('2026-09-29T15:54:59.999Z'), 'manager_1'],
    ['future', new Date('2026-09-29T16:00:00.001Z'), 'manager_1'],
    ['invalid', new Date('invalid'), 'manager_1'],
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
          overrideReason: 'Approved exception',
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
        ownerAuthorizedByUserId: 'manager_1',
        ownerReauthenticatedAt: new Date(now.getTime() - 5 * 60_000),
        overrideReason: 'Approved exception',
      }
    );
    expect(update).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledOnce();
  });
});

describe('counter Khata ledger gate', () => {
  function fixture() {
    return {
      $queryRaw: vi.fn()
        .mockResolvedValueOnce([])
        .mockResolvedValue([{ id: 'manager_1', status: 'ACTIVE', organizationId: scope.organizationId, roleKey: 'manager', isSystem: true }]),
      pharmacySale: { findFirst: vi.fn().mockResolvedValue({ customerId: 'customer-a', createdByUserId: 'cashier_1' }) },
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
  it('returns the sale member account balance and scoped financial statement', async () => {
    const db = fixture();
    const entries = [
      { id: 'charge-a', kind: 'CHARGE', amountMinor: 1200, occurredAt: new Date('2026-10-01') },
      { id: 'payment-a', kind: 'PAYMENT', amountMinor: 700, occurredAt: new Date('2026-10-02') },
    ];
    db.pharmacyKhataEvent.findMany.mockResolvedValue(entries);

    const statement = await readSaleKhataStatement(
      db as never,
      scope,
      input.saleId,
      input.familyAccountId
    );

    expect(statement).toEqual({
      account: {
        id: 'family-a',
        displayName: 'Family',
        creditLimitMinor: 1000,
        memberId: 'member-a',
        balanceMinor: 500,
      },
      generatedAt: expect.any(Date),
      truncated: false,
      entries,
    });
    expect(db.pharmacySale.findFirst).toHaveBeenCalledWith({
      where: { id: input.saleId, organizationId: scope.organizationId, branchId: scope.branchId },
      select: { customerId: true },
    });
    expect(db.pharmacyFamilyAccount.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          organizationId: scope.organizationId,
          branchId: scope.branchId,
          active: true,
          members: { some: { customerId: 'customer-a' } },
        },
      })
    );
    expect(db.pharmacyKhataEvent.findMany).toHaveBeenCalledWith({
      where: {
        organizationId: scope.organizationId,
        branchId: scope.branchId,
        familyAccountId: input.familyAccountId,
      },
      select: { id: true, kind: true, amountMinor: true, occurredAt: true },
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      take: 1001,
    });
  });
  it('uses all ledger events and accepts the exact limit without owner authorization', async () => {
    const db = fixture();
    expect(await readKhataBalance(db as never, scope, 'family-a')).toBe(500);
    await authorizeKhataCharge(db as never, scope, input, {});
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
    { approverId: 'manager_1', reason: 'Approved', reauthenticatedAt: Date.now() - 301000 },
    { approverId: 'manager_1', reason: 'Approved' },
    { approverId: 'manager_1', reauthenticatedAt: Date.now() },
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
  it.each(['owner', 'manager'])('allows an active system %s to approve', async (roleKey) => {
    const db = fixture();
    db.$queryRaw.mockReset().mockResolvedValueOnce([]).mockResolvedValue([
      {
        id: 'manager_1',
        status: 'ACTIVE',
        organizationId: scope.organizationId,
        roleKey,
        isSystem: true,
      },
    ]);
    await authorizeKhataCharge(
      db as never,
      scope,
      { ...input, amountMinor: 600, ownerOverride: true },
      { approverId: 'manager_1', reason: 'Approved exception', reauthenticatedAt: Date.now() }
    );
    expect(db.pharmacyKhataLimitDecision.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        appliedLimitMinor: 1100,
        ownerActorId: 'manager_1',
        reasons: expect.objectContaining({
          ownerAuthorizedByUserId: 'manager_1',
          ownerAuthorizedAt: expect.any(String),
          overrideReason: 'Approved exception',
        }),
      }),
    });
    expect(db.pharmacyKhataEvent.findMany).toHaveBeenCalledWith({
      where: {
        organizationId: scope.organizationId,
        branchId: scope.branchId,
        familyAccountId: 'family-a',
        occurredAt: { gte: expect.any(Date), lte: expect.any(Date) },
      },
      select: {
        id: true,
        kind: true,
        amountMinor: true,
        occurredAt: true,
        dueAt: true,
        settlesChargeId: true,
      },
    });
  });
  it.each([
    ['cashier role', { status: 'ACTIVE', roleKey: 'cashier', isSystem: true }],
    ['custom role', { status: 'ACTIVE', roleKey: 'manager', isSystem: false }],
    ['no role', { status: 'ACTIVE', roleKey: null, isSystem: null }],
    ['deactivated', { status: 'INACTIVE', roleKey: 'owner', isSystem: true }],
    ['revoked mid-flow', { status: 'ACTIVE', roleKey: 'cashier', isSystem: true }],
  ])('refuses an approver with %s on the in-transaction read', async (_label, row) => {
    const db = fixture();
    db.$queryRaw.mockReset().mockResolvedValueOnce([]).mockResolvedValue([
      { id: 'manager_1', organizationId: scope.organizationId, ...row },
    ]);
    await expect(
      authorizeKhataCharge(
        db as never,
        scope,
        { ...input, amountMinor: 600, ownerOverride: true },
        { approverId: 'manager_1', reason: 'Approved exception', reauthenticatedAt: Date.now() }
      )
    ).rejects.toMatchObject({ reason: 'OWNER_ACTION_REQUIRED' });
    expect(db.pharmacyFamilyAccount.update).not.toHaveBeenCalled();
  });
  it('refuses self-approval before reading or writing the approver', async () => {
    const db = fixture();
    await expect(
      authorizeKhataCharge(
        db as never,
        scope,
        { ...input, amountMinor: 600, ownerOverride: true },
        { approverId: 'cashier_1', reason: 'Approved', reauthenticatedAt: Date.now() }
      )
    ).rejects.toMatchObject({ reason: 'OWNER_ACTION_REQUIRED' });
    expect(db.$queryRaw).toHaveBeenCalledOnce();
    expect(db.pharmacyFamilyAccount.update).not.toHaveBeenCalled();
  });
  it('denies an account outside the sale customer membership and does not expose its statement', async () => {
    const db = fixture();
    await expect(
      authorizeKhataCharge(
        db as never,
        scope,
        { ...input, familyAccountId: 'foreign' },
        { approverId: 'manager_1', reason: 'Approved exception' }
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
        { approverId: 'manager_1', reason: 'Approved exception', reauthenticatedAt: Date.now() }
      )
    ).rejects.toMatchObject({ reason: 'CREDIT_LIMIT_EXCEEDED' });
  });
});
