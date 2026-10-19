/**
 * PROP-07 — function spaces, their turnaround buffers, and what a space's time
 * is already spoken for.
 *
 * Three things live here and nowhere else:
 *
 * - the **input contracts** the `hotelProperty.spaces.*` router validates against
 *   — layouts as `[{ layout, capacity }]`, pricing in PKR **minor units**, buffers
 *   in minutes;
 * - **buffer arithmetic** (`bufferedWindow`), the one place the application widens
 *   a range by a space's setup and teardown; and
 * - the **availability read** (`spaceAvailability`), which answers "is this space
 *   free between these two instants" before an operator is told to try.
 *
 * The availability read is an answer, never a guarantee. Invariant 25 is held by
 * the exclusion constraint in `20260908140000_hospitality_function_spaces`, which
 * is the only thing two concurrent bookings both consult. This module mirrors the
 * database's arithmetic so a user is told "the Crystal Hall is busy until 18:30"
 * instead of being handed a constraint violation — and the tests pin that the two
 * agree.
 */
import { z } from 'zod';

import type { HotelSpaceBookingKind } from '@/generated/prisma/enums';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

/** A day of turnaround is already unusual; the database refuses more. */
export const MAX_BUFFER_MINUTES = 1440;

const MINUTE_MS = 60_000;

/**
 * The layouts a hall can be set in. Free text rather than an enum: "theatre",
 * "cabaret" and "baraat seating" are the operator's vocabulary, not ours, and the
 * pack lists no closed set.
 */
export const hotelFunctionSpaceLayout = z.object({
  layout: z.string().trim().min(1).max(60),
  capacity: z.coerce.number().int().min(1).max(100_000),
});

export type HotelFunctionSpaceLayout = z.infer<typeof hotelFunctionSpaceLayout>;

/** PKR minor units. No decimal ever reaches a money column in this vertical. */
const minorAmount = z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

/**
 * PROP-07 pricing: "hourly/daily/per-function". Every member is optional because a
 * lawn may only ever be sold per function, and `minimumSpendMinor` is here because
 * banquet spaces in this market are sold against one (PRD §5.20 / 05 §1.7).
 */
export const hotelFunctionSpacePricing = z
  .object({
    hourlyMinor: minorAmount.optional(),
    dailyMinor: minorAmount.optional(),
    perFunctionMinor: minorAmount.optional(),
    minimumSpendMinor: minorAmount.optional(),
  })
  .strict();

export type HotelFunctionSpacePricing = z.infer<typeof hotelFunctionSpacePricing>;

const bufferMinutes = z.coerce.number().int().min(0).max(MAX_BUFFER_MINUTES);

const spaceName = z.string().trim().min(2).max(160);

export const hotelFunctionSpaceCreateInput = z.object({
  name: spaceName,
  /** Bilingual field (05 §1.1). Blank means "not supplied", never an empty name. */
  nameUr: z.string().trim().min(1).max(160).nullable().optional(),
  layouts: z
    .array(hotelFunctionSpaceLayout)
    .min(1, 'A function space needs at least one layout and its capacity.')
    .max(12)
    .superRefine((layouts, ctx) => {
      const seen = new Set<string>();
      for (const [index, entry] of layouts.entries()) {
        const key = entry.layout.toLowerCase();
        if (seen.has(key)) {
          ctx.addIssue({
            code: 'custom',
            path: [index, 'layout'],
            message: 'This layout is already listed for the space.',
          });
        }
        seen.add(key);
      }
    }),
  pricing: hotelFunctionSpacePricing.default({}),
  setupMinutes: bufferMinutes.default(0),
  teardownMinutes: bufferMinutes.default(0),
  active: z.boolean().default(true),
});

export type HotelFunctionSpaceCreateInput = z.infer<typeof hotelFunctionSpaceCreateInput>;

export const hotelFunctionSpaceUpdateInput = hotelFunctionSpaceCreateInput.extend({
  id: z.string().trim().min(1).max(191),
});

export type HotelFunctionSpaceUpdateInput = z.infer<typeof hotelFunctionSpaceUpdateInput>;

/** An instant, however the caller spelled it, refused if it is not a real one. */
const instant = z.coerce.date().refine((value) => Number.isFinite(value.getTime()), {
  message: 'Use a real date and time.',
});

export const hotelSpaceWindowInput = z
  .object({
    spaceId: z.string().trim().min(1).max(191),
    startsAt: instant,
    endsAt: instant,
  })
  .refine((value) => value.endsAt.getTime() > value.startsAt.getTime(), {
    path: ['endsAt'],
    message: 'A booking ends after it starts.',
  });

export type HotelSpaceWindowInput = z.infer<typeof hotelSpaceWindowInput>;

export interface HotelSpaceBuffers {
  setupMinutes: number;
  teardownMinutes: number;
}

export interface HotelSpaceWindow {
  startsAt: Date;
  endsAt: Date;
}

