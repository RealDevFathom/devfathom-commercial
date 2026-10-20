/**
 * PROP-07 — the shape rules and the buffer arithmetic.
 *
 * The database is what actually holds invariant 25; these tests pin that the
 * application's arithmetic gives the *same* answer, so a surface never tells an
 * operator a hall is free that the exclusion constraint is about to refuse — nor
 * the reverse, which would hide a saleable slot.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  HOTEL_SPACE_BOOKING_KIND_LABELS,
  MAX_BOOKING_HOURS,
  bufferedWindow,
  getFunctionSpace,
  hotelFunctionSpaceCreateInput,
  hotelFunctionSpacePricing,
  hotelSpaceBookingInput,
  hotelSpaceWindowInput,
  insertSpaceBooking,
  listSpaceBookings,
  releaseSpaceHold,
  setFunctionSpaceActive,
  spaceAvailability,
  toFunctionSpaceView,
  toSpaceBookingView,
  unavailableReason,
  updateFunctionSpace,
  windowsOverlap,
  type FunctionSpaceDb,
} from './function-spaces';

const ORG = 'org_hotel_spaces';
const BRANCH = 'branch_1';
const at = (iso: string) => new Date(iso);

const validSpace = {
  name: 'Crystal Hall',
  nameUr: 'کرسٹل ہال',
  layouts: [
    { layout: 'Theatre', capacity: 300 },
    { layout: 'Banquet', capacity: 220 },
  ],
  pricing: { hourlyMinor: 4_500_000, perFunctionMinor: 25_000_000 },
  setupMinutes: 90,
  teardownMinutes: 60,
};
const version = new Date('2026-10-01T00:00:00.000Z');

describe('function space input contract', () => {
  it('accepts a space with layouts, capacities and minor-unit pricing', () => {
    const parsed = hotelFunctionSpaceCreateInput.parse(validSpace);
    expect(parsed.layouts).toEqual(validSpace.layouts);
    expect(parsed.pricing.hourlyMinor).toBe(4_500_000);
    // Not stated is not the same as zero: a hall sold only per function has no
    // daily rate, and a default of 0 would read as "free for the day".
    expect(parsed.pricing.dailyMinor).toBeUndefined();
    expect(parsed.active).toBe(true);
  });

  it('refuses a space with no layout at all', () => {
    expect(() => hotelFunctionSpaceCreateInput.parse({ ...validSpace, layouts: [] })).toThrow(
      /at least one layout/i
    );
  });

  it('refuses a capacity that is not a positive whole number of people', () => {
    for (const capacity of [0, -10, 12.5]) {
      expect(
        () =>
          hotelFunctionSpaceCreateInput.parse({
            ...validSpace,
            layouts: [{ layout: 'Theatre', capacity }],
          }),
        `capacity ${capacity}`
      ).toThrow();
    }
  });

  it('refuses the same layout listed twice for one space', () => {
    expect(() =>
      hotelFunctionSpaceCreateInput.parse({
        ...validSpace,
        layouts: [
          { layout: 'Theatre', capacity: 300 },
          { layout: 'theatre', capacity: 280 },
        ],
      })
    ).toThrow(/already listed/i);
  });

  it('refuses money that is not integer minor units', () => {
    expect(() => hotelFunctionSpacePricing.parse({ hourlyMinor: 4500.5 })).toThrow();
    expect(() => hotelFunctionSpacePricing.parse({ hourlyMinor: -1 })).toThrow();
    // A stray key is a mistake, not something to store and hope a reader ignores.
    expect(() => hotelFunctionSpacePricing.parse({ hourly: 4500 })).toThrow();
  });

  it('refuses a turnaround buffer longer than a day', () => {
    expect(() =>
      hotelFunctionSpaceCreateInput.parse({ ...validSpace, setupMinutes: 1441 })
    ).toThrow();
    expect(() =>
      hotelFunctionSpaceCreateInput.parse({ ...validSpace, teardownMinutes: -1 })
    ).toThrow();
  });

  it('refuses a window that does not end after it starts', () => {
    expect(() =>
      hotelSpaceWindowInput.parse({
        spaceId: 'space_1',
        startsAt: '2026-10-01T12:00:00.000Z',
        endsAt: '2026-10-01T12:00:00.000Z',
      })
    ).toThrow(/ends after it starts/i);
  });
});

describe('buffer arithmetic', () => {
  const buffers = { setupMinutes: 90, teardownMinutes: 60 };

  it('widens a window by the space’s setup before and teardown after', () => {
    const widened = bufferedWindow(
      { startsAt: at('2026-10-01T12:00:00.000Z'), endsAt: at('2026-10-01T16:00:00.000Z') },
      buffers
    );
    expect(widened.startsAt.toISOString()).toBe('2026-10-01T10:30:00.000Z');
    expect(widened.endsAt.toISOString()).toBe('2026-10-01T17:00:00.000Z');
  });

  it('treats touching windows as free, exactly as a half-open range does', () => {
    // `[)` bounds: with no buffers, a function ending at 16:00 and one starting
    // at 16:00 do not overlap. This is what makes back-to-back legal until a
    // buffer exists.
    const morning = {
      startsAt: at('2026-10-01T12:00:00.000Z'),
      endsAt: at('2026-10-01T16:00:00.000Z'),
    };
    const evening = {
      startsAt: at('2026-10-01T16:00:00.000Z'),
      endsAt: at('2026-10-01T20:00:00.000Z'),
    };
    expect(windowsOverlap(morning, evening)).toBe(false);

    const zero = { setupMinutes: 0, teardownMinutes: 0 };
    expect(windowsOverlap(bufferedWindow(morning, zero), bufferedWindow(evening, zero))).toBe(
      false
    );
    // One minute of teardown is enough to make the same pair collide.
    const oneMinute = { setupMinutes: 0, teardownMinutes: 1 };
    expect(
      windowsOverlap(bufferedWindow(morning, oneMinute), bufferedWindow(evening, oneMinute))
    ).toBe(true);
  });
});

/** A `findMany` that answers from a fixed list and records what it was asked. */
function fakeDb(
  rows: {
    id: string;
    organizationId: string;
    branchId: string;
    spaceId: string;
    kind: 'HOLD' | 'FUNCTION';
    startsAt: Date;
    endsAt: Date;
  }[]
) {
  const findMany = vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
    const from = (where.endsAt as { gt: Date }).gt;
    const to = (where.startsAt as { lt: Date }).lt;
    const excluded = (where.id as { not?: string } | undefined)?.not;
    return rows.filter(
      (row) =>
        ['organizationId', 'branchId', 'spaceId'].every(
          (key) => !(key in where) || row[key as keyof typeof row] === where[key]
        ) &&
        row.startsAt < to &&
        row.endsAt > from &&
        (!excluded || row.id !== excluded)
    );
  });
  return { db: { hotelSpaceBooking: { findMany } } as unknown as FunctionSpaceDb, findMany };
}

