import { describe, expect, it } from 'vitest';
import {
  detectSalesSpikes,
  learnCalendarUplift,
  removeSeasonalWindow,
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
});
