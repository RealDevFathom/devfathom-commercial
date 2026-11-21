import { renderToStaticMarkup } from 'react-dom/server';
import { TRPCError } from '@trpc/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  resolveTenantActor: vi.fn(),
  createTRPCContext: vi.fn(),
  aging: vi.fn(),
  payablesDrafts: vi.fn(),
  creditSetOffs: vi.fn(),
  reversalSearch: vi.fn(),
  reversalAccess: vi.fn(),
}));

vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: mocks.resolveTenantActor }));
vi.mock('@/server/trpc', () => ({ createTRPCContext: mocks.createTRPCContext }));
vi.mock('@/server/routers/pharmacy-ap-invoices', () => ({
  pharmacyApInvoicesRouter: {
    createCaller: () => ({
      aging: mocks.aging,
      payablesDrafts: mocks.payablesDrafts,
      creditSetOffs: mocks.creditSetOffs,
      reversalSearch: mocks.reversalSearch,
      reversalAccess: mocks.reversalAccess,
    }),
  },
}));

import { apAgingWindow, computeApAging } from '@/lib/pharmacy/accounts/ap-aging';
import ApAgingPage from './page';
import { parseAgingQuery } from './query';

const NOW = new Date('2026-11-15T12:00:00.000Z');
const actor = {
  session: { user: { id: 'owner_1', organizationId: 'org_1', role: 'ADMIN' } },
  organization: { id: 'org_1' },
  support: null,
};

const view = computeApAging(
  [
    {
      id: 'inv_1',
      reference: 'AP-0001',
      payeeName: 'K-Electric',
      supplierInvoiceRef: 'KE-11',
      invoiceDate: new Date('2026-08-01T00:00:00.000Z'),
      dueDate: new Date('2026-08-31T00:00:00.000Z'),
      amountMinor: 123_456,
      currency: 'PKR',
      status: 'POSTED',
      reversedAt: null,
      settlements: [
        {
          amountMinor: 23_456,
          paidAt: new Date('2026-09-01T00:00:00.000Z'),
          status: 'ACTIVE',
          reversedAt: null,
        },
      ],
    },
  ],
  apAgingWindow('2026-11-15', NOW),
  true
);

const scope = { organizationId: 'org_1', branchId: 'branch_1' };
const emptyDrafts = {
  scope,
  draftOnly: true,
  reminders: [],
  paymentDraft: null,
  setOffDraft: { lines: [], totalSetOffMinor: 0, unmatchedCreditMinor: 0 },
  openCredits: [],
  viewComplete: true,
  creditsComplete: true,
  retrievedAt: NOW,
};

async function html(query: Record<string, string | string[] | undefined>) {
  return renderToStaticMarkup(await ApAgingPage({ searchParams: Promise.resolve(query) }));
}

describe('parseAgingQuery', () => {
  it('defaults the as-of day to today and accepts a past day', () => {
    expect(parseAgingQuery({ branch: 'b' }, NOW)).toEqual({ branchId: 'b', asOf: '2026-11-15' });
    expect(parseAgingQuery({ branch: 'b', asOf: '2026-01-31' }, NOW)).toEqual({
      branchId: 'b',
      asOf: '2026-01-31',
    });
  });

  it.each([
    { branch: 'b', asOf: '2026-11-16' },
    { branch: 'b', asOf: 'yesterday' },
    { branch: 'b', asOf: ['2026-01-01', '2026-01-02'] },
    { branch: '' },
    { branch: ['a', 'b'] },
    { branch: 'x'.repeat(129) },
  ])('flags an invalid query %#', (query) => {
    expect(parseAgingQuery(query, NOW).invalid).toBe(true);
  });
});

