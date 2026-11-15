/**
 * DEV-74 — branch seasonal calendar and demand spike detection.
 *
 * Pure and deterministic. A branch owner records dated seasonal windows (dengue, flu,
 * Ramadan, monsoon or a custom label); uplift is learned only from that branch's own
 * observed history, never from a hardcoded item list or a research figure. Every threshold
 * is a caller-configurable value with a documented default, not a fact.
 */

import { demandDateAfter, demandDateMs, safeDemandTotal } from './demand-evidence';

const BPS = 10_000;

export const SEASONAL_WINDOW_KINDS = ['DENGUE', 'FLU', 'RAMADAN', 'MONSOON', 'CUSTOM'] as const;
export type SeasonalWindowKind = (typeof SEASONAL_WINDOW_KINDS)[number];

/** One dated occurrence of a season; Ramadan and monsoon move, so each year is its own row. */
export type SeasonalWindow = {
  kind: SeasonalWindowKind;
  label: string;
  /** YYYY-MM-DD inclusive start. */
  startDate: string;
  /** YYYY-MM-DD exclusive end. */
  endDateExclusive: string;
};

export type SeasonalUpliftConfig = {
  /** Minimum observed in-window days before an uplift is trusted. */
  minWindowDays: number;
  /** Minimum observed out-of-window days forming the baseline. */
  minBaselineDays: number;
  /** Upper clamp on a learned uplift, in basis points of baseline. */
  maxUpliftBps: number;
};

/** Configurable defaults; they are guards against thin evidence, not research findings. */
export const DEFAULT_SEASONAL_UPLIFT_CONFIG: SeasonalUpliftConfig = {
  minWindowDays: 7,
  minBaselineDays: 14,
  maxUpliftBps: 50_000,
};

export type SeasonalUplift = {
  /** Groups occurrences across years: the kind, or `CUSTOM:<label>` for custom windows. */
  key: string;
  kind: SeasonalWindowKind;
  label: string;
  status: 'LEARNED' | 'INSUFFICIENT_HISTORY';
  /** In-window mean over out-of-window mean, in basis points. Null unless learned. */
  upliftBps: number | null;
  windowDays: number;
  baselineDays: number;
  evidenceDates: readonly string[];
};

export type ObservedUnitsDay = { date: string; units: number | null };

export function seasonalWindowKey(window: Pick<SeasonalWindow, 'kind' | 'label'>): string {
  return window.kind === 'CUSTOM'
    ? `CUSTOM:${window.label.trim().toLowerCase().replace(/\s+/g, ' ')}`
    : window.kind;
}

export function validateSeasonalWindows(windows: readonly SeasonalWindow[]): void {
  if (windows.length > 500) throw new RangeError('Too many seasonal windows');
  for (const window of windows) {
    if (!SEASONAL_WINDOW_KINDS.includes(window.kind))
      throw new RangeError('Unsupported seasonal window kind');
    const label = window.label.trim();
    if (!label || label.length > 80) throw new RangeError('Seasonal window label is required');
    const start = demandDateMs(window.startDate);
    const end = demandDateMs(window.endDateExclusive);
    if (end <= start || (end - start) / 86_400_000 > 366)
      throw new RangeError('Seasonal windows must span 1..366 days');
  }
}

export function validateSeasonalUpliftConfig(config: SeasonalUpliftConfig): void {
  if (
    !Number.isInteger(config.minWindowDays) ||
    config.minWindowDays < 1 ||
    config.minWindowDays > 366 ||
    !Number.isInteger(config.minBaselineDays) ||
    config.minBaselineDays < 1 ||
    config.minBaselineDays > 3660 ||
    !Number.isInteger(config.maxUpliftBps) ||
    config.maxUpliftBps < BPS ||
    config.maxUpliftBps > 1_000_000
  )
    throw new RangeError('Invalid seasonal uplift configuration');
}

