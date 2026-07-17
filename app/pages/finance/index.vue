<script setup lang="ts">
import {
  ArrowDownLeft,
  ArrowUpRight,
  Download,
  DollarSign,
  FilePlus2,
  FileText,
  Pencil,
  PieChart,
  Plus,
  Printer,
  Receipt,
  RefreshCw,
  Trash2,
  TrendingDown,
  TrendingUp,
  WalletCards,
} from 'lucide-vue-next';
import type { Component } from 'vue';
import type { CurrencySummary, Invoice, RecurringExpense, Transaction } from '~/types/firm';

type FinanceTab = 'transactions' | 'invoices' | 'pnl' | 'recurring';
useHead({ title: 'Finance · DevFathom Hub' });
const api = useFirm();
const crm = useCrm();
const { user } = useAuth();
const admin = computed(() => user.value?.role === 'ADMIN');
const categoryLabels: Record<string, string> = {
  SALARIES: 'Salaries',
  SUBSCRIPTIONS: 'Subscriptions',
  OFFICE: 'Office',
  MARKETING: 'Marketing',
  HOSTING: 'Hosting',
  SOFTWARE: 'Software',
  HARDWARE: 'Hardware',
  TRAVEL: 'Travel',
  UTILITIES: 'Utilities',
  MISCELLANEOUS: 'Miscellaneous',
};
const tab = ref<FinanceTab>('transactions');
const transactionFilter = ref<'ALL' | 'INCOME' | 'EXPENSE'>('ALL');
const pnlCurrency = ref<'USD' | 'PKR'>('USD');
const summary = ref<CurrencySummary[]>([]);
const invoices = ref<Invoice[]>([]);
const transactions = ref<Transaction[]>([]);
const recurring = ref<RecurringExpense[]>([]);
const clients = ref<{ id: string; name: string }[]>([]);
const loading = ref(true);
const error = ref('');
const form = ref<'invoice' | 'transaction' | 'payment' | null>(null);
const selectedInvoice = ref<Invoice | null>(null);
const recurringOpen = ref(false);
const postResult = ref('');
const editingTransactionId = ref<string | null>(null);
const updatingTransaction = ref(false);
const invoiceDraft = reactive({
  client_id: '',
  currency: 'USD',
  due_date: '',
  tax: 0,
  notes: '',
  description: '',
  quantity: 1,
  rate: 0,
});
const txDraft = reactive({
  type: 'EXPENSE',
  amount: 0,
  currency: 'USD',
  category: '',
  description: '',
  date: '',
});
const txEditDraft = reactive({
  description: '',
  amount: '',
  date: '',
  category: '',
});
const payment = reactive({ amount: 0, method: '', note: '' });
const recurringDraft = reactive({
  name: '',
  vendor_name: '',
  amount: 0,
  currency: 'USD',
  category: 'SUBSCRIPTIONS',
  interval: 'monthly',
  next_due_date: '',
});

async function load() {
  loading.value = true;
  error.value = '';
  try {
    const [s, i, t, c, r] = await Promise.all([
      api.summary(),
      api.invoices(),
      api.transactions(),
      crm.listClients(),
      api.recurringExpenses(),
    ]);
    summary.value = s.byCurrency;
    invoices.value = i;
    transactions.value = t;
    clients.value = c;
    recurring.value = r;
  } catch (caught: any) {
    error.value = caught?.data?.detail || 'The finance workspace is unavailable.';
  } finally {
    loading.value = false;
  }
}
await load();

const money = (amount: number, currency: string) =>
  new Intl.NumberFormat('en', { style: 'currency', currency, maximumFractionDigits: 0 }).format(
    Number(amount)
  );
const date = (value: string) =>
  new Intl.DateTimeFormat('en', { dateStyle: 'medium' }).format(new Date(value));
const statusTone = (status: string) =>
  status === 'PAID'
    ? 'bg-emerald-500/10 text-emerald-500'
    : status === 'OVERDUE'
      ? 'bg-red-500/10 text-red-500'
      : status === 'SENT'
        ? 'bg-blue-500/10 text-blue-500'
        : 'bg-muted text-text-muted';
const moneyList = (key: keyof CurrencySummary) =>
  summary.value.map((group) => money(Number(group[key]), group.currency)).join(' · ') || '$0';
