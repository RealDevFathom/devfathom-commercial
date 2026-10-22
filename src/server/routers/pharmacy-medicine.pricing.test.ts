import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  can: vi.fn(),
  confirm: vi.fn(async () => []),
  list: vi.fn(async () => ({ rows: [] })),
  setPrice: vi.fn(async () => ({ id: 'price-1' })),
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
vi.mock('@/lib/pharmacy/pricing', () => ({
  confirmPriceChanges: mocks.confirm,
  priceIntelligence: mocks.list,
  priceOverrides: vi.fn(),
  setManualPackPrice: mocks.setPrice,
}));
import { pharmacyMedicineRouter } from './pharmacy-medicine';
import type { TRPCContext } from '../trpc';
const db = {};
const caller = () =>
  pharmacyMedicineRouter.createCaller({
    db,
    entitlements: { organizationId: 'org_owned', enabledModules: ['pharmacy-core'] },
    session: { expires: 'later', user: { id: 'actor_owned', role: 'ADMIN', status: 'ACTIVE' } },
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext);
describe('price router authorization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.can.mockResolvedValue(false);
  });
  it('denies reads and confirmation without safety permission', async () => {
    await expect(caller().priceNotices()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(caller().confirmPrices({ proposalIds: ['p'] })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(mocks.confirm).not.toHaveBeenCalled();
    expect(mocks.list).not.toHaveBeenCalled();
  });
  it('uses session actor and tenant, rejects injected organization', async () => {
    mocks.can.mockResolvedValue(true);
    await caller().confirmPrices({ proposalIds: ['p'] });
    expect(mocks.confirm).toHaveBeenCalledWith(
      db,
      { organizationId: 'org_owned', actorId: 'actor_owned' },
      ['p']
    );
    await expect(
      caller().confirmPrices({ proposalIds: ['p'], organizationId: 'other' } as never)
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });
  it('branch override reads require admin capability, not safety alone', async () => {
    mocks.can.mockImplementation(async (_subject, action) => action === 'pharmacy:safety');
    await expect(caller().priceOverrides({ branchId: 'sibling' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('denies a manual price write without the exact safety grant', async () => {
    await expect(
      caller().setPackPrice({
        packLevelId: 'pack-1',
        mrpMinor: 100,
        sellingPriceMinor: 90,
        effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.setPrice).not.toHaveBeenCalled();
  });

  it('allows a manual price write only when the safety decision allows it', async () => {
    mocks.can.mockImplementation(async (_subject, action) => action === 'pharmacy:safety');
    await caller().setPackPrice({
      packLevelId: 'pack-1',
      mrpMinor: 100,
      sellingPriceMinor: 90,
      effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
    });
    expect(mocks.setPrice).toHaveBeenCalledOnce();
  });

  it('fails closed when central ABAC resolves an exact allow plus wildcard deny to deny', async () => {
    mocks.can.mockResolvedValue(false);
    await expect(
      caller().setPackPrice({
        packLevelId: 'pack-1',
        mrpMinor: 100,
        sellingPriceMinor: null,
        effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.setPrice).not.toHaveBeenCalled();
  });
});