/** The first window (by start date, then key) covering a date. */
export function seasonalWindowFor(
  windows: readonly SeasonalWindow[],
  date: string
): SeasonalWindow | null {
  let match: SeasonalWindow | null = null;
  for (const window of windows) {
    if (date < window.startDate || date >= window.endDateExclusive) continue;
    if (
      !match ||
      window.startDate < match.startDate ||
      (window.startDate === match.startDate && seasonalWindowKey(window) < seasonalWindowKey(match))
    )
      match = window;
  }
  return match;
}

function ratioBps(
  numeratorTotal: number,
  numeratorCount: number,
  baseTotal: number,
  baseCount: number
): number {
  // (numeratorTotal / numeratorCount) / (baseTotal / baseCount), rounded half up.
  const num = BigInt(numeratorTotal) * BigInt(baseCount) * BigInt(BPS);
  const den = BigInt(baseTotal) * BigInt(numeratorCount);
  return Number((num * BigInt(2) + den) / (den * BigInt(2)));
}

/**
 * Learns one uplift per season from observed history: mean units on in-window days divided by
 * mean units on days outside every window. Unknown (null) days are excluded, never zero.
 */
export function learnSeasonalUplift(input: {
  days: readonly ObservedUnitsDay[];
  windows: readonly SeasonalWindow[];
  config?: Partial<SeasonalUpliftConfig>;
}): { baseline: { days: number; meanUnits: number | null }; uplifts: SeasonalUplift[] } {
  const config = { ...DEFAULT_SEASONAL_UPLIFT_CONFIG, ...input.config };
  validateSeasonalUpliftConfig(config);
  validateSeasonalWindows(input.windows);
  const seen = new Set<string>();
  const groups = new Map<
    string,
    { kind: SeasonalWindowKind; label: string; dates: string[]; units: number[] }
  >();
  for (const window of input.windows) {
    const key = seasonalWindowKey(window);
    if (!groups.has(key))
      groups.set(key, { kind: window.kind, label: window.label.trim(), dates: [], units: [] });
  }
  const baselineUnits: number[] = [];
  for (const day of input.days) {
    demandDateMs(day.date);
    if (seen.has(day.date)) throw new RangeError('Duplicate demand date');
    seen.add(day.date);
    if (day.units === null) continue;
    safeDemandTotal([day.units]);
    const window = seasonalWindowFor(input.windows, day.date);
    if (!window) {
      baselineUnits.push(day.units);
      continue;
    }
    const group = groups.get(seasonalWindowKey(window))!;
    group.dates.push(day.date);
    group.units.push(day.units);
  }
  const baselineTotal = safeDemandTotal(baselineUnits);
  const baselineReady = baselineUnits.length >= config.minBaselineDays && baselineTotal > 0;
  const uplifts = [...groups.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, group]): SeasonalUplift => {
      const learned = baselineReady && group.units.length >= config.minWindowDays;
      return {
        key,
        kind: group.kind,
        label: group.label,
        status: learned ? 'LEARNED' : 'INSUFFICIENT_HISTORY',
        upliftBps: learned
          ? Math.min(
              config.maxUpliftBps,
              ratioBps(
                safeDemandTotal(group.units),
                group.units.length,
                baselineTotal,
                baselineUnits.length
              )
            )
          : null,
        windowDays: group.units.length,
        baselineDays: baselineUnits.length,
        evidenceDates: [...group.dates].sort(),
      };
    });
  return {
    baseline: {
      days: baselineUnits.length,
      meanUnits: baselineUnits.length
        ? Number(
            (BigInt(baselineTotal) + BigInt(baselineUnits.length - 1)) /
              BigInt(baselineUnits.length)
          )
        : null,
    },
    uplifts,
  };
}

