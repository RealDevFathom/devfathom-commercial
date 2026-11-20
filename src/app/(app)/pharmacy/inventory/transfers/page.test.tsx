import { selectFieldControl } from '@/lib/testing/select-field';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  actor: vi.fn(),
  context: vi.fn(),
  board: vi.fn(),
  settings: vi.fn(),
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
  pharmacyInventoryRouter: {
    createCaller: () => ({
      transferBoard: mocks.board,
      branchTransferSettings: mocks.settings,
    }),
  },
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
      // A colleague without a PIN is still assigned, so nobody is solo by default.
      user: { findMany: vi.fn().mockResolvedValue([]), count: vi.fn().mockResolvedValue(1) },
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
  mocks.settings.mockResolvedValue({ enabled: true, canChange: false });
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
  expect(within(selectFieldControl(branchSelect)).queryByRole('option', { hidden: true, name: /Other/ })).toBeNull();
  expect(within(selectFieldControl(branchSelect)).getByRole('option', { hidden: true, name: /Main/ })).toBeInTheDocument();
});

it('DEV-660: reads no stock directly when the gated transfer board refuses', async () => {
  mocks.board.mockRejectedValue(new Error('Branch is outside your scope.'));

  await expect(Page({ searchParams: Promise.resolve({ branch: main.id }) })).rejects.toThrow(
    'Branch is outside your scope.'
  );
  expect(ctx.db.pharmacyStockBalance.findMany).not.toHaveBeenCalled();
});

it('DEV-628: offers as shortfall witness only colleagues assigned to this branch with a PIN', async () => {
  render(await Page({ searchParams: Promise.resolve({ branch: main.id }) }));

  expect(ctx.db.user.findMany).toHaveBeenCalledWith(
    expect.objectContaining({
      where: expect.objectContaining({
        id: { not: 'user_a' },
        status: 'ACTIVE',
        pharmacyBranchAssignments: {
          some: { organizationId: 'org_a', branchId: main.id, active: true },
        },
        restaurantStaffProfiles: {
          some: {
            organizationId: 'org_a',
            status: 'ACTIVE',
            credentials: { some: { type: 'PIN', revokedAt: null, deviceId: null } },
          },
        },
      }),
    })
  );
});

it('DEV-908: offers no send form while branch transfers are switched off, and only the owner may switch', async () => {
  mocks.settings.mockResolvedValue({ enabled: false, canChange: false });
  ctx.db.pharmacyStockBalance.findMany.mockResolvedValue([
    {
      inventoryLotId: 'lot_1',
      stockLocationId: 'location_1',
      onHandUnits: 10,
      location: { name: 'Shelf' },
      lot: {
        id: 'lot_1',
        batch: {
          batchNumber: 'B1',
          expiresAt: new Date('2030-01-01T00:00:00.000Z'),
          medicine: { productName: 'Product', brandName: null },
        },
      },
    },
  ]);
  ctx.db.pharmacyStockLocation.findMany.mockResolvedValue([
    { id: 'location_2', name: 'Store', branchId: other.id },
  ]);

  const { unmount } = render(await Page({ searchParams: Promise.resolve({ branch: main.id }) }));

  expect(screen.getByText(/Branch transfers are switched off/)).toBeVisible();
  expect(screen.getByText('Only the owner can change this setting.')).toBeVisible();
  expect(screen.queryByRole('button', { name: 'Switch on' })).toBeNull();
  unmount();

  mocks.settings.mockResolvedValue({ enabled: false, canChange: true });
  render(await Page({ searchParams: Promise.resolve({ branch: main.id }) }));
  expect(screen.getByRole('button', { name: 'Switch on' })).toBeVisible();
});
