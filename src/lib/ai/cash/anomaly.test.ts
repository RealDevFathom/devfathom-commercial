import { describe, expect, it, vi } from 'vitest';
import { analyzeCashClose, CashAnomalyAccessError, detectCashCloseAnomalies } from './anomaly';

const input = {
  organizationId: 'org_1',
  branchId: 'branch_1',
  closeId: 'close_1',
  declaredCashMinor: 8_000,
  cashSalesMinor: 10_000,
  cashRefundsMinor: 500,
  cashPayoutsMinor: 500,
  varianceLimitMinor: 500,
  cashiers: [
    {
      cashierId: 'cashier_1',
      transactionCount: 20,
      voidCount: 2,
      refundCount: 1,
      discountCount: 4,
    },
  ],
  sales: [{ saleId: 'sale_1', occurredAt: '2026-10-21T23:00:00.000Z', localHour: 23 }],
  businessHours: { opensAtHour: 9, closesAtHour: 22 },
};

describe('cash-close anomaly rules', () => {
  it('deterministically flags variance, cashier rates, and after-hours sales', () => {
    const result = detectCashCloseAnomalies(input);
    expect(result.expectedCashMinor).toBe(9_000);
    expect(result.anomalies.map((x) => x.kind)).toEqual([
      'CASH_VARIANCE',
      'UNUSUAL_VOID_RATE',
      'UNUSUAL_DISCOUNT_RATE',
      'AFTER_HOURS_SALE',
    ]);
  });

  it('does not flag small cashier samples or overnight business hours', () => {
    const result = detectCashCloseAnomalies({
      ...input,
      declaredCashMinor: 9_000,
      cashiers: [{ ...input.cashiers[0], transactionCount: 9 }],
      sales: [{ ...input.sales[0], localHour: 1 }],
      businessHours: { opensAtHour: 18, closesAtHour: 2 },
    });
    expect(result.anomalies).toEqual([]);
  });
});

describe('cash-close AI boundary', () => {
  function actor(
    overrides: Partial<{ organizationId: string; role: string; allowed: boolean }> = {}
  ) {
    const audit = vi.fn().mockResolvedValue({});
    return {
      value: {
        organizationId: overrides.organizationId ?? 'org_1',
        userId: 'owner_1',
        role: overrides.role ?? 'ADMIN',
        can: vi.fn().mockResolvedValue(overrides.allowed ?? true),
        db: { auditLog: { create: audit } } as never,
      },
      audit,
    };
  }

  it('lets AI summarize only deterministic findings and audits model and tier', async () => {
    const a = actor();
    const summarize = vi
      .fn()
      .mockResolvedValue('One cash variance and cashier exceptions need review.');
    const result = await analyzeCashClose(a.value, input, {
      readProviderConfig: vi.fn().mockResolvedValue({
        provider: 'anthropic',
        secretConfigured: true,
        providerEnv: { ANTHROPIC_API_KEY: 'test-only' },
      }),
      summarize,
    });
    expect(summarize).toHaveBeenCalledWith(result.anomalies, expect.anything());
    expect(result.ai).toMatchObject({ status: 'READY', tier: 'standard' });
    expect(a.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          organizationId: 'org_1',
          actorId: 'owner_1',
          metadata: expect.objectContaining({ tier: 'standard', model: expect.any(String) }),
        }),
      })
    );
  });

  it('keeps AI off without the organization provider secret and audits the attempt', async () => {
    const a = actor();
    const result = await analyzeCashClose(a.value, input, {
      readProviderConfig: vi.fn().mockResolvedValue(null),
    });
    expect(result).toMatchObject({ summary: null, ai: { status: 'UNAVAILABLE', model: null } });
    expect(a.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ outcome: 'FAILURE', errorCode: 'AI_NOT_CONFIGURED' }),
      })
    );
  });

  it.each([{ role: 'MEMBER' }, { allowed: false }, { organizationId: 'org_2' }])(
    'denies non-owners, explicit permission denial, and cross-tenant input: %j',
    async (override) => {
      const a = actor(override);
      await expect(
        analyzeCashClose(a.value, input, { readProviderConfig: vi.fn() })
      ).rejects.toBeInstanceOf(CashAnomalyAccessError);
      expect(a.audit).not.toHaveBeenCalled();
    }
  );
});
