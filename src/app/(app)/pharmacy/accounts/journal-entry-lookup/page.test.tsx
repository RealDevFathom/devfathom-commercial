import { TRPCError } from '@trpc/server';
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

  it('associates field-level validation errors with the invalid inputs only', async () => {
    const output = await html({ ...valid, entryId: 'x'.repeat(129), to: valid.from });
    const input = (name: string) => {
      const marker = `id="journal-lookup-${name}"`;
      const at = output.indexOf(marker);
      if (at < 0) return '';
      const start = output.lastIndexOf('<input', at);
      const end = output.indexOf('>', at);
      return start < 0 || end < 0 ? '' : output.slice(start, end + 1);
    };
    expect(input('entryId')).toContain('aria-invalid="true"');
    expect(input('entryId')).toContain('aria-describedby="journal-lookup-entryId-error"');
    expect(output).toContain('id="journal-lookup-entryId-error"');
    expect(output).toContain('Use at most 128 characters.');
    expect(input('to')).toContain('aria-invalid="true"');
    expect(input('to')).toContain('aria-describedby="journal-lookup-to-error"');
    expect(output).toContain('Must be after From and no more than 92 days later.');
    expect(input('branchId')).not.toBe('');
    expect(input('branchId')).not.toContain('aria-invalid="true"');
    expect(input('branchId')).not.toContain('aria-describedby');
    expect(input('from')).not.toBe('');
    expect(input('from')).not.toContain('aria-invalid="true"');
    expect(input('from')).not.toContain('aria-describedby');
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

  it('accepts 1-character and punctuation-only IDs and performs the exact lookup', async () => {
    const query = { ...valid, branchId: '!', entryId: '.' };
    const output = await html(query);
    expect(mocks.lookup).toHaveBeenCalledWith(query);
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
});
