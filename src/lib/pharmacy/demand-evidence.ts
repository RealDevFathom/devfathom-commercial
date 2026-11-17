/** Pure, calendar-preserving scenarios. Caller provenance is not a verified live adapter. */
import {
  learnSeasonalUplift,
  seasonalWindowFor,
  seasonalWindowKey,
  type SeasonalUplift,
  type SeasonalUpliftConfig,
  type SeasonalWindow,
} from './seasonal-calendar';

export type DemandScope = { organizationId: string; branchId: string; medicineId: string };

export type DemandSource = {
  kind: 'OBSERVED_TRANSACTIONS' | 'MANUAL_SCENARIO' | 'SYNTHETIC_FIXTURE';
  reference: string;
  /** Snapshot cutoff, not proof that historical versions were retained. */
  asOf: string;
};

export type DemandEvidenceDay = {
  date: string;
  /** First availability of this exact observation/version, including later corrections. */
  knownAt: string;
} & (
  | { state: 'OBSERVED'; units: number }
  | { state: 'STOCKOUT_CENSORED'; units: number }
  | { state: 'UNKNOWN' | 'CLOSED'; units?: never }
);

export type DemandMethod = 'RECENT_MEAN' | 'WEEKLY_SEASONAL_NAIVE';
export type DemandEvidenceInput = {
  scope: DemandScope;
  source: DemandSource;
  /** All dates are YYYY-MM-DD UTC calendar labels; origin is the first forecast day. */
  originDate: string;
  historyStartDate: string;
  horizonDays: number;
  method: DemandMethod;
  days: readonly DemandEvidenceDay[];
  /** Only closures already known at origin may override a future day's demand. */
  closures?: readonly { date: string; knownAt: string }[];
  /**
   * DEV-74: branch seasonal windows. Uplift is learned only from eligible history before
   * origin and applied to forecast days inside a window with the same season key.
   */
  seasonalCalendar?: {
    windows: readonly SeasonalWindow[];
    config?: Partial<SeasonalUpliftConfig>;
  };
};

export type DemandForecastDay = {
  date: string;
  units: number | null;
  method: DemandMethod | 'KNOWN_CLOSED' | 'UNAVAILABLE' | 'SEASONAL_CALENDAR';
  evidenceDates: readonly string[];
  /** Present only when a learned seasonal uplift set this day's units. */
  seasonal?: { key: string; label: string; upliftBps: number; baselineMeanUnits: number };
};

export type DemandForecast = {
  label: 'CONDITIONAL_SCENARIO';
  scope: DemandScope;
  source: DemandSource;
  timeBasis: 'UTC_DAY_START';
  originDate: string;
  period: { startDate: string; endDateExclusive: string };
  historyPeriod: { startDate: string; endDateExclusive: string };
  coverage: {
    observedDays: number;
    unknownDays: number;
    closedDays: number;
    censoredDays: number;
    excludedFutureOrUnavailableRows: number;
  };
  days: readonly DemandForecastDay[];
  assumptions: readonly string[];
  unknowns: readonly string[];
  /** Present only when the input carried a seasonal calendar. */
  seasonalCalendar?: {
    baselineDays: number;
    baselineMeanUnits: number | null;
    uplifts: readonly SeasonalUplift[];
  };
};

const DAY_MS = 86_400_000;

