import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  can: vi.fn(),
  confirm: vi.fn(async () => []),
  list: vi.fn(async () => ({ rows: [] })),
  smartOwner: vi.fn(async () => undefined),
  smartSave: vi.fn(async () => ({})),
  smartRecord: vi.fn(async () => ({})),
  smartSuggest: vi.fn(async () => ({})),
  smartPin: vi.fn(async () => ({ staffProfileId: 'owner-staff' })),
  annotateAudit: vi.fn(),
}));
vi.mock('@/lib/pharmacy/smart-discount-approval', () => ({
  setSmartDiscountOwnerPin: mocks.smartPin,
}));
vi.mock('@/lib/pharmacy/smart-discount-operations', () => ({
  assertSmartDiscountOwner: mocks.smartOwner,
  saveSmartDiscountPolicy: mocks.smartSave,
  recordCompetitorDiscountObservation: mocks.smartRecord,
  readSmartDiscountSuggestion: mocks.smartSuggest,
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
  annotateAudit: mocks.annotateAudit,
}));
vi.mock('@/lib/pharmacy/pricing', () => ({
  confirmPriceChanges: mocks.confirm,
  priceIntelligence: mocks.list,
  priceOverrides: vi.fn(),
  setManualPackPrice: vi.fn(),
}));
import { pharmacyMedicineRouter } from './pharmacy-medicine';
import type { TRPCContext } from '../trpc';
const db = { $transaction: async (work: (tx: unknown) => unknown) => work(db) };
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
  it('exposes policy, evidence and suggestions with server-owned tenant and actor', async () => {
    mocks.can.mockResolvedValue(true);
    const policy = { minimumMarginBps: 2000, minimumObservations: 3, targetDemandLiftBps: 1000 };
    const scope = { organizationId: 'org_owned', actorId: 'actor_owned', branchId: 'branch' };
    await caller().setSmartDiscountPolicy({ branchId: 'branch', policy });
    const evidence = {
      branchId: 'branch',
      medicineId: 'medicine',
      packLevelId: 'pack',
      competitor: 'Nearby',
      competitorPriceMinor: 900,
      observedDemandUnits: 12,
      observedAt: new Date('2026-01-01'),
    };
    await caller().recordCompetitorDiscountObservation(evidence);
    await caller().smartDiscountSuggestion({ branchId: 'branch', inventoryLotId: 'lot' });
    expect(mocks.smartOwner).toHaveBeenCalledTimes(3);
    expect(mocks.smartSave).toHaveBeenCalledWith(db, scope, policy);
    expect(mocks.smartRecord).toHaveBeenCalledWith(db, scope, evidence);
    expect(mocks.smartSuggest).toHaveBeenCalledWith(db, scope, 'lot');
    await expect(
      caller().setSmartDiscountPolicy({
        branchId: 'branch',
        policy,
        organizationId: 'other',
      } as never)
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });
  it('refuses smart discount administration without admin permission', async () => {
    await expect(
      caller().smartDiscountSuggestion({ branchId: 'branch', inventoryLotId: 'lot' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.smartOwner).not.toHaveBeenCalled();
    expect(mocks.smartSuggest).not.toHaveBeenCalled();
  });
  it('enrolls the current pharmacy owner PIN with audit input suppressed', async () => {
    mocks.can.mockResolvedValue(true);
    expect(await caller().setSmartDiscountOwnerPin({ branchId: 'branch', pin: '1234' })).toEqual({
      staffProfileId: 'owner-staff',
    });
    expect(mocks.smartPin).toHaveBeenCalledWith(
      db,
      {
        organizationId: 'org_owned',
        branchId: 'branch',
        actorId: 'actor_owned',
      },
      '1234',
      undefined
    );
    expect(mocks.annotateAudit).toHaveBeenCalledWith(expect.anything(), { skipInput: true });
    await expect(
      caller().setSmartDiscountOwnerPin({
        branchId: 'branch',
        pin: '1234',
        staffProfileId: 'another-owner',
      } as never)
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });
});
