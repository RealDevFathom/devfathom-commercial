'use client';

import { memo, useCallback, useMemo, useState } from 'react';
import dynamic from 'next/dynamic';
import {
  DollarSign,
  TrendingUp,
  TrendingDown,
  ArrowDownLeft,
  ArrowUpRight,
  FileText,
  Plus,
  Trash2,
  X,
  Loader2,
  Receipt,
  Pencil,
  RefreshCw,
  AlertTriangle,
  ChevronDown,
  Wallet,
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { PageHeader } from '@/components/ui/page-header';
import { Stat } from '@/components/ui/stat';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { trpc } from '@/lib/trpc';
import { cn } from '@/lib/utils';
import { financeCsvCell } from './finance-csv';
import { format } from 'date-fns';
import { moneyListLabel, baseEquivalentLabel, moneyLabel } from '@/lib/finance/currency';
import { InvoicesTab } from './invoices-tab';
import { InvoiceManagePanel } from '@/components/finance/invoice-manage-panel';

// P&L report pulls in recharts; it is tab-gated, so load it lazily (client-only)
// and only when the P&L tab mounts to keep recharts out of the initial bundle.
const PnlReport = dynamic(() => import('./pnl-report').then((mod) => mod.PnlReport), {
  ssr: false,
  loading: () => (
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
      <Card className="lg:col-span-2 border-border/60">
        <CardContent className="p-6">
          <Skeleton className="h-[300px] w-full rounded-xl" />
        </CardContent>
      </Card>
      <Card className="border-border/60">
        <CardContent className="p-6">
          <Skeleton className="h-[300px] w-full rounded-xl" />
        </CardContent>
      </Card>
    </div>
  ),
});

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

export function FinanceContent() {
  const summary = trpc.finance.getFinancialSummary.useQuery();
  const transactions = trpc.finance.getTransactions.useQuery({});

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="FIRM"
        heading="Finance"
        description="Income, expenses, invoices, and financial reports."
      />

      {/* KPI Summary */}
      {summary.isLoading ? (
        <div className="grid grid-cols-1 gap-px overflow-hidden rounded-lg border border-border-subtle bg-border-subtle sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="bg-card p-5">
              <Skeleton className="h-4 w-24 mb-3" />
              <Skeleton className="h-9 w-28" />
            </div>
          ))}
        </div>
      ) : (
        summary.data && (
          <div className="grid grid-cols-1 gap-px overflow-hidden rounded-lg border border-border-subtle bg-border-subtle sm:grid-cols-2 lg:grid-cols-4">
            <FinanceKPI
              title="Monthly Revenue"
              value={moneyListLabel(summary.data.monthlyIncome)}
              subtitle={baseEquivalentLabel(summary.data.monthlyIncome) ?? undefined}
              icon={TrendingUp}
            />
            <FinanceKPI
              title="Monthly Expenses"
              value={moneyListLabel(summary.data.monthlyExpense)}
              subtitle={baseEquivalentLabel(summary.data.monthlyExpense) ?? undefined}
              icon={TrendingDown}
            />
            <FinanceKPI
              title="Net Profit"
              value={moneyListLabel(summary.data.monthlyProfit)}
              subtitle={baseEquivalentLabel(summary.data.monthlyProfit) ?? undefined}
              icon={DollarSign}
            />
            <FinanceKPI
              title="Outstanding"
              value={moneyListLabel(summary.data.totalOutstanding)}
              subtitle={`${summary.data.outstandingCount} invoices`}
              icon={FileText}
            />
          </div>
        )
      )}

      {/* Tabs */}
      <Tabs defaultValue="transactions" className="space-y-5">
        <TabsList>
          <TabsTrigger value="transactions">Transactions</TabsTrigger>
          <TabsTrigger value="invoices">Invoices</TabsTrigger>
          <TabsTrigger value="pnl">P&L Report</TabsTrigger>
          <TabsTrigger value="recurring">Recurring</TabsTrigger>
        </TabsList>

        {/* TRANSACTIONS */}
        <TabsContent value="transactions">
          <TransactionsTab transactions={transactions.data} isLoading={transactions.isLoading} />
        </TabsContent>

        {/* INVOICES */}
        <TabsContent value="invoices" className="space-y-6">
          <InvoicesTab />
          {/* IMP-FIN-01: full edit (line items / tax / due / notes), email, print/PDF. */}
          <InvoiceManagePanel />
          {/* IMP-FIN-04: partial payments + overdue automation. */}
          <InvoicePaymentsPanel />
        </TabsContent>

        {/* P&L */}
        <TabsContent value="pnl">
          <PnlReport />
        </TabsContent>

        {/* RECURRING */}
        <TabsContent value="recurring">
          <RecurringTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function FinanceKPI({
  title,
  value,
  subtitle,
  icon: Icon,
}: {
  title: string;
  value: string;
  subtitle?: string;
  icon: React.ComponentType<{ className?: string }>;
}) {
  return (
    <div className="relative bg-card p-5">
      <Icon aria-hidden className="absolute right-5 top-5 h-4 w-4 text-text-muted" />
      <Stat
        className="pr-8"
        label={title}
        value={value}
        valueClassName="break-words text-[clamp(1.5rem,7vw,2rem)]"
        sub={subtitle}
      />
    </div>
  );
}

