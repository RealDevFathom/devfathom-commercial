import { describe, expect, it, vi } from 'vitest';
import {
  MAX_MONEY_MINOR,
  MAX_TAX_BASIS_POINTS,
  quoteStay,
  taxMinorRoundHalfUp,
  type RateScope,
} from './rates';

const scope = (rows: Awaited<ReturnType<RateScope['loadPrices']>>) => ({
  organizationId: 'org-a',
  branchId: 'branch-a',
  loadPrices: vi.fn().mockResolvedValue(rows),
});

describe('hotel rates', () => {
  it('rounds basis-point tax half up using bigint only', () => {
    expect(taxMinorRoundHalfUp(BigInt(1), 5_000)).toBe(BigInt(1));
    expect(taxMinorRoundHalfUp(BigInt(101), 1_000)).toBe(BigInt(10));
  });

  it('rejects overflow', () => {
    expect(() => taxMinorRoundHalfUp(MAX_MONEY_MINOR + BigInt(1), 100)).toThrow('overflow');
    // At the 100% ceiling the tax equals the net; the sum is what overflows.
    expect(taxMinorRoundHalfUp(MAX_MONEY_MINOR, MAX_TAX_BASIS_POINTS)).toBe(MAX_MONEY_MINOR);
  });

  it('caps the tax rate at 100%, the same ceiling as catalog extras', () => {
    expect(() => taxMinorRoundHalfUp(BigInt(100), MAX_TAX_BASIS_POINTS + 1)).toThrow('Invalid tax');
    expect(() => taxMinorRoundHalfUp(BigInt(100), 100_000)).toThrow('Invalid tax');
  });

  it('passes both tenant dimensions to the server-side loader', async () => {
    const tenant = scope([
      { stayDate: new Date('2026-11-01'), netMinor: BigInt(100), taxBasisPoints: 500 },
    ]);
    await quoteStay(tenant, 'room-a', 'plan-a', new Date('2026-11-01'), new Date('2026-11-02'));
    expect(tenant.loadPrices).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: 'org-a', branchId: 'branch-a' })
    );
  });

  it('sums per-night net and tax and refuses an unpriced night', async () => {
    const priced = scope([
      { stayDate: new Date('2026-11-01'), netMinor: BigInt(10_000), taxBasisPoints: 1_600 },
      { stayDate: new Date('2026-11-02'), netMinor: BigInt(12_000), taxBasisPoints: 1_600 },
    ]);
    await expect(
      quoteStay(priced, 'room-a', 'plan-a', new Date('2026-11-01'), new Date('2026-11-03'))
    ).resolves.toMatchObject({
      netMinor: BigInt(22_000),
      taxMinor: BigInt(3_520),
      totalMinor: BigInt(25_520),
    });
    await expect(
      quoteStay(priced, 'room-a', 'plan-a', new Date('2026-11-01'), new Date('2026-11-04'))
    ).rejects.toThrow('every night');
  });
});
