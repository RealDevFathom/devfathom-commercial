'use client';

import { useState } from 'react';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
} from 'recharts';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { trpc } from '@/lib/trpc';
import { TrendingUp, PieChart as PieIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { moneyLabel } from '@/lib/finance/currency';

const COLORS = [
  '#3C7A74',
  '#2563EB',
  '#16A34A',
  '#D97706',
  '#7C3AED',
  '#DB2777',
  '#0EA5E9',
  '#6E7280',
  '#EF4444',
  '#065F46',
];

function ChartTooltip({
  active,
  payload,
  label,
  currency = 'USD',
}: {
  active?: boolean;
  payload?: Array<{ value: number; dataKey: string; color: string }>;
  label?: string;
  currency?: string;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-xl border border-border bg-card px-4 py-3 shadow-xl shadow-black/10">
      <p className="text-xs font-medium text-muted-foreground mb-2">{label}</p>
      {payload.map((entry) => (
        <div key={entry.dataKey} className="flex items-center justify-between gap-6">
          <div className="flex items-center gap-2">
            <div className="h-2 w-2 rounded-full" style={{ backgroundColor: entry.color }} />
            <span className="text-xs text-muted-foreground capitalize">{entry.dataKey}</span>
          </div>
          <span className="text-sm font-semibold text-foreground tabular-nums">
            {moneyLabel(entry.value, currency)}
          </span>
        </div>
      ))}
    </div>
  );
}

export function PnlReport() {
  const { data: result, isLoading } = trpc.finance.getPnlReport.useQuery({
    period: 'monthly',
    months: 12,
  });
  // FIN-02: P&L is reported one currency at a time (USD-first by default).
  const [currency, setCurrency] = useState<string | null>(null);

  if (isLoading) {
    return (
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
    );
  }

  if (!result || result.currencies.length === 0) return null;

  const selected = currency && result.byCurrency[currency] ? currency : result.currencies[0];
  const view = result.byCurrency[selected];
  const multiCurrency = result.currencies.length > 1;
  const axisSymbol = selected === 'PKR' ? 'Rs ' : '$';

  const totalIncome = view.data.reduce((s, d) => s + d.income, 0);
  const totalExpense = view.data.reduce((s, d) => s + d.expense, 0);
  const totalProfit = totalIncome - totalExpense;
  const avgMargin =
    view.data.length > 0 ? view.data.reduce((s, d) => s + d.margin, 0) / view.data.length : 0;

  return (
    <div className="space-y-5">
      {multiCurrency && (
        <div className="flex w-fit items-center gap-1 rounded-lg border border-border p-0.5">
          {result.currencies.map((c) => (
            <button
              key={c}
              onClick={() => setCurrency(c)}
              className={cn(
                'rounded-md px-2.5 py-1 text-xs font-semibold transition-colors',
                selected === c
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:text-foreground'
              )}
            >
              {c}
            </button>
          ))}
        </div>
      )}
      {/* Summary row */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <SummaryCard
          label="Total Income"
          value={moneyLabel(totalIncome, selected)}
          color="text-emerald-500"
        />
        <SummaryCard
          label="Total Expenses"
          value={moneyLabel(totalExpense, selected)}
          color="text-red-500"
        />
        <SummaryCard
          label="Net Profit"
          value={moneyLabel(totalProfit, selected)}
          color={totalProfit >= 0 ? 'text-emerald-500' : 'text-red-500'}
        />
        <SummaryCard label="Avg Margin" value={`${avgMargin.toFixed(1)}%`} color="text-primary" />
      </div>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
        {/* Revenue vs Expense trend */}
        <Card className="lg:col-span-2 border-border/60">
          <CardHeader className="pb-2">
            <CardTitle className="text-[15px] font-semibold flex items-center gap-2 text-foreground">
              <div className="flex h-6 w-6 items-center justify-center rounded-md bg-primary/10">
                <TrendingUp className="h-3.5 w-3.5 text-primary" />
              </div>
              Profit & Loss Trend
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-2 pb-4">
            <div className="h-[300px] w-full">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={view.data} margin={{ top: 8, right: 8, left: -20, bottom: 0 }}>
                  <CartesianGrid
                    strokeDasharray="3 3"
                    vertical={false}
                    stroke="var(--border)"
                    strokeOpacity={0.5}
                  />
                  <XAxis
                    dataKey="period"
                    axisLine={false}
                    tickLine={false}
                    tick={{ fontSize: 11, fill: 'var(--muted-foreground)' }}
                    dy={8}
                  />
                  <YAxis
                    axisLine={false}
                    tickLine={false}
                    tick={{ fontSize: 11, fill: 'var(--muted-foreground)' }}
                    tickFormatter={(v: number) => `${axisSymbol}${(v / 1000).toFixed(0)}k`}
                  />
                  <Tooltip content={<ChartTooltip currency={selected} />} cursor={false} />
                  <Bar dataKey="income" fill="#16A34A" radius={[4, 4, 0, 0]} barSize={20} />
                  <Bar dataKey="expense" fill="#EF4444" radius={[4, 4, 0, 0]} barSize={20} />
                </BarChart>
              </ResponsiveContainer>
            </div>
            <div className="flex items-center justify-center gap-6 mt-2">
              <div className="flex items-center gap-1.5">
                <div className="h-2 w-2 rounded-full bg-[#16A34A]" />
                <span className="text-xs text-muted-foreground">Income</span>
              </div>
              <div className="flex items-center gap-1.5">
                <div className="h-2 w-2 rounded-full bg-[#EF4444]" />
                <span className="text-xs text-muted-foreground">Expenses</span>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Expense breakdown */}
        <Card className="border-border/60">
          <CardHeader className="pb-2">
            <CardTitle className="text-[15px] font-semibold flex items-center gap-2 text-foreground">
              <div className="flex h-6 w-6 items-center justify-center rounded-md bg-violet-500/10">
                <PieIcon className="h-3.5 w-3.5 text-violet-500" />
              </div>
              Expense Breakdown
            </CardTitle>
          </CardHeader>
          <CardContent>
            {view.categoryBreakdown.length > 0 ? (
              <>
                <div className="h-[180px] w-full">
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie
                        data={view.categoryBreakdown}
                        dataKey="amount"
                        nameKey="category"
                        cx="50%"
                        cy="50%"
                        outerRadius={70}
                        innerRadius={40}
                        strokeWidth={2}
                        stroke="var(--card)"
                      >
                        {view.categoryBreakdown.map((_, i) => (
                          <Cell key={i} fill={COLORS[i % COLORS.length]} />
                        ))}
                      </Pie>
                    </PieChart>
                  </ResponsiveContainer>
                </div>
                <div className="space-y-2 mt-2">
                  {view.categoryBreakdown.map((cat, i) => (
                    <div key={cat.category} className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <div
                          className="h-2.5 w-2.5 rounded-full"
                          style={{ backgroundColor: COLORS[i % COLORS.length] }}
                        />
                        <span className="text-xs text-foreground font-medium">{cat.category}</span>
                      </div>
                      <span className="text-xs text-muted-foreground tabular-nums">
                        {moneyLabel(cat.amount, selected)}
                      </span>
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <div className="py-12 text-center">
                <PieIcon className="mx-auto h-8 w-8 text-muted-foreground/20" />
                <p className="mt-2 text-xs text-muted-foreground">No expense data</p>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function SummaryCard({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <Card className="border-border/60">
      <CardContent className="p-4">
        <p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">
          {label}
        </p>
        <p className={`font-display text-xl font-bold tracking-tight mt-1 ${color}`}>{value}</p>
      </CardContent>
    </Card>
  );
}
