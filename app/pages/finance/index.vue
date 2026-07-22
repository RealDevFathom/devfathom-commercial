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
import type { FinanceTab } from '~/types/finance-bootstrap';
import type { CurrencySummary, Invoice, InvoiceItem, Transaction } from '~/types/firm';

useHead({ title: 'Finance · DevFathom Hub' });
const api = useFirm();
const { user } = useAuth();
const allowed = computed(() => user.value?.role === 'ADMIN');
const admin = allowed;
const {
  pending: actionPending,
  error: actionError,
  success: actionSuccess,
  clear: clearAction,
  run: runAction,
} = useFirmAction();
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
const {
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
} = await useFinanceData({
  enabled: allowed.value,
  cacheKey: user.value?.id || 'anonymous',
});
const form = ref<'invoice' | 'transaction' | 'payment' | null>(null);
const selectedInvoice = ref<Invoice | null>(null);
const recurringOpen = ref(false);
const editingTransactionId = ref<string | null>(null);
const editingInvoiceId = ref<string | null>(null);
const invoiceDraft = reactive({
  client_id: '',
  currency: 'USD',
  due_date: '',
  tax: 0,
  notes: '',
  items: [{ description: '', quantity: 1, rate: 0 }] as InvoiceItem[],
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

watch(tab, (value) => void ensureTab(value));
watch(
  summary,
  (value) => {
    if (value.length && !value.some((group) => group.currency === pnlCurrency.value)) {
      pnlCurrency.value = value[0]!.currency;
    }
  },
  { immediate: true }
);

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
    const entries = pnlTransactions.value.filter((entry) => {
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
  for (const entry of pnlTransactions.value) {
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
const invoiceDraftTotal = computed(() =>
  invoiceDraft.items.reduce(
    (total, item) => total + Number(item.quantity || 0) * Number(item.rate || 0),
    0
  )
);
const outstandingInvoiceCount = computed(() =>
  summary.value.reduce((total, group) => total + Number(group.outstanding_count), 0)
);

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
    subtitle: `${outstandingInvoiceCount.value} invoices`,
    icon: FileText,
    tone: 'amber',
  },
]);

function resetInvoiceDraft() {
  Object.assign(invoiceDraft, {
    client_id: '',
    currency: invoiceDraft.currency,
    due_date: '',
    tax: 0,
    notes: '',
    items: [{ description: '', quantity: 1, rate: 0 }],
  });
  editingInvoiceId.value = null;
}

function openNewInvoice() {
  resetInvoiceDraft();
  form.value = 'invoice';
}

function editInvoice(invoice: Invoice) {
  editingInvoiceId.value = invoice.id;
  Object.assign(invoiceDraft, {
    client_id: invoice.clientId,
    currency: invoice.currency,
    due_date: new Date(invoice.dueDate).toISOString().slice(0, 10),
    tax: Number(invoice.tax),
    notes: invoice.notes || '',
    items: invoice.items.map((item) => ({
      description: item.description,
      quantity: Number(item.quantity),
      rate: Number(item.rate),
    })),
  });
  form.value = 'invoice';
}

function closeInvoiceForm() {
  if (actionPending.value) return;
  form.value = null;
  resetInvoiceDraft();
}

async function saveInvoice() {
  const editingId = editingInvoiceId.value;
  const result = await runAction(
    editingId ? 'Saving invoice…' : 'Creating invoice…',
    async () => {
      const mutableFields = {
        due_date: new Date(invoiceDraft.due_date).toISOString(),
        tax: invoiceDraft.tax,
        notes: invoiceDraft.notes || null,
        items: invoiceDraft.items.map((item) => ({
          description: item.description.trim(),
          quantity: Number(item.quantity),
          rate: Number(item.rate),
        })),
      };
      const saved = editingId
        ? await api.updateInvoice(editingId, mutableFields)
        : await api.createInvoice({
            ...mutableFields,
            client_id: invoiceDraft.client_id,
            currency: invoiceDraft.currency,
          });
      await refreshAfterMutation('invoice');
      return saved;
    },
    {
      success: editingId ? 'Invoice updated.' : 'Invoice draft created.',
      error: editingId ? 'The invoice could not be updated.' : 'The invoice could not be created.',
    }
  );
  if (!result) return;
  form.value = null;
  resetInvoiceDraft();
}
async function createTransaction() {
  const result = await runAction(
    'Adding transaction…',
    async () => {
      const created = await api.createTransaction({
        ...txDraft,
        date: new Date(txDraft.date).toISOString(),
        category: txDraft.category || null,
      });
      await refreshAfterMutation('transaction');
      return created;
    },
    { success: 'Transaction added.', error: 'The transaction could not be added.' }
  );
  if (!result) return;
  form.value = null;
  Object.assign(txDraft, {
    type: 'EXPENSE',
    amount: 0,
    currency: txDraft.currency,
    category: '',
    description: '',
    date: '',
  });
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
  const result = await runAction(
    'Saving transaction…',
    async () => {
      const updated = await api.updateTransaction(entry.id, {
        description: txEditDraft.description.trim(),
        amount: Number(txEditDraft.amount),
        date: new Date(txEditDraft.date).toISOString(),
        category: entry.type === 'EXPENSE' ? txEditDraft.category || null : null,
      });
      await refreshAfterMutation('transaction');
      return updated;
    },
    { success: 'Transaction updated.', error: 'The transaction could not be updated.' }
  );
  if (result) editingTransactionId.value = null;
}
async function addPayment() {
  if (!selectedInvoice.value) return;
  const result = await runAction(
    'Recording payment…',
    async () => {
      const recorded = await api.addPayment(selectedInvoice.value!.id, { ...payment });
      await refreshAfterMutation('invoice');
      return recorded;
    },
    { success: 'Payment recorded.', error: 'The payment could not be recorded.' }
  );
  if (!result) return;
  form.value = null;
  selectedInvoice.value = null;
  Object.assign(payment, { amount: 0, method: '', note: '' });
}
async function openPayments(invoice: Invoice) {
  const result = await runAction('Loading invoice…', () => api.invoice(invoice.id), {
    error: 'The invoice details could not be loaded.',
  });
  if (!result) return;
  selectedInvoice.value = result;
  payment.amount = result.balance;
  form.value = 'payment';
}

async function removeInvoicePayment(id: string) {
  if (!selectedInvoice.value || !confirm('Delete this payment?')) return;
  const invoiceId = selectedInvoice.value.id;
  const result = await runAction(
    'Deleting payment…',
    async () => {
      const removed = await api.removePayment(id);
      const refreshed = await api.invoice(invoiceId);
      selectedInvoice.value = refreshed;
      payment.amount = refreshed.balance;
      await refreshAfterMutation('invoice');
      return removed;
    },
    { success: 'Payment deleted.', error: 'The payment could not be deleted.' }
  );
  if (!result) return;
}

async function markOverdue() {
  await runAction(
    'Checking overdue invoices…',
    async () => {
      const result = await api.markOverdueInvoices();
      await refreshAfterMutation('invoice');
      return result;
    },
    {
      success: (result) =>
        result.count
          ? `Marked ${result.count} invoice${result.count === 1 ? '' : 's'} overdue.`
          : 'No invoices are newly overdue.',
      error: 'Overdue invoices could not be checked.',
    }
  );
}
async function removeTx(id: string) {
  if (confirm('Delete this transaction?')) {
    await runAction(
      'Deleting transaction…',
      async () => {
        const removed = await api.removeTransaction(id);
        await refreshAfterMutation('transaction');
        return removed;
      },
      { success: 'Transaction deleted.', error: 'The transaction could not be deleted.' }
    );
  }
}
async function setStatus(invoice: Invoice, value: string) {
  await runAction(
    'Updating invoice status…',
    async () => {
      const updated = await api.updateInvoiceStatus(invoice.id, value);
      await refreshAfterMutation('invoice');
      return updated;
    },
    {
      success: `Invoice marked ${value.toLowerCase()}.`,
      error: 'The invoice status could not be updated.',
    }
  );
}
async function createRecurring() {
  const result = await runAction(
    'Adding recurring expense…',
    async () => {
      const created = await api.createRecurringExpense({
        ...recurringDraft,
        next_due_date: new Date(recurringDraft.next_due_date).toISOString(),
        vendor_name: recurringDraft.vendor_name || null,
      });
      await refreshAfterMutation('recurring');
      return created;
    },
    { success: 'Recurring expense added.', error: 'The recurring expense could not be added.' }
  );
  if (!result) return;
  recurringOpen.value = false;
  Object.assign(recurringDraft, {
    name: '',
    vendor_name: '',
    amount: 0,
    currency: recurringDraft.currency,
    category: 'SUBSCRIPTIONS',
    interval: 'monthly',
    next_due_date: '',
  });
}
async function removeRecurring(id: string) {
  if (!confirm('Remove this recurring expense?')) return;
  await runAction(
    'Removing recurring expense…',
    async () => {
      const removed = await api.removeRecurringExpense(id);
      await refreshAfterMutation('recurring');
      return removed;
    },
    { success: 'Recurring expense removed.', error: 'The recurring expense could not be removed.' }
  );
}
async function postDue() {
  await runAction(
    'Posting due cycles…',
    async () => {
      const result = await api.postDueRecurringExpenses();
      await refreshAfterMutation('recurring-post');
      return result;
    },
    {
      success: (result) =>
        result.posted
          ? `Posted ${result.posted} transaction${result.posted === 1 ? '' : 's'} from due cycles.`
          : 'Nothing is due. Recurring expenses are up to date.',
      error: 'Due recurring expenses could not be posted.',
    }
  );
}

function addInvoiceItem() {
  invoiceDraft.items.push({ description: '', quantity: 1, rate: 0 });
}

function removeInvoiceItem(index: number) {
  if (invoiceDraft.items.length > 1) invoiceDraft.items.splice(index, 1);
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

    <FirmActionFeedback
      v-if="allowed"
      :busy="Boolean(actionPending)"
      :busy-label="actionPending"
      :error="actionError"
      :success="actionSuccess"
      @dismiss="clearAction"
    />

    <DeliveryFieldState v-if="!allowed" error="Finance is available to administrators only." />
    <DeliveryFieldState
      v-else-if="loading || error"
      :loading="loading"
      :error="error"
      action="Try again"
      @action="refreshTransactionsAndSummary"
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

      <DeliveryFieldState v-if="activeLoad === tab" :loading="true" />
      <DeliveryFieldState
        v-else-if="tabError"
        :error="tabError"
        action="Try again"
        @action="ensureTab(tab, true)"
      />

      <section v-else-if="tab === 'transactions'" class="space-y-4">
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
            <button
              v-if="admin"
              class="studio-primary-button"
              :disabled="Boolean(actionPending)"
              @click="form = 'transaction'"
            >
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
            ><button class="studio-primary-button" :disabled="Boolean(actionPending)">
              Add Transaction
            </button>
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
                      Boolean(actionPending) ||
                      !txEditDraft.description.trim() ||
                      !txEditDraft.amount ||
                      !txEditDraft.date
                    "
                  >
                    {{ actionPending === 'Saving transaction…' ? 'Saving…' : 'Save' }}
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
                  :disabled="Boolean(actionPending)"
                  @click="editTransaction(entry)"
                >
                  <Pencil :size="14" />
                </button>
                <button
                  v-if="admin"
                  class="flex size-7 shrink-0 items-center justify-center rounded-md text-text-muted/0 transition-all group-hover:text-text-muted hover:!bg-red-500/10 hover:!text-red-500"
                  aria-label="Delete transaction"
                  :disabled="Boolean(actionPending)"
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
        <header class="flex flex-wrap items-center justify-between gap-3">
          <p class="text-sm text-text-muted">{{ invoices.length }} invoices</p>
          <div v-if="admin" class="flex items-center gap-2">
            <button
              class="studio-outline-button"
              :disabled="Boolean(actionPending)"
              title="Flag sent invoices that are past their due date"
              @click="markOverdue"
            >
              <RefreshCw :size="15" /> Check overdue
            </button>
            <button
              class="studio-primary-button"
              :disabled="Boolean(actionPending)"
              @click="openNewInvoice"
            >
              <FilePlus2 :size="16" /> New Invoice
            </button>
          </div>
        </header>
        <form
          v-if="form === 'invoice'"
          class="space-y-4 rounded-xl bg-card p-5 ring-1 ring-primary/20"
          @submit.prevent="saveInvoice"
        >
          <div class="flex items-center justify-between">
            <h3 class="text-sm font-semibold text-foreground">
              {{ editingInvoiceId ? 'Edit Invoice' : 'New Invoice' }}
            </h3>
            <button
              type="button"
              class="text-text-muted hover:text-foreground"
              :disabled="Boolean(actionPending)"
              @click="closeInvoiceForm"
            >
              ×
            </button>
          </div>
          <div class="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <label class="studio-field"
              >Client *<select
                v-model="invoiceDraft.client_id"
                required
                :disabled="Boolean(editingInvoiceId)"
              >
                <option value="">Select...</option>
                <option v-for="client in clients" :key="client.id" :value="client.id">
                  {{ client.name }}
                </option>
              </select></label
            >
            <label class="studio-field"
              >Currency<select
                v-model="invoiceDraft.currency"
                :disabled="Boolean(editingInvoiceId)"
              >
                <option>USD</option>
                <option>PKR</option>
              </select></label
            >
            <label class="studio-field"
              >Due Date *<input v-model="invoiceDraft.due_date" type="date" required
            /></label>
          </div>
          <div class="space-y-2">
            <div
              v-for="(item, index) in invoiceDraft.items"
              :key="index"
              class="grid grid-cols-1 items-end gap-2 rounded-xl border border-border-subtle p-3 sm:grid-cols-12"
            >
              <label class="studio-field sm:col-span-6"
                >Line item<input v-model="item.description" placeholder="Description" required
              /></label>
              <label class="studio-field sm:col-span-2"
                >Qty<input
                  v-model.number="item.quantity"
                  type="number"
                  min="0.01"
                  step="0.01"
                  required
              /></label>
              <label class="studio-field sm:col-span-2"
                >Rate<input
                  v-model.number="item.rate"
                  type="number"
                  min="0.01"
                  step="0.01"
                  required
              /></label>
              <div
                class="flex items-center justify-between gap-2 pb-2 sm:col-span-2 sm:justify-end"
              >
                <strong class="text-sm tabular-nums">{{
                  money(Number(item.quantity) * Number(item.rate), invoiceDraft.currency)
                }}</strong>
                <button
                  v-if="invoiceDraft.items.length > 1"
                  type="button"
                  class="grid size-7 place-items-center rounded-lg text-text-muted hover:bg-red-500/10 hover:text-red-500"
                  aria-label="Remove line item"
                  @click="removeInvoiceItem(index)"
                >
                  <Trash2 :size="13" />
                </button>
              </div>
            </div>
            <button
              type="button"
              class="inline-flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs font-medium text-text-muted hover:bg-secondary hover:text-foreground"
              @click="addInvoiceItem"
            >
              <Plus :size="13" /> Add line item
            </button>
          </div>
          <div class="grid gap-3 sm:grid-cols-[1fr_160px]">
            <label class="studio-field"
              >Notes<input v-model="invoiceDraft.notes" placeholder="Payment terms, notes..."
            /></label>
            <label class="studio-field"
              >Tax<input v-model.number="invoiceDraft.tax" type="number" min="0" step="0.01"
            /></label>
          </div>
          <div class="flex justify-end border-t border-border-subtle pt-3 text-sm">
            <span class="text-text-muted">Subtotal&nbsp;</span>
            <strong class="tabular-nums">{{
              money(invoiceDraftTotal, invoiceDraft.currency)
            }}</strong>
          </div>
          <div class="flex justify-end gap-2">
            <button
              type="button"
              class="rounded-xl px-4 py-2 text-xs font-medium text-text-muted"
              :disabled="Boolean(actionPending)"
              @click="closeInvoiceForm"
            >
              Cancel</button
            ><button class="studio-primary-button" :disabled="Boolean(actionPending)">
              {{
                actionPending === 'Saving invoice…'
                  ? 'Saving…'
                  : actionPending === 'Creating invoice…'
                    ? 'Creating…'
                    : editingInvoiceId
                      ? 'Save Invoice'
                      : 'Create Invoice'
              }}
            </button>
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
                  :disabled="Boolean(actionPending)"
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
                  <button
                    v-if="admin && ['DRAFT', 'SENT'].includes(invoice.status)"
                    class="grid size-7 place-items-center rounded-lg text-text-muted hover:bg-muted"
                    :disabled="Boolean(actionPending)"
                    aria-label="Edit invoice"
                    @click="editInvoice(invoice)"
                  >
                    <Pencil :size="14" />
                  </button>
                  <NuxtLink
                    :to="`/finance/invoices/${invoice.id}/print`"
                    class="grid size-7 place-items-center rounded-lg text-text-muted hover:bg-muted"
                    aria-label="Print invoice"
                    ><Printer :size="14"
                  /></NuxtLink>
                  <button
                    v-if="admin && ['SENT', 'OVERDUE', 'PAID'].includes(invoice.status)"
                    class="grid size-7 place-items-center rounded-lg text-text-muted hover:bg-muted"
                    :disabled="Boolean(actionPending)"
                    aria-label="Manage payments"
                    @click="openPayments(invoice)"
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
      <section
        v-else-if="tab === 'pnl'"
        class="flex min-h-64 flex-col items-center justify-center rounded-2xl border border-dashed border-border bg-card"
      >
        <PieChart :size="40" class="text-text-faint/20" />
        <h2 class="mt-3 text-sm font-semibold text-foreground">No P&amp;L data yet</h2>
        <p class="mt-1 max-w-sm text-center text-xs text-text-muted">
          Add an income or expense transaction to start the report.
        </p>
      </section>
      <section v-else-if="tab === 'recurring'" class="space-y-4">
        <header class="flex flex-wrap items-center justify-between gap-3">
          <p class="text-sm text-text-muted">{{ recurring.length }} active subscriptions</p>
          <div v-if="admin" class="flex items-center gap-2">
            <button
              class="studio-outline-button"
              :disabled="Boolean(actionPending)"
              @click="postDue"
            >
              Post due cycles
            </button>
            <button
              class="studio-primary-button"
              :disabled="Boolean(actionPending)"
              @click="recurringOpen = true"
            >
              <Plus :size="15" /> Add Recurring
            </button>
          </div>
        </header>
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
                :disabled="Boolean(actionPending)"
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
      title="Payments and balance"
      @close="
        if (!actionPending) {
          form = null;
          selectedInvoice = null;
        }
      "
    >
      <div v-if="selectedInvoice" class="space-y-5">
        <FirmActionFeedback
          :busy="['Recording payment…', 'Deleting payment…'].includes(actionPending)"
          :busy-label="actionPending"
          :error="actionError"
          @dismiss="clearAction"
        />
        <p class="text-sm text-text-muted">
          {{ selectedInvoice.invoiceNumber }} ·
          {{ money(selectedInvoice.balance, selectedInvoice.currency) }} due
        </p>
        <div
          v-if="selectedInvoice.payments?.length"
          class="divide-y divide-border-subtle rounded-xl border border-border-subtle"
        >
          <article
            v-for="entry in selectedInvoice.payments"
            :key="entry.id"
            class="flex items-center gap-3 px-3 py-2.5"
          >
            <div class="min-w-0 flex-1">
              <strong class="text-sm tabular-nums">{{
                money(entry.amount, entry.currency)
              }}</strong>
              <p class="truncate text-xs text-text-muted">
                {{ entry.method || 'Payment' }} · {{ date(entry.paidAt)
                }}<template v-if="entry.note"> · {{ entry.note }}</template>
              </p>
            </div>
            <button
              type="button"
              class="grid size-8 place-items-center rounded-lg text-text-muted hover:bg-red-500/10 hover:text-red-500"
              :disabled="Boolean(actionPending)"
              aria-label="Delete payment"
              @click="removeInvoicePayment(entry.id)"
            >
              <Trash2 :size="14" />
            </button>
          </article>
        </div>
        <DeliveryFieldState v-else empty="No payments recorded." />
        <form
          v-if="selectedInvoice.balance > 0 && ['SENT', 'OVERDUE'].includes(selectedInvoice.status)"
          class="studio-form-grid border-t border-border-subtle pt-4"
          @submit.prevent="addPayment"
        >
          <label
            >Amount<input
              v-model.number="payment.amount"
              type="number"
              min="0.01"
              :max="selectedInvoice.balance"
              step="0.01"
              required /></label
          ><label>Method<input v-model="payment.method" /></label
          ><label>Note<input v-model="payment.note" /></label
          ><button class="studio-primary-button" :disabled="Boolean(actionPending)">
            {{ actionPending === 'Recording payment…' ? 'Recording…' : 'Record payment' }}
          </button>
        </form>
      </div>
    </DeliveryFieldDialog>

    <DeliveryFieldDialog
      :open="recurringOpen"
      title="New Recurring Expense"
      @close="recurringOpen = false"
    >
      <form class="studio-form-grid" @submit.prevent="createRecurring">
        <FirmActionFeedback
          :busy="actionPending === 'Adding recurring expense…'"
          :busy-label="actionPending"
          :error="actionError"
          @dismiss="clearAction"
        />
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
        <button class="studio-primary-button" :disabled="Boolean(actionPending)">
          Add Recurring
        </button>
      </form>
    </DeliveryFieldDialog>
  </section>
</template>
