import { TRPCError } from '@trpc/server';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  lookup: vi.fn(),
  context: vi.fn(),
  actor: vi.fn(),
  branches: vi.fn(),
}));
vi.mock('@/lib/pharmacy/accounts/journal-entry-lookup', () => ({
  journalEntryLookupRouter: { createCaller: () => ({ lookup: mocks.lookup }) },
}));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: mocks.actor }));
vi.mock('@/server/trpc', () => ({ createTRPCContext: mocks.context }));

import JournalEntryLookupPage from './page';

// What the owner types: a date and a time on the organisation's clock.
const valid = {
  branchId: 'branch-1',
  entryId: 'entry-1',
  fromDate: '2026-08-01',
  fromTime: '00:00',
  toDate: '2026-08-02',
  toTime: '00:00',
};
// What the server receives for `valid` in a UTC organisation: the same instants as before.
const sent = {
  branchId: 'branch-1',
  entryId: 'entry-1',
  from: '2026-08-01T00:00:00Z',
  to: '2026-08-02T00:00:00Z',
};
async function html(query: Record<string, string | string[] | undefined>) {
  return renderToStaticMarkup(
    await JournalEntryLookupPage({ searchParams: Promise.resolve(query) })
  );
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.actor.mockResolvedValue({ session: {}, organization: { id: 'org-1' }, support: null });
  // DEV-103: the branch picker lists the owner's active branches through this context.
  mocks.context.mockResolvedValue({
    session: { user: { id: 'owner-1', role: 'ADMIN' } },
    db: { pharmacyBranch: { findMany: mocks.branches } },
  });
  mocks.branches.mockResolvedValue([
    { id: 'branch-1', name: 'Main Branch' },
    { id: 'branch-2', name: 'Gulshan Branch' },
  ]);
  mocks.lookup.mockResolvedValue({ status: 'NOT_FOUND' });
});

