import { renderToStaticMarkup } from 'react-dom/server';
import { TRPCError } from '@trpc/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  resolveTenantActor: vi.fn(),
  createTRPCContext: vi.fn(),
  aging: vi.fn(),
}));

vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: mocks.resolveTenantActor }));
vi.mock('@/server/trpc', () => ({ createTRPCContext: mocks.createTRPCContext }));
vi.mock('@/server/routers/pharmacy-ap-invoices', () => ({
  pharmacyApInvoicesRouter: { createCaller: () => ({ aging: mocks.aging }) },
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

  it('labels an incomplete bounded view as partial', async () => {
    mocks.aging.mockResolvedValue({
      scope: { organizationId: 'org_1', branchId: 'branch_1' },
      view: { ...view, complete: false },
      retrievedAt: new Date(),
    });
    const output = await html({ branch: 'branch_1' });
    expect(output).toContain('these totals are partial');
    expect(output).toContain('this view is incomplete');
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

  it('never declares the branch clear when a capped read found nothing open', async () => {
    mocks.aging.mockResolvedValue({
      scope: { organizationId: 'org_1', branchId: 'branch_1' },
      view: { ...view, complete: false, scannedInvoices: 1000, rows: [], totals: [] },
      retrievedAt: new Date(),
    });
    const output = await html({ branch: 'branch_1' });
    expect(output).toContain('Nothing outstanding in the invoices read');
    expect(output).toContain('later-due invoices may still be');
    expect(output).not.toContain('No supplier expense invoice for this branch was open');
    expect(output).not.toContain('Export aging CSV');
  });

  it.each(['FORBIDDEN', 'UNAUTHORIZED'] as const)(
    'maps a %s router refusal to the denial state',
    async (code) => {
      mocks.aging.mockRejectedValue(new TRPCError({ code }));
      const output = await html({ branch: 'branch_1' });
      expect(output).toContain('Aging unavailable');
      expect(output).not.toContain('AP-0001');
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
});