describe('space availability', () => {
  const space = { id: 'space_crystal', branchId: BRANCH, setupMinutes: 90, teardownMinutes: 60 };
  const booked = [
    {
      id: 'booking_walima',
      organizationId: ORG,
      branchId: BRANCH,
      spaceId: space.id,
      kind: 'FUNCTION' as const,
      startsAt: at('2026-10-01T12:00:00.000Z'),
      endsAt: at('2026-10-01T16:00:00.000Z'),
    },
  ];

  it('scopes the read by organization, property and space', async () => {
    const { db, findMany } = fakeDb(booked);
    await spaceAvailability(db, ORG, BRANCH, space, {
      startsAt: at('2026-10-02T12:00:00.000Z'),
      endsAt: at('2026-10-02T16:00:00.000Z'),
    });
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organizationId: ORG,
          branchId: BRANCH,
          spaceId: space.id,
        }),
      })
    );
  });

  it('reports a free window with the buffers it would occupy', async () => {
    const { db } = fakeDb(booked);
    const result = await spaceAvailability(db, ORG, BRANCH, space, {
      startsAt: at('2026-10-01T19:00:00.000Z'),
      endsAt: at('2026-10-01T23:00:00.000Z'),
    });
    expect(result.available).toBe(true);
    expect(result.conflicts).toEqual([]);
    expect(result.buffered.startsAt.toISOString()).toBe('2026-10-01T17:30:00.000Z');
    expect(result.buffered.endsAt.toISOString()).toBe('2026-10-02T00:00:00.000Z');
  });

  it('reports the booking in the way when the windows themselves overlap', async () => {
    const { db } = fakeDb(booked);
    const result = await spaceAvailability(db, ORG, BRANCH, space, {
      startsAt: at('2026-10-01T15:00:00.000Z'),
      endsAt: at('2026-10-01T18:00:00.000Z'),
    });
    expect(result.available).toBe(false);
    expect(result.conflicts.map((conflict) => conflict.id)).toEqual(['booking_walima']);
  });

  it('refuses a back-to-back booking because of the buffers alone', async () => {
    // 16:00–20:00 does not touch 12:00–16:00 at all. Teardown (60) then setup (90)
    // is what collides them — the same reason the exclusion constraint refuses it.
    const { db } = fakeDb(booked);
    const result = await spaceAvailability(db, ORG, BRANCH, space, {
      startsAt: at('2026-10-01T16:00:00.000Z'),
      endsAt: at('2026-10-01T20:00:00.000Z'),
    });
    expect(result.available).toBe(false);
    expect(result.conflicts.map((conflict) => conflict.id)).toEqual(['booking_walima']);
  });

  it('is free again once the gap covers teardown and setup', async () => {
    // 16:00 + 60 teardown = 17:00 clear; + 90 setup = 18:30 is the first legal start.
    const { db } = fakeDb(booked);
    const tooEarly = await spaceAvailability(db, ORG, BRANCH, space, {
      startsAt: at('2026-10-01T18:29:00.000Z'),
      endsAt: at('2026-10-01T22:00:00.000Z'),
    });
    expect(tooEarly.available).toBe(false);

    const exactly = await spaceAvailability(db, ORG, BRANCH, space, {
      startsAt: at('2026-10-01T18:30:00.000Z'),
      endsAt: at('2026-10-01T22:00:00.000Z'),
    });
    expect(exactly.available).toBe(true);
  });

  it('lets a booking being moved ignore itself', async () => {
    const { db } = fakeDb(booked);
    const result = await spaceAvailability(
      db,
      ORG,
      BRANCH,
      space,
      { startsAt: at('2026-10-01T13:00:00.000Z'), endsAt: at('2026-10-01T17:00:00.000Z') },
      { excludeBookingId: 'booking_walima' }
    );
    expect(result.available).toBe(true);
  });

  it('names when the space is next free rather than saying “unavailable”', async () => {
    const { db } = fakeDb(booked);
    const result = await spaceAvailability(db, ORG, BRANCH, space, {
      startsAt: at('2026-10-01T16:00:00.000Z'),
      endsAt: at('2026-10-01T20:00:00.000Z'),
    });
    const message = unavailableReason('Crystal Hall', result, (value) => value.toISOString());
    expect(message).toContain('Crystal Hall');
    // 16:00 end + 60 minutes of teardown.
    expect(message).toContain('2026-10-01T17:00:00.000Z');
    expect(
      unavailableReason('Crystal Hall', { ...result, available: true, conflicts: [] }, String)
    ).toBeNull();
  });

  it('denies a space from another property before reading its bookings', async () => {
    const { db, findMany } = fakeDb(booked);
    await expect(
      spaceAvailability(db, ORG, 'branch_2', space, {
        startsAt: at('2026-10-01T15:00:00.000Z'),
        endsAt: at('2026-10-01T18:00:00.000Z'),
      })
    ).rejects.toThrow(/does not belong to the expected property/i);
    expect(findMany).not.toHaveBeenCalled();
  });

  it('does not disclose bookings from another property, organization or space', async () => {
    const booking = booked[0]!;
    const { db } = fakeDb([
      booking,
      { ...booking, id: 'other_property', branchId: 'branch_2' },
      { ...booking, id: 'other_organization', organizationId: 'org_other' },
      { ...booking, id: 'other_space', spaceId: 'space_other' },
    ]);
    const result = await spaceAvailability(db, ORG, BRANCH, space, {
      startsAt: at('2026-10-01T15:00:00.000Z'),
      endsAt: at('2026-10-01T18:00:00.000Z'),
    });
    expect(result.available).toBe(false);
    expect(result.conflicts.map((conflict) => conflict.id)).toEqual([booking.id]);
  });
});

