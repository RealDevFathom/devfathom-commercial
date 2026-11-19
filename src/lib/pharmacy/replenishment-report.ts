import 'server-only';

import { z } from 'zod';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { pharmacyBusinessDayRange, type PharmacyDayEnd } from './business-day';
import { demandDateAfter, demandDateMs, forecastDemandEvidence } from './demand-evidence';
import {
  readPharmacyDemandEvidence,
  type PharmacyDemandEvidenceReaderInput,
} from './demand-evidence-reader';
import { loadForecastingInputs } from './forecasting-inputs';
import { listSeasonalWindows } from './seasonal-calendar-operations';
import { learnSeasonalUplift } from './seasonal-calendar';
import {
  simulateReplenishmentDecision,
  type ReplenishmentDecision,
  type ReplenishmentDecisionInput,
} from './forecasting';

const units = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const date = z.iso.date();
const instant = z.iso.datetime({ offset: true }).nullable();

export const pharmacyReplenishmentReportInput = z
  .object({
    branchId: z.string().trim().min(1).max(128),
    medicineId: z.string().trim().min(1).max(128),
    historyStartDate: date,
    originDate: date,
    horizonDays: z.number().int().min(1).max(366),
    method: z.enum(['RECENT_MEAN', 'WEEKLY_SEASONAL_NAIVE']),
    manualScenario: z
      .object({
        /** Independent future planning origin; never a historical inventory assertion. */
        originDate: date,
        dailyDemandUnits: units,
        currentQuantityUnits: units,
        proposedQuantityUnits: units,
        currency: z.string().regex(/^[A-Z]{3}$/),
        goals: z
          .object({
            salesMinor: units.nullable(),
            marginMinor: units.nullable(),
          })
          .strict(),
        pricing: z
          .object({
            currentUnitPriceMinor: units,
            proposedUnitPriceMinor: units,
          })
          .strict(),
        orderTerms: z
          .object({
            packSize: units.min(1),
            minimumOrderUnits: units,
            unitCostMinor: units.nullable(),
            budgetMinor: units.nullable(),
            storageLimitUnits: units.nullable(),
            arrivalAt: instant,
            expiresAt: instant,
          })
          .strict(),
      })
      .strict()
      .optional(),
  })
  .strict();

/** Public request: tenant, branch authority, timestamps and provenance are server-owned. */
export type PharmacyReplenishmentReportInput = z.infer<typeof pharmacyReplenishmentReportInput>;
export type PharmacyReplenishmentReportReaderInput = PharmacyReplenishmentReportInput &
  Pick<
    PharmacyDemandEvidenceReaderInput,
    'organizationId' | 'authorizedBranchIds' | 'timeZone' | 'dayEnd'
  > & {
    financial: boolean;
  };

/**
 * When the business day `date` starts on the branch's clock (UTC when absent): the organisation's
 * midnight, or DEV-958A the branch's "day ends at" hour.
 */
function shopDayStartMs(
  date: string,
  timeZone: string | null | undefined,
  dayEnd?: PharmacyDayEnd
): number {
  return pharmacyBusinessDayRange(date, date, { timeZone, dayEnd }).from.getTime();
}

/**
 * `timeZone` is the caller's own organisation zone, loaded on the server: the history may end
 * on the shop's today and the scenario starts on a later shop day, the same days the screen
 * offers. An organisation on UTC keeps UTC days.
 */
export function validatePharmacyReplenishmentReportInput(
  input: PharmacyReplenishmentReportInput,
  readAt: Date,
  timeZone?: string | null,
  /** DEV-958A: the branch's day-end hours by day (`PharmacyDayEnd`; midnight when absent). */
  dayEnd?: PharmacyDayEnd
): void {
  pharmacyReplenishmentReportInput.parse(input);
  const origin = demandDateMs(input.originDate);
  const historyDays = (origin - demandDateMs(input.historyStartDate)) / 86_400_000;
  if (
    !Number.isFinite(readAt.getTime()) ||
    shopDayStartMs(input.originDate, timeZone, dayEnd) > readAt.getTime() ||
    historyDays < 1 ||
    historyDays > 90
  )
    throw new RangeError('Use 1..90 history days ending no later than the read instant.');
  demandDateAfter(input.originDate, input.horizonDays);
  if (input.manualScenario) {
    const scenario = input.manualScenario;
    // The planning model itself starts each day at midnight UTC (demand-evidence UTC_DAY_START)
    // and refuses sources dated after that origin, so the scenario day must not have begun
    // on either clock: the shop's (a day east of UTC starts earlier) or the model's UTC
    // midnight (a day west of UTC starts later). "Within 31 days" counts on the shop's clock.
    const planningOrigin = demandDateMs(scenario.originDate);
    const planningStart = shopDayStartMs(scenario.originDate, timeZone, dayEnd);
    if (
      Math.min(planningStart, planningOrigin) <= readAt.getTime() ||
      planningStart > readAt.getTime() + 31 * 86_400_000 ||
      (scenario.orderTerms.arrivalAt !== null &&
        Date.parse(scenario.orderTerms.arrivalAt) < planningOrigin) ||
      !Number.isSafeInteger(scenario.dailyDemandUnits * input.horizonDays) ||
      !Number.isSafeInteger(
        scenario.dailyDemandUnits * input.horizonDays * scenario.pricing.currentUnitPriceMinor
      ) ||
      !Number.isSafeInteger(
        scenario.dailyDemandUnits * input.horizonDays * scenario.pricing.proposedUnitPriceMinor
      )
    )
      throw new RangeError('Use a future planning origin within 31 days and safe scenario totals.');
    demandDateAfter(scenario.originDate, input.horizonDays);
  }
}

