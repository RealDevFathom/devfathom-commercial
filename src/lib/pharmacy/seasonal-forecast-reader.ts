import 'server-only';

import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { demandDateAfter, safeDemandTotal, type DemandScope } from './demand-evidence';
import {
  DEFAULT_SEASONAL_LEARNING_CONFIG,
  seasonalForecastAdjustment,
  type SaltSalesDay,
} from './seasonal-forecasting';

/** Current recorded sales signals, never proof of uncensored demand or historical availability. */
export async function readSeasonalSalesForecast(
  db: ScopedDb,
  input: DemandScope & { historyStartDate: string; originDate: string; horizonDays: number },
  recordedDays: readonly { date: string; observedCanonicalUnits: number | null; state: string }[],
  readAt: Date
) {
  const { organizationId, branchId, medicineId } = input;
  const windows = await db.pharmacySeasonalCalendarWindow.findMany({
    where: { organizationId, branchId, enabled: true },
    orderBy: [{ startDate: 'asc' }, { id: 'asc' }],
  });
  const calendar = windows.map((window) => ({
    id: window.id,
    branchId: window.branchId,
    name: window.name,
    startDate: window.startDate.toISOString().slice(0, 10),
    endDate: window.endDate.toISOString().slice(0, 10),
    enabled: window.enabled,
  }));
  const strengths = await db.medicineStrengthComponent.findMany({
    where: { organizationId, medicineId },
    select: { ingredientId: true },
  });
  const saltIds = [...new Set(strengths.map((strength) => strength.ingredientId))];
  const dailySales = new Map<string, Map<string, number>>();
  if (saltIds.length) {
    const lines = await db.pharmacySaleLine.findMany({
      where: {
        organizationId,
        branchId,
        createdAt: { lte: readAt },
        medicine: {
          organizationId,
          strengths: { some: { organizationId, ingredientId: { in: saltIds } } },
        },
        sale: {
          organizationId,
          branchId,
          status: 'COMPLETED',
          completedAt: {
            gte: new Date(`${input.historyStartDate}T00:00:00Z`),
            lt: new Date(`${input.originDate}T00:00:00Z`),
            lte: readAt,
          },
          updatedAt: { lte: readAt },
        },
      },
      select: {
        canonicalUnits: true,
        sale: { select: { completedAt: true } },
        medicine: {
          select: {
            strengths: {
              where: { organizationId, ingredientId: { in: saltIds } },
              select: { ingredientId: true },
            },
          },
        },
      },
      orderBy: { id: 'asc' },
      take: 10_001,
    });
    if (lines.length > 10_000)
      throw new RangeError('Seasonal sales row limit exceeded; narrow the history.');
    for (const line of lines) {
      if (!line.sale.completedAt) continue;
      for (const saltId of new Set(
        line.medicine.strengths.map((strength) => strength.ingredientId)
      )) {
        const date = line.sale.completedAt.toISOString().slice(0, 10);
        const totals = dailySales.get(saltId) ?? new Map<string, number>();
        totals.set(date, safeDemandTotal([totals.get(date) ?? 0, line.canonicalUnits]));
        dailySales.set(saltId, totals);
      }
    }
  }
  const historyBySalt = new Map<string, SaltSalesDay[]>(
    [...dailySales].map(([saltId, days]) => [
      saltId,
      [...days].map(([date, units]) => ({ branchId, saltId, date, units })),
    ])
  );
  const adjustments = Array.from({ length: input.horizonDays }, (_, index) => {
    const date = demandDateAfter(input.originDate, index);
    const salts = saltIds.map((saltId) => ({
      saltId,
      ...seasonalForecastAdjustment({
        branchId,
        saltId,
        forecastDate: date,
        calendar,
        history: historyBySalt.get(saltId) ?? [],
      }),
    }));
    const supported = salts.filter((salt) => salt.learnedUplift || salt.detectedSpike);
    return {
      date,
      seasonalityBps: supported.length
        ? Math.max(...supported.map((salt) => salt.seasonalityBps))
        : 10_000,
      salts,
    };
  });
  // A recorded-sales projection is separate from the demand forecast. Missing days remain
  // unknown, stockout days are excluded, and event days do not inflate the baseline twice.
  const baseline = recordedDays.filter(
    (day) =>
      day.date < input.originDate &&
      day.state !== 'STOCKOUT_CENSORED' &&
      day.observedCanonicalUnits !== null &&
      !calendar.some((window) => window.startDate <= day.date && day.date <= window.endDate)
  );
  const total = safeDemandTotal(baseline.map((day) => day.observedCanonicalUnits!));
  const projection =
    baseline.length >= DEFAULT_SEASONAL_LEARNING_CONFIG.minimumBaselineDays
      ? adjustments.map(({ date, seasonalityBps }) => {
          const units = Number(
            (BigInt(total) * BigInt(seasonalityBps) + BigInt(baseline.length * 10_000 - 1)) /
              BigInt(baseline.length * 10_000)
          );
          safeDemandTotal([units]);
          return { date, units, seasonalityBps };
        })
      : null;
  return {
    label: 'MODELLED_RECORDED_SALES' as const,
    calendar,
    adjustments,
    baselineDays: baseline.length,
    projection,
    assumptions: [
      'Projection of recorded completed sales, not uncensored demand. Missing days are unknown and stockout days are excluded from the medicine baseline.',
      'Salt signals aggregate recorded canonical sales units across medicines containing that ingredient; they do not estimate ingredient mass or therapeutic equivalence.',
      'Calendar factors use only recorded event and non-event days before origin. Spikes expire after seven UTC days. Multiple salt signals use the largest supported factor.',
      'Current records and calendars cannot establish historical versions or backtest eligibility. No orders or approval changes are created.',
    ],
  };
}
