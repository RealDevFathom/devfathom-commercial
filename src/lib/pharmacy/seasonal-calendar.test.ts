import { describe, expect, it } from 'vitest';

import { demandDateAfter, forecastDemandEvidence, type DemandEvidenceDay } from './demand-evidence';
import { simulateReplenishmentDecision } from './forecasting';
import {
  detectDemandSpikes,
  learnSeasonalUplift,
  seasonalWindowFor,
  seasonalWindowKey,
  validateSeasonalWindows,
  type SeasonalWindow,
} from './seasonal-calendar';

const scope = { organizationId: 'org', branchId: 'branch', medicineId: 'med' };
const source = {
  kind: 'SYNTHETIC_FIXTURE' as const,
  reference: 'DEV-74 fixture',
  asOf: '2026-01-01T00:00:00Z',
};

/** 2025 history: 10 units/day, tripled during last year's dengue window. */
function history(): DemandEvidenceDay[] {
  const rows: DemandEvidenceDay[] = [];
  for (let i = 0; i < 365; i += 1) {
    const date = demandDateAfter('2025-01-01', i);
    const inDengue = date >= '2025-09-01' && date < '2025-11-01';
    rows.push({ date, knownAt: `${date}T23:00:00Z`, state: 'OBSERVED', units: inDengue ? 30 : 10 });
  }
  return rows;
}

const dengue2025: SeasonalWindow = {
  kind: 'DENGUE',
  label: 'Dengue season',
  startDate: '2025-09-01',
  endDateExclusive: '2025-11-01',
};
const dengue2026: SeasonalWindow = {
  kind: 'DENGUE',
  label: 'Dengue season',
  startDate: '2026-01-03',
  endDateExclusive: '2026-01-05',
};

describe('seasonal calendar uplift', () => {
  it('learns the uplift from branch history instead of a hardcoded figure', () => {
    const result = learnSeasonalUplift({
      days: history().map((row) => ({ date: row.date, units: row.units ?? null })),
      windows: [dengue2025],
    });
    expect(result.baseline).toEqual({ days: 304, meanUnits: 10 });
    expect(result.uplifts).toEqual([
      expect.objectContaining({
        key: 'DENGUE',
        status: 'LEARNED',
        upliftBps: 30_000,
        windowDays: 61,
      }),
    ]);
  });

  it('withholds an uplift when the window has too little history and honours the config', () => {
    const days = history()
      .slice(0, 250)
      .map((row) => ({ date: row.date, units: row.units ?? null }));
    // Only 5 in-window days exist before 2025-09-06.
    const thin = learnSeasonalUplift({
      days: days.filter((day) => day.date < '2025-09-06'),
      windows: [dengue2025],
    });
    expect(thin.uplifts[0]).toMatchObject({ status: 'INSUFFICIENT_HISTORY', upliftBps: null });
    const relaxed = learnSeasonalUplift({
      days: days.filter((day) => day.date < '2025-09-06'),
      windows: [dengue2025],
      config: { minWindowDays: 5 },
    });
    expect(relaxed.uplifts[0]).toMatchObject({ status: 'LEARNED', upliftBps: 30_000 });
    const capped = learnSeasonalUplift({
      days: days.filter((day) => day.date < '2025-09-06'),
      windows: [dengue2025],
      config: { minWindowDays: 5, maxUpliftBps: 15_000 },
    });
    expect(capped.uplifts[0]!.upliftBps).toBe(15_000);
  });

  it('skips unknown days rather than treating them as zero', () => {
    const result = learnSeasonalUplift({
      days: [
        ...Array.from({ length: 14 }, (_, i) => ({
          date: demandDateAfter('2025-01-01', i),
          units: 10,
        })),
        ...Array.from({ length: 7 }, (_, i) => ({
          date: demandDateAfter('2025-02-01', i),
          units: i % 2 ? null : 20,
        })),
      ],
      windows: [
        { kind: 'FLU', label: 'Flu', startDate: '2025-02-01', endDateExclusive: '2025-03-01' },
      ],
      config: { minWindowDays: 4 },
    });
    expect(result.uplifts[0]).toMatchObject({ upliftBps: 20_000, windowDays: 4 });
  });

  it('groups custom windows by label and validates windows', () => {
    expect(seasonalWindowKey({ kind: 'CUSTOM', label: '  Eid  Rush ' })).toBe('CUSTOM:eid rush');
    expect(seasonalWindowKey({ kind: 'RAMADAN', label: 'Ramadan 1447' })).toBe('RAMADAN');
    expect(seasonalWindowFor([dengue2025], '2025-10-31')).toBe(dengue2025);
    expect(seasonalWindowFor([dengue2025], '2025-11-01')).toBeNull();
    expect(() =>
      validateSeasonalWindows([{ ...dengue2025, endDateExclusive: dengue2025.startDate }])
    ).toThrow(RangeError);
    expect(() => validateSeasonalWindows([{ ...dengue2025, label: ' ' }])).toThrow(RangeError);
  });

  it('feeds the learned uplift into the demand forecast for in-window days only', () => {
    const input = {
      scope,
      source,
      originDate: '2026-01-01',
      historyStartDate: '2025-01-01',
      horizonDays: 5,
      method: 'RECENT_MEAN' as const,
      days: history(),
    };
    const plain = forecastDemandEvidence(input);
    expect(plain.seasonalCalendar).toBeUndefined();
    expect(plain.days.every((day) => day.method === 'RECENT_MEAN')).toBe(true);

    const seasonal = forecastDemandEvidence({
      ...input,
      seasonalCalendar: { windows: [dengue2025, dengue2026] },
    });
    expect(seasonal.days.map((day) => [day.date, day.units, day.method])).toEqual([
      ['2026-01-01', plain.days[0]!.units, 'RECENT_MEAN'],
      ['2026-01-02', plain.days[1]!.units, 'RECENT_MEAN'],
      ['2026-01-03', 30, 'SEASONAL_CALENDAR'],
      ['2026-01-04', 30, 'SEASONAL_CALENDAR'],
      ['2026-01-05', plain.days[4]!.units, 'RECENT_MEAN'],
    ]);
    expect(seasonal.days[2]!.seasonal).toEqual({
      key: 'DENGUE',
      label: 'Dengue season',
      upliftBps: 30_000,
      baselineMeanUnits: 10,
    });
    expect(seasonal.seasonalCalendar).toMatchObject({ baselineDays: 304, baselineMeanUnits: 10 });
  });

  it('never learns from evidence at or after origin', () => {
    const rows = history().filter((row) => row.date < '2025-09-01');
    // A future in-window spike must not leak into the learned uplift.
    rows.push({
      date: '2026-01-03',
      knownAt: '2025-12-31T00:00:00Z',
      state: 'OBSERVED',
      units: 999,
    });
    const forecast = forecastDemandEvidence({
      scope,
      source,
      originDate: '2026-01-01',
      historyStartDate: '2025-01-01',
      horizonDays: 4,
      method: 'RECENT_MEAN',
      days: rows,
      seasonalCalendar: { windows: [dengue2025, dengue2026] },
    });
    expect(forecast.seasonalCalendar!.uplifts[0]).toMatchObject({
      status: 'INSUFFICIENT_HISTORY',
      upliftBps: null,
    });
    expect(forecast.days.every((day) => day.method === 'RECENT_MEAN')).toBe(true);
    expect(forecast.unknowns).toContain(
      'Some seasonal windows lack enough branch history; their days use the base method.'
    );
  });

  it('carries the calendar uplift through the replenishment decision', () => {
    const decision = simulateReplenishmentDecision({
      demand: {
        scope,
        source,
        originDate: '2026-01-01',
        historyStartDate: '2025-01-01',
        horizonDays: 5,
        method: 'RECENT_MEAN',
        days: history(),
        seasonalCalendar: { windows: [dengue2025, dengue2026] },
      },
      currency: 'PKR',
      inventorySource: { kind: 'SYNTHETIC_FIXTURE', reference: 'fixture', asOf: source.asOf },
      stock: [],
      inbound: [],
      policies: { source: 'MANUAL_SCENARIO', currentQuantityUnits: 0, proposedQuantityUnits: 0 },
      orderTerms: {
        source,
        packSize: 1,
        minimumOrderUnits: 0,
        unitCostMinor: null,
        budgetMinor: null,
        storageLimitUnits: null,
        arrivalAt: null,
        expiresAt: null,
      },
    });
    expect(decision.demand.days.filter((day) => day.method === 'SEASONAL_CALENDAR')).toHaveLength(
      2
    );
  });
});

