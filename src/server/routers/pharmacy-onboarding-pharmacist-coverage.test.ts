/**
 * DEV-846 (DEV-86) — the owner records pharmacist coverage hours per branch.
 * The record is owner-only, optimistic on its revision, audited with before and
 * after, and never turns on the live-sale hours check: that stays with the
 * jurisdiction rule set until the adviser's provincial rules are published.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  can: vi.fn(async () => true),
  branchFindFirst: vi.fn(),
  organizationFindFirst: vi.fn(),
  profileFindFirst: vi.fn(),
  updateMany: vi.fn(),
  transaction: vi.fn(),
  recordAudit: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn() }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/abac', async () => {
  const actual = await vi.importActual<typeof import('@/lib/abac')>('@/lib/abac');
  return { ...actual, can: mocks.can };
});
vi.mock('@/server/audit', () => ({
  ipFromHeaders: vi.fn(() => null),
  isAuditExcludedPath: vi.fn(() => false),
  recordTrpcAudit: vi.fn(),
  recordAudit: mocks.recordAudit,
}));

import { Prisma } from '@/generated/prisma/client';
import { PHARMACIST_COVERAGE_HOURS_SET_ACTION } from '@/lib/pharmacy/pharmacist-coverage-hours';
import type { TRPCContext } from '../trpc';
import { pharmacyOnboardingRouter } from './pharmacy-onboarding';

function context(role = 'ADMIN'): TRPCContext {
  return {
    db: {
      pharmacyBranch: { findFirst: mocks.branchFindFirst },
      organization: { findFirst: mocks.organizationFindFirst },
      branchRegulatoryProfile: { findFirst: mocks.profileFindFirst },
      $transaction: mocks.transaction,
    },
    entitlements: {
      organizationId: 'pharmacy-org',
      enabledModules: ['pharmacy-core'],
      modules: [{ key: 'pharmacy-core', name: 'Pharmacy', enabled: true }],
    },
    session: {
      expires: 'later',
      user: { id: 'owner', organizationId: 'pharmacy-org', role, status: 'ACTIVE' },
    },
    organization: { id: 'pharmacy-org' },
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext;
}

const weekdays = { days: [5, 1, 2, 3, 4], start: '09:00', end: '17:00' };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.can.mockResolvedValue(true);
  mocks.organizationFindFirst.mockResolvedValue({ timezone: 'Asia/Karachi' });
  mocks.profileFindFirst.mockResolvedValue(null);
  mocks.updateMany.mockResolvedValue({ count: 1 });
  mocks.transaction.mockImplementation(async (run: (tx: unknown) => Promise<unknown>) =>
    run({ pharmacyBranch: { updateMany: mocks.updateMany } })
  );
});

describe('pharmacistCoverage', () => {
  it('reads the recorded hours and reports the live-sale hours check off', async () => {
    mocks.branchFindFirst.mockResolvedValue({
      id: 'branch-1',
      pharmacistCoverageHours: { timeZone: 'Asia/Karachi', windows: [weekdays] },
      pharmacistCoverageRevision: 3,
    });
    mocks.profileFindFirst.mockResolvedValue({
      jurisdictionRuleSet: { pharmacistCoverageRule: { provisional: true, values: {} } },
    });
    const result = await pharmacyOnboardingRouter
      .createCaller(context())
      .pharmacistCoverage({ branchId: 'branch-1' });
    expect(result).toEqual({
      branchId: 'branch-1',
      timeZone: 'Asia/Karachi',
      windows: [weekdays],
      revision: 3,
      liveSaleHoursCheck: false,
    });
    expect(mocks.branchFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { organizationId: 'pharmacy-org', id: 'branch-1', active: true },
      })
    );
  });

  it('reports the check on only when the branch rule set publishes presence hours', async () => {
    mocks.branchFindFirst.mockResolvedValue({
      id: 'branch-1',
      pharmacistCoverageHours: null,
      pharmacistCoverageRevision: 0,
    });
    mocks.profileFindFirst.mockResolvedValue({
      jurisdictionRuleSet: {
        pharmacistCoverageRule: {
          provisional: false,
          values: { presenceHours: { windows: [weekdays] } },
        },
      },
    });
    const result = await pharmacyOnboardingRouter
      .createCaller(context())
      .pharmacistCoverage({ branchId: 'branch-1' });
    expect(result).toMatchObject({ windows: [], liveSaleHoursCheck: true });
  });

  it('refuses a branch outside this workspace', async () => {
    mocks.branchFindFirst.mockResolvedValue(null);
    await expect(
      pharmacyOnboardingRouter.createCaller(context()).pharmacistCoverage({ branchId: 'other' })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('is not available to a cashier', async () => {
    mocks.can.mockResolvedValue(false);
    await expect(
      pharmacyOnboardingRouter
        .createCaller(context('MEMBER'))
        .pharmacistCoverage({ branchId: 'branch-1' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.branchFindFirst).not.toHaveBeenCalled();
  });
});

describe('savePharmacistCoverage', () => {
  beforeEach(() => {
    mocks.branchFindFirst.mockResolvedValue({
      id: 'branch-1',
      name: 'Main pharmacy',
      pharmacistCoverageHours: null,
    });
  });

  it('records the hours on the branch at the expected revision and audits before and after', async () => {
    const result = await pharmacyOnboardingRouter
      .createCaller(context())
      .savePharmacistCoverage({ branchId: 'branch-1', revision: 2, windows: [weekdays] });
    const stored = {
      timeZone: 'Asia/Karachi',
      windows: [{ days: [1, 2, 3, 4, 5], start: '09:00', end: '17:00' }],
    };
    expect(result).toEqual({ branchId: 'branch-1', windows: stored.windows, revision: 3 });
    expect(mocks.updateMany).toHaveBeenCalledExactlyOnceWith({
      where: {
        organizationId: 'pharmacy-org',
        id: 'branch-1',
        active: true,
        pharmacistCoverageRevision: 2,
      },
      data: { pharmacistCoverageHours: stored, pharmacistCoverageRevision: { increment: 1 } },
    });
    expect(mocks.recordAudit).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        organizationId: 'pharmacy-org',
        actorId: 'owner',
        action: PHARMACIST_COVERAGE_HOURS_SET_ACTION,
        targetType: 'PharmacyBranch',
        targetId: 'branch-1',
        changes: { pharmacistCoverageHours: { before: null, after: stored } },
      }),
      expect.anything()
    );
  });

  it('keeps the branch’s stored time zone on save instead of the workspace zone', async () => {
    mocks.branchFindFirst.mockResolvedValue({
      id: 'branch-1',
      name: 'Main pharmacy',
      pharmacistCoverageHours: { timeZone: 'Asia/Dubai', windows: [] },
    });
    await pharmacyOnboardingRouter.createCaller(context()).savePharmacistCoverage({
      branchId: 'branch-1',
      revision: 2,
      windows: [weekdays],
      timeZone: 'Asia/Tokyo',
    });
    expect(mocks.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          pharmacistCoverageHours: expect.objectContaining({ timeZone: 'Asia/Dubai' }),
        }),
      })
    );
  });

  it('clears the record when no windows are saved', async () => {
    await pharmacyOnboardingRouter
      .createCaller(context())
      .savePharmacistCoverage({ branchId: 'branch-1', revision: 0, windows: [] });
    expect(mocks.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          pharmacistCoverageHours: Prisma.DbNull,
          pharmacistCoverageRevision: { increment: 1 },
        },
      })
    );
  });

  it('refuses a stale revision without auditing a change', async () => {
    mocks.updateMany.mockResolvedValue({ count: 0 });
    await expect(
      pharmacyOnboardingRouter
        .createCaller(context())
        .savePharmacistCoverage({ branchId: 'branch-1', revision: 0, windows: [weekdays] })
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(mocks.recordAudit).not.toHaveBeenCalled();
  });

  it('refuses an overnight window instead of storing hours the gate could not read', async () => {
    await expect(
      pharmacyOnboardingRouter.createCaller(context()).savePharmacistCoverage({
        branchId: 'branch-1',
        revision: 0,
        windows: [{ days: [1], start: '21:00', end: '03:00' }],
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it('refuses another workspace’s branch', async () => {
    mocks.branchFindFirst.mockResolvedValue(null);
    await expect(
      pharmacyOnboardingRouter
        .createCaller(context())
        .savePharmacistCoverage({ branchId: 'other', revision: 0, windows: [weekdays] })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it('is owner-only: a cashier cannot record hours', async () => {
    mocks.can.mockResolvedValue(false);
    await expect(
      pharmacyOnboardingRouter
        .createCaller(context('MEMBER'))
        .savePharmacistCoverage({ branchId: 'branch-1', revision: 0, windows: [weekdays] })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
});
