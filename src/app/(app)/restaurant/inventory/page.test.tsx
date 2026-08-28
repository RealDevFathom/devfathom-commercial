import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  resolveTenantActor: vi.fn(),
  createTRPCContext: vi.fn(),
  can: vi.fn(),
  createCaller: vi.fn(),
}));

vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: mocks.resolveTenantActor }));
vi.mock('@/server/trpc', () => ({ createTRPCContext: mocks.createTRPCContext }));
vi.mock('@/lib/abac', () => ({
  can: mocks.can,
  subjectFromSession: (user: { id: string }) => ({ id: user.id }),
}));
vi.mock('@/lib/entitlements', () => ({ hasModule: () => true }));
vi.mock('@/server/routers/restaurant-inventory', () => ({
  restaurantInventoryRouter: { createCaller: mocks.createCaller },
}));

import InventoryPage from './page';

const actor = {
  session: { expires: '2099-01-01', user: { id: 'user-1', organizationId: 'org-1' } },
  organization: { id: 'org-1', slug: 'acme', status: 'ACTIVE' },
  support: null,
};

function contextStub() {
  return {
    session: actor.session,
    organization: actor.organization,
    entitlements: { vertical: 'RESTAURANT', enabledModules: ['restaurant-pos'] },
    db: {
      restaurantStockLocation: { findMany: vi.fn().mockResolvedValue([]) },
      restaurantStockItem: { findMany: vi.fn().mockResolvedValue([]) },
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.can.mockResolvedValue(true);
  mocks.createCaller.mockReturnValue({
    listStockOnHand: vi.fn().mockResolvedValue([]),
    evaluateLowStockRules: vi.fn().mockResolvedValue([]),
    listStockMovements: vi.fn().mockResolvedValue({ items: [] }),
    listStockCounts: vi.fn().mockResolvedValue({ items: [] }),
    listStockTransfers: vi.fn().mockResolvedValue({ items: [] }),
  });
});

describe('InventoryPage tenancy resolution', () => {
  it('renders with a resolvable tenant actor and does not throw', async () => {
    mocks.resolveTenantActor.mockResolvedValue(actor);
    mocks.createTRPCContext.mockResolvedValue(contextStub());

    render(await InventoryPage());

    expect(screen.getByRole('heading', { name: 'Inventory' })).toBeDefined();
  });

  it('never asks the context factory to re-resolve tenancy', async () => {
    mocks.resolveTenantActor.mockResolvedValue(actor);
    mocks.createTRPCContext.mockResolvedValue(contextStub());

    await InventoryPage();

    // A bare `createTRPCContext()` always throws `Workspace not found.`: the
    // `{ session: undefined }` it forwards suppresses the `auth()` call.
    expect(mocks.createTRPCContext).toHaveBeenCalledWith({
      session: actor.session,
      organization: actor.organization,
      support: actor.support,
    });
  });

  it('renders the access state instead of throwing when the organization is absent', async () => {
    mocks.resolveTenantActor.mockResolvedValue(null);

    render(await InventoryPage());

    expect(screen.getByRole('heading', { name: 'Permission denied' })).toBeDefined();
    expect(mocks.createTRPCContext).not.toHaveBeenCalled();
  });
});
