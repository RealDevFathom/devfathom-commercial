/**
 * PROP-07 — function spaces, their turnaround buffers, and what a space's time
 * is already spoken for.
 *
 * Four things live here and nowhere else:
 *
 * - the **input contracts** the `hotelProperty.spaces.*` router validates against
 *   — layouts as `[{ layout, capacity }]`, pricing in PKR **minor units**, buffers
 *   in minutes, and a booking window with the hold it claims;
 * - **buffer arithmetic** (`bufferedWindow`), the one place the application widens
 *   a range by a space's setup and teardown;
 * - the **availability read** (`spaceAvailability`), which answers "is this space
 *   free between these two instants" before an operator is told to try; and
 * - the **SQL booking write** (`insertSpaceBooking`). The Prisma client has no
 *   `create` for `HotelSpaceBooking` — its `bufferedRange` is a required
 *   `Unsupported` column that only the database trigger fills — so every claim on
 *   a space's time is an INSERT the database completes and judges.
 *
 * The availability read is an answer, never a guarantee. Invariant 25 is held by
 * the exclusion constraint in `20261021102000_hospitality_function_spaces`, which
 * is the only thing two concurrent bookings both consult. This module mirrors the
 * database's arithmetic so a user is told "the Crystal Hall is busy until 18:30"
 * instead of being handed a constraint violation — and the tests pin that the two
 * agree.
 */
import { z } from 'zod';

import type { Prisma } from '@/generated/prisma/client';
import type { HotelSpaceBookingKind } from '@/generated/prisma/enums';

/** The client every function here accepts: a tenant client or a transaction on one. */
export type FunctionSpaceDb = Prisma.TransactionClient;

/** A day of turnaround is already unusual; the database refuses more. */
export const MAX_BUFFER_MINUTES = 1440;

const MINUTE_MS = 60_000;

export const HOTEL_SPACE_BOOKING_KINDS = [
  'HOLD',
  'FUNCTION',
] as const satisfies readonly HotelSpaceBookingKind[];

/** Operator-facing names. UX rule 1: no surface prints a bare enum value. */
export const HOTEL_SPACE_BOOKING_KIND_LABELS: Record<HotelSpaceBookingKind, string> = {
  HOLD: 'Tentative hold',
  FUNCTION: 'Confirmed function',
};

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

const spaceId = z.string().trim().min(1).max(191);

export const hotelFunctionSpaceUpdateInput = hotelFunctionSpaceCreateInput.extend({
  id: spaceId,
});

export type HotelFunctionSpaceUpdateInput = z.infer<typeof hotelFunctionSpaceUpdateInput>;

export const hotelFunctionSpaceActiveInput = z.object({ spaceId, active: z.boolean() });

/** An instant, however the caller spelled it, refused if it is not a real one. */
const instant = z.coerce.date().refine((value) => Number.isFinite(value.getTime()), {
  message: 'Use a real date and time.',
});

const endsAfterStart = (value: { startsAt: Date; endsAt: Date }) =>
  value.endsAt.getTime() > value.startsAt.getTime();
const endsAfterStartIssue = { path: ['endsAt'], message: 'A booking ends after it starts.' };

export const hotelSpaceWindowInput = z
  .object({ spaceId, startsAt: instant, endsAt: instant })
  .refine(endsAfterStart, endsAfterStartIssue);

export type HotelSpaceWindowInput = z.infer<typeof hotelSpaceWindowInput>;

/** A week is the longest single claim this surface writes; longer is a diary's job. */
export const MAX_BOOKING_HOURS = 24 * 7;

/**
 * A claim on a space's time from the spaces page: a tentative hold by default,
 * or a confirmed function, with the label the diary will show for it.
 */
export const hotelSpaceBookingInput = z
  .object({
    spaceId,
    startsAt: instant,
    endsAt: instant,
    kind: z.enum(HOTEL_SPACE_BOOKING_KINDS).default('HOLD'),
    label: z.string().trim().min(2).max(160),
  })
  .refine(endsAfterStart, endsAfterStartIssue)
  .refine(
    (value) => value.endsAt.getTime() - value.startsAt.getTime() <= MAX_BOOKING_HOURS * 3_600_000,
    {
      path: ['endsAt'],
      message: `A single booking may run for at most ${MAX_BOOKING_HOURS / 24} days.`,
    }
  );

export type HotelSpaceBookingInput = z.infer<typeof hotelSpaceBookingInput>;

export const hotelSpaceBookingReleaseInput = z.object({
  bookingId: z.string().trim().min(1).max(191),
});

export const hotelSpaceBookingListInput = z.object({
  spaceId: spaceId.optional(),
  /** Bookings ending after this instant; defaults to now, so the list is the diary ahead. */
  from: instant.optional(),
});

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
  db: FunctionSpaceDb,
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
  updatedAt: Date;
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
  updatedAt: Date;
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
    updatedAt: row.updatedAt,
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
  updatedAt: true,
} as const;

/** A validated document on its way into JSONB, with nothing `InputJsonValue` cannot carry. */
function json(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

/** Every space of a property, inactive ones included — settings maintains both. */
export async function listFunctionSpaces(
  db: FunctionSpaceDb,
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
  db: FunctionSpaceDb,
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
  db: FunctionSpaceDb,
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
      layouts: json(input.layouts),
      pricing: json(input.pricing),
      setupMinutes: input.setupMinutes,
      teardownMinutes: input.teardownMinutes,
      active: input.active,
    },
    select: SPACE_COLUMNS,
  });
  return toFunctionSpaceView(row);
}

