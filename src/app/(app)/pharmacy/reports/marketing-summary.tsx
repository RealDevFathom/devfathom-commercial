import { reportDate } from '@/lib/pharmacy/report-presentation';
import Link from 'next/link';
import { SectionCard } from '@/components/ui/section-card';
import { buttonVariants } from '@/components/ui/button';
import type { readPharmacyMarketingReport } from '@/lib/pharmacy/marketing-report';

export function MarketingSummary({
  report,
  money,
  branch,
  financial = false,
  timezone = 'UTC',
}: {
  report: Awaited<ReturnType<typeof readPharmacyMarketingReport>> | null;
  money: (minor: number | null) => string;
  branch?: string;
  financial?: boolean;
  timezone?: string;
}) {
  return (
    <SectionCard
      title="Marketing evidence"
      titleLevel={2}
      actions={
        <Link
          className={buttonVariants({ variant: 'outline' })}
          href={`/pharmacy/marketing${branch ? `?branch=${encodeURIComponent(branch)}` : ''}`}
        >
          Review campaigns
        </Link>
      }
    >
      {!report ? (
        <p className="text-sm text-text-muted">
          Marketing evidence unavailable for this date, branch or permission scope. No zero totals
          inferred.
        </p>
      ) : (
        <div className="space-y-4 text-sm">
          <p className="text-text-muted">
            {report.period.from}–{report.period.to} ({report.period.timezone}); evidence cutoff{' '}
            {reportDate(report.cutoff, timezone)}. Branch and date filters apply. Supplier, ingredient and batch filters
            do not scope these figures.
          </p>
          <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {(
              [
                ['Prepared captures', report.prepared],
                ['Live accepted', report.providerAccepted],
                ['Live delivered', report.delivered],
                ['Live failure evidence', report.failed],
                ['Unresolved live outcome', report.unknown],
                ['Contradictory evidence', report.contradictory],
                ['Branch opt-out logs', report.consentOptOuts],
                ['Unassigned opt-out logs', report.unassignedConsentOptOuts],
                ['Observed attributed receipts', report.attribution.attributedReceipts],
                [
                  'Attributed net sales',
                  financial
                    ? money(report.attribution.recoveredSalesMinor)
                    : 'Financial permission required',
                ],
                [
                  'Attributed signed margin',
                  financial
                    ? money(report.attribution.recoveredMarginMinor)
                    : 'Financial permission required',
                ],
              ] as const
            ).map(([label, value]) => (
              <div key={label}>
                <dt className="text-text-muted">{label}</dt>
                <dd className="font-mono tabular-nums text-text-strong">{value}</dd>
              </div>
            ))}
          </dl>
          <p>
            Sandbox only: {report.sandbox.captures} captures, {report.sandbox.delivered} delivered,{' '}
            {report.sandbox.failed} failed, {report.sandbox.unknown} unknown. These counts do not
            prove live delivery.
          </p>
          <p>
            Excluded unverified links: {report.attribution.excludedUnverifiedLinks}. Competing
            receipt links excluded: {report.attribution.excludedCompetingLinks}. Message cost
            unavailable.
          </p>
          <details>
            <summary className="cursor-pointer focus-visible:outline-2 focus-visible:outline-ring">
              Definitions and exclusions
            </summary>
            <ul className="mt-3 space-y-2 text-text-muted">
              {Object.entries(report.definitions).map(([key, definition]) => (
                <li key={key}>{definition}</li>
              ))}
            </ul>
            <ul className="mt-3 space-y-1">
              {report.exclusions.map((row) => (
                <li key={row.reason}>
                  {row.reason}: {row.count}
                </li>
              ))}
            </ul>
          </details>
        </div>
      )}
    </SectionCard>
  );
}
