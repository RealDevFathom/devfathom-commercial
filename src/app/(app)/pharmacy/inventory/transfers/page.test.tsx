import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  actor: vi.fn(),
  context: vi.fn(),
  board: vi.fn(),
  assigned: vi.fn(),
}));
vi.mock('next/navigation', () => ({ redirect: vi.fn() }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: mocks.actor }));
vi.mock('@/server/trpc', () => ({ createTRPCContext: mocks.context }));
vi.mock('@/lib/entitlements', () => ({ hasModule: () => true }));
// The capability gate is not under test here; keep it open so the branch rule is.
vi.mock('@/lib/abac', () => ({
  can: async () => true,
  subjectFromSession: (user: unknown) => user,
}));
vi.mock('@/server/routers/pharmacy-inventory', () => ({
  admittedInventoryBranchIds: mocks.assigned,
  pharmacyInventoryRouter: { createCaller: () => ({ transferBoard: mocks.board }) },
}));

import Page from './page';

const main = { id: 'branch_main', name: 'Main', city: 'Karachi' };
const other = { id: 'branch_other', name: 'Other', city: 'Lahore' };
let ctx: ReturnType<typeof makeContext>;

function makeContext() {
  return {
    session: { user: { id: 'user_a', status: 'ACTIVE' } },
    organization: { id: 'org_a' },
    entitlements: {},
    requestMeta: { ip: null, userAgent: null },
    db: {
      pharmacyBranch: { findMany: vi.fn().mockResolvedValue([main, other]) },
      pharmacyStockBalance: { findMany: vi.fn().mockResolvedValue([]) },
      pharmacyStockLocation: { findMany: vi.fn().mockResolvedValue([]) },
      user: { findMany: vi.fn().mockResolvedValue([]) },
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  ctx = makeContext();
  mocks.actor.mockResolvedValue(ctx);
  mocks.context.mockResolvedValue(ctx);
  mocks.assigned.mockResolvedValue(new Set([main.id]));
  mocks.board.mockResolvedValue([]);
});

afterEach(cleanup);

it('DEV-660: explains a missing branch assignment and reads no transfer or stock', async () => {
  mocks.assigned.mockResolvedValue(new Set());

  render(await Page({ searchParams: Promise.resolve({ branch: main.id }) }));

  expect(screen.getByText('Branch assignment required')).toBeVisible();
  expect(mocks.board).not.toHaveBeenCalled();
  expect(ctx.db.pharmacyStockBalance.findMany).not.toHaveBeenCalled();
});

it('DEV-660: opens an assigned branch instead of an unassigned one named in the URL', async () => {
  render(await Page({ searchParams: Promise.resolve({ branch: other.id }) }));

  expect(mocks.board).toHaveBeenCalledExactlyOnceWith({ branchId: main.id });
  expect(ctx.db.pharmacyStockBalance.findMany).toHaveBeenCalledWith(
    expect.objectContaining({ where: expect.objectContaining({ branchId: main.id }) })
  );
  const branchSelect = screen.getByRole('combobox', { name: 'Branch' });
  expect(within(branchSelect).queryByRole('option', { name: /Other/ })).toBeNull();
  expect(within(branchSelect).getByRole('option', { name: /Main/ })).toBeInTheDocument();
});

it('DEV-660: reads no stock directly when the gated transfer board refuses', async () => {
  mocks.board.mockRejectedValue(new Error('Branch is outside your scope.'));

  await expect(Page({ searchParams: Promise.resolve({ branch: main.id }) })).rejects.toThrow(
    'Branch is outside your scope.'
  );
  expect(ctx.db.pharmacyStockBalance.findMany).not.toHaveBeenCalled();
});