export function demandDateMs(date: string): number {
  const ms = Date.parse(`${date}T00:00:00.000Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
    !Number.isFinite(ms) ||
    new Date(ms).toISOString().slice(0, 10) !== date
  ) {
    throw new RangeError('Expected a valid YYYY-MM-DD calendar date');
  }
  return ms;
}

export function demandInstantMs(value: string): number {
  const ms = Date.parse(value);
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) ||
    !Number.isFinite(ms)
  ) {
    throw new RangeError('Expected an instant with an explicit timezone');
  }
  demandDateMs(value.slice(0, 10));
  return ms;
}

export function demandDateAfter(date: string, days: number): string {
  const result = new Date(demandDateMs(date) + days * DAY_MS).toISOString().slice(0, 10);
  demandDateMs(result);
  return result;
}

export function safeDemandTotal(values: readonly number[]): number {
  let total = 0;
  for (const value of values) {
    if (!Number.isSafeInteger(value) || value < 0 || !Number.isSafeInteger(total + value)) {
      throw new RangeError('Demand units and totals must be non-negative safe integers');
    }
    total += value;
  }
  return total;
}

function evidenceRows(input: DemandEvidenceInput): Map<string, DemandEvidenceDay> {
  for (const value of Object.values(input.scope)) {
    if (!value.trim()) throw new RangeError('Demand scope is required');
  }
  if (
    !input.source.reference.trim() ||
    !['OBSERVED_TRANSACTIONS', 'MANUAL_SCENARIO', 'SYNTHETIC_FIXTURE'].includes(input.source.kind)
  ) {
    throw new RangeError('Demand provenance is required');
  }
  demandInstantMs(input.source.asOf);
  if (!['RECENT_MEAN', 'WEEKLY_SEASONAL_NAIVE'].includes(input.method)) {
    throw new RangeError('Unsupported demand method');
  }
  const historyDays =
    (demandDateMs(input.originDate) - demandDateMs(input.historyStartDate)) / DAY_MS;
  if (
    historyDays < 1 ||
    historyDays > 3660 ||
    !Number.isInteger(input.horizonDays) ||
    input.horizonDays < 1 ||
    input.horizonDays > 366 ||
    input.days.length > 10_000
  ) {
    throw new RangeError('Demand history must be 1..3660 days; horizon must be 1..366 days');
  }
  demandDateAfter(input.originDate, input.horizonDays);
  const rows = new Map<string, DemandEvidenceDay>();
  for (const row of input.days) {
    demandDateMs(row.date);
    demandInstantMs(row.knownAt);
    if (rows.has(row.date)) throw new RangeError('Duplicate demand date');
    if (row.state === 'OBSERVED' || row.state === 'STOCKOUT_CENSORED') safeDemandTotal([row.units]);
    else if (!['UNKNOWN', 'CLOSED'].includes(row.state) || row.units !== undefined)
      throw new RangeError('Invalid demand state');
    rows.set(row.date, row);
  }
  return rows;
}

/** Uses only uncensored observed days available at origin. Missing dates stay unknown. */
export function forecastDemandEvidence(input: DemandEvidenceInput): DemandForecast {
  const rows = evidenceRows(input);
  const origin = demandDateMs(input.originDate);
  const cutoff = Math.min(origin, demandInstantMs(input.source.asOf));
  const observed = new Map<string, number>();
  const coverage = {
    observedDays: 0,
    unknownDays: 0,
    closedDays: 0,
    censoredDays: 0,
    excludedFutureOrUnavailableRows: 0,
  };
  for (const row of rows.values()) {
    if (demandDateMs(row.date) >= origin || demandInstantMs(row.knownAt) > cutoff)
      coverage.excludedFutureOrUnavailableRows += 1;
  }
  for (
    let date = input.historyStartDate;
    date < input.originDate;
    date = demandDateAfter(date, 1)
  ) {
    const row = rows.get(date);
    if (!row || demandInstantMs(row.knownAt) > cutoff || row.state === 'UNKNOWN')
      coverage.unknownDays += 1;
    else if (row.state === 'CLOSED') coverage.closedDays += 1;
    else if (row.state === 'STOCKOUT_CENSORED') coverage.censoredDays += 1;
    else if (row.state === 'OBSERVED') {
      observed.set(date, row.units);
      coverage.observedDays += 1;
    }
  }
  const total = safeDemandTotal([...observed.values()]);
  const mean = observed.size
    ? Number((BigInt(total) + BigInt(observed.size - 1)) / BigInt(observed.size))
    : null;
  const closures = new Set<string>();
  const closureDates = new Set<string>();
  if ((input.closures?.length ?? 0) > 10_000) throw new RangeError('Too many closure dates');
  for (const closure of input.closures ?? []) {
    demandDateMs(closure.date);
    if (closureDates.has(closure.date)) throw new RangeError('Duplicate closure date');
    closureDates.add(closure.date);
    if (demandInstantMs(closure.knownAt) <= cutoff) closures.add(closure.date);
  }
  // Learned from the same eligible (observed, known-by-cutoff, pre-origin) days as the mean.
  const calendar = input.seasonalCalendar
    ? learnSeasonalUplift({
        days: [...observed.entries()].map(([date, units]) => ({ date, units })),
        windows: input.seasonalCalendar.windows,
        config: input.seasonalCalendar.config,
      })
    : null;
  const uplifts = new Map(calendar?.uplifts.map((uplift) => [uplift.key, uplift]));
  const days: DemandForecastDay[] = [];
  for (let i = 0; i < input.horizonDays; i += 1) {
    const date = demandDateAfter(input.originDate, i);
    if (closures.has(date)) {
      days.push({ date, units: 0, method: 'KNOWN_CLOSED', evidenceDates: [] });
      continue;
    }
    const window = calendar ? seasonalWindowFor(input.seasonalCalendar!.windows, date) : null;
    const uplift = window ? uplifts.get(seasonalWindowKey(window)) : undefined;
    if (uplift?.upliftBps != null && calendar!.baseline.meanUnits !== null) {
      // Baseline excludes every window day, so the uplift is never applied twice.
      const units = BigInt(calendar!.baseline.meanUnits) * BigInt(uplift.upliftBps);
      days.push({
        date,
        units: Number((units + BigInt(9_999)) / BigInt(10_000)),
        method: 'SEASONAL_CALENDAR',
        evidenceDates: uplift.evidenceDates,
        seasonal: {
          key: uplift.key,
          label: uplift.label,
          upliftBps: uplift.upliftBps,
          baselineMeanUnits: calendar!.baseline.meanUnits,
        },
      });
      continue;
    }
    // Preserve weekday distance even across unknown, closed and censored dates.
    const lagDays = (Math.floor(i / 7) + 1) * 7;
    const lagDate = demandDateAfter(date, -lagDays);
    const seasonal = input.method === 'WEEKLY_SEASONAL_NAIVE' ? observed.get(lagDate) : undefined;
    days.push({
      date,
      units: seasonal ?? mean,
      method:
        seasonal !== undefined
          ? 'WEEKLY_SEASONAL_NAIVE'
          : mean === null
            ? 'UNAVAILABLE'
            : 'RECENT_MEAN',
      evidenceDates: seasonal !== undefined ? [lagDate] : [...observed.keys()],
    });
  }
  return {
    label: 'CONDITIONAL_SCENARIO',
    scope: { ...input.scope },
    source: { ...input.source },
    timeBasis: 'UTC_DAY_START',
    originDate: input.originDate,
    period: {
      startDate: input.originDate,
      endDateExclusive: demandDateAfter(input.originDate, input.horizonDays),
    },
    historyPeriod: { startDate: input.historyStartDate, endDateExclusive: input.originDate },
    coverage,
    days,
    assumptions: [
      'Observed units must be complete consumption in canonical units; returns and adjustments are separate.',
      'UTC calendar days; recent mean excludes unknown, closed and stockout-censored days and rounds each forecast day upward.',
      'Based on the same weekday last week (the latest matching weekday before the forecast start); if that day is unavailable, the recent average is used.',
      'Source kind and known-at version timestamps are caller assertions; this pure function does not verify a live reader.',
      'No calibrated intervals, service probabilities, latent-demand recovery or profit guarantees.',
      ...(calendar
        ? [
            "Seasonal calendar days use the out-of-window mean times the uplift learned from this scope's own earlier in-window days; unlearned windows keep the base method.",
          ]
        : []),
    ],
    unknowns: [
      ...(coverage.unknownDays ? ['Missing or unavailable demand days are not zero.'] : []),
      ...(coverage.censoredDays ? ['Latent demand on stockout-censored days is unknown.'] : []),
      ...(mean === null ? ['No eligible observed history for open-day demand.'] : []),
      ...(input.source.kind !== 'OBSERVED_TRANSACTIONS'
        ? ['Demand inputs are a manual or synthetic scenario, not observed transactions.']
        : []),
      ...(calendar?.uplifts.some((uplift) => uplift.status === 'INSUFFICIENT_HISTORY')
        ? ['Some seasonal windows lack enough branch history; their days use the base method.']
        : []),
    ],
    ...(calendar
      ? {
          seasonalCalendar: {
            baselineDays: calendar.baseline.days,
            baselineMeanUnits: calendar.baseline.meanUnits,
            uplifts: calendar.uplifts,
          },
        }
      : {}),
  };
}

export type DemandBacktestInput = Omit<DemandEvidenceInput, 'originDate' | 'method'> & {
  /** Strictly increasing origins; each forecast uses only earlier available evidence. */
  origins: readonly string[];
};
export type DemandBacktestMetrics = {
  sampleCount: number;
  maeUnits: number | null;
  biasUnits: number | null;
  wapePercent: number | null;
};
export type DemandBacktest = {
  scope: DemandScope;
  source: DemandSource;
  timeBasis: 'UTC_DAY_START';
  period: { startDate: string; endDateExclusive: string };
  folds: readonly {
    originDate: string;
    days: readonly {
      date: string;
      actualUnits: number | null;
      recentMeanUnits: number | null;
      seasonalNaiveUnits: number | null;
      scored: boolean;
    }[];
  }[];
  metrics: Record<DemandMethod, DemandBacktestMetrics>;
  excludedPairs: number;
  assumptions: readonly string[];
};

/** Both baselines score the same origin/date pairs. Unknown/censored actuals never score. */
export function backtestDemandEvidence(input: DemandBacktestInput): DemandBacktest {
  if (input.origins.length < 1 || input.origins.length > 100)
    throw new RangeError('Backtest requires 1..100 origins');
  const methods = ['RECENT_MEAN', 'WEEKLY_SEASONAL_NAIVE'] as const;
  const sums = methods.map(() => ({ absolute: 0, signed: 0, actual: 0, count: 0 }));
  let excludedPairs = 0;
  const folds = input.origins.map((originDate, index) => {
    demandDateMs(originDate);
    if (index > 0 && originDate <= input.origins[index - 1]!)
      throw new RangeError('Backtest origins must increase');
    const forecasts = methods.map((method) =>
      forecastDemandEvidence({ ...input, originDate, method })
    );
    const rows = new Map(input.days.map((row) => [row.date, row]));
    const days = forecasts[0]!.days.map((day, dayIndex) => {
      const actual = rows.get(day.date);
      const actualUnits =
        actual?.state === 'OBSERVED' &&
        demandInstantMs(actual.knownAt) <= demandInstantMs(input.source.asOf)
          ? actual.units
          : null;
      const predictions = forecasts.map((forecast) => forecast.days[dayIndex]!.units);
      const scored = actualUnits !== null && predictions.every((units) => units !== null);
      if (scored) {
        predictions.forEach((units, methodIndex) => {
          const sum = sums[methodIndex]!;
          const error = units! - actualUnits!;
          sum.absolute = safeDemandTotal([sum.absolute, Math.abs(error)]);
          sum.actual = safeDemandTotal([sum.actual, actualUnits!]);
          if (!Number.isSafeInteger(sum.signed + error))
            throw new RangeError('Backtest bias exceeds safe integer range');
          sum.signed += error;
          sum.count += 1;
        });
      } else excludedPairs += 1;
      return {
        date: day.date,
        actualUnits,
        recentMeanUnits: predictions[0]!,
        seasonalNaiveUnits: predictions[1]!,
        scored,
      };
    });
    return { originDate, days };
  });
  const metrics = (index: number): DemandBacktestMetrics => {
    const sum = sums[index]!;
    return {
      sampleCount: sum.count,
      maeUnits: sum.count ? sum.absolute / sum.count : null,
      biasUnits: sum.count ? sum.signed / sum.count : null,
      wapePercent: sum.actual ? (sum.absolute / sum.actual) * 100 : null,
    };
  };
  return {
    scope: { ...input.scope },
    source: { ...input.source },
    timeBasis: 'UTC_DAY_START',
    period: {
      startDate: input.origins[0]!,
      endDateExclusive: demandDateAfter(input.origins.at(-1)!, input.horizonDays),
    },
    folds,
    metrics: { RECENT_MEAN: metrics(0), WEEKLY_SEASONAL_NAIVE: metrics(1) },
    excludedPairs,
    assumptions: [
      'Errors are forecast minus observed actual; WAPE is null when total actual is zero.',
      'Both methods use identical eligible origin/date pairs; overlapping horizons count as separate forecast decisions.',
      'Only uncensored observed holdout days known by source as-of score; true latent demand and inventory economics are not measured.',
      'Historical known-at timestamps require retained evidence versions; a current live snapshot alone cannot prove historical reproducibility.',
      `Source kind: ${input.source.kind}; manual and synthetic inputs are not measured transaction performance.`,
    ],
  };
}
