import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import PharmacyApprovalsPage from './page';
import { PHARMACY_APPROVAL_QUEUE_PAGE_SIZE } from '@/lib/platform/pharmacy-approval-queue';

const mocks = vi.hoisted(() => ({
  requirePlatformRead: vi.fn(),
  withPlatformDb: vi.fn(),
  findMany: vi.fn(),
  findFirst: vi.fn(),
  count: vi.fn(),
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

const db = {
  organization: { findMany: mocks.findMany, findFirst: mocks.findFirst, count: mocks.count },
};

beforeEach(() => {
  vi.resetAllMocks();
  mocks.requirePlatformRead.mockResolvedValue({ role: 'SUPER_ADMIN' });
  mocks.withPlatformDb.mockImplementation((run) => run(db));
  mocks.count.mockResolvedValue(3);
  mocks.findFirst.mockResolvedValue(null);
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

const page = (after?: string) =>
  PharmacyApprovalsPage({ searchParams: Promise.resolve(after ? { after } : {}) });

function postedBody(fetchMock: ReturnType<typeof vi.fn>) {
  const calls = fetchMock.mock.calls as unknown as Array<[string, RequestInit]>;
  return JSON.parse(String(calls[0]![1].body));
}

describe('Pharmacy approval queue (DEV-905)', () => {
  it('checks the approval permission before reading any organization', async () => {
    mocks.requirePlatformRead.mockRejectedValue(new Error('forbidden'));
    await expect(page()).rejects.toThrow('forbidden');
    expect(mocks.requirePlatformRead).toHaveBeenCalledWith('/platform/approvals');
    expect(mocks.withPlatformDb).not.toHaveBeenCalled();
  });

  it('lists only pharmacies in onboarding, oldest first, one bounded page at a time', async () => {
    render(await page());
    expect(mocks.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { vertical: 'PHARMACY', status: 'ONBOARDING' },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: PHARMACY_APPROVAL_QUEUE_PAGE_SIZE + 1,
      })
    );
    expect(mocks.count).toHaveBeenCalledWith({
      where: { vertical: 'PHARMACY', status: 'ONBOARDING' },
    });
    expect(screen.getByText('3 pharmacies waiting.')).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Approval queue pages' })).toBeNull();
  });

  it('separates pharmacies meeting every check from those still onboarding', async () => {
    render(await page());

    const ready = screen.getByRole('region', { name: 'Ready to approve' });
    expect(within(ready).getByRole('link', { name: 'Ready Pharmacy' })).toBeInTheDocument();
    expect(within(ready).getByRole('button', { name: 'Approve pharmacy' })).toBeEnabled();
    expect(within(ready).getByLabelText('Approval note (optional)')).toBeInTheDocument();
    expect(within(ready).queryByText('Old Town Pharmacy')).not.toBeInTheDocument();
    expect(within(ready).queryByRole('checkbox')).toBeNull();

    const onboarding = screen.getByRole('region', { name: 'Still onboarding' });
    expect(
      within(onboarding)
        .getAllByRole('listitem')
        .filter((item) => item.dataset.organizationId)
        .map((item) => item.dataset.organizationId)
    ).toEqual(['org_old', 'org_nodeploy']);
    // Each not-ready pharmacy names the checks it does not meet, as information.
    expect(within(onboarding).getAllByText('Legal business (LEGAL_BUSINESS)')).not.toHaveLength(0);
    expect(within(onboarding).getAllByText('Add a ready production deployment.')).not.toHaveLength(
      0
    );
  });

  it('approves a ready pharmacy with the optional note and no confirmation', async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ data: {} }), { status: 200 })
    );
    vi.stubGlobal('fetch', fetchMock);
    render(await page());

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
    expect(postedBody(fetchMock)).toEqual({
      action: 'organization.pharmacy.approve',
      payload: {
        id: 'org_ready',
        reason:
          'Pharmacy approved by DevFathom after onboarding review. Note: Licence checked by phone',
        note: 'Licence checked by phone',
        confirmedUnmetChecks: [],
      },
    });
  });

  it('approves a pharmacy still onboarding only after the unmet checks are confirmed by name', async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ data: {} }), { status: 200 })
    );
    vi.stubGlobal('fetch', fetchMock);
    render(await page());

    const form = screen.getByRole('form', { name: 'Approve Old Town Pharmacy' });
    expect(within(form).getByText('This check is not met:')).toBeInTheDocument();
    expect(within(form).getByText('Legal business (LEGAL_BUSINESS)')).toBeInTheDocument();
    const approve = within(form).getByRole('button', { name: 'Approve pharmacy' });
    expect(approve).toBeDisabled();
    fireEvent.click(approve);
    expect(fetchMock).not.toHaveBeenCalled();

    fireEvent.click(within(form).getByRole('checkbox', { name: 'Approve without this check' }));
    expect(approve).toBeEnabled();
    fireEvent.click(approve);

    await waitFor(() => expect(mocks.refresh).toHaveBeenCalled());
    expect(postedBody(fetchMock)).toEqual({
      action: 'organization.pharmacy.approve',
      payload: {
        id: 'org_old',
        reason: 'Pharmacy approved by DevFathom after onboarding review.',
        confirmedUnmetChecks: ['LEGAL_BUSINESS'],
      },
    });
  });

  it('shows the server refusal', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              error:
                'Confirm the checks this pharmacy does not meet before approving it: Opening stock readiness (OPENING_STOCK_READINESS).',
            }),
            { status: 400 }
          )
      )
    );
    render(await page());

    const ready = screen.getByRole('region', { name: 'Ready to approve' });
    fireEvent.click(within(ready).getByRole('button', { name: 'Approve pharmacy' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Opening stock readiness (OPENING_STOCK_READINESS)'
    );
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it('explains an empty queue', async () => {
    mocks.findMany.mockResolvedValue([]);
    mocks.count.mockResolvedValue(0);
    render(await page());
    expect(screen.getByText('No pharmacy is waiting for approval.')).toBeInTheDocument();
    expect(screen.getByText(/No pharmacy meets every check yet/)).toBeInTheDocument();
    expect(screen.getByText('No pharmacy is still onboarding.')).toBeInTheDocument();
  });

  it('pages past the first batch so newer pharmacies stay reachable', async () => {
    const batch = Array.from({ length: PHARMACY_APPROVAL_QUEUE_PAGE_SIZE + 1 }, (_, index) =>
      pharmacy(`org_${String(index).padStart(3, '0')}`, `Pharmacy ${index}`, '2026-10-01T00:00:00Z')
    );
    mocks.findMany.mockResolvedValue(batch);
    mocks.count.mockResolvedValue(PHARMACY_APPROVAL_QUEUE_PAGE_SIZE + 7);
    mocks.readiness.mockImplementation(async (_db: unknown, organizationId: string) => ({
      organizationId,
      gates: [],
      ready: false,
      blocking: ['LEGAL_BUSINESS'],
    }));
    render(await page());

    // The page holds one batch and evaluates nothing beyond it.
    expect(mocks.readiness).toHaveBeenCalledTimes(PHARMACY_APPROVAL_QUEUE_PAGE_SIZE);
    expect(
      screen.getByText(
        `Showing ${PHARMACY_APPROVAL_QUEUE_PAGE_SIZE} of ${PHARMACY_APPROVAL_QUEUE_PAGE_SIZE + 7} pharmacies waiting.`
      )
    ).toBeInTheDocument();
    // No "none ready" claim while later pages exist.
    expect(screen.getByText(/No pharmacy on this page meets every check yet/)).toBeInTheDocument();
    const next = screen.getByRole('link', { name: 'Next page' });
    expect(next).toHaveAttribute(
      'href',
      `/platform/approvals?after=${batch[PHARMACY_APPROVAL_QUEUE_PAGE_SIZE - 1]!.id}`
    );
  });

  it('reads the next page after the cursor pharmacy', async () => {
    const anchor = { id: 'org_049', createdAt: new Date('2026-10-01T00:00:00Z') };
    mocks.findFirst.mockResolvedValue(anchor);
    render(await page('org_049'));

    expect(mocks.findFirst).toHaveBeenCalledWith({
      where: { vertical: 'PHARMACY', status: 'ONBOARDING', id: 'org_049' },
      select: { id: true, createdAt: true },
    });
    expect(mocks.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          vertical: 'PHARMACY',
          status: 'ONBOARDING',
          OR: [
            { createdAt: { gt: anchor.createdAt } },
            { createdAt: anchor.createdAt, id: { gt: anchor.id } },
          ],
        },
      })
    );
    expect(screen.getByRole('link', { name: 'Oldest first' })).toHaveAttribute(
      'href',
      '/platform/approvals'
    );
  });
});
