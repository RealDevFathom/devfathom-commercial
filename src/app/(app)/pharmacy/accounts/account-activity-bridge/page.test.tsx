import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TRPCError } from '@trpc/server';
import AccountActivityBridgePage from './page';

const mocks = vi.hoisted(() => ({ branches: vi.fn(), financialStatements: vi.fn() }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({
  resolveTenantActor: vi.fn().mockResolvedValue({
    session: { user: { role: 'ADMIN' } },
    organization: { id: 'org_1' },
  }),
}));
vi.mock('@/server/trpc', () => ({
  createTRPCContext: vi.fn().mockResolvedValue({
    session: { user: { role: 'ADMIN' } },
    entitlements: { organizationId: 'org_1' },
    db: { pharmacyBranch: { findMany: mocks.branches } },
  }),
}));
vi.mock('@/server/routers/pharmacy-finance', () => ({
  pharmacyFinanceRouter: {
    createCaller: () => ({ financialStatements: mocks.financialStatements }),
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.financialStatements.mockReset();
  mocks.branches.mockResolvedValue([{ id: 'branch_1', name: 'Main' }]);
  mocks.financialStatements.mockResolvedValue({
    scope: { organizationId: 'org_1', branchId: 'branch_1' },
    accounts: ['PKR', 'USD'].map((currency) => ({
      accountCode: 'CASH',
      currency,
      openingMinor: '100',
      debitMinor: '50',
      creditMinor: '20',
      closingMinor: '130',
    })),
  });
});

describe('account activity bridge page failures', () => {
  it.each([
    [new TRPCError({ code: 'FORBIDDEN' }), 'Permission required', 'financial-report permission'],
    [
      new Error('database unavailable'),
      'Account activity unavailable',
      'No financial data was changed',
    ],
  ])('separates denied and read errors without exposing details', async (error, title, message) => {
    mocks.financialStatements.mockRejectedValue(error);
    const page = await AccountActivityBridgePage({
      searchParams: Promise.resolve({ from: '2026-10-01', to: '2026-10-02' }),
    });
    const html = renderToStaticMarkup(page);
    expect(html).toContain(title);
    expect(html).toContain(message);
    expect(html).not.toContain('database unavailable');
  });
});

describe('account activity bridge filters', () => {
  const window = { from: '2026-10-01', to: '2026-10-02' };

  async function read(query: Record<string, string | string[]> = window) {
    const page = await AccountActivityBridgePage({ searchParams: Promise.resolve(query) });
    const container = document.createElement('div');
    container.innerHTML = renderToStaticMarkup(page);
    return container;
  }

  it('submits the filter form', async () => {
    const container = await read();
    expect(container.querySelector('form button')?.getAttribute('type')).toBe('submit');
  });

  it('round-trips a browser-selected account/currency', async () => {
    const container = await read();
    const form = container.querySelector('form')!;
    const selection = form.querySelector<HTMLSelectElement>('[name="selection"]')!;
    selection.selectedIndex = 1;
    const query = Object.fromEntries(new FormData(form)) as Record<string, string>;
    const result = await read(query);
    expect(result.querySelector('tbody')?.textContent).toContain('CASH / USD');
    expect(result.querySelector('button[type="button"]')?.textContent).toContain('Export evidence');
  });

  it('refuses a requested branch outside the active organization scope', async () => {
    const result = await read({ ...window, branch: 'foreign_branch' });
    expect(result.textContent).toContain('Branch unavailable');
    expect(mocks.financialStatements).not.toHaveBeenCalled();
  });

  it('does not substitute another aggregate for an unrecognized selection', async () => {
    const result = await read({ ...window, selection: JSON.stringify(['CASH', 'EUR']) });
    expect(result.querySelector('tbody')).toBeNull();
    expect(result.textContent).not.toContain('Export evidence CSV');
    expect(result.querySelector<HTMLSelectElement>('[name="selection"]')?.value).toBe('');
    expect(result.textContent).toContain('No unique, complete aggregate');
  });

  it.each([undefined, { organizationId: 'other', branchId: 'branch_1' }])(
    'withholds evidence and export when the reader returns an unverified scope',
    async (scope) => {
      mocks.financialStatements.mockResolvedValue({ scope, accounts: [] });
      const result = await read();
      expect(result.textContent).toContain('Account activity unavailable');
      expect(result.textContent).not.toContain('Export evidence CSV');
    }
  );

  it.each(['branch', 'from', 'to', 'selection'])(
    'handles repeated %s query parameters without crashing or reading evidence',
    async (key) => {
      const result = await read({ ...window, [key]: ['first', 'second'] });
      expect(result.textContent).toContain('Invalid filters');
      expect(mocks.financialStatements).not.toHaveBeenCalled();
    }
  );

  it.each([
    [{ from: '2026-13-45', to: '2026-14-01' }, 'valid date window'],
    [{ from: '2026-02-30', to: '2026-03-05' }, 'valid date window'],
    [{ from: '2026-01-01', to: '2026-06-01' }, 'at most 92 days'],
  ])('explains an invalid date window %j without reading evidence', async (dates, message) => {
    const result = await read({ ...window, ...dates });
    expect(result.textContent).toContain('Invalid date window');
    expect(result.textContent).toContain(message);
    expect(mocks.financialStatements).not.toHaveBeenCalled();
  });
});
