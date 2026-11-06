import { SectionCard } from '@/components/ui/section-card';
import { StatusPill, type StatusTone } from '@/components/ui/status-pill';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import type { AIProviderCapStatus, AIProviderMonthlyUsage, MonthlyAIUsage } from '@/lib/ai/usage';
import { cn } from '@/lib/utils';

const PROVIDER_LABEL: Record<AIProviderMonthlyUsage['provider'], string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  bedrock: 'Amazon Bedrock',
};

const STATUS: Record<AIProviderCapStatus, { tone: StatusTone; label: string; fill: string }> = {
  ok: { tone: 'success', label: 'Within cap', fill: 'bg-success' },
  near_cap: { tone: 'warning', label: 'Near cap', fill: 'bg-warning' },
  capped: { tone: 'danger', label: 'Capped', fill: 'bg-destructive' },
};

const money = (minor: number) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(minor / 100);
const count = (value: number) => new Intl.NumberFormat('en-US').format(value);
const percent = (value: number) => `${value.toFixed(1)}%`;

const TITLE = 'AI spend by provider';

function ProviderUsage({
  usage,
  nearCapPercent,
}: {
  usage: AIProviderMonthlyUsage;
  nearCapPercent: number;
}) {
  const label = PROVIDER_LABEL[usage.provider];
  const status = STATUS[usage.status];
  const fill = Math.min(100, Math.max(0, usage.percentUsed));
  const headingId = `ai-usage-${usage.provider}`;

  return (
    <article
      aria-labelledby={headingId}
      className="grid gap-5 py-5 first:pt-0 last:pb-0 md:grid-cols-[minmax(0,15rem)_minmax(0,1fr)]"
    >
      <div className="min-w-0 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 id={headingId} className="font-display text-base font-semibold text-text-strong">
            {label}
          </h3>
          <StatusPill status={usage.status} tone={status.tone} label={status.label} />
        </div>
        <div>
          <p className="stat-figure text-2xl text-text-strong">{money(usage.spendMinor)}</p>
          <p className="mt-1 font-mono text-xs tabular-nums text-text-muted">
            of {money(usage.capMinor)} cap · {percent(usage.percentUsed)}
          </p>
        </div>
        <div
          role="progressbar"
          aria-label={`${label} spend against its monthly cap`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(fill)}
          aria-valuetext={`${percent(usage.percentUsed)} of the monthly cap`}
          className="h-1.5 overflow-hidden rounded-full bg-surface-sunken"
        >
          <div className={cn('h-full rounded-full', status.fill)} style={{ width: `${fill}%` }} />
        </div>
        {usage.status === 'capped' ? (
          <p className="text-xs leading-relaxed text-destructive">
            Cap reached — routing skips {label} until the month ends or the cap is raised.
          </p>
        ) : usage.status === 'near_cap' ? (
          <p className="text-xs leading-relaxed text-warning">
            At {nearCapPercent}% or more of the cap. Routing moves to the next provider once the cap
            is reached.
          </p>
        ) : null}
      </div>

      <div className="min-w-0">
        <Table aria-label={`${label} spend by tier`}>
          <TableHeader>
            <TableRow>
              <TableHead>Tier</TableHead>
              <TableHead numeric>Calls</TableHead>
              <TableHead numeric>Input tokens</TableHead>
              <TableHead numeric>Output tokens</TableHead>
              <TableHead numeric>Spend</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {usage.tiers.map((tier) => (
              <TableRow key={tier.tier}>
                <TableCell>
                  <span className="font-medium capitalize text-text-strong">{tier.tier}</span>
                  {tier.configuredModel ? (
                    <span className="block font-mono text-[10px] text-text-muted">
                      {tier.configuredModel}
                    </span>
                  ) : null}
                </TableCell>
                <TableCell numeric className="font-mono text-xs">
                  {count(tier.calls)}
                </TableCell>
                <TableCell numeric className="font-mono text-xs">
                  {count(tier.inputTokens)}
                </TableCell>
                <TableCell numeric className="font-mono text-xs">
                  {count(tier.outputTokens)}
                </TableCell>
                <TableCell numeric className="font-mono text-xs text-text-strong">
                  {money(tier.spendMinor)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </article>
  );
}

/**
 * This Asia/Karachi month's AI spend per provider against its server-side cap,
 * with a per-tier breakdown. `usage` is null when the report could not be read.
 */
export function AIUsagePanel({ usage }: { usage: MonthlyAIUsage | null }) {
  if (!usage) {
    return (
      <SectionCard role="region" aria-label={TITLE} eyebrow="Asia/Karachi" title={TITLE}>
        <p className="text-sm text-text-muted">
          Spend could not be loaded. Caps are still enforced when AI is routed; reload to try again.
        </p>
      </SectionCard>
    );
  }

  const idle = usage.providers.every((provider) =>
    provider.tiers.every((tier) => tier.calls === 0)
  );

  return (
    <SectionCard
      role="region"
      aria-label={TITLE}
      eyebrow={`Asia/Karachi · ${usage.month}`}
      title={TITLE}
      actions={
        <p className="font-mono text-xs tabular-nums text-text-muted">
          Total {money(usage.totalSpendMinor)}
        </p>
      }
    >
      {idle ? (
        <p className="mb-5 text-sm text-text-muted">No AI spend recorded this month.</p>
      ) : null}
      <div className="divide-y divide-border-subtle">
        {usage.providers.map((provider) => (
          <ProviderUsage
            key={provider.provider}
            usage={provider}
            nearCapPercent={usage.nearCapPercent}
          />
        ))}
      </div>
      <p className="mt-5 border-t border-border-subtle pt-4 text-xs text-text-muted">
        Caps from{' '}
        {usage.capSource === 'superadmin' ? 'SuperAdmin settings' : 'environment defaults'}. A
        provider at its cap is skipped until the next Asia/Karachi month.
      </p>
    </SectionCard>
  );
}
