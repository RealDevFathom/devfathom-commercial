import { TRPCError } from '@trpc/server';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  actor: vi.fn(),
  context: vi.fn(),
  caller: vi.fn(),
  module: vi.fn(),
}));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: mocks.actor }));
vi.mock('@/server/trpc', () => ({ createTRPCContext: mocks.context }));
vi.mock('@/lib/entitlements', () => ({ hasModule: mocks.module }));
vi.mock('@/server/routers/pharmacy-purchasing', () => ({
  pharmacyPurchasingRouter: { createCaller: mocks.caller },
}));

import PharmacyPurchasingPage from './page';
import type { SearchQuery } from './_lib/console';

const reads = {
  workspace: vi.fn(),
  purchaseOrders: vi.fn(),
  receivingExceptionQueue: vi.fn(),
  purchaseReturns: vi.fn(),
};
const branch = { id: 'branch-main', name: 'Main branch', code: 'MAIN', city: 'Karachi' };
const secondBranch = { ...branch, id: 'branch-second', name: 'Second branch' };
const workspace = {
  branches: [branch, secondBranch],
  suppliers: [],
  medicines: [],
  stockLocations: [],
};
let unexpectedCalls: string[];

function context(currency: string | undefined = 'PKR') {
  return {
    session: { user: { id: 'user' } },
    organization: { id: 'org', currency },
    entitlements: { organizationId: 'org' },
  };
}

function returnsWith(...outstanding: number[]) {
  return [
    { debitNotes: outstanding.map((outstandingMinor) => ({ position: { outstandingMinor } })) },
  ];
}

async function show(query: SearchQuery = { branch: branch.id }) {
  return render(await PharmacyPurchasingPage({ searchParams: Promise.resolve(query) }));
}

function stat(label: string) {
  const element = screen.getByText(label).closest<HTMLElement>('[data-slot="stat"]');
  if (!element) throw new Error(`Missing stat: ${label}`);
  return within(element);
}

beforeEach(() => {
  vi.resetAllMocks();
  unexpectedCalls = [];
  mocks.actor.mockResolvedValue(context());
  mocks.context.mockResolvedValue(context());
  mocks.module.mockReturnValue(true);
  // Any caller outside these four existing reads, including a mutation, fails every test.
  mocks.caller.mockReturnValue(
    new Proxy(reads, {
      get(target, key) {
        if (key === 'then') return undefined;
        if (typeof key === 'string' && Object.hasOwn(target, key)) {
          return target[key as keyof typeof target];
        }
        unexpectedCalls.push(String(key));
        throw new Error(`Unexpected purchasing operation: ${String(key)}`);
      },
    })
  );
  reads.workspace.mockResolvedValue(workspace);
  reads.purchaseOrders.mockResolvedValue([]);
  reads.receivingExceptionQueue.mockResolvedValue([{ id: 'one' }, { id: 'two' }]);
  reads.purchaseReturns.mockResolvedValue(returnsWith(12_345));
});

afterEach(() => {
  cleanup();
  expect(unexpectedCalls).toEqual([]);
});

