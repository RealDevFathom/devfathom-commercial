import { renderToStaticMarkup } from 'react-dom/server';
import { TRPCError } from '@trpc/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  resolveTenantActor: vi.fn(),
  createTRPCContext: vi.fn(),
  list: vi.fn(),
}));

vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: mocks.resolveTenantActor }));
vi.mock('@/server/trpc', () => ({ createTRPCContext: mocks.createTRPCContext }));
vi.mock('@/server/routers/pharmacy-general-journal', () => ({
  pharmacyGeneralJournalRouter: { createCaller: () => ({ list: mocks.list }) },
}));

import GeneralJournalPage from './page';

const actor = {
  session: { user: { id: 'owner_1', organizationId: 'org_1', role: 'ADMIN' } },
  organization: { id: 'org_1' },
  support: null,
};

const voucher = {
  id: 'jv_1',
  reference: 'JV-0001',
  purpose: 'NONTRADE_OPERATING_ACCRUAL',
  status: 'POSTED',
  version: 2,
  currency: 'PKR',
  occurredAt: new Date('2026-11-10T09:00:00.000Z'),
  reason: 'Electricity accrual',
  evidenceReference: 'Bill 2026-11',
  journalEntryId: 'entry_1',
  reversalEntryId: null,
  lines: [
    { lineNumber: 1, accountCode: 'OPERATING_EXPENSE', side: 'DEBIT', amountMinor: 123_456 },
    { lineNumber: 2, accountCode: 'MANUAL_NONTRADE_ACCRUAL', side: 'CREDIT', amountMinor: 123_456 },
  ],
};

async function html(query: Record<string, string | string[] | undefined>) {
  return renderToStaticMarkup(await GeneralJournalPage({ searchParams: Promise.resolve(query) }));
}

describe('GeneralJournalPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveTenantActor.mockResolvedValue(actor);
    mocks.createTRPCContext.mockResolvedValue({ session: actor.session });
    mocks.list.mockResolvedValue({
      scope: { organizationId: 'org_1', branchId: 'branch_1' },
      vouchers: [voucher],
      retrievedAt: new Date('2026-11-15T00:00:00.000Z'),
    });
  });

  it('renders the catalog and branch control without authenticating or reading', async () => {
    const output = await html({});
    expect(output).toContain('General journal vouchers');
    expect(output).toContain('No voucher has been read');
    expect(output).toContain('Non-trade accruals');
    expect(output).toContain('Operating expenses');
    expect(mocks.resolveTenantActor).not.toHaveBeenCalled();
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it.each([{ branch: '' }, { branch: '   ' }, { branch: ['a', 'b'] }, { branch: 'x'.repeat(129) }])(
    'rejects an invalid branch before reading',
    async (query) => {
      expect(await html(query)).toContain('role="alert"');
      expect(mocks.resolveTenantActor).not.toHaveBeenCalled();
      expect(mocks.list).not.toHaveBeenCalled();
    }
  );

  it('lists the branch vouchers through the authorized caller', async () => {
    const output = await html({ branch: 'branch_1' });
    expect(mocks.list).toHaveBeenCalledWith({ branchId: 'branch_1', take: 50 });
    expect(output).toContain('JV-0001');
    expect(output).toContain('PKR 1234.56');
    expect(output).toContain('Bill 2026-11');
    expect(output).toContain('posted');
  });

  it('shows an empty register with an explanation', async () => {
    mocks.list.mockResolvedValue({
      scope: { organizationId: 'org_1', branchId: 'branch_1' },
      vouchers: [],
      retrievedAt: new Date(),
    });
    expect(await html({ branch: 'branch_1' })).toContain('No journal vouchers exist');
  });

  it('shows the denial state without data when there is no tenant actor', async () => {
    mocks.resolveTenantActor.mockResolvedValue(null);
    const output = await html({ branch: 'branch_1' });
    expect(output).toContain('Journal vouchers unavailable');
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it.each(['FORBIDDEN', 'UNAUTHORIZED'] as const)(
    'maps a %s router refusal to the denial state',
    async (code) => {
      mocks.list.mockRejectedValue(new TRPCError({ code }));
      const output = await html({ branch: 'branch_1' });
      expect(output).toContain('Journal vouchers unavailable');
      expect(output).not.toContain('JV-0001');
    }
  );

  it('refuses a response scoped to another organization or branch', async () => {
    mocks.list.mockResolvedValue({
      scope: { organizationId: 'org_2', branchId: 'branch_1' },
      vouchers: [voucher],
      retrievedAt: new Date(),
    });
    const output = await html({ branch: 'branch_1' });
    expect(output).toContain('could not be loaded');
    expect(output).not.toContain('JV-0001');
  });
});
