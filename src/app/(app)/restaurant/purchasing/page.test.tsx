import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  resolveTenantActor: vi.fn(),
  createTRPCContext: vi.fn(),
  can: vi.fn(),
  createCaller: vi.fn(),
  hasModule: vi.fn(),
}));

vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: mocks.resolveTenantActor }));
vi.mock('@/server/trpc', () => ({ createTRPCContext: mocks.createTRPCContext }));
vi.mock('@/lib/abac', () => ({
  can: mocks.can,
  subjectFromSession: (user: { id: string }) => ({ id: user.id }),
}));
vi.mock('@/lib/entitlements', () => ({ hasModule: mocks.hasModule }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('next/navigation', () => ({ redirect: vi.fn() }));
vi.mock('@/server/routers/restaurant-purchasing', () => ({
  restaurantPurchasingRouter: { createCaller: mocks.createCaller },
}));

import PurchasingPage from './page';

const actor = {
  session: { expires: '2099-01-01', user: { id: 'user-1', organizationId: 'org-1' } },
  organization: { id: 'org-1', slug: 'acme', status: 'ACTIVE' },
  support: null,
};

const searchParams = Promise.resolve({});

function contextStub(enabledModules = ['restaurant-purchasing']) {
  return {
    session: actor.session,
    organization: actor.organization,
    entitlements: { enabledModules },
    db: {
      restaurantBranch: { findMany: vi.fn().mockResolvedValue([]) },
      restaurantStockLocation: { findMany: vi.fn().mockResolvedValue([]) },
      restaurantStockItem: { findMany: vi.fn().mockResolvedValue([]) },
      restaurantUnit: { findMany: vi.fn().mockResolvedValue([]) },
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.can.mockResolvedValue(true);
  mocks.hasModule.mockImplementation(
    (entitlements: { enabledModules: string[] }, module: string) =>
      entitlements.enabledModules.includes(module)
  );
  mocks.createCaller.mockReturnValue({
    listSuppliers: vi.fn().mockResolvedValue({ suppliers: [] }),
    listPurchaseOrders: vi.fn().mockResolvedValue({ orders: [] }),
  });
});

describe('PurchasingPage tenancy resolution', () => {
  it('renders when purchasing is enabled even with POS disabled', async () => {
    mocks.resolveTenantActor.mockResolvedValue(actor);
    mocks.createTRPCContext.mockResolvedValue(contextStub());

    render(await PurchasingPage({ searchParams }));

    expect(screen.getByRole('heading', { name: 'Purchasing' })).toBeDefined();
    expect(screen.queryByText('Purchasing could not load')).toBeNull();
    expect(mocks.hasModule).toHaveBeenCalledWith(
      { enabledModules: ['restaurant-purchasing'] },
      'restaurant-purchasing'
    );
  });

  it('denies access when purchasing is disabled', async () => {
    mocks.resolveTenantActor.mockResolvedValue(actor);
    mocks.createTRPCContext.mockResolvedValue(contextStub(['restaurant-pos']));

    render(await PurchasingPage({ searchParams }));

    expect(screen.getByRole('heading', { name: 'Module disabled' })).toBeDefined();
    expect(mocks.createCaller).not.toHaveBeenCalled();
  });

  it('never asks the context factory to re-resolve tenancy', async () => {
    mocks.resolveTenantActor.mockResolvedValue(actor);
    mocks.createTRPCContext.mockResolvedValue(contextStub());

    await PurchasingPage({ searchParams });

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

    render(await PurchasingPage({ searchParams }));

    expect(screen.getByRole('heading', { name: 'Module disabled' })).toBeDefined();
    expect(mocks.createTRPCContext).not.toHaveBeenCalled();
  });

  it('renders the access state instead of throwing when the session is absent', async () => {
    mocks.resolveTenantActor.mockResolvedValue(actor);
    mocks.createTRPCContext.mockResolvedValue({ ...contextStub(), session: null });

    render(await PurchasingPage({ searchParams }));

    expect(screen.getByRole('heading', { name: 'Permission denied' })).toBeDefined();
    expect(mocks.createCaller).not.toHaveBeenCalled();
  });
});
