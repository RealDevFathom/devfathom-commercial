import { describe, expect, it } from 'vitest';

import {
  type AvailabilityWindow,
  channelPublished,
  isItemAvailableAt,
  partitionWindows,
  resolveLocalWallClock,
  windowMatches,
} from './menu-availability';

/** Build a window with sensible defaults. */
function win(partial: Partial<AvailabilityWindow>): AvailabilityWindow {
  return { daysOfWeek: [], startMinutes: 0, endMinutes: 0, menuItemId: null, ...partial };
}

const NY = 'America/New_York';

describe('resolveLocalWallClock', () => {
  it('converts a UTC instant to branch-local wall clock', () => {
    // 2026-06-15 16:30 UTC == 12:30 EDT (UTC-4), a Monday.
    const local = resolveLocalWallClock(NY, new Date('2026-06-15T16:30:00Z'));
    expect(local.dateKey).toBe('2026-06-15');
    expect(local.dayOfWeek).toBe(1); // Monday
    expect(local.minutes).toBe(12 * 60 + 30);
  });

  it('rolls the local calendar date back across the UTC boundary', () => {
    // 2026-06-15 02:00 UTC == 2026-06-14 22:00 EDT (previous local day, a Sunday).
    const local = resolveLocalWallClock(NY, new Date('2026-06-15T02:00:00Z'));
    expect(local.dateKey).toBe('2026-06-14');
    expect(local.dayOfWeek).toBe(0); // Sunday
    expect(local.minutes).toBe(22 * 60);
  });

  it('reports local midnight as minute 0, not 1440', () => {
    // 2026-06-15 04:00 UTC == 00:00 EDT.
    const local = resolveLocalWallClock(NY, new Date('2026-06-15T04:00:00Z'));
    expect(local.dateKey).toBe('2026-06-15');
    expect(local.minutes).toBe(0);
  });
});

describe('windowMatches — same-day windows', () => {
  const local = { dateKey: '2026-06-15', dayOfWeek: 1, minutes: 12 * 60 }; // Mon 12:00

  it('matches inside a half-open range on a selected day', () => {
    expect(windowMatches(win({ daysOfWeek: [1], startMinutes: 660, endMinutes: 900 }), local)).toBe(
      true
    );
  });

  it('is inclusive of the start minute and exclusive of the end minute', () => {
    const noon = { ...local, minutes: 720 };
    expect(windowMatches(win({ startMinutes: 720, endMinutes: 900 }), noon)).toBe(true); // start
    expect(windowMatches(win({ startMinutes: 600, endMinutes: 720 }), noon)).toBe(false); // end excl
  });

  it('rejects a day not in the day-of-week set', () => {
    expect(windowMatches(win({ daysOfWeek: [2], startMinutes: 660, endMinutes: 900 }), local)).toBe(
      false
    );
  });

  it('treats an empty day-of-week set as every day', () => {
    expect(windowMatches(win({ daysOfWeek: [], startMinutes: 660, endMinutes: 900 }), local)).toBe(
      true
    );
  });
});

describe('windowMatches — cross-midnight windows', () => {
  // "Fri 22:00 – 02:00" => startMinutes 1320, endMinutes 120, daysOfWeek [5] (Fri).
  const window = win({ daysOfWeek: [5], startMinutes: 1320, endMinutes: 120 });

  it('is open late Friday night (late-night tail on the start day)', () => {
    expect(windowMatches(window, { dateKey: '2026-06-19', dayOfWeek: 5, minutes: 23 * 60 })).toBe(
      true
    );
  });

  it('is open early Saturday morning (early tail attributed to Friday)', () => {
    expect(windowMatches(window, { dateKey: '2026-06-20', dayOfWeek: 6, minutes: 60 })).toBe(true);
  });

  it('is closed Saturday night (Saturday is not a selected start day)', () => {
    expect(windowMatches(window, { dateKey: '2026-06-20', dayOfWeek: 6, minutes: 23 * 60 })).toBe(
      false
    );
  });

  it('is closed mid-afternoon Friday (outside both tails)', () => {
    expect(windowMatches(window, { dateKey: '2026-06-19', dayOfWeek: 5, minutes: 15 * 60 })).toBe(
      false
    );
  });
});

describe('isItemAvailableAt — DST transitions (America/New_York)', () => {
  it('never opens a wall-clock window that the spring-forward gap skips', () => {
    // 2026-03-08: 02:00 -> 03:00. A 02:00–02:30 window can never be reached.
    const windows = [win({ startMinutes: 120, endMinutes: 150 })];
    // 06:30 UTC == 01:30 EST (just before the jump).
    expect(
      isItemAvailableAt({
        timezone: NY,
        at: new Date('2026-03-08T06:30:00Z'),
        publicationWindows: windows,
        itemWindows: [],
        exceptions: [],
      })
    ).toBe(false);
    // 07:00 UTC == 03:00 EDT (just after the jump).
    expect(
      isItemAvailableAt({
        timezone: NY,
        at: new Date('2026-03-08T07:00:00Z'),
        publicationWindows: windows,
        itemWindows: [],
        exceptions: [],
      })
    ).toBe(false);
  });

  it('opens a repeated fall-back wall time for both underlying instants', () => {
    // 2026-11-01: 02:00 EDT -> 01:00 EST, so 01:00–01:59 occurs twice. Window 01:00–01:45.
    const windows = [win({ startMinutes: 60, endMinutes: 105 })];
    // 05:30 UTC == 01:30 EDT (first pass, before fall-back).
    expect(
      isItemAvailableAt({
        timezone: NY,
        at: new Date('2026-11-01T05:30:00Z'),
        publicationWindows: windows,
        itemWindows: [],
        exceptions: [],
      })
    ).toBe(true);
    // 06:30 UTC == 01:30 EST (second pass, after fall-back).
    expect(
      isItemAvailableAt({
        timezone: NY,
        at: new Date('2026-11-01T06:30:00Z'),
        publicationWindows: windows,
        itemWindows: [],
        exceptions: [],
      })
    ).toBe(true);
  });
});

