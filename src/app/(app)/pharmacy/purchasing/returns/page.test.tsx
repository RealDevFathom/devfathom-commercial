import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  actor: vi.fn(),
  context: vi.fn(),
  caller: vi.fn(),
  module: vi.fn(),
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
const findUser = vi.fn();
const procurementUser = (permissions: { capability: string; effect: 'ALLOW' | 'DENY' }[]) => ({
  role: 'EMPLOYEE',
  organizationRole: { permissions },
  permissionOverrides: [],
});
beforeEach(() => {
  vi.resetAllMocks();
  mocks.actor.mockResolvedValue({ session: { user: { id: 'user' } }, organization: { id: 'org' } });
  mocks.context.mockResolvedValue({
    session: { user: { id: 'user' } },
    entitlements: { organizationId: 'org' },
    db: { user: { findUnique: findUser } },
  });
  findUser.mockResolvedValue(
    procurementUser([
      { capability: 'pharmacy:procurement', effect: 'ALLOW' },
      { capability: 'reports:financial', effect: 'ALLOW' },
    ])
  );
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
  expect(reads.purchaseReturns).not.toHaveBeenCalled();
  expect(screen.queryByRole('heading', { name: 'Supplier-credit follow-up' })).toBeNull();
});
it('closes returns to a counter-only role without procurement (#979)', async () => {
  findUser.mockResolvedValue(
    procurementUser([
      { capability: 'pharmacy:counter', effect: 'ALLOW' },
      { capability: 'pharmacy:orders', effect: 'ALLOW' },
    ])
  );
  render(await ReturnsPage({ searchParams: params() }));
  expect(screen.getByRole('heading', { name: 'You do not have purchasing access' })).toBeVisible();
  expect(mocks.caller).not.toHaveBeenCalled();
  expect(reads.purchaseReturns).not.toHaveBeenCalled();
  expect(screen.queryByRole('heading', { name: 'Supplier-credit follow-up' })).toBeNull();
});
it('closes returns to a procurement role without financial access (PR J)', async () => {
  findUser.mockResolvedValue(
    procurementUser([{ capability: 'pharmacy:procurement', effect: 'ALLOW' }])
  );
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
it('says the operator is not assigned to a branch instead of failing to load (PR J)', async () => {
  reads.workspace.mockResolvedValue({
    branches: [{ id: 'branch', name: 'Branch', city: 'Karachi', code: 'B' }],
    reachableBranchIds: [],
    suppliers: [],
    medicines: [],
    approvers: [],
  });
  render(await ReturnsPage({ searchParams: Promise.resolve({}) }));
  expect(
    screen.getByRole('heading', { name: 'Returns & claims needs a branch assignment' })
  ).toBeVisible();
  expect(screen.queryByText('This surface could not load')).toBeNull();
  expect(reads.purchaseReturns).not.toHaveBeenCalled();
  expect(reads.returnableLots).not.toHaveBeenCalled();
  expect(reads.supplierCredits).not.toHaveBeenCalled();
});
it('opens the only assigned branch and never reads an unassigned one (PR J)', async () => {
  reads.workspace.mockResolvedValue({
    branches: [
      { id: 'branch', name: 'Branch', city: 'Karachi', code: 'B' },
      { id: 'other', name: 'Other', city: 'Lahore', code: 'O' },
    ],
    reachableBranchIds: ['branch'],
    suppliers: [],
    medicines: [],
    approvers: [],
  });
  render(await ReturnsPage({ searchParams: Promise.resolve({ branch: 'other' }) }));
  expect(reads.purchaseReturns).toHaveBeenCalledExactlyOnceWith({ branchId: 'branch' });
  expect(reads.returnableLots).toHaveBeenCalledExactlyOnceWith({ branchId: 'branch' });
  expect(reads.supplierCredits).toHaveBeenCalledExactlyOnceWith({ branchId: 'branch' });
  expect(screen.getByText(/the only branch you are assigned to/)).toBeVisible();
  expect(screen.queryByText('This surface could not load')).toBeNull();
});
it('retains the descriptive route loading state', () => {
  render(<Loading />);
  expect(screen.getByRole('status', { name: 'Loading Returns & claims' })).toBeVisible();
});
it('does not read zero returns as an all-clear return-window board (DEV-522)', async () => {
  render(await ReturnsPage({ searchParams: params() }));
  expect(screen.getByText('No returns or claims to check')).toBeVisible();
  expect(screen.queryByText('No return window is closing')).toBeNull();
  expect(screen.queryByText(/Every open return and claim/)).toBeNull();
});

// QA-3: a non-drug lot stocked without an expiry sits on a 9998-12-31 storage
// marker; the returns screens show "No expiry" instead of that date.
const NO_EXPIRY_MARKER = new Date('9998-12-31T19:00:00.000Z');
it('offers a no-expiry lot for return as "No expiry", never 9998-12-31 (QA-3)', async () => {
  reads.returnableLots.mockResolvedValue([
    {
      lot: {
        id: 'lot-retail',
        batch: {
          batchNumber: 'RETAIL-NOEXP',
          expiresAt: NO_EXPIRY_MARKER,
          medicine: { productName: 'Baby lotion' },
        },
      },
      location: { id: 'loc-1', name: 'Front shelf' },
      onHandUnits: 6,
    },
  ]);
  render(await ReturnsPage({ searchParams: params() }));
  const options = screen.getAllByRole('option', { name: /RETAIL-NOEXP/ });
  expect(options.length).toBeGreaterThan(0);
  for (const option of options) {
    expect(option).toHaveTextContent(
      'Baby lotion · batch RETAIL-NOEXP · No expiry · 6 available in Front shelf'
    );
    expect(option.textContent).not.toContain('9998');
  }
});
it('shows a no-expiry return line as "No expiry", never 9998-12-31 (QA-3)', async () => {
  reads.purchaseReturns.mockResolvedValue([
    {
      id: 'ret-1',
      reference: 'RET-1',
      kind: 'PURCHASE_RETURN',
      status: 'DRAFT',
      createdAt: new Date('2026-11-10T09:00:00.000Z'),
      dispatchedAt: null,
      supplier: { name: 'Karachi Distributors' },
      debitNotes: [],
      lines: [
        {
          id: 'retl-1',
          lot: {
            batch: {
              batchNumber: 'RETAIL-NOEXP',
              expiresAt: NO_EXPIRY_MARKER,
              medicine: { productName: 'Baby lotion' },
            },
          },
          location: { name: 'Front shelf' },
          quantityUnits: 6,
          expectedCreditMinor: 1_200,
          reason: 'Damaged packaging',
          supplierClaimId: null,
          returnWindowEndsAt: new Date('2026-12-31T00:00:00.000Z'),
          windowState: 'OPEN',
          daysToWindowEnd: 46,
        },
      ],
    },
  ]);
  render(
    await ReturnsPage({ searchParams: Promise.resolve({ branch: 'branch', return: 'ret-1' }) })
  );
  const line = screen.getByText(/Batch RETAIL-NOEXP/);
  expect(line).toHaveTextContent('Batch RETAIL-NOEXP · No expiry ·');
  expect(line.textContent).not.toContain('9998');
});
