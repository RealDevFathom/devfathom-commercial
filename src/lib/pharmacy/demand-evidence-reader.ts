import 'server-only';

import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { pharmacyBusinessDay, pharmacyBusinessDayRange } from './business-day';
import {
  demandDateAfter,
  demandDateMs,
  safeDemandTotal,
  type DemandEvidenceInput,
  type DemandScope,
} from './demand-evidence';

const MAX_HISTORY_DAYS = 90;
const MAX_SOURCE_ROWS = 10_000;

export type PharmacyDemandEvidenceReaderInput = DemandScope & {
  /** Server-authorized branch IDs, never an untrusted request's assertion. */
  authorizedBranchIds: readonly string[];
  historyStartDate: string;
  originDate: string;
  horizonDays: DemandEvidenceInput['horizonDays'];
  method: DemandEvidenceInput['method'];
  /**
   * The caller's own organisation zone, loaded on the server (never request input): the
   * completion and stockout capture days are that clock's days. UTC when absent or refused.
   */
  timeZone?: string | null;
  /** DEV-958A: the hour the branch's business day ends at (midnight when absent). */
  dayEndsAtHour?: number | null;
};

type ConsumptionDay = {
  date: string;
  /** Frozen completed-line quantities. Null means no qualifying recorded lines. */
  observedCanonicalUnits: number | null;
  lineCount: number;
};

export type PharmacyDemandEvidence = {
  scope: DemandScope;
  period: { startDate: string; endDateExclusive: string };
  provenance: {
    kind: 'OBSERVED_TRANSACTIONS';
    readAt: string;
    reference: string;
    historicalVersionsAvailable: false;
    sources: readonly string[];
  };
  consumption: {
    timeBasis: 'SALE_BUSINESS_DATE';
    days: ConsumptionDay[];
    observedCanonicalUnits: number | null;
  };
  /**
   * Completion instants and stockout capture instants, grouped by their calendar day on the
   * organisation's clock (UTC for an organisation on UTC), not by business-date labels.
   */
  days: (ConsumptionDay & {
    timeBasis: 'WORKSPACE_DAY';
    state: 'UNKNOWN' | 'STOCKOUT_CENSORED';
    stockoutEventCount: number;
    estimatedDemandUnits: null;
    /** No first-availability timestamp for the exact historical aggregate exists. */
    knownAt: null;
  })[];
  coverage: {
    requestedDays: number;
    businessConsumptionDays: number;
    completionDayConsumptionDays: number;
    observedDemandDays: 0;
    unknownDays: number;
    censoredDays: number;
    sourceLineRows: number;
    sourceStockoutRows: number;
    qualifyingLineCount: number;
    excludedLineCount: number;
    excludedStockoutCount: number;
    missingBusinessDateLineCount: number;
    missingCompletedAtLineCount: number;
    factsAfterReadAtLineCount: number;
    /** Current facts dated at/after origin; this is not an ingestion watermark. */
    factsAtOrAfterOriginLineCount: number;
    businessCompletionDateMismatchLineCount: number;
  };
  missingInputs: string[];
  forecastInput: DemandEvidenceInput | null;
  backtestEligibility: { eligible: false; reasons: string[] };
};

/**
 * Read-only current evidence. Caller supplies a tenant-scoped db and authorized scope after
 * the existing reports license/capability gates. This function does not grant report access.
 * readAt bounds stored timestamps; it cannot reconstruct database state at a historical time.
 * No current schema source proves full-day availability, completeness or historical versions,
 * so consumption never becomes an uncensored OBSERVED demand day or a backtest input.
 */
