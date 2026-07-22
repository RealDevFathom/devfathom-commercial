import type {
  FinanceBootstrap,
  FinanceClientChoice,
  FinanceMutationKind,
  FinanceTab,
  FinanceTabCache,
} from '~/types/finance-bootstrap';
import type {
  CurrencySummary,
  DataResponse,
  Invoice,
  RecurringExpense,
  Transaction,
} from '~/types/firm';

export const FINANCE_BOOTSTRAP_KEY = 'finance-bootstrap-v1';
export const FINANCE_TAB_FRESHNESS_MS = 60_000;
export const FINANCE_ENDPOINTS = {
  bootstrap: '/api/finance/bootstrap',
  summary: '/api/finance/summary',
  transactions: '/api/finance/transactions',
  invoices: '/api/finance/invoices',
  clientChoices: '/api/finance/client-choices',
  recurring: '/api/finance/recurring-expenses',
} as const;

export const FINANCE_BOOTSTRAP_ASYNC_OPTIONS = {
  server: true,
  lazy: false,
  deep: false,
  dedupe: 'defer',
} as const;

export const FINANCE_MUTATION_RESOURCES = {
  invoice: ['invoices', 'summary'],
  transaction: ['transactions', 'summary'],
  recurring: ['recurring'],
  'recurring-post': ['recurring', 'transactions', 'summary'],
} as const satisfies Record<FinanceMutationKind, readonly string[]>;

interface FinanceRequest {
  <T>(path: string, options?: { query?: Record<string, unknown> }): Promise<T>;
}

interface FinanceTabLoaders {
  transactions: () => Promise<void>;
  invoices: () => Promise<void>;
  pnl: () => Promise<void>;
  recurring: () => Promise<void>;
}

interface FinanceMutationRefreshers {
  invoicesAndSummary: () => Promise<void>;
  transactionsAndSummary: () => Promise<void>;
  recurring: () => Promise<void>;
}

export function isFinanceCacheFresh(
  loadedAt: number,
  now = Date.now(),
  freshnessMs = FINANCE_TAB_FRESHNESS_MS
) {
  return loadedAt > 0 && now - loadedAt < freshnessMs;
}

export function createFinanceTabLoader(
  cache: Pick<FinanceTabCache, 'loadedAt'>,
  loaders: FinanceTabLoaders,
  options: { now?: () => number; freshnessMs?: number } = {}
) {
  const pending = new Map<FinanceTab, Promise<boolean>>();
  const now = options.now || Date.now;
  const freshnessMs = options.freshnessMs ?? FINANCE_TAB_FRESHNESS_MS;

  async function ensure(tab: FinanceTab, force = false): Promise<boolean> {
    if (!force && isFinanceCacheFresh(cache.loadedAt[tab], now(), freshnessMs)) return false;
    const active = pending.get(tab);
    if (active) return active;

    const load = loaders[tab]().then(() => {
      cache.loadedAt[tab] = now();
      return true;
    });
    pending.set(tab, load);
    try {
      return await load;
    } finally {
      pending.delete(tab);
    }
  }

  return { ensure };
}

export async function fetchFinanceBootstrap(request: FinanceRequest): Promise<FinanceBootstrap> {
  return request<FinanceBootstrap>(FINANCE_ENDPOINTS.bootstrap);
}

export async function fetchFinanceInvoiceTab(request: FinanceRequest) {
  const [invoiceResponse, clientResponse] = await Promise.all([
    request<DataResponse<Invoice[]>>(FINANCE_ENDPOINTS.invoices, { query: { limit: 1000 } }),
    request<DataResponse<FinanceClientChoice[]>>(FINANCE_ENDPOINTS.clientChoices),
  ]);
  return { invoices: invoiceResponse.data, clients: clientResponse.data };
}

export async function fetchFinancePnlTransactions(
  request: FinanceRequest,
  initial: Transaction[],
  at = new Date()
) {
  const start = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() - 11, 1));
  const end = new Date(at);
  const transactions = new Map(initial.map((entry) => [entry.id, entry]));
  const seenCursors = new Set<string>();
  let cursor: string | undefined;

  for (let page = 0; page < 100; page += 1) {
    const response = await request<DataResponse<Transaction[]>>(FINANCE_ENDPOINTS.transactions, {
      query: {
        start_date: start.toISOString(),
        end_date: end.toISOString(),
        limit: 100,
        ...(cursor ? { cursor } : {}),
      },
    });
    for (const entry of response.data) transactions.set(entry.id, entry);
    if (response.data.length < 100) break;
    const nextCursor = response.data.at(-1)?.id;
    if (!nextCursor || seenCursors.has(nextCursor)) break;
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }

  return [...transactions.values()].sort(
    (left, right) => new Date(right.date).getTime() - new Date(left.date).getTime()
  );
}

export async function runFinanceMutationRefresh(
  kind: FinanceMutationKind,
  refreshers: FinanceMutationRefreshers
) {
  if (kind === 'invoice') return refreshers.invoicesAndSummary();
  if (kind === 'transaction') return refreshers.transactionsAndSummary();
  if (kind === 'recurring') return refreshers.recurring();
  await Promise.all([refreshers.recurring(), refreshers.transactionsAndSummary()]);
}

