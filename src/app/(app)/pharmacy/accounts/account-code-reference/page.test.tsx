import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { TRPCContext } from '@/server/trpc';

const mocks = vi.hoisted(() => ({
  tenantContext: vi.fn(),
  can: vi.fn(),
  hasModule: vi.fn(),
  branchFindMany: vi.fn(),
  branchFindFirst: vi.fn(),
  journalEntryRead: vi.fn(),
  journalLineRead: vi.fn(),
  postJournalEntry: vi.fn(),
  reverseJournalEntry: vi.fn(),
  entriesForSource: vi.fn(),
  accountCodeReference: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('../../purchasing/_lib/console', () => ({ tenantContext: mocks.tenantContext }));
vi.mock('@/lib/abac', async () => ({
  ...(await vi.importActual<typeof import('@/lib/abac')>('@/lib/abac')),
  can: mocks.can,
}));
vi.mock('@/lib/entitlements', () => ({
  hasModule: mocks.hasModule,
  resolveOrganizationEntitlements: vi.fn(async () => ({ enabledModules: [] })),
}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn(() => ({})) }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/server/audit', () => ({
  ipFromHeaders: vi.fn(() => null),
  isAuditExcludedPath: vi.fn(() => true),
  recordTrpcAudit: vi.fn(),
}));
// The canonical mapping stays real; the journal's writers and reader are spies
// that must never be reached from this read-only reference.
vi.mock('@/lib/finance/journal', async () => ({
  ...(await vi.importActual<typeof import('@/lib/finance/journal')>('@/lib/finance/journal')),
  postJournalEntry: mocks.postJournalEntry,
  reverseJournalEntry: mocks.reverseJournalEntry,
  entriesForSource: mocks.entriesForSource,
}));
vi.mock('@/lib/pharmacy/accounts/account-code-reference', async () => {
  const actual = await vi.importActual<
    typeof import('@/lib/pharmacy/accounts/account-code-reference')
  >('@/lib/pharmacy/accounts/account-code-reference');
  mocks.accountCodeReference.mockImplementation(actual.accountCodeReference);
  return { ...actual, accountCodeReference: mocks.accountCodeReference };
});

import { ACCOUNT_NORMAL_SIDE } from '@/lib/finance/journal';
import Page from './page';

const BRANCHES = [
  { id: 'branch-1', name: 'Main' },
  { id: 'branch-2', name: 'North' },
];

function context(
  overrides: { role?: string; organizationId?: string; organization?: unknown } = {}
) {
  return {
    db: {
      pharmacyBranch: { findMany: mocks.branchFindMany, findFirst: mocks.branchFindFirst },
      financeJournalEntry: { findMany: mocks.journalEntryRead, create: mocks.journalEntryRead },
      financeJournalLine: { findMany: mocks.journalLineRead, create: mocks.journalLineRead },
    },
    entitlements: {
      organizationId: overrides.organizationId ?? 'org-1',
      enabledModules: ['pharmacy-reports'],
      modules: [],
    },
    session: {
      expires: 'later',
      user: {
        id: 'user-1',
        role: overrides.role ?? 'EMPLOYEE',
        status: 'ACTIVE',
        organizationId: 'org-1',
      },
    },
    organization: 'organization' in overrides ? overrides.organization : { id: 'org-1' },
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext;
}

function grant(actions: string[]) {
  mocks.can.mockImplementation(async (_subject: unknown, action: string) =>
    actions.includes(action)
  );
}

async function show(query: Record<string, string | string[]> = {}) {
  render(await Page({ searchParams: Promise.resolve(query) }));
}

function expectNoReference() {
  expect(mocks.accountCodeReference).not.toHaveBeenCalled();
  expect(screen.queryByRole('table')).not.toBeInTheDocument();
  expect(screen.queryByText('SALES_REVENUE')).not.toBeInTheDocument();
}

function expectNoFinancialAccess() {
  expect(mocks.postJournalEntry).not.toHaveBeenCalled();
  expect(mocks.reverseJournalEntry).not.toHaveBeenCalled();
  expect(mocks.entriesForSource).not.toHaveBeenCalled();
  expect(mocks.journalEntryRead).not.toHaveBeenCalled();
  expect(mocks.journalLineRead).not.toHaveBeenCalled();
  expect(mocks.branchFindFirst).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.tenantContext.mockResolvedValue(context());
  mocks.hasModule.mockReturnValue(true);
  mocks.branchFindMany.mockResolvedValue(BRANCHES);
  grant(['reports:operational', 'reports:financial']);
});
afterEach(cleanup);

describe('account-code reference page: authorized', () => {
  it('renders every canonical code once with its exact normal side, in canonical order', async () => {
    await show();
    const region = screen.getByRole('region', { name: 'Canonical account codes' });
    const rows = within(region).getAllByRole('row').slice(1);
    const codes = Object.keys(ACCOUNT_NORMAL_SIDE) as (keyof typeof ACCOUNT_NORMAL_SIDE)[];
    expect(rows).toHaveLength(codes.length);
    rows.forEach((row, index) => {
      const cells = within(row).getAllByRole('cell');
      expect(cells[0]).toHaveTextContent(new RegExp(`^${codes[index]}$`));
      expect(cells[2]).toHaveTextContent(
        ACCOUNT_NORMAL_SIDE[codes[index]!] === 'DEBIT' ? 'Debit' : 'Credit'
      );
    });
    expect(mocks.accountCodeReference).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/all 2 authorized active branches/)).toBeInTheDocument();
    expectNoFinancialAccess();
  });

  it('allows an operational-report ADMIN without a separate financial grant', async () => {
    mocks.tenantContext.mockResolvedValue(context({ role: 'ADMIN' }));
    grant(['reports:operational']);
    await show();
    expect(screen.getByRole('table')).toBeInTheDocument();
    expectNoFinancialAccess();
  });

  it('shows the selected authorized branch as context', async () => {
    await show({ branch: 'branch-2' });
    expect(screen.getByText(/Branch context: North\./)).toBeInTheDocument();
    expect(screen.getByRole('table')).toBeInTheDocument();
  });

  it('offers no mutation controls', async () => {
    await show();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(document.querySelector('form')).toBeNull();
  });
});

