import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn(() => ({})) }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/entitlements', () => ({
  hasModule: (view: { enabledModules: string[] }, key: string) => view.enabledModules.includes(key),
  resolveOrganizationEntitlements: vi.fn(),
}));
vi.mock('@/server/audit', () => ({
  ipFromHeaders: vi.fn(() => null), isAuditExcludedPath: vi.fn(() => false), recordTrpcAudit: vi.fn(),
  annotateAudit: (ctx: { audit: { detail: object } }, detail: object) => Object.assign(ctx.audit.detail, detail),
}));
vi.mock('@/lib/pharmacy/migration/owner-import', () => ({ previewOwnerImport: vi.fn(), commitOwnerImport: vi.fn() }));
import { previewOwnerImport, commitOwnerImport } from '@/lib/pharmacy/migration/owner-import';
import { recordTrpcAudit } from '../audit';
import { pharmacyOwnerImportRouter } from './pharmacy-owner-import';
import { router, type TRPCContext } from '../trpc';

const root = router({ pharmacyOwnerImport: pharmacyOwnerImportRouter });
const payload = {
  fileName: 'stock.csv', content: Buffer.from('A\n1').toString('base64'),
  branchId: 'branch_a', stockLocationId: 'location_a',
  mapping: { sourceRef: 0 }, previewHash: 'a'.repeat(64), confirmed: true as const,
};
function makeDb() {
  return {
    user: { findUnique: vi.fn().mockResolvedValue({ organizationRole: null, permissionOverrides: [] }) },
    pharmacyBranch: { findMany: vi.fn().mockResolvedValue([{ id: 'branch_a', name: 'A' }]) },
    pharmacyStockLocation: { findMany: vi.fn().mockResolvedValue([{ id: 'location_a', branchId: 'branch_a', name: 'Store' }]) },
  };
}
let db = makeDb();
function caller(options: { role?: string; status?: string; tenant?: string; enabled?: boolean; revoked?: boolean; mustChangePassword?: boolean } = {}) {
  return root.createCaller({
    db, entitlements: { organizationId: 'org_a', enabledModules: options.enabled === false ? [] : ['pharmacy-inventory'], modules: [] },
    session: { expires: 'later', user: { id: 'owner_a', organizationId: options.tenant ?? 'org_a', role: options.role ?? 'ADMIN', status: options.status ?? 'ACTIVE', sessionRevoked: options.revoked, mustChangePassword: options.mustChangePassword } },
    organization: null, support: null, requestMeta: { ip: null, userAgent: null }, audit: { detail: {} },
  } as unknown as TRPCContext).pharmacyOwnerImport;
}
beforeEach(() => { db = makeDb(); vi.clearAllMocks(); });

describe('owner importer authorization and audit', () => {
  it.each([{ role: 'EMPLOYEE' }, { status: 'INACTIVE' }, { revoked: true }, { tenant: 'org_b' }, { enabled: false }, { mustChangePassword: true }])('denies every endpoint for an invalid actor: %j', async (options) => {
    const owner = caller(options);
    await expect(owner.options()).rejects.toBeDefined();
    await expect(owner.upload({ fileName: payload.fileName, content: payload.content })).rejects.toBeDefined();
    await expect(owner.preview({ fileName: payload.fileName, content: payload.content, branchId: payload.branchId, stockLocationId: payload.stockLocationId, mapping: payload.mapping })).rejects.toBeDefined();
    await expect(owner.commit(payload)).rejects.toBeDefined();
    expect(db.pharmacyBranch.findMany).not.toHaveBeenCalled();
    expect(previewOwnerImport).not.toHaveBeenCalled();
    expect(commitOwnerImport).not.toHaveBeenCalled();
  });
  it('loads only the active tenant branches and their stock locations', async () => {
    await caller().options();
    expect(db.pharmacyBranch.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { organizationId: 'org_a', active: true } }));
    expect(db.pharmacyStockLocation.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { organizationId: 'org_a', active: true, branchId: { in: ['branch_a'] } } }));
  });
  it('refuses an unconfirmed commit', async () => {
    await expect(caller().commit({ ...payload, confirmed: false } as never)).rejects.toBeDefined();
    expect(commitOwnerImport).not.toHaveBeenCalled();
  });
  it('pins actor/tenant to the session and audits the receipt without the uploaded bytes', async () => {
    vi.mocked(commitOwnerImport).mockResolvedValueOnce({ sessionId: 'session_a', sourceHash: 'b'.repeat(64), totalUnits: 10, totalValueMinor: '1250', replayed: false });
    await caller().commit(payload);
    expect(commitOwnerImport).toHaveBeenCalledWith(db, { organizationId: 'org_a', actorId: 'owner_a', branchId: 'branch_a' }, payload);
    expect(recordTrpcAudit).toHaveBeenCalledWith(expect.objectContaining({ path: 'pharmacyOwnerImport.commit', outcome: 'SUCCESS', ctx: expect.objectContaining({ audit: { detail: expect.objectContaining({ skipInput: true, targetType: 'PharmacyOpeningSession', targetId: 'session_a', result: expect.objectContaining({ sourceHash: 'b'.repeat(64) }) }) } }) }));
  });
});
