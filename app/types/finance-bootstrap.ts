import type { CurrencySummary, Invoice, RecurringExpense, Transaction } from '~/types/firm';

export type FinanceTab = 'transactions' | 'invoices' | 'pnl' | 'recurring';

export interface FinanceTransactionPage {
  items: Transaction[];
  nextCursor: string | null;
}

export interface FinanceBootstrap {
  summary: {
    byCurrency: CurrencySummary[];
  };
  transactions: FinanceTransactionPage;
}

export interface FinanceClientChoice {
  id: string;
  name: string;
}

export interface FinanceTabCache {
  invoices: Invoice[];
  clients: FinanceClientChoice[];
  recurring: RecurringExpense[];
  pnlTransactions: Transaction[];
  loadedAt: Record<FinanceTab, number>;
}

export type FinanceMutationKind = 'invoice' | 'transaction' | 'recurring' | 'recurring-post';
