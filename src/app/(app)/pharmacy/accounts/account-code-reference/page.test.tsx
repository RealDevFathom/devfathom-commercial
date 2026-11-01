import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  actor: vi.fn(),
  can: vi.fn(),
  hasModule: vi.fn(),
  branchRead: vi.fn(),
  referenceRead: vi.fn(),
  journalWriter: vi.fn(),
  financeDataReader: vi.fn(),
}));

vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: mocks.actor }));
vi.mock('@/lib/entitlements', () => ({ hasModule: mocks.hasModule }));
vi.mock('@/lib/abac', () => ({
  can: mocks.can,
  subjectFromSession: (user: unknown) => user,
}));
vi.mock('@/lib/pharmacy/accounts/account-code-reference', () => ({
  accountCodeReference: mocks.referenceRead,
}));
vi.mock('@/server/trpc', () => ({
  createTRPCContext: vi.fn(async () => ({
    session: { user: { id: 'user-1', role: 'EMPLOYEE', status: 'ACTIVE' } },
    entitlements: { organizationId: 'org-1' },
    organization: { id: 'org-1' },
    requestMeta: { ip: null },
    db: {
      pharmacyBranch: { findMany: mocks.branchRead },
      financeJournalEntry: { create: mocks.journalWriter },
      financeJournalLine: { findMany: mocks.financeDataReader },
    },
  })),
}));

import Page from './page';

const actor = { session: {}, organization: { id: 'org-1' }, support: null };