describe('ApAgingPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    mocks.resolveTenantActor.mockResolvedValue(actor);
    mocks.createTRPCContext.mockResolvedValue({ session: actor.session });
    mocks.aging.mockResolvedValue({
      mayManageAccounts: true,
      scope: { organizationId: 'org_1', branchId: 'branch_1' },
      view,
      retrievedAt: new Date('2026-11-15T12:00:00.000Z'),
    });
    mocks.payablesDrafts.mockResolvedValue(emptyDrafts);
    mocks.creditSetOffs.mockResolvedValue({ scope, setOffs: [], retrievedAt: NOW });
    mocks.reversalSearch.mockResolvedValue({
      scope,
      invoices: [],
      hasOlder: false,
      hasNewer: false,
      older: null,
      newer: null,
      retrievedAt: NOW,
    });
    mocks.reversalAccess.mockResolvedValue({
      scope,
      actorId: 'owner_1',
      mayReverse: true,
      otherApprover: null,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows the aging to a view-only member and explains why payment entry is unavailable', async () => {
    mocks.aging.mockResolvedValue({
      scope: { organizationId: 'org_1', branchId: 'branch_1' },
      view,
      retrievedAt: NOW,
      mayManageAccounts: false,
    });
    const output = await html({ branch: 'branch_1' });
    expect(output).toContain('Outstanding by age');
    expect(output).toContain(
      'Ask your workspace owner for permission to manage pharmacy account transactions.'
    );
    expect(output).not.toContain('Record invoice');
  });
  it('renders the query form without authenticating or reading', async () => {
    const output = await html({});
    expect(output).toContain('Supplier expense invoice aging');
    expect(output).toContain('Nothing has been read');
    expect(mocks.aging).not.toHaveBeenCalled();
    expect(mocks.payablesDrafts).not.toHaveBeenCalled();
    expect(mocks.creditSetOffs).not.toHaveBeenCalled();
  });

  describe('DEV-103 branch picker', () => {
    const findMany = vi.fn();
    beforeEach(() => {
      findMany.mockReset();
      findMany.mockResolvedValue([
        { id: 'branch_1', name: 'Main Branch' },
        { id: 'branch_2', name: 'Gulshan Branch' },
      ]);
      mocks.createTRPCContext.mockResolvedValue({
        session: actor.session,
        db: { pharmacyBranch: { findMany } },
      });
    });

    it('lists only the active branches of the signed-in organization by name', async () => {
      const output = await html({});
      expect(findMany).toHaveBeenCalledWith({
        where: { organizationId: 'org_1', active: true },
        orderBy: { name: 'asc' },
        select: { id: true, name: true },
      });
      expect(output).toContain('<select');
      expect(output).toContain('Main Branch');
      expect(output).toContain('Gulshan Branch');
      expect(output).not.toMatch(/name="branch"[^>]*type="text"/);
    });

    it('selects the requested branch', async () => {
      expect(await html({ branch: 'branch_2' })).toMatch(
        /<option value="branch_2" selected=""[^>]*>Gulshan Branch|<option value="branch_2"[^>]*selected/
      );
    });

    it('shows the prompt, not another branch, when the URL names an unlisted branch', async () => {
      const output = await html({ branch: 'branch_other', asOf: '2026-11-15' });
      expect(output).toContain('<option value="">Choose a branch</option>');
      expect(output).not.toMatch(/<option value="branch_[12]"[^>]*selected/);
      expect(output).not.toMatch(/<option value=""[^>]*disabled/);
    });

    it('offers no branches to a non-owner and passes a typed branch to the router unchanged', async () => {
      mocks.createTRPCContext.mockResolvedValue({
        session: { user: { id: 'u', organizationId: 'org_1', role: 'STAFF' } },
        db: { pharmacyBranch: { findMany } },
      });
      mocks.aging.mockRejectedValue(new TRPCError({ code: 'FORBIDDEN' }));
      const output = await html({ branch: 'branch_other', asOf: '2026-11-15' });
      expect(findMany).not.toHaveBeenCalled();
      expect(mocks.aging).toHaveBeenCalledWith({ branchId: 'branch_other', asOf: '2026-11-15' });
      expect(output).toContain('Aging unavailable');
      expect(output).not.toContain('AP-0001');
    });
  });

  it('refuses a future as-of day before reading', async () => {
    expect(await html({ branch: 'branch_1', asOf: '2026-11-16' })).toContain('role="alert"');
    expect(mocks.aging).not.toHaveBeenCalled();
    expect(mocks.payablesDrafts).not.toHaveBeenCalled();
    expect(mocks.creditSetOffs).not.toHaveBeenCalled();
  });

  it('shows the aged rows, bucket totals and the CSV action from the same view', async () => {
    const output = await html({ branch: 'branch_1', asOf: '2026-11-15' });
    expect(mocks.aging).toHaveBeenCalledWith({ branchId: 'branch_1', asOf: '2026-11-15' });
    expect(output).toContain('AP-0001');
    expect(output).toContain('PKR 1234.56');
    expect(output).toContain('1000.00');
    expect(output).toContain('61–90 days');
    expect(output).toContain('Export aging CSV');
    expect(output).toContain('Totals cover every eligible');
  });

  it('never shows a partial total, list or export above the ceiling', async () => {
    mocks.aging.mockResolvedValue({
      mayManageAccounts: true,
      scope: { organizationId: 'org_1', branchId: 'branch_1' },
      view: { ...view, complete: false },
      retrievedAt: new Date(),
    });
    const output = await html({ branch: 'branch_1' });
    expect(output).toContain('Too many invoices to total');
    expect(output).toContain('no total is shown rather than a partial one');
    expect(output).toContain('Enter one payee');
    expect(output).not.toContain('partial.');
    expect(output).not.toContain('Outstanding by age');
    expect(output).not.toContain('AP-0001');
    expect(output).not.toContain('Export aging CSV');
    expect(output).not.toContain('Record payment');
    expect(output).not.toContain('Due-bill reminders');
  });

  it('narrows both reads to one payee when asked', async () => {
    await html({ branch: 'branch_1', payeeFilter: ' K-Electric ' });
    expect(mocks.aging).toHaveBeenCalledWith({
      branchId: 'branch_1',
      asOf: '2026-11-15',
      payeeFilter: 'K-Electric',
    });
    expect(mocks.payablesDrafts).toHaveBeenCalledWith({
      branchId: 'branch_1',
      asOf: '2026-11-15',
      payeeFilter: 'K-Electric',
    });
  });

  it('explains an empty view and offers no export', async () => {
    mocks.aging.mockResolvedValue({
      mayManageAccounts: true,
      scope: { organizationId: 'org_1', branchId: 'branch_1' },
      view: { ...view, rows: [], totals: [] },
      retrievedAt: new Date(),
    });
    const output = await html({ branch: 'branch_1' });
    expect(output).toContain('Nothing outstanding');
    expect(output).not.toContain('Export aging CSV');
  });

  it('never declares the branch clear when the view was refused for size', async () => {
    mocks.aging.mockResolvedValue({
      mayManageAccounts: true,
      scope: { organizationId: 'org_1', branchId: 'branch_1' },
      view: { ...view, complete: false, scannedInvoices: 10_001, rows: [], totals: [] },
      retrievedAt: new Date(),
    });
    const output = await html({ branch: 'branch_1' });
    expect(output).toContain('Too many invoices to total');
    expect(output).not.toContain('Nothing outstanding');
    expect(output).not.toContain('No supplier expense invoice for this branch was open');
    expect(output).not.toContain('Export aging CSV');
  });

  it('offers invoice and payment entry only after the branch was authorized and read', async () => {
    expect(await html({})).not.toContain('Record invoice');
    const output = await html({ branch: 'branch_1', asOf: '2026-11-15' });
    expect(output).toContain('Record a supplier expense invoice');
    expect(output).toContain('Record invoice');
    expect(output).toContain('Record a payment');
    expect(output).toContain('Record payment');
    expect(output).toMatch(/name="branchId" value="branch_1"/);
    expect(output).toMatch(/name="createKey" value="ap-invoice:[0-9a-f-]{36}"/);
    expect(output).toMatch(/name="commandKey" value="ap-payment:[0-9a-f-]{36}"/);
    // Only invoices open in this view are payment targets, with what each still owes.
    expect(output).toContain('<option value="inv_1">');
    expect(output).toContain('PKR 1000.00 outstanding');
  });

  it('asks for an invoice first when nothing is open to pay', async () => {
    mocks.aging.mockResolvedValue({
      mayManageAccounts: true,
      scope: { organizationId: 'org_1', branchId: 'branch_1' },
      view: { ...view, rows: [], totals: [] },
      retrievedAt: new Date(),
    });
    const output = await html({ branch: 'branch_1' });
    expect(output).toContain('Record invoice');
    expect(output).not.toContain('Record payment');
    expect(output).toContain('Record the invoice');
  });

  it.each(['FORBIDDEN', 'UNAUTHORIZED'] as const)(
    'maps a %s router refusal to the denial state',
    async (code) => {
      mocks.aging.mockRejectedValue(new TRPCError({ code }));
      const output = await html({ branch: 'branch_1' });
      expect(output).toContain('Aging unavailable');
      expect(output).not.toContain('AP-0001');
      expect(output).not.toContain('Record invoice');
      expect(output).not.toContain('Record payment');
    }
  );

  it('refuses a response scoped to another organization or branch', async () => {
    mocks.aging.mockResolvedValue({
      mayManageAccounts: true,
      scope: { organizationId: 'org_2', branchId: 'branch_1' },
      view,
      retrievedAt: new Date(),
    });
    const output = await html({ branch: 'branch_1' });
    expect(output).toContain('could not be loaded');
    expect(output).not.toContain('AP-0001');
  });

  describe('DEV-694 reminders, payment draft and credit-note set-off', () => {
    const drafts = {
      ...emptyDrafts,
      reminders: [
        {
          payeeKey: 'k-electric',
          payeeName: 'K-Electric',
          currency: 'PKR',
          overdueMinor: 100_000,
          overdueCount: 1,
          dueSoonMinor: 0,
          dueSoonCount: 0,
          oldestDueDate: '2026-08-31',
          maxDaysPastDue: 76,
        },
      ],
      setOffDraft: {
        lines: [
          {
            creditId: 'cr_1',
            creditReference: 'CN-77',
            invoiceId: 'inv_1',
            invoiceReference: 'AP-0001',
            dueDate: '2026-08-31',
            setOffMinor: 25_000,
          },
        ],
        totalSetOffMinor: 25_000,
        unmatchedCreditMinor: 0,
      },
      openCredits: [
        {
          creditId: 'cr_1',
          reference: 'CN-77',
          supplierName: 'K-Electric',
          remainingMinor: 25_000,
        },
      ],
    };
    const pending = {
      id: 'so_1',
      status: 'PENDING',
      amountMinor: 25_000,
      currency: 'PKR',
      note: null,
      requestedByUserId: 'clerk_1',
      requestedAt: NOW,
      decidedByUserId: null,
      decidedAt: null,
      rejectionReason: null,
      invoice: {
        id: 'inv_1',
        reference: 'AP-0001',
        payeeName: 'K-Electric',
        supplierInvoiceRef: 'KE-11',
      },
      credit: { id: 'cr_1', reference: 'CN-77', supplier: { name: 'K-Electric' } },
    };

    it('reads the drafts for the authorized branch and day and shows reminders', async () => {
      mocks.payablesDrafts.mockResolvedValue(drafts);
      const output = await html({ branch: 'branch_1', asOf: '2026-11-15' });
      expect(mocks.payablesDrafts).toHaveBeenCalledWith({
        branchId: 'branch_1',
        asOf: '2026-11-15',
      });
      expect(mocks.creditSetOffs).toHaveBeenCalledWith({ branchId: 'branch_1', status: 'PENDING' });
      expect(output).toContain('Due-bill reminders');
      expect(output).toContain('Overdue');
      expect(output).toContain('PKR 1000.00 (1)');
      expect(output).toContain('Credit set off');
    });

    it('asks the server for a payment draft only for a valid payee and budget', async () => {
      await html({ branch: 'branch_1', payee: 'K-Electric', budget: 'abc' });
      expect(mocks.payablesDrafts).toHaveBeenLastCalledWith({
        branchId: 'branch_1',
        asOf: '2026-11-15',
      });
      mocks.payablesDrafts.mockResolvedValue({
        ...drafts,
        paymentDraft: {
          payeeKey: 'k-electric',
          currency: 'PKR',
          budgetMinor: 50_000,
          allocatedMinor: 50_000,
          remainingBudgetMinor: 0,
          lines: [
            {
              invoiceId: 'inv_1',
              reference: 'AP-0001',
              dueDate: '2026-08-31',
              currency: 'PKR',
              outstandingMinor: 100_000,
              payMinor: 50_000,
            },
          ],
        },
      });
      const output = await html({ branch: 'branch_1', payee: 'K-Electric', budget: '500' });
      expect(mocks.payablesDrafts).toHaveBeenLastCalledWith({
        branchId: 'branch_1',
        asOf: '2026-11-15',
        payee: { name: 'K-Electric', currency: 'PKR', budgetMinor: 50_000 },
      });
      expect(output).toContain('Payment draft');
      expect(output).toContain('PKR 500.00 of 500.00 drafted');
    });

    it('lets staff choose the bill and shows requests awaiting a manager PIN', async () => {
      mocks.payablesDrafts.mockResolvedValue(drafts);
      mocks.creditSetOffs.mockResolvedValue({ scope, setOffs: [pending], retrievedAt: NOW });
      const output = await html({ branch: 'branch_1', asOf: '2026-11-15' });
      expect(output).toContain('Suggested, oldest credit against oldest due bill');
      expect(output).toContain('Request set-off');
      expect(output).toMatch(/name="requestKey" value="ap-set-off:[0-9a-f-]{36}"/);
      expect(output).toContain('CN-77 · K-Electric · PKR 250.00 left');
      expect(output).toContain('Set-offs awaiting approval');
      expect(output).toContain('CN-77 against AP-0001');
      expect(output).toContain('Your manager or owner PIN');
      expect(output).toMatch(/<input[^>]*name="pin"[^>]*>/);
      expect(output.match(/<input[^>]*name="pin"[^>]*>/)![0]).toContain('type="password"');
      expect(output).toContain('Approve set-off');
      expect(output).toContain('Reason to reject');
    });

    it('lists approved set-offs with a PIN-gated reverse form', async () => {
      mocks.payablesDrafts.mockResolvedValue(drafts);
      mocks.creditSetOffs.mockImplementation(async ({ status }: { status: string }) => ({
        scope,
        setOffs: status === 'APPROVED' ? [{ ...pending, status: 'APPROVED' }] : [],
        retrievedAt: NOW,
      }));
      const output = await html({ branch: 'branch_1', asOf: '2026-11-15' });
      expect(mocks.creditSetOffs).toHaveBeenCalledWith({
        branchId: 'branch_1',
        status: 'APPROVED',
      });
      expect(output).toContain('Approved set-offs');
      expect(output).toContain('No set-off is waiting for approval.');
      expect(output).toContain('Reverse set-off');
      expect(output).toContain('Reason to reverse');
      expect(output).toMatch(/name="commandKey" value="ap-set-off-rev:[0-9a-f-]{36}"/);
    });

    it('keeps the aging when the drafts cannot be read, and says so', async () => {
      mocks.payablesDrafts.mockRejectedValue(new Error('boom'));
      const output = await html({ branch: 'branch_1' });
      expect(output).toContain('AP-0001');
      expect(output).toContain('Reminders and drafts could not be loaded');
      expect(output).not.toContain('Request set-off');
    });

    it('refuses drafts scoped to another branch', async () => {
      mocks.payablesDrafts.mockResolvedValue({ ...drafts, scope: { ...scope, branchId: 'b2' } });
      const output = await html({ branch: 'branch_1' });
      expect(output).toContain('Reminders and drafts could not be loaded');
      expect(output).not.toContain('Oldest due');
      expect(output).not.toContain('Request set-off');
    });
  });
  describe('DEV-103 reversal of an invoice or payment', () => {
    const posted = (overrides: Record<string, unknown> = {}) => ({
      id: 'inv_1',
      reference: 'AP-0001',
      payeeName: 'K-Electric',
      supplierInvoiceRef: 'KE-11',
      invoiceDate: new Date('2026-08-01T00:00:00.000Z'),
      amountMinor: 123_456,
      currency: 'PKR',
      status: 'POSTED',
      createdByUserId: 'clerk_1',
      settlements: [
        {
          id: 'set_1',
          amountMinor: 23_456,
          paidAt: new Date('2026-09-01T00:00:00.000Z'),
          fundingAccount: 'BANK',
          status: 'ACTIVE',
          createdByUserId: 'clerk_1',
        },
        {
          id: 'set_0',
          amountMinor: 5_000,
          paidAt: new Date('2026-08-20T00:00:00.000Z'),
          fundingAccount: 'CASH',
          status: 'REVERSED',
          createdByUserId: 'clerk_1',
        },
      ],
      ...overrides,
    });

    it('reads the first page of posted invoices of the authorized branch through the search', async () => {
      await html({ branch: 'branch_1', asOf: '2026-11-15' });
      expect(mocks.reversalSearch).toHaveBeenCalledWith({ branchId: 'branch_1' });
      expect(mocks.reversalAccess).toHaveBeenCalledWith({ branchId: 'branch_1' });
    });

    describe('DEV-103 search and paging', () => {
      const searchQuery = {
        branch: 'branch_1',
        asOf: '2026-11-15',
        rvPayee: ' K-Electric ',
        rvRef: 'KE-11',
        rvAmount: '234.56',
        rvFrom: '2026-08-01',
        rvTo: '2026-09-30',
        rvOlder: '2026-09-02T00:00:00.000Z~inv_9',
      };
      const older = { invoiceDate: '2026-08-20T00:00:00.000Z', id: 'inv_40' };
      const newer = { invoiceDate: '2026-09-01T00:00:00.000Z', id: 'inv_10' };

      it('sends every filter to the server, the typed amount in exact minor units', async () => {
        await html(searchQuery);
        expect(mocks.reversalSearch).toHaveBeenCalledWith({
          branchId: 'branch_1',
          payee: 'K-Electric',
          reference: 'KE-11',
          amountMinor: 23_456,
          from: '2026-08-01',
          to: '2026-09-30',
          older: { invoiceDate: '2026-09-02T00:00:00.000Z', id: 'inv_9' },
        });
      });

      it('DEV-967 turns back toward the newest with a newer cursor', async () => {
        await html({
          branch: 'branch_1',
          asOf: '2026-11-15',
          rvNewer: '2026-09-02T00:00:00.000Z~inv_9',
        });
        expect(mocks.reversalSearch).toHaveBeenCalledWith({
          branchId: 'branch_1',
          newer: { invoiceDate: '2026-09-02T00:00:00.000Z', id: 'inv_9' },
        });
      });

      it.each([
        [{ rvAmount: '12.345' }, 'Use at most 2 decimal places'],
        [{ rvAmount: '-5' }, 'Enter an amount of 0 or more.'],
        [{ rvAmount: '1,000' }, 'Enter an amount using digits'],
        [{ rvAmount: '0' }, 'Enter an amount above 0'],
        [{ rvAmount: '10000000' }, 'Enter an amount above 0'],
        [{ rvFrom: '2026-02-30' }, 'Choose a date.'],
        [{ rvFrom: '2026-09-01', rvTo: '2026-08-01' }, 'Choose a day on or after the from day.'],
        [{ rvPayee: ['a', 'b'] }, 'Enter this only once.'],
      ])('refuses %o without searching and names the field', async (bad, message) => {
        const output = await html({ branch: 'branch_1', asOf: '2026-11-15', ...bad });
        expect(mocks.reversalSearch).not.toHaveBeenCalled();
        expect(output).toContain(message);
        expect(output).toContain('aria-invalid="true"');
        expect(output).toContain('Fix the search above. Nothing was searched.');
        expect(output).not.toContain('Reverse payment');
      });

      it('keeps the search and the aging request in the form and in the page links', async () => {
        mocks.reversalSearch.mockResolvedValue({
          scope,
          invoices: [posted({ settlements: [] })],
          hasOlder: true,
          hasNewer: true,
          older,
          newer,
          retrievedAt: NOW,
        });
        const output = await html({ ...searchQuery, payeeFilter: 'K-Electric' });
        expect(output).toContain('role="search"');
        expect(output).toMatch(
          /name="rvAmount"[^>]*value="234.56"|value="234.56"[^>]*name="rvAmount"/
        );
        expect(output).toContain('<input type="hidden" name="branch" value="branch_1"/>');
        expect(output).toContain('<input type="hidden" name="payeeFilter" value="K-Electric"/>');
        const link = (page: string) =>
          `/pharmacy/accounts/ap-aging?branch=branch_1&amp;asOf=2026-11-15&amp;payeeFilter=K-Electric&amp;rvPayee=K-Electric&amp;rvRef=KE-11&amp;rvAmount=234.56&amp;rvFrom=2026-08-01&amp;rvTo=2026-09-30${page}#reverse`;
        // DEV-967: each link keeps the search and names the row its page starts after, never a
        // page number.
        expect(output).toContain(
          `href="${link('&amp;rvNewer=2026-09-01T00%3A00%3A00.000Z%7Einv_10')}"`
        );
        expect(output).toContain(
          `href="${link('&amp;rvOlder=2026-08-20T00%3A00%3A00.000Z%7Einv_40')}"`
        );
        expect(output).toContain('Newer invoices');
        expect(output).toContain('Older invoices');
        expect(output).not.toContain('rvPage');
      });

      it('offers no older page on the last page and explains an empty search', async () => {
        mocks.reversalSearch.mockResolvedValue({
          scope,
          invoices: [],
          hasOlder: false,
          hasNewer: false,
          older: null,
          newer: null,
          retrievedAt: NOW,
        });
        const output = await html({ branch: 'branch_1', asOf: '2026-11-15', rvRef: 'nothing' });
        expect(output).toContain('matches this search. Change or clear the search.');
        expect(output).not.toContain('Older invoices');
        expect(output).not.toContain('Newer invoices');
        expect(output).not.toContain('Newest invoices');
      });

      it('DEV-967 offers an older link however deep the page, with no depth wall', async () => {
        mocks.reversalSearch.mockResolvedValue({
          scope,
          invoices: [posted({ settlements: [] })],
          hasOlder: true,
          hasNewer: true,
          older,
          newer,
          retrievedAt: NOW,
        });
        const output = await html({
          branch: 'branch_1',
          asOf: '2026-11-15',
          rvOlder: '2016-01-01T00:00:00.000Z~inv_99999',
        });
        expect(output).toContain('Older invoices</a>');
        expect(output).toContain('rvOlder=2026-08-20T00%3A00%3A00.000Z%7Einv_40');
        expect(output).not.toContain('Narrow the search to reach them');
        expect(output).toContain('Newer invoices');
      });

      it('DEV-967 links an emptied turned page back to the newest page', async () => {
        const output = await html({
          branch: 'branch_1',
          asOf: '2026-11-15',
          rvOlder: '2026-09-02T00:00:00.000Z~inv_9',
        });
        expect(output).toContain('No more posted supplier expense invoices on this branch.');
        expect(output).toContain(
          'href="/pharmacy/accounts/ap-aging?branch=branch_1&amp;asOf=2026-11-15#reverse"'
        );
        expect(output).toContain('Newest invoices');
        expect(output).not.toContain('Older invoices');
      });

      it.each([
        [{ rvPage: '99999' }],
        [{ rvPage: '2' }],
        [{ rvOlder: 'garbage' }],
        [{ rvOlder: '2026-09-02~inv_9' }],
        [{ rvOlder: '2026-02-30T00:00:00.000Z~inv_9' }],
        [{ rvOlder: '2026-09-02T00:00:00.000Z~' }],
        [{ rvOlder: `2026-09-02T00:00:00.000Z~${'x'.repeat(129)}` }],
        [{ rvOlder: '2026-09-02T00:00:00.000Z~ inv_9' }],
        [{ rvOlder: ['2026-09-02T00:00:00.000Z~inv_9', '2026-09-01T00:00:00.000Z~inv_8'] }],
        [{ rvOlder: '2026-09-02T00:00:00.000Z~inv_9', rvNewer: '2026-09-02T00:00:00.000Z~inv_9' }],
      ])('ignores a malformed page %o and starts from the newest', async (bad) => {
        await html({ branch: 'branch_1', asOf: '2026-11-15', ...bad } as never);
        expect(mocks.reversalSearch).toHaveBeenCalledWith({ branchId: 'branch_1' });
      });
    });

    it('offers the payment still in force for reversal, and the invoice only after it', async () => {
      mocks.reversalSearch.mockResolvedValue({ scope, invoices: [posted()], retrievedAt: NOW });
      const output = await html({ branch: 'branch_1', asOf: '2026-11-15' });
      expect(output).toContain('Reverse an invoice or payment');
      expect(output).toContain('Reverse payment');
      expect(output).toMatch(/name="settlementId" value="set_1"/);
      expect(output).not.toMatch(/name="settlementId" value="set_0"/);
      expect(output).toMatch(/name="commandKey" value="ap-payment-rev:[0-9a-f-]{36}"/);
      expect(output).toContain('Reverse its payment first to reverse this invoice.');
      expect(output).not.toContain('Reverse invoice');
      expect(output).toContain('Your manager or owner PIN');
    });

    it('offers the invoice once nothing settles it', async () => {
      mocks.reversalSearch.mockResolvedValue({
        scope,
        invoices: [posted({ settlements: [] })],
        retrievedAt: NOW,
      });
      const output = await html({ branch: 'branch_1', asOf: '2026-11-15' });
      expect(output).toContain('Reverse invoice');
      expect(output).toMatch(/name="invoiceId" value="inv_1"/);
      expect(output).toMatch(/name="commandKey" value="ap-invoice-rev:[0-9a-f-]{36}"/);
    });

    it('sends an entry you recorded to the other manager instead of showing a form', async () => {
      mocks.reversalSearch.mockResolvedValue({
        scope,
        invoices: [posted({ settlements: [], createdByUserId: 'owner_1' })],
        retrievedAt: NOW,
      });
      mocks.reversalAccess.mockResolvedValue({
        scope,
        actorId: 'owner_1',
        mayReverse: true,
        otherApprover: { name: 'Hina' },
      });
      const output = await html({ branch: 'branch_1', asOf: '2026-11-15' });
      expect(output).toContain('You recorded this, so Hina or another manager or owner');
      expect(output).not.toContain('Reverse invoice');
    });

    it('lets a solo owner reverse what they recorded', async () => {
      mocks.reversalSearch.mockResolvedValue({
        scope,
        invoices: [posted({ settlements: [], createdByUserId: 'owner_1' })],
        retrievedAt: NOW,
      });
      const output = await html({ branch: 'branch_1', asOf: '2026-11-15' });
      expect(output).toContain('Reverse invoice');
    });

    it('shows no reversal form to someone who is not a manager or owner', async () => {
      mocks.reversalSearch.mockResolvedValue({ scope, invoices: [posted()], retrievedAt: NOW });
      mocks.reversalAccess.mockResolvedValue({
        scope,
        actorId: 'owner_1',
        mayReverse: false,
        otherApprover: null,
      });
      const output = await html({ branch: 'branch_1', asOf: '2026-11-15' });
      expect(output).toContain('Only a manager or owner can reverse');
      expect(output).not.toContain('Reverse payment');
      expect(output).not.toContain('Reverse invoice');
    });

    it('keeps the aging when the reversal list cannot be read, and refuses another branch', async () => {
      mocks.reversalSearch.mockRejectedValue(new Error('boom'));
      let output = await html({ branch: 'branch_1', asOf: '2026-11-15' });
      expect(output).toContain('AP-0001');
      expect(output).toContain('Reversals could not be loaded');
      mocks.reversalSearch.mockResolvedValue({
        scope: { ...scope, branchId: 'b2' },
        invoices: [posted()],
        retrievedAt: NOW,
      });
      output = await html({ branch: 'branch_1', asOf: '2026-11-15' });
      expect(output).toContain('Reversals could not be loaded');
      expect(output).not.toContain('Reverse payment');
    });

    it('explains an empty list', async () => {
      const output = await html({ branch: 'branch_1', asOf: '2026-11-15' });
      expect(output).toContain('No posted supplier expense invoice on this branch to reverse.');
    });
  });
});
