import { beforeEach, expect, it, vi } from 'vitest';
import type { TRPCContext } from './trpc';
const m = vi.hoisted(() => ({
  grants: new Set<string>(),
  catalogue: vi.fn(),
  edits: vi.fn(),
  self: vi.fn(),
  clinical: vi.fn(),
  inventory: vi.fn(),
  procurement: vi.fn(),
  register: vi.fn(),
  solo: vi.fn(),
  orders: vi.fn(),
  orderScope: vi.fn(),
  canOpenOrders: vi.fn(),
  supplierCount: vi.fn(),
  reviewCount: vi.fn(),
  incidentCount: vi.fn(),
  stockCount: vi.fn(),
}));
vi.mock('@/lib/abac', () => ({
  can: async (_: unknown, action: string) => m.grants.has(action),
  subjectFromSession: () => ({}),
}));
vi.mock('@/lib/entitlements', () => ({ hasModule: () => true }));
vi.mock('@/lib/pharmacy/procurement-access', () => ({
  actorIsPharmacyOwner: async () => false,
  actorCanProcure: m.canOpenOrders,
}));
vi.mock('./routers/pharmacy-medicine', async (load) => ({
  ...(await load<typeof import('./routers/pharmacy-medicine')>()),
  catalogueAccess: m.catalogue,
}));
vi.mock('./routers/pharmacy-purchasing', () => ({ purchasingOrderScope: m.orderScope }));
vi.mock('./routers/pharmacy-dispensing', () => ({ clinicalReviewScope: m.clinical }));
vi.mock('./routers/pharmacy-inventory', () => ({ admittedInventoryBranchIds: m.inventory }));
vi.mock('./pharmacy-procurement-scope', () => ({
  reachableProcurementBranchIds: m.procurement,
  isSoloOwner: m.solo,
}));
vi.mock('@/lib/pharmacy/controlled-register', () => ({ assignedRegisterBranchIds: m.register }));
vi.mock('@/lib/pharmacy/purchase-approval', () => ({ soloOwnerApprovalAllowed: m.solo }));
vi.mock('@/lib/pharmacy/catalogue-approvals', async (load) => ({
  ...(await load<typeof import('@/lib/pharmacy/catalogue-approvals')>()),
  isOwnerWithoutOtherReviewer: m.self,
}));
import { readDashboardApprovals } from './pharmacy-dashboard-approvals';
const ctx = {
  session: { user: { id: 'reviewer', organizationId: 'org' } },
  entitlements: { organizationId: 'org' },
  requestMeta: { ip: null },
  db: {
    pharmacyCatalogueEdit: { findMany: m.edits },
    pharmacyPurchaseOrder: { findMany: m.orders },
    pharmacySupplierSubmission: { count: m.supplierCount },
    pharmacyPharmacistReviewItem: { count: m.reviewCount },
    pharmacyRegisterIncident: { count: m.incidentCount },
    pharmacyInventoryCount: { count: m.stockCount },
  },
} as unknown as TRPCContext;
beforeEach(() => {
  vi.clearAllMocks();
  m.grants.clear();
  m.catalogue.mockResolvedValue({ reviewer: false, ownerFallback: false });
  m.self.mockResolvedValue(false);
  m.canOpenOrders.mockResolvedValue(true);
  m.orderScope.mockResolvedValue({ branchIds: ['admitted'], includeUnscoped: false });
  m.solo.mockResolvedValue(false);
  m.procurement.mockResolvedValue(['admitted']);
  m.register.mockResolvedValue(['admitted']);
  m.inventory.mockResolvedValue(new Set(['admitted']));
  m.orders.mockResolvedValue([
    { branchId: 'admitted', createdByUserId: 'other', requisition: null },
    { branchId: 'admitted', createdByUserId: 'reviewer', requisition: null },
  ]);
  m.supplierCount.mockResolvedValue(3);
  m.incidentCount.mockResolvedValue(4);
  m.stockCount.mockResolvedValue(2);
  m.reviewCount.mockResolvedValue(1);
  m.clinical.mockResolvedValue({ organizationId: 'org', id: { in: ['unsigned'] } });
});
it('omits every queue for a financial-only reader and never reads the operational records', async () => {
  m.grants.add('reports:financial');
  expect(await readDashboardApprovals(ctx, ['admitted'])).toEqual([]);
  for (const query of [
    m.edits,
    m.orders,
    m.supplierCount,
    m.reviewCount,
    m.stockCount,
    m.incidentCount,
  ])
    expect(query).not.toHaveBeenCalled();
});
it('shows purchase approvals only for a purchase approver and omits orders requiring a different approver', async () => {
  m.grants.add('pharmacy:procurement');
  const staff = await readDashboardApprovals(ctx, ['admitted', 'elsewhere']);
  expect(staff.map((r) => r.label)).toEqual(['Supplier submission approvals']);
  expect(m.supplierCount).toHaveBeenCalledWith({
    where: expect.objectContaining({
      organizationId: 'org',
      branchId: { in: ['admitted'] },
      approvals: { none: {} },
    }),
  });
  m.grants.add('pharmacy:procurement-approve');
  const reviewer = await readDashboardApprovals(ctx, ['admitted', 'elsewhere']);
  expect(reviewer.map((r) => [r.label, r.value])).toEqual([
    ['Purchase orders', 1],
    ['Supplier submission approvals', 3],
  ]);
  m.procurement.mockResolvedValue([]);
  expect(await readDashboardApprovals(ctx, ['elsewhere'])).toEqual([]);
});
it('separates pack prices from other catalogue edits and excludes own and out-of-branch proposals', async () => {
  m.catalogue.mockResolvedValue({ reviewer: true });
  m.edits.mockResolvedValue([
    { operation: 'UPDATE_MEDICINE', editorId: 'other' },
    { operation: 'UPDATE_MEDICINE', editorId: 'reviewer' },
    { operation: 'setPackPrice', editorId: 'other', changes: { json: { branchId: 'admitted' } } },
    { operation: 'setPackPrice', editorId: 'other', changes: { json: { branchId: 'elsewhere' } } },
  ]);
  const rows = await readDashboardApprovals(ctx, ['admitted'], 'admitted');
  expect(rows.map((r) => [r.label, r.value])).toEqual([
    ['Catalogue edits', 1],
    ['Price-change proposals', 1],
  ]);
  expect(rows.every((r) => r.href.includes('branch=admitted'))).toBe(true);
});
it('counts imported catalogue edits only where their existing inventory review gate admits the reviewer', async () => {
  m.catalogue.mockResolvedValue({ reviewer: true });
  m.edits.mockResolvedValue(
    ['admitted', 'elsewhere', null].map((reorderBranchId) => ({
      operation: 'createStagedMedicines',
      editorId: 'other',
      changes: { json: { reorderBranchId } },
    }))
  );
  const read = async (ids: string[]) =>
    (await readDashboardApprovals(ctx, ids)).find((r) => r.label === 'Catalogue edits')?.value;
  expect(await read(['admitted', 'elsewhere'])).toBe(2);
  expect(await read(['elsewhere'])).toBe(0);
});
it('applies each clinical, inventory and register branch gate independently', async () => {
  for (const action of ['pharmacy:safety', 'pharmacy:dispense', 'pharmacy:inventory'])
    m.grants.add(action);
  const queues = await readDashboardApprovals(ctx, ['admitted', 'elsewhere']);
  expect(queues.map((r) => [r.label, r.value])).toEqual([
    ['Register incident approvals', 4],
    ['Pharmacist review items', 1],
    ['Stock counts', 2],
  ]);
  expect(m.incidentCount).toHaveBeenCalledWith({
    where: { organizationId: 'org', branchId: { in: ['admitted'] }, status: 'OPEN' },
  });
  expect(m.reviewCount).toHaveBeenCalledWith({
    where: { organizationId: 'org', id: { in: ['unsigned'] } },
  });
  expect(m.stockCount).toHaveBeenCalledWith({
    where: expect.objectContaining({ branchId: 'admitted' }),
  });
});

it('uses the purchase order console’s access gate for its dashboard link', async () => {
  m.grants.add('pharmacy:procurement-approve');
  m.canOpenOrders.mockResolvedValue(false);
  expect(await readDashboardApprovals(ctx, ['admitted'])).toEqual([]);
  expect(m.orders).not.toHaveBeenCalled();
});
