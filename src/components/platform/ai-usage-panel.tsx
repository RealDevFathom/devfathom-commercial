import type { MonthlyAIUsage } from '@/lib/ai/usage';

const money = (minor: number) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(minor / 100);

export function AIUsagePanel({ usage }: { usage: MonthlyAIUsage }) {
  const percent = Math.max(0, usage.percentUsed);
  return (
    <section
      className="border border-border-default bg-surface-card"
      aria-labelledby="ai-usage-title"
    >
      <div className="flex flex-wrap items-end justify-between gap-3 border-b border-border-subtle px-5 py-4">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-text-muted">
            Asia/Karachi · {usage.month}
          </p>
          <h2 id="ai-usage-title" className="mt-1 font-display text-xl font-semibold">
            AI usage
          </h2>
        </div>
        <p className="font-mono text-xs tabular-nums text-text-muted">
          Total {money(usage.totalSpendMinor)}
        </p>
      </div>
      <div className="grid gap-px bg-border-subtle sm:grid-cols-3">
        <div className="bg-surface-card p-5">
          <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-text-muted">
            Anthropic
          </p>
          <p className="mt-2 text-2xl font-semibold tabular-nums">
            {money(usage.anthropicSpendMinor)}
          </p>
          <p className="mt-1 text-xs text-text-muted">
            of {money(usage.anthropicBudgetMinor)} budget
          </p>
        </div>
        <div className="bg-surface-card p-5 sm:col-span-2">
          <div className="flex justify-between text-xs">
            <span>Monthly budget used</span>
            <span className="font-mono tabular-nums">{percent.toFixed(1)}%</span>
          </div>
          <div
            className="mt-3 h-2 overflow-hidden rounded-full bg-surface-sunken"
            role="progressbar"
            aria-valuenow={Math.min(percent, 100)}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <div className="h-full bg-warning" style={{ width: `${Math.min(percent, 100)}%` }} />
          </div>
          <div className="mt-5 flex flex-wrap gap-x-6 gap-y-2 text-xs text-text-muted">
            {Object.entries(usage.providerSpendMinor).map(([provider, amount]) => (
              <span key={provider}>
                <strong className="text-text-strong">{provider}</strong> {money(amount)}
              </span>
            ))}
            {Object.entries(usage.tierSpendMinor).map(([tier, amount]) => (
              <span key={tier}>
                <strong className="text-text-strong">{tier}</strong> {money(amount)}
              </span>
            ))}
            {!usage.breakdown.length ? <span>No usage recorded this month.</span> : null}
          </div>
        </div>
      </div>
    </section>
  );
}
