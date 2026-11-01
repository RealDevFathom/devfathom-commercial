import { cleanup, render, screen } from '@testing-library/react';
import { Children, isValidElement, type ReactNode } from 'react';
import { TRPCError } from '@trpc/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  resolveTenantActor: vi.fn(),
  createTRPCContext: vi.fn(),
  createCaller: vi.fn(),
  redirect: vi.fn(),
  jar: new Map<string, string>(),
}));

vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: mocks.resolveTenantActor }));
vi.mock('@/server/trpc', () => ({ createTRPCContext: mocks.createTRPCContext }));
vi.mock('@/server/routers/pharmacy-general-journal', () => ({ pharmacyGeneralJournalRouter: { createCaller: mocks.createCaller } }));
vi.mock('next/navigation', () => ({ redirect: mocks.redirect }));
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => (mocks.jar.has(name) ? { name, value: mocks.jar.get(name)! } : undefined),
    set: (name: string, value: string) => { mocks.jar.set(name, value); },
    delete: (name: string | { name: string }) => { mocks.jar.delete(typeof name === 'string' ? name : name.name); },
  }),
}));

import GeneralJournalPage from './page';
import { encodeRetained } from './retry-store';

const actor = {
  session: { user: { id: 'user-1' } },
  organization: { id: 'org-1', slug: 'shop' },
  support: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.jar.clear();
  mocks.redirect.mockImplementation(() => { throw new Error('NEXT_REDIRECT'); });
  mocks.createTRPCContext.mockResolvedValue({ session: actor.session, organization: actor.organization });
  mocks.createCaller.mockReturnValue({
    branches: vi.fn().mockResolvedValue([{ id: 'branch-1', name: 'Main branch' }]),
    list: vi.fn().mockResolvedValue([]),
  });
});

describe('general journal page admission', () => {
  it('renders a denial without touching protected data when no tenant actor resolves', async () => {
    mocks.resolveTenantActor.mockResolvedValue(null);
    render(await GeneralJournalPage({ searchParams: Promise.resolve({}) }));
    expect(screen.getByText('Permission denied')).toBeDefined();
    expect(mocks.createTRPCContext).not.toHaveBeenCalled();
    expect(mocks.createCaller).not.toHaveBeenCalled();
  });

  it('passes the prefixless request actor to context and loads through the real router surface', async () => {
    mocks.resolveTenantActor.mockResolvedValue(actor);
    render(await GeneralJournalPage({ searchParams: Promise.resolve({}) }));
    expect(mocks.createTRPCContext).toHaveBeenCalledWith({ session: actor.session, organization: actor.organization, support: null });
    expect(screen.getByRole('heading', { name: 'General journal' })).toBeDefined();
    expect(screen.getByText('No vouchers have been saved for this branch.')).toBeDefined();
  });
});

const at = new Date('2026-10-25T12:00:00Z');
const document = { id: 'doc-1', branchId: 'branch-1', reference: 'USD-1', status: 'DRAFT', amountMinor: 12345, currency: 'USD', occurredAt: at, evidence: 'invoice', reason: 'accrual', version: 1 };

function serverAction(node: ReactNode): ((form: FormData) => Promise<void>) | undefined {
  for (const child of Children.toArray(node)) {
    if (!isValidElement<{ action?: unknown; children?: ReactNode }>(child)) continue;
    if (typeof child.props.action === 'function') return child.props.action as (form: FormData) => Promise<void>;
    const action = serverAction(child.props.children);
    if (action) return action;
  }
}

