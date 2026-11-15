import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  can: vi.fn(),
  list: vi.fn(async () => []),
  dismiss: vi.fn(async () => ({ id: 'alert-1' })),
  ingest: vi.fn(async () => []),
}));
vi.mock('@/lib/abac', () => ({ can: mocks.can, subjectFromSession: (user: unknown) => user }));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn() }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/entitlements', () => ({
  hasModule: () => true,
  resolveOrganizationEntitlements: vi.fn(),
}));
vi.mock('@/server/audit', () => ({
  ipFromHeaders: () => null,
  isAuditExcludedPath: () => true,
  recordTrpcAudit: vi.fn(),
}));
vi.mock('@/lib/pharmacy/drap-monitoring', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/pharmacy/drap-monitoring')>()),
  listDrapPriceAlerts: mocks.list,
  dismissDrapPriceAlert: mocks.dismiss,
  ingestDrapSource: mocks.ingest,
}));
import { pharmacyMedicineRouter } from './pharmacy-medicine';
import type { TRPCContext } from '../trpc';

const db = { $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(db)) };
const caller = () =>
  pharmacyMedicineRouter.createCaller({
    db,
    entitlements: { organizationId: 'org_owned', enabledModules: ['pharmacy-core'] },
    session: { expires: 'later', user: { id: 'actor_owned', role: 'MEMBER', status: 'ACTIVE' } },
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext);

describe('DEV-693 official price alerts router', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.can.mockResolvedValue(false);
  });

  it('hides alerts from roles that cannot see prices', async () => {
    mocks.can.mockImplementation(async (_subject, action) => action === 'pharmacy:inventory');
    await expect(caller().drapPriceAlerts()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(caller().dismissDrapPriceAlert({ alertId: 'alert-1' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(mocks.list).not.toHaveBeenCalled();
    expect(mocks.dismiss).not.toHaveBeenCalled();
  });

  it('scopes reads and dismissals to the session tenant and actor', async () => {
    mocks.can.mockImplementation(async (_subject, action) => action === 'pharmacy:safety');
    await caller().drapPriceAlerts({ medicineIds: ['med-a'] });
    expect(mocks.list).toHaveBeenCalledWith(
      db,
      { organizationId: 'org_owned', actorId: 'actor_owned' },
      ['med-a']
    );
    await caller().dismissDrapPriceAlert({ alertId: 'alert-1' });
    expect(mocks.dismiss).toHaveBeenCalledWith(
      db,
      { organizationId: 'org_owned', actorId: 'actor_owned' },
      'alert-1'
    );
    await expect(
      caller().drapPriceAlerts({ organizationId: 'org_other' } as never)
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('ingests an uploaded SRO CSV schedule and reports a bad row plainly', async () => {
    mocks.can.mockImplementation(async (_subject, action) => action === 'pharmacy:safety');
    await caller().ingestPriceNotices({
      format: 'csv',
      contents:
        'SRO,Registration No,MRP,Effective Date\nSRO 1092(I)/2023,012345,315.00,22/08/2023\n',
    });
    expect(mocks.ingest).toHaveBeenCalledOnce();
    await expect(
      caller().ingestPriceNotices({
        format: 'csv',
        contents: 'SRO,Registration No,MRP,Effective Date\nSRO 1,012345,about 300,2023-08-22\n',
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: expect.stringContaining('Row 2') });
  });
});