/**
 * The window a booking actually occupies: its own time widened by the space's
 * setup before it and teardown after it. This is the same arithmetic the database
 * trigger performs — `tstzrange(startsAt − setup, endsAt + teardown, '[)')`.
 */
export function bufferedWindow(window: HotelSpaceWindow, buffers: HotelSpaceBuffers) {
  return {
    startsAt: new Date(window.startsAt.getTime() - buffers.setupMinutes * MINUTE_MS),
    endsAt: new Date(window.endsAt.getTime() + buffers.teardownMinutes * MINUTE_MS),
  };
}

/**
 * Do two buffered windows collide? Half-open (`[)`), exactly like the range the
 * exclusion constraint compares: two bookings that merely touch do not overlap, so
 * back-to-back is legal when the buffers are zero and refused as soon as they are
 * not.
 */
export function windowsOverlap(left: HotelSpaceWindow, right: HotelSpaceWindow): boolean {
  return (
    left.startsAt.getTime() < right.endsAt.getTime() &&
    right.startsAt.getTime() < left.endsAt.getTime()
  );
}

export interface HotelSpaceConflict {
  id: string;
  kind: HotelSpaceBookingKind;
  startsAt: Date;
  endsAt: Date;
  /** The booking's time widened by the space's buffers — what actually collides. */
  buffered: HotelSpaceWindow;
}

export interface HotelSpaceAvailability {
  available: boolean;
  /** The candidate window widened by the space's buffers. */
  buffered: HotelSpaceWindow;
  conflicts: HotelSpaceConflict[];
}

/** A space, as this module needs to see it, whoever loaded it. */
export interface HotelSpaceBufferSource extends HotelSpaceBuffers {
  id: string;
  branchId: string;
}

/**
 * Is `space` free for `window`? Answers with the bookings that say otherwise, so a
 * surface can name them rather than say "unavailable".
 *
 * `excludeBookingId` lets a move re-check its own space without colliding with the
 * booking it is moving.
 *
 * Every booking of one space carries the same buffers, so widening both sides of
 * the comparison is equivalent to the database's range overlap — and is what makes
 * a back-to-back pair collide once a buffer exists.
 */
export async function spaceAvailability(
  db: ScopedDb,
  organizationId: string,
  branchId: string,
  space: HotelSpaceBufferSource,
  window: HotelSpaceWindow,
  options: { excludeBookingId?: string } = {}
): Promise<HotelSpaceAvailability> {
  if (space.branchId !== branchId) {
    throw new Error('That function space does not belong to the expected property.');
  }
  const buffered = bufferedWindow(window, space);

  // The candidate is already buffered, so a stored booking can only collide if its
  // own buffered window reaches into it. Widening the query bounds by the same
  // buffers keeps the database doing the narrowing on the `(org, space, startsAt)`
  // index instead of loading a hall's whole diary.
  const searchFrom = new Date(buffered.startsAt.getTime() - space.teardownMinutes * MINUTE_MS);
  const searchTo = new Date(buffered.endsAt.getTime() + space.setupMinutes * MINUTE_MS);

  const candidates = await db.hotelSpaceBooking.findMany({
    where: {
      organizationId,
      branchId,
      spaceId: space.id,
      startsAt: { lt: searchTo },
      endsAt: { gt: searchFrom },
      ...(options.excludeBookingId ? { id: { not: options.excludeBookingId } } : {}),
    },
    orderBy: { startsAt: 'asc' },
    select: { id: true, kind: true, startsAt: true, endsAt: true },
  });

  const conflicts = candidates
    .map((booking) => ({ ...booking, buffered: bufferedWindow(booking, space) }))
    .filter((booking) => windowsOverlap(booking.buffered, buffered));

  return { available: conflicts.length === 0, buffered, conflicts };
}

/* ------------------------------------------------------------------ *
 * CRUD
 *
 * Every statement carries the explicit `organizationId` and server-resolved
 * property's `branchId`. Forced row-level security is the second wall
 * and never the only one — a query that forgot the tenant would still be filtered,
 * but it would also be a bug we never want to rely on the database to hide.
 * ------------------------------------------------------------------ */

/** The row as every surface reads it: JSONB columns parsed, never raw. */
export interface HotelFunctionSpaceView {
  id: string;
  branchId: string;
  name: string;
  nameUr: string | null;
  layouts: HotelFunctionSpaceLayout[];
  pricing: HotelFunctionSpacePricing;
  setupMinutes: number;
  teardownMinutes: number;
  active: boolean;
  /** The largest capacity any layout offers — what a space is searched by. */
  maxCapacity: number;
}

interface HotelFunctionSpaceRow {
  id: string;
  branchId: string;
  name: string;
  nameUr: string | null;
  layouts: unknown;
  pricing: unknown;
  setupMinutes: number;
  teardownMinutes: number;
  active: boolean;
}

/**
 * A stored row on its way to a surface. The database CHECK already refuses a
 * malformed `layouts`, so a parse failure here would mean the column was written
 * around the constraint; the view degrades to an empty list rather than throwing
 * an operator out of the page over a row they cannot fix.
 */
