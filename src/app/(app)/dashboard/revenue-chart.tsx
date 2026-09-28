'use client';

import { useState } from 'react';
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { trpc } from '@/lib/trpc';
import { TrendingUp } from 'lucide-react';
import { cn } from '@/lib/utils';
import { moneyLabel } from '@/lib/finance/currency';

function ChartTooltipContent({
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

export function RevenueChart() {
  const { data: result, isLoading } = trpc.dashboard.getRevenueChart.useQuery();
  // FIN-02: view one currency at a time (USD-first); never blend USD + PKR.
  const [currency, setCurrency] = useState<string | null>(null);

  if (isLoading) {
    return (
      <Card className="studio-panel border-border/60">
        <CardHeader className="pb-2">
          <Skeleton className="h-5 w-40" />
        </CardHeader>
        <CardContent>
          <Skeleton className="h-[260px] w-full rounded-xl" />
        </CardContent>
      </Card>
    );
  }

  if (!result || result.currencies.length === 0) return null;

  const selected = currency && result.byCurrency[currency] ? currency : result.currencies[0];
  const data = result.byCurrency[selected];
  const multiCurrency = result.currencies.length > 1;
  const axisSymbol = selected === 'PKR' ? 'Rs ' : '$';

  const totalIncome = data.reduce((sum, d) => sum + d.income, 0);
  const totalProfit = data.reduce((sum, d) => sum + d.profit, 0);

  return (
    <Card className="studio-panel studio-revenue-card border-border/60">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-[15px] font-semibold flex items-center gap-2 text-foreground">
            <div className="studio-section-icon">
              <TrendingUp className="h-3.5 w-3.5 text-accent-brand" />
            </div>
            Revenue Overview
          </CardTitle>
          <div className="flex items-center gap-5">
            {multiCurrency && (
              <div className="flex items-center gap-1 rounded-lg border border-border p-0.5">
                {result.currencies.map((c) => (
                  <button
                    key={c}
                    onClick={() => setCurrency(c)}
                    className={cn(
                      'rounded-md px-2 py-0.5 text-[11px] font-semibold transition-colors',
                      selected === c
                        ? 'bg-foreground text-background'
                        : 'text-muted-foreground hover:text-foreground'
                    )}
                  >
                    {c}
                  </button>
                ))}
              </div>
            )}
            <div className="flex items-center gap-1.5">
              <div className="h-2 w-2 rounded-full bg-accent-brand" />
              <span className="text-xs text-muted-foreground">Income</span>
            </div>
            <div className="flex items-center gap-1.5">
              <div className="h-2 w-2 rounded-full bg-border dark:bg-muted-foreground" />
              <span className="text-xs text-muted-foreground">Expenses</span>
            </div>
          </div>
        </div>
        <div className="flex items-baseline gap-4 mt-2">
          <div>
            <span className="font-display text-2xl font-bold text-foreground">
              {moneyLabel(totalIncome, selected)}
            </span>
            <span className="text-xs text-muted-foreground ml-1.5">total income</span>
          </div>
          <div>
            <span className="text-sm font-semibold text-success">
              {moneyLabel(totalProfit, selected)}
            </span>
            <span className="text-xs text-muted-foreground ml-1">net profit</span>
          </div>
        </div>
      </CardHeader>
      <CardContent className="pt-2 pb-4">
        <div className="h-[260px] w-full">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={data} margin={{ top: 8, right: 8, left: -20, bottom: 0 }}>
              <defs>
                <linearGradient id="incomeGradient" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="var(--accent-brand)" stopOpacity={0.26} />
                  <stop offset="100%" stopColor="var(--accent-brand)" stopOpacity={0} />
                </linearGradient>
                <linearGradient id="expenseGradient" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="var(--muted-foreground)" stopOpacity={0.12} />
                  <stop offset="100%" stopColor="var(--muted-foreground)" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid
                strokeDasharray="3 3"
                vertical={false}
                stroke="var(--border)"
                strokeOpacity={0.5}
              />
              <XAxis
                dataKey="month"
                axisLine={false}
                tickLine={false}
                tick={{ fontSize: 12, fill: 'var(--muted-foreground)' }}
                dy={8}
              />
              <YAxis
                axisLine={false}
                tickLine={false}
                tick={{ fontSize: 11, fill: 'var(--muted-foreground)' }}
                tickFormatter={(v: number) => `${axisSymbol}${(v / 1000).toFixed(0)}k`}
              />
              <Tooltip content={<ChartTooltipContent currency={selected} />} cursor={false} />
              <Area
                type="monotone"
                dataKey="income"
                stroke="var(--accent-brand)"
                strokeWidth={2.5}
                fill="url(#incomeGradient)"
                dot={false}
                activeDot={{
                  r: 5,
                  fill: 'var(--accent-brand)',
                  strokeWidth: 2,
                  stroke: 'var(--card)',
                }}
              />
              <Area
                type="monotone"
                dataKey="expense"
                stroke="var(--muted-foreground)"
                strokeWidth={1.5}
                fill="url(#expenseGradient)"
                dot={false}
                activeDot={{
                  r: 4,
                  fill: 'var(--muted-foreground)',
                  strokeWidth: 2,
                  stroke: 'var(--card)',
                }}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  );
}
