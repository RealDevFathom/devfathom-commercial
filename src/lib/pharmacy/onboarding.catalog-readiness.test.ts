import { describe, expect, it, vi } from 'vitest';

import type { PrismaClient } from '@/generated/prisma/client';

import { evaluatePharmacyReadiness } from './onboarding';

const ORG = 'org-dev18-catalog';

function readinessDb(publicationCount: number, packCount?: () => Promise<number>) {
  return {
    $queryRaw: vi.fn(async () => []),
    organization: {
      findUnique: vi.fn(async () => ({ packageId: 'pharmacy', package: { vertical: 'PHARMACY' } })),
    },
    pharmacyOnboardingGateState: { findMany: vi.fn(async () => []) },
    branchRegulatoryProfile: { findFirst: vi.fn(async () => null) },
    organizationRole: { count: vi.fn(async () => 0) },
    medicinePublicationEntry: { count: vi.fn(async () => publicationCount) },
    ...(packCount ? { packLevel: { count: packCount } } : {}),
    pharmacyInventoryLot: { count: vi.fn(async () => 0) },
    pharmacySupplier: { count: vi.fn(async () => 1) },
  } as unknown as PrismaClient;
}

describe('DEV-18 catalog evidence dependency', () => {
  it('returns supplier readiness without pack access when no medicine is published', async () => {
    const readiness = await evaluatePharmacyReadiness(readinessDb(0), ORG);

    expect(readiness.gates.find(({ gate }) => gate === 'PARTIES_AND_BALANCES')).toMatchObject({
      status: 'PASSED',
    });
    expect(readiness.blocking).toContain('MEDICINE_CATALOG_READINESS');
    expect(readiness.supplierChecksEnabled).toBe(true);
  });

  it('does not query packs when publication evidence already makes the catalog incomplete', async () => {
    const packCount = vi.fn(async (): Promise<number> => {
      throw new Error('pack read unavailable');
    });

    const readiness = await evaluatePharmacyReadiness(readinessDb(0, packCount), ORG);

    expect(readiness.blocking).toContain('MEDICINE_CATALOG_READINESS');
    expect(packCount).not.toHaveBeenCalled();
  });

  it('propagates pack evidence failures once publication evidence exists', async () => {
    const error = new Error('pack read unavailable');
    const packCount = vi.fn(async (): Promise<number> => {
      throw error;
    });

    await expect(evaluatePharmacyReadiness(readinessDb(1, packCount), ORG)).rejects.toBe(error);
    expect(packCount).toHaveBeenCalledExactlyOnceWith({
      where: {
        organizationId: ORG,
        effectiveFrom: { lte: expect.any(Date) },
        OR: [{ effectiveTo: null }, { effectiveTo: { gt: expect.any(Date) } }],
        barcodes: { some: { organizationId: ORG } },
        presentation: { medicine: { saleable: true } },
      },
    });
  });
});
