import { describe, expect, it } from 'vitest';

import { pharmacyCashCloseDayBounds } from './cash-close-day';

describe('pharmacy cash-close calendar-day evidence bounds', () => {
  it.each([
    {
      date: '2026-10-30',
      zone: 'UTC',
      start: '2026-10-30T00:00:00.000Z',
      end: '2026-10-31T00:00:00.000Z',
    },
    {
      date: '2026-10-30',
      zone: 'Asia/Karachi',
      start: '2026-10-29T19:00:00.000Z',
      end: '2026-10-30T19:00:00.000Z',
    },
    {
      date: '2026-10-30',
      zone: 'Asia/Kathmandu',
      start: '2026-10-29T18:15:00.000Z',
      end: '2026-10-30T18:15:00.000Z',
    },
    {
      date: '2026-03-08',
      zone: 'America/New_York',
      start: '2026-03-08T05:00:00.000Z',
      end: '2026-03-09T04:00:00.000Z',
    },
    {
      date: '2026-11-01',
      zone: 'America/New_York',
      start: '2026-11-01T04:00:00.000Z',
      end: '2026-11-02T05:00:00.000Z',
    },
    {
      date: '2018-11-04',
      zone: 'America/Sao_Paulo',
      start: '2018-11-04T03:00:00.000Z',
      end: '2018-11-05T02:00:00.000Z',
    },
    {
      date: '2011-12-30',
      zone: 'Pacific/Apia',
      start: '2011-12-30T10:00:00.000Z',
      end: '2011-12-30T10:00:00.000Z',
    },
  ])('selects exactly $date in $zone', ({ date, zone, start, end }) => {
    expect(pharmacyCashCloseDayBounds(new Date(`${date}T00:00:00.000Z`), zone)).toEqual({
      start: new Date(start),
      end: new Date(end),
    });
  });
});
