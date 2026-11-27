// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest';
import { GET } from './route';

const m = vi.hoisted(() => ({
  audit: vi.fn(),
  actor: vi.fn(),
  find: vi.fn(),
  scope: vi.fn(),
  can: vi.fn(),
  branches: vi.fn(),
  bytes: vi.fn(),
}));
vi.mock('@/server/audit', () => ({ recordAudit: m.audit }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: m.actor }));
vi.mock('@/lib/tenancy/scoped-db', () => ({ withTenantDb: m.scope }));
vi.mock('@/lib/pharmacy/procurement-access', () => ({
  actorCanProcure: m.can,
  procurementBranchIds: m.branches,
}));
vi.mock('@/lib/storage', async (original) => ({
  ...(await original<typeof import('@/lib/storage')>()),
  getUpload: m.bytes,
}));
const db = { pharmacySupplierDocument: { findFirst: m.find } };
const linkId = '00000000-0000-4000-8000-000000000001';
const sha256 = 'a'.repeat(64);
const read = () =>
  GET(new Request('https://tenant.test/api/pharmacy/supplier-documents/doc'), {
    params: Promise.resolve({ id: 'doc' }),
  });
beforeEach(() => {
  vi.resetAllMocks();
  m.actor.mockResolvedValue({
    session: { user: { id: 'member', organizationId: 'tenant' } },
    organization: { id: 'tenant' },
  });
  m.scope.mockImplementation(async (_org, run) => run(db));
  m.can.mockResolvedValue(true);
  m.branches.mockResolvedValue(['admitted']);
  m.find.mockImplementation(async ({ where }) =>
    where.organizationId === 'tenant' &&
    where.submission.actionLink.purchaseOrder.branchId.in.includes('admitted')
      ? {
          branchId: 'admitted',
          storageUri: `supplier-po-${linkId}-${sha256}`,
          submission: { actionLinkId: linkId },
          sha256,
          mimeType: 'application/pdf',
        }
      : null
  );
  m.bytes.mockResolvedValue(Buffer.from('%PDF-1.7'));
});
it('reads an order-owned document within the procurement branch scope', async () => {
  const res = await read();
  expect(res.status).toBe(200);
  expect(res.headers.get('Cache-Control')).toContain('no-store');
  expect(m.find).toHaveBeenCalledWith(
    expect.objectContaining({
      where: expect.objectContaining({
        id: 'doc',
        ownerType: 'PHARMACY_PURCHASE_ORDER',
        organizationId: 'tenant',
      }),
    })
  );
  expect(await res.text()).toBe('%PDF-1.7');
  expect(m.audit).toHaveBeenCalledWith(
    expect.objectContaining({
      actorId: 'member',
      actorType: 'USER',
      organizationId: 'tenant',
      targetId: 'doc',
      operation: 'READ',
      metadata: { branchId: 'admitted', actionLinkId: linkId },
    }),
    db
  );
});
it.each(['supplier', 'cashier', 'another branch', 'another business'] as const)(
  'refuses a document read for %s without accessing storage',
  async (kind) => {
    if (kind === 'supplier') m.actor.mockResolvedValue(null);
    if (kind === 'cashier') m.can.mockResolvedValue(false);
    if (kind === 'another branch') m.branches.mockResolvedValue(['elsewhere']);
    if (kind === 'another business')
      m.actor.mockResolvedValue({
        session: { user: { id: 'member', organizationId: 'elsewhere' } },
        organization: { id: 'elsewhere' },
      });
    expect((await read()).status).toBe(kind === 'supplier' ? 401 : 404);
    expect(m.bytes).not.toHaveBeenCalled();
    expect(m.audit).not.toHaveBeenCalled();
  }
);