export async function readPharmacyDemandEvidence(
  db: ScopedDb,
  input: PharmacyDemandEvidenceReaderInput,
  readAt: Date = new Date()
): Promise<PharmacyDemandEvidence> {
  const scope = {
    organizationId: input.organizationId,
    branchId: input.branchId,
    medicineId: input.medicineId,
  };
  if (Object.values(scope).some((id) => !id.trim() || id.length > 128))
    throw new RangeError('A valid organization, branch and medicine scope is required');
  if (!input.authorizedBranchIds.includes(input.branchId))
    throw new Error('Branch is outside authorized scope');
  const start = demandDateMs(input.historyStartDate);
  const end = demandDateMs(input.originDate);
  const requestedDays = (end - start) / 86_400_000;
  if (
    !Number.isFinite(readAt.getTime()) ||
    requestedDays < 1 ||
    requestedDays > MAX_HISTORY_DAYS ||
    !Number.isInteger(input.horizonDays) ||
    input.horizonDays < 1 ||
    input.horizonDays > 366 ||
    !['RECENT_MEAN', 'WEEKLY_SEASONAL_NAIVE'].includes(input.method)
  )
    throw new RangeError(
      'Use 1..90 history days, 1..366 forecast days and a valid read instant/method'
    );
  demandDateAfter(input.originDate, input.horizonDays);
  const cutoff = new Date(readAt.getTime());
  // Business dates are stored day labels: they compare as UTC-midnight dates. Completion and
  // stockout capture instants are bounded by the same days on the organisation's clock.
  const labels = { gte: new Date(start), lt: new Date(end) };
  // DEV-958A: the branch's business days, which end at its "day ends at" hour.
  const shopDays = pharmacyBusinessDayRange(
    input.historyStartDate,
    demandDateAfter(input.originDate, -1),
    input
  );
  const instants = { gte: shopDays.from, lt: shopDays.to };
  const shopDay = (at: Date) => pharmacyBusinessDay(input, at);
  const branch = await db.pharmacyBranch.findFirst({
    where: { id: scope.branchId, organizationId: scope.organizationId, active: true },
    select: { id: true, organizationId: true, active: true },
  });
  if (
    !branch ||
    branch.id !== scope.branchId ||
    branch.organizationId !== scope.organizationId ||
    !branch.active
  )
    throw new Error('Branch is outside active authorized scope');
  const medicine = await db.medicine.findFirst({
    where: { id: scope.medicineId, organizationId: scope.organizationId },
    select: { id: true, organizationId: true },
  });
  if (
    !medicine ||
    medicine.id !== scope.medicineId ||
    medicine.organizationId !== scope.organizationId
  )
    throw new Error('Medicine is outside organization scope');

  // Separate projections: no identities, prescriptions, event payloads or free-text fields.
  const lines = await db.pharmacySaleLine.findMany({
    where: {
      ...scope,
      sale: {
        organizationId: scope.organizationId,
        branchId: scope.branchId,
        status: 'COMPLETED',
        OR: [{ businessDate: labels }, { completedAt: instants }],
      },
    },
    select: {
      id: true,
      organizationId: true,
      branchId: true,
      medicineId: true,
      canonicalUnits: true,
      createdAt: true,
      sale: {
        select: {
          organizationId: true,
          branchId: true,
          status: true,
          businessDate: true,
          completedAt: true,
          createdAt: true,
          updatedAt: true,
        },
      },
    },
    orderBy: { id: 'asc' },
    take: MAX_SOURCE_ROWS + 1,
  });
  if (lines.length > MAX_SOURCE_ROWS)
    throw new RangeError('Consumption row limit exceeded; narrow the history');
  const stockouts = await db.unfulfilledDemandEvent.findMany({
    where: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      requestedMedicineId: scope.medicineId,
      reason: 'STOCKOUT',
      createdAt: { ...instants, lte: cutoff },
    },
    select: {
      id: true,
      organizationId: true,
      branchId: true,
      requestedMedicineId: true,
      reason: true,
      createdAt: true,
    },
    orderBy: { id: 'asc' },
    take: MAX_SOURCE_ROWS + 1,
  });
  if (stockouts.length > MAX_SOURCE_ROWS)
    throw new RangeError('Stockout row limit exceeded; narrow the history');

  const dates = Array.from({ length: requestedDays }, (_, i) =>
    demandDateAfter(input.historyStartDate, i)
  );
  const businessDays = new Map(
    dates.map((date) => [
      date,
      { date, observedCanonicalUnits: null, lineCount: 0 } as ConsumptionDay,
    ])
  );
  const completionDays = new Map(
    dates.map((date) => [
      date,
      {
        date,
        observedCanonicalUnits: null,
        lineCount: 0,
        timeBasis: 'WORKSPACE_DAY' as const,
        state: 'UNKNOWN' as 'UNKNOWN' | 'STOCKOUT_CENSORED',
        stockoutEventCount: 0,
        estimatedDemandUnits: null,
        knownAt: null,
      },
    ])
  );
  const coverage: PharmacyDemandEvidence['coverage'] = {
    requestedDays,
    businessConsumptionDays: 0,
    completionDayConsumptionDays: 0,
    observedDemandDays: 0,
    unknownDays: requestedDays,
    censoredDays: 0,
    sourceLineRows: lines.length,
    sourceStockoutRows: stockouts.length,
    qualifyingLineCount: 0,
    excludedLineCount: 0,
    excludedStockoutCount: 0,
    missingBusinessDateLineCount: 0,
    missingCompletedAtLineCount: 0,
    factsAfterReadAtLineCount: 0,
    factsAtOrAfterOriginLineCount: 0,
    businessCompletionDateMismatchLineCount: 0,
  };
  const lineIds = new Set<string>();
  const add = (day: ConsumptionDay | undefined, units: number) => {
    if (!day) return;
    day.observedCanonicalUnits = safeDemandTotal([day.observedCanonicalUnits ?? 0, units]);
    day.lineCount += 1;
  };
  const instant = (date: Date): number => {
    if (!Number.isFinite(date.getTime())) throw new RangeError('Invalid source timestamp');
    return date.getTime();
  };
  for (const line of lines) {
    const sale = line.sale;
    if (
      line.organizationId !== scope.organizationId ||
      line.branchId !== scope.branchId ||
      line.medicineId !== scope.medicineId ||
      sale.organizationId !== scope.organizationId ||
      sale.branchId !== scope.branchId ||
      sale.status !== 'COMPLETED'
    ) {
      coverage.excludedLineCount += 1;
      continue;
    }
    if (lineIds.has(line.id)) throw new Error('Duplicate consumption source line');
    lineIds.add(line.id);
    if (!sale.completedAt) {
      coverage.missingCompletedAtLineCount += 1;
      coverage.excludedLineCount += 1;
      continue;
    }
    const factTimes = [line.createdAt, sale.createdAt, sale.updatedAt, sale.completedAt].map(
      instant
    );
    if (factTimes.some((ms) => ms > cutoff.getTime())) {
      coverage.factsAfterReadAtLineCount += 1;
      coverage.excludedLineCount += 1;
      continue;
    }
    const completedDate = shopDay(sale.completedAt);
    const businessDate = sale.businessDate?.toISOString().slice(0, 10) ?? null;
    if (sale.businessDate && instant(sale.businessDate) !== demandDateMs(businessDate!))
      throw new RangeError('Expected a stored business-date label, not an instant');
    if (!completionDays.has(completedDate) && (!businessDate || !businessDays.has(businessDate))) {
      coverage.excludedLineCount += 1;
      continue;
    }
    safeDemandTotal([line.canonicalUnits]);
    coverage.qualifyingLineCount += 1;
    if (factTimes.some((ms) => ms >= shopDays.to.getTime()))
      coverage.factsAtOrAfterOriginLineCount += 1;
    if (!businessDate) coverage.missingBusinessDateLineCount += 1;
    else {
      if (businessDate !== completedDate) coverage.businessCompletionDateMismatchLineCount += 1;
      add(businessDays.get(businessDate), line.canonicalUnits);
    }
    add(completionDays.get(completedDate), line.canonicalUnits);
  }
  const stockoutIds = new Set<string>();
  for (const event of stockouts) {
    if (
      event.organizationId !== scope.organizationId ||
      event.branchId !== scope.branchId ||
      event.requestedMedicineId !== scope.medicineId ||
      event.reason !== 'STOCKOUT' ||
      instant(event.createdAt) > cutoff.getTime()
    ) {
      coverage.excludedStockoutCount += 1;
      continue;
    }
    if (stockoutIds.has(event.id)) throw new Error('Duplicate stockout source event');
    stockoutIds.add(event.id);
    const day = completionDays.get(shopDay(event.createdAt));
    if (!day) {
      coverage.excludedStockoutCount += 1;
      continue;
    }
    day.state = 'STOCKOUT_CENSORED';
    day.stockoutEventCount += 1;
  }
  const consumptionDays = [...businessDays.values()];
  const days = [...completionDays.values()];
  coverage.businessConsumptionDays = consumptionDays.filter((day) => day.lineCount > 0).length;
  coverage.completionDayConsumptionDays = days.filter((day) => day.lineCount > 0).length;
  coverage.censoredDays = days.filter((day) => day.state === 'STOCKOUT_CENSORED').length;
  coverage.unknownDays -= coverage.censoredDays;
  // Validate each view's complete sum, not just individual days.
  safeDemandTotal(days.map((day) => day.observedCanonicalUnits ?? 0));
  const total = safeDemandTotal(consumptionDays.map((day) => day.observedCanonicalUnits ?? 0));
  const missingInputs = [
    'Full-day stock availability: absence of a stockout event does not prove availability.',
    'Trading calendar: accounting daily closes do not establish closed-for-business days.',
    'Observation completeness: no-sale days and missing/offline facts are unknown, not zero demand.',
    'Historical versions and first-availability timestamps for exact observations are unavailable.',
    "Business-day to clock interval mapping is unavailable; business labels and completion/capture days on the organisation's clock remain separate.",
    ...(coverage.censoredDays
      ? [
          'Stockout quantities lack frozen canonical conversion and are not added to consumption or estimated demand.',
        ]
      : []),
    ...(coverage.missingBusinessDateLineCount
      ? ['Some qualifying completed lines have no business date.']
      : []),
    ...(coverage.missingCompletedAtLineCount
      ? ['Some completed-status lines have no completion timestamp and were excluded.']
      : []),
    ...(coverage.factsAfterReadAtLineCount
      ? ['Facts after readAt were excluded; prior versions cannot be reconstructed.']
      : []),
  ];
  return {
    scope,
    period: { startDate: input.historyStartDate, endDateExclusive: input.originDate },
    provenance: {
      kind: 'OBSERVED_TRANSACTIONS',
      readAt: cutoff.toISOString(),
      reference: 'pharmacy_sales + pharmacy_sale_lines + pharmacy_unfulfilled_demand_events',
      historicalVersionsAvailable: false,
      sources: [
        'Current COMPLETED sales: businessDate, completedAt, createdAt, updatedAt; frozen sale-line canonicalUnits and createdAt.',
        'Explicit STOCKOUT events: createdAt is UTC capture time, not a historical-version watermark. Recovered/closed events still evidence a stockout.',
        'Returns, refunds, voids and adjustments are not netted into completed-line consumption.',
      ],
    },
    consumption: {
      timeBasis: 'SALE_BUSINESS_DATE',
      days: consumptionDays,
      observedCanonicalUnits: coverage.businessConsumptionDays ? total : null,
    },
    days,
    coverage,
    missingInputs,
    forecastInput: null,
    backtestEligibility: {
      eligible: false,
      reasons: [
        'No complete uncensored demand days are established.',
        'Historical versions and exact knownAt timestamps are unavailable.',
      ],
    },
  };
}