const filteredTransactions = computed(() =>
  transactions.value.filter(
    (entry) => transactionFilter.value === 'ALL' || entry.type === transactionFilter.value
  )
);
const currencies = computed(
  () => [...new Set(summary.value.map((group) => group.currency))] as Array<'USD' | 'PKR'>
);
const selectedSummary = computed(
  () =>
    summary.value.find((group) => group.currency === pnlCurrency.value) || summary.value[0] || null
);
const pnlMonths = computed(() => {
  const now = new Date();
  return Array.from({ length: 12 }, (_, index) => {
    const month = new Date(now.getFullYear(), now.getMonth() - 11 + index, 1);
    const entries = transactions.value.filter((entry) => {
      const entryDate = new Date(entry.date);
      return (
        entry.currency === pnlCurrency.value &&
        entryDate.getFullYear() === month.getFullYear() &&
        entryDate.getMonth() === month.getMonth()
      );
    });
    const income = entries
      .filter((entry) => entry.type === 'INCOME')
      .reduce((total, entry) => total + Number(entry.amount), 0);
    const expense = entries
      .filter((entry) => entry.type === 'EXPENSE')
      .reduce((total, entry) => total + Number(entry.amount), 0);
    return {
      label: month.toLocaleDateString('en', { month: 'short' }),
      income,
      expense,
    };
  });
});
const pnlMax = computed(() =>
  Math.max(1, ...pnlMonths.value.flatMap((month) => [month.income, month.expense]))
);
const expenseBreakdown = computed(() => {
  const amounts = new Map<string, number>();
  for (const entry of transactions.value) {
    if (entry.currency !== pnlCurrency.value || entry.type !== 'EXPENSE') continue;
    const category = entry.category || 'Uncategorised';
    amounts.set(category, (amounts.get(category) || 0) + Number(entry.amount));
  }
  return [...amounts.entries()]
    .map(([category, amount]) => ({ category, amount }))
    .sort((a, b) => b.amount - a.amount);
});
const averageMargin = computed(() => {
  const income = Number(selectedSummary.value?.yearly_income || 0);
  return income ? (Number(selectedSummary.value?.yearly_profit || 0) / income) * 100 : 0;
});