export type SpikeDetectionConfig = {
  /** Trailing observed days used as the baseline for each date. */
  baselineDays: number;
  /** Minimum observed trailing days before a date can be judged. */
  minBaselineDays: number;
  /** A date spikes when units ≥ baseline mean × thresholdBps / 10 000. */
  thresholdBps: number;
  /** And exceeds the baseline mean by at least this many units. */
  minExcessUnits: number;
};

/** Configurable defaults (2× a four-week trailing mean); not a research figure. */
export const DEFAULT_SPIKE_DETECTION_CONFIG: SpikeDetectionConfig = {
  baselineDays: 28,
  minBaselineDays: 7,
  thresholdBps: 20_000,
  minExcessUnits: 5,
};

export type DemandSpike = {
  date: string;
  units: number;
  /** Trailing observed mean, rounded up to a whole unit. */
  baselineMeanUnits: number;
  /** Null when the trailing baseline sold nothing (an unbounded ratio). */
  upliftBps: number | null;
  baselineDays: number;
};

export function validateSpikeDetectionConfig(config: SpikeDetectionConfig): void {
  if (
    !Number.isInteger(config.baselineDays) ||
    config.baselineDays < 1 ||
    config.baselineDays > 366 ||
    !Number.isInteger(config.minBaselineDays) ||
    config.minBaselineDays < 1 ||
    config.minBaselineDays > config.baselineDays ||
    !Number.isInteger(config.thresholdBps) ||
    config.thresholdBps <= BPS ||
    config.thresholdBps > 1_000_000 ||
    !Number.isSafeInteger(config.minExcessUnits) ||
    config.minExcessUnits < 0
  )
    throw new RangeError('Invalid spike detection configuration');
}

/**
 * Flags dates whose units clear a configurable multiple of the trailing observed baseline.
 * The baseline uses only observed days strictly before the judged date (no look-ahead);
 * unknown days are skipped rather than counted as zero.
 */
export function detectDemandSpikes(input: {
  days: readonly ObservedUnitsDay[];
  /** Only dates on or after this are judged; earlier days feed the baseline. */
  fromDate?: string;
  config?: Partial<SpikeDetectionConfig>;
}): DemandSpike[] {
  const config = { ...DEFAULT_SPIKE_DETECTION_CONFIG, ...input.config };
  validateSpikeDetectionConfig(config);
  if (input.fromDate) demandDateMs(input.fromDate);
  if (input.days.length > 10_000) throw new RangeError('Too many demand days');
  const sorted = [...input.days].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const observed: { date: string; units: number }[] = [];
  const spikes: DemandSpike[] = [];
  let first = 0;
  let total = 0;
  for (let i = 0; i < sorted.length; i += 1) {
    const day = sorted[i]!;
    demandDateMs(day.date);
    if (i > 0 && sorted[i - 1]!.date === day.date) throw new RangeError('Duplicate demand date');
    if (day.units === null) continue;
    safeDemandTotal([day.units]);
    const windowStart = demandDateAfter(day.date, -config.baselineDays);
    while (first < observed.length && observed[first]!.date < windowStart) {
      total -= observed[first]!.units;
      first += 1;
    }
    const count = observed.length - first;
    if ((!input.fromDate || day.date >= input.fromDate) && count >= config.minBaselineDays) {
      // units / (total / count) ≥ threshold / BPS and units − mean ≥ minExcess, in integers.
      const units = BigInt(day.units);
      const n = BigInt(count);
      const sum = BigInt(total);
      if (
        units * n * BigInt(BPS) >= sum * BigInt(config.thresholdBps) &&
        units * n - sum >= BigInt(config.minExcessUnits) * n
      ) {
        spikes.push({
          date: day.date,
          units: day.units,
          baselineMeanUnits: Number((sum + n - BigInt(1)) / n),
          upliftBps: total > 0 ? ratioBps(day.units, 1, total, count) : null,
          baselineDays: count,
        });
      }
    }
    observed.push({ date: day.date, units: day.units });
    total = safeDemandTotal([total, day.units]);
  }
  return spikes;
}