function financeErrorMessage(caught: unknown, fallback: string) {
  const candidate = caught as { data?: { detail?: unknown }; message?: string };
  const detail = candidate?.data?.detail;
  if (typeof detail === 'string' && detail.trim()) return detail;
  return candidate?.message?.trim() || fallback;
}

export async function useFinanceData(options: { enabled: boolean; cacheKey: string }) {
  const { request } = useApi();
  const asyncKey = `${FINANCE_BOOTSTRAP_KEY}:${options.cacheKey}`;
  const bootstrapRequest = useAsyncData(asyncKey, () => fetchFinanceBootstrap(request), {
    ...FINANCE_BOOTSTRAP_ASYNC_OPTIONS,
    immediate: options.enabled,
    getCachedData: (key, nuxtApp) =>
      nuxtApp.isHydrating ? nuxtApp.payload.data[key] : nuxtApp.static.data[key],
  });
  const summaryOverride = useState<CurrencySummary[] | null>(`${asyncKey}:summary`, () => null);
  const cache = useState<FinanceTabCache>(`${asyncKey}:tabs`, () => ({
    invoices: [],
    clients: [],
    recurring: [],
    pnlTransactions: [],
    loadedAt: { transactions: 0, invoices: 0, pnl: 0, recurring: 0 },
  }));
  const {
    data: bootstrap,
    error: bootstrapError,
    status,
    refresh: refreshBootstrapRequest,
  } = await bootstrapRequest;
  const activeLoad = ref<FinanceTab | null>(null);
  const tabError = ref('');

  const summary = computed(
    () => summaryOverride.value ?? bootstrap.value?.summary.byCurrency ?? []
  );
  const transactions = computed(() => bootstrap.value?.transactions.items ?? []);
  const invoices = computed(() => cache.value.invoices);
  const clients = computed(() => cache.value.clients);
  const recurring = computed(() => cache.value.recurring);
  const pnlTransactions = computed(() =>
    cache.value.loadedAt.pnl ? cache.value.pnlTransactions : transactions.value
  );
  const loading = computed(() => options.enabled && status.value === 'pending' && !bootstrap.value);
  const error = computed(() =>
    bootstrapError.value
      ? financeErrorMessage(bootstrapError.value, 'The finance workspace is unavailable.')
      : ''
  );

  if (bootstrap.value && !cache.value.loadedAt.transactions) {
    cache.value.loadedAt.transactions = Date.now();
  }

  async function refreshBootstrap() {
    await refreshBootstrapRequest();
    if (bootstrapError.value) throw bootstrapError.value;
    if (!bootstrap.value) throw new Error('The finance bootstrap returned no data.');
    summaryOverride.value = null;
    cache.value.loadedAt.transactions = Date.now();
  }

  async function refreshSummary() {
    const response = await request<{ byCurrency: CurrencySummary[] }>(FINANCE_ENDPOINTS.summary);
    summaryOverride.value = response.byCurrency;
  }

  async function refreshInvoices() {
    const response = await request<DataResponse<Invoice[]>>(FINANCE_ENDPOINTS.invoices, {
      query: { limit: 1000 },
    });
    cache.value.invoices = response.data;
    cache.value.loadedAt.invoices = Date.now();
  }

  async function refreshRecurring() {
    const response = await request<DataResponse<RecurringExpense[]>>(FINANCE_ENDPOINTS.recurring);
    cache.value.recurring = response.data;
    cache.value.loadedAt.recurring = Date.now();
  }

  async function refreshTransactionsAndSummary() {
    await refreshBootstrap();
    cache.value.pnlTransactions = [];
    cache.value.loadedAt.pnl = 0;
  }

  async function refreshInvoicesAndSummary() {
    await Promise.all([refreshInvoices(), refreshSummary()]);
  }

  const loader = createFinanceTabLoader(cache.value, {
    transactions: refreshBootstrap,
    invoices: async () => {
      const result = await fetchFinanceInvoiceTab(request);
      cache.value.invoices = result.invoices;
      cache.value.clients = result.clients;
    },
    pnl: async () => {
      cache.value.pnlTransactions = bootstrap.value?.transactions.nextCursor
        ? await fetchFinancePnlTransactions(request, transactions.value)
        : [...transactions.value];
    },
    recurring: async () => {
      const response = await request<DataResponse<RecurringExpense[]>>(FINANCE_ENDPOINTS.recurring);
      cache.value.recurring = response.data;
    },
  });

  async function ensureTab(tab: FinanceTab, force = false) {
    if (!force && isFinanceCacheFresh(cache.value.loadedAt[tab])) {
      tabError.value = '';
      return;
    }
    activeLoad.value = tab;
    tabError.value = '';
    try {
      await loader.ensure(tab, force);
    } catch (caught) {
      tabError.value = financeErrorMessage(caught, 'This finance section is unavailable.');
    } finally {
      if (activeLoad.value === tab) activeLoad.value = null;
    }
  }

  const refreshAfterMutation = (kind: FinanceMutationKind) =>
    runFinanceMutationRefresh(kind, {
      invoicesAndSummary: refreshInvoicesAndSummary,
      transactionsAndSummary: refreshTransactionsAndSummary,
      recurring: refreshRecurring,
    });

  return {
    activeLoad,
    clients,
    ensureTab,
    error,
    invoices,
    loading,
    pnlTransactions,
    recurring,
    refreshAfterMutation,
    refreshTransactionsAndSummary,
    summary,
    tabError,
    transactions,
  };
}
