import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  resolveOrganizationEntitlements: vi.fn(),
  platformDb: {
    organization: { findMany: vi.fn() },
    pharmacyBranch: { findMany: vi.fn() },
    pharmacyChurnScoringRun: { findMany: vi.fn() },
  },
  tenantDb: {
    $queryRaw: vi.fn(),
    organization: { findUnique: vi.fn() },
    pharmacyBranch: { findFirst: vi.fn() },
    pharmacyChurnScoringRun: { createMany: vi.fn(), updateMany: vi.fn() },
    pharmacyCustomerChurnScore: { deleteMany: vi.fn(), createMany: vi.fn() },
  },
  withTenantDb: vi.fn(),
}));
vi.mock('@/lib/entitlements', async () => ({
  ...(await vi.importActual<typeof import('@/lib/entitlements')>('@/lib/entitlements')),
  resolveOrganizationEntitlements: mocks.resolveOrganizationEntitlements,
}));
vi.mock('@/lib/tenancy/scoped-db', () => ({
  withPlatformDb: vi.fn(async (callback) => callback(mocks.platformDb)),
  withTenantDb: mocks.withTenantDb,
}));

import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import {
  churnBusinessDate,
  processNightlyChurnScoring,
  readBranchChurnInputs,
  refreshBranchChurnScores,
} from './churn-scoring-job';

const now = new Date('2026-11-01T20:30:00Z'); // 01:30 on 2 Nov in Asia/Karachi
const db = mocks.tenantDb as unknown as ScopedDb;
const scope = { organizationId: 'org-a', branchId: 'branch-a', businessDate: '2026-11-02' };
const aggregates = [
  {
    customerId: 'customer-a',
    lastCompletedAt: new Date('2026-10-30T10:00:00Z'),
    frequency: 6,
    monetary: '12000',
  },
  {
    customerId: 'customer-b',
    lastCompletedAt: new Date('2026-03-01T10:00:00Z'),
    frequency: 1,
    monetary: '800',
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.withTenantDb.mockImplementation(async (_organizationId, callback) =>
    callback(mocks.tenantDb)
  );
  mocks.resolveOrganizationEntitlements.mockResolvedValue({ enabledModules: ['pharmacy-crm'] });
  mocks.platformDb.organization.findMany.mockResolvedValue([
    { id: 'org-a', timezone: 'Asia/Karachi' },
  ]);
  mocks.platformDb.pharmacyBranch.findMany.mockResolvedValue([
    { id: 'branch-a', organizationId: 'org-a' },
  ]);
  mocks.platformDb.pharmacyChurnScoringRun.findMany.mockResolvedValue([]);
  mocks.tenantDb.$queryRaw.mockResolvedValue(aggregates);
  mocks.tenantDb.organization.findUnique.mockResolvedValue({
    vertical: 'PHARMACY',
    status: 'ACTIVE',
  });
  mocks.tenantDb.pharmacyBranch.findFirst.mockResolvedValue({ id: 'branch-a' });
  mocks.tenantDb.pharmacyChurnScoringRun.createMany.mockResolvedValue({ count: 1 });
  mocks.tenantDb.pharmacyChurnScoringRun.updateMany.mockResolvedValue({ count: 1 });
  mocks.tenantDb.pharmacyCustomerChurnScore.deleteMany.mockResolvedValue({ count: 0 });
  mocks.tenantDb.pharmacyCustomerChurnScore.createMany.mockResolvedValue({ count: 2 });
});

describe('churn business date', () => {
  it('uses the workspace local calendar date and falls back to UTC', () => {
    expect(churnBusinessDate(now, 'Asia/Karachi')).toBe('2026-11-02');
    expect(churnBusinessDate(now, 'Not/AZone')).toBe('2026-11-01');
    expect(churnBusinessDate(now, null)).toBe('2026-11-01');
  });
});

describe('branch churn inputs', () => {
  it('reads only tenant/branch-scoped retail aggregates', async () => {
    const rows = await readBranchChurnInputs(db, scope, now);
    expect(rows).toEqual([
      {
        customerId: 'customer-a',
        lastCompletedAt: new Date('2026-10-30T10:00:00Z'),
        frequency: 6,
        monetaryMinor: BigInt(12000),
      },
      {
        customerId: 'customer-b',
        lastCompletedAt: new Date('2026-03-01T10:00:00Z'),
        frequency: 1,
        monetaryMinor: BigInt(800),
      },
    ]);
    const [query] = mocks.tenantDb.$queryRaw.mock.calls[0] as [{ sql: string; values: unknown[] }];
    expect(query.sql).toContain('s."organizationId" = ?');
    expect(query.sql).toContain('s."branchId" = ?');
    expect(query.sql).toContain("s.status = 'COMPLETED'");
    expect(query.sql).toContain('pharmacy_sale_returns');
    // Mixed-lot lines (#636) are valued at what was actually charged.
    expect(query.sql).toContain(
      'COALESCE(l."grossMinor"::bigint, l.quantity::bigint * l."unitPriceMinor")'
    );
    expect(query.values).toEqual(expect.arrayContaining(['org-a', 'branch-a', now]));
    expect(query.sql).not.toMatch(/prescription|patient|medicine|displayName|phone/i);
  });
});

