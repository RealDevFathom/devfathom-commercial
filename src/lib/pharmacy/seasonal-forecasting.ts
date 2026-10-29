/** Branch-owned seasonal calendars and demand signals used by PUR-09 forecasts. */

const BPS = 10_000;

export type SeasonalCalendarWindow = {
  id: string;
  branchId: string;
  name: string;
  startDate: string;
  endDate: string;
  enabled: boolean;
};

export type SaltSalesDay = {
  branchId: string;
  saltId: string;
  date: string;
  units: number;
};

export type SeasonalLearningConfig = {
  minimumEventDays: number;
  minimumBaselineDays: number;
  minimumUpliftBps: number;
  maximumUpliftBps: number;
};

export const DEFAULT_SEASONAL_LEARNING_CONFIG: SeasonalLearningConfig = {
  minimumEventDays: 2,
  minimumBaselineDays: 7,
  minimumUpliftBps: 5_000,
  maximumUpliftBps: 30_000,
};

export type LearnedCalendarUplift = {
  windowId: string;
  windowName: string;
  upliftBps: number;
  eventDays: number;
  baselineDays: number;
  eventMeanUnits: number;
  baselineMeanUnits: number;
};

export type SpikeDetectionConfig = {
  baselineDays: number;
  minimumBaselineDays: number;
  thresholdBps: number;
  minimumUnits: number;
};

export const DEFAULT_SPIKE_DETECTION_CONFIG: SpikeDetectionConfig = {
  baselineDays: 28,
  minimumBaselineDays: 7,
  thresholdBps: 20_000,
  minimumUnits: 1,
};

export type SalesSpike = {
  branchId: string;
  saltId: string;
  date: string;
  units: number;
  baselineMeanUnits: number;
  ratioBps: number;
};

function dateMs(value: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new RangeError('Dates must be YYYY-MM-DD');
  const result = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(result) || new Date(result).toISOString().slice(0, 10) !== value) {
    throw new RangeError('Dates must be valid UTC calendar dates');
  }
  return result;
}

function validateWindow(window: SeasonalCalendarWindow): void {
  if (!window.id.trim() || !window.branchId.trim() || !window.name.trim()) {
    throw new RangeError('Calendar window id, branch and name are required');
  }
  if (dateMs(window.endDate) < dateMs(window.startDate)) {
    throw new RangeError('Calendar window end date cannot precede its start date');
  }
}

/** Owner-facing update primitive: callers persist the returned branch calendar. */
export function upsertSeasonalWindow(
  calendar: readonly SeasonalCalendarWindow[],
  window: SeasonalCalendarWindow
): SeasonalCalendarWindow[] {
  validateWindow(window);
  if (calendar.some((item) => item.id === window.id && item.branchId !== window.branchId)) {
    throw new RangeError('A calendar window cannot be moved between branches');
  }
  return [...calendar.filter((item) => item.id !== window.id), { ...window }].sort(
    (a, b) => a.startDate.localeCompare(b.startDate) || a.id.localeCompare(b.id)
  );
}

export function removeSeasonalWindow(
  calendar: readonly SeasonalCalendarWindow[],
  input: { branchId: string; windowId: string }
): SeasonalCalendarWindow[] {
  return calendar.filter((item) => item.branchId !== input.branchId || item.id !== input.windowId);
}

function mean(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function checkedHistory(history: readonly SaltSalesDay[]): SaltSalesDay[] {
  return history.map((day) => {
    dateMs(day.date);
    if (
      !day.branchId.trim() ||
      !day.saltId.trim() ||
      !Number.isSafeInteger(day.units) ||
      day.units < 0
    ) {
      throw new RangeError('Sales history requires branch, salt and non-negative integer units');
    }
    return day;
  });
}

/** Learns an event's uplift only from the selected branch and salt's own observations. */
export function learnCalendarUplift(input: {
  branchId: string;
  saltId: string;
  forecastDate: string;
  calendar: readonly SeasonalCalendarWindow[];
  history: readonly SaltSalesDay[];
  config?: SeasonalLearningConfig;
}): LearnedCalendarUplift | null {
  const forecastMs = dateMs(input.forecastDate);
  const config = input.config ?? DEFAULT_SEASONAL_LEARNING_CONFIG;
  const active = input.calendar.find((window) => {
    validateWindow(window);
    return (
      window.enabled &&
      window.branchId === input.branchId &&
      dateMs(window.startDate) <= forecastMs &&
      forecastMs <= dateMs(window.endDate)
    );
  });
  if (!active) return null;

  const ownHistory = checkedHistory(input.history).filter(
    (day) =>
      day.branchId === input.branchId &&
      day.saltId === input.saltId &&
      dateMs(day.date) < forecastMs
  );
  const eventUnits = ownHistory
    .filter((day) => active.startDate <= day.date && day.date <= active.endDate)
    .map((day) => day.units);
  const baselineUnits = ownHistory
    .filter((day) => day.date < active.startDate || day.date > active.endDate)
    .map((day) => day.units);
  if (
    eventUnits.length < config.minimumEventDays ||
    baselineUnits.length < config.minimumBaselineDays
  ) {
    return null;
  }
  const baselineMeanUnits = mean(baselineUnits);
  if (baselineMeanUnits <= 0) return null;
  const eventMeanUnits = mean(eventUnits);
  const observedBps = Math.round((eventMeanUnits * BPS) / baselineMeanUnits);
  return {
    windowId: active.id,
    windowName: active.name,
    upliftBps: Math.min(config.maximumUpliftBps, Math.max(config.minimumUpliftBps, observedBps)),
    eventDays: eventUnits.length,
    baselineDays: baselineUnits.length,
    eventMeanUnits,
    baselineMeanUnits,
  };
}

/** Flags per-salt daily spikes against prior branch-local observations (never future data). */
export function detectSalesSpikes(
  history: readonly SaltSalesDay[],
  config: SpikeDetectionConfig = DEFAULT_SPIKE_DETECTION_CONFIG
): SalesSpike[] {
  const groups = new Map<string, SaltSalesDay[]>();
  for (const day of checkedHistory(history)) {
    const key = `${day.branchId}\u0000${day.saltId}`;
    groups.set(key, [...(groups.get(key) ?? []), day]);
  }
  const spikes: SalesSpike[] = [];
  for (const days of groups.values()) {
    days.sort((a, b) => a.date.localeCompare(b.date));
    days.forEach((day, index) => {
      const prior = days.slice(Math.max(0, index - config.baselineDays), index);
      if (prior.length < config.minimumBaselineDays || day.units < config.minimumUnits) return;
      const baselineMeanUnits = mean(prior.map((item) => item.units));
      if (baselineMeanUnits <= 0) return;
      const ratioBps = Math.round((day.units * BPS) / baselineMeanUnits);
      if (ratioBps >= config.thresholdBps) spikes.push({ ...day, baselineMeanUnits, ratioBps });
    });
  }
  return spikes.sort(
    (a, b) => a.date.localeCompare(b.date) || a.branchId.localeCompare(b.branchId)
  );
}
