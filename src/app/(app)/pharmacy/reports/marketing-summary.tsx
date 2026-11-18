import { SHOP_SCREEN_COPY as screenCopy } from '@/lib/pharmacy/screen-copy';
import { ReportDetails } from '@/components/pharmacy/report-details';
import { formatShopTime } from '@/lib/pharmacy/plain-language';
import Link from 'next/link';
import { SectionCard } from '@/components/ui/section-card';
import { buttonVariants } from '@/components/ui/button';
import type { readPharmacyMarketingReport } from '@/lib/pharmacy/marketing-report';

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
  return (
    <SectionCard
      title={screenCopy.marketing.campaignResults}
      titleLevel={2}
      actions={
        <Link
          className={buttonVariants({ variant: 'outline' })}
          href={`/pharmacy/marketing${branch ? `?branch=${encodeURIComponent(branch)}` : ''}`}
        >
          {screenCopy.marketing.reviewCampaigns}
        </Link>
      }
    >
      {!report ? (
        <p className="text-sm text-text-muted">
          {screenCopy.marketing.campaignResultsUnavailableForThisDateBranchOr}
        </p>
      ) : (
        <div className="space-y-4 text-sm">
          <ReportDetails>
            <p className="text-text-muted">
              {report.period.from}–{report.period.to} ({report.period.timezone}
              {screenCopy.marketing.evidenceCutoff} {formatShopTime(report.cutoff)}
              {screenCopy.marketing.branchAndDateFiltersApplySupplierIngredientAnd}
            </p>
          </ReportDetails>
          <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {(
              [
                ['Messages prepared', report.prepared],
                ['Accepted by delivery service', report.providerAccepted],
                ['Delivered', report.delivered],
                ['Failed deliveries', report.failed],
                ['Delivery not confirmed', report.unknown],
                ['Delivery needs a check', report.contradictory],
                ['Opt-outs at this branch', report.consentOptOuts],
                ['Opt-outs without a branch', report.unassignedConsentOptOuts],
                ['Linked receipts', report.attribution.attributedReceipts],
                [
                  'Sales linked to campaigns',
                  financial
                    ? money(report.attribution.recoveredSalesMinor)
                    : 'Financial permission required',
                ],
                [
                  'Margin linked to campaigns',
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
          {process.env.NODE_ENV !== 'production' ? (
            <ReportDetails>
              <p>
                {screenCopy.marketing.sandboxOnly}
                {report.sandbox.captures}
                {screenCopy.marketing.captures}
                {report.sandbox.delivered}
                {screenCopy.marketing.delivered} {report.sandbox.failed}
                {screenCopy.marketing.failed}
                {report.sandbox.unknown}
                {screenCopy.marketing.unknownTheseCountsDoNotProveLiveDelivery}
              </p>
            </ReportDetails>
          ) : null}
          <ReportDetails>
            <p>
              {screenCopy.marketing.excludedUnverifiedLinks}
              {report.attribution.excludedUnverifiedLinks}
              {screenCopy.marketing.competingReceiptLinksExcluded}
              {report.attribution.excludedCompetingLinks}
              {screenCopy.marketing.messageCostUnavailable}
            </p>
          </ReportDetails>
          <details>
            <summary className="cursor-pointer focus-visible:outline-2 focus-visible:outline-ring">
              {screenCopy.marketing.details}
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