function exportTransactions() {
  const escape = (value: unknown) => `"${String(value ?? '').replaceAll('"', '""')}"`;
  const rows = filteredTransactions.value.map((entry) => [
    entry.date.slice(0, 10),
    entry.type,
    entry.amount,
    entry.currency,
    entry.category || '',
    entry.description,
    entry.projectName || '',
    entry.clientName || '',
  ]);
  const csv = [
    ['Date', 'Type', 'Amount', 'Currency', 'Category', 'Description', 'Project', 'Client'],
    ...rows,
  ]
    .map((row) => row.map(escape).join(','))
    .join('\r\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `transactions-${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

const summaryCards = computed<
  Array<{ title: string; value: string; subtitle?: string; icon: Component; tone: string }>
>(() => [
  {
    title: 'Monthly Revenue',
    value: moneyList('monthly_income'),
    icon: TrendingUp,
    tone: 'emerald',
  },
  {
    title: 'Monthly Expenses',
    value: moneyList('monthly_expense'),
    icon: TrendingDown,
    tone: 'red',
  },
  {
    title: 'Net Profit',
    value: moneyList('monthly_profit'),
    icon: DollarSign,
    tone: Number(summary.value[0]?.monthly_profit || 0) < 0 ? 'red' : 'emerald',
  },
  {
    title: 'Outstanding',
    value: moneyList('total_outstanding'),
    subtitle: `${invoices.value.filter((invoice) => !['PAID', 'CANCELLED'].includes(invoice.status)).length} invoices`,
    icon: FileText,
    tone: 'amber',
  },
]);

async function createInvoice() {
  await api.createInvoice({
    ...invoiceDraft,
    due_date: new Date(invoiceDraft.due_date).toISOString(),
    items: [
      {
        description: invoiceDraft.description,
        quantity: invoiceDraft.quantity,
        rate: invoiceDraft.rate,
      },
    ],
  });
  form.value = null;
  await load();
}
async function createTransaction() {
  await api.createTransaction({
    ...txDraft,
    date: new Date(txDraft.date).toISOString(),
    category: txDraft.category || null,
  });
  form.value = null;
  await load();
}
function editTransaction(entry: Transaction) {
  editingTransactionId.value = entry.id;
  txEditDraft.description = entry.description;
  txEditDraft.amount = String(entry.amount);
  txEditDraft.date = new Date(entry.date).toISOString().slice(0, 10);
  txEditDraft.category = entry.category || '';
}
async function updateTransaction(entry: Transaction) {
  if (!txEditDraft.description.trim() || !txEditDraft.amount || !txEditDraft.date) return;
  updatingTransaction.value = true;
  try {
    await api.updateTransaction(entry.id, {
      description: txEditDraft.description.trim(),
      amount: Number(txEditDraft.amount),
      date: new Date(txEditDraft.date).toISOString(),
      category: entry.type === 'EXPENSE' ? txEditDraft.category || null : null,
    });
    editingTransactionId.value = null;
    await load();
  } finally {
    updatingTransaction.value = false;
  }
}
async function addPayment() {
  if (!selectedInvoice.value) return;
  await api.addPayment(selectedInvoice.value.id, payment);
  form.value = null;
  await load();
}
async function removeTx(id: string) {
  if (confirm('Delete this transaction?')) {
    await api.removeTransaction(id);
    await load();
  }
}
async function setStatus(invoice: Invoice, value: string) {
  await api.updateInvoiceStatus(invoice.id, value);
  await load();
}
async function createRecurring() {
  await api.createRecurringExpense({
    ...recurringDraft,
    next_due_date: new Date(recurringDraft.next_due_date).toISOString(),
    vendor_name: recurringDraft.vendor_name || null,
  });
  recurringOpen.value = false;
  await load();
}
async function removeRecurring(id: string) {
  if (!confirm('Remove this recurring expense?')) return;
  await api.removeRecurringExpense(id);
  await load();
}
async function postDue() {
  const result = await api.postDueRecurringExpenses();
  postResult.value = result.posted
    ? `Posted ${result.posted} transaction${result.posted === 1 ? '' : 's'} from due cycles.`
    : 'Nothing due — all subscriptions are up to date.';
  await load();
}
</script>

<template>
  <section class="animate-fade-in space-y-6">
    <div>
      <h1 class="font-display text-2xl font-bold tracking-tight text-foreground">Finance</h1>
      <p class="mt-1.5 text-[15px] text-text-muted">
        Income, expenses, invoices, and financial reports.
      </p>
    </div>

    <DeliveryFieldState
      v-if="loading || error"
      :loading="loading"
      :error="error"
      action="Try again"
      @action="load"
    />
    <template v-else>
      <div class="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <article
          v-for="card in summaryCards"
          :key="card.title"
          class="rounded-xl bg-card py-4 ring-1 ring-foreground/10"
        >
          <div class="flex items-start justify-between gap-3 p-6">
            <div>
              <p class="text-[13px] font-medium text-text-muted">{{ card.title }}</p>
              <strong
                class="mt-1 block break-words text-2xl font-bold tracking-tight text-foreground"
                >{{ card.value }}</strong
              >
              <small v-if="card.subtitle" class="mt-0.5 block text-xs text-text-muted">{{
                card.subtitle
              }}</small>
            </div>
            <span
              class="flex size-10 shrink-0 items-center justify-center rounded-xl"
              :class="
                card.tone === 'emerald'
                  ? 'bg-emerald-500/10 text-emerald-500'
                  : card.tone === 'red'
                    ? 'bg-red-500/10 text-red-500'
                    : 'bg-amber-500/10 text-amber-500'
              "
            >
              <component :is="card.icon" :size="20" />
            </span>
          </div>
        </article>
      </div>

      <nav
        class="inline-flex h-8 w-fit max-w-full items-center gap-0.5 overflow-x-auto rounded-lg bg-muted p-[3px] text-text-muted"
        aria-label="Finance sections"
      >
        <button
          v-for="item in ['transactions', 'invoices', 'pnl', 'recurring'] as const"
          :key="item"
          class="inline-flex h-[26px] flex-none items-center justify-center whitespace-nowrap rounded-md border border-transparent px-1.5 py-0.5 text-sm font-medium capitalize transition-all"
          :class="
            tab === item
              ? 'bg-card text-foreground shadow-sm'
              : 'text-text-muted hover:text-foreground'
          "
          @click="tab = item"
        >
          {{ item === 'pnl' ? 'P&L Report' : item }}
        </button>
      </nav>

      <section v-if="tab === 'transactions'" class="space-y-4">
        <header class="flex flex-wrap items-center justify-between gap-3">
          <div class="flex items-center gap-1.5" aria-label="Transaction filters">
            <button
              v-for="filter in ['ALL', 'INCOME', 'EXPENSE'] as const"
              :key="filter"
              class="rounded-lg px-3 py-1.5 text-xs font-medium transition-colors"
              :class="
                transactionFilter === filter
                  ? 'bg-foreground text-background'
                  : 'text-text-muted hover:bg-secondary hover:text-foreground'
              "
              @click="transactionFilter = filter"
            >
              {{ filter === 'ALL' ? 'All' : filter === 'INCOME' ? 'Income' : 'Expenses' }}
            </button>
          </div>
          <div class="flex items-center gap-2">
            <button
              class="studio-outline-button"
              :disabled="!filteredTransactions.length"
              @click="exportTransactions"
            >
              <Download :size="15" /> Export CSV
            </button>
            <button v-if="admin" class="studio-primary-button" @click="form = 'transaction'">
              <Plus :size="16" /> Add Transaction
            </button>
          </div>
        </header>
        <form
          v-if="form === 'transaction'"
          class="space-y-4 rounded-xl bg-card p-5 ring-1 ring-primary/20"
          @submit.prevent="createTransaction"
        >
          <div class="flex items-center justify-between">
            <h3 class="text-sm font-semibold text-foreground">New Transaction</h3>
            <button
              type="button"
              class="text-text-muted hover:text-foreground"
              @click="form = null"
            >
              ×
            </button>
          </div>
          <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label class="studio-field"
              >Type<select v-model="txDraft.type">
                <option>INCOME</option>
                <option>EXPENSE</option>
              </select></label
            >
            <label class="studio-field"
              >Amount<input
                v-model.number="txDraft.amount"
                type="number"
                min="0.01"
                step="0.01"
                required
            /></label>
          </div>
          <label class="studio-field"
            >Description<input v-model="txDraft.description" required
          /></label>
          <div class="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <label class="studio-field"
              >Date<input v-model="txDraft.date" type="date" required /></label
            ><label class="studio-field"
              >Currency<select v-model="txDraft.currency">
                <option>USD</option>
                <option>PKR</option>
              </select></label
            ><label class="studio-field">Category<input v-model="txDraft.category" /></label>
          </div>
          <div class="flex justify-end gap-2">
            <button
              type="button"
              class="rounded-xl px-4 py-2 text-xs font-medium text-text-muted"
              @click="form = null"
            >
              Cancel</button
            ><button class="studio-primary-button">Add Transaction</button>
          </div>
        </form>
        <div class="overflow-hidden rounded-xl bg-card py-4 text-sm ring-1 ring-foreground/10">
          <div v-if="filteredTransactions.length" class="divide-y divide-border-subtle">
            <template v-for="entry in filteredTransactions" :key="entry.id">
              <form
                v-if="editingTransactionId === entry.id"
                class="space-y-2 border-b border-primary/10 bg-primary/[0.02] px-6 py-3"
                @submit.prevent="updateTransaction(entry)"
              >
                <div class="grid grid-cols-2 gap-2 sm:grid-cols-4">
                  <input
                    v-model="txEditDraft.description"
                    class="col-span-2 rounded-lg border border-border bg-background px-3 py-1.5 text-sm text-foreground outline-none focus:border-primary"
                    placeholder="Description"
                    required
                  />
                  <input
                    v-model="txEditDraft.amount"
                    type="number"
                    min="0.01"
                    step="0.01"
                    class="rounded-lg border border-border bg-background px-3 py-1.5 text-right text-sm text-foreground outline-none focus:border-primary"
                    placeholder="Amount"
                    required
                  />
                  <input
                    v-model="txEditDraft.date"
                    type="date"
                    class="rounded-lg border border-border bg-background px-2 py-1.5 text-sm text-foreground outline-none focus:border-primary"
                    required
                  />
                </div>
                <select
                  v-if="entry.type === 'EXPENSE'"
                  v-model="txEditDraft.category"
                  class="rounded-lg border border-border bg-background px-2 py-1 text-xs text-foreground outline-none focus:border-primary"
                >
                  <option value="">No category</option>
                  <option v-for="(label, value) in categoryLabels" :key="value" :value="value">
                    {{ label }}
                  </option>
                </select>
                <div class="flex justify-end gap-2">
                  <button
                    type="button"
                    class="rounded-lg px-3 py-1 text-[11px] font-medium text-text-muted hover:text-foreground"
                    @click="editingTransactionId = null"
                  >
                    Cancel
                  </button>
                  <button
                    class="rounded-lg bg-primary px-3 py-1 text-[11px] font-semibold text-white transition-colors hover:bg-[#0C2E2C] disabled:opacity-40"
                    :disabled="
                      updatingTransaction ||
                      !txEditDraft.description.trim() ||
                      !txEditDraft.amount ||
                      !txEditDraft.date
                    "
                  >
                    {{ updatingTransaction ? 'Saving…' : 'Save' }}
                  </button>
                </div>
              </form>
              <article
                v-else
                class="group flex items-center gap-4 px-6 py-3.5 transition-colors hover:bg-secondary/30"
              >
                <span
                  class="flex size-9 shrink-0 items-center justify-center rounded-xl"
                  :class="entry.type === 'INCOME' ? 'bg-emerald-500/10' : 'bg-red-500/10'"
                >
                  <ArrowDownLeft
                    v-if="entry.type === 'INCOME'"
                    :size="16"
                    class="text-emerald-500"
                  />
                  <ArrowUpRight v-else :size="16" class="text-red-500" />
                </span>
                <div class="min-w-0 flex-1">
                  <p class="truncate text-sm font-medium text-foreground">
                    {{ entry.description }}
                  </p>
                  <p class="truncate text-xs text-text-muted">
                    {{ entry.category ? categoryLabels[entry.category] || entry.category : ''
                    }}{{ entry.projectName ? ` · ${entry.projectName}` : ''
                    }}{{ entry.clientName ? ` · ${entry.clientName}` : '' }}
                  </p>
                </div>
                <time class="hidden shrink-0 text-xs text-text-muted sm:block">{{
                  date(entry.date)
                }}</time>
                <strong
                  class="shrink-0 text-sm font-semibold tabular-nums"
                  :class="entry.type === 'INCOME' ? 'text-emerald-500' : 'text-foreground'"
                >
                  {{ entry.type === 'INCOME' ? '+' : '-' }}{{ money(entry.amount, entry.currency) }}
                </strong>
                <button
                  v-if="admin"
                  class="flex size-7 shrink-0 items-center justify-center rounded-md text-text-muted/0 transition-all group-hover:text-text-muted hover:!bg-secondary hover:!text-foreground"
                  aria-label="Edit transaction"
                  @click="editTransaction(entry)"
                >
                  <Pencil :size="14" />
                </button>
                <button
                  v-if="admin"
                  class="flex size-7 shrink-0 items-center justify-center rounded-md text-text-muted/0 transition-all group-hover:text-text-muted hover:!bg-red-500/10 hover:!text-red-500"
                  aria-label="Delete transaction"
                  @click="removeTx(entry.id)"
                >
                  <Trash2 :size="14" />
                </button>
              </article>
            </template>
          </div>
          <div v-else class="py-16 text-center">
            <Receipt :size="40" class="mx-auto text-text-muted/20" />
            <p class="mt-3 text-sm text-text-muted">No transactions found</p>
          </div>
        </div>
      </section>

      <section v-else-if="tab === 'invoices'" class="space-y-4">
        <header class="flex items-center justify-between">
          <p class="text-sm text-text-muted">{{ invoices.length }} invoices</p>
          <button v-if="admin" class="studio-primary-button" @click="form = 'invoice'">
            <FilePlus2 :size="16" /> New Invoice
          </button>
        </header>
        <form
          v-if="form === 'invoice'"
          class="space-y-4 rounded-xl bg-card p-5 ring-1 ring-primary/20"
          @submit.prevent="createInvoice"
        >
          <div class="flex items-center justify-between">
            <h3 class="text-sm font-semibold text-foreground">New Invoice</h3>
            <button
              type="button"
              class="text-text-muted hover:text-foreground"
              @click="form = null"
            >
              ×
            </button>
          </div>
          <div class="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <label class="studio-field"
              >Client *<select v-model="invoiceDraft.client_id" required>
                <option value="">Select...</option>
                <option v-for="client in clients" :key="client.id" :value="client.id">
                  {{ client.name }}
                </option>
              </select></label
            >
            <label class="studio-field"
              >Currency<select v-model="invoiceDraft.currency">
                <option>USD</option>
                <option>PKR</option>
              </select></label
            >
            <label class="studio-field"
              >Due Date *<input v-model="invoiceDraft.due_date" type="date" required
            /></label>
          </div>
          <div class="grid grid-cols-12 items-end gap-2">
            <label class="studio-field col-span-6"
              >Line item<input
                v-model="invoiceDraft.description"
                placeholder="Description"
                required
            /></label>
            <label class="studio-field col-span-2"
              >Qty<input
                v-model.number="invoiceDraft.quantity"
                type="number"
                min="0.01"
                step="0.01"
                required
            /></label>
            <label class="studio-field col-span-2"
              >Rate<input
                v-model.number="invoiceDraft.rate"
                type="number"
                min="0.01"
                step="0.01"
                required
            /></label>
            <strong class="col-span-2 pb-2 text-right text-sm tabular-nums">{{
              money(invoiceDraft.quantity * invoiceDraft.rate, invoiceDraft.currency)
            }}</strong>
          </div>
          <label class="studio-field"
            >Notes<input v-model="invoiceDraft.notes" placeholder="Payment terms, notes..."
          /></label>
          <div class="flex justify-end gap-2">
            <button
              type="button"
              class="rounded-xl px-4 py-2 text-xs font-medium text-text-muted"
              @click="form = null"
            >
              Cancel</button
            ><button class="studio-primary-button">Create Invoice</button>
          </div>
        </form>
        <div class="overflow-x-auto rounded-xl bg-card py-4 ring-1 ring-foreground/10">
          <div v-if="invoices.length" class="min-w-[820px] divide-y divide-border-subtle">
            <div
              class="grid grid-cols-12 gap-4 px-6 py-3 text-[11px] font-medium uppercase tracking-wider text-text-muted"
            >
              <span class="col-span-2">Invoice</span><span class="col-span-3">Client</span
              ><span class="col-span-2">Project</span
              ><span class="col-span-1 text-right">Amount</span
              ><span class="col-span-2 text-center">Status</span
              ><span class="col-span-2 text-right">Due Date</span>
            </div>
            <article
              v-for="invoice in invoices"
              :key="invoice.id"
              class="grid grid-cols-12 items-center gap-4 border-b border-border-subtle bg-card px-6 py-3.5 transition-colors last:border-0 hover:bg-secondary/30"
            >
              <strong class="col-span-2 font-mono text-sm text-foreground">{{
                invoice.invoiceNumber
              }}</strong>
              <span class="col-span-3 truncate text-sm text-foreground">{{
                invoice.clientName
              }}</span>
              <span class="col-span-2 truncate text-sm text-text-muted">{{
                invoice.projectName || '—'
              }}</span>
              <strong class="col-span-1 text-right text-sm tabular-nums text-foreground">{{
                money(invoice.total, invoice.currency)
              }}</strong>
              <span class="col-span-2 flex justify-center">
                <select
                  v-if="admin"
                  :value="invoice.status"
                  class="rounded-full border-0 px-2.5 py-1 text-[11px] font-medium outline-none"
                  :class="statusTone(invoice.status)"
                  @change="setStatus(invoice, ($event.target as HTMLSelectElement).value)"
                >
                  <option
                    v-for="status in ['DRAFT', 'SENT', 'PAID', 'OVERDUE', 'CANCELLED']"
                    :key="status"
                  >
                    {{ status }}
                  </option>
                </select>
                <span
                  v-else
                  class="rounded-full px-2.5 py-1 text-[11px] font-medium"
                  :class="statusTone(invoice.status)"
                  >{{ invoice.status.charAt(0) + invoice.status.slice(1).toLowerCase() }}</span
                >
              </span>
              <span class="col-span-2 flex items-center justify-end gap-1">
                <time
                  class="text-sm tabular-nums"
                  :class="
                    invoice.status === 'OVERDUE' ? 'font-medium text-red-500' : 'text-text-muted'
                  "
                  >{{ date(invoice.dueDate) }}</time
                >
                <span class="ml-2 flex gap-1">
                  <NuxtLink
                    :to="`/finance/invoices/${invoice.id}/print`"
                    class="grid size-7 place-items-center rounded-lg text-text-muted hover:bg-muted"
                    aria-label="Print invoice"
                    ><Printer :size="14"
                  /></NuxtLink>
                  <button
                    v-if="admin && ['SENT', 'OVERDUE'].includes(invoice.status)"
                    class="grid size-7 place-items-center rounded-lg text-text-muted hover:bg-muted"
                    @click="
                      selectedInvoice = invoice;
                      payment.amount = invoice.balance;
                      form = 'payment';
                    "
                  >
                    <WalletCards :size="14" />
                  </button>
                </span>
              </span>
            </article>
          </div>
          <div v-else class="py-16 text-center">
            <FileText :size="40" class="mx-auto text-text-muted/20" />
            <p class="mt-3 text-sm text-text-muted">No invoices yet</p>
          </div>
        </div>
      </section>

      <section v-else-if="tab === 'pnl' && selectedSummary" class="space-y-5">
        <nav v-if="currencies.length > 1" class="inline-flex rounded-lg border border-border p-0.5">
          <button
            v-for="currency in currencies"
            :key="currency"
            class="rounded-md px-2.5 py-1 text-xs font-semibold"
            :class="pnlCurrency === currency ? 'bg-foreground text-background' : 'text-text-muted'"
            @click="pnlCurrency = currency"
          >
            {{ currency }}
          </button>
        </nav>
        <div class="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <article
            v-for="card in [
              { label: 'Total Income', value: selectedSummary.yearly_income, tone: 'income' },
              { label: 'Total Expenses', value: selectedSummary.yearly_expense, tone: 'expense' },
              { label: 'Net Profit', value: selectedSummary.yearly_profit, tone: 'income' },
            ]"
            :key="card.label"
            class="rounded-xl bg-card p-4 ring-1 ring-foreground/10"
          >
            <p class="text-[10px] font-semibold uppercase tracking-wider text-text-muted">
              {{ card.label }}
            </p>
            <strong
              class="mt-1 block text-xl font-semibold tracking-tight"
              :class="card.tone === 'expense' ? 'text-red-500' : 'text-emerald-600'"
              >{{ money(card.value, pnlCurrency) }}</strong
            >
          </article>
          <article class="rounded-xl bg-card p-4 ring-1 ring-foreground/10">
            <p class="text-[10px] font-semibold uppercase tracking-wider text-text-muted">
              Avg Margin
            </p>
            <strong class="mt-1 block text-xl font-semibold tracking-tight text-accent-brand"
              >{{ averageMargin.toFixed(1) }}%</strong
            >
          </article>
        </div>
        <div class="grid gap-5 lg:grid-cols-3">
          <article class="rounded-xl bg-card p-5 ring-1 ring-foreground/10 lg:col-span-2">
            <header class="mb-6 flex items-center gap-2">
              <span
                class="grid size-7 place-items-center rounded-lg bg-emerald-500/10 text-emerald-600"
                ><TrendingUp :size="15"
              /></span>
              <h2 class="text-[15px] font-semibold">Profit &amp; Loss Trend</h2>
            </header>
            <div class="flex h-[280px] items-end gap-2 border-b border-border-subtle px-2 pb-7">
              <div
                v-for="month in pnlMonths"
                :key="month.label"
                class="relative flex h-full flex-1 items-end justify-center gap-1"
              >
                <span
                  class="w-[38%] rounded-t bg-emerald-500"
                  :style="{
                    height: `${Math.max(month.income ? 2 : 0, (month.income / pnlMax) * 100)}%`,
                  }"
                />
                <span
                  class="w-[38%] rounded-t bg-red-500"
                  :style="{
                    height: `${Math.max(month.expense ? 2 : 0, (month.expense / pnlMax) * 100)}%`,
                  }"
                />
                <small class="absolute -bottom-6 font-mono text-[9px] text-text-muted">{{
                  month.label
                }}</small>
              </div>
            </div>
            <div class="mt-4 flex justify-center gap-6 text-xs text-text-muted">
              <span><i class="mr-1.5 inline-block size-2 rounded-full bg-emerald-500" />Income</span
              ><span><i class="mr-1.5 inline-block size-2 rounded-full bg-red-500" />Expenses</span>
            </div>
          </article>
          <article class="rounded-xl bg-card p-5 ring-1 ring-foreground/10">
            <header class="mb-5 flex items-center gap-2">
              <span
                class="grid size-7 place-items-center rounded-lg bg-violet-500/10 text-violet-600"
                ><PieChart :size="15"
              /></span>
              <h2 class="text-[15px] font-semibold">Expense Breakdown</h2>
            </header>
            <div v-if="expenseBreakdown.length" class="space-y-3">
              <div
                v-for="(item, index) in expenseBreakdown"
                :key="item.category"
                class="space-y-1.5"
              >
                <div class="flex items-center justify-between gap-3 text-xs">
                  <span class="font-medium">{{ item.category }}</span
                  ><strong class="font-mono text-[10px]">{{
                    money(item.amount, pnlCurrency)
                  }}</strong>
                </div>
                <div class="h-2 overflow-hidden rounded-full bg-secondary">
                  <span
                    class="block h-full rounded-full"
                    :class="index % 2 ? 'bg-violet-500' : 'bg-accent-brand'"
                    :style="{
                      width: `${(item.amount / (expenseBreakdown[0]?.amount || 1)) * 100}%`,
                    }"
                  />
                </div>
              </div>
            </div>
            <div v-else class="py-12 text-center">
              <PieChart :size="32" class="mx-auto text-text-faint/20" />
              <p class="mt-2 text-xs text-text-muted">No expense data</p>
            </div>
          </article>
        </div>
      </section>
      <section v-else class="space-y-4">
        <header class="flex flex-wrap items-center justify-between gap-3">
          <p class="text-sm text-text-muted">{{ recurring.length }} active subscriptions</p>
          <div v-if="admin" class="flex items-center gap-2">
            <button class="studio-outline-button" @click="postDue">Post due cycles</button>
            <button class="studio-primary-button" @click="recurringOpen = true">
              <Plus :size="15" /> Add Recurring
            </button>
          </div>
        </header>
        <p
          v-if="postResult"
          class="rounded-xl border border-emerald-500/20 bg-emerald-500/10 px-4 py-3 text-xs text-emerald-600"
        >
          {{ postResult }}
        </p>
        <div
          v-if="recurring.length"
          class="divide-y divide-border-subtle overflow-hidden rounded-xl bg-card py-4 ring-1 ring-foreground/10"
        >
          <article
            v-for="entry in recurring"
            :key="entry.id"
            class="group flex items-center justify-between gap-4 p-5 hover:bg-secondary/30"
          >
            <div class="flex min-w-0 items-center gap-3">
              <span class="grid size-10 place-items-center rounded-xl bg-blue-500/10 text-blue-500"
                ><RefreshCw :size="16"
              /></span>
              <div class="min-w-0">
                <strong class="block truncate text-sm">{{ entry.name }}</strong>
                <p class="mt-1 truncate text-xs text-text-muted">
                  {{ entry.vendorName ? `${entry.vendorName} · ` : '' }}{{ entry.interval }} ·
                  {{ entry.category }}
                </p>
              </div>
            </div>
            <div class="flex items-center gap-3">
              <div class="text-right">
                <strong class="text-sm">{{ money(entry.amount, entry.currency) }}</strong>
                <p class="mt-1 text-xs text-text-muted">Next: {{ date(entry.nextDueDate) }}</p>
              </div>
              <button
                v-if="admin"
                class="studio-icon-button text-red-500"
                aria-label="Remove recurring expense"
                @click="removeRecurring(entry.id)"
              >
                <Trash2 :size="14" />
              </button>
            </div>
          </article>
        </div>
        <div
          v-else
          class="flex min-h-64 flex-col items-center justify-center rounded-2xl border border-dashed border-border bg-card"
        >
          <RefreshCw :size="40" class="text-text-faint/20" />
          <h2 class="mt-3 text-sm font-semibold text-foreground">No recurring expenses</h2>
          <p class="mt-1 text-xs text-text-muted">
            Add subscriptions and recurring costs to track them.
          </p>
        </div>
      </section>
    </template>

    <DeliveryFieldDialog
      :open="form === 'payment'"
      :title="
        form === 'invoice'
          ? 'New invoice'
          : form === 'payment'
            ? 'Record payment'
            : 'New transaction'
      "
      @close="form = null"
    >
      <form v-if="form === 'invoice'" class="studio-form-grid" @submit.prevent="createInvoice">
        <label
          >Client<select v-model="invoiceDraft.client_id" required>
            <option value="">Select client</option>
            <option v-for="client in clients" :key="client.id" :value="client.id">
              {{ client.name }}
            </option>
          </select></label
        >
        <div class="grid grid-cols-2 gap-3">
          <label
            >Currency<select v-model="invoiceDraft.currency">
              <option>USD</option>
              <option>PKR</option>
            </select></label
          ><label>Due date<input v-model="invoiceDraft.due_date" type="date" required /></label>
        </div>
        <label>Line item description<input v-model="invoiceDraft.description" required /></label>
        <div class="grid grid-cols-2 gap-3">
          <label
            >Quantity<input
              v-model.number="invoiceDraft.quantity"
              type="number"
              min="0.01"
              step="0.01"
              required /></label
          ><label
            >Rate<input
              v-model.number="invoiceDraft.rate"
              type="number"
              min="0.01"
              step="0.01"
              required
          /></label>
        </div>
        <label
          >Tax<input v-model.number="invoiceDraft.tax" type="number" min="0" step="0.01" /></label
        ><button class="studio-primary-button">Create draft</button>
      </form>
      <form
        v-else-if="form === 'transaction'"
        class="studio-form-grid"
        @submit.prevent="createTransaction"
      >
        <div class="grid grid-cols-2 gap-3">
          <label
            >Type<select v-model="txDraft.type">
              <option>INCOME</option>
              <option>EXPENSE</option>
            </select></label
          ><label
            >Currency<select v-model="txDraft.currency">
              <option>USD</option>
              <option>PKR</option>
            </select></label
          >
        </div>
        <label>Description<input v-model="txDraft.description" required /></label>
        <div class="grid grid-cols-2 gap-3">
          <label
            >Amount<input
              v-model.number="txDraft.amount"
              type="number"
              min="0.01"
              step="0.01"
              required /></label
          ><label>Date<input v-model="txDraft.date" type="date" required /></label>
        </div>
        <label>Category<input v-model="txDraft.category" /></label
        ><button class="studio-primary-button">Enter transaction</button>
      </form>
      <form v-else class="studio-form-grid" @submit.prevent="addPayment">
        <p v-if="selectedInvoice" class="text-sm text-text-muted">
          {{ selectedInvoice.invoiceNumber }} ·
          {{ money(selectedInvoice.balance, selectedInvoice.currency) }} due
        </p>
        <label
          >Amount<input
            v-model.number="payment.amount"
            type="number"
            min="0.01"
            step="0.01"
            required /></label
        ><label>Method<input v-model="payment.method" /></label
        ><label>Note<input v-model="payment.note" /></label
        ><button class="studio-primary-button">Record payment</button>
      </form>
    </DeliveryFieldDialog>

    <DeliveryFieldDialog
      :open="recurringOpen"
      title="New Recurring Expense"
      @close="recurringOpen = false"
    >
      <form class="studio-form-grid" @submit.prevent="createRecurring">
        <div class="grid gap-3 sm:grid-cols-2">
          <label>Name<input v-model="recurringDraft.name" required /></label
          ><label>Vendor<input v-model="recurringDraft.vendor_name" /></label>
        </div>
        <div class="grid gap-3 sm:grid-cols-2">
          <label
            >Amount<input
              v-model.number="recurringDraft.amount"
              type="number"
              min="0.01"
              step="0.01"
              required /></label
          ><label
            >Currency<select v-model="recurringDraft.currency">
              <option>USD</option>
              <option>PKR</option>
            </select></label
          >
        </div>
        <div class="grid gap-3 sm:grid-cols-2">
          <label
            >Category<select v-model="recurringDraft.category">
              <option
                v-for="value in [
                  'SALARIES',
                  'SUBSCRIPTIONS',
                  'OFFICE',
                  'MARKETING',
                  'HOSTING',
                  'SOFTWARE',
                  'HARDWARE',
                  'TRAVEL',
                  'UTILITIES',
                  'MISCELLANEOUS',
                ]"
                :key="value"
              >
                {{ value }}
              </option>
            </select></label
          ><label
            >Interval<select v-model="recurringDraft.interval">
              <option value="monthly">Monthly</option>
              <option value="quarterly">Quarterly</option>
              <option value="yearly">Yearly</option>
            </select></label
          >
        </div>
        <label>Next due<input v-model="recurringDraft.next_due_date" type="date" required /></label>
        <button class="studio-primary-button">Add Recurring</button>
      </form>
    </DeliveryFieldDialog>
  </section>
</template>
