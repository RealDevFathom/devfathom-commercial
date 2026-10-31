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
  isPlaceholder: false,
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

type EndCondition = { effectiveTo: null | { gt: Date } };
type ProfileWhere = {
  organizationId: string;
  branchId?: string;
  OR?: Array<{ isPlaceholder: boolean; effectiveFrom: { lte: Date }; OR: EndCondition[] }>;
};

/** Evaluates the effective-window filter the way Postgres would. */
function matchesEffectiveWindow(
  row: { isPlaceholder: boolean; effectiveFrom: Date; effectiveTo: Date | null },
  where: ProfileWhere
): boolean {
  if (!where.OR) return false;
  return where.OR.some(
    (branch) =>
      branch.isPlaceholder === row.isPlaceholder &&
      row.effectiveFrom <= branch.effectiveFrom.lte &&
      branch.OR.some(({ effectiveTo: condition }) =>
        condition === null
          ? row.effectiveTo === null
          : row.effectiveTo !== null && row.effectiveTo > condition.gt
      )
  );
}

function fixture(
  timezone: string,
  effectiveTo: Date | null = null,
  overrides: Partial<typeof profile> = {}
) {
  const storedProfile = { ...profile, ...overrides, effectiveTo };
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
      findFirst: vi.fn(async ({ where }: { where: ProfileWhere }) =>
        where.organizationId === storedProfile.organizationId &&
        (!where.branchId || where.branchId === storedProfile.branchId) &&
        matchesEffectiveWindow(storedProfile, where)
          ? storedProfile
          : null
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

describe('placeholder profile boundaries keep instant semantics', () => {
  // Applied 2026-10-31 12:00 UTC (17:00 PKT); the workspace day began at 2026-10-30T19:00Z.
  const appliedAt = new Date('2026-10-31T12:00:00.000Z');
  const placeholder = { isPlaceholder: true, effectiveFrom: appliedAt };

  it.each([
    ['2026-10-31T11:59:59.999Z', false],
    ['2026-10-31T12:00:00.000Z', true],
  ])('a placeholder applied mid-day is in force from that instant (%s)', async (instant, ready) => {
    db = fixture('Asia/Karachi', null, placeholder);
    const readiness = await evaluatePharmacyReadiness(
      db as unknown as PrismaClient,
      profile.organizationId,
      new Date(instant)
    );
    expect(readiness.ready).toBe(ready);
  });

  it('a locked placeholder stops the instant it is locked, not at workspace midnight', async () => {
    const lockedAt = new Date('2026-10-31T13:00:00.000Z');
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-31T13:01:00.000Z'));
    db = fixture('Asia/Karachi', lockedAt, placeholder);

    const readiness = await evaluatePharmacyReadiness(
      db as unknown as PrismaClient,
      profile.organizationId
    );
    expect(readiness.ready).toBe(false);
    expect(readiness.blocking).toEqual(['PREMISES_AND_LICENCES']);

    await expect(
      executePlatformCommand(
        { id: 'operator', role: 'SUPER_ADMIN' } as never,
        'organization.transition',
        { id: profile.organizationId, status: 'ACTIVE', reason: 'Reactivate after lock' },
        new Request('https://admin.devfathom.com/api/platform/control', { method: 'POST' })
      )
    ).rejects.toMatchObject({ status: 400 });
    expect(db.organization.update).not.toHaveBeenCalled();

    await expect(
      assertStoredBranchMayOperate(
        db as unknown as PrismaClient,
        profile.organizationId,
        profile.branchId,
        { name: 'DISPENSE', schedule: 'RX' }
      )
    ).rejects.toMatchObject({ reason: 'PROFILE_MISSING' });
  });

  it('does not resurrect an operator profile superseded at an instant', async () => {
    const supersededAt = new Date('2026-10-31T12:00:00.000Z');
    db = fixture('Asia/Karachi', supersededAt);
    const readiness = await evaluatePharmacyReadiness(
      db as unknown as PrismaClient,
      profile.organizationId,
      new Date('2026-10-31T12:00:01.000Z')
    );
    expect(readiness.ready).toBe(false);
  });
});
