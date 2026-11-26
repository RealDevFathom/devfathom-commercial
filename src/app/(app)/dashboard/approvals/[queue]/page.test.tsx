import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import ApprovalQueue from './page';

const f = vi.hoisted(() => ({
  suppliers: vi.fn(), incidents: vi.fn(), branches: vi.fn(), allowed: new Set<string>(),
}));
vi.mock('../../../pharmacy/purchasing/_lib/console', () => ({ tenantContext: async () => ({
  session: { user: { organizationId: 'demo', id: 'viewer' } },
  requestMeta: { ip: null }, entitlements: { organizationId: 'demo' },
  db: { pharmacySupplierSubmission: { findMany: f.suppliers }, pharmacyRegisterIncident: { findMany: f.incidents } },
}) }));
vi.mock('@/lib/entitlements', () => ({ hasModule: () => true }));
vi.mock('@/lib/abac', () => ({ subjectFromSession: () => ({}), can: (_: unknown, action: string) => f.allowed.has(action) }));
vi.mock('@/server/routers/pharmacy-reports', () => ({
  pharmacyReportAccess: async () => 'ALL', pharmacyReportsRouter: { createCaller: () => ({ branches: f.branches }) },
}));
vi.mock('@/server/routers/pharmacy-safety', () => ({ pharmacySafetyRouter: {} }));
vi.mock('@/server/routers/pharmacy-supplier-links', () => ({ pharmacySupplierLinksRouter: {} }));
vi.mock('@/lib/pharmacy/controlled-register', () => ({ assignedRegisterBranchIds: async () => ['local'] }));
vi.mock('@/server/pharmacy-procurement-scope', () => ({ reachableProcurementBranchIds: async () => ['local'] }));
vi.mock('@/server/pharmacy-dashboard-approvals', async (load) => {
  const { pendingSupplierSubmissions, pendingRegisterIncidents } = await load<typeof import('@/server/pharmacy-dashboard-approvals')>();
  return { pendingSupplierSubmissions, pendingRegisterIncidents };
});
const page = (queue: string) => ApprovalQueue({ params: Promise.resolve({ queue }), searchParams: Promise.resolve({ branch: 'local' }) });
beforeEach(() => {
  vi.clearAllMocks(); f.allowed.clear();
  f.branches.mockResolvedValue({ branches: [{ id: 'local' }, { id: 'remote' }] });
});
afterEach(cleanup);
it('shows the supplier decision with the proposed product and human-readable order lines', async () => {
  f.allowed.add('pharmacy:procurement');
  const order = { reference: 'PO-7', supplier: { name: 'Fixture supplier' }, lines: [{ id: 'line-7', lineNumber: 2 }] };
  f.suppliers.mockResolvedValue([
    { id: 'sub', kind: 'SUBSTITUTION_PROPOSAL', payload: { description: 'Proposed pack of 12', internalField: 'unused fixture metadata' }, actionLink: { purchaseOrder: order } },
    { id: 'part', kind: 'PARTIAL_ACCEPTANCE', payload: { quantities: { 'line-7': 4 } }, actionLink: { purchaseOrder: order } },
  ]);
  render(await page('suppliers'));
  expect(screen.getByText('Proposed pack of 12')).toBeVisible();
  expect(screen.getByText('Line 2: 4 packs')).toBeVisible();
  expect(screen.queryByText(/unused fixture metadata/)).toBeNull();
  expect(screen.getAllByRole('button', {name: 'Approve'})).toHaveLength(2);
  expect(f.suppliers).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ organizationId: 'demo', branchId: { in: ['local'] } }) }));
});
it('shows the selected register discrepancy and its decision form', async () => {
  f.allowed.add('pharmacy:safety');
  f.incidents.mockResolvedValue([{id:'i', registerEntryId:'entry-1', expectedBalance:10, actualBalance:9}]);
  render(await page('register'));
  expect(screen.getByText('Expected 10 units · Recorded 9 units')).toBeVisible();
  expect(screen.getByRole('textbox', {name:'Decision reason'})).toBeRequired();
  expect(f.incidents).toHaveBeenCalledWith(expect.objectContaining({ where: { organizationId: 'demo', branchId: {in:['local']}, status:'OPEN' } }));
});
