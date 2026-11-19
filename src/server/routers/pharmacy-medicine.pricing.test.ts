import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  can: vi.fn(),
  confirm: vi.fn(async () => []),
  list: vi.fn(async () => ({ rows: [] })),
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
  setManualPackPrice: vi.fn(),
}));
import { pharmacyMedicineRouter } from './pharmacy-medicine';
import type { TRPCContext } from '../trpc';
const db = {};
const caller = (organization?: { id: string; timezone?: string }) =>
  pharmacyMedicineRouter.createCaller({
    ...(organization ? { organization } : {}),
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
  it.each([
    ['Asia/Karachi', 'Asia/Karachi'],
    ['UTC', 'UTC'],
    [undefined, 'UTC'],
  ])(
    'DEV-943: price notices carry the session organisation zone %s as %s',
    async (stored, zone) => {
      mocks.can.mockResolvedValue(true);
      await expect(
        caller({ id: 'org_owned', ...(stored ? { timezone: stored } : {}) }).priceNotices()
      ).resolves.toEqual({ rows: [], timezone: zone });
    }
  );
  it('branch override reads require admin capability, not safety alone', async () => {
    mocks.can.mockImplementation(async (_subject, action) => action === 'pharmacy:safety');
    await expect(caller().priceOverrides({ branchId: 'sibling' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });
});
