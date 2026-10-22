import { describe, expect, it, vi } from 'vitest';
import { quoteStay, taxMinorRoundHalfUp, type RateScope } from './rates';

const scope = (rows: Awaited<ReturnType<RateScope['loadPrices']>>) => ({
  organizationId: 'org-a',
  branchId: 'branch-a',
  loadPrices: vi.fn().mockResolvedValue(rows),
});

describe('hotel rates', () => {
  it('rounds basis-point tax half up using bigint only', () => {
    expect(taxMinorRoundHalfUp(1n, 5_000)).toBe(1n);
    expect(taxMinorRoundHalfUp(101n, 1_000)).toBe(10n);
  });

  it('rejects overflow', () => {
    expect(() => taxMinorRoundHalfUp(9_223_372_036_854_775_807n, 100_000)).toThrow('overflow');
  });

  it('passes both tenant dimensions to the server-side loader', async () => {
    const tenant = scope([
      { stayDate: new Date('2026-11-01'), netMinor: 100n, taxBasisPoints: 500 },
    ]);
    await quoteStay(tenant, 'room-a', 'plan-a', new Date('2026-11-01'), new Date('2026-11-02'));
    expect(tenant.loadPrices).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: 'org-a', branchId: 'branch-a' })
    );
  });
});
