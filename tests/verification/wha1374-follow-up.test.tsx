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
vi.mock('next/navigation', () => ({ redirect: vi.fn() }));
import ReturnsPage from '@/app/(app)/pharmacy/purchasing/returns/page';
import {
  supplierCreditFollowUp,
  type FollowUpReturn,
} from '@/lib/pharmacy/supplier-credit-follow-up';
import { FollowUpQueue } from '@/app/(app)/pharmacy/purchasing/returns/follow-up-queue';

const reads = {
  workspace: vi.fn(),
  purchaseReturns: vi.fn(),
  supplierCredits: vi.fn(),
  returnableLots: vi.fn(),
};
beforeEach(() => {
  vi.resetAllMocks();
  mocks.actor.mockResolvedValue({ session: { user: { id: 'user' } }, organization: { id: 'org' } });
  mocks.context.mockResolvedValue({
    session: { user: { id: 'user' } },
    entitlements: { organizationId: 'org' },
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

const scope = { organizationId: 'org', branchId: 'branch' };
const at = new Date('2026-09-06T12:00:00Z');
const row = (): FollowUpReturn => ({
  ...scope,
  id: 'return &?#',
  supplierId: 'supplier',
  supplier: { name: 'Supplier' },
  reference: 'Return probe',
  status: 'DISPATCHED',
  dispatchedAt: at,
  lines: [],
  debitNotes: [
    {
      ...scope,
      id: 'note',
      supplierId: 'supplier',
      purchaseReturnId: 'return &?#',
      reference: 'Note probe',
      status: 'OPEN',
      cancelledAt: null,
      issuedAt: at,
      expectedCreditMinor: 10000,
      allocations: [],
    },
  ],
});
const credit = () => ({
  ...scope,
  id: 'credit &?#',
  supplierId: 'supplier',
  supplier: { name: 'Supplier' },
  receivedAt: at,
  reference: 'Credit probe',
  amountMinor: 6000,
  allocations: [] as { organizationId: string; supplierCreditId: string; amountMinor: number }[],
});
it('rejects invalid principal amounts and unsafe aggregate allocations', () => {
  for (const amount of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    const r = row();
    r.debitNotes[0].expectedCreditMinor = amount;
    const c = credit();
    c.amountMinor = amount;
    expect(
      supplierCreditFollowUp({ scope, asOf: at, returns: [r], credits: [c], coverage: 'complete' })
    ).toMatchObject({ claims: [], excluded: 2 });
  }
  const r = row();
  r.debitNotes[0].allocations = [Number.MAX_SAFE_INTEGER, 1].map((amountMinor) => ({
    organizationId: 'org',
    debitNoteId: 'note',
    amountMinor,
  }));
  expect(
    supplierCreditFollowUp({ scope, asOf: at, returns: [r], credits: [], coverage: 'complete' })
  ).toMatchObject({ claims: [], excluded: 1 });
});
it('keeps upcoming work visible above six expired returns and discloses top-five', () => {
  const returns = Array.from({ length: 7 }, (_, i) => ({
    ...row(),
    id: String(i),
    reference: i === 6 ? 'Upcoming probe' : `Expired ${i}`,
    status: 'SUBMITTED' as const,
    dispatchedAt: null,
    lines: [{ returnWindowEndsAt: new Date(at.getTime() + (i === 6 ? 1 : -1)) }],
  }));
  const queue = supplierCreditFollowUp({
    scope,
    asOf: at,
    returns,
    credits: [],
    coverage: 'complete',
  });
  render(<FollowUpQueue queue={queue} branchId="branch" />);
  expect(screen.getByText('Showing 5 of 7 qualifying loaded returns.')).toBeVisible();
  expect(screen.getAllByRole('link')[0]).toHaveTextContent('Upcoming probe');
});
it('discloses matching-credit truncation and non-additive advice', () => {
  const credits = Array.from({ length: 6 }, (_, i) => ({
    ...credit(),
    id: String(i),
    reference: `Credit ${i}`,
  }));
  render(
    <FollowUpQueue
      branchId="branch"
      queue={supplierCreditFollowUp({
        scope,
        asOf: at,
        returns: [row()],
        credits,
        coverage: 'partial',
      })}
    />
  );
  expect(screen.getByText(/Showing 5 of 6 matching loaded credits/)).toBeVisible();
  expect(screen.queryByRole('link', { name: /Credit 5/ })).toBeNull();
  expect(screen.getByText(/not reserved and must not be added/)).toBeVisible();
});
it('connects populated page to selected return and encoded credit target; reload reflects changed independent projection', async () => {
  const r = {
    ...row(),
    createdAt: at,
    kind: 'PURCHASE_RETURN',
    debitNotes: row().debitNotes.map((n) => ({
      ...n,
      position: {
        expectedCreditMinor: 10000,
        receivedCreditMinor: 0,
        outstandingMinor: 10000,
        varianceMinor: 10000,
        status: 'OPEN',
      },
    })),
  };
  reads.purchaseReturns.mockResolvedValue([r]);
  reads.supplierCredits.mockResolvedValue([credit()]);
  render(await ReturnsPage({ searchParams: Promise.resolve({ branch: 'branch', return: r.id }) }));
  expect(screen.getByRole('heading', { name: 'Return probe' })).toBeVisible();
  const link = screen.getByRole('link', { name: /Credit probe · PKR/ });
  const url = new URL(link.getAttribute('href')!, 'http://example.test');
  expect(url.searchParams.get('return')).toBe(r.id);
  expect(document.getElementById(url.hash.slice(1))).not.toBeNull();
  expect(url.searchParams.get('branch')).toBe('branch');
  cleanup();
  const c = credit();
  c.allocations = [{ organizationId: 'org', supplierCreditId: c.id, amountMinor: 6000 }];
  reads.supplierCredits.mockResolvedValue([c]);
  render(await ReturnsPage({ searchParams: Promise.resolve({ branch: 'branch', return: r.id }) }));
  expect(screen.queryByRole('link', { name: /Credit probe · PKR/ })).toBeNull();
  expect(
    screen.getByText(/No matching unallocated credit in validated loaded records/)
  ).toBeVisible();
});
