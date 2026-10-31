import { render, screen } from '@testing-library/react';
import { Children, isValidElement, type ReactNode } from 'react';
import { TRPCError } from '@trpc/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  resolveTenantActor: vi.fn(),
  createTRPCContext: vi.fn(),
  createCaller: vi.fn(),
  redirect: vi.fn(),
}));

vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: mocks.resolveTenantActor }));
vi.mock('@/server/trpc', () => ({ createTRPCContext: mocks.createTRPCContext }));
vi.mock('@/server/routers/pharmacy-general-journal', () => ({ pharmacyGeneralJournalRouter: { createCaller: mocks.createCaller } }));
vi.mock('next/navigation', () => ({ redirect: mocks.redirect }));

import GeneralJournalPage from './page';

const actor = {
  session: { user: { id: 'user-1' } },
  organization: { id: 'org-1', slug: 'shop' },
  support: null,
};

beforeEach(() => {
  vi.clearAllMocks();
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
        expect(api.reverse).toHaveBeenLastCalledWith(expect.objectContaining({ at: new Date(String(form.get('reversalAt'))) }));
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
});
