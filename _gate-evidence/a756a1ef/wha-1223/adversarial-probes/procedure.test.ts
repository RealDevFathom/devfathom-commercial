import { beforeEach, describe, expect, it, vi } from 'vitest';

const guards = vi.hoisted(() => ({ hasModule: vi.fn(() => true) }));
vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn() }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/entitlements', () => ({
  hasModule: guards.hasModule,
  resolveOrganizationEntitlements: vi.fn(),
}));
vi.mock('@/server/audit', () => ({
  ipFromHeaders: vi.fn(),
  isAuditExcludedPath: vi.fn(() => true),
  recordTrpcAudit: vi.fn(),
}));

import { pharmacyMedicineRouter } from '@/server/routers/pharmacy-medicine';
import { router, type TRPCContext } from '@/server/trpc';
import { purchasingWorkspace } from '@/lib/pharmacy/purchasing-console';

function caller(db: object) {
  return router({ pharmacyMedicine: pharmacyMedicineRouter }).createCaller({
    db,
    entitlements: { organizationId: 'org-a', enabledModules: ['pharmacy-core'], modules: [] },
    session: { expires: 'later', user: { id: 'admin-a', role: 'ADMIN', status: 'ACTIVE' } },
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext).pharmacyMedicine;
}
const input = {
  presentationId: 'published-presentation',
  versionGroupId: 'new-pack-group',
  level: 'STRIP' as const,
  unitsPerParent: 10,
  effectiveFrom: new Date('2026-09-01'),
};
beforeEach(() => {
  guards.hasModule.mockReturnValue(true);
});

describe('WHA1223 independent procedure adversarial probes', () => {
  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER+1])('rejects nonrepresentable unit count %s', async (unitsPerParent) => {
    const create=vi.fn();
    await expect(caller({packLevel:{create}}).createPackLevel({...input,unitsPerParent})).rejects.toMatchObject({code:'BAD_REQUEST'});
    expect(create).not.toHaveBeenCalled();
  });
  it('rejects invalid date before persistence', async () => {
    const create=vi.fn();
    await expect(caller({packLevel:{create}}).createPackLevel({...input,effectiveFrom:new Date('invalid')})).rejects.toMatchObject({code:'BAD_REQUEST'});
    expect(create).not.toHaveBeenCalled();
  });
  it('rejects parent pack belonging to another presentation', async () => {
    const create=vi.fn(), findFirst=vi.fn(async()=>null);
    await expect(caller({presentation:{findFirst:vi.fn(async()=>({id:input.presentationId}))},packLevel:{create,findFirst}}).createPackLevel({...input,parentPackLevelId:'foreign-pack'})).rejects.toMatchObject({code:'FORBIDDEN',message:'Parent pack is outside this presentation.'});
    expect(findFirst).toHaveBeenCalledWith({where:{id:'foreign-pack',presentationId:input.presentationId}});
    expect(create).not.toHaveBeenCalled();
  });
  it('rejects unauthenticated caller before any persistence', async () => {
    const create=vi.fn();
    const api=router({pharmacyMedicine:pharmacyMedicineRouter}).createCaller({db:{packLevel:{create}},session:null,requestMeta:{ip:null,userAgent:null},audit:{detail:{}}} as unknown as TRPCContext);
    await expect(api.pharmacyMedicine.createPackLevel(input)).rejects.toMatchObject({code:'UNAUTHORIZED'});
    expect(create).not.toHaveBeenCalled();
  });
});
