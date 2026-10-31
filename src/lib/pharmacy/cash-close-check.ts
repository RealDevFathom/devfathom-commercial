import { PHARMACY_ANOMALY_POLICY } from './anomaly-signals';

/**
 * #728 — cash-close anomaly check. Pure rules over one branch/business day's
 * close evidence (drawer counts, refunds, voids) plus a plain-language
 * narrative. Read-only by construction: this module has no database, command,
 * posting or notification dependency. Thresholds reuse the AI-04 anomaly
 * policy where one already exists, so the check never disagrees with the
 * CASH_VARIANCE / GHOST_RETURN signals the owner already sees.
 */
export const CASH_CLOSE_CHECK_POLICY = {
  version: 'CC01-2026-11-01',
  cashVariance: PHARMACY_ANOMALY_POLICY.cashVariance,
  unmatchedRefunds: { minimum: PHARMACY_ANOMALY_POLICY.ghostReturn.minimumUnmatchedRefunds },
  refundRate: { minimumRateBps: 1_000, minimumMinor: 50_000 },
  voids: { minimumCount: 3, minimumRateBps: 1_000, absoluteCount: 10 },
  actorConcentration: { minimumEvents: 3, minimumShareBps: 8_000 },
} as const;

export type CashCloseFindingKind =
  | 'CLOSE_VARIANCE'
  | 'DRAWER_VARIANCE'
  | 'VARIANCE_WITHOUT_NOTE'
  | 'REFUND_RATE'
  | 'UNMATCHED_REFUNDS'
  | 'VOID_VOLUME'
  | 'ACTOR_CONCENTRATION';

export type CashCloseFacts = {
  businessDate: string;
  /** The latest Z report for the day, or null when the day is still open. */
  close: {
    id: string;
    sequence: number;
    cashExpectedMinor: number;
    cashCountedMinor: number;
    cashVarianceMinor: number;
    varianceNote: string | null;
  } | null;
  grossSalesMinor: number;
  completedSales: number;
  drawers: Array<{
    id: string;
    label: string;
    expectedMinor: number;
    /** Null while the drawer has not been counted. */
    countedMinor: number | null;
  }>;
  refunds: Array<{
    id: string;
    saleId: string;
    actorId: string;
    amountMinor: number;
    /** A stock-return record exists for the refunded sale. */
    matchedReturn: boolean;
  }>;
  voids: Array<{ saleId: string; actorId: string; valueMinor: number }>;
  /** Display names for actor ids; absent names are rendered as "a team member". */
  actorNames?: Record<string, string>;
};

export type CashCloseFinding = {
  kind: CashCloseFindingKind;
  severity: 'NOTICE' | 'REVIEW' | 'URGENT';
  subject: Record<string, string>;
  exactNumbers: Record<string, number>;
  explanation: string;
};

export type CashCloseCheck = {
  policyVersion: string;
  businessDate: string;
  closed: boolean;
  closeId: string | null;
  readOnly: true;
  totals: {
    grossSalesMinor: number;
    completedSales: number;
    refundCount: number;
    refundTotalMinor: number;
    unmatchedRefundCount: number;
    voidCount: number;
    voidValueMinor: number;
    cashExpectedMinor: number;
    cashCountedMinor: number | null;
    cashVarianceMinor: number | null;
  };
  findings: CashCloseFinding[];
  narrative: string;
};

const abs = (value: number) => Math.abs(value);
const rateBps = (part: number, total: number) =>
  total <= 0 ? 0 : Math.round((abs(part) * 10_000) / abs(total));
const pct = (bps: number) => `${(bps / 100).toFixed(2)}%`;
export const formatCloseMoney = (minor: number) =>
  `${minor < 0 ? '-' : ''}PKR ${(abs(minor) / 100).toFixed(2)}`;
const signed = (minor: number) =>
  minor === 0
    ? formatCloseMoney(0)
    : `${minor > 0 ? 'over' : 'short'} ${formatCloseMoney(abs(minor))}`;