/* ============================================
   Transactions Tab
   ============================================ */
type TransactionData = {
  id: string;
  type: string;
  amount: unknown;
  currency: string;
  category: string | null;
  description: string;
  date: Date;
  // DEV-166: set when an invoice payment posted this income; it changes only
  // through that payment, so the row offers no edit or delete.
  paymentId?: string | null;
  project: { id: string; name: string } | null;
  client: { id: string; name: string } | null;
};

function TransactionsTab({
  transactions,
  isLoading,
}: {
  transactions: TransactionData[] | undefined;
  isLoading: boolean;
}) {
  const utils = trpc.useUtils();
  const [showAdd, setShowAdd] = useState(false);
  const [filter, setFilter] = useState<'ALL' | 'INCOME' | 'EXPENSE'>('ALL');

  const invalidateFinance = useCallback(() => {
    utils.finance.getTransactions.invalidate();
    utils.finance.getFinancialSummary.invalidate();
  }, [utils]);

  const filtered = useMemo(
    () => transactions?.filter((t) => filter === 'ALL' || t.type === filter) ?? [],
    [transactions, filter]
  );

  // IMP-FIN-06: export the currently-filtered transactions to CSV.
  const exportCsv = useCallback(() => {
    const header = [
      'Date',
      'Type',
      'Amount',
      'Currency',
      'Category',
      'Description',
      'Project',
      'Client',
    ];
    const rows = filtered.map((t) => [
      format(new Date(t.date), 'yyyy-MM-dd'),
      t.type,
      Number(t.amount),
      t.currency,
      t.category ?? '',
      t.description,
      t.project?.name ?? '',
      t.client?.name ?? '',
    ]);
    const csv = [header, ...rows].map((r) => r.map(financeCsvCell).join(',')).join('\r\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `transactions-${format(new Date(), 'yyyy-MM-dd')}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }, [filtered]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          {(['ALL', 'INCOME', 'EXPENSE'] as const).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={cn(
                'rounded-lg px-3 py-1.5 text-xs font-medium transition-colors',
                filter === f
                  ? 'bg-foreground text-background'
                  : 'text-muted-foreground hover:bg-secondary hover:text-foreground'
              )}
            >
              {f === 'ALL' ? 'All' : f === 'INCOME' ? 'Income' : 'Expenses'}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={exportCsv}
            disabled={filtered.length === 0}
            className="flex items-center gap-1.5 rounded-xl border border-border bg-card px-3.5 py-2 text-xs font-medium text-foreground transition-colors hover:bg-secondary disabled:opacity-40"
            title="Export the filtered transactions to CSV"
          >
            <FileText className="h-3.5 w-3.5" />
            Export CSV
          </button>
          <button
            onClick={() => setShowAdd(true)}
            className="flex items-center gap-1.5 rounded-xl bg-primary px-3.5 py-2 text-xs font-semibold text-primary-foreground transition-all hover:bg-[#0C2E2C] active:scale-[0.98]"
          >
            <Plus className="h-3.5 w-3.5" />
            Add Transaction
          </button>
        </div>
      </div>

      {showAdd && <AddTransactionForm onClose={() => setShowAdd(false)} />}

      <Card className="border-border/60">
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-6 space-y-3">
              {Array.from({ length: 6 }).map((_, i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : filtered.length === 0 ? (
            <div className="py-16 text-center">
              <Receipt className="mx-auto h-10 w-10 text-muted-foreground/20" />
              <p className="mt-3 text-sm text-muted-foreground">No transactions found</p>
            </div>
          ) : (
            <div className="divide-y divide-border/60">
              {filtered.map((t) => (
                <TransactionRow key={t.id} t={t} onInvalidate={invalidateFinance} />
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

/* ============================================
   Transaction Row (memoized; owns its own inline-edit state)
   ============================================ */
const TransactionRow = memo(function TransactionRow({
  t,
  onInvalidate,
}: {
  t: TransactionData;
  onInvalidate: () => void;
}) {
  const [isEditing, setIsEditing] = useState(false);
  const [eDesc, setEDesc] = useState('');
  const [eAmount, setEAmount] = useState('');
  const [eDate, setEDate] = useState('');
  const [eCategory, setECategory] = useState('');

  const deleteTransaction = trpc.finance.deleteTransaction.useMutation({
    onSuccess: onInvalidate,
  });
  const updateTransaction = trpc.finance.updateTransaction.useMutation({
    onSuccess: () => {
      onInvalidate();
      setIsEditing(false);
    },
  });

  if (isEditing) {
    return (
      <div className="px-6 py-3 border-b border-primary/10 bg-primary/[0.02]">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          <div className="col-span-2">
            <input
              value={eDesc}
              onChange={(e) => setEDesc(e.target.value)}
              placeholder="Description"
              className="w-full rounded-lg border border-border bg-background px-3 py-1.5 text-sm text-foreground focus:border-primary focus:outline-none"
            />
          </div>
          <div>
            <input
              type="number"
              step="0.01"
              value={eAmount}
              onChange={(e) => setEAmount(e.target.value)}
              placeholder="Amount"
              className="w-full rounded-lg border border-border bg-background px-3 py-1.5 text-sm text-foreground text-right focus:border-primary focus:outline-none"
            />
          </div>
          <div>
            <input
              type="date"
              value={eDate}
              onChange={(e) => setEDate(e.target.value)}
              className="w-full rounded-lg border border-border bg-background px-2 py-1.5 text-sm text-foreground focus:border-primary focus:outline-none"
            />
          </div>
        </div>
        {t.type === 'EXPENSE' && (
          <div className="mt-2">
            <select
              value={eCategory}
              onChange={(e) => setECategory(e.target.value)}
              className="rounded-lg border border-border bg-background px-2 py-1 text-xs text-foreground focus:border-primary focus:outline-none"
            >
              <option value="">No category</option>
              {Object.entries(categoryLabels).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </div>
        )}
        <div className="flex justify-end gap-2 mt-2">
          <button
            onClick={() => setIsEditing(false)}
            className="rounded-lg px-3 py-1 text-[11px] font-medium text-muted-foreground hover:text-foreground"
          >
            Cancel
          </button>
          <button
            onClick={() => {
              if (eDesc.trim() && eAmount) {
                updateTransaction.mutate({
                  id: t.id,
                  description: eDesc.trim(),
                  amount: parseFloat(eAmount),
                  date: new Date(eDate),
                  category: t.type === 'EXPENSE' && eCategory ? (eCategory as 'SALARIES') : null,
                });
              }
            }}
            disabled={!eDesc.trim() || !eAmount || updateTransaction.isPending}
            className="flex items-center gap-1 rounded-lg bg-primary px-3 py-1 text-[11px] font-semibold text-primary-foreground hover:bg-[#0C2E2C] disabled:opacity-40 transition-colors"
          >
            {updateTransaction.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : null} Save
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-4 px-6 py-3.5 group hover:bg-secondary/30 transition-colors">
      <div
        className={cn(
          'flex h-9 w-9 shrink-0 items-center justify-center rounded-xl',
          t.type === 'INCOME' ? 'bg-emerald-500/10' : 'bg-red-500/10'
        )}
      >
        {t.type === 'INCOME' ? (
          <ArrowDownLeft className="h-4 w-4 text-emerald-500" />
        ) : (
          <ArrowUpRight className="h-4 w-4 text-red-500" />
        )}
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-foreground truncate">{t.description}</p>
        <p className="text-xs text-muted-foreground">
          {t.category ? categoryLabels[t.category] || t.category : ''}
          {t.project ? ` · ${t.project.name}` : ''}
          {t.client ? ` · ${t.client.name}` : ''}
          {t.paymentId ? ' · Invoice payment' : ''}
        </p>
      </div>
      <span className="text-xs text-muted-foreground shrink-0 hidden sm:block">
        {format(new Date(t.date), 'MMM d, yyyy')}
      </span>
      <span
        className={cn(
          'text-sm font-semibold tabular-nums shrink-0',
          t.type === 'INCOME' ? 'text-emerald-500' : 'text-foreground'
        )}
      >
        {t.type === 'INCOME' ? '+' : '-'}${Number(t.amount).toLocaleString()}
      </span>
      {!t.paymentId && (
        <>
          <button
            onClick={() => {
              setEDesc(t.description);
              setEAmount(String(Number(t.amount)));
              setEDate(format(new Date(t.date), 'yyyy-MM-dd'));
              setECategory(t.category || '');
              setIsEditing(true);
            }}
            className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground/0 group-hover:text-muted-foreground hover:!bg-secondary hover:!text-foreground transition-all shrink-0"
            title="Edit"
          >
            <Pencil className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={() => deleteTransaction.mutate({ id: t.id })}
            className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground/0 group-hover:text-muted-foreground hover:!text-red-500 hover:!bg-red-500/10 transition-all shrink-0"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </>
      )}
    </div>
  );
});

// Money columns are Decimal(12,2) in the schema; the max value Postgres accepts is
// 9,999,999,999.99. Keep this in sync with the server-side bound in finance.ts.
const MAX_MONEY = 9_999_999_999.99;

/* ============================================
   Add Transaction Form
   ============================================ */
function AddTransactionForm({ onClose }: { onClose: () => void }) {
  const utils = trpc.useUtils();
  const { data: projects } = trpc.projects.getAll.useQuery();
  const { data: clients } = trpc.clients.getAll.useQuery();

  const createTransaction = trpc.finance.createTransaction.useMutation({
    onSuccess: () => {
      utils.finance.getTransactions.invalidate();
      utils.finance.getFinancialSummary.invalidate();
      onClose();
    },
  });

  const [type, setType] = useState<'INCOME' | 'EXPENSE'>('EXPENSE');
  const [amount, setAmount] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState('');
  const [projectId, setProjectId] = useState('');
  const [clientId, setClientId] = useState('');
  const [date, setDate] = useState(format(new Date(), 'yyyy-MM-dd'));

  // Mirrors the Decimal(12,2) ceiling enforced server-side so we flag oversized
  // amounts inline instead of letting the request fail at the DB layer.
  const amountNum = parseFloat(amount);
  const amountTooLarge = amount !== '' && amountNum > MAX_MONEY;

  const handleSubmit = () => {
    if (!amount || !description.trim() || amountTooLarge) return;
    createTransaction.mutate({
      type,
      amount: parseFloat(amount),
      description: description.trim(),
      category: type === 'EXPENSE' && category ? (category as 'SALARIES') : undefined,
      projectId: projectId || undefined,
      clientId: clientId || undefined,
      date: new Date(date),
    });
  };

  return (
    <Card className="border-primary/20 bg-card">
      <CardContent className="p-5 space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-foreground">New Transaction</h3>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground">
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Type toggle */}
        <div className="flex rounded-xl border border-border overflow-hidden">
          {(['INCOME', 'EXPENSE'] as const).map((t) => (
            <button
              key={t}
              onClick={() => setType(t)}
              className={cn(
                'flex-1 py-2 text-xs font-medium transition-colors',
                type === t
                  ? t === 'INCOME'
                    ? 'bg-emerald-500 text-white'
                    : 'bg-red-500 text-white'
                  : 'bg-card text-muted-foreground hover:text-foreground'
              )}
            >
              {t === 'INCOME' ? 'Income' : 'Expense'}
            </button>
          ))}
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="block text-xs font-medium text-foreground mb-1">Amount *</label>
            <input
              type="number"
              step="0.01"
              min="0"
              max={MAX_MONEY}
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0.00"
              className={cn(
                'w-full rounded-xl border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2',
                amountTooLarge
                  ? 'border-red-500 focus:border-red-500 focus:ring-red-500/20'
                  : 'border-border focus:border-primary focus:ring-primary/20'
              )}
            />
            {amountTooLarge && (
              <p className="mt-1 text-xs text-red-500">Max amount is 9,999,999,999.99</p>
            )}
          </div>
          <div>
            <label className="block text-xs font-medium text-foreground mb-1">Date</label>
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
            />
          </div>
        </div>

        <div>
          <label className="block text-xs font-medium text-foreground mb-1">Description *</label>
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Payment for..."
            className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
          />
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {type === 'EXPENSE' && (
            <div>
              <label className="block text-xs font-medium text-foreground mb-1">Category</label>
              <select
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                className="w-full rounded-xl border border-border bg-background px-2 py-2 text-sm text-foreground focus:border-primary focus:outline-none"
              >
                <option value="">Select...</option>
                {Object.entries(categoryLabels).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </select>
            </div>
          )}
          <div>
            <label className="block text-xs font-medium text-foreground mb-1">Project</label>
            <select
              value={projectId}
              onChange={(e) => setProjectId(e.target.value)}
              className="w-full rounded-xl border border-border bg-background px-2 py-2 text-sm text-foreground focus:border-primary focus:outline-none"
            >
              <option value="">None</option>
              {projects?.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-foreground mb-1">Client</label>
            <select
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              className="w-full rounded-xl border border-border bg-background px-2 py-2 text-sm text-foreground focus:border-primary focus:outline-none"
            >
              <option value="">None</option>
              {clients?.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
        </div>

        {createTransaction.error && (
          <p className="text-xs text-red-500">{createTransaction.error.message}</p>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <button
            onClick={onClose}
            className="rounded-xl px-4 py-2 text-xs font-medium text-muted-foreground hover:text-foreground"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={
              !amount || !description.trim() || amountTooLarge || createTransaction.isPending
            }
            className="flex items-center gap-1.5 rounded-xl bg-primary px-4 py-2 text-xs font-semibold text-primary-foreground hover:bg-[#0C2E2C] disabled:opacity-40 transition-colors"
          >
            {createTransaction.isPending ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Saving...
              </>
            ) : (
              'Save Transaction'
            )}
          </button>
        </div>
      </CardContent>
    </Card>
  );
}

/* ============================================
   Recurring Expenses Tab
   ============================================ */
function RecurringTab() {
  const utils = trpc.useUtils();
  // Query lives here so it only fires when the Recurring tab mounts.
  const { data, isLoading } = trpc.finance.getRecurringExpenses.useQuery();
  const [showAdd, setShowAdd] = useState(false);

  const deleteRecurring = trpc.finance.deleteRecurringExpense.useMutation({
    onSuccess: () => utils.finance.getRecurringExpenses.invalidate(),
  });
  const createRecurring = trpc.finance.createRecurringExpense.useMutation({
    onSuccess: () => {
      utils.finance.getRecurringExpenses.invalidate();
      setShowAdd(false);
    },
  });
  // IMP-FIN-03: post any due cycles as real EXPENSE transactions, and show how
  // each budgeted project's spend tracks against its budget.
  const [postResult, setPostResult] = useState<string | null>(null);
  const postDue = trpc.finance.postDueRecurringExpenses.useMutation({
    onSuccess: (r) => {
      utils.finance.getRecurringExpenses.invalidate();
      utils.finance.getBudgetVsActuals.invalidate();
      utils.finance.getTransactions.invalidate();
      setPostResult(
        r.posted > 0
          ? `Posted ${r.posted} transaction${r.posted === 1 ? '' : 's'} from due cycles.`
          : 'Nothing due — all subscriptions are up to date.'
      );
    },
  });
  const budgetQ = trpc.finance.getBudgetVsActuals.useQuery();

  const [name, setName] = useState('');
  const [amount, setAmount] = useState('');
  const [category, setCategory] = useState('SUBSCRIPTIONS');
  const [interval, setInterval] = useState('monthly');
  const [nextDueDate, setNextDueDate] = useState('');
  const [vendorName, setVendorName] = useState('');

  const handleCreate = () => {
    if (!name.trim() || !amount || !nextDueDate) return;
    createRecurring.mutate({
      name: name.trim(),
      amount: parseFloat(amount),
      category: category as 'SUBSCRIPTIONS',
      interval,
      nextDueDate: new Date(nextDueDate),
      vendorName: vendorName.trim() || undefined,
    });
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">{data?.length ?? 0} active subscriptions</p>
        <div className="flex items-center gap-2">
          <button
            onClick={() => postDue.mutate()}
            disabled={postDue.isPending}
            className="flex items-center gap-1.5 rounded-xl border border-border bg-card px-3.5 py-2 text-xs font-semibold text-foreground transition-colors hover:bg-secondary disabled:opacity-50"
            title="Post any due billing cycles as expense transactions"
          >
            {postDue.isPending ? 'Posting…' : 'Post due cycles'}
          </button>
          <button
            onClick={() => setShowAdd(true)}
            className="flex items-center gap-1.5 rounded-xl bg-primary px-3.5 py-2 text-xs font-semibold text-primary-foreground transition-all hover:bg-[#0C2E2C] active:scale-[0.98]"
          >
            <Plus className="h-3.5 w-3.5" /> Add Recurring
          </button>
        </div>
      </div>

      {postResult && (
        <p className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-600 dark:text-emerald-400">
          {postResult}
        </p>
      )}

      {/* IMP-FIN-03: budget vs. actuals rollup for budgeted projects. */}
      {budgetQ.data && budgetQ.data.length > 0 && (
        <Card className="border-border/60">
          <CardContent className="p-5 space-y-3">
            <h3 className="text-sm font-semibold text-foreground">Budget vs. spend</h3>
            <div className="space-y-3">
              {budgetQ.data.map((b) => (
                <div key={b.projectId}>
                  <div className="flex items-center justify-between text-xs">
                    <span className="truncate font-medium text-foreground">{b.name}</span>
                    <span
                      className={cn(
                        'tabular-nums',
                        b.overBudget ? 'text-red-500 font-semibold' : 'text-muted-foreground'
                      )}
                    >
                      {b.totalSpent.toLocaleString()} / {b.budget.toLocaleString()} ({b.pct}%)
                    </span>
                  </div>
                  <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-secondary">
                    <div
                      className={cn(
                        'h-full rounded-full',
                        b.overBudget ? 'bg-red-500' : 'bg-primary'
                      )}
                      style={{ width: `${Math.min(100, b.pct)}%` }}
                    />
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {showAdd && (
        <Card className="border-primary/20">
          <CardContent className="p-5 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-foreground">New Recurring Expense</h3>
              <button
                onClick={() => setShowAdd(false)}
                className="text-muted-foreground hover:text-foreground"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-foreground mb-1">Name *</label>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. AWS Cloud Services"
                  className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-foreground mb-1">Vendor</label>
                <input
                  value={vendorName}
                  onChange={(e) => setVendorName(e.target.value)}
                  placeholder="e.g. Amazon"
                  className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
                />
              </div>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <div>
                <label className="block text-xs font-medium text-foreground mb-1">Amount *</label>
                <input
                  type="number"
                  step="0.01"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  placeholder="0.00"
                  className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-foreground mb-1">Category</label>
                <select
                  value={category}
                  onChange={(e) => setCategory(e.target.value)}
                  className="w-full rounded-xl border border-border bg-background px-2 py-2 text-sm text-foreground focus:border-primary focus:outline-none"
                >
                  {Object.entries(categoryLabels).map(([k, v]) => (
                    <option key={k} value={k}>
                      {v}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-foreground mb-1">Interval</label>
                <select
                  value={interval}
                  onChange={(e) => setInterval(e.target.value)}
                  className="w-full rounded-xl border border-border bg-background px-2 py-2 text-sm text-foreground focus:border-primary focus:outline-none"
                >
                  <option value="monthly">Monthly</option>
                  <option value="quarterly">Quarterly</option>
                  <option value="yearly">Yearly</option>
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-foreground mb-1">Next Due *</label>
                <input
                  type="date"
                  value={nextDueDate}
                  onChange={(e) => setNextDueDate(e.target.value)}
                  className="w-full rounded-xl border border-border bg-background px-2 py-2 text-sm text-foreground focus:border-primary focus:outline-none"
                />
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setShowAdd(false)}
                className="rounded-xl px-4 py-2 text-xs font-medium text-muted-foreground hover:text-foreground"
              >
                Cancel
              </button>
              <button
                onClick={handleCreate}
                disabled={!name.trim() || !amount || !nextDueDate || createRecurring.isPending}
                className="flex items-center gap-1.5 rounded-xl bg-primary px-4 py-2 text-xs font-semibold text-primary-foreground hover:bg-[#0C2E2C] disabled:opacity-40 transition-colors"
              >
                {createRecurring.isPending ? (
                  <>
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    Adding...
                  </>
                ) : (
                  'Add Recurring'
                )}
              </button>
            </div>
          </CardContent>
        </Card>
      )}

      <Card className="border-border/60">
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-6 space-y-3">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-14 w-full rounded-xl" />
              ))}
            </div>
          ) : data?.length ? (
            <div className="divide-y divide-border/60">
              {data.map((exp) => (
                <div
                  key={exp.id}
                  className="flex items-center justify-between px-6 py-3.5 group hover:bg-secondary/30 transition-colors"
                >
                  <div className="flex items-center gap-3">
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-blue-500/10">
                      <RefreshCw className="h-4 w-4 text-blue-500" />
                    </div>
                    <div>
                      <p className="text-sm font-medium text-foreground">{exp.name}</p>
                      <p className="text-xs text-muted-foreground">
                        {exp.vendorName ? `${exp.vendorName} · ` : ''}
                        {exp.interval} &middot; {categoryLabels[exp.category] || exp.category}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <div className="text-right">
                      <p className="text-sm font-semibold text-foreground tabular-nums">
                        ${Number(exp.amount).toLocaleString()}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        Next: {format(new Date(exp.nextDueDate), 'MMM d')}
                      </p>
                    </div>
                    <button
                      onClick={() => deleteRecurring.mutate({ id: exp.id })}
                      className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground/0 group-hover:text-muted-foreground hover:!text-red-500 hover:!bg-red-500/10 transition-all shrink-0"
                      title="Remove"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="py-16 text-center">
              <RefreshCw className="mx-auto h-10 w-10 text-muted-foreground/20" />
              <p className="mt-3 text-sm text-muted-foreground">No recurring expenses</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Add subscriptions and recurring costs to track them
              </p>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

/* ============================================
   IMP-FIN-04: Invoice Payments & Overdue automation
   ============================================ */

// Mirror the server's half-cent payoff tolerance so the UI's "paid in full" and
// overpayment hints agree with what the router actually accepts.
const PAYMENT_EPSILON = 0.005;

// getInvoices now ships payments + computed amountPaid/balance. Money fields stay
// `unknown` (Decimal over the wire) and are coerced with Number(), matching the
// transaction views above.
type PaymentItem = {
  id: string;
  amount: unknown;
  currency: string;
  method: string | null;
  note: string | null;
  paidAt: Date | string;
};

type PayableInvoice = {
  id: string;
  invoiceNumber: string;
  status: string;
  currency: string;
  total: unknown;
  dueDate: Date | string;
  amountPaid: number;
  balance: number;
  client: { name: string };
  payments: PaymentItem[];
};

function InvoicePaymentsPanel() {
  const utils = trpc.useUtils();
  const { data: invoices, isLoading } = trpc.finance.getInvoices.useQuery();

  const invalidate = useCallback(() => {
    utils.finance.getInvoices.invalidate();
    utils.finance.getFinancialSummary.invalidate();
  }, [utils]);

  const [overdueMsg, setOverdueMsg] = useState<string | null>(null);
  const markOverdue = trpc.finance.markOverdueInvoices.useMutation({
    onSuccess: (r) => {
      invalidate();
      setOverdueMsg(
        r.count > 0
          ? `Flagged ${r.count} invoice${r.count === 1 ? '' : 's'} as overdue.`
          : 'No past-due invoices to flag.'
      );
    },
  });

  // Only invoices that can carry a balance — a DRAFT isn't owed yet and CANCELLED is void.
  const payable = useMemo(
    () =>
      (invoices ?? []).filter(
        (inv) => inv.status === 'SENT' || inv.status === 'OVERDUE' || inv.status === 'PAID'
      ),
    [invoices]
  );

  return (
    <Card className="border-border/60">
      <CardContent className="p-0">
        <div className="flex items-center justify-between gap-3 border-b border-border/60 px-6 py-4">
          <div className="flex items-center gap-2.5">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary/10">
              <Wallet className="h-4 w-4 text-primary" />
            </div>
            <div>
              <h3 className="text-sm font-semibold text-foreground">Payments &amp; balances</h3>
              <p className="text-xs text-muted-foreground">
                Record payments against sent invoices and track what&apos;s outstanding.
              </p>
            </div>
          </div>
          <button
            onClick={() => markOverdue.mutate()}
            disabled={markOverdue.isPending}
            className="flex items-center gap-1.5 rounded-xl border border-border bg-card px-3.5 py-2 text-xs font-semibold text-foreground transition-colors hover:bg-secondary disabled:opacity-50"
            title="Flag every sent invoice past its due date as overdue"
          >
            <AlertTriangle className="h-3.5 w-3.5" />
            {markOverdue.isPending ? 'Flagging…' : 'Flag overdue'}
          </button>
        </div>

        {overdueMsg && (
          <p className="border-b border-border/60 bg-amber-500/10 px-6 py-2.5 text-xs text-amber-600 dark:text-amber-400">
            {overdueMsg}
          </p>
        )}

        {isLoading ? (
          <div className="space-y-3 p-6">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-14 w-full rounded-xl" />
            ))}
          </div>
        ) : payable.length === 0 ? (
          <div className="py-14 text-center">
            <Wallet className="mx-auto h-10 w-10 text-muted-foreground/20" />
            <p className="mt-3 text-sm text-muted-foreground">No payable invoices</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Send an invoice to start recording payments against it.
            </p>
          </div>
        ) : (
          <div className="divide-y divide-border/60">
            {payable.map((inv) => (
              <InvoicePaymentRow key={inv.id} inv={inv} onInvalidate={invalidate} />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

const InvoicePaymentRow = memo(function InvoicePaymentRow({
  inv,
  onInvalidate,
}: {
  inv: PayableInvoice;
  onInvalidate: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const total = Number(inv.total);
  const isOverdue = inv.status === 'OVERDUE';
  const isPaid = inv.status === 'PAID';
  const fullyPaid = inv.balance <= PAYMENT_EPSILON;

  return (
    <div className={cn('bg-card transition-colors', expanded && 'bg-secondary/20')}>
      <button
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-4 px-6 py-3.5 text-left transition-colors hover:bg-secondary/30"
      >
        <ChevronDown
          className={cn(
            'h-4 w-4 shrink-0 text-muted-foreground transition-transform',
            expanded && 'rotate-180'
          )}
        />
        <div className="min-w-0 flex-1">
          <p className="font-mono text-sm font-semibold text-foreground">{inv.invoiceNumber}</p>
          <p className="truncate text-xs text-muted-foreground">{inv.client.name}</p>
        </div>
        <span
          className={cn(
            'inline-flex shrink-0 items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-medium',
            isOverdue
              ? 'bg-red-500/10 text-red-500'
              : isPaid
                ? 'bg-emerald-500/10 text-emerald-500'
                : 'bg-blue-500/10 text-blue-500'
          )}
        >
          {isOverdue && <AlertTriangle className="h-3 w-3" />}
          {isOverdue ? 'Overdue' : isPaid ? 'Paid' : 'Sent'}
        </span>
        <div className="hidden shrink-0 text-right sm:block">
          <p className="text-xs text-muted-foreground">
            Paid {moneyLabel(inv.amountPaid, inv.currency)}
          </p>
          <p
            className={cn(
              'text-sm font-semibold tabular-nums',
              fullyPaid ? 'text-emerald-500' : isOverdue ? 'text-red-500' : 'text-foreground'
            )}
          >
            {fullyPaid ? 'Paid in full' : `${moneyLabel(inv.balance, inv.currency)} due`}
          </p>
        </div>
      </button>

      {expanded && (
        <div className="space-y-4 border-t border-border/60 px-6 py-4">
          <div className="grid grid-cols-3 gap-3">
            <PaymentStat label="Invoice total" value={moneyLabel(total, inv.currency)} />
            <PaymentStat
              label="Paid"
              value={moneyLabel(inv.amountPaid, inv.currency)}
              tone="emerald"
            />
            <PaymentStat
              label="Balance"
              value={moneyLabel(inv.balance, inv.currency)}
              tone={fullyPaid ? 'emerald' : isOverdue ? 'red' : 'default'}
            />
          </div>

          {inv.payments.length > 0 ? (
            <div className="space-y-1.5">
              {inv.payments.map((p) => (
                <PaymentLine key={p.id} p={p} onInvalidate={onInvalidate} />
              ))}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">No payments recorded yet.</p>
          )}

          {!isPaid && (
            <AddPaymentForm
              invoiceId={inv.id}
              currency={inv.currency}
              balance={inv.balance}
              onInvalidate={onInvalidate}
            />
          )}
        </div>
      )}
    </div>
  );
});

function PaymentStat({
  label,
  value,
  tone = 'default',
}: {
  label: string;
  value: string;
  tone?: 'default' | 'emerald' | 'red';
}) {
  return (
    <div className="rounded-xl border border-border/60 bg-background px-3 py-2">
      <p className="text-[11px] text-muted-foreground">{label}</p>
      <p
        className={cn(
          'mt-0.5 text-sm font-semibold tabular-nums',
          tone === 'emerald'
            ? 'text-emerald-500'
            : tone === 'red'
              ? 'text-red-500'
              : 'text-foreground'
        )}
      >
        {value}
      </p>
    </div>
  );
}

function PaymentLine({ p, onInvalidate }: { p: PaymentItem; onInvalidate: () => void }) {
  const deletePayment = trpc.finance.deletePayment.useMutation({ onSuccess: onInvalidate });
  return (
    <div className="group flex items-center gap-3 rounded-lg border border-border/60 bg-background px-3 py-2">
      <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-emerald-500/10">
        <ArrowDownLeft className="h-3.5 w-3.5 text-emerald-500" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-foreground tabular-nums">
          {moneyLabel(Number(p.amount), p.currency)}
          {p.method ? (
            <span className="ml-2 text-xs font-normal text-muted-foreground">{p.method}</span>
          ) : null}
        </p>
        {p.note && <p className="truncate text-xs text-muted-foreground">{p.note}</p>}
      </div>
      <span className="shrink-0 text-xs text-muted-foreground">
        {format(new Date(p.paidAt), 'MMM d, yyyy')}
      </span>
      <button
        onClick={() => deletePayment.mutate({ id: p.id })}
        disabled={deletePayment.isPending}
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground/0 transition-all hover:!bg-red-500/10 hover:!text-red-500 group-hover:text-muted-foreground disabled:opacity-50"
        title="Delete payment"
      >
        {deletePayment.isPending ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <Trash2 className="h-3.5 w-3.5" />
        )}
      </button>
    </div>
  );
}

function AddPaymentForm({
  invoiceId,
  currency,
  balance,
  onInvalidate,
}: {
  invoiceId: string;
  currency: string;
  balance: number;
  onInvalidate: () => void;
}) {
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState('');
  const [note, setNote] = useState('');
  const [paidAt, setPaidAt] = useState(format(new Date(), 'yyyy-MM-dd'));

  const addPayment = trpc.finance.addPayment.useMutation({
    onSuccess: () => {
      onInvalidate();
      setAmount('');
      setMethod('');
      setNote('');
    },
  });

  const amountNum = parseFloat(amount);
  const amountValid = amount !== '' && amountNum > 0 && amountNum <= MAX_MONEY;
  // Flag overpayment client-side using the same half-cent tolerance the server uses.
  const overpay = amountValid && amountNum > balance + PAYMENT_EPSILON;

  const submit = () => {
    if (!amountValid || overpay) return;
    addPayment.mutate({
      invoiceId,
      amount: amountNum,
      method: method.trim() || undefined,
      note: note.trim() || undefined,
      paidAt: paidAt ? new Date(paidAt) : undefined,
    });
  };

  return (
    <div className="rounded-xl border border-primary/20 bg-primary/[0.02] p-3.5">
      <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-foreground">
        <Plus className="h-3.5 w-3.5 text-primary" />
        Record a payment
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <div>
          <label className="mb-1 block text-[11px] font-medium text-muted-foreground">
            Amount ({currency}) *
          </label>
          <input
            type="number"
            step="0.01"
            min="0"
            max={MAX_MONEY}
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="0.00"
            className={cn(
              'w-full rounded-lg border bg-background px-2.5 py-1.5 text-right text-sm text-foreground focus:outline-none focus:ring-2',
              overpay
                ? 'border-red-500 focus:border-red-500 focus:ring-red-500/20'
                : 'border-border focus:border-primary focus:ring-primary/20'
            )}
          />
        </div>
        <div>
          <label className="mb-1 block text-[11px] font-medium text-muted-foreground">Method</label>
          <input
            value={method}
            onChange={(e) => setMethod(e.target.value)}
            placeholder="Bank transfer"
            className="w-full rounded-lg border border-border bg-background px-2.5 py-1.5 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
          />
        </div>
        <div>
          <label className="mb-1 block text-[11px] font-medium text-muted-foreground">Date</label>
          <input
            type="date"
            value={paidAt}
            onChange={(e) => setPaidAt(e.target.value)}
            className="w-full rounded-lg border border-border bg-background px-2 py-1.5 text-sm text-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
          />
        </div>
        <div className="flex items-end">
          <button
            onClick={submit}
            disabled={!amountValid || overpay || addPayment.isPending}
            className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground transition-colors hover:bg-[#0C2E2C] disabled:opacity-40"
          >
            {addPayment.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            Add
          </button>
        </div>
      </div>
      <div className="mt-2">
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Note (optional)"
          className="w-full rounded-lg border border-border bg-background px-2.5 py-1.5 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
        />
      </div>
      {overpay && (
        <p className="mt-1.5 text-xs text-red-500">
          Amount exceeds the {moneyLabel(balance, currency)} balance.
        </p>
      )}
      {addPayment.error && (
        <p className="mt-1.5 text-xs text-red-500">{addPayment.error.message}</p>
      )}
    </div>
  );
}
