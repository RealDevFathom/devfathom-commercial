import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  raw: vi.fn(),
  execute: vi.fn(),
  session: vi.fn(),
  budget: vi.fn(),
}));
vi.mock('@/lib/tenancy/scoped-db', () => ({
  withPlatformDb: (run: (db: unknown) => unknown) =>
    run({ $queryRaw: mocks.raw, $executeRaw: mocks.execute }),
}));
vi.mock('@/lib/platform/auth', () => ({ requirePlatformSession: mocks.session }));
vi.mock('./budget', () => ({ getAiBudgetMinor: mocks.budget }));

import { karachiMonthRange, maybeCreateAIBudgetAlert, readMonthlyAIUsage } from './usage';

describe('monthly AI usage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.budget.mockResolvedValue(10_000);
    mocks.session.mockResolvedValue({ id: 'admin', role: 'SUPER_ADMIN' });
  });

  it('uses Asia/Karachi calendar boundaries', () => {
    expect(karachiMonthRange(new Date('2026-10-31T20:00:00Z'))).toEqual({
      month: '2026-11',
      from: new Date('2026-10-31T19:00:00.000Z'),
      to: new Date('2026-11-30T19:00:00.000Z'),
    });
  });

  it('aggregates provider and tier spend', async () => {
    mocks.raw.mockResolvedValue([
      { provider: 'anthropic', tier: 'cheap', spendMinor: 2_000n },
      { provider: 'anthropic', tier: 'deep', spendMinor: 3_000n },
      { provider: 'bedrock', tier: 'cheap', spendMinor: 1_000n },
    ]);
    const result = await readMonthlyAIUsage(new Date('2026-10-10T00:00:00Z'));
    expect(result.providerSpendMinor).toEqual({ anthropic: 5_000, bedrock: 1_000 });
    expect(result.tierSpendMinor).toEqual({ cheap: 3_000, deep: 3_000 });
    expect(result.totalSpendMinor).toBe(6_000);
    expect(result.percentUsed).toBe(50);
  });

  it('forbids non-SuperAdmins before querying usage', async () => {
    mocks.session.mockResolvedValue({ id: 'ops', role: 'OPERATIONS' });
    await expect(readMonthlyAIUsage()).rejects.toMatchObject({ status: 403 });
    expect(mocks.raw).not.toHaveBeenCalled();
  });

  it('alerts once at 80 percent and can alert again next month', async () => {
    mocks.raw.mockResolvedValue([{ provider: 'anthropic', tier: 'cheap', spendMinor: 8_000n }]);
    mocks.execute
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(2)
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(2);
    await expect(maybeCreateAIBudgetAlert(new Date('2026-10-20T00:00:00Z'))).resolves.toBe(true);
    await expect(maybeCreateAIBudgetAlert(new Date('2026-10-21T00:00:00Z'))).resolves.toBe(false);
    await expect(maybeCreateAIBudgetAlert(new Date('2026-11-20T00:00:00Z'))).resolves.toBe(true);
  });

  it('allows only one claim when alert attempts race', async () => {
    mocks.raw.mockResolvedValue([{ provider: 'anthropic', tier: 'cheap', spendMinor: 8_000n }]);
    let claimed = false;
    mocks.execute.mockImplementation(async () => {
      if (!claimed) {
        claimed = true;
        return 1;
      }
      return 0;
    });
    const results = await Promise.all([
      maybeCreateAIBudgetAlert(new Date('2026-10-20T00:00:00Z')),
      maybeCreateAIBudgetAlert(new Date('2026-10-20T00:00:00Z')),
    ]);
    expect(results.sort()).toEqual([false, true]);
  });

  it('propagates notification failure so the platform transaction can roll back its claim', async () => {
    mocks.raw.mockResolvedValue([{ provider: 'anthropic', tier: 'cheap', spendMinor: 8_000n }]);
    mocks.execute.mockResolvedValueOnce(1).mockRejectedValueOnce(new Error('notification failed'));
    await expect(maybeCreateAIBudgetAlert()).rejects.toThrow('notification failed');
  });

  it('rejects unsafe database minor units instead of rounding them', async () => {
    mocks.raw.mockResolvedValue([
      {
        provider: 'anthropic',
        tier: 'cheap',
        spendMinor: BigInt(Number.MAX_SAFE_INTEGER) + 1n,
      },
    ]);
    await expect(readMonthlyAIUsage()).rejects.toThrow('outside the safe minor-unit range');
  });

  it('does not alert below 80 percent', async () => {
    mocks.raw.mockResolvedValue([{ provider: 'anthropic', tier: 'cheap', spendMinor: 7_999n }]);
    await expect(maybeCreateAIBudgetAlert()).resolves.toBe(false);
    expect(mocks.execute).not.toHaveBeenCalled();
  });
});
