import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  resolveTenantActor: vi.fn(),
  createTRPCContext: vi.fn(),
  createCaller: vi.fn(),
}));

vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: mocks.resolveTenantActor }));
vi.mock('@/server/trpc', () => ({ createTRPCContext: mocks.createTRPCContext }));
vi.mock('@/server/routers/pharmacy-general-journal', () => ({ pharmacyGeneralJournalRouter: { createCaller: mocks.createCaller } }));
vi.mock('next/navigation', () => ({ redirect: vi.fn() }));

import GeneralJournalPage from './page';

const actor = {
  session: { user: { id: 'user-1' } },
  organization: { id: 'org-1', slug: 'shop' },
  support: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.createTRPCContext.mockResolvedValue({ session: actor.session, organization: actor.organization });
  mocks.createCaller.mockReturnValue({
    branches: vi.fn().mockResolvedValue([{ id: 'branch-1', name: 'Main branch' }]),
    list: vi.fn().mockResolvedValue([]),
  });
});

describe('general journal page admission', () => {
  it('renders a denial without touching protected data when no tenant actor resolves', async () => {
    mocks.resolveTenantActor.mockResolvedValue(null);
    render(await GeneralJournalPage({ searchParams: Promise.resolve({}) }));
    expect(screen.getByText('Permission denied')).toBeDefined();
    expect(mocks.createTRPCContext).not.toHaveBeenCalled();
    expect(mocks.createCaller).not.toHaveBeenCalled();
  });

  it('passes the prefixless request actor to context and loads through the real router surface', async () => {
    mocks.resolveTenantActor.mockResolvedValue(actor);
    render(await GeneralJournalPage({ searchParams: Promise.resolve({}) }));
    expect(mocks.createTRPCContext).toHaveBeenCalledWith({ session: actor.session, organization: actor.organization, support: null });
    expect(screen.getByRole('heading', { name: 'General journal' })).toBeDefined();
    expect(screen.getByText('No vouchers have been saved for this branch.')).toBeDefined();
  });
});