/**
 * Caller must enforce the existing Reports license/capability and tenant-scoped db contract.
 * Current reader statements are not an atomic or historical snapshot. No business writes.
 */
export async function readPharmacyReplenishmentReport(
  db: ScopedDb,
  input: PharmacyReplenishmentReportReaderInput,
  readAt: Date = new Date()
) {
  const { organizationId, authorizedBranchIds, financial, timeZone, dayEnd, ...request } = input;
  validatePharmacyReplenishmentReportInput(request, readAt, timeZone, dayEnd);
  if (!organizationId.trim() || organizationId.length > 128)
    throw new RangeError('A valid organization scope is required.');
  if (!authorizedBranchIds.includes(input.branchId))
    throw new Error('Branch is outside authorized scope.');
  const scope = { organizationId, branchId: input.branchId, medicineId: input.medicineId };
  // Demand reader verifies active branch and medicine before any supply reads.
  const evidence = await readPharmacyDemandEvidence(
    db,
    { ...scope, ...request, authorizedBranchIds, timeZone, dayEnd },
    readAt
  );
  const supply = await loadForecastingInputs(db, scope);
  if (
    [evidence.scope, supply.scope, evidence.forecastInput?.scope]
      .filter((value) => value !== undefined)
      .some(
        (value) =>
          value.organizationId !== organizationId ||
          value.branchId !== input.branchId ||
          value.medicineId !== input.medicineId
      )
  )
    throw new Error('Evidence does not match report scope.');
  if (supply.stock.length + supply.excludedStock.length > 10_000 || supply.inbound.length > 10_000)
    throw new RangeError('Supply row limit exceeded.');

  // DEV-74: the branch's own seasonal calendar feeds forecasting wherever eligible
  // demand evidence exists, and its uplift is learned from this branch's history only.
  const windows = await listSeasonalWindows(db, {
    organizationId,
    branchId: input.branchId,
  });
  const calendarWindows = windows.map(({ kind, label, startDate, endDateExclusive }) => ({
    kind,
    label,
    startDate,
    endDateExclusive,
  }));
  const { forecastInput, ...demand } = evidence;
  const forecast = forecastInput
    ? forecastDemandEvidence(
        calendarWindows.length
          ? { ...forecastInput, seasonalCalendar: { windows: calendarWindows } }
          : forecastInput
      )
    : null;
  const seasonalCalendar = {
    label: 'ESTIMATE' as const,
    basis: 'BUSINESS_DATE_CONSUMPTION' as const,
    windows,
    ...learnSeasonalUplift({
      days: demand.consumption.days.map((day) => ({
        date: day.date,
        units: day.observedCanonicalUnits,
      })),
      windows: calendarWindows,
    }),
  };
  let decision: ReplenishmentDecision | null = null;
  let goalComparison: ReturnType<typeof compareReplenishmentGoals> | null = null;
  const scenario = request.manualScenario;
  // The delivered supply reader has no stock-completeness contract. In particular,
  // an empty read cannot prove zero inventory; never simulate it as known zero.
  const hasRecordedStock = supply.stock.length > 0;
  if (scenario && financial && hasRecordedStock) {
    const source = {
      kind: 'MANUAL_SCENARIO' as const,
      reference:
        'User-supplied constant daily demand and hypothetical order terms; not observations.',
      asOf: readAt.toISOString(),
    };
    const assumedDay = demandDateAfter(scenario.originDate, -1);
    const decisionInput: ReplenishmentDecisionInput = {
      demand: {
        scope,
        source,
        originDate: scenario.originDate,
        historyStartDate: assumedDay,
        horizonDays: request.horizonDays,
        method: 'RECENT_MEAN',
        // A single MODELLED day encodes the explicit constant-rate assumption. Its
        // source and knownAt describe this user scenario, never historical facts.
        days: [
          {
            date: assumedDay,
            knownAt: source.asOf,
            state: 'OBSERVED',
            units: scenario.dailyDemandUnits,
          },
        ],
      },
      currency: scenario.currency,
      inventorySource: supply.inventorySource,
      stock: supply.stock,
      inbound: supply.inbound,
      policies: {
        source: 'MANUAL_SCENARIO',
        currentQuantityUnits: scenario.currentQuantityUnits,
        proposedQuantityUnits: scenario.proposedQuantityUnits,
      },
      orderTerms: { ...scenario.orderTerms, source },
    };
    decision = simulateReplenishmentDecision(decisionInput);
    goalComparison = compareReplenishmentGoals(decision, scenario);
  }
  return {
    scope,
    readAt: readAt.toISOString(),
    permissions: { operational: true as const, financial },
    observations: {
      demand,
      supply,
      supplyCoverage: {
        status: 'UNKNOWN' as const,
        recordedEligibleLots: supply.stock.length,
        reason: 'Stock completeness is unverified. Empty reads do not establish zero inventory.',
      },
    },
    forecast: {
      status: forecast ? ('AVAILABLE' as const) : ('INSUFFICIENT_EVIDENCE' as const),
      result: forecast,
    },
    seasonalCalendar,
    backtest: {
      status: 'INELIGIBLE' as const,
      result: null,
      reasons: evidence.backtestEligibility.reasons,
    },
    planning: {
      status: !scenario
        ? ('NOT_REQUESTED' as const)
        : !financial
          ? ('REDACTED' as const)
          : !hasRecordedStock
            ? ('INSUFFICIENT_STOCK_EVIDENCE' as const)
            : ('AVAILABLE' as const),
      basis: 'USER_SUPPLIED_ASSUMPTIONS' as const,
      dailyDemandUnits: decision ? scenario!.dailyDemandUnits : null,
      decision,
      goalComparison,
    },
    limitations: [
      ...evidence.missingInputs,
      ...supply.limitations,
      'Consumption is not uncensored demand. Null observations are unknown, not zero.',
      'Demand and supply are separate current reads, not an atomic snapshot or historical replay.',
      'Manual planning assumes a constant daily rate and only recorded eligible stock carried to a future UTC origin. Stock completeness remains unverified. Scenario coverage is model input coverage, not empirical performance.',
      'Planning is read-only and requires financial report access. No order, reservation or approval is created.',
      ...(windows.length
        ? [
            'Seasonal uplift is an estimate from completed-sale units on this branch; no-sale days are unknown, not zero.',
          ]
        : []),
    ],
  };
}