/**
 * Record a space's new facts. Scoped by `(organizationId, branchId, id)` and by
 * the version the editor saw, so a crafted identifier cannot address another
 * property's or tenant's space even if row-level security were ever relaxed for
 * a maintenance connection, and a stale form cannot overwrite a colleague.
 *
 * Narrowing a buffer is free; widening one re-ranges every booking of the space in
 * the same transaction and is refused by the exclusion constraint if that would
 * make two of them collide. That refusal is the point — the alternative is a diary
 * that says a hall is free while the constraint that guards it has gone stale.
 */
export async function updateFunctionSpace(
  db: FunctionSpaceDb,
  organizationId: string,
  branchId: string,
  input: HotelFunctionSpaceUpdateInput,
  expectedUpdatedAt: Date
): Promise<number> {
  const result = await db.hotelFunctionSpace.updateMany({
    where: { organizationId, branchId, id: input.id, updatedAt: expectedUpdatedAt },
    data: {
      name: input.name,
      nameUr: input.nameUr ?? null,
      layouts: json(input.layouts),
      pricing: json(input.pricing),
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
 * foreign key is `ON DELETE RESTRICT` for the same reason. The same call brings a
 * retired space back.
 */
export async function setFunctionSpaceActive(
  db: FunctionSpaceDb,
  organizationId: string,
  branchId: string,
  id: string,
  active: boolean,
  expectedUpdatedAt: Date
): Promise<number> {
  const result = await db.hotelFunctionSpace.updateMany({
    where: { organizationId, branchId, id, updatedAt: expectedUpdatedAt },
    data: { active },
  });
  return result.count;
}

/* ------------------------------------------------------------------ *
 * Bookings
 * ------------------------------------------------------------------ */

/** A claim on a space's time, as the diary and the availability answer read it. */
export interface HotelSpaceBookingView {
  id: string;
  spaceId: string;
  kind: HotelSpaceBookingKind;
  startsAt: Date;
  endsAt: Date;
  /** The label the claim was placed with, or null for a claim another lane wrote. */
  label: string | null;
  createdBy: string | null;
  createdAt: Date;
}

interface HotelSpaceBookingRow {
  id: string;
  spaceId: string;
  kind: HotelSpaceBookingKind;
  startsAt: Date;
  endsAt: Date;
  ref: unknown;
  createdBy: string | null;
  createdAt: Date;
}

export function toSpaceBookingView(row: HotelSpaceBookingRow): HotelSpaceBookingView {
  const label =
    row.ref &&
    typeof row.ref === 'object' &&
    typeof (row.ref as { label?: unknown }).label === 'string'
      ? (row.ref as { label: string }).label
      : null;
  return {
    id: row.id,
    spaceId: row.spaceId,
    kind: row.kind,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    label,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
  };
}

const BOOKING_COLUMNS = {
  id: true,
  spaceId: true,
  kind: true,
  startsAt: true,
  endsAt: true,
  ref: true,
  createdBy: true,
  createdAt: true,
} as const;

/** The diary ahead: every claim of the property (or one space) ending after `from`. */
export async function listSpaceBookings(
  db: FunctionSpaceDb,
  organizationId: string,
  branchId: string,
  options: { spaceId?: string; from?: Date; take?: number } = {}
): Promise<HotelSpaceBookingView[]> {
  const rows = await db.hotelSpaceBooking.findMany({
    where: {
      organizationId,
      branchId,
      ...(options.spaceId ? { spaceId: options.spaceId } : {}),
      endsAt: { gt: options.from ?? new Date() },
    },
    orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
    take: options.take ?? 200,
    select: BOOKING_COLUMNS,
  });
  return rows.map(toSpaceBookingView);
}

/**
 * Write one claim on a space's time. SQL, because the client has no `create`
 * for this model: the database generates the id, the BEFORE trigger fills the
 * buffered range from the space's buffers, and the exclusion constraint judges
 * it — a collision surfaces as SQLSTATE 23P01 for the caller to translate. The
 * row names the property as well as the space, and the property-pinned foreign
 * key refuses a space of any other property.
 */
export async function insertSpaceBooking(
  db: FunctionSpaceDb,
  organizationId: string,
  branchId: string,
  actorId: string,
  input: HotelSpaceBookingInput
): Promise<HotelSpaceBookingView> {
  const rows = await db.$queryRaw<HotelSpaceBookingRow[]>`
    INSERT INTO "hotel_space_bookings" (
      "organizationId", "branchId", "spaceId", "startsAt", "endsAt", "kind", "ref", "createdBy", "updatedAt"
    ) VALUES (
      ${organizationId}, ${branchId}, ${input.spaceId}, ${input.startsAt}, ${input.endsAt},
      ${input.kind}::"HotelSpaceBookingKind", ${JSON.stringify({ label: input.label })}::jsonb, ${actorId}, CURRENT_TIMESTAMP
    )
    RETURNING "id", "spaceId", "kind", "startsAt", "endsAt", "ref", "createdBy", "createdAt"`;
  const row = rows[0];
  if (!row) throw new Error('The booking insert returned no row.');
  return toSpaceBookingView(row);
}

/**
 * Release a tentative hold. Only a HOLD: a confirmed function belongs to the
 * banquet lane's event, and this surface never deletes one. Scoped by
 * `(organizationId, branchId, id)`; returns how many rows went (0 or 1).
 */
export async function releaseSpaceHold(
  db: FunctionSpaceDb,
  organizationId: string,
  branchId: string,
  bookingId: string
): Promise<number> {
  const result = await db.hotelSpaceBooking.deleteMany({
    where: { organizationId, branchId, id: bookingId, kind: 'HOLD' },
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
