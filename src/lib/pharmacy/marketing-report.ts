import 'server-only';

import { reconcileCapture } from './marketing-delivery';
import { eligibleMarketingReceipts, ATTRIBUTION_METHOD } from './marketing-attribution';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

const DAY = 86_400_000;
export type MarketingReportFilters = { branchIds: string[]; from: string; to: string };

export function validateMarketingReportFilters(input: MarketingReportFilters) {
  const from = new Date(`${input.from}T00:00:00.000Z`);
  const to = new Date(`${input.to}T00:00:00.000Z`);
  if (
    !input.branchIds.length ||
    input.branchIds.length > 100 ||
    !Number.isFinite(from.getTime()) ||
    !Number.isFinite(to.getTime()) ||
    from.toISOString().slice(0, 10) !== input.from ||
    to.toISOString().slice(0, 10) !== input.to ||
    from > to ||
    to.getTime() - from.getTime() >= 90 * DAY
  )
    throw new Error('Use valid UTC dates spanning at most 90 days and 1–100 authorized branches.');
  return { gte: from, lt: new Date(to.getTime() + DAY) };
}

export const MARKETING_REPORT_DEFINITIONS = {
  prepared:
    'Distinct persisted campaign captures in the selected branches and inclusive UTC capture dates. Preparation is not provider acceptance or delivery.',
  providerAccepted:
    'Distinct cohort captures with persisted Meta acceptance through the report cutoff; sandbox evidence excluded.',
  delivered:
    'Distinct cohort captures with bound Meta delivered callbacks through cutoff. Contradictions remain separately flagged.',
  failed:
    'Cohort captures with Meta failure evidence through cutoff, including failures before a later retry. Cumulative evidence counts overlap.',
  unknown:
    'Cohort captures without resolved live outcome, including preparation-only, sandbox-only and contradictory evidence. Does not imply a live attempt.',
  consentOptOuts:
    'Distinct inbound WhatsApp OPT_OUT logs recorded in the selected branches and UTC dates. These are consent events, not campaign-attributed opt-outs or current consent state. Unassigned-branch events are excluded.',
  unassignedConsentOptOuts:
    'Organization-wide inbound WhatsApp OPT_OUT logs without a branch, in the selected UTC dates. Reported separately because STOP intake currently has no branch. Counts received requests, not proof that the consent update committed.',
  optedOutExclusions:
    'Persisted campaign exclusions with reason OPTED_OUT evaluated in the selected branches and UTC dates; not additional consent events.',
  attribution:
    'Estimated stored receipt links, revalidated against latest bound Meta delivery in the same tenant/customer/branch within seven days before completion. Receipt is the observed visit. Posted Finance sale/return amounts through cutoff determine net revenue and margin; sandbox and legacy links are excluded from verified totals. No causal uplift claim; message cost is unavailable.',
} as const;

export type StoredMarketingAttribution = {
  id: string;
  campaignId: string;
  visitId: string;
  receiptId: string;
  attributedAt: Date;
  method: string;
  windowDays: number;
  confidence: string;
  recoveredSalesMinor: number;
  recoveredMarginMinor: number;
  messageCostMinor: number;
};

/** Stable across query order and retries; each receipt contributes at most once. */
export function summarizeStoredMarketingAttribution(rows: StoredMarketingAttribution[]) {
  const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  const sorted = [...rows].sort(
    (a, b) =>
      b.attributedAt.getTime() - a.attributedAt.getTime() ||
      compare(a.campaignId, b.campaignId) ||
      compare(a.visitId, b.visitId) ||
      compare(a.id, b.id)
  );
  const receipts = new Set<string>();
  const selected = sorted.filter((row) => {
    if (receipts.has(row.receiptId)) return false;
    receipts.add(row.receiptId);
    return true;
  });
  return {
    estimated: true as const,
    selectionMethod: 'LATEST_RECORDED_LINK_PER_RECEIPT' as const,
    attributedReceipts: selected.length,
    excludedCompetingLinks: rows.length - selected.length,
    recoveredSalesMinor: selected.reduce((sum, row) => sum + row.recoveredSalesMinor, 0),
    recoveredMarginMinor: selected.reduce((sum, row) => sum + row.recoveredMarginMinor, 0),
    // Attribution costs cover selected links only, not the campaign's total spend.
    linkedMessageCostMinor: selected.reduce((sum, row) => sum + row.messageCostMinor, 0),
    methods: [...new Set(selected.map((row) => row.method))].sort(),
    windowDays: [...new Set(selected.map((row) => row.windowDays))].sort((a, b) => a - b),
    confidence: [...new Set(selected.map((row) => row.confidence))].sort(),
  };
}

/** Read-only consumer. Tenant and branch predicates are explicit on every query. */
export async function readPharmacyMarketingReport(
  db: ScopedDb,
  organizationId: string,
  input: MarketingReportFilters
) {
  const period = validateMarketingReportFilters(input);
  const report = await readPharmacyMarketingReportWindow(
    db,
    organizationId,
    input.branchIds,
    period
  );
  return { ...report, period: { from: input.from, to: input.to, timezone: 'UTC' as const } };
}

