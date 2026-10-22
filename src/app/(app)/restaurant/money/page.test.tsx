import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  can: vi.fn(),
  createTRPCContext: vi.fn(),
  resolveTenantActor: vi.fn(),
}));

vi.mock('@/components/restaurant/money/money-console', () => ({
  MoneyConsole: ({
    initialTab,
    canReadFinance,
  }: {
    initialTab: string;
    canReadFinance: boolean;
  }) => (
    <div>
      Initial tab: {initialTab}; finance: {String(canReadFinance)}
    </div>
  ),
}));
vi.mock('@/lib/abac', () => ({
  can: mocks.can,
  subjectFromSession: (user: { id: string }) => ({ id: user.id }),
}));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: mocks.resolveTenantActor }));
vi.mock('@/server/trpc', () => ({ createTRPCContext: mocks.createTRPCContext }));

import RestaurantMoneyPage from './page';

describe('RestaurantMoneyPage', () => {
  const actor = {
    session: { user: { id: 'user_1' } },
    organization: { id: 'org_1', slug: 'restaurant' },
    support: null,
  };
  const context = {
    session: actor.session,
    db: { marker: 'tenant-db' },
    requestMeta: { ip: '127.0.0.1' },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveTenantActor.mockResolvedValue(actor);
    mocks.createTRPCContext.mockResolvedValue(context);
    mocks.can.mockResolvedValue(true);
  });

  it('opens a validated URL-driven ledger tab', async () => {
    render(
      await RestaurantMoneyPage({
        searchParams: Promise.resolve({ tab: 'daily-close' }),
      })
    );
    expect(screen.getByText('Initial tab: daily-close; finance: true')).toBeInTheDocument();
    expect(mocks.can).toHaveBeenCalledWith({ id: 'user_1' }, 'money:read', undefined, {
      db: context.db,
      source: 'TRPC',
      ip: '127.0.0.1',
    });
    expect(mocks.createTRPCContext).toHaveBeenCalledWith({
      session: actor.session,
      organization: actor.organization,
      support: actor.support,
    });
  });

  it.each([{ tab: 'unknown' }, { tab: ['daily-close', 'bills'] }, {}])(
    'falls back to Bills for an invalid or missing tab',
    async (searchParams) => {
      render(await RestaurantMoneyPage({ searchParams: Promise.resolve(searchParams) }));
      expect(screen.getByText('Initial tab: bills; finance: true')).toBeInTheDocument();
    }
  );

  it('fails closed when the tenant actor lacks finance read capability', async () => {
    mocks.can.mockResolvedValue(false);

    render(await RestaurantMoneyPage({ searchParams: Promise.resolve({}) }));

    expect(screen.getByText('Initial tab: bills; finance: false')).toBeInTheDocument();
  });

  it('fails closed without constructing a context when tenancy does not resolve', async () => {
    mocks.resolveTenantActor.mockResolvedValue(null);

    render(await RestaurantMoneyPage({ searchParams: Promise.resolve({ tab: 'payments' }) }));

    expect(screen.getByText('Initial tab: payments; finance: false')).toBeInTheDocument();
    expect(mocks.createTRPCContext).not.toHaveBeenCalled();
    expect(mocks.can).not.toHaveBeenCalled();
  });
});
