import { expect, it } from 'vitest';
import { comparisonDays, dashboardPeriods } from './owner-trading';

it('aligns two thirty-day windows and keeps days without sales at zero', () => {
  const rows = comparisonDays([
    { key: '-31', value: 100 },
    { key: '-1', value: 250 },
  ]);
  expect(rows).toHaveLength(30);
  expect(rows[28]).toMatchObject({ value: 250, previous: 100 });
  expect(rows[29]).toMatchObject({ value: 0, previous: 0 });
});

it('aligns today and the same weekday last week separately for each branch', () => {
  const at = new Date('2026-11-26T02:00:00+05:00');
  const days = dashboardPeriods(
    [
      {
        id: 'morning',
        name: 'Morning',
        businessDayEndsAtHistory: [{ from: '2020-01-01', hour: 4 }],
      },
      { id: 'midnight', name: 'Midnight', businessDayEndsAtHistory: [] },
    ],
    'Asia/Karachi',
    at
  );
  expect(days.map((row) => row.today)).toEqual(['2026-11-25', '2026-11-26']);
});
