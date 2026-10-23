import { describe, expect, it, vi } from 'vitest';

import type { PrismaClient } from '@/generated/prisma/client';

vi.mock('./regulatory', () => ({
  assertStoredBranchMayOperate: vi.fn(async () => undefined),
  BranchOperationDeniedError: class extends Error {},
}));

import { evaluatePharmacyReadiness, PHARMACY_ONBOARDING_STEPS } from './onboarding';

const standardRoleKeys = [
  'owner',
  'pharmacist',
  'manager',
  'cashier',
  'procurement',
  'inventory',
  'finance',
  'auditor',
];

function readinessDb(roles: Record<string, string[]>) {
  const countRoles = vi.fn(
    async ({ where }: { where: { organizationId: string; key: { in: string[] } } }) =>
      (roles[where.organizationId] ?? []).filter((key) => where.key.in.includes(key)).length
  );
  const db = {
    organization: {
      findUnique: vi.fn(async () => ({ packageId: 'pharmacy', package: { vertical: 'PHARMACY' } })),
    },
    pharmacyOnboardingGateState: {
      findMany: vi.fn(async () =>
        PHARMACY_ONBOARDING_STEPS.map(({ gate }) => ({
          gate,
          status: 'PASSED',
          evidenceRef: `test-evidence://${gate}`,
          actorId: 'test-operator',
          recordedAt: new Date('2026-09-12T00:00:00Z'),
        }))
      ),
    },
    branchRegulatoryProfile: { findFirst: vi.fn(async () => ({ branchId: 'branch-1' })) },
    organizationRole: { count: countRoles },
    medicinePublicationEntry: { count: vi.fn(async () => 1) },
    pharmacyInventoryLot: { count: vi.fn(async () => 1) },
    pharmacySupplier: { count: vi.fn(async () => 1) },
  } as unknown as PrismaClient;
  return { db, countRoles };
}

describe('optional pharmacy Owner / Operator readiness', () => {
  it('allows activation with only the original eight roles', async () => {
    const { db, countRoles } = readinessDb({ standard: standardRoleKeys });
    const result = await evaluatePharmacyReadiness(db, 'standard');
    expect(result.ready).toBe(true);
    expect(result.blocking).toEqual([]);
    expect(countRoles).toHaveBeenCalledExactlyOnceWith({
      where: { organizationId: 'standard', key: { in: standardRoleKeys } },
    });
    expect(db.branchRegulatoryProfile.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ branch: { active: true } }) })
    );
  });

  it('leaves every gate unchanged when the optional role is also present', async () => {
    const standard = readinessDb({ pharmacy: standardRoleKeys });
    const combined = readinessDb({ pharmacy: [...standardRoleKeys, 'owner-operator'] });
    await expect(evaluatePharmacyReadiness(combined.db, 'pharmacy')).resolves.toEqual(
      await evaluatePharmacyReadiness(standard.db, 'pharmacy')
    );
  });

  it.each(standardRoleKeys)(
    'still blocks missing standard role %s even with Owner / Operator',
    async (missing) => {
      const { db } = readinessDb({
        incomplete: [...standardRoleKeys.filter((key) => key !== missing), 'owner-operator'],
      });
      const result = await evaluatePharmacyReadiness(db, 'incomplete');
      expect(result.ready).toBe(false);
      expect(result.blocking).toEqual(['OWNER_AND_ROLE_TEMPLATES']);
    }
  );

  it('keeps concurrent organizations independent when only one has the required roles', async () => {
    const { db, countRoles } = readinessDb({
      standard: standardRoleKeys,
      incomplete: ['owner-operator'],
    });
    const [standard, incomplete] = await Promise.all([
      evaluatePharmacyReadiness(db, 'standard'),
      evaluatePharmacyReadiness(db, 'incomplete'),
    ]);
    expect(standard.ready).toBe(true);
    expect(incomplete.ready).toBe(false);
    expect(incomplete.blocking).toEqual(['OWNER_AND_ROLE_TEMPLATES']);
    expect(countRoles).toHaveBeenCalledTimes(2);
  });
});