describe('demand spike detection', () => {
  const baseline = Array.from({ length: 30 }, (_, i) => ({
    date: demandDateAfter('2026-03-01', i),
    units: 10 + (i % 3),
  }));

  it('flags a synthetic outbreak spike against the trailing baseline', () => {
    const days = [
      ...baseline,
      { date: '2026-03-31', units: 45 },
      { date: '2026-04-01', units: 11 },
    ];
    const spikes = detectDemandSpikes({ days, fromDate: '2026-03-20' });
    expect(spikes).toEqual([
      expect.objectContaining({
        date: '2026-03-31',
        units: 45,
        baselineMeanUnits: 12,
        baselineDays: 28,
      }),
    ]);
    expect(spikes[0]!.upliftBps).toBeGreaterThanOrEqual(40_000);
  });

  it('does not flag ordinary variation, thin baselines or unknown days', () => {
    expect(detectDemandSpikes({ days: baseline })).toEqual([]);
    expect(
      detectDemandSpikes({
        days: [
          { date: '2026-03-01', units: 10 },
          { date: '2026-03-02', units: 90 },
        ],
      })
    ).toEqual([]);
    expect(
      detectDemandSpikes({ days: [...baseline, { date: '2026-03-31', units: null }] })
    ).toEqual([]);
  });

  it('honours a configurable threshold and judges only from the requested date', () => {
    const days = [...baseline, { date: '2026-03-31', units: 18 }];
    expect(detectDemandSpikes({ days })).toEqual([]);
    expect(detectDemandSpikes({ days, config: { thresholdBps: 15_000 } })).toHaveLength(1);
    expect(
      detectDemandSpikes({ days, fromDate: '2026-04-01', config: { thresholdBps: 15_000 } })
    ).toEqual([]);
    expect(() => detectDemandSpikes({ days, config: { thresholdBps: 10_000 } })).toThrow(
      RangeError
    );
  });
});