describe('refreshBranchChurnScores', () => {
  it('claims the run, replaces the branch score set and records the count', async () => {
    expect(await refreshBranchChurnScores(db, scope, now)).toEqual({ scored: 2, replay: false });
    expect(mocks.tenantDb.pharmacyChurnScoringRun.createMany).toHaveBeenCalledWith({
      data: expect.objectContaining({
        organizationId: 'org-a',
        branchId: 'branch-a',
        businessDate: '2026-11-02',
        modelVersion: 1,
      }),
      skipDuplicates: true,
    });
    expect(mocks.tenantDb.pharmacyCustomerChurnScore.deleteMany).toHaveBeenCalledWith({
      where: { organizationId: 'org-a', branchId: 'branch-a' },
    });
    const [{ data }] = mocks.tenantDb.pharmacyCustomerChurnScore.createMany.mock.calls[0] as [
      { data: Array<Record<string, unknown>> },
    ];
    expect(data).toHaveLength(2);
    expect(data[0]).toMatchObject({
      organizationId: 'org-a',
      branchId: 'branch-a',
      customerId: 'customer-a',
      businessDate: '2026-11-02',
      recencyScore: 5,
      frequencyScore: 4,
      riskBand: 'LOW',
      scoredAt: now,
    });
    expect(data[1]).toMatchObject({ customerId: 'customer-b', recencyScore: 1, riskBand: 'HIGH' });
    expect(mocks.tenantDb.pharmacyChurnScoringRun.updateMany).toHaveBeenCalledWith({
      where: { organizationId: 'org-a', branchId: 'branch-a', businessDate: '2026-11-02' },
      data: { scoredCustomers: 2 },
    });
  });

  it('is idempotent per branch and business date', async () => {
    mocks.tenantDb.pharmacyChurnScoringRun.createMany.mockResolvedValue({ count: 0 });
    expect(await refreshBranchChurnScores(db, scope, now)).toEqual({ scored: 0, replay: true });
    expect(mocks.tenantDb.$queryRaw).not.toHaveBeenCalled();
    expect(mocks.tenantDb.pharmacyCustomerChurnScore.deleteMany).not.toHaveBeenCalled();
    expect(mocks.tenantDb.pharmacyCustomerChurnScore.createMany).not.toHaveBeenCalled();
  });

  it('clears stale scores when a branch has no scorable customers', async () => {
    mocks.tenantDb.$queryRaw.mockResolvedValue([]);
    expect(await refreshBranchChurnScores(db, scope, now)).toEqual({ scored: 0, replay: false });
    expect(mocks.tenantDb.pharmacyCustomerChurnScore.deleteMany).toHaveBeenCalled();
    expect(mocks.tenantDb.pharmacyCustomerChurnScore.createMany).not.toHaveBeenCalled();
  });
});