/**
 * The same report over an exact half-open window, for callers that already validated a
 * completed one-to-ninety-day period in the workspace zone (growth insights). The guard below
 * is a backstop, not the caller's period rule.
 */
export async function readPharmacyMarketingReportWindow(
  db: ScopedDb,
  organizationId: string,
  branchIds: string[],
  period: { gte: Date; lt: Date }
) {
  const span = period.lt.getTime() - period.gte.getTime();
  if (
    !branchIds.length ||
    branchIds.length > 100 ||
    !Number.isFinite(span) ||
    span <= 0 ||
    span > 90 * DAY + 2 * 3_600_000
  )
    throw new Error('Use a bounded window of at most 90 days and 1–100 authorized branches.');
  const input = { branchIds };
  const scope = { organizationId, branchId: { in: input.branchIds } };
  const [captures, exclusions, consentOptOuts, unassignedConsentOptOuts, attribution, receipts] =
    await Promise.all([
      db.pharmacyCampaignCapture.findMany({
        where: { ...scope, capturedAt: period },
        select: {
          id: true,
          dispatchAttempts: {
            where: { reservedAt: { lt: period.lt } },
            select: {
              provider: true,
              events: {
                where: { recordedAt: { lt: period.lt }, occurredAt: { lt: period.lt } },
                select: { state: true, reason: true },
              },
            },
          },
        },
      }),
      db.pharmacyCampaignExclusion.groupBy({
        by: ['reason'],
        where: { ...scope, evaluatedAt: period },
        _count: { _all: true },
      }),
      db.pharmacyMessageLog.count({
        where: {
          ...scope,
          direction: 'INBOUND',
          kind: 'OPT_OUT',
          createdAt: period,
          status: { in: ['RECEIVED', 'SENT'] },
        },
      }),
      db.pharmacyMessageLog.count({
        where: {
          organizationId,
          branchId: null,
          direction: 'INBOUND',
          kind: 'OPT_OUT',
          createdAt: period,
          status: { in: ['RECEIVED', 'SENT'] },
        },
      }),
      db.pharmacyCampaignAttribution.findMany({
        where: { ...scope, attributedAt: period },
        select: {
          id: true,
          campaignId: true,
          visitId: true,
          receiptId: true,
          attributedAt: true,
          method: true,
          windowDays: true,
          confidence: true,
          recoveredSalesMinor: true,
          recoveredMarginMinor: true,
          messageCostMinor: true,
        },
      }),
      eligibleMarketingReceipts(db, organizationId, input.branchIds, period.gte, period.lt),
    ]);
  if (receipts.length > 5000) throw new Error('Narrow the attribution window.');
  const live = captures.map((c) =>
    reconcileCapture(c.dispatchAttempts.filter((a) => a.provider === 'meta'))
  );
  const sandbox = captures.map((c) =>
    reconcileCapture(c.dispatchAttempts.filter((a) => a.provider === 'sandbox'))
  );
  const eligible = new Map(receipts.map((r) => [r.receiptId, r]));
  const verified = attribution.flatMap((row) => {
    const receipt = eligible.get(row.receiptId);
    return row.method === ATTRIBUTION_METHOD &&
      receipt?.campaignId === row.campaignId &&
      row.visitId === `receipt:${row.receiptId}`
      ? [
          {
            ...row,
            recoveredSalesMinor: receipt.salesMinor,
            recoveredMarginMinor: receipt.marginMinor,
          },
        ]
      : [];
  });
  return {
    period: { gte: period.gte.toISOString(), lt: period.lt.toISOString() },
    definitions: MARKETING_REPORT_DEFINITIONS,
    deliveryEvidenceAvailable: true as const,
    cutoff: period.lt.toISOString(),
    prepared: captures.length,
    providerAccepted: live.filter((e) => e.accepted).length,
    delivered: live.filter((e) => e.delivered).length,
    failed: live.filter((e) => e.failed).length,
    unknown: live.filter((e) => e.unknown).length,
    suppressed: live.filter((e) => e.suppressed).length,
    contradictory: live.filter((e) => e.contradictory).length,
    preparationOnly: captures.filter((c) => !c.dispatchAttempts.length).length,
    sandbox: {
      captures: captures.filter((c) => c.dispatchAttempts.some((a) => a.provider === 'sandbox'))
        .length,
      accepted: sandbox.filter((e) => e.accepted).length,
      delivered: sandbox.filter((e) => e.delivered).length,
      failed: sandbox.filter((e) => e.failed).length,
      suppressed: sandbox.filter((e) => e.suppressed).length,
      unknown: captures.filter(
        (c, i) => c.dispatchAttempts.some((a) => a.provider === 'sandbox') && sandbox[i].unknown
      ).length,
    },
    consentOptOuts,
    unassignedConsentOptOuts,
    optedOutExclusions: exclusions.find((row) => row.reason === 'OPTED_OUT')?._count._all ?? 0,
    exclusions: exclusions
      .map((row) => ({ reason: row.reason, count: row._count._all }))
      .sort((a, b) => (a.reason < b.reason ? -1 : a.reason > b.reason ? 1 : 0)),
    attribution: {
      ...summarizeStoredMarketingAttribution(verified),
      linkedMessageCostMinor: null,
      excludedUnverifiedLinks: attribution.length - verified.length,
    },
  };
}
