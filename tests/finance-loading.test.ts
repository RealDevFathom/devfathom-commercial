import { describe, expect, test } from 'bun:test';
import {
  FINANCE_BOOTSTRAP_ASYNC_OPTIONS,
  FINANCE_ENDPOINTS,
  FINANCE_MUTATION_RESOURCES,
  createFinanceTabLoader,
  fetchFinanceBootstrap,
  fetchFinancePnlTransactions,
  runFinanceMutationRefresh,
} from '../app/composables/useFinanceData.ts';
import type { FinanceTabCache } from '../app/types/finance-bootstrap.ts';
import type { Transaction } from '../app/types/firm.ts';

function cache(): FinanceTabCache {
  return {
    invoices: [],
    clients: [],
    recurring: [],
    pnlTransactions: [],
    loadedAt: { transactions: 0, invoices: 0, pnl: 0, recurring: 0 },
  };
}

describe('finance bootstrap loading', () => {
  test('uses one initial endpoint and keeps lazy resources out of the payload', async () => {
    const calls: string[] = [];
    const payload = {
      summary: { byCurrency: [] },
      transactions: { items: [], nextCursor: null },
    };
    const result = await fetchFinanceBootstrap(async (path) => {
      calls.push(path);
      return payload;
    });

    expect(calls).toEqual([FINANCE_ENDPOINTS.bootstrap]);
    expect(result).toEqual(payload);
    expect(result).not.toHaveProperty('invoices');
    expect(result).not.toHaveProperty('clients');
    expect(result).not.toHaveProperty('recurring');
  });

  test('renders bootstrap on the server and reuses the Nuxt payload during hydration', () => {
    expect(FINANCE_BOOTSTRAP_ASYNC_OPTIONS).toEqual({
      server: true,
      lazy: false,
      deep: false,
      dedupe: 'defer',
    });
  });
});

describe('finance tab cache', () => {
  test('loads only the active tab and does not immediately refetch a loaded tab', async () => {
    let now = 1_000;
    const state = cache();
    state.loadedAt.transactions = now;
    const calls = { transactions: 0, invoices: 0, pnl: 0, recurring: 0 };
    const loader = createFinanceTabLoader(
      state,
      {
        transactions: async () => void (calls.transactions += 1),
        invoices: async () => void (calls.invoices += 1),
        pnl: async () => void (calls.pnl += 1),
        recurring: async () => void (calls.recurring += 1),
      },
      { now: () => now, freshnessMs: 60_000 }
    );

    await loader.ensure('transactions');
    await loader.ensure('invoices');
    await loader.ensure('invoices');
    expect(calls).toEqual({ transactions: 0, invoices: 1, pnl: 0, recurring: 0 });

    now += 60_001;
    await loader.ensure('invoices');
    expect(calls.invoices).toBe(2);
  });

  test('deduplicates concurrent tab requests and caches only successful loads', async () => {
    const state = cache();
    let resolveInvoice!: () => void;
    let invoiceCalls = 0;
    let recurringCalls = 0;
    const loader = createFinanceTabLoader(state, {
      transactions: async () => {},
      invoices: () => {
        invoiceCalls += 1;
        return new Promise<void>((resolve) => (resolveInvoice = resolve));
      },
      pnl: async () => {},
      recurring: async () => {
        recurringCalls += 1;
        throw new Error('offline');
      },
    });

    const first = loader.ensure('invoices');
    const second = loader.ensure('invoices');
    expect(invoiceCalls).toBe(1);
    resolveInvoice();
    await Promise.all([first, second]);

    await expect(loader.ensure('recurring')).rejects.toThrow('offline');
    await expect(loader.ensure('recurring')).rejects.toThrow('offline');
    expect(recurringCalls).toBe(2);
    expect(state.loadedAt.recurring).toBe(0);
  });

  test('fetches an additional P&L range page only when asked', async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => ({
      id: `transaction-${index}`,
      type: 'INCOME',
      amount: 1,
      currency: 'USD',
      description: 'Revenue',
      date: `2026-07-${String(20 - (index % 20)).padStart(2, '0')}T00:00:00.000Z`,
    })) as Transaction[];
    const calls: unknown[] = [];
    const result = await fetchFinancePnlTransactions(
      async (_path, options) => {
        calls.push(options?.query);
        return { data: calls.length === 1 ? firstPage : [] };
      },
      [],
      new Date('2026-07-22T00:00:00.000Z')
    );

    expect(calls).toHaveLength(2);
    expect(result).toHaveLength(100);
    expect(calls[1]).toMatchObject({ cursor: 'transaction-99' });
  });
});

describe('finance mutation refresh scopes', () => {
  test('refreshes only resources affected by each CRUD family', async () => {
    expect(FINANCE_MUTATION_RESOURCES).toEqual({
      invoice: ['invoices', 'summary'],
      transaction: ['transactions', 'summary'],
      recurring: ['recurring'],
      'recurring-post': ['recurring', 'transactions', 'summary'],
    });
    const calls: string[] = [];
    const refreshers = {
      invoicesAndSummary: async () => void calls.push('invoices+summary'),
      transactionsAndSummary: async () => void calls.push('transactions+summary'),
      recurring: async () => void calls.push('recurring'),
    };

    await runFinanceMutationRefresh('invoice', refreshers);
    await runFinanceMutationRefresh('transaction', refreshers);
    await runFinanceMutationRefresh('recurring', refreshers);
    expect(calls).toEqual(['invoices+summary', 'transactions+summary', 'recurring']);

    calls.length = 0;
    await runFinanceMutationRefresh('recurring-post', refreshers);
    expect(calls.sort()).toEqual(['recurring', 'transactions+summary']);
  });
});
