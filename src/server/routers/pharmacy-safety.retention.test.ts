import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ annotateAudit: vi.fn() }));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn() }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/entitlements', () => ({
  hasModule: () => true,
  resolveOrganizationEntitlements: vi.fn(),
}));
vi.mock('@/server/audit', () => ({
  annotateAudit: mocks.annotateAudit,
  ipFromHeaders: () => null,
  isAuditExcludedPath: () => true,
  recordTrpcAudit: vi.fn(),
}));
vi.mock('@/lib/abac', async () => ({
  ...(await vi.importActual<typeof import('@/lib/abac')>('@/lib/abac')),
  can: vi.fn(async (_subject, action: string) => action === 'pharmacy:safety'),
}));

import { router, type TRPCContext } from '../trpc';
import { pharmacySafetyRouter } from './pharmacy-safety';

const app = router({ pharmacySafety: pharmacySafetyRouter });

function fixture(longestDays: number | null) {
  const db = {
    pharmacyRetentionClass: {
      aggregate: vi.fn().mockResolvedValue({ _max: { retentionDays: longestDays } }),
      create: vi.fn(async ({ data }) => ({ ...data })),
    },
  };
  const ctx = {
    db,
    entitlements: { organizationId: 'org_1', modules: [] },
    session: { user: { id: 'user_1', role: 'EMPLOYEE', status: 'ACTIVE' } },
    requestMeta: { ip: null },
    audit: { detail: {} },
  } as unknown as TRPCContext;
  return { db, caller: app.createCaller(ctx).pharmacySafety };
}

const input = (recordClass: 'AUDIT' | 'FISCAL', retentionDays: number) => ({
  id: `rc_${recordClass}_${retentionDays}`,
  recordClass,
  retentionDays,
  effectiveFrom: new Date('2026-11-15T00:00:00.000Z'),
  reason: 'Owner policy',
});

beforeEach(() => vi.clearAllMocks());

describe('DEV-96 setRetentionClass only lengthens a period', () => {
  it('refuses a period shorter than the longest one already set for the class', async () => {
    const f = fixture(3653);
    await expect(f.caller.setRetentionClass(input('AUDIT', 1))).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(f.db.pharmacyRetentionClass.aggregate).toHaveBeenCalledWith({
      where: { organizationId: 'org_1', recordClass: 'AUDIT' },
      _max: { retentionDays: true },
    });
    expect(f.db.pharmacyRetentionClass.create).not.toHaveBeenCalled();
    expect(mocks.annotateAudit).not.toHaveBeenCalled();
  });

  it('records a longer period and audits the change with the previous value', async () => {
    const f = fixture(3653);
    await f.caller.setRetentionClass(input('FISCAL', 4000));
    expect(f.db.pharmacyRetentionClass.create).toHaveBeenCalledWith({
      data: { ...input('FISCAL', 4000), createdByUserId: 'user_1' },
    });
    expect(mocks.annotateAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'pharmacy.retentionClass.set',
        targetType: 'PharmacyRetentionClass',
        targetId: 'rc_FISCAL_4000',
        metadata: expect.objectContaining({
          recordClass: 'FISCAL',
          previousDays: 3653,
          retentionDays: 4000,
        }),
      })
    );
  });

  it('refuses a period longer than 100 years before touching the database', async () => {
    const f = fixture(null);
    await expect(f.caller.setRetentionClass(input('FISCAL', 36_526))).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: expect.stringContaining('A retention period cannot exceed 100 years (36525 days).'),
    });
    expect(f.db.pharmacyRetentionClass.aggregate).not.toHaveBeenCalled();
    expect(f.db.pharmacyRetentionClass.create).not.toHaveBeenCalled();
  });

  it('accepts exactly 100 years', async () => {
    const f = fixture(3653);
    await f.caller.setRetentionClass(input('FISCAL', 36_525));
    expect(f.db.pharmacyRetentionClass.create).toHaveBeenCalledOnce();
  });

  it('accepts the first period of a class and audits it', async () => {
    const f = fixture(null);
    await f.caller.setRetentionClass(input('AUDIT', 30));
    expect(f.db.pharmacyRetentionClass.create).toHaveBeenCalledOnce();
    expect(mocks.annotateAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        metadata: expect.objectContaining({ previousDays: null, retentionDays: 30 }),
      })
    );
  });
});
