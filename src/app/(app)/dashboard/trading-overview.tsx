'use client';

import Link from 'next/link';
import { BusinessOverview } from '@/components/dashboard/business-overview';
import type { WatchRow } from '@/lib/pharmacy/owner-watch';
import { useState } from 'react';
import { trpc } from '@/lib/trpc';
import { Button } from '@/components/ui/button';
import { SectionCard } from '@/components/ui/section-card';
import { Stat } from '@/components/ui/stat';
import { BusinessChart, reportMoney } from '@/components/dashboard/business-chart';
import type { TradingSection } from '@/lib/pharmacy/owner-trading';

const labels = {
  expiry: ['Stock expiring from today', 'Cumulative value · next 30, 60 and 90 days'],
  stock: ['Stock value over time', 'Last 30 business days · available units at landed cost'],
  summary: ['Trading today', 'Compared with the same weekday last week'],
  days: ['Daily sales', 'Last 30 business days · dashed line shows the previous 30'],
  hours: ['Sales by hour', 'Today · business local time'],
  payments: ['Sales by payment method', 'Today · applied tenders'],
  medicines: ['Top 10 medicines', 'Last 30 business days'],
  profits: ['Top 10 medicines', 'Last 30 business days'],
  branches: ['Sales by branch', 'Today · each branch’s business day'],
} as const;

type Props = { branchId?: string; financial: boolean; currency?: string | null; branches: number };
function TradingPanel({
  section,
  branchId,
  currency,
  actions,
  financial,
}: Pick<Props, 'branchId' | 'currency' | 'financial'> & {
  section: TradingSection;
  actions?: React.ReactNode;
}) {
  const query = trpc.pharmacyReports.ownerTrading.useQuery(
    { section, branchId },
    { retry: false, trpc: { context: { independentSection: true } } }
  );
  const [title, period] = labels[section];
  const money = (v: number) => reportMoney(v, currency);
  return (
    <SectionCard title={title} eyebrow={period}>
      {actions}
      <div className={section === 'summary' && financial ? 'min-h-96 md:min-h-56' : 'min-h-56'}>
        {query.error ? (
          <div role="alert" className="space-y-2">
            <p>This section could not load.</p>
            <Button variant="outline" onClick={() => void query.refetch()}>
              Try again
            </Button>
          </div>
        ) : !query.data ? (
          <p role="status" className="min-h-56 text-sm text-text-muted">
            Loading {title.toLowerCase()}…
          </p>
        ) : section === 'summary' ? (
          <>
            {query.data.find((p) => p.label === 'Bills')?.value === 0 && (
              <p className="mb-4 text-sm text-text-muted">No sales yet today.</p>
            )}
            <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
              {query.data.map((p) => {
                const format = p.count ? (v: number) => v.toLocaleString() : money;
                const delta = p.previous != null && p.value != null ? p.value - p.previous : null;
                return (
                  <Stat
                    key={p.label}
                    label={p.label}
                    valueClassName="text-xl break-words"
                    value={p.value == null ? 'No recorded value' : format(p.value)}
                    delta={
                      delta === null
                        ? undefined
                        : `${format(Math.abs(delta))} ${delta === 0 ? 'change' : delta > 0 ? 'more' : 'less'}`
                    }
                    deltaDirection={
                      delta === null || delta === 0 ? 'flat' : delta > 0 ? 'up' : 'down'
                    }
                    sub={
                      p.previous != null
                        ? `${format(p.previous)} last week`
                        : 'No comparison recorded'
                    }
                  />
                );
              })}
            </div>
          </>
        ) : (
          <BusinessChart
            title={title}
            points={query.data}
            empty={
              section === 'expiry'
                ? 'No stock expiring in the next 90 days.'
                : section === 'stock'
                  ? 'No available stock recorded in this period.'
                  : section === 'profits'
                    ? 'No medicine profit recorded in the last 30 days.'
                    : section === 'days' || section === 'medicines'
                      ? 'No sales recorded in this period.'
                      : 'No sales yet today.'
            }
            format={money}
            line={section === 'days' || section === 'stock'}
            comparison={section === 'days'}
          />
        )}
      </div>
    </SectionCard>
  );
}

