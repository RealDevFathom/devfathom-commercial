import { describe, expect, it } from 'vitest';
import {
  detectSalesSpikes,
  learnCalendarUplift,
  removeSeasonalWindow,
  seasonalForecastAdjustment,
  upsertSeasonalWindow,
  type SaltSalesDay,
  type SeasonalCalendarWindow,
} from './seasonal-forecasting';

const window: SeasonalCalendarWindow = {
  id: 'dengue-2026',
  branchId: 'branch-a',
  name: 'Owner seasonal window',
  startDate: '2026-07-01',
  endDate: '2026-09-30',
  enabled: true,
};

const baseline: SaltSalesDay[] = Array.from({ length: 10 }, (_, index) => ({
  branchId: 'branch-a',
  saltId: 'salt-a',
  date: `2026-06-${String(index + 1).padStart(2, '0')}`,
  units: 10,
}));

describe('branch seasonal calendar', () => {
  it('is owner-editable without changing another branch calendar', () => {
    const other = { ...window, id: 'other', branchId: 'branch-b' };
    const created = upsertSeasonalWindow([other], window);
    const renamed = upsertSeasonalWindow(created, { ...window, name: 'Edited locally' });
    expect(renamed.find((item) => item.id === window.id)?.name).toBe('Edited locally');
    expect(removeSeasonalWindow(renamed, { branchId: 'branch-a', windowId: window.id })).toEqual([
      other,
    ]);
  });

  it('learns calendar uplift only from matching branch and salt history', () => {
    const history = [
      ...baseline,
      { branchId: 'branch-a', saltId: 'salt-a', date: '2026-07-01', units: 20 },
      { branchId: 'branch-a', saltId: 'salt-a', date: '2026-07-02', units: 20 },
      { branchId: 'branch-b', saltId: 'salt-a', date: '2026-07-01', units: 500 },
      { branchId: 'branch-a', saltId: 'salt-b', date: '2026-07-01', units: 500 },
    ];
    expect(
      learnCalendarUplift({
        branchId: 'branch-a',
        saltId: 'salt-a',
        forecastDate: '2026-07-03',
        calendar: [window],
        history,
      })
    ).toMatchObject({ upliftBps: 20_000, eventDays: 2, baselineDays: 10 });
  });

  it('rejects overlapping enabled windows independent of input order', () => {
    expect(() =>
      upsertSeasonalWindow([window], {
        ...window,
        id: 'overlap',
        startDate: '2026-09-01',
        endDate: '2026-10-01',
      })
    ).toThrow(/cannot overlap/);
    expect(() =>
      learnCalendarUplift({
        branchId: 'branch-a',
        saltId: 'salt-a',
        forecastDate: '2026-07-03',
        calendar: [window, { ...window, id: 'overlap' }],
        history: baseline,
      })
    ).toThrow(/multiple enabled/);
  });

  it('aggregates duplicate same-day rows and validates learning configuration', () => {
    const history = [
      ...baseline,
      { branchId: 'branch-a', saltId: 'salt-a', date: '2026-07-01', units: 8 },
      { branchId: 'branch-a', saltId: 'salt-a', date: '2026-07-01', units: 12 },
      { branchId: 'branch-a', saltId: 'salt-a', date: '2026-07-02', units: 20 },
    ];
    expect(
      learnCalendarUplift({
        branchId: 'branch-a',
        saltId: 'salt-a',
        forecastDate: '2026-07-03',
        calendar: [window],
        history,
      })
    ).toMatchObject({ eventDays: 2, eventMeanUnits: 20 });
    expect(() =>
      learnCalendarUplift({
        branchId: 'branch-a',
        saltId: 'salt-a',
        forecastDate: '2026-07-03',
        calendar: [window],
        history,
        config: {
          minimumEventDays: 0,
          minimumBaselineDays: 1,
          minimumUpliftBps: 1,
          maximumUpliftBps: 2,
        },
      })
    ).toThrow(/configuration/);
  });
});

describe('branch and salt sales spike detection', () => {
  it('flags a synthetic spike against only preceding observations', () => {
    const history = [
      ...baseline,
      { branchId: 'branch-a', saltId: 'salt-a', date: '2026-06-11', units: 30 },
      { branchId: 'branch-b', saltId: 'salt-a', date: '2026-06-11', units: 100 },
    ];
    expect(detectSalesSpikes(history)).toEqual([
      {
        branchId: 'branch-a',
        saltId: 'salt-a',
        date: '2026-06-11',
        units: 30,
        baselineMeanUnits: 10,
        ratioBps: 30_000,
      },
    ]);
  });

  it('aggregates duplicate dates and rejects invalid spike configuration', () => {
    expect(detectSalesSpikes([...baseline, { ...baseline[0], units: 5 }])).toEqual([]);
    expect(() =>
      detectSalesSpikes(baseline, {
        baselineDays: 0,
        minimumBaselineDays: 1,
        thresholdBps: 0,
        minimumUnits: 0,
      })
    ).toThrow(/configuration/);
  });
});

describe('seasonal forecast adjustment bounds', () => {
  it('caps an outlier spike at the calendar uplift ceiling', () => {
    const history = [
      ...baseline,
      { branchId: 'branch-a', saltId: 'salt-a', date: '2026-06-11', units: 5_000 },
    ];
    const result = seasonalForecastAdjustment({
      branchId: 'branch-a',
      saltId: 'salt-a',
      forecastDate: '2026-06-12',
      calendar: [],
      history,
    });
    expect(result.detectedSpike?.ratioBps).toBe(5_000_000);
    expect(result.seasonalityBps).toBe(30_000);
  });

  it('excludes other enabled event windows from the learning baseline', () => {
    const earlier: SeasonalCalendarWindow = {
      ...window,
      id: 'earlier',
      startDate: '2026-06-01',
      endDate: '2026-06-03',
    };
    const history: SaltSalesDay[] = [
      ...baseline.map((day, index) => (index < 3 ? { ...day, units: 40 } : day)),
      ...Array.from({ length: 5 }, (_, index) => ({
        branchId: 'branch-a',
        saltId: 'salt-a',
        date: `2026-06-${String(index + 11).padStart(2, '0')}`,
        units: 10,
      })),
      { branchId: 'branch-a', saltId: 'salt-a', date: '2026-07-01', units: 20 },
      { branchId: 'branch-a', saltId: 'salt-a', date: '2026-07-02', units: 20 },
    ];
    const learned = learnCalendarUplift({
      branchId: 'branch-a',
      saltId: 'salt-a',
      forecastDate: '2026-07-03',
      calendar: [earlier, window],
      history,
    });
    expect(learned).toMatchObject({ baselineDays: 12, baselineMeanUnits: 10, upliftBps: 20_000 });
  });
});