describe('function space ID isolation', () => {
  function spacesDb() {
    const current = {
      ...validSpace,
      id: 'space_current',
      organizationId: ORG,
      branchId: BRANCH,
      active: true,
      updatedAt: version,
    };
    const rows = [
      current,
      { ...current, id: 'space_other_property', branchId: 'branch_2' },
      { ...current, id: 'space_other_organization', organizationId: 'org_other' },
    ];
    const matches = (row: typeof current, where: Record<string, unknown>) =>
      Object.entries(where).every(([key, value]) => {
        const held = row[key as keyof typeof row];
        return held instanceof Date && value instanceof Date
          ? held.getTime() === value.getTime()
          : held === value;
      });
    const findFirst = vi.fn(
      async ({ where }: { where: Record<string, unknown> }) =>
        rows.find((row) => matches(row, where)) ?? null
    );
    const updateMany = vi.fn(
      async ({
        where,
        data,
      }: {
        where: Record<string, unknown>;
        data: Partial<typeof current>;
      }) => {
        const matched = rows.filter((row) => matches(row, where));
        matched.forEach((row) => Object.assign(row, data));
        return { count: matched.length };
      }
    );
    return {
      rows,
      db: { hotelFunctionSpace: { findFirst, updateMany } } as unknown as FunctionSpaceDb,
    };
  }

  const cases = [
    ['same property', 'space_current', true],
    ['another property in the same organization', 'space_other_property', false],
    ['another organization', 'space_other_organization', false],
  ] as const;

  it.each(cases)('get enforces access for %s', async (_label, id, allowed) => {
    const { db } = spacesDb();
    const result = await getFunctionSpace(db, ORG, BRANCH, id);
    if (allowed) expect(result).toMatchObject({ id, branchId: BRANCH, name: validSpace.name });
    else expect(result).toBeNull();
  });

  it.each(cases)('update enforces access for %s', async (_label, id, allowed) => {
    const { db, rows } = spacesDb();
    const before = structuredClone(rows);
    const result = await updateFunctionSpace(
      db,
      ORG,
      BRANCH,
      { ...validSpace, id, name: 'Updated Hall', active: true },
      version
    );
    expect(result).toBe(allowed ? 1 : 0);
    expect(rows).toEqual(
      before.map((row) => (allowed && row.id === id ? { ...row, name: 'Updated Hall' } : row))
    );
  });

  it.each(cases)('retirement enforces access for %s', async (_label, id, allowed) => {
    const { db, rows } = spacesDb();
    const before = structuredClone(rows);
    expect(await setFunctionSpaceActive(db, ORG, BRANCH, id, false, version)).toBe(allowed ? 1 : 0);
    expect(rows).toEqual(
      before.map((row) => (allowed && row.id === id ? { ...row, active: false } : row))
    );
  });

  it('refuses an update and a retirement against a version the editor did not see', async () => {
    const { db, rows } = spacesDb();
    const before = structuredClone(rows);
    const stale = new Date('2026-09-01T00:00:00.000Z');
    expect(
      await updateFunctionSpace(
        db,
        ORG,
        BRANCH,
        { ...validSpace, id: 'space_current', name: 'Stale', active: true },
        stale
      )
    ).toBe(0);
    expect(await setFunctionSpaceActive(db, ORG, BRANCH, 'space_current', false, stale)).toBe(0);
    expect(rows).toEqual(before);
  });
});