export function toFunctionSpaceView(row: HotelFunctionSpaceRow): HotelFunctionSpaceView {
  const layouts = z.array(hotelFunctionSpaceLayout).safeParse(row.layouts);
  const pricing = hotelFunctionSpacePricing.safeParse(row.pricing);
  const parsedLayouts = layouts.success ? layouts.data : [];
  return {
    id: row.id,
    branchId: row.branchId,
    name: row.name,
    nameUr: row.nameUr,
    layouts: parsedLayouts,
    pricing: pricing.success ? pricing.data : {},
    setupMinutes: row.setupMinutes,
    teardownMinutes: row.teardownMinutes,
    active: row.active,
    maxCapacity: parsedLayouts.reduce((largest, entry) => Math.max(largest, entry.capacity), 0),
  };
}

const SPACE_COLUMNS = {
  id: true,
  branchId: true,
  name: true,
  nameUr: true,
  layouts: true,
  pricing: true,
  setupMinutes: true,
  teardownMinutes: true,
  active: true,
} as const;

/** Every space of a property, inactive ones included — settings maintains both. */
export async function listFunctionSpaces(
  db: ScopedDb,
  organizationId: string,
  branchId: string
): Promise<HotelFunctionSpaceView[]> {
  const rows = await db.hotelFunctionSpace.findMany({
    where: { organizationId, branchId },
    orderBy: [{ active: 'desc' }, { name: 'asc' }],
    select: SPACE_COLUMNS,
  });
  return rows.map(toFunctionSpaceView);
}

export async function getFunctionSpace(
  db: ScopedDb,
  organizationId: string,
  branchId: string,
  id: string
): Promise<HotelFunctionSpaceView | null> {
  const row = await db.hotelFunctionSpace.findFirst({
    where: { organizationId, branchId, id },
    select: SPACE_COLUMNS,
  });
  return row ? toFunctionSpaceView(row) : null;
}

export async function createFunctionSpace(
  db: ScopedDb,
  organizationId: string,
  branchId: string,
  input: HotelFunctionSpaceCreateInput
): Promise<HotelFunctionSpaceView> {
  const row = await db.hotelFunctionSpace.create({
    data: {
      organizationId,
      branchId,
      name: input.name,
      nameUr: input.nameUr ?? null,
      layouts: input.layouts,
      pricing: input.pricing,
      setupMinutes: input.setupMinutes,
      teardownMinutes: input.teardownMinutes,
      active: input.active,
    },
    select: SPACE_COLUMNS,
  });
  return toFunctionSpaceView(row);
}

/**
 * Record a space's new facts. Scoped by `(organizationId, branchId, id)`, so a
 * crafted identifier cannot address another property's or tenant's space even if
 * row-level security were ever relaxed for a maintenance connection.
 *
 * Narrowing a buffer is free; widening one re-ranges every booking of the space in
 * the same transaction and is refused by the exclusion constraint if that would
 * make two of them collide. That refusal is the point — the alternative is a diary
 * that says a hall is free while the constraint that guards it has gone stale.
 */
export async function updateFunctionSpace(
  db: ScopedDb,
  organizationId: string,
  branchId: string,
  input: HotelFunctionSpaceUpdateInput
): Promise<number> {
  const result = await db.hotelFunctionSpace.updateMany({
    where: { organizationId, branchId, id: input.id },
    data: {
      name: input.name,
      nameUr: input.nameUr ?? null,
      layouts: input.layouts,
      pricing: input.pricing,
      setupMinutes: input.setupMinutes,
      teardownMinutes: input.teardownMinutes,
      active: input.active,
    },
  });
  return result.count;
}

/**
 * Spaces are retired, never deleted: a booking references one, and a hall that
 * held last year's weddings still has to be nameable in this year's reports. The
 * foreign key is `ON DELETE RESTRICT` for the same reason.
 */
export async function deactivateFunctionSpace(
  db: ScopedDb,
  organizationId: string,
  branchId: string,
  id: string
): Promise<number> {
  const result = await db.hotelFunctionSpace.updateMany({
    where: { organizationId, branchId, id },
    data: { active: false },
  });
  return result.count;
}

/**
 * One sentence an operator can act on when a space is not free. UX rule 13: a
 * refusal names what is in the way and when the space is next clear.
 */
export function unavailableReason(
  spaceName: string,
  availability: HotelSpaceAvailability,
  formatInstant: (value: Date) => string
): string | null {
  if (availability.available) return null;
  const clearAt = availability.conflicts.reduce(
    (latest, conflict) => (conflict.buffered.endsAt > latest ? conflict.buffered.endsAt : latest),
    availability.conflicts[0]!.buffered.endsAt
  );
  const count = availability.conflicts.length;
  return `${spaceName} is already booked for ${count === 1 ? 'this time' : `${count} of these hours`}. Including setup and teardown it is next free at ${formatInstant(clearAt)}.`;
}