function materiality(expectedMinor: number, policy = CASH_CLOSE_CHECK_POLICY) {
  return Math.max(
    policy.cashVariance.minimumMinor,
    Math.round((abs(expectedMinor) * policy.cashVariance.minimumRateBps) / 10_000)
  );
}

const SEVERITY_RANK = { URGENT: 0, REVIEW: 1, NOTICE: 2 } as const;

/** Evaluates every rule; never throws for well-formed facts and never mutates them. */
export function checkPharmacyCashClose(
  facts: CashCloseFacts,
  policy = CASH_CLOSE_CHECK_POLICY
): CashCloseCheck {
  const findings: CashCloseFinding[] = [];
  const name = (actorId: string) => facts.actorNames?.[actorId] ?? 'a team member';

  const counted = facts.drawers.filter((drawer) => drawer.countedMinor !== null);
  const drawerExpected = facts.drawers.reduce((sum, drawer) => sum + drawer.expectedMinor, 0);
  const cashExpectedMinor = facts.close?.cashExpectedMinor ?? drawerExpected;
  const cashCountedMinor = facts.close
    ? facts.close.cashCountedMinor
    : counted.length === facts.drawers.length && counted.length > 0
      ? counted.reduce((sum, drawer) => sum + (drawer.countedMinor ?? 0), 0)
      : null;
  const cashVarianceMinor = facts.close
    ? facts.close.cashVarianceMinor
    : cashCountedMinor === null
      ? null
      : cashCountedMinor - cashExpectedMinor;

  // Rule 1 — net close variance against the AI-04 materiality floor.
  if (cashVarianceMinor !== null && cashCountedMinor !== null) {
    const floor = materiality(cashExpectedMinor, policy);
    if (abs(cashVarianceMinor) >= floor) {
      findings.push({
        kind: 'CLOSE_VARIANCE',
        severity: abs(cashVarianceMinor) >= floor * 2 ? 'URGENT' : 'REVIEW',
        subject: { businessDate: facts.businessDate },
        exactNumbers: {
          expectedMinor: cashExpectedMinor,
          countedMinor: cashCountedMinor,
          varianceMinor: cashVarianceMinor,
          varianceRateBps: rateBps(cashVarianceMinor, cashExpectedMinor),
          materialityMinor: floor,
        },
        explanation: `Cash counted ${formatCloseMoney(cashCountedMinor)} against ${formatCloseMoney(cashExpectedMinor)} expected — ${signed(cashVarianceMinor)} (${pct(rateBps(cashVarianceMinor, cashExpectedMinor))}), at or above the ${formatCloseMoney(floor)} review floor.`,
      });
    }
  }

  // Rule 2 — individual drawers. Offsetting drawers can hide inside a small net figure.
  // A single drawer is the net figure, so it is only evaluated when there are several.
  for (const drawer of facts.drawers.length > 1 ? counted : []) {
    const variance = (drawer.countedMinor ?? 0) - drawer.expectedMinor;
    const floor = materiality(drawer.expectedMinor, policy);
    if (abs(variance) < floor) continue;
    findings.push({
      kind: 'DRAWER_VARIANCE',
      severity: abs(variance) >= floor * 2 ? 'URGENT' : 'REVIEW',
      subject: { drawerSessionId: drawer.id },
      exactNumbers: {
        expectedMinor: drawer.expectedMinor,
        countedMinor: drawer.countedMinor ?? 0,
        varianceMinor: variance,
        materialityMinor: floor,
      },
      explanation: `Drawer ${drawer.label} was ${signed(variance)} (${formatCloseMoney(drawer.countedMinor ?? 0)} counted, ${formatCloseMoney(drawer.expectedMinor)} expected).`,
    });
  }

  // Rule 3 — a recorded variance with no operator explanation on the Z report.
  if (facts.close && facts.close.cashVarianceMinor !== 0 && !facts.close.varianceNote?.trim()) {
    findings.push({
      kind: 'VARIANCE_WITHOUT_NOTE',
      severity: 'NOTICE',
      subject: { closeId: facts.close.id },
      exactNumbers: { varianceMinor: facts.close.cashVarianceMinor },
      explanation: `The close records a ${signed(facts.close.cashVarianceMinor)} variance with no variance note.`,
    });
  }

  // Rule 4 — refunds as a share of the day's gross sales.
  const refundTotalMinor = facts.refunds.reduce((sum, refund) => sum + refund.amountMinor, 0);
  const refundRateBps = rateBps(refundTotalMinor, facts.grossSalesMinor);
  if (
    refundTotalMinor >= policy.refundRate.minimumMinor &&
    (facts.grossSalesMinor <= 0 || refundRateBps >= policy.refundRate.minimumRateBps)
  ) {
    findings.push({
      kind: 'REFUND_RATE',
      severity:
        facts.grossSalesMinor <= 0 || refundRateBps >= policy.refundRate.minimumRateBps * 2
          ? 'URGENT'
          : 'REVIEW',
      subject: { businessDate: facts.businessDate },
      exactNumbers: {
        refundCount: facts.refunds.length,
        refundTotalMinor,
        grossSalesMinor: facts.grossSalesMinor,
        refundRateBps,
        thresholdRateBps: policy.refundRate.minimumRateBps,
      },
      explanation:
        facts.grossSalesMinor <= 0
          ? `${facts.refunds.length} refunds totalling ${formatCloseMoney(refundTotalMinor)} were paid on a day with no completed sales.`
          : `${facts.refunds.length} refunds totalling ${formatCloseMoney(refundTotalMinor)} are ${pct(refundRateBps)} of ${formatCloseMoney(facts.grossSalesMinor)} gross sales, at or above the ${pct(policy.refundRate.minimumRateBps)} review threshold.`,
    });
  }

  // Rule 5 — refunds with no stock-return record behind them.
  const unmatched = facts.refunds.filter((refund) => !refund.matchedReturn);
  if (unmatched.length >= policy.unmatchedRefunds.minimum) {
    const amount = unmatched.reduce((sum, refund) => sum + refund.amountMinor, 0);
    findings.push({
      kind: 'UNMATCHED_REFUNDS',
      severity: unmatched.length >= policy.unmatchedRefunds.minimum * 2 ? 'URGENT' : 'REVIEW',
      subject: { businessDate: facts.businessDate },
      exactNumbers: {
        unmatchedRefunds: unmatched.length,
        unmatchedAmountMinor: amount,
        thresholdRefunds: policy.unmatchedRefunds.minimum,
      },
      explanation: `${unmatched.length} refunds totalling ${formatCloseMoney(amount)} have no matching stock-return record.`,
    });
  }

  // Rule 6 — voided sales, by count and by share of all finished sale attempts.
  const voidValueMinor = facts.voids.reduce((sum, item) => sum + item.valueMinor, 0);
  const voidRateBps = rateBps(facts.voids.length, facts.voids.length + facts.completedSales);
  if (
    facts.voids.length >= policy.voids.absoluteCount ||
    (facts.voids.length >= policy.voids.minimumCount &&
      voidRateBps >= policy.voids.minimumRateBps)
  ) {
    findings.push({
      kind: 'VOID_VOLUME',
      severity:
        facts.voids.length >= policy.voids.absoluteCount ||
        voidRateBps >= policy.voids.minimumRateBps * 2
          ? 'URGENT'
          : 'REVIEW',
      subject: { businessDate: facts.businessDate },
      exactNumbers: {
        voidCount: facts.voids.length,
        voidValueMinor,
        completedSales: facts.completedSales,
        voidRateBps,
        thresholdCount: policy.voids.minimumCount,
        thresholdRateBps: policy.voids.minimumRateBps,
      },
      explanation: `${facts.voids.length} sales worth ${formatCloseMoney(voidValueMinor)} were voided against ${facts.completedSales} completed (${pct(voidRateBps)} of sale attempts).`,
    });
  }

  // Rule 7 — refunds and voids concentrated on one team member.
  const events = [
    ...facts.refunds.map((refund) => refund.actorId),
    ...facts.voids.map((item) => item.actorId),
  ];
  if (events.length >= policy.actorConcentration.minimumEvents) {
    const byActor = new Map<string, number>();
    for (const actorId of events) byActor.set(actorId, (byActor.get(actorId) ?? 0) + 1);
    const [top] = [...byActor.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const share = rateBps(top[1], events.length);
    if (
      byActor.size > 1 &&
      top[1] >= policy.actorConcentration.minimumEvents &&
      share >= policy.actorConcentration.minimumShareBps
    ) {
      findings.push({
        kind: 'ACTOR_CONCENTRATION',
        severity: 'NOTICE',
        subject: { actorId: top[0] },
        exactNumbers: {
          actorEvents: top[1],
          totalEvents: events.length,
          shareBps: share,
          thresholdShareBps: policy.actorConcentration.minimumShareBps,
        },
        explanation: `${top[1]} of ${events.length} refunds and voids (${pct(share)}) were recorded by ${name(top[0])}.`,
      });
    }
  }

  findings.sort(
    (a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || a.kind.localeCompare(b.kind)
  );

  const totals = {
    grossSalesMinor: facts.grossSalesMinor,
    completedSales: facts.completedSales,
    refundCount: facts.refunds.length,
    refundTotalMinor,
    unmatchedRefundCount: unmatched.length,
    voidCount: facts.voids.length,
    voidValueMinor,
    cashExpectedMinor,
    cashCountedMinor,
    cashVarianceMinor,
  };
  return {
    policyVersion: policy.version,
    businessDate: facts.businessDate,
    closed: Boolean(facts.close),
    closeId: facts.close?.id ?? null,
    readOnly: true,
    totals,
    findings,
    narrative: narrateCashCloseCheck(facts.businessDate, Boolean(facts.close), totals, findings),
  };
}

/**
 * The owner-facing narrative. Deterministic so it can be shown without a model
 * call and cited verbatim by Ask Fathom; it states facts and review prompts,
 * never a cause, accusation or instruction to change the books.
 */
export function narrateCashCloseCheck(
  businessDate: string,
  closed: boolean,
  totals: CashCloseCheck['totals'],
  findings: CashCloseFinding[]
): string {
  const status = closed ? 'closed' : 'still open (preview figures)';
  const cash =
    totals.cashVarianceMinor === null || totals.cashCountedMinor === null
      ? `Expected drawer cash is ${formatCloseMoney(totals.cashExpectedMinor)}; not every drawer has been counted yet.`
      : `Cash counted ${formatCloseMoney(totals.cashCountedMinor)} against ${formatCloseMoney(totals.cashExpectedMinor)} expected (${signed(totals.cashVarianceMinor)}).`;
  const activity = `Gross sales ${formatCloseMoney(totals.grossSalesMinor)} across ${totals.completedSales} sales; ${totals.refundCount} refunds (${formatCloseMoney(totals.refundTotalMinor)}); ${totals.voidCount} voids (${formatCloseMoney(totals.voidValueMinor)}).`;
  const head = `Cash-close check for ${businessDate} (${status}). ${cash} ${activity}`;
  if (!findings.length)
    return `${head} No rule flagged this close. This check is read-only and changes nothing.`;
  const urgent = findings.filter((finding) => finding.severity === 'URGENT').length;
  const lines = findings.map(
    (finding) => `- [${finding.severity.toLowerCase()}] ${finding.explanation}`
  );
  return [
    `${head} ${findings.length} item${findings.length === 1 ? '' : 's'} to review${urgent ? `, ${urgent} urgent` : ''}:`,
    ...lines,
    'These are review prompts from recorded events, not findings of misconduct. The check is read-only: it posts nothing, reopens nothing and contacts no one.',
  ].join('\n');
}