describe('isItemAvailableAt — exceptions override windows', () => {
  const openWindows = [win({ startMinutes: 0, endMinutes: 1439 })]; // effectively all day

  it('a closed exception closes an otherwise-open date', () => {
    expect(
      isItemAvailableAt({
        timezone: NY,
        at: new Date('2026-12-25T17:00:00Z'), // 12:00 EST, 2026-12-25 local
        publicationWindows: openWindows,
        itemWindows: [],
        exceptions: [{ date: new Date('2026-12-25T00:00:00Z'), isClosed: true }],
      })
    ).toBe(false);
  });

  it('an open exception opens an otherwise-closed date', () => {
    // No windows match noon (a 03:00–04:00 window), but the open exception forces open.
    expect(
      isItemAvailableAt({
        timezone: NY,
        at: new Date('2026-12-25T17:00:00Z'),
        publicationWindows: [win({ startMinutes: 180, endMinutes: 240 })],
        itemWindows: [],
        exceptions: [{ date: new Date('2026-12-25T00:00:00Z'), isClosed: false }],
      })
    ).toBe(true);
  });

  it('matches the exception against the branch-local date, not the UTC date', () => {
    // 2026-12-26 02:00 UTC == 2026-12-25 21:00 EST. The 12-25 closed exception applies.
    expect(
      isItemAvailableAt({
        timezone: NY,
        at: new Date('2026-12-26T02:00:00Z'),
        publicationWindows: openWindows,
        itemWindows: [],
        exceptions: [{ date: new Date('2026-12-25T00:00:00Z'), isClosed: true }],
      })
    ).toBe(false);
  });
});

describe('isItemAvailableAt — layered windows', () => {
  const noonMonday = new Date('2026-06-15T16:00:00Z'); // 12:00 EDT Monday

  it('is open when both layers are open', () => {
    expect(
      isItemAvailableAt({
        timezone: NY,
        at: noonMonday,
        publicationWindows: [win({ startMinutes: 600, endMinutes: 900 })], // 10:00–15:00
        itemWindows: [win({ startMinutes: 660, endMinutes: 840 })], // 11:00–14:00
        exceptions: [],
      })
    ).toBe(true);
  });

  it('is closed when the item layer excludes the instant even if the publication layer is open', () => {
    expect(
      isItemAvailableAt({
        timezone: NY,
        at: noonMonday,
        publicationWindows: [win({ startMinutes: 600, endMinutes: 900 })],
        itemWindows: [win({ startMinutes: 360, endMinutes: 660 })], // 06:00–11:00 only
        exceptions: [],
      })
    ).toBe(false);
  });

  it('treats an empty layer as no restriction', () => {
    expect(
      isItemAvailableAt({
        timezone: NY,
        at: noonMonday,
        publicationWindows: [],
        itemWindows: [],
        exceptions: [],
      })
    ).toBe(true);
  });
});

describe('channelPublished', () => {
  it('lists an explicitly published channel', () => {
    expect(channelPublished(['DINE_IN', 'TAKEAWAY'], 'DINE_IN')).toBe(true);
    expect(channelPublished(['DINE_IN', 'TAKEAWAY'], 'DELIVERY')).toBe(false);
  });

  it('treats an empty set as every operational channel, including delivery', () => {
    expect(channelPublished([], 'DINE_IN')).toBe(true);
    expect(channelPublished([], 'TAKEAWAY')).toBe(true);
    expect(channelPublished([], 'DELIVERY')).toBe(true);
    expect(channelPublished(['DELIVERY'], 'DELIVERY')).toBe(true);
  });
});

describe('partitionWindows', () => {
  it('splits windows into the publication and per-item layers', () => {
    const windows = [
      win({ menuItemId: null, startMinutes: 600, endMinutes: 900 }),
      win({ menuItemId: 'item_a', startMinutes: 660, endMinutes: 840 }),
      win({ menuItemId: 'item_b', startMinutes: 0, endMinutes: 100 }),
    ];
    const { publicationWindows, itemWindows } = partitionWindows(windows, 'item_a');
    expect(publicationWindows).toHaveLength(1);
    expect(itemWindows).toHaveLength(1);
    expect(itemWindows[0].startMinutes).toBe(660);
  });
});

it('treats 1440 as end of day, including the final minute', () => {
  expect(
    windowMatches(win({ startMinutes: 0, endMinutes: 1440 }), {
      dateKey: '2026-06-15',
      dayOfWeek: 1,
      minutes: 1439,
    })
  ).toBe(true);
});
