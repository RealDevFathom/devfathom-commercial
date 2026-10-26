import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ lookup: vi.fn(), context: vi.fn(), actor: vi.fn() }));
vi.mock('@/lib/pharmacy/accounts/journal-entry-lookup', () => ({
  journalEntryLookupRouter: { createCaller: () => ({ lookup: mocks.lookup }) },
}));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: mocks.actor }));
vi.mock('@/server/trpc', () => ({ createTRPCContext: mocks.context }));

import JournalEntryLookupPage from './page';

const valid = {
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
  mocks.actor.mockResolvedValue({ session: {}, organization: {}, support: null });
  mocks.context.mockResolvedValue({});
  mocks.lookup.mockResolvedValue({ status: 'NOT_FOUND' });
});

describe('journal lookup page', () => {
  it('renders a preserved labeled GET form and performs no read initially or for invalid/repeated input', async () => {
    const initial = await html({});
    expect(initial).toContain('method="get"');
    expect(initial).toContain('action="/pharmacy/accounts/journal-entry-lookup"');
    expect(initial).toContain('Branch ID');
    expect(initial).toContain('Back to finance');
    await html({ ...valid, entryId: ['one', 'two'] });
    await html({ ...valid, unexpected: 'value' });
    expect(mocks.actor).not.toHaveBeenCalled();
    expect(mocks.context).not.toHaveBeenCalled();
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
        occurredAt: valid.from,
        reversesEntryId: '<reverse>',
        lines: [{ id: '<line>', accountCode: 'CASH', side: 'DEBIT', amountMinor: '10' }],
        debitMinor: '10',
        creditMinor: '0',
        differenceMinor: '10',
      },
    });
    const output = await html(valid);
    expect(mocks.lookup).toHaveBeenCalledWith(valid);
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
        occurredAt: valid.from,
        reversesEntryId: null,
        lines: [{ id: 'line-1', accountCode: 'CASH', side: 'DEBIT', amountMinor: '10' }],
        debitMinor: '10',
        creditMinor: '0',
        differenceMinor: '10',
      },
    });

    const output = await html({ ...valid, branchId: '  branch-1  ', entryId: '  entry-1  ' });

    expect(mocks.lookup).toHaveBeenCalledWith(valid);
    expect(output).toContain('value="branch-1"');
    expect(output).toContain('branch-1 · [');
    expect(output).not.toContain('  branch-1  ');
  });

  it.each([
    ['TRUNCATED', 'exceeds 200 lines'],
    ['INVALID_SOURCE', 'failed validation'],
    ['NOT_FOUND', 'No journal entry was found'],
  ])('renders the distinct %s state without stale details', async (status, copy) => {
    mocks.lookup.mockResolvedValue({ status });
    const output = await html(valid);
    expect(output).toContain(copy);
    expect(output).not.toContain('Authorized branch slice');
  });
});
