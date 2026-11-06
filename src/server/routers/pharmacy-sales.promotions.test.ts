import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn() }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/entitlements', () => ({
  hasModule: vi.fn(() => true),
  resolveOrganizationEntitlements: vi.fn(),
}));
vi.mock('@/server/audit', async (original) => ({
  ...(await original<typeof import('@/server/audit')>()),
  recordTrpcAudit: vi.fn(),
}));
import { hasModule } from '@/lib/entitlements';
import { recordTrpcAudit } from '@/server/audit';
import { router, type TRPCContext } from '../trpc';
import { pharmacySalesRouter } from './pharmacy-sales';

const app = router({ pharmacySales: pharmacySalesRouter });
const input = {
  branchId: 'branch-727',
  name: 'November offer',
  effectiveFrom: new Date('2026-11-01T00:00:00Z'),
  effectiveTo: new Date('2026-11-02T00:00:00Z'),
  benefitBasisPoints: 1000,
};
function fixture(
  options: { role?: string; actor?: boolean; branch?: boolean; vertical?: string } = {}
) {
  const db = {
    user: {
      findFirst: vi.fn().mockResolvedValue(options.actor === false ? null : { id: 'owner' }),
      findUnique: vi.fn().mockResolvedValue({ organizationRole: null, permissionOverrides: [] }),
    },
    pharmacyBranch: {
      findMany: vi.fn().mockResolvedValue(options.branch === false ? [] : [{ id: input.branchId }]),
    },
    medicine: {
      findFirst: vi.fn().mockResolvedValue({ rx: false, restricted: false, controlled: false }),
    },
    pharmacyPromotion: {
      create: vi.fn().mockResolvedValue({ id: 'offer', ...input }),
      findMany: vi.fn().mockResolvedValue([]),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
  };
  const context = {
    db,
    entitlements: { organizationId: 'org-727', enabledModules: ['pharmacy-counter'], modules: [] },
    session: {
      expires: 'later',
      user: {
        id: 'owner',
        role: options.role ?? 'ADMIN',
        status: 'ACTIVE',
        organizationId: 'org-727',
      },
    },
    organization: { id: 'org-727', vertical: options.vertical ?? 'PHARMACY' },
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext;
  return { db, context, caller: app.createCaller(context).pharmacySales };
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(hasModule).mockReturnValue(true);
});
describe('#727 promotion administration', () => {
  it('uses the current administrator as author and audits creation', async () => {
    const f = fixture();
    await f.caller.createPromotion(input);
    expect(f.db.pharmacyPromotion.create).toHaveBeenCalledWith({
      data: {
        ...input,
        priority: 0,
        organizationId: 'org-727',
        createdByUserId: 'owner',
      },
    });
    expect(f.context.audit.detail).toMatchObject({ action: 'pharmacy_promotion_created' });
    expect(recordTrpcAudit).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'SUCCESS' }));
  });
  it.each([{ role: 'EMPLOYEE' }, { actor: false }, { branch: false }, { vertical: 'RESTAURANT' }])(
    'refuses unauthorized administration: %j',
    async (options) => {
      const f = fixture(options);
      await expect(f.caller.createPromotion(input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(f.db.pharmacyPromotion.create).not.toHaveBeenCalled();
    }
  );
  it('honors an explicit admin capability denial', async () => {
    const f = fixture();
    f.db.user.findUnique.mockResolvedValue({
      organizationRole: null,
      permissionOverrides: [{ capability: 'admin:access', effect: 'DENY' }],
    } as never);
    await expect(f.caller.createPromotion(input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(f.db.pharmacyPromotion.create).not.toHaveBeenCalled();
  });
  it('refuses an unlicensed counter', async () => {
    const f = fixture();
    vi.mocked(hasModule).mockReturnValue(false);
    await expect(f.caller.createPromotion(input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(f.db.pharmacyPromotion.create).not.toHaveBeenCalled();
  });
  it.each(['rx', 'restricted', 'controlled'])('refuses a targeted %s medicine', async (field) => {
    const f = fixture();
    f.db.medicine.findFirst.mockResolvedValue({
      rx: false,
      restricted: false,
      controlled: false,
      [field]: true,
    });
    await expect(
      f.caller.createPromotion({ ...input, medicineId: 'medicine' })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(f.db.pharmacyPromotion.create).not.toHaveBeenCalled();
  });
  it('refuses a foreign or missing medicine', async () => {
    const f = fixture();
    f.db.medicine.findFirst.mockResolvedValue(null as never);
    await expect(
      f.caller.createPromotion({ ...input, medicineId: 'foreign' })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(f.db.medicine.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: 'foreign',
          organizationId: 'org-727',
          saleable: true,
        },
      })
    );
  });
  it('lists and disables only offers in the authorized tenant branch', async () => {
    const f = fixture();
    await f.caller.promotions({ branchId: input.branchId });
    expect(f.db.pharmacyPromotion.findMany).toHaveBeenCalledWith({
      where: { organizationId: 'org-727', branchId: input.branchId },
      orderBy: [{ priority: 'desc' }, { id: 'asc' }],
    });
    await f.caller.disablePromotion({ branchId: input.branchId, promotionId: 'offer' });
    expect(f.db.pharmacyPromotion.updateMany).toHaveBeenCalledWith({
      where: { id: 'offer', organizationId: 'org-727', branchId: input.branchId },
      data: { active: false },
    });
    f.db.pharmacyPromotion.updateMany.mockResolvedValue({ count: 0 });
    await expect(
      f.caller.disablePromotion({ branchId: input.branchId, promotionId: 'foreign' })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
