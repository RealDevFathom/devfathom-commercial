import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import PharmacyApprovalsPage from './page';

const mocks = vi.hoisted(() => ({
  requirePlatformRead: vi.fn(),
  withPlatformDb: vi.fn(),
  findMany: vi.fn(),
  readiness: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock('@/lib/platform/page-access', () => ({ requirePlatformRead: mocks.requirePlatformRead }));
vi.mock('@/lib/tenancy/scoped-db', () => ({ withPlatformDb: mocks.withPlatformDb }));
vi.mock('@/lib/pharmacy/onboarding', async (original) => ({
  ...(await original<typeof import('@/lib/pharmacy/onboarding')>()),
  evaluatePharmacyReadiness: mocks.readiness,
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: mocks.refresh }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

/** A pharmacy organization row as the queue selects it, with every base gate met. */
function pharmacy(id: string, displayName: string, createdAt: string) {
  return {
    id,
    slug: id,
    displayName,
    legalName: `${displayName} Ltd`,
    createdAt: new Date(createdAt),
    packageId: 'pkg_pharmacy',
    package: { moduleLinks: [{ id: 'link_1' }] },
    modules: [],
    users: [{ id: 'admin_1' }],
    deployments: [{ id: 'deployment_1' }],
  };
}

const db = { organization: { findMany: mocks.findMany } };

beforeEach(() => {
  vi.resetAllMocks();
  mocks.requirePlatformRead.mockResolvedValue({ role: 'SUPER_ADMIN' });
  mocks.withPlatformDb.mockImplementation((run) => run(db));
  mocks.findMany.mockResolvedValue([
    pharmacy('org_old', 'Old Town Pharmacy', '2026-10-01T00:00:00Z'),
    pharmacy('org_ready', 'Ready Pharmacy', '2026-10-05T00:00:00Z'),
    { ...pharmacy('org_nodeploy', 'No Deploy Pharmacy', '2026-10-09T00:00:00Z'), deployments: [] },
  ]);
  mocks.readiness.mockImplementation(async (_db: unknown, organizationId: string) =>
    organizationId === 'org_old'
      ? { organizationId, gates: [], ready: false, blocking: ['LEGAL_BUSINESS'] }
      : { organizationId, gates: [], ready: true, blocking: [] }
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Pharmacy approval queue (DEV-905)', () => {
  it('checks the approval permission before reading any organization', async () => {
    mocks.requirePlatformRead.mockRejectedValue(new Error('forbidden'));
    await expect(PharmacyApprovalsPage()).rejects.toThrow('forbidden');
    expect(mocks.requirePlatformRead).toHaveBeenCalledWith('/platform/approvals');
    expect(mocks.withPlatformDb).not.toHaveBeenCalled();
  });

  it('lists only pharmacies in onboarding, oldest first', async () => {
    render(await PharmacyApprovalsPage());
    expect(mocks.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { vertical: 'PHARMACY', status: 'ONBOARDING' },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      })
    );
  });

  it('separates pharmacies ready to approve from those still onboarding', async () => {
    render(await PharmacyApprovalsPage());

    const ready = screen.getByRole('region', { name: 'Ready to approve' });
    expect(within(ready).getByRole('link', { name: 'Ready Pharmacy' })).toBeInTheDocument();
    expect(within(ready).getByRole('button', { name: 'Approve pharmacy' })).toBeInTheDocument();
    expect(within(ready).getByLabelText('Approval note (optional)')).toBeInTheDocument();
    expect(within(ready).queryByText('Old Town Pharmacy')).not.toBeInTheDocument();

    const onboarding = screen.getByRole('region', { name: 'Still onboarding' });
    expect(
      within(onboarding)
        .getAllByRole('listitem')
        .filter((item) => item.dataset.organizationId)
        .map((item) => item.dataset.organizationId)
    ).toEqual(['org_old', 'org_nodeploy']);
    // Each not-ready pharmacy names the gates that block it, and offers no approval.
    expect(within(onboarding).getByText('Legal business (LEGAL_BUSINESS)')).toBeInTheDocument();
    expect(within(onboarding).getByText('Add a ready production deployment.')).toBeInTheDocument();
    expect(
      within(onboarding).queryByRole('button', { name: 'Approve pharmacy' })
    ).not.toBeInTheDocument();
  });

  it('approves through the existing lifecycle transition with the optional note', async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ data: {} }), { status: 200 })
    );
    vi.stubGlobal('fetch', fetchMock);
    render(await PharmacyApprovalsPage());

    const ready = screen.getByRole('region', { name: 'Ready to approve' });
    fireEvent.change(within(ready).getByLabelText('Approval note (optional)'), {
      target: { value: 'Licence checked by phone' },
    });
    fireEvent.click(within(ready).getByRole('button', { name: 'Approve pharmacy' }));

    await waitFor(() => expect(mocks.refresh).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/platform/control',
      expect.objectContaining({ method: 'POST' })
    );
    const calls = fetchMock.mock.calls as unknown as Array<[string, RequestInit]>;
    expect(JSON.parse(String(calls[0]![1].body))).toEqual({
      action: 'organization.transition',
      payload: {
        id: 'org_ready',
        status: 'ACTIVE',
        reason:
          'Pharmacy approved by DevFathom after onboarding review. Note: Licence checked by phone',
      },
    });
  });

  it('shows the server refusal and the gates it names', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              error:
                'Activation preflight failed: pharmacy onboarding gates not passed (OPENING_STOCK_READINESS).',
            }),
            { status: 400 }
          )
      )
    );
    render(await PharmacyApprovalsPage());

    fireEvent.click(screen.getByRole('button', { name: 'Approve pharmacy' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'pharmacy onboarding gates not passed (OPENING_STOCK_READINESS)'
    );
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it('explains an empty queue', async () => {
    mocks.findMany.mockResolvedValue([]);
    render(await PharmacyApprovalsPage());
    expect(screen.getByText(/No pharmacy has finished onboarding yet/)).toBeInTheDocument();
    expect(screen.getByText('No pharmacy is still onboarding.')).toBeInTheDocument();
  });
});
