'use client';

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

function ChartTooltipContent({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: Array<{ value: number; dataKey: string; color: string }>;
  label?: string;
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
            ${entry.value.toLocaleString()}
          </span>
        </div>
      ))}
    </div>
  );
}

export function RevenueChart() {
  const { data, isLoading } = trpc.dashboard.getRevenueChart.useQuery();

  if (isLoading) {
    return (
      <Card className="border-border/60">
        <CardHeader className="pb-2">
          <Skeleton className="h-5 w-40" />
        </CardHeader>
        <CardContent>
          <Skeleton className="h-[260px] w-full rounded-xl" />
        </CardContent>
      </Card>
    );
  }

  if (!data?.length) return null;

  const totalIncome = data.reduce((sum, d) => sum + d.income, 0);
  const totalProfit = data.reduce((sum, d) => sum + d.profit, 0);

  return (
    <Card className="border-border/60">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-[15px] font-semibold flex items-center gap-2 text-foreground">
            <div className="flex h-6 w-6 items-center justify-center rounded-md bg-[#FF4C29]/10">
              <TrendingUp className="h-3.5 w-3.5 text-[#FF4C29]" />
            </div>
            Revenue Overview
          </CardTitle>
          <div className="flex items-center gap-5">
            <div className="flex items-center gap-1.5">
              <div className="h-2 w-2 rounded-full bg-[#FF4C29]" />
              <span className="text-xs text-muted-foreground">Income</span>
            </div>
            <div className="flex items-center gap-1.5">
              <div className="h-2 w-2 rounded-full bg-[#2E2C2A] dark:bg-[#A8A49D]" />
              <span className="text-xs text-muted-foreground">Expenses</span>
            </div>
          </div>
        </div>
        <div className="flex items-baseline gap-4 mt-2">
          <div>
            <span className="font-display text-2xl font-bold text-foreground">${totalIncome.toLocaleString()}</span>
            <span className="text-xs text-muted-foreground ml-1.5">total income</span>
          </div>
          <div>
            <span className="text-sm font-semibold text-emerald-500">${totalProfit.toLocaleString()}</span>
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
                  <stop offset="0%" stopColor="#FF4C29" stopOpacity={0.2} />
                  <stop offset="100%" stopColor="#FF4C29" stopOpacity={0} />
                </linearGradient>
                <linearGradient id="expenseGradient" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#8E919B" stopOpacity={0.1} />
                  <stop offset="100%" stopColor="#8E919B" stopOpacity={0} />
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
                tickFormatter={(v: number) => `$${(v / 1000).toFixed(0)}k`}
              />
              <Tooltip content={<ChartTooltipContent />} cursor={false} />
              <Area
                type="monotone"
                dataKey="income"
                stroke="#FF4C29"
                strokeWidth={2.5}
                fill="url(#incomeGradient)"
                dot={false}
                activeDot={{ r: 5, fill: '#FF4C29', strokeWidth: 2, stroke: 'var(--card)' }}
              />
              <Area
                type="monotone"
                dataKey="expense"
                stroke="#8E919B"
                strokeWidth={1.5}
                fill="url(#expenseGradient)"
                dot={false}
                activeDot={{ r: 4, fill: '#8E919B', strokeWidth: 2, stroke: 'var(--card)' }}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  );
}
