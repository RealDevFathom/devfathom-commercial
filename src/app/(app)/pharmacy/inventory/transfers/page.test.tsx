import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  actor: vi.fn(),
  context: vi.fn(),
  caller: vi.fn(),
  module: vi.fn(),
  access: vi.fn(),
  branchFindMany: vi.fn(),
}));
vi.mock('next/navigation', () => ({ redirect: vi.fn() }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: mocks.actor }));
vi.mock('@/server/trpc', () => ({ createTRPCContext: mocks.context }));
vi.mock('@/lib/entitlements', () => ({ hasModule: mocks.module }));
vi.mock('@/server/routers/pharmacy-inventory', () => ({
  pharmacyInventoryRouter: { createCaller: mocks.caller },
}));
vi.mock('@/lib/pharmacy/staff-access', () => ({ readPharmacyStaffAccess: mocks.access }));

import PharmacyTransfersPage from './page';

const user = { id: 'cashier', role: 'EMPLOYEE', status: 'ACTIVE' };

beforeEach(() => {
  vi.clearAllMocks();
  const ctx = {
    session: { user },
    organization: { id: 'org' },
    entitlements: {},
    db: { pharmacyBranch: { findMany: mocks.branchFindMany } },
  };
  mocks.actor.mockResolvedValue({ session: ctx.session, organization: ctx.organization });
  mocks.context.mockResolvedValue(ctx);
  mocks.module.mockReturnValue(true);
  mocks.branchFindMany.mockResolvedValue([]);
});
afterEach(cleanup);

describe('Stock transfers screen by role', () => {
  it('shows a cashier the permission state, never the transfer screen or its actions', async () => {
    mocks.access.mockResolvedValue({ inventoryControl: false });
    render(await PharmacyTransfersPage({ searchParams: Promise.resolve({}) }));
    expect(screen.getByRole('heading', { name: 'Permission required' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Allocate|Approve|Dispatch|Receive/ })).toBeNull();
    expect(mocks.access).toHaveBeenCalledWith(user, expect.anything());
    expect(mocks.branchFindMany).not.toHaveBeenCalled();
    expect(mocks.caller).not.toHaveBeenCalled();
  });

  it('lets a member with inventory control past the permission gate', async () => {
    mocks.access.mockResolvedValue({ inventoryControl: true });
    render(await PharmacyTransfersPage({ searchParams: Promise.resolve({}) }));
    expect(screen.queryByRole('heading', { name: 'Permission required' })).toBeNull();
    expect(mocks.branchFindMany).toHaveBeenCalled();
  });
});
