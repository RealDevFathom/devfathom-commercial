import Link from 'next/link';

import { SectionCard } from '@/components/ui/section-card';
import { StatusPill } from '@/components/ui/status-pill';
import type { FbrTier1Result } from '@/lib/pharmacy/fbr-tier1';

const RESULT_TONE: Record<FbrTier1Result, 'danger' | 'success' | 'warning'> = {
  TIER_1: 'danger',
  NOT_TIER_1: 'success',
  UNSURE: 'warning',
};

const dayFormat = new Intl.DateTimeFormat('en', { dateStyle: 'medium' });

/**
 * #709 — the onboarding and settings entry point to the Tier-1 self-check:
 * the latest result, and a prompt when it has never been answered or is twelve
 * months old.
 */
export function FbrTier1Summary({
  status,
}: {
  status: {
    recheckDue: boolean;
    latest: {
      assessedAt: Date | string;
      recheckDueAt: Date | string;
      evaluation: { result: FbrTier1Result; headline: string };
    } | null;
  };
}) {
  const { latest, recheckDue } = status;
  return (
    <SectionCard
      title="FBR: am I Tier-1?"
      titleLevel={2}
      compact
      actions={
        latest ? (
          <StatusPill
            status={latest.evaluation.result}
            label={latest.evaluation.headline}
            tone={RESULT_TONE[latest.evaluation.result]}
            className="max-w-40 whitespace-normal sm:max-w-none"
          />
        ) : (
          <StatusPill status="Not answered" tone="warning" />
        )
      }
    >
      <p className="text-sm text-text-body">
        {latest
          ? recheckDue
            ? `Last answered ${dayFormat.format(new Date(latest.assessedAt))}. Twelve months have passed — answer it again.`
            : `Last answered ${dayFormat.format(new Date(latest.assessedAt))}. Ask again by ${dayFormat.format(new Date(latest.recheckDueAt))}.`
          : 'Chain outlets, mall shops, large electricity users, wholesaler-retailers, card-payment POS holders and other FBR-prescribed categories must integrate with FBR. Check whether that includes you.'}{' '}
        <Link
          className="font-medium text-primary underline underline-offset-4 hover:text-accent-brand"
          href="/pharmacy/regulatory/fbr-tier-1"
        >
          {latest && !recheckDue ? 'Review the self-check' : 'Take the self-check'}
        </Link>
      </p>
      <p className="mt-2 text-xs text-text-muted">Guidance only — not tax advice.</p>
    </SectionCard>
  );
}
