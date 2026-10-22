import { describe, expect, it, vi } from 'vitest';

import { BranchCommercialTermsError, loadBranchCommercialTerms } from './branch-commercial-terms';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

const at = new Date('2026-10-21T00:00:00.000Z');

describe('loadBranchCommercialTerms', () => {
  it('returns the branch tax profile and the effective service-charge rate', async () => {
    const db = {
      restaurantTaxProfileVersion: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: 'profile-1',
            effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
            effectiveTo: null,
            status: 'PUBLISHED',
            approvalReference: 'TAX-1',
            approvedAt: new Date('2025-12-01T00:00:00.000Z'),
            rules: [
              {
                id: 'rule-cash',
                profileVersionId: 'profile-1',
                paymentCategory: 'CASH',
                priceMode: 'EXCLUSIVE',
                rate: { toString: () => '0.050000' },
                effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
                effectiveTo: null,
                status: 'PUBLISHED',
                approvalReference: 'TAX-1',
                approvedAt: new Date('2025-12-01T00:00:00.000Z'),
                officialSource: { expiresAt: new Date('2027-01-01T00:00:00.000Z') },
              },
            ],
          },
        ]),
      },
      restaurantServiceChargePolicyVersion: {
        findMany: vi.fn().mockResolvedValue([{ rate: { toString: () => '0.100000' } }]),
      },
    };
    const terms = await loadBranchCommercialTerms(db as unknown as ScopedDb, 'branch-1', at);
    expect(db.restaurantTaxProfileVersion.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          branchId: 'branch-1',
          status: 'PUBLISHED',
          effectiveFrom: { lte: at },
          OR: [{ effectiveTo: null }, { effectiveTo: { gt: at } }],
        },
        select: expect.objectContaining({
          rules: expect.objectContaining({
            where: {
              status: 'PUBLISHED',
              effectiveFrom: { lte: at },
              OR: [{ effectiveTo: null }, { effectiveTo: { gt: at } }],
            },
          }),
        }),
      })
    );
    expect(db.restaurantServiceChargePolicyVersion.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ branchId: 'branch-1', effectiveFrom: { lte: at } }),
        take: 2,
      })
    );
    expect(terms.serviceChargeRate).toBe('0.100000');
    expect(terms.profiles[0]).toMatchObject({ id: 'profile-1', status: 'PUBLISHED' });
    expect(terms.rules[0]).toMatchObject({ rate: '0.050000', paymentCategory: 'CASH' });
  });

  it('returns a null service-charge rate when the branch has no effective policy', async () => {
    const db = {
      restaurantTaxProfileVersion: { findMany: vi.fn().mockResolvedValue([]) },
      restaurantServiceChargePolicyVersion: { findMany: vi.fn().mockResolvedValue([]) },
    };
    const terms = await loadBranchCommercialTerms(db as unknown as ScopedDb, 'branch-1', at);
    expect(terms).toEqual({ profiles: [], rules: [], serviceChargeRate: null });
  });

  it('denies an ambiguous service-charge policy instead of choosing one', async () => {
    const db = {
      restaurantTaxProfileVersion: { findMany: vi.fn().mockResolvedValue([]) },
      restaurantServiceChargePolicyVersion: {
        findMany: vi.fn().mockResolvedValue([
          { rate: { toString: () => '0.100000' } },
          { rate: { toString: () => '0.200000' } },
        ]),
      },
    };

    await expect(
      loadBranchCommercialTerms(db as unknown as ScopedDb, 'branch-1', at)
    ).rejects.toBeInstanceOf(BranchCommercialTermsError);
  });
});