/**
 * Read-only estimates derived solely from configurable scenario assumptions. Keeping this
 * calculation pure makes fixture results stable and prevents illustrative figures becoming facts.
 */
export function compareReplenishmentGoals(
  decision: ReplenishmentDecision,
  scenario: NonNullable<PharmacyReplenishmentReportInput['manualScenario']>
) {
  const estimate = (entry: ReplenishmentDecision['scenarios'][number]) => {
    const unitPriceMinor =
      entry.policy === 'PROPOSED'
        ? scenario.pricing.proposedUnitPriceMinor
        : scenario.pricing.currentUnitPriceMinor;
    const fulfilledUnits = entry.outcome?.fulfilledUnits ?? null;
    const salesMinor = fulfilledUnits === null ? null : fulfilledUnits * unitPriceMinor;
    const marginMinor =
      salesMinor === null || scenario.orderTerms.unitCostMinor === null
        ? null
        : salesMinor - fulfilledUnits! * scenario.orderTerms.unitCostMinor;
    return {
      policy: entry.policy,
      label: 'ESTIMATE' as const,
      assumptions: {
        unitPriceMinor,
        unitCostMinor: scenario.orderTerms.unitCostMinor,
      },
      fulfilledUnits,
      salesMinor,
      marginMinor,
      goals: {
        salesMinor: scenario.goals.salesMinor,
        marginMinor: scenario.goals.marginMinor,
        salesMet:
          scenario.goals.salesMinor === null || salesMinor === null
            ? null
            : salesMinor >= scenario.goals.salesMinor,
        marginMet:
          scenario.goals.marginMinor === null || marginMinor === null
            ? null
            : marginMinor >= scenario.goals.marginMinor,
      },
    };
  };
  return {
    label: 'ILLUSTRATIVE_ESTIMATE' as const,
    definition:
      'Sales and margin estimates use fulfilled units and user-supplied unit prices and unit cost; they are not recorded or forecast results.',
    scenarios: decision.scenarios.map(estimate),
  };
}

export type PharmacyReplenishmentReport = Awaited<
  ReturnType<typeof readPharmacyReplenishmentReport>
>;
