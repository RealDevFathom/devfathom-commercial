import { renderToStaticMarkup } from 'react-dom/server';
import { TRPCError } from '@trpc/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  resolveTenantActor: vi.fn(),
  createTRPCContext: vi.fn(),
  list: vi.fn(),
  branches: vi.fn(),
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
    mocks.createTRPCContext.mockResolvedValue({
      session: actor.session,
      db: { pharmacyBranch: { findMany: mocks.branches } },
    });
    mocks.branches.mockResolvedValue([
      { id: 'branch_1', name: 'Main Branch' },
      { id: 'branch_2', name: 'Gulshan Branch' },
    ]);
    mocks.list.mockResolvedValue({
      scope: { organizationId: 'org_1', branchId: 'branch_1' },
      vouchers: [voucher],
      retrievedAt: new Date('2026-11-15T00:00:00.000Z'),
    });
  });

  // DEV-103: the branch picker reads the owner's branch names, and nothing else, before a branch
  // is chosen: one actor resolution and one branch list, never the voucher register.
  const expectOnlyTheBranchList = () => {
    expect(mocks.resolveTenantActor).toHaveBeenCalledTimes(1);
    expect(mocks.branches).toHaveBeenCalledTimes(1);
    expect(mocks.branches).toHaveBeenCalledWith({
      where: { organizationId: 'org_1', active: true },
      orderBy: { name: 'asc' },
      select: { id: true, name: true },
    });
    expect(mocks.list).not.toHaveBeenCalled();
  };

  it('renders the catalog and branch control reading only the branch list', async () => {
    const output = await html({});
    expect(output).toContain('General journal vouchers');
    expect(output).toContain('No voucher has been read');
    expect(output).toContain('Non-trade accruals');
    expect(output).toContain('Operating expenses');
    expectOnlyTheBranchList();
  });

  it.each([{ branch: '' }, { branch: '   ' }, { branch: ['a', 'b'] }, { branch: 'x'.repeat(129) }])(
    'rejects an invalid branch before reading',
    async (query) => {
      expect(await html(query)).toContain('role="alert"');
      expectOnlyTheBranchList();
    }
  );

  describe('DEV-103 branch picker', () => {
    it('offers the active branches of the signed-in organization by name, not a typed ID', async () => {
      const output = await html({});
      expect(output).toContain('<select');
      expect(output).toContain('>Main Branch</option>');
      expect(output).toContain('>Gulshan Branch</option>');
      expect(output).not.toContain('Branch ID');
      expect(output).not.toMatch(/<input[^>]*name="branch"/);
    });

    it('selects the requested branch', async () => {
      expect(await html({ branch: 'branch_2' })).toMatch(/<option value="branch_2" selected="">/);
    });

    it('shows the prompt, not another branch, for an unlisted branch and leaves it to the router', async () => {
      mocks.list.mockRejectedValue(new TRPCError({ code: 'FORBIDDEN' }));
      const output = await html({ branch: 'branch_other' });
      expect(output).toContain('<option value="">Choose a branch</option>');
      expect(output).not.toMatch(/<option value="branch_[12]" selected/);
      expect(mocks.list).toHaveBeenCalledWith({ branchId: 'branch_other', take: 50 });
      expect(output).toContain('Journal vouchers unavailable');
    });

    it('offers no branches to someone who is not an owner', async () => {
      mocks.createTRPCContext.mockResolvedValue({
        session: { user: { id: 'u', organizationId: 'org_1', role: 'EMPLOYEE' } },
        db: { pharmacyBranch: { findMany: mocks.branches } },
      });
      const output = await html({});
      expect(mocks.branches).not.toHaveBeenCalled();
      expect(output).not.toContain('Main Branch');
    });
  });

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

  it('shows the voucher day on the organization clock', async () => {
    mocks.resolveTenantActor.mockResolvedValue({
      ...actor,
      organization: { id: 'org_1', timezone: 'Asia/Karachi' },
    });
    mocks.list.mockResolvedValue({
      scope: { organizationId: 'org_1', branchId: 'branch_1' },
      vouchers: [{ ...voucher, occurredAt: new Date('2026-11-10T20:00:00.000Z') }],
      retrievedAt: new Date('2026-11-15T00:00:00.000Z'),
    });
    const output = await html({ branch: 'branch_1' });
    // 20:00 UTC on the 10th is already the 11th, 01:00, in Karachi.
    expect(output).toContain('2026-11-11');
    expect(output).not.toContain('2026-11-10');
    expect(output).toContain('Date (PKT)');
  });
});