describe('general journal commands', () => {
  function caller() {
    const value = {
      branches: vi.fn().mockResolvedValue([{ id: 'branch-1', name: 'Main branch' }]),
      list: vi.fn().mockResolvedValue([document, { ...document, id: 'doc-2', reference: 'Posted', status: 'POSTED' }]),
      updateDraft: vi.fn().mockResolvedValue(document),
      createDraft: vi.fn().mockResolvedValue(document),
      post: vi.fn().mockResolvedValue({ ...document, status: 'POSTED' }),
      reverse: vi.fn().mockResolvedValue({ ...document, status: 'REVERSED' }),
    };
    mocks.resolveTenantActor.mockResolvedValue(actor);
    mocks.createCaller.mockReturnValue(value);
    return value;
  }

  it('renders every voucher command as a submit button', async () => {
    caller();
    render(await GeneralJournalPage({ searchParams: Promise.resolve({}) }));
    for (const name of ['Save draft', 'Save changes', 'Post', 'Cancel', 'Reverse']) {
      expect(screen.getByRole('button', { name }).getAttribute('type')).toBe('submit');
    }
  });

  it('shows and preserves a USD draft currency when saving changes', async () => {
    const api = caller();
    const page = await GeneralJournalPage({ searchParams: Promise.resolve({}) });
    render(page);
    expect(screen.getAllByText(/USD 123\.45/)).toHaveLength(2);
    expect(screen.getByLabelText('Amount (USD)')).toBeDefined();
    const button = screen.getByRole('button', { name: 'Save changes' }) as HTMLButtonElement;
    const form = new FormData(button.form!);
    form.set('action', button.value);
    await expect(serverAction(page)!(form)).rejects.toThrow('NEXT_REDIRECT');
    expect(api.updateDraft).toHaveBeenCalledWith(expect.objectContaining({ documentId: 'doc-1', currency: 'USD', amountMinor: 12345 }));
  });

  it.each([
    ['Save draft', 'createDraft'],
    ['Post', 'post'],
    ['Reverse', 'reverse'],
  ] as const)('retries %s with the original command after a lost response', async (name, method) => {
    const api = caller();
    api[method].mockRejectedValueOnce(new Error('response lost'));
    const page = await GeneralJournalPage({ searchParams: Promise.resolve({}) });
    render(page);
    const button = screen.getByRole('button', { name }) as HTMLButtonElement;
    const form = new FormData(button.form!);
    form.set('action', button.value);
    form.set('reversalReason', 'Correct the accrual');
    if (method === 'createDraft') {
      form.set('reference', 'JV-RETRY');
      form.set('amount', '12.34');
      form.set('evidence', 'invoice');
      form.set('reason', 'accrual');
    }
    const key = form.get('idempotencyKey');
    expect(key).toEqual(expect.any(String));
    expect(String(key).length).toBeGreaterThan(0);
    vi.useFakeTimers();
    try {
      await expect(serverAction(page)!(form)).rejects.toThrow('NEXT_REDIRECT');
      vi.setSystemTime(new Date('2026-11-01T12:00:00Z'));
      await expect(serverAction(page)!(form)).rejects.toThrow('NEXT_REDIRECT');
      expect(api[method]).toHaveBeenCalledTimes(2);
      expect(api[method].mock.calls[0]).toEqual(api[method].mock.calls[1]);
      expect(api[method]).toHaveBeenLastCalledWith(expect.objectContaining({ idempotencyKey: key }));
      if (method === 'reverse') {
        expect(api.reverse).toHaveBeenLastCalledWith(expect.objectContaining({ at: new Date(`${String(form.get('reversalDate'))}T12:00:00Z`) }));
      }
      expect(mocks.redirect.mock.calls[1][0]).toContain('kind=success');
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(['INTERNAL_SERVER_ERROR', 'BAD_REQUEST', 'CONFLICT'] as const)('keeps raw %s messages out of redirect notices', async (code) => {
    const api = caller();
    api.updateDraft.mockRejectedValue(new TRPCError({ code, message: 'Invalid prisma invocation: Unique constraint secret_table' }));
    const page = await GeneralJournalPage({ searchParams: Promise.resolve({}) });
    const form = new FormData();
    form.set('action', 'update');
    form.set('branchId', 'branch-1');
    await expect(serverAction(page)!(form)).rejects.toThrow('NEXT_REDIRECT');
    const url = mocks.redirect.mock.calls[0][0] as string;
    expect(url).toContain('kind=error');
    expect(decodeURIComponent(url)).not.toMatch(/prisma|constraint|secret_table/i);
    expect(mocks.redirect).toHaveBeenCalledTimes(1);
  });

  it('renders empty-branch and failed-load states', async () => {
    const api = caller();
    api.branches.mockResolvedValueOnce([]);
    const { unmount } = render(await GeneralJournalPage({ searchParams: Promise.resolve({}) }));
    expect(screen.getByText('No active branch')).toBeDefined();
    unmount();
    api.list.mockRejectedValueOnce(new Error('database unavailable'));
    render(await GeneralJournalPage({ searchParams: Promise.resolve({}) }));
    expect(screen.getByText('General journal unavailable')).toBeDefined();
  });

  it('defaults the reversal to an editable accounting date that satisfies the voucher chronology', async () => {
    const api = caller();
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      // 03:00 UTC on the voucher day: a render-time instant would precede the noon-UTC voucher date.
      vi.setSystemTime(new Date('2026-10-25T03:00:00Z'));
      const page = await GeneralJournalPage({ searchParams: Promise.resolve({}) });
      render(page);
      const input = screen.getByLabelText('Reversal date') as HTMLInputElement;
      expect(input.type).toBe('date');
      expect(input.value).toBe('2026-10-25');
      expect(input.min).toBe('2026-10-25');
      const button = screen.getByRole('button', { name: 'Reverse' }) as HTMLButtonElement;
      const form = new FormData(button.form!);
      form.set('action', button.value);
      form.set('reversalReason', 'Correct the accrual');
      form.set('reversalDate', '2026-10-27');
      await expect(serverAction(page)!(form)).rejects.toThrow('NEXT_REDIRECT');
      expect(api.reverse).toHaveBeenCalledWith(expect.objectContaining({ documentId: 'doc-2', at: new Date('2026-10-27T12:00:00Z') }));
    } finally {
      vi.useRealTimers();
    }
  });

  it('defaults a future-dated voucher reversal to the voucher date', async () => {
    const api = caller();
    api.list.mockResolvedValue([{ ...document, id: 'doc-2', status: 'POSTED', occurredAt: new Date('2099-01-05T12:00:00Z') }]);
    render(await GeneralJournalPage({ searchParams: Promise.resolve({}) }));
    expect((screen.getByLabelText('Reversal date') as HTMLInputElement).value).toBe('2099-01-05');
  });

  it('preserves a failed new draft and its request key with an actionable error', async () => {
    const api = caller();
    api.createDraft.mockRejectedValue(new TRPCError({ code: 'CONFLICT', message: 'A voucher with this reference or request key already exists.' }));
    const page = await GeneralJournalPage({ searchParams: Promise.resolve({}) });
    render(page);
    const button = screen.getByRole('button', { name: 'Save draft' }) as HTMLButtonElement;
    const form = new FormData(button.form!);
    form.set('action', button.value);
    form.set('reference', 'JV-DUP');
    form.set('amount', '45.60');
    form.set('occurredAt', '2026-10-20');
    form.set('evidence', 'invoice 7');
    form.set('reason', 'utility accrual');
    await expect(serverAction(page)!(form)).rejects.toThrow('NEXT_REDIRECT');
    const url = new URL(mocks.redirect.mock.calls[0][0] as string, 'https://tenant.test');
    expect(url.searchParams.get('kind')).toBe('error');
    expect(url.search).not.toMatch(/JV-DUP|invoice|utility/);
    cleanup();
    render(await GeneralJournalPage({ searchParams: Promise.resolve(Object.fromEntries(url.searchParams)) }));
    expect(screen.getAllByText('A voucher with this reference already exists. Use a different reference.').length).toBeGreaterThan(0);
    const retry = screen.getByRole('button', { name: 'Save draft' }) as HTMLButtonElement;
    const retained = new FormData(retry.form!);
    expect(Object.fromEntries(['reference', 'amount', 'occurredAt', 'evidence', 'reason', 'idempotencyKey'].map((name) => [name, retained.get(name)])))
      .toEqual({ reference: 'JV-DUP', amount: '45.60', occurredAt: '2026-10-20', evidence: 'invoice 7', reason: 'utility accrual', idempotencyKey: form.get('idempotencyKey') });
    expect((screen.getAllByLabelText('Reference')[0] as HTMLInputElement).getAttribute('aria-invalid')).toBe('true');
  });

  it('preserves edited draft values after a stale-version failure', async () => {
    const api = caller();
    api.updateDraft.mockRejectedValue(new TRPCError({ code: 'CONFLICT', message: 'STALE_VERSION' }));
    const page = await GeneralJournalPage({ searchParams: Promise.resolve({}) });
    render(page);
    const button = screen.getByRole('button', { name: 'Save changes' }) as HTMLButtonElement;
    const form = new FormData(button.form!);
    form.set('action', button.value);
    form.set('reference', 'USD-1-EDITED');
    await expect(serverAction(page)!(form)).rejects.toThrow('NEXT_REDIRECT');
    const url = new URL(mocks.redirect.mock.calls[0][0] as string, 'https://tenant.test');
    cleanup();
    render(await GeneralJournalPage({ searchParams: Promise.resolve(Object.fromEntries(url.searchParams)) }));
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeDefined();
    const edited = new FormData((screen.getByRole('button', { name: 'Save changes' }) as HTMLButtonElement).form!);
    expect(edited.get('reference')).toBe('USD-1-EDITED');
    expect(screen.getAllByText(/changed by someone else/).length).toBeGreaterThan(0);
  });

  it('ignores retained values without the matching one-time retry nonce', async () => {
    caller();
    encodeRetained({ nonce: 'n-1', branchId: 'branch-1', message: 'old', action: 'create', reference: 'STALE' })
      .forEach((chunk, index) => mocks.jar.set(`pharmacy-general-journal-retry.${index}`, chunk));
    render(await GeneralJournalPage({ searchParams: Promise.resolve({ retry: 'other' }) }));
    const form = new FormData((screen.getByRole('button', { name: 'Save draft' }) as HTMLButtonElement).form!);
    expect(form.get('reference')).toBe('');
  });

  it('pages older vouchers and searches history by reference', async () => {
    const api = caller();
    const page = Array.from({ length: 26 }, (_, index) => ({ ...document, id: `doc-${index}`, reference: `JV-${index}` }));
    api.list.mockResolvedValue(page);
    render(await GeneralJournalPage({ searchParams: Promise.resolve({ ref: 'JV', before: 'doc-x' }) }));
    expect(api.list).toHaveBeenCalledWith({ branchId: 'branch-1', limit: 26, cursor: 'doc-x', reference: 'JV' });
    expect(screen.queryByText('JV-25')).toBeNull();
    const older = screen.getByRole('link', { name: 'Older vouchers' }).getAttribute('href')!;
    expect(Object.fromEntries(new URL(older, 'https://tenant.test').searchParams)).toEqual({ branch: 'branch-1', ref: 'JV', before: 'doc-24' });
    expect((screen.getByLabelText('Search by reference') as HTMLInputElement).value).toBe('JV');
  });

  it('keeps evidence and business reason readable after a voucher leaves draft', async () => {
    const api = caller();
    api.list.mockResolvedValue([
      { ...document, id: 'doc-posted', reference: 'JV-P', status: 'POSTED', evidence: 'invoice 42', reason: 'electricity accrual' },
      { ...document, id: 'doc-cancelled', reference: 'JV-C', status: 'CANCELLED', evidence: 'quote 9', reason: 'duplicate entry' },
      { ...document, id: 'doc-reversed', reference: 'JV-R', status: 'REVERSED', evidence: 'bill 3', reason: 'rent accrual' },
    ]);
    render(await GeneralJournalPage({ searchParams: Promise.resolve({}) }));
    for (const text of ['invoice 42', 'electricity accrual', 'quote 9', 'duplicate entry', 'bill 3', 'rent accrual']) {
      expect(screen.getByText(text)).toBeDefined();
    }
    expect(screen.getAllByText('Evidence reference')).toHaveLength(4);
    expect(screen.getAllByText('Business reason')).toHaveLength(4);
    expect(screen.queryByRole('button', { name: 'Save changes' })).toBeNull();
  });

  it('returns a failed command on an older voucher to the same history page and keeps the nonce while navigating', async () => {
    const api = caller();
    const older = Array.from({ length: 26 }, (_, index) => ({ ...document, id: `doc-${index}`, reference: `JV-${index}` }));
    api.list.mockResolvedValue(older);
    api.updateDraft.mockRejectedValue(new TRPCError({ code: 'CONFLICT', message: 'STALE_VERSION' }));
    const query = { ref: 'JV', before: 'doc-cursor' };
    const page = await GeneralJournalPage({ searchParams: Promise.resolve(query) });
    render(page);
    const button = screen.getAllByRole('button', { name: 'Save changes' })[3] as HTMLButtonElement;
    const form = new FormData(button.form!);
    form.set('action', button.value);
    form.set('reference', 'JV-3-EDITED');
    expect(form.get('documentId')).toBe('doc-3');
    await expect(serverAction(page)!(form)).rejects.toThrow('NEXT_REDIRECT');
    const url = new URL(mocks.redirect.mock.calls[0][0] as string, 'https://tenant.test');
    expect(url.searchParams.get('ref')).toBe('JV');
    expect(url.searchParams.get('before')).toBe('doc-cursor');
    expect(url.searchParams.get('kind')).toBe('error');
    const retry = url.searchParams.get('retry')!;
    cleanup();
    render(await GeneralJournalPage({ searchParams: Promise.resolve(Object.fromEntries(url.searchParams)) }));
    expect(api.list).toHaveBeenLastCalledWith({ branchId: 'branch-1', limit: 26, cursor: 'doc-cursor', reference: 'JV' });
    const edited = screen.getAllByRole('button', { name: 'Save changes' })
      .map((item) => new FormData((item as HTMLButtonElement).form!))
      .find((data) => data.get('documentId') === 'doc-3')!;
    expect(edited.get('reference')).toBe('JV-3-EDITED');
    const olderLink = new URL(screen.getByRole('link', { name: 'Older vouchers' }).getAttribute('href')!, 'https://tenant.test');
    expect(olderLink.searchParams.get('retry')).toBe(retry);
    const newest = new URL(screen.getByRole('link', { name: 'Show newest' }).getAttribute('href')!, 'https://tenant.test');
    expect(newest.searchParams.get('retry')).toBe(retry);
    const search = new FormData(screen.getByRole('search') as HTMLFormElement);
    expect(search.get('retry')).toBe(retry);
  });

  it('retains maximum-length Urdu evidence and reason within per-cookie browser limits', async () => {
    const api = caller();
    api.createDraft.mockRejectedValue(new Error('response lost'));
    const page = await GeneralJournalPage({ searchParams: Promise.resolve({}) });
    render(page);
    const button = screen.getByRole('button', { name: 'Save draft' }) as HTMLButtonElement;
    const form = new FormData(button.form!);
    const evidence = 'رسید'.repeat(125);
    const reason = 'بجلی کا بل'.repeat(50);
    const reference = 'حوالہ'.repeat(16);
    expect(evidence).toHaveLength(500);
    expect(reason).toHaveLength(500);
    form.set('action', button.value);
    form.set('reference', reference);
    form.set('amount', '1250.00');
    form.set('occurredAt', '2026-10-20');
    form.set('evidence', evidence);
    form.set('reason', reason);
    await expect(serverAction(page)!(form)).rejects.toThrow('NEXT_REDIRECT');
    const chunks = [...mocks.jar.entries()].filter(([name]) => name.startsWith('pharmacy-general-journal-retry.'));
    expect(chunks.length).toBeGreaterThan(0);
    for (const [name, value] of chunks) {
      // The browser limit applies to the name, value, and attributes together.
      expect(new TextEncoder().encode(`${name}=${encodeURIComponent(value)}`).length).toBeLessThan(3900);
    }
    const url = new URL(mocks.redirect.mock.calls[0][0] as string, 'https://tenant.test');
    cleanup();
    render(await GeneralJournalPage({ searchParams: Promise.resolve(Object.fromEntries(url.searchParams)) }));
    const retained = new FormData((screen.getByRole('button', { name: 'Save draft' }) as HTMLButtonElement).form!);
    expect(retained.get('evidence')).toBe(evidence);
    expect(retained.get('reason')).toBe(reason);
    expect(retained.get('reference')).toBe(reference);
    expect(retained.get('idempotencyKey')).toBe(form.get('idempotencyKey'));
  });

  it('clears every retained chunk after a successful command', async () => {
    caller();
    mocks.jar.set('pharmacy-general-journal-retry.0', 'stale');
    mocks.jar.set('pharmacy-general-journal-retry.1', 'stale');
    mocks.jar.set('pharmacy-general-journal-retry', 'legacy');
    const page = await GeneralJournalPage({ searchParams: Promise.resolve({}) });
    render(page);
    const button = screen.getByRole('button', { name: 'Post' }) as HTMLButtonElement;
    const form = new FormData(button.form!);
    form.set('action', button.value);
    await expect(serverAction(page)!(form)).rejects.toThrow('NEXT_REDIRECT');
    expect([...mocks.jar.keys()].filter((name) => name.startsWith('pharmacy-general-journal-retry'))).toEqual([]);
  });
});