function PositionPanels({ branchId, financial }: Pick<Props, 'branchId' | 'financial'>) {
  const options = { retry: false, trpc: { context: { independentSection: true } } };
  const work = trpc.pharmacyReports.ownerWatch.useQuery({ section: 'work', branchId }, options);
  const approvals = trpc.pharmacyReports.ownerWatch.useQuery(
    { section: 'approvals', branchId },
    options
  );
  const suppliers = trpc.pharmacyReports.ownerWatch.useQuery(
    { section: 'suppliers', branchId },
    { ...options, enabled: financial }
  );
  const customers = trpc.pharmacyReports.ownerWatch.useQuery(
    { section: 'customers', branchId },
    { ...options, enabled: financial }
  );
  const groups: { group: WatchRow['group']; title: string; queries: (typeof work)[] }[] = [
    {
      group: 'attention',
      title: 'Needs attention',
      queries: financial ? [work, approvals, suppliers, customers] : [work, approvals],
    },
    ...(financial
      ? [{ group: 'owed' as const, title: 'Money owed', queries: [suppliers, customers] }]
      : []),
  ];
  return groups.map(({ group, title, queries }) => {
    const rows = queries.flatMap((q) => q.data ?? []).filter((r) => r.group === group);
    const queues = group === 'attention' ? (approvals.data ?? []) : [];
    if (!queues.length && !rows.length && queries.every((q) => q.data)) return null;
    return (
      <SectionCard key={group} title={title} eyebrow="Current position">
        <div className={group === 'owed' ? 'min-h-56' : 'min-h-[32rem]'}>
          {queues.length > 0 && (
            <details className="border-b border-border-subtle">
              <summary className="min-h-11 cursor-pointer py-3 text-sm font-medium focus-visible:outline-ring">
                <span>Approvals waiting</span>
                <span className="float-right font-mono tabular-nums">
                  {queues.reduce((sum, q) => sum + (q.value ?? 0), 0)}
                </span>
              </summary>
              <ul className="divide-y divide-border-subtle pl-3">
                {queues.map((q) => (
                  <li key={q.label}>
                    <Link
                      className="flex min-h-11 items-center justify-between gap-3 rounded-control py-2 text-sm hover:bg-surface-sunken focus-visible:outline-ring"
                      href={q.href}
                    >
                      <span>
                        {q.label}
                        <small className="block text-text-muted">{q.period}</small>
                      </span>
                      <span className="font-mono tabular-nums">{q.value}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </details>
          )}
          <ul className="divide-y divide-border-subtle">
            {rows.map((r) => (
              <li key={r.label + (r.currency ?? '')}>
                <Link
                  href={r.href}
                  className="flex min-h-11 items-center justify-between gap-3 rounded-control py-2 text-sm hover:bg-surface-sunken focus-visible:outline-2 focus-visible:outline-ring"
                >
                  <span>
                    <span className="block font-medium">{r.label}</span>
                    <span className="text-xs text-text-muted">{r.period}</span>
                  </span>
                  <span className="text-right font-mono tabular-nums">
                    {r.value == null
                      ? group === 'owed' || r.label.includes('due')
                        ? 'See report'
                        : 'Not calculated yet'
                      : group === 'owed'
                        ? reportMoney(r.value, r.currency)
                        : r.value.toLocaleString()}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
          {queries.some((q) => q.isLoading) && (
            <p role="status" className="text-sm text-text-muted">
              Loading figures…
            </p>
          )}
          {queries.some((q) => q.error) && (
            <Button
              variant="outline"
              onClick={() => queries.filter((q) => q.error).forEach((q) => void q.refetch())}
            >
              Retry unavailable figures
            </Button>
          )}
        </div>
      </SectionCard>
    );
  });
}

export function TradingOverview({ branchId, financial, currency, branches }: Props) {
  const [profit, setProfit] = useState(false);
  const props = { branchId, currency, financial };
  return (
    <BusinessOverview summary={<TradingPanel {...props} section="summary" />}>
      {financial && <TradingPanel {...props} section="days" />}
      <PositionPanels branchId={branchId} financial={financial} />
      {financial && (
        <>
          <TradingPanel {...props} section="hours" />
          <TradingPanel {...props} section="payments" />
          <TradingPanel {...props} section="stock" />
          <TradingPanel {...props} section="expiry" />
          <TradingPanel
            {...props}
            section={profit ? 'profits' : 'medicines'}
            actions={
              <div role="group" aria-label="Rank medicines by" className="mb-4 flex gap-2">
                <Button
                  variant={profit ? 'outline' : 'default'}
                  aria-pressed={!profit}
                  onClick={() => setProfit(false)}
                >
                  Sales
                </Button>
                <Button
                  variant={profit ? 'default' : 'outline'}
                  aria-pressed={profit}
                  onClick={() => setProfit(true)}
                >
                  Profit
                </Button>
              </div>
            }
          />
          {branches > 1 && <TradingPanel {...props} section="branches" />}
        </>
      )}
    </BusinessOverview>
  );
}
