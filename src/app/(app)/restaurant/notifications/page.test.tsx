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
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('next/navigation', () => ({ redirect: vi.fn() }));
vi.mock('@/server/routers/restaurant-notifications', () => ({
  restaurantNotificationsRouter: { createCaller: mocks.createCaller },
}));

import RestaurantNotificationsPage from './page';

const actor = {
  session: { expires: '2099-01-01', user: { id: 'user-1', organizationId: 'org-1' } },
  organization: { id: 'org-1', slug: 'acme', status: 'ACTIVE' },
  support: null,
};

const searchParams = Promise.resolve({});

function contextStub() {
  return {
    session: actor.session,
    organization: actor.organization,
    entitlements: { enabledModules: ['restaurant-core'] },
    db: { restaurantBranch: { findMany: vi.fn().mockResolvedValue([]) } },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // `staff:manage` denied keeps the routing-matrix branch out of this fixture;
  // the tenancy path under test is the same either way.
  mocks.can.mockResolvedValue(false);
  mocks.createCaller.mockReturnValue({
    list: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    unreadCount: vi.fn().mockResolvedValue({ count: 0 }),
  });
});

describe('RestaurantNotificationsPage tenancy resolution', () => {
  it('renders with a resolvable tenant actor and does not throw', async () => {
    mocks.resolveTenantActor.mockResolvedValue(actor);
    mocks.createTRPCContext.mockResolvedValue(contextStub());

    render(await RestaurantNotificationsPage({ searchParams }));

    expect(screen.getByRole('heading', { name: 'Notifications center' })).toBeDefined();
  });

  it('never asks the context factory to re-resolve tenancy', async () => {
    mocks.resolveTenantActor.mockResolvedValue(actor);
    mocks.createTRPCContext.mockResolvedValue(contextStub());

    await RestaurantNotificationsPage({ searchParams });

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

    render(await RestaurantNotificationsPage({ searchParams }));

    expect(screen.getByText('Permission denied')).toBeDefined();
    expect(mocks.createTRPCContext).not.toHaveBeenCalled();
  });

  it('renders labeled webhook controls and a disabled test action when the endpoint is disabled', async () => {
    mocks.resolveTenantActor.mockResolvedValue(actor);
    mocks.createTRPCContext.mockResolvedValue(contextStub());
    mocks.can.mockResolvedValue(true);
    mocks.createCaller.mockReturnValue({
      list: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
      unreadCount: vi.fn().mockResolvedValue({ count: 0 }),
      getMatrix: vi.fn().mockResolvedValue({
        category: 'sop.escalation',
        branchId: null,
        channels: ['IN_APP', 'WEBHOOK', 'EMAIL', 'SMS', 'PUSH', 'WHATSAPP'].map((channel) => ({
          channel,
          enabled: true,
        })),
      }),
      webhookStatus: vi.fn().mockResolvedValue({ config: null, deliveries: [] }),
    });

    render(await RestaurantNotificationsPage({ searchParams }));

    expect(screen.getByLabelText('HTTPS endpoint')).toBeDefined();
    expect(screen.getByLabelText('New signing secret')).toHaveAttribute(
      'aria-describedby',
      'webhook-secret-help'
    );
    expect(screen.getByRole('button', { name: 'Queue test delivery' })).toBeDisabled();
    expect(screen.getByText('Signed webhook')).toBeDefined();
  });
});
