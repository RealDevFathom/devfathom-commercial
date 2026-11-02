import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  actor: vi.fn(),
  context: vi.fn(),
  caller: vi.fn(),
  module: vi.fn(),
  user: vi.fn(),
}));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: mocks.actor }));
vi.mock('@/server/trpc', () => ({ createTRPCContext: mocks.context }));
vi.mock('@/lib/entitlements', () => ({ hasModule: mocks.module }));
vi.mock('@/server/routers/pharmacy-purchasing', () => ({
  pharmacyPurchasingRouter: { createCaller: mocks.caller },
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('next/navigation', () => ({ redirect: vi.fn(), useRouter: () => ({ refresh: vi.fn() }) }));
import ReturnsPage from './page';
import Loading from './loading';

const reads = {
  workspace: vi.fn(),
  purchaseReturns: vi.fn(),
  supplierCredits: vi.fn(),
  returnableLots: vi.fn(),
};
const params = () => Promise.resolve({ branch: 'branch' });
beforeEach(() => {
  vi.resetAllMocks();
  mocks.actor.mockResolvedValue({ session: { user: { id: 'user' } }, organization: { id: 'org' } });
  mocks.context.mockResolvedValue({
    session: { user: { id: 'user' } },
    entitlements: { organizationId: 'org' },
    db: { user: { findUnique: mocks.user } },
  });
  mocks.user.mockResolvedValue({
    organizationRole: {
      permissions: [{ capability: 'pharmacy:procurement', effect: 'ALLOW' }],
    },
    permissionOverrides: [],
  });
  mocks.module.mockReturnValue(true);
  mocks.caller.mockReturnValue(reads);
  reads.workspace.mockResolvedValue({
    branches: [{ id: 'branch', name: 'Branch', stockLocations: [] }],
    suppliers: [],
    medicines: [],
    approvers: [],
  });
  reads.purchaseReturns.mockResolvedValue([]);
  reads.supplierCredits.mockResolvedValue([]);
  reads.returnableLots.mockResolvedValue([]);
});
afterEach(cleanup);
it('does not read or render priorities without module access', async () => {
  mocks.module.mockReturnValue(false);
  render(await ReturnsPage({ searchParams: params() }));
  expect(
    screen.getByRole('heading', { name: 'Pharmacy Procurement is not licensed' })
  ).toBeVisible();
  expect(mocks.user).not.toHaveBeenCalled();
  expect(mocks.caller).not.toHaveBeenCalled();
  expect(reads.purchaseReturns).not.toHaveBeenCalled();
  expect(screen.queryByRole('heading', { name: 'Supplier-credit follow-up' })).toBeNull();
});
it('denies cashiers before creating a caller or reading any purchasing records', async () => {
  mocks.user.mockResolvedValue({
    organizationRole: {
      permissions: [{ capability: 'pharmacy.counter', effect: 'ALLOW' }],
    },
    permissionOverrides: [],
  });
  render(await ReturnsPage({ searchParams: params() }));
  expect(screen.getByRole('heading', { name: 'You do not have purchasing access' })).toBeVisible();
  expect(mocks.caller).not.toHaveBeenCalled();
  for (const read of Object.values(reads)) expect(read).not.toHaveBeenCalled();
  expect(screen.queryByRole('heading', { name: 'Supplier-credit follow-up' })).toBeNull();
});
it('does not render priorities after branch read denial', async () => {
  reads.purchaseReturns.mockRejectedValue(new Error('FORBIDDEN'));
  render(await ReturnsPage({ searchParams: params() }));
  expect(
    screen.getByText(
      'Returns for this branch could not be read. This read failure does not confirm or undo earlier changes. Check their outcomes before retrying.'
    )
  ).toBeVisible();
  expect(screen.queryByRole('heading', { name: 'Supplier-credit follow-up' })).toBeNull();
});
it('loads the queue for a procurement manager after checking capability', async () => {
  render(await ReturnsPage({ searchParams: params() }));
  expect(mocks.user).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'user' } }));
  expect(mocks.user.mock.invocationCallOrder[0]).toBeLessThan(
    reads.workspace.mock.invocationCallOrder[0]!
  );
  expect(reads.purchaseReturns).toHaveBeenCalledExactlyOnceWith({ branchId: 'branch' });
  expect(reads.supplierCredits).toHaveBeenCalledExactlyOnceWith({ branchId: 'branch' });
  expect(screen.getByRole('heading', { name: 'Supplier-credit follow-up' })).toBeVisible();
  expect(screen.getByText('No open issued debit notes in validated loaded records.')).toBeVisible();
});
it('retains the descriptive route loading state', () => {
  render(<Loading />);
  expect(screen.getByRole('status', { name: 'Loading Returns & claims' })).toBeVisible();
});