describe('processNightlyChurnScoring', () => {
  it('scores each due branch once for its local business date inside its tenant', async () => {
    expect(await processNightlyChurnScoring(now, 25)).toEqual({
      due: 1,
      scoredBranches: 1,
      scoredCustomers: 2,
      failed: 0,
      deferred: 0,
    });
    expect(mocks.withTenantDb).toHaveBeenCalledWith('org-a', expect.any(Function), {
      timeout: 60_000,
    });
    expect(mocks.tenantDb.pharmacyChurnScoringRun.createMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ businessDate: '2026-11-02' }) })
    );
  });

  it('skips branches already scored for the local business date', async () => {
    mocks.platformDb.pharmacyChurnScoringRun.findMany.mockResolvedValue([
      { organizationId: 'org-a', branchId: 'branch-a', businessDate: '2026-11-02' },
    ]);
    expect(await processNightlyChurnScoring(now, 25)).toMatchObject({ due: 0, scoredBranches: 0 });
    expect(mocks.withTenantDb).not.toHaveBeenCalled();
    // Once today's runs are done a tick resolves no entitlements at all.
    expect(mocks.resolveOrganizationEntitlements).not.toHaveBeenCalled();
  });

  it('resolves entitlements once per workspace with due branches', async () => {
    mocks.platformDb.organization.findMany.mockResolvedValue([
      { id: 'org-a', timezone: 'Asia/Karachi' },
      { id: 'org-b', timezone: 'Asia/Karachi' },
    ]);
    mocks.platformDb.pharmacyBranch.findMany.mockResolvedValue([
      { id: 'branch-a', organizationId: 'org-a' },
      { id: 'branch-a2', organizationId: 'org-a' },
      { id: 'branch-b', organizationId: 'org-b' },
    ]);
    mocks.platformDb.pharmacyChurnScoringRun.findMany.mockResolvedValue([
      { organizationId: 'org-b', branchId: 'branch-b', businessDate: '2026-11-02' },
    ]);
    expect(await processNightlyChurnScoring(now, 25)).toMatchObject({ due: 2 });
    // org-a once on the platform side, then once per branch inside its tenant;
    // org-b has nothing due so its entitlements are never resolved.
    const orgs = mocks.resolveOrganizationEntitlements.mock.calls.map(([org]) => org);
    expect(orgs).toEqual(['org-a', 'org-a', 'org-a']);
    expect(mocks.withTenantDb).toHaveBeenCalledTimes(2);
  });

  it('stops starting branches once the tick budget is spent and defers the rest', async () => {
    mocks.platformDb.pharmacyBranch.findMany.mockResolvedValue(
      Array.from({ length: 3 }, (_, index) => ({ id: `branch-${index}`, organizationId: 'org-a' }))
    );
    expect(await processNightlyChurnScoring(now, 25, 0)).toEqual({
      due: 3,
      scoredBranches: 0,
      scoredCustomers: 0,
      failed: 0,
      deferred: 3,
    });
    expect(mocks.withTenantDb).not.toHaveBeenCalled();
    expect(mocks.tenantDb.pharmacyChurnScoringRun.createMany).not.toHaveBeenCalled();
  });

  it('does not schedule workspaces without Pharmacy CRM', async () => {
    mocks.resolveOrganizationEntitlements.mockResolvedValue({ enabledModules: [] });
    expect(await processNightlyChurnScoring(now, 25)).toMatchObject({ due: 0 });
    expect(mocks.resolveOrganizationEntitlements).toHaveBeenCalledTimes(1);
    expect(mocks.withTenantDb).not.toHaveBeenCalled();
  });

  it('re-checks entitlement inside the tenant transaction before writing', async () => {
    mocks.resolveOrganizationEntitlements
      .mockResolvedValueOnce({ enabledModules: ['pharmacy-crm'] })
      .mockResolvedValueOnce({ enabledModules: [] });
    expect(await processNightlyChurnScoring(now, 25)).toMatchObject({
      due: 1,
      scoredBranches: 0,
    });
    expect(mocks.tenantDb.pharmacyChurnScoringRun.createMany).not.toHaveBeenCalled();
  });

  it('does not write for an inaccessible workspace or inactive branch', async () => {
    mocks.tenantDb.organization.findUnique.mockResolvedValueOnce({
      vertical: 'PHARMACY',
      status: 'SUSPENDED',
    });
    expect(await processNightlyChurnScoring(now, 25)).toMatchObject({ scoredBranches: 0 });
    mocks.tenantDb.pharmacyBranch.findFirst.mockResolvedValueOnce(null);
    expect(await processNightlyChurnScoring(now, 25)).toMatchObject({ scoredBranches: 0 });
    expect(mocks.tenantDb.pharmacyChurnScoringRun.createMany).not.toHaveBeenCalled();
  });

  it('isolates a failing branch so other branches still score', async () => {
    mocks.platformDb.pharmacyBranch.findMany.mockResolvedValue([
      { id: 'branch-a', organizationId: 'org-a' },
      { id: 'branch-b', organizationId: 'org-a' },
    ]);
    mocks.withTenantDb
      .mockImplementationOnce(async () => {
        throw new Error('lock timeout');
      })
      .mockImplementation(async (_organizationId, callback) => callback(mocks.tenantDb));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await processNightlyChurnScoring(now, 25)).toEqual({
      due: 2,
      scoredBranches: 1,
      scoredCustomers: 2,
      failed: 1,
      deferred: 0,
    });
    error.mockRestore();
  });

  it('honours the per-tick branch budget', async () => {
    mocks.platformDb.pharmacyBranch.findMany.mockResolvedValue(
      Array.from({ length: 5 }, (_, index) => ({ id: `branch-${index}`, organizationId: 'org-a' }))
    );
    expect(await processNightlyChurnScoring(now, 2)).toMatchObject({ due: 2 });
    expect(mocks.withTenantDb).toHaveBeenCalledTimes(2);
  });
});
