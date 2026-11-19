import 'server-only';

import { reconcileCapture } from './marketing-delivery';
import { eligibleMarketingReceipts, ATTRIBUTION_METHOD } from './marketing-attribution';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { workspaceTimezone } from '@/lib/timezone';
import {
  pharmacyBranchDayWindows,
  pharmacyCalendarDayRange,
  type PharmacyBranchDayEnds,
} from './business-day';

const DAY = 86_400_000;
export type MarketingReportFilters = {
  branchIds: string[];
  from: string;
  to: string;
  /** DEV-958A: each branch's own day-end history; a branch not listed is on midnight. */
  dayEnds?: PharmacyBranchDayEnds;
};

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
    // DEV-943: both callers (campaign results, lost sales) count these as the shop's own days.
    throw new Error('Use valid dates spanning at most 90 days and 1–100 authorized branches.');
  return { gte: from, lt: new Date(to.getTime() + DAY) };
}

export const MARKETING_REPORT_DEFINITIONS = {
  prepared:
    "Distinct persisted campaign captures in the selected branches and inclusive capture dates, counted as the organisation's own days. Preparation is not provider acceptance or delivery.",
  providerAccepted:
    'Distinct cohort captures with persisted Meta acceptance through the report cutoff; sandbox evidence excluded.',
  delivered:
    'Distinct cohort captures with bound Meta delivered callbacks through cutoff. Contradictions remain separately flagged.',
  failed:
    'Cohort captures with Meta failure evidence through cutoff, including failures before a later retry. Cumulative evidence counts overlap.',
  unknown:
    'Cohort captures without resolved live outcome, including preparation-only, sandbox-only and contradictory evidence. Does not imply a live attempt.',
  consentOptOuts:
    'Distinct inbound WhatsApp OPT_OUT logs recorded in the selected branches and dates. These are consent events, not campaign-attributed opt-outs or current consent state. Unassigned-branch events are excluded.',
  unassignedConsentOptOuts:
    'Organization-wide inbound WhatsApp OPT_OUT logs without a branch, in the selected dates. Reported separately because STOP intake currently has no branch. Counts received requests, not proof that the consent update committed.',
  optedOutExclusions:
    'Persisted campaign exclusions with reason OPTED_OUT evaluated in the selected branches and dates; not additional consent events.',
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

/**
 * Read-only consumer. Tenant and branch predicates are explicit on every query.
 * DEV-943: the inclusive dates are the organisation's own days, shop midnight to shop
 * midnight in `timeZone` (the caller's organisation zone, never an input), as every other
 * owner report counts them. A UTC organisation, or none, reads the same UTC days as before.
 * DEV-958A: each day ends at the branches' "day ends at" hour (midnight by default).
 */
export async function readPharmacyMarketingReport(
  db: ScopedDb,
  organizationId: string,
  input: MarketingReportFilters,
  timeZone?: string | null
) {
  validateMarketingReportFilters(input);
  const zone = workspaceTimezone(timeZone);
  // DEV-958A: each branch's campaigns on its own business days; across branches, their sum.
  // Opt-outs that name no branch belong to no branch's day, so they are always counted on the
  // organisation's calendar days: never on a window that depends on which branches are picked
  // or on their hours. At midnight the two are the same window, as before.
  const windows = pharmacyBranchDayWindows(input.from, input.to, input.branchIds, {
    timeZone: zone,
    dayEnds: input.dayEnds,
  });
  const calendar = pharmacyCalendarDayRange(input.from, input.to, zone);
  const report = await readMarketingWindows(
    db,
    organizationId,
    windows.map((window) => ({
      branchIds: window.branchIds,
      gte: window.from,
      lt: window.to,
    })),
    { gte: calendar.from, lt: calendar.to }
  );
  return { ...report, period: { from: input.from, to: input.to, timezone: zone } };
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
  return readMarketingWindows(db, organizationId, [{ branchIds, ...period }], period);
}

type MarketingWindow = { branchIds: string[]; gte: Date; lt: Date };

/**
 * The report over each branch group's own window (DEV-958A), summed: a branch's captures,
 * exclusions, opt-outs, attributions and receipts are read on that branch's window only.
 * Opt-outs that name no branch are read once, over `unassigned`.
 */
async function readMarketingWindows(
  db: ScopedDb,
  organizationId: string,
  windows: readonly MarketingWindow[],
  unassigned: { gte: Date; lt: Date }
) {
  const allBranchIds = windows.flatMap((window) => window.branchIds);
  if (
    !windows.length ||
    !allBranchIds.length ||
    allBranchIds.length > 100 ||
    windows.some((window) => {
      const span = window.lt.getTime() - window.gte.getTime();
      return !Number.isFinite(span) || span <= 0 || span > 90 * DAY + 2 * 3_600_000;
    })
  )
    throw new Error('Use a bounded window of at most 90 days and 1–100 authorized branches.');
  const parts = await Promise.all(
    windows.map((window) => readMarketingWindow(db, organizationId, window))
  );
  const unassignedConsentOptOuts = await db.pharmacyMessageLog.count({
    where: {
      organizationId,
      branchId: null,
      direction: 'INBOUND',
      kind: 'OPT_OUT',
      createdAt: unassigned,
      status: { in: ['RECEIVED', 'SENT'] },
    },
  });
  const exclusionCounts = new Map<string, number>();
  for (const part of parts)
    for (const row of part.exclusions)
      exclusionCounts.set(row.reason, (exclusionCounts.get(row.reason) ?? 0) + row._count._all);
  return summarizeMarketingWindows({
    period: {
      gte: new Date(Math.min(...windows.map((window) => window.gte.getTime()))),
      lt: new Date(Math.max(...windows.map((window) => window.lt.getTime()))),
    },
    captures: parts.flatMap((part) => part.captures),
    exclusions: [...exclusionCounts].map(([reason, count]) => ({
      reason,
      _count: { _all: count },
    })),
    consentOptOuts: parts.reduce((sum, part) => sum + part.consentOptOuts, 0),
    unassignedConsentOptOuts,
    attribution: parts.flatMap((part) => part.attribution),
    receipts: parts.flatMap((part) => part.receipts),
  });
}

async function readMarketingWindow(db: ScopedDb, organizationId: string, window: MarketingWindow) {
  const period = { gte: window.gte, lt: window.lt };
  const input = { branchIds: window.branchIds };
  const scope = { organizationId, branchId: { in: input.branchIds } };
  const [captures, exclusions, consentOptOuts, attribution, receipts] = await Promise.all([
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
  return { captures, exclusions, consentOptOuts, attribution, receipts };
}

function summarizeMarketingWindows({
  period,
  captures,
  exclusions,
  consentOptOuts,
  unassignedConsentOptOuts,
  attribution,
  receipts,
}: {
  period: { gte: Date; lt: Date };
  captures: Awaited<ReturnType<typeof readMarketingWindow>>['captures'];
  exclusions: { reason: string; _count: { _all: number } }[];
  consentOptOuts: number;
  unassignedConsentOptOuts: number;
  attribution: Awaited<ReturnType<typeof readMarketingWindow>>['attribution'];
  receipts: Awaited<ReturnType<typeof readMarketingWindow>>['receipts'];
}) {
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