describe('stored row to view', () => {
  it('parses the JSONB columns and derives the largest capacity', () => {
    const view = toFunctionSpaceView({
      id: 'space_1',
      branchId: 'branch_1',
      name: 'Crystal Hall',
      nameUr: 'کرسٹل ہال',
      layouts: validSpace.layouts,
      pricing: validSpace.pricing,
      setupMinutes: 90,
      teardownMinutes: 60,
      active: true,
      updatedAt: version,
    });
    expect(view.maxCapacity).toBe(300);
    expect(view.pricing.perFunctionMinor).toBe(25_000_000);
  });

  it('degrades a column written around the CHECK instead of throwing the page away', () => {
    const view = toFunctionSpaceView({
      id: 'space_1',
      branchId: 'branch_1',
      name: 'Crystal Hall',
      nameUr: null,
      layouts: 'not an array',
      pricing: 7,
      setupMinutes: 0,
      teardownMinutes: 0,
      active: false,
      updatedAt: version,
    });
    expect(view.layouts).toEqual([]);
    expect(view.pricing).toEqual({});
    expect(view.maxCapacity).toBe(0);
  });
});

describe('bookings', () => {
  const window = {
    spaceId: 'space_crystal',
    startsAt: '2026-10-01T12:00:00.000Z',
    endsAt: '2026-10-01T16:00:00.000Z',
    label: 'Khan walima — tentative',
  };

  it('claims a tentative hold by default and names both kinds for an operator', () => {
    const parsed = hotelSpaceBookingInput.parse(window);
    expect(parsed.kind).toBe('HOLD');
    expect(parsed.startsAt).toBeInstanceOf(Date);
    expect(hotelSpaceBookingInput.parse({ ...window, kind: 'FUNCTION' }).kind).toBe('FUNCTION');
    expect(HOTEL_SPACE_BOOKING_KIND_LABELS).toEqual({
      HOLD: 'Tentative hold',
      FUNCTION: 'Confirmed function',
    });
  });

  it('refuses a claim that does not end after it starts, runs longer than a week, or has no label', () => {
    expect(() => hotelSpaceBookingInput.parse({ ...window, endsAt: window.startsAt })).toThrow(
      /ends after it starts/i
    );
    expect(() =>
      hotelSpaceBookingInput.parse({
        ...window,
        endsAt: new Date(
          Date.parse(window.startsAt) + (MAX_BOOKING_HOURS + 1) * 3_600_000
        ).toISOString(),
      })
    ).toThrow(/at most 7 days/i);
    expect(() => hotelSpaceBookingInput.parse({ ...window, label: 'x' })).toThrow();
  });

  it('writes a claim in SQL with the property, the space, the actor and the label, and reads the row back', async () => {
    const row = {
      id: 'booking_new',
      spaceId: 'space_crystal',
      kind: 'HOLD' as const,
      startsAt: at(window.startsAt),
      endsAt: at(window.endsAt),
      ref: { label: window.label },
      createdBy: 'user_1',
      createdAt: version,
    };
    const queryRaw = vi.fn(async () => [row]);
    const db = { $queryRaw: queryRaw } as unknown as FunctionSpaceDb;
    const view = await insertSpaceBooking(
      db,
      ORG,
      BRANCH,
      'user_1',
      hotelSpaceBookingInput.parse(window)
    );
    expect(view).toEqual({
      id: 'booking_new',
      spaceId: 'space_crystal',
      kind: 'HOLD',
      startsAt: at(window.startsAt),
      endsAt: at(window.endsAt),
      label: window.label,
      createdBy: 'user_1',
      createdAt: version,
    });
    const [strings, ...values] = queryRaw.mock.calls[0] as unknown as [
      readonly string[],
      ...unknown[],
    ];
    const sql = strings.join('?');
    expect(sql).toContain('INSERT INTO "hotel_space_bookings"');
    expect(sql).toContain('RETURNING');
    expect(sql).not.toContain('bufferedRange');
    expect(values).toEqual([
      ORG,
      BRANCH,
      'space_crystal',
      at(window.startsAt),
      at(window.endsAt),
      'HOLD',
      JSON.stringify({ label: window.label }),
      'user_1',
    ]);
    await expect(
      insertSpaceBooking(
        { $queryRaw: vi.fn(async () => []) } as unknown as FunctionSpaceDb,
        ORG,
        BRANCH,
        'user_1',
        hotelSpaceBookingInput.parse(window)
      )
    ).rejects.toThrow(/returned no row/);
  });

  it('reads a claim another lane wrote without a label as unlabelled', () => {
    expect(
      toSpaceBookingView({
        id: 'b',
        spaceId: 's',
        kind: 'FUNCTION',
        startsAt: version,
        endsAt: version,
        ref: { eventId: 'evt_1' },
        createdBy: null,
        createdAt: version,
      }).label
    ).toBeNull();
  });

  it('releases only a tentative hold of the selected property, scoped by organization, property and id', async () => {
    const deleteMany = vi.fn(async () => ({ count: 1 }));
    const db = { hotelSpaceBooking: { deleteMany } } as unknown as FunctionSpaceDb;
    expect(await releaseSpaceHold(db, ORG, BRANCH, 'booking_1')).toBe(1);
    expect(deleteMany).toHaveBeenCalledWith({
      where: { organizationId: ORG, branchId: BRANCH, id: 'booking_1', kind: 'HOLD' },
    });
  });

  it('lists the diary ahead, scoped and ordered, optionally for one space', async () => {
    const findMany = vi.fn(async () => []);
    const db = { hotelSpaceBooking: { findMany } } as unknown as FunctionSpaceDb;
    const from = at('2026-10-01T00:00:00.000Z');
    await listSpaceBookings(db, ORG, BRANCH, { spaceId: 'space_crystal', from });
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          organizationId: ORG,
          branchId: BRANCH,
          spaceId: 'space_crystal',
          endsAt: { gt: from },
        },
        orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
        take: 200,
      })
    );
    await listSpaceBookings(db, ORG, BRANCH);
    const where = (findMany.mock.calls[1] as unknown as [{ where: Record<string, unknown> }])[0]
      .where;
    expect(where).not.toHaveProperty('spaceId');
    expect((where.endsAt as { gt: Date }).gt).toBeInstanceOf(Date);
  });
});
