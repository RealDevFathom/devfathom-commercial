import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  actor: vi.fn(),
  context: vi.fn(),
  caller: vi.fn(),
  module: vi.fn(),
  canProcure: vi.fn(),
}));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: mocks.actor }));
vi.mock('@/server/trpc', () => ({ createTRPCContext: mocks.context }));
vi.mock('@/lib/entitlements', () => ({ hasModule: mocks.module }));
vi.mock('@/lib/pharmacy/procurement-access', () => ({ actorCanProcure: mocks.canProcure }));
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
  });
  mocks.module.mockReturnValue(true);
  mocks.canProcure.mockResolvedValue(true);
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
  expect(reads.purchaseReturns).not.toHaveBeenCalled();
  expect(screen.queryByRole('heading', { name: 'Supplier-credit follow-up' })).toBeNull();
});
it('shows a member without procurement the closed state, not the returns screen', async () => {
  mocks.canProcure.mockResolvedValue(false);
  render(await ReturnsPage({ searchParams: params() }));
  expect(screen.getByRole('heading', { name: 'You do not have purchasing access' })).toBeVisible();
  expect(mocks.caller).not.toHaveBeenCalled();
  expect(reads.purchaseReturns).not.toHaveBeenCalled();
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
it('loads the queue from the existing authorized branch reads', async () => {
  render(await ReturnsPage({ searchParams: params() }));
  expect(reads.purchaseReturns).toHaveBeenCalledExactlyOnceWith({ branchId: 'branch' });
  expect(reads.supplierCredits).toHaveBeenCalledExactlyOnceWith({ branchId: 'branch' });
  expect(screen.getByRole('heading', { name: 'Supplier-credit follow-up' })).toBeVisible();
  expect(screen.getByText('No open issued debit notes in validated loaded records.')).toBeVisible();
});
it('retains the descriptive route loading state', () => {
  render(<Loading />);
  expect(screen.getByRole('status', { name: 'Loading Returns & claims' })).toBeVisible();
});
