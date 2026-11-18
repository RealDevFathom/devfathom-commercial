import { renderToStaticMarkup } from 'react-dom/server';
import { TRPCError } from '@trpc/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  resolveTenantActor: vi.fn(),
  createTRPCContext: vi.fn(),
  aging: vi.fn(),
  payablesDrafts: vi.fn(),
  creditSetOffs: vi.fn(),
}));

vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: mocks.resolveTenantActor }));
vi.mock('@/server/trpc', () => ({ createTRPCContext: mocks.createTRPCContext }));
vi.mock('@/server/routers/pharmacy-ap-invoices', () => ({
  pharmacyApInvoicesRouter: {
    createCaller: () => ({
      aging: mocks.aging,
      payablesDrafts: mocks.payablesDrafts,
      creditSetOffs: mocks.creditSetOffs,
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
      scope: { organizationId: 'org_1', branchId: 'branch_1' },
      view,
      retrievedAt: new Date('2026-11-15T12:00:00.000Z'),
    });
    mocks.payablesDrafts.mockResolvedValue(emptyDrafts);
    mocks.creditSetOffs.mockResolvedValue({ scope, setOffs: [], retrievedAt: NOW });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders the query form without authenticating or reading', async () => {
    const output = await html({});
    expect(output).toContain('Supplier expense invoice aging');
    expect(output).toContain('Nothing has been read');
    expect(mocks.resolveTenantActor).not.toHaveBeenCalled();
    expect(mocks.aging).not.toHaveBeenCalled();
  });

  it('refuses a future as-of day before reading', async () => {
    expect(await html({ branch: 'branch_1', asOf: '2026-11-16' })).toContain('role="alert"');
    expect(mocks.resolveTenantActor).not.toHaveBeenCalled();
    expect(mocks.aging).not.toHaveBeenCalled();
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
});
