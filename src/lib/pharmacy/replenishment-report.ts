import 'server-only';

import { z } from 'zod';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { demandDateAfter, demandDateMs, forecastDemandEvidence } from './demand-evidence';
import {
  readPharmacyDemandEvidence,
  type PharmacyDemandEvidenceReaderInput,
} from './demand-evidence-reader';
import { loadForecastingInputs } from './forecasting-inputs';
import { readSeasonalSalesForecast } from './seasonal-forecast-reader';
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
  Pick<PharmacyDemandEvidenceReaderInput, 'organizationId' | 'authorizedBranchIds'> & {
    financial: boolean;
  };

export function validatePharmacyReplenishmentReportInput(
  input: PharmacyReplenishmentReportInput,
  readAt: Date
): void {
  pharmacyReplenishmentReportInput.parse(input);
  const origin = demandDateMs(input.originDate);
  const historyDays = (origin - demandDateMs(input.historyStartDate)) / 86_400_000;
  if (
    !Number.isFinite(readAt.getTime()) ||
    origin > readAt.getTime() ||
    historyDays < 1 ||
    historyDays > 90
  )
    throw new RangeError('Use 1..90 history days ending no later than the read instant.');
  demandDateAfter(input.originDate, input.horizonDays);
  if (input.manualScenario) {
    const scenario = input.manualScenario;
    const planningOrigin = demandDateMs(scenario.originDate);
    if (
      planningOrigin <= readAt.getTime() ||
      planningOrigin > readAt.getTime() + 31 * 86_400_000 ||
      (scenario.orderTerms.arrivalAt !== null &&
        Date.parse(scenario.orderTerms.arrivalAt) < planningOrigin) ||
      !Number.isSafeInteger(scenario.dailyDemandUnits * input.horizonDays)
    )
      throw new RangeError('Use a future planning origin within 31 days and safe demand totals.');
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
  const { organizationId, authorizedBranchIds, financial, ...request } = input;
  validatePharmacyReplenishmentReportInput(request, readAt);
  if (!organizationId.trim() || organizationId.length > 128)
    throw new RangeError('A valid organization scope is required.');
  if (!authorizedBranchIds.includes(input.branchId))
    throw new Error('Branch is outside authorized scope.');
  const scope = { organizationId, branchId: input.branchId, medicineId: input.medicineId };
  // Demand reader verifies active branch and medicine before any supply reads.
  const evidence = await readPharmacyDemandEvidence(
    db,
    { ...scope, ...request, authorizedBranchIds },
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

  const { forecastInput, ...demand } = evidence;
  const seasonalForecast = await readSeasonalSalesForecast(
    db,
    { ...scope, ...request },
    evidence.days,
    readAt
  );
  const baseForecast = forecastInput ? forecastDemandEvidence(forecastInput) : null;
  const forecast = baseForecast
    ? {
        ...baseForecast,
        days: baseForecast.days.map((day, index) => {
          if (day.units === null) return day;
          const factor = seasonalForecast.adjustments[index]!.seasonalityBps;
          const units = Number((BigInt(day.units) * BigInt(factor) + 9_999n) / 10_000n);
          if (!Number.isSafeInteger(units))
            throw new RangeError('Seasonal forecast exceeds safe units.');
          return { ...day, units };
        }),
        assumptions: [...baseForecast.assumptions, ...seasonalForecast.assumptions],
      }
    : null;
  let decision: ReplenishmentDecision | null = null;
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
    seasonalForecast,
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
    },
    limitations: [
      ...evidence.missingInputs,
      ...supply.limitations,
      'Consumption is not uncensored demand. Null observations are unknown, not zero.',
      'Demand and supply are separate current reads, not an atomic snapshot or historical replay.',
      'Manual planning assumes a constant daily rate and only recorded eligible stock carried to a future UTC origin. Stock completeness remains unverified. Scenario coverage is model input coverage, not empirical performance.',
      'Planning is read-only and requires financial report access. No order, reservation or approval is created.',
    ],
  };
}

export type PharmacyReplenishmentReport = Awaited<
  ReturnType<typeof readPharmacyReplenishmentReport>
>;
