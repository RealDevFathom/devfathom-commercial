import Link from 'next/link';
import { SectionCard } from '@/components/ui/section-card';
import { buttonVariants } from '@/components/ui/button';
import type { readPharmacyMarketingReport } from '@/lib/pharmacy/marketing-report';
import { formatReportPeriod } from './report-format';

// Owner-facing explanations of each figure. They restate the stored report definitions in plain words.
const DEFINITIONS = [
  'Messages prepared counts campaign messages set up for the selected branch and dates. Preparing a message does not mean it was sent.',
  'Accepted, delivered and failed come from WhatsApp delivery reports for real sends. Test sends are not included. A message can fail and later succeed on retry, so these can overlap.',
  'Result not known yet includes messages that were only prepared, only test-sent, or have conflicting delivery reports.',
  'Customer opt-outs are STOP requests received in the selected dates. Opt-outs with no branch are listed separately because they cannot be matched to a branch.',
  'Purchases after a message are purchases by the same customer at the same branch within seven days after a delivered message. Sales and margin come from Finance. This does not prove the message caused the purchase.',
];

const reasonLabel = (reason: string) => {
  const words = reason.replaceAll('_', ' ').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
};

export function MarketingSummary({
  report,
  money,
  branch,
  financial = false,
}: {
  report: Awaited<ReturnType<typeof readPharmacyMarketingReport>> | null;
  money: (minor: number | null) => string;
  branch?: string;
  financial?: boolean;
}) {
  const hidden = 'Needs finance access';
  return (
    <SectionCard
      title="Marketing results"
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
          Marketing results are not available for these dates or this branch. Nothing is shown as
          zero.
        </p>
      ) : (
        <div className="space-y-4 text-sm">
          <p className="text-text-muted">
            {formatReportPeriod(report.period.from, report.period.to)}. Branch and date filters
            apply; supplier, ingredient and batch filters do not.
          </p>
          <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {(
              [
                ['Messages prepared', report.prepared],
                ['Accepted by WhatsApp', report.providerAccepted],
                ['Delivered', report.delivered],
                ['Failed', report.failed],
                ['Result not known yet', report.unknown],
                ['Conflicting delivery reports', report.contradictory],
                ['Customer opt-outs', report.consentOptOuts],
                ['Opt-outs with no branch', report.unassignedConsentOptOuts],
                ['Purchases after a message', report.attribution.attributedReceipts],
                [
                  'Sales from those purchases',
                  financial ? money(report.attribution.recoveredSalesMinor) : hidden,
                ],
                [
                  'Margin from those purchases',
                  financial ? money(report.attribution.recoveredMarginMinor) : hidden,
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
            Test sends: {report.sandbox.captures} sent, {report.sandbox.delivered} delivered,{' '}
            {report.sandbox.failed} failed, {report.sandbox.unknown} not known. Test sends are not
            real customer messages.
          </p>
          <p>
            Not counted: {report.attribution.excludedUnverifiedLinks} purchases we could not
            confirm and {report.attribution.excludedCompetingLinks} purchases also linked to
            another message. Message cost is not tracked.
          </p>
          <details>
            <summary className="cursor-pointer focus-visible:outline-2 focus-visible:outline-ring">
              How these numbers are counted
            </summary>
            <ul className="mt-3 space-y-2 text-text-muted">
              {DEFINITIONS.map((definition) => (
                <li key={definition}>{definition}</li>
              ))}
            </ul>
            {report.exclusions.length ? (
              <>
                <p className="mt-3 font-medium text-text-body">Customers left out of campaigns</p>
                <ul className="mt-1 space-y-1">
                  {report.exclusions.map((row) => (
                    <li key={row.reason}>
                      {reasonLabel(row.reason)}: {row.count}
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
          </details>
        </div>
      )}
    </SectionCard>
  );
}