beforeEach(() => {
  mocks.actor.mockResolvedValue(actor);
  mocks.hasModule.mockReturnValue(true);
  mocks.can.mockResolvedValue(true);
  mocks.branchRead.mockResolvedValue([{ id: 'branch-1', name: 'Main pharmacy' }]);
  mocks.referenceRead.mockReturnValue([
    { code: 'ACCOUNTS_PAYABLE', normalSide: 'CREDIT' },
    { code: 'CASH', normalSide: 'DEBIT' },
  ]);
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('account code reference page authorization', () => {
  it.each(['loaded', 'permission-denied'] as const)(
    'preserves the shell as the only main landmark in the %s state',
    async (state) => {
      if (state === 'permission-denied') mocks.actor.mockResolvedValueOnce(null);

      const page = await Page({ searchParams: Promise.resolve({}) });
      render(<main data-slot="app-canvas">{page}</main>);

      expect(screen.getAllByRole('main')).toHaveLength(1);
      expect(screen.getByRole('main')).toHaveAttribute('data-slot', 'app-canvas');
    }
  );

  it('renders the canonical read-only reference for operational plus financial access', async () => {
    render(await Page({ searchParams: Promise.resolve({ branch: 'branch-1' }) }));

    expect(mocks.can).toHaveBeenCalledTimes(2);
    expect(mocks.can.mock.calls.map((call) => call[1])).toEqual([
      'reports:operational',
      'reports:financial',
    ]);
    expect(screen.getByRole('heading', { name: 'Account code reference' })).toBeInTheDocument();
    expect(screen.getByText('ACCOUNTS_PAYABLE')).toBeInTheDocument();
    expect(screen.getByText('CREDIT')).toBeInTheDocument();
    expect(
      screen.getByText(/do not create or change accounts, balances, or postings/)
    ).toBeVisible();
    expect(mocks.journalWriter).not.toHaveBeenCalled();
    expect(mocks.financeDataReader).not.toHaveBeenCalled();
  });

  it('allows an administrator without consulting report capability policy', async () => {
    const { createTRPCContext } = await import('@/server/trpc');
    vi.mocked(createTRPCContext).mockResolvedValueOnce({
      session: { user: { id: 'admin-1', role: 'ADMIN', status: 'ACTIVE' } },
      entitlements: { organizationId: 'org-1' },
      organization: { id: 'org-1' },
      requestMeta: { ip: null },
      db: { pharmacyBranch: { findMany: mocks.branchRead } },
    } as never);

    render(await Page({ searchParams: Promise.resolve({}) }));

    expect(screen.getByText('CASH')).toBeInTheDocument();
    expect(mocks.can).not.toHaveBeenCalled();
  });

  it.each([
    ['missing tenant actor', () => mocks.actor.mockResolvedValueOnce(null)],
    [
      'inactive session',
      async () => {
        const { createTRPCContext } = await import('@/server/trpc');
        vi.mocked(createTRPCContext).mockResolvedValueOnce({
          session: { user: { id: 'user-1', role: 'EMPLOYEE', status: 'INACTIVE' } },
          entitlements: { organizationId: 'org-1' },
          requestMeta: { ip: null },
          db: { pharmacyBranch: { findMany: mocks.branchRead } },
        } as never);
      },
    ],
    [
      'null session',
      async () => {
        const { createTRPCContext } = await import('@/server/trpc');
        vi.mocked(createTRPCContext).mockResolvedValueOnce({
          session: null,
          entitlements: { organizationId: 'org-1' },
          requestMeta: { ip: null },
          db: { pharmacyBranch: { findMany: mocks.branchRead } },
        } as never);
      },
    ],
    ['disabled module', () => mocks.hasModule.mockReturnValueOnce(false)],
    [
      'missing operational permission',
      () => mocks.can.mockImplementation((_subject, action) => action !== 'reports:operational'),
    ],
    [
      'missing financial permission',
      () => mocks.can.mockImplementation((_subject, action) => action !== 'reports:financial'),
    ],
  ])('denies %s before branch or reference reads', async (_condition, arrange) => {
    await arrange();
    render(await Page({ searchParams: Promise.resolve({}) }));

    expect(screen.getByRole('heading', { name: /required|unavailable/i })).toBeInTheDocument();
    expect(mocks.branchRead).not.toHaveBeenCalled();
    expect(mocks.referenceRead).not.toHaveBeenCalled();
    expect(mocks.journalWriter).not.toHaveBeenCalled();
    expect(mocks.financeDataReader).not.toHaveBeenCalled();
  });

  it('denies an explicit unknown or inactive branch instead of falling back', async () => {
    render(await Page({ searchParams: Promise.resolve({ branch: 'stale-branch' }) }));

    expect(screen.getByRole('heading', { name: 'Branch unavailable' })).toBeInTheDocument();
    expect(screen.queryByText('CASH')).not.toBeInTheDocument();
    expect(mocks.referenceRead).not.toHaveBeenCalled();
    expect(mocks.branchRead).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { organizationId: 'org-1', active: true },
      })
    );
    expect(mocks.journalWriter).not.toHaveBeenCalled();
    expect(mocks.financeDataReader).not.toHaveBeenCalled();
  });

  it('denies access when the workspace has no active pharmacy branch', async () => {
    mocks.branchRead.mockResolvedValueOnce([]);

    render(await Page({ searchParams: Promise.resolve({}) }));

    expect(screen.getByRole('heading', { name: 'No active branch' })).toBeInTheDocument();
    expect(screen.queryByText('CASH')).not.toBeInTheDocument();
    expect(mocks.referenceRead).not.toHaveBeenCalled();
    expect(mocks.journalWriter).not.toHaveBeenCalled();
    expect(mocks.financeDataReader).not.toHaveBeenCalled();
  });

  it.each([
    ['an empty value', ''],
    ['repeated values', ['stale-branch', 'branch-1']],
    ['an empty repeated value', []],
    ['an excessively long value', 'b'.repeat(129)],
  ])('denies an explicit malformed branch with %s', async (_condition, branch) => {
    render(await Page({ searchParams: Promise.resolve({ branch }) }));

    expect(screen.getByRole('heading', { name: 'Branch unavailable' })).toBeInTheDocument();
    expect(screen.queryByText('CASH')).not.toBeInTheDocument();
    expect(mocks.branchRead).not.toHaveBeenCalled();
    expect(mocks.referenceRead).not.toHaveBeenCalled();
    expect(mocks.journalWriter).not.toHaveBeenCalled();
    expect(mocks.financeDataReader).not.toHaveBeenCalled();
  });
});
