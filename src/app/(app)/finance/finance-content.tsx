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
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { trpc } from '@/lib/trpc';
import { cn } from '@/lib/utils';
import { format } from 'date-fns';
import { InvoicesTab } from './invoices-tab';

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
    <div className="space-y-6 animate-fade-in">
      {/* Header */}
      <div>
        <h1 className="font-display text-2xl font-bold tracking-tight text-foreground">Finance</h1>
        <p className="text-muted-foreground mt-1.5 text-[15px]">
          Income, expenses, invoices, and financial reports.
        </p>
      </div>

      {/* KPI Summary */}
      {summary.isLoading ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Card key={i} className="border-border/60">
              <CardContent className="p-6">
                <Skeleton className="h-4 w-24 mb-3" />
                <Skeleton className="h-9 w-28" />
              </CardContent>
            </Card>
          ))}
        </div>
      ) : (
        summary.data && (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <FinanceKPI
              title="Monthly Revenue"
              value={`$${summary.data.monthlyIncome.toLocaleString()}`}
              icon={TrendingUp}
              accent="emerald"
            />
            <FinanceKPI
              title="Monthly Expenses"
              value={`$${summary.data.monthlyExpense.toLocaleString()}`}
              icon={TrendingDown}
              accent="red"
            />
            <FinanceKPI
              title="Net Profit"
              value={`$${summary.data.monthlyProfit.toLocaleString()}`}
              icon={DollarSign}
              accent={summary.data.monthlyProfit >= 0 ? 'emerald' : 'red'}
            />
            <FinanceKPI
              title="Outstanding"
              value={`$${summary.data.totalOutstanding.toLocaleString()}`}
              subtitle={`${summary.data.outstandingCount} invoices`}
              icon={FileText}
              accent="amber"
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
        <TabsContent value="invoices">
          <InvoicesTab />
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
  accent,
}: {
  title: string;
  value: string;
  subtitle?: string;
  icon: React.ComponentType<{ className?: string }>;
  accent: 'emerald' | 'red' | 'amber' | 'blue';
}) {
  const colors = {
    emerald: 'bg-emerald-500/10 text-emerald-500',
    red: 'bg-red-500/10 text-red-500',
    amber: 'bg-amber-500/10 text-amber-500',
    blue: 'bg-blue-500/10 text-blue-500',
  };
  return (
    <Card className="border-border/60">
      <CardContent className="p-6">
        <div className="flex items-start justify-between">
          <div>
            <p className="text-[13px] font-medium text-muted-foreground">{title}</p>
            <p className="font-display text-2xl font-bold tracking-tight text-foreground mt-1">
              {value}
            </p>
            {subtitle && <p className="text-xs text-muted-foreground mt-0.5">{subtitle}</p>}
          </div>
          <div
            className={cn('flex h-10 w-10 items-center justify-center rounded-xl', colors[accent])}
          >
            <Icon className="h-5 w-5" />
          </div>
        </div>
      </CardContent>
    </Card>
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
        <button
          onClick={() => setShowAdd(true)}
          className="flex items-center gap-1.5 rounded-xl bg-primary px-3.5 py-2 text-xs font-semibold text-white transition-all hover:bg-[#0C2E2C] active:scale-[0.98]"
        >
          <Plus className="h-3.5 w-3.5" />
          Add Transaction
        </button>
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
            className="flex items-center gap-1 rounded-lg bg-primary px-3 py-1 text-[11px] font-semibold text-white hover:bg-[#0C2E2C] disabled:opacity-40 transition-colors"
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
    </div>
  );
});

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

  const handleSubmit = () => {
    if (!amount || !description.trim()) return;
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
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0.00"
              className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
            />
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

        <div className="flex justify-end gap-2 pt-1">
          <button
            onClick={onClose}
            className="rounded-xl px-4 py-2 text-xs font-medium text-muted-foreground hover:text-foreground"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={!amount || !description.trim() || createTransaction.isPending}
            className="flex items-center gap-1.5 rounded-xl bg-primary px-4 py-2 text-xs font-semibold text-white hover:bg-[#0C2E2C] disabled:opacity-40 transition-colors"
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
        <button
          onClick={() => setShowAdd(true)}
          className="flex items-center gap-1.5 rounded-xl bg-primary px-3.5 py-2 text-xs font-semibold text-white transition-all hover:bg-[#0C2E2C] active:scale-[0.98]"
        >
          <Plus className="h-3.5 w-3.5" /> Add Recurring
        </button>
      </div>

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
                className="flex items-center gap-1.5 rounded-xl bg-primary px-4 py-2 text-xs font-semibold text-white hover:bg-[#0C2E2C] disabled:opacity-40 transition-colors"
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