describe('independent purchasing overview reads', () => {
  it('keeps exceptions when the credit read fails without claiming a zero balance', async () => {
    reads.purchaseReturns.mockRejectedValue(new Error('Read failed'));
    await show();
    expect(stat('Open match exceptions').getByText('2')).toBeVisible();
    expect(stat('Credit outstanding').getByText('Unavailable')).toBeVisible();
    expect(screen.queryByText('PKR 0.00')).toBeNull();
    expect(screen.getByRole('button', { name: 'Retry reads' })).toBeVisible();
  });

  it('keeps authoritative credit when the exception read fails', async () => {
    reads.receivingExceptionQueue.mockRejectedValue(new Error('Read failed'));
    await show();
    expect(stat('Open match exceptions').getByText('Unavailable')).toBeVisible();
    expect(stat('Credit outstanding').getByText('PKR 123.45')).toBeVisible();
  });

  it('shows both failures independently without numeric zero', async () => {
    reads.receivingExceptionQueue.mockRejectedValue(new Error('Read failed'));
    reads.purchaseReturns.mockRejectedValue(new Error('Read failed'));
    await show();
    expect(stat('Open match exceptions').getByText('Unavailable')).toBeVisible();
    expect(stat('Credit outstanding').getByText('Unavailable')).toBeVisible();
    expect(screen.queryByText('PKR 0.00')).toBeNull();
  });

  it.each([{ rows: [] }, { rows: returnsWith(0) }])(
    'shows confirmed zero only after successful reads: $rows',
    async ({ rows }) => {
      reads.receivingExceptionQueue.mockResolvedValue([]);
      reads.purchaseReturns.mockResolvedValue(rows);
      await show();
      expect(stat('Open match exceptions').getByText('0')).toBeVisible();
      expect(stat('Credit outstanding').getByText('PKR 0.00')).toBeVisible();
      expect(screen.queryByRole('button', { name: 'Retry reads' })).toBeNull();
    }
  );

  it('preserves the existing sum of debit-note outstanding positions and its scope', async () => {
    reads.purchaseReturns.mockResolvedValue([...returnsWith(12_000, 0), ...returnsWith(345)]);
    await show({ branch: secondBranch.id });
    expect(stat('Credit outstanding').getByText('PKR 123.45')).toBeVisible();
    expect(
      stat('Credit outstanding').getByText(/Second branch · Expected, not yet received/)
    ).toBeVisible();
    expect(
      stat('Credit outstanding').getByText(
        /across all returns for this branch; read on this page load/
      )
    ).toBeVisible();
    expect(reads.purchaseReturns).toHaveBeenCalledExactlyOnceWith({ branchId: secondBranch.id });
    expect(reads.receivingExceptionQueue).toHaveBeenCalledExactlyOnceWith({
      branchId: secondBranch.id,
      status: 'OPEN',
    });
  });

  it.each(['USD', 'EUR'])(
    'uses tenant currency %s with exactly two minor-unit decimals',
    async (currency) => {
      mocks.context.mockResolvedValue(context(currency));
      await show();
      expect(stat('Credit outstanding').getByText(`${currency} 123.45`)).toBeVisible();
      expect(screen.queryByText(/PKR/)).toBeNull();
    }
  );

  it.each([undefined, '', 'invalid'])(
    'withholds currency-less amounts instead of inventing a default: %s',
    async (currency) => {
      mocks.context.mockResolvedValue({ ...context(), organization: { id: 'org', currency } });
      await show();
      expect(stat('Credit outstanding').getByText('Currency unavailable')).toBeVisible();
      expect(stat('Credit outstanding').getByText(/Credit read succeeded/)).toBeVisible();
      expect(screen.queryByText(/123\.45|PKR|USD/)).toBeNull();
      expect(stat('Open match exceptions').getByText('2')).toBeVisible();
    }
  );

  it.each([{ branches: [] }, { branches: [branch, secondBranch] }])(
    'does not read branch totals until a branch is resolved: $branches',
    async ({ branches }) => {
      reads.workspace.mockResolvedValue({ ...workspace, branches });
      await show({});
      for (const label of ['Open match exceptions', 'Credit outstanding']) {
        expect(stat(label).getByText('Unselected')).toBeVisible();
        expect(stat(label).getByText(/Choose a branch/)).toBeVisible();
      }
      expect(reads.receivingExceptionQueue).not.toHaveBeenCalled();
      expect(reads.purchaseReturns).not.toHaveBeenCalled();
      expect(screen.queryByRole('button', { name: 'Retry reads' })).toBeNull();
    }
  );

  it.each(['receivingExceptionQueue', 'purchaseReturns'] as const)(
    'distinguishes denied %s from failure and keeps the successful sibling',
    async (read) => {
      reads[read].mockRejectedValue(new TRPCError({ code: 'FORBIDDEN' }));
      await show();
      const deniedLabel =
        read === 'purchaseReturns' ? 'Credit outstanding' : 'Open match exceptions';
      expect(stat(deniedLabel).getByText('Access denied')).toBeVisible();
      expect(stat(deniedLabel).getByText(/Ask a workspace administrator/)).toBeVisible();
      expect(
        read === 'purchaseReturns'
          ? stat('Open match exceptions').getByText('2')
          : stat('Credit outstanding').getByText('PKR 123.45')
      ).toBeVisible();
      expect(screen.queryByRole('button', { name: 'Retry reads' })).toBeNull();
    }
  );

  it('does not show either balance after session denial', async () => {
    reads.receivingExceptionQueue.mockRejectedValue(new TRPCError({ code: 'UNAUTHORIZED' }));
    reads.purchaseReturns.mockRejectedValue(new TRPCError({ code: 'UNAUTHORIZED' }));
    await show();
    expect(screen.getAllByText('Access denied')).toHaveLength(2);
    expect(screen.queryByText(/123\.45|PKR 0\.00/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Retry reads' })).toBeNull();
  });

  it('never substitutes the sole remaining branch for an unavailable explicit selection', async () => {
    reads.workspace.mockResolvedValue({ ...workspace, branches: [branch] });
    await show({ branch: 'removed-branch' });
    expect(screen.getAllByText('Access denied')).toHaveLength(2);
    expect(reads.receivingExceptionQueue).not.toHaveBeenCalled();
    expect(reads.purchaseReturns).not.toHaveBeenCalled();
  });

  it.each(['module', 'session'] as const)(
    'does not start protected reads without %s access',
    async (gate) => {
      if (gate === 'module') mocks.module.mockReturnValue(false);
      else mocks.context.mockResolvedValue({ ...context(), session: null });
      await show();
      expect(reads.workspace).not.toHaveBeenCalled();
      expect(reads.purchaseReturns).not.toHaveBeenCalled();
      expect(screen.queryByText('Credit outstanding')).toBeNull();
    }
  );

  it('retries via a native GET retaining the selected branch and recovers without new writes', async () => {
    reads.purchaseReturns.mockRejectedValueOnce(new Error('Read failed'));
    const view = await show({ branch: secondBranch.id });
    const form = screen.getByRole('form', { name: 'Retry purchasing reads' }) as HTMLFormElement;
    expect(form).toHaveAttribute('method', 'get');
    expect(form).toHaveAttribute('action', '/pharmacy/purchasing');
    const retryQuery = Object.fromEntries(new FormData(form)) as Record<string, string>;
    expect(retryQuery).toEqual({ branch: secondBranch.id });
    expect(screen.getByRole('button', { name: 'Retry reads' })).toHaveAttribute('type', 'submit');
    view.unmount();
    await show(retryQuery);
    expect(stat('Credit outstanding').getByText('PKR 123.45')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Retry reads' })).toBeNull();
    expect(reads.purchaseReturns.mock.calls).toEqual([
      [{ branchId: secondBranch.id }],
      [{ branchId: secondBranch.id }],
    ]);
    expect(reads.receivingExceptionQueue.mock.calls).toEqual([
      [{ branchId: secondBranch.id, status: 'OPEN' }],
      [{ branchId: secondBranch.id, status: 'OPEN' }],
    ]);
  });

  it('pins an implicitly resolved single branch into the retry GET', async () => {
    reads.workspace.mockResolvedValue({ ...workspace, branches: [branch] });
    reads.purchaseReturns.mockRejectedValue(new Error('Read failed'));
    await show({});
    const form = screen.getByRole('form', { name: 'Retry purchasing reads' }) as HTMLFormElement;
    expect(Object.fromEntries(new FormData(form))).toEqual({ branch: branch.id });
  });

  it('retains the requested branch if workspace discovery fails', async () => {
    reads.workspace.mockRejectedValue(new Error('Read failed'));
    await show({ branch: secondBranch.id });
    const form = screen.getByRole('form', { name: 'Retry purchasing reads' }) as HTMLFormElement;
    expect(Object.fromEntries(new FormData(form))).toEqual({ branch: secondBranch.id });
    expect(reads.purchaseReturns).not.toHaveBeenCalled();
  });

  it('explains workspace access denial without a retry or protected totals', async () => {
    reads.workspace.mockRejectedValue(new TRPCError({ code: 'FORBIDDEN' }));
    await show();
    expect(
      screen.getByRole('heading', { name: 'You do not have purchasing access' })
    ).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Retry reads' })).toBeNull();
    expect(reads.purchaseReturns).not.toHaveBeenCalled();
  });
});