describe('journal lookup page', () => {
  // DEV-103: before a valid lookup, the only read is the branch picker's list of the owner's
  // branch names: one actor resolution and one branch list per render, never the lookup.
  const expectOnlyTheBranchList = (renders: number) => {
    expect(mocks.actor).toHaveBeenCalledTimes(renders);
    expect(mocks.context).toHaveBeenCalledTimes(renders);
    expect(mocks.branches).toHaveBeenCalledTimes(renders);
    expect(mocks.branches).toHaveBeenCalledWith({
      where: { organizationId: 'org-1', active: true },
      orderBy: { name: 'asc' },
      select: { id: true, name: true },
    });
    expect(mocks.lookup).not.toHaveBeenCalled();
  };

  it('renders a preserved labeled GET form and reads only the branch list initially or for invalid/repeated input', async () => {
    const initial = await html({});
    expect(initial).toContain('method="get"');
    expect(initial).toContain('action="/pharmacy/accounts/journal-entry-lookup"');
    expect(initial).toContain('<label for="journal-lookup-branchId">Branch</label>');
    expect(initial).toContain('Back to finance');
    await html({ ...valid, entryId: ['one', 'two'] });
    await html({ ...valid, unexpected: 'value' });
    expectOnlyTheBranchList(3);
  });

  describe('DEV-103 branch picker', () => {
    it('offers the active branches of the signed-in organization by name, not a typed ID', async () => {
      const output = await html({});
      expect(output).toMatch(/<select[^>]*id="journal-lookup-branchId"[^>]*name="branchId"/);
      expect(output).toContain('>Main Branch</option>');
      expect(output).toContain('>Gulshan Branch</option>');
      expect(output).not.toContain('Branch ID');
      expect(output).not.toMatch(/<input[^>]*name="branchId"/);
    });

    it('selects the requested branch', async () => {
      expect(await html(valid)).toMatch(/<option value="branch-1" selected="">/);
    });

    it('shows the prompt, not another branch, for an unlisted branch and leaves it to the router', async () => {
      mocks.lookup.mockRejectedValue(new TRPCError({ code: 'FORBIDDEN' }));
      const output = await html({ ...valid, branchId: 'branch-other' });
      expect(output).toContain('<option value="">Choose a branch</option>');
      expect(output).not.toMatch(/<option value="branch-[12]" selected/);
      expect(mocks.lookup).toHaveBeenCalledWith({ ...sent, branchId: 'branch-other' });
      expect(output).toContain('You do not have access to this financial report scope.');
    });

    it('offers no branches to someone who is not an owner', async () => {
      mocks.context.mockResolvedValue({
        session: { user: { id: 'u', role: 'EMPLOYEE' } },
        db: { pharmacyBranch: { findMany: mocks.branches } },
      });
      const output = await html({});
      expect(mocks.branches).not.toHaveBeenCalled();
      expect(output).not.toContain('Main Branch');
    });
  });

  it('associates field-level validation errors with the invalid inputs only', async () => {
    const output = await html({ ...valid, entryId: 'x'.repeat(129), fromTime: '25:00' });
    const input = (name: string) => {
      const marker = `id="journal-lookup-${name}"`;
      const at = output.indexOf(marker);
      if (at < 0) return '';
      // The branch is a picker (DEV-103); every other field is an input.
      const start = Math.max(output.lastIndexOf('<input', at), output.lastIndexOf('<select', at));
      const end = output.indexOf('>', at);
      return start < 0 || end < 0 ? '' : output.slice(start, end + 1);
    };
    expect(input('entryId')).toContain('aria-invalid="true"');
    expect(input('entryId')).toContain('aria-describedby="journal-lookup-entryId-error"');
    expect(output).toContain('id="journal-lookup-entryId-error"');
    expect(output).toContain('Use at most 128 characters.');
    expect(input('fromTime')).toContain('aria-invalid="true"');
    expect(input('fromTime')).toContain('aria-describedby="journal-lookup-fromTime-error"');
    expect(output).toContain('Choose a time.');
    expect(input('branchId')).not.toBe('');
    expect(input('branchId')).not.toContain('aria-invalid="true"');
    expect(input('branchId')).not.toContain('aria-describedby');
    expect(input('fromDate')).not.toBe('');
    expect(input('fromDate')).not.toContain('aria-invalid="true"');
    expect(input('fromDate')).not.toContain('aria-describedby');
    expect(mocks.lookup).not.toHaveBeenCalled();
  });

  it('wires the real server context to an exact lookup and renders escaped branch-slice detail', async () => {
    mocks.lookup.mockResolvedValue({
      status: 'FOUND',
      entry: {
        id: '<entry>',
        sourceKind: 'SALE',
        sourceId: '<source>',
        currency: 'PKR',
        occurredAt: sent.from,
        reversesEntryId: '<reverse>',
        lines: [{ id: '<line>', accountCode: 'CASH', side: 'DEBIT', amountMinor: '10' }],
        debitMinor: '10',
        creditMinor: '0',
        differenceMinor: '10',
      },
    });
    const output = await html(valid);
    expect(mocks.lookup).toHaveBeenCalledWith(sent);
    expect(output).toContain('&lt;source&gt;');
    expect(output).not.toContain('href="&lt;source&gt;"');
    expect(output).toContain('not a complete journal or global-balance assertion');
    expect(output).toContain('10 / 0 / 10');
  });

  it('renders the canonical IDs used by the lookup rather than padded query values', async () => {
    mocks.lookup.mockResolvedValue({
      status: 'FOUND',
      entry: {
        id: 'entry-1',
        sourceKind: 'SALE',
        sourceId: 'sale-1',
        currency: 'PKR',
        occurredAt: sent.from,
        reversesEntryId: null,
        lines: [{ id: 'line-1', accountCode: 'CASH', side: 'DEBIT', amountMinor: '10' }],
        debitMinor: '10',
        creditMinor: '0',
        differenceMinor: '10',
      },
    });

    const output = await html({ ...valid, branchId: '  branch-1  ', entryId: '  entry-1  ' });

    expect(mocks.lookup).toHaveBeenCalledWith(sent);
    expect(output).toContain('value="branch-1"');
    expect(output).toContain('<dd class="break-all">branch-1</dd>');
    expect(output).not.toContain('  branch-1  ');
  });

  it('accepts 1-character and punctuation-only IDs and performs the exact lookup', async () => {
    const output = await html({ ...valid, branchId: '!', entryId: '.' });
    expect(mocks.lookup).toHaveBeenCalledWith({ ...sent, branchId: '!', entryId: '.' });
    expect(output).not.toContain('aria-invalid="true"');
    expect(output).toContain('No journal entry was found');
  });

  it.each([
    ['FORBIDDEN', 'You do not have access to this financial report scope.'],
    ['UNAUTHORIZED', 'You do not have access to this financial report scope.'],
    ['INTERNAL_SERVER_ERROR', 'The journal lookup is unavailable.'],
  ] as const)('renders %s errors as a non-stale status', async (code, copy) => {
    mocks.lookup.mockRejectedValue(new TRPCError({ code }));
    const output = await html(valid);
    expect(output).toContain(copy);
    expect(output).toContain('role="alert"');
    expect(output).not.toContain('Authorized branch slice');
  });

  it('renders DENIED when no tenant actor resolves and FAILURE for unexpected errors', async () => {
    mocks.actor.mockResolvedValueOnce(null);
    expect(await html(valid)).toContain('You do not have access to this financial report scope.');
    mocks.context.mockRejectedValueOnce(new Error('db down'));
    const failure = await html(valid);
    expect(failure).toContain('The journal lookup is unavailable.');
    expect(failure).not.toContain('db down');
    expect(failure).not.toContain('Authorized branch slice');
  });

  it.each([
    ['TRUNCATED', 'exceeds 200 lines'],
    ['INVALID_SOURCE', 'could not be checked'],
    ['NOT_FOUND', 'No journal entry was found'],
  ])('renders the distinct %s state without stale details', async (status, copy) => {
    mocks.lookup.mockResolvedValue({ status });
    const output = await html(valid);
    expect(output).toContain(copy);
    expect(output).not.toContain('Authorized branch slice');
  });

  it('asks for a date and a time with normal pickers, never an ISO instant', async () => {
    const output = await html({});
    expect(output).toContain('type="date"');
    expect(output).toContain('type="time"');
    expect(output).toContain('Until time (not included)');
    expect(output).not.toMatch(/RFC3339|ISO|\+05:00|T09:00/);
  });

  it('reads the typed date and time on the Asia/Karachi clock and sends the same instant', async () => {
    mocks.actor.mockResolvedValue({
      session: {},
      organization: { timezone: 'Asia/Karachi' },
      support: null,
    });
    await html({ ...valid, fromDate: '2026-08-01', fromTime: '09:00', toTime: '17:30' });
    expect(mocks.lookup).toHaveBeenCalledWith({
      ...sent,
      from: '2026-08-01T04:00:00Z',
      to: '2026-08-02T12:30:00Z',
    });
  });

  it('keeps a Karachi day boundary on the previous UTC day', async () => {
    mocks.actor.mockResolvedValue({
      session: {},
      organization: { timezone: 'Asia/Karachi' },
      support: null,
    });
    mocks.lookup.mockResolvedValue({
      status: 'FOUND',
      entry: {
        id: 'entry-1',
        sourceKind: 'SALE',
        sourceId: 'sale-1',
        currency: 'PKR',
        occurredAt: '2026-07-31T19:30:00.000Z',
        reversesEntryId: null,
        lines: [{ id: 'line-1', accountCode: 'CASH', side: 'DEBIT', amountMinor: '10' }],
        debitMinor: '10',
        creditMinor: '0',
        differenceMinor: '10',
      },
    });
    const output = await html({
      ...valid,
      fromTime: '00:00',
      toDate: '2026-08-01',
      toTime: '23:59',
    });
    expect(mocks.lookup).toHaveBeenCalledWith({
      ...sent,
      from: '2026-07-31T19:00:00Z',
      to: '2026-08-01T18:59:00Z',
    });
    expect(output).toContain('1 Aug 2026, 12:30 AM PKT');
    expect(output).not.toContain('2026-07-31T19:30');
    expect(output).toContain(
      'From 1 Aug 2026, 12:00 AM PKT up to, but not including, 1 Aug 2026, 11:59 PM PKT'
    );
    expect(output).toContain('(PKT)');
  });

  it('refuses a window that ends before it starts or runs past 92 days, without a lookup', async () => {
    const backwards = await html({ ...valid, toDate: '2026-08-01', toTime: '00:00' });
    expect(backwards).toContain('Must be after the From date and time');
    expect(backwards).toContain('aria-describedby="journal-lookup-toDate-error"');
    await html({ ...valid, toDate: '2026-11-02', toTime: '00:01' });
    expect(mocks.lookup).not.toHaveBeenCalled();
    await html({ ...valid, toDate: '2026-11-01', toTime: '00:00' });
    expect(mocks.lookup).toHaveBeenCalledWith({ ...sent, to: '2026-11-01T00:00:00Z' });
  });

  it.each([
    ['fromDate', '2026-02-30', 'Choose a date.'],
    ['toDate', '01/08/2026', 'Choose a date.'],
    ['toTime', '9am', 'Choose a time.'],
  ])('refuses %s=%s with a plain message', async (name, value, message) => {
    const output = await html({ ...valid, [name]: value });
    expect(output).toContain(message);
    expect(output).toContain(`aria-describedby="journal-lookup-${name}-error"`);
    expectOnlyTheBranchList(1);
  });
});