describe('account-code reference page: denial before rendering', () => {
  it.each([
    ['no tenant actor', () => mocks.tenantContext.mockResolvedValue(null)],
    [
      'organization mismatch',
      () => mocks.tenantContext.mockResolvedValue(context({ organizationId: 'org-2' })),
    ],
    [
      'no organization',
      () => mocks.tenantContext.mockResolvedValue(context({ organization: null })),
    ],
    ['reports module disabled', () => mocks.hasModule.mockReturnValue(false)],
    ['operational without financial', () => grant(['reports:operational'])],
    ['financial without operational', () => grant(['reports:financial'])],
    [
      'ADMIN without operational',
      () => {
        mocks.tenantContext.mockResolvedValue(context({ role: 'ADMIN' }));
        grant([]);
      },
    ],
  ])('denies: %s', async (_name, arrange) => {
    arrange();
    await show();
    expect(screen.getByText('Account reference access required')).toBeInTheDocument();
    expectNoReference();
    expectNoFinancialAccess();
  });

  it('denies an explicit branch outside the authorized active scope without falling back', async () => {
    await show({ branch: 'branch-other' });
    expect(screen.getByText('Branch not available')).toBeInTheDocument();
    expect(screen.queryByText(/Main|North/)).not.toBeInTheDocument();
    expectNoReference();
    expectNoFinancialAccess();
  });

  it('denies an empty explicit branch', async () => {
    await show({ branch: '' });
    expect(screen.getByText('Branch not available')).toBeInTheDocument();
    expectNoReference();
  });

  it('denies duplicated branch parameters even when one is authorized', async () => {
    await show({ branch: ['branch-1', 'branch-2'] });
    expect(screen.getByText('Branch not available')).toBeInTheDocument();
    expectNoReference();
  });

  it('denies when no authorized active branch exists', async () => {
    mocks.branchFindMany.mockResolvedValue([]);
    await show();
    expect(screen.getByText('No active branch')).toBeInTheDocument();
    expectNoReference();
  });

  it('fails closed when access cannot be verified', async () => {
    mocks.branchFindMany.mockRejectedValue(new Error('database host secret'));
    await show();
    expect(screen.getByText('Reference access unavailable')).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent('database host secret');
    expectNoReference();
  });

  it('scopes the branch read to the active tenant branches', async () => {
    await show();
    expect(mocks.branchFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { organizationId: 'org-1', active: true } })
    );
  });
});
