import { afterEach, describe, expect, it, vi } from 'vitest';

import type { PrismaClient } from '@/generated/prisma/client';
import { evaluatePharmacyReadiness, PHARMACY_ONBOARDING_STEPS } from '@/lib/pharmacy/onboarding';
import { assertStoredBranchMayOperate } from '@/lib/pharmacy/regulatory';

vi.mock('@/lib/platform/auth', () => ({ assertPlatformCapability: vi.fn() }));
vi.mock('@/lib/tenancy/scoped-db', () => ({
  withPlatformDb: vi.fn(async (run: (db: unknown) => Promise<unknown>) => run(db)),
}));
vi.mock('@/server/audit', () => ({ recordAudit: vi.fn() }));

import { executePlatformCommand } from './commands';

const effectiveFrom = new Date('2026-10-21T00:00:00.000Z');
const profile = {
  organizationId: 'org_pharmacy',
  branchId: 'branch_pharmacy',
  effectiveFrom,
  effectiveTo: null,
  licenceCategory: 'PHARMACY',
  licenceValidFrom: effectiveFrom,
  licenceValidTo: new Date('2027-01-01T00:00:00.000Z'),
  licenceEvidenceFileRef: 'evidence://licence',
  permittedSchedules: ['RX'],
  qualifiedPersonRegistration: 'QP-1',
  qualifiedPersonValidFrom: effectiveFrom,
  qualifiedPersonValidTo: new Date('2027-01-01T00:00:00.000Z'),
  qualifiedPersonCoverageRosterRef: 'evidence://roster',
  jurisdictionRuleSet: {
    licenceCategories: { provisional: false, values: ['PHARMACY'] },
    permittedSchedules: { provisional: false, values: ['RX'] },
    pharmacistCoverageRule: { provisional: false },
  },
};

function fixture(timezone: string, effectiveTo: Date | null = null) {
  const storedProfile = { ...profile, effectiveTo };
  const organization = {
    id: profile.organizationId,
    status: 'ONBOARDING',
    vertical: 'PHARMACY',
    timezone,
    packageId: 'pharmacy',
    package: { vertical: 'PHARMACY', moduleLinks: [{ moduleId: 'pharmacy-core' }] },
    modules: [],
    users: [{ id: 'admin' }],
    deployments: [{ id: 'production' }],
  };
  return {
    organization: {
      findUnique: vi.fn(async () => organization),
      findFirst: vi.fn(async () => organization),
      update: vi.fn(async () => ({ ...organization, status: 'ACTIVE' })),
    },
    branchRegulatoryProfile: {
      findFirst: vi.fn(
        async ({
          where,
        }: {
          where: {
            organizationId: string;
            branchId?: string;
            effectiveFrom?: { lte: Date };
            OR?: Array<{ effectiveTo: null | { gt: Date } }>;
          };
        }) => {
          if (!where.effectiveFrom || !where.OR) return null;
          return where.organizationId === profile.organizationId &&
            (!where.branchId || where.branchId === profile.branchId) &&
            effectiveFrom <= where.effectiveFrom.lte &&
            where.OR.some(({ effectiveTo: condition }) =>
              condition === null
                ? effectiveTo === null
                : effectiveTo !== null && effectiveTo > condition.gt
            )
            ? storedProfile
            : null;
        }
      ),
    },
    pharmacyOnboardingGateState: {
      findMany: vi.fn(async () =>
        PHARMACY_ONBOARDING_STEPS.map(({ gate }) => ({
          gate,
          status: 'PASSED',
          actorId: 'operator',
          evidenceRef: `evidence://${gate}`,
        }))
      ),
    },
    organizationRole: { count: vi.fn(async () => 8) },
    medicinePublicationEntry: { count: vi.fn(async () => 1) },
    pharmacyInventoryLot: { count: vi.fn(async () => 1) },
    pharmacySupplier: { count: vi.fn(async () => 1) },
    organizationLifecycleEvent: { create: vi.fn(async () => ({ id: 'event' })) },
    platformAuditLog: { create: vi.fn(async () => ({ id: 'audit' })) },
  };
}

let db: ReturnType<typeof fixture>;

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('pharmacy readiness and activation use the workspace calendar date', () => {
  it.each([
    ['Asia/Karachi', '2026-10-20T19:00:00.000Z', true],
    ['Asia/Karachi', '2026-10-20T23:59:59.999Z', true],
    ['Asia/Karachi', '2026-10-20T18:59:59.999Z', false],
    ['America/Los_Angeles', '2026-10-21T06:59:59.999Z', false],
    ['America/Los_Angeles', '2026-10-21T07:00:00.000Z', true],
    ['UTC', '2026-10-21T00:00:00.000Z', true],
    ['PKT', '2026-10-21T00:00:00.000Z', true],
    ['PKT', '2026-10-20T23:59:59.999Z', false],
  ])('%s at %s has readiness %s', async (timezone, instant, ready) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(instant));
    db = fixture(timezone);
    const readiness = await evaluatePharmacyReadiness(
      db as unknown as PrismaClient,
      profile.organizationId
    );
    expect(readiness.ready).toBe(ready);
    expect(readiness.blocking).toEqual(ready ? [] : ['PREMISES_AND_LICENCES']);

    const activation = executePlatformCommand(
      { id: 'operator', role: 'SUPER_ADMIN' } as never,
      'organization.transition',
      { id: profile.organizationId, status: 'ACTIVE', reason: 'Onboarding is complete' },
      new Request('https://admin.devfathom.com/api/platform/control', { method: 'POST' })
    );
    if (ready) {
      await expect(activation).resolves.toBeDefined();
      expect(db.organization.update).toHaveBeenCalledOnce();
    } else {
      await expect(activation).rejects.toMatchObject({ status: 400 });
      expect(db.organization.update).not.toHaveBeenCalled();
    }
  });

  it.each([
    ['2026-10-21T18:59:59.999Z', true],
    ['2026-10-21T19:00:00.000Z', false],
  ])('closes date-only profiles at workspace midnight (%s)', async (instant, ready) => {
    db = fixture('Asia/Karachi', new Date('2026-10-22T00:00:00.000Z'));
    const readiness = await evaluatePharmacyReadiness(
      db as unknown as PrismaClient,
      profile.organizationId,
      new Date(instant)
    );
    expect(readiness.ready).toBe(ready);
  });

  it.each([
    ['licenceValidTo', 'LICENCE_INVALID'],
    ['qualifiedPersonValidTo', 'QUALIFIED_PERSON_COVERAGE_MISSING'],
  ] as const)('preserves the %s expiry instant in the stored guard', async (field, reason) => {
    db = fixture('Asia/Karachi');
    const expiry = new Date('2026-10-21T00:00:00.000Z');
    db.branchRegulatoryProfile.findFirst.mockResolvedValue({ ...profile, [field]: expiry });
    await expect(
      assertStoredBranchMayOperate(
        db as unknown as PrismaClient,
        profile.organizationId,
        profile.branchId,
        {
          name: 'DISPENSE',
          at: expiry,
          schedule: 'RX',
        }
      )
    ).rejects.toMatchObject({ reason });
  });
});
