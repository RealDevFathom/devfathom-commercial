/**
 * The property context every `hotelProperty.*` sub-router resolves before it
 * reads or writes anything: which property the caller selected, whether this
 * session may act on it, and the lock that serializes writes to it.
 *
 * Extracted from `routers/hotel-property.ts` (where the extras catalog and the
 * mode settings use it) so the inventory, meal-plan, function-space and
 * journey routers can mount beside it without each re-stating the selection,
 * scope and locking rules — three copies of "lock, then re-check access, then
 * write" would be three places for the order to drift.
 *
 * Nothing here is a grant. {@link requireHotelPropertyScope} is called again
 * for every operation; a resolved property is a fact about this request and is
 * never cached, stored or handed to the client as a token.
 */
import { TRPCError } from '@trpc/server';

import type { HotelProperty, Prisma } from '@/generated/prisma/client';
import { requireHotelPropertyScope } from '@/server/hotel-property-scope';
import type { TRPCContext } from '@/server/trpc';

export type PropertyContext = Omit<TRPCContext, 'db'> & { db: Prisma.TransactionClient };

/** A `hotel:*` ABAC action, as `requireHotelPropertyScope` accepts it. */
export type HotelCapability = Parameters<typeof requireHotelPropertyScope>[2];

/**
 * Resolves the property a locked write may act on, after the lock is held. The
 * default resolver is {@link currentProperty} with `hotel:property-admin`; a
 * router whose procedure admits more than one capability supplies its own.
 */
export type PropertyResolver = (ctx: PropertyContext) => Promise<HotelProperty>;

export function chooseAProperty(): TRPCError {
  return new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Choose a property to continue.' });
}

/** Every consumer must supply a selection; only fresh membership authorizes it. */
export async function currentProperty(
  ctx: PropertyContext,
  branchId?: string,
  capability: HotelCapability = 'hotel:property-admin'
): Promise<HotelProperty> {
  if (!branchId) throw chooseAProperty();
  await requireHotelPropertyScope(ctx, branchId, capability);
  const property = await ctx.db.hotelProperty.findFirst({
    where: { organizationId: ctx.entitlements.organizationId, branchId, active: true },
  });
  if (!property)
    throw new TRPCError({ code: 'FORBIDDEN', message: 'This property is no longer available.' });
  return property;
}

/**
 * Keep property mutation authorization inside the same lock as assignment and
 * lifecycle changes: lock the property row, THEN re-check access, THEN write.
 * The lock query is scoped by organization as well as by the primary key, and
 * RLS applies to it too — it never acquires an unscoped connection.
 */
export async function withLockedProperty<T>(
  ctx: TRPCContext,
  branchId: string | undefined,
  run: (ctx: PropertyContext, property: HotelProperty) => Promise<T>,
  resolve: HotelCapability | PropertyResolver = 'hotel:property-admin'
): Promise<T> {
  if (!branchId) throw chooseAProperty();
  const organizationId = ctx.entitlements.organizationId;
  return ctx.db.$transaction(async (db) => {
    await db.$queryRaw`SELECT "branchId" FROM "hotel_properties"
      WHERE "organizationId" = ${organizationId} AND "branchId" = ${branchId}
      FOR UPDATE`;
    const transactionContext = { ...ctx, db };
    const property =
      typeof resolve === 'function'
        ? await resolve(transactionContext)
        : await currentProperty(transactionContext, branchId, resolve);
    return run(transactionContext, property);
  });
}

export function notProvisioned(): TRPCError {
  return new TRPCError({
    code: 'NOT_FOUND',
    message:
      'This workspace has no property yet. A property is created with the workspace, so ask your DevFathom account manager to re-run provisioning.',
  });
}

/**
 * A validated policy object on its way into a JSONB column. The round-trip drops
 * anything Prisma's `InputJsonValue` cannot carry (undefined members, prototypes)
 * rather than asserting the shape and hoping.
 */
export function inputJson(value: Record<string, unknown>): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

/**
 * A constraint Prisma does not model arrives as a generic error carrying the
 * driver's SQLSTATE somewhere beneath it — for the pg driver adapter, at
 * `meta.driverAdapterError.cause.originalCode` (the same chain
 * `src/app/api/ready/route.ts` reads). The nesting has changed with Prisma
 * versions before, so this walks the chain rather than naming one path;
 * `restaurant-shifts.errors.ts` does the same for the roster's own exclusion
 * constraint, and the verticals keep their own copy rather than sharing a
 * restaurant module.
 */
/**
 * The columns and constraint name a Prisma unique violation reports. The query
 * engine fills `meta.target`; the pg driver adapter instead fills
 * `meta.driverAdapterError.cause.constraint` with `fields` (quoted identifiers,
 * `"organizationId"`) or `index`. On a table with row-level security Postgres
 * withholds the key detail those fields are parsed from, so the adapter sends
 * no constraint at all and only `originalMessage` ("duplicate key value
 * violates unique constraint "…_key"") names it; that is read too. Names are
 * unquoted and de-duplicated, and an error carrying none yields an empty list.
 */
export function uniqueViolationColumns(error: { meta?: Record<string, unknown> }): string[] {
  const names: string[] = [];
  const collect = (value: unknown) => {
    if (typeof value === 'string') names.push(value);
    else if (Array.isArray(value)) {
      for (const entry of value) if (typeof entry === 'string') names.push(entry);
    }
  };
  collect(error.meta?.target);
  const adapterError = error.meta?.driverAdapterError;
  if (adapterError && typeof adapterError === 'object') {
    const cause = (adapterError as { cause?: unknown }).cause;
    if (cause && typeof cause === 'object') {
      const { constraint, originalMessage } = cause as {
        constraint?: unknown;
        originalMessage?: unknown;
      };
      if (constraint && typeof constraint === 'object') {
        collect((constraint as { fields?: unknown }).fields);
        collect((constraint as { index?: unknown }).index);
      }
      if (typeof originalMessage === 'string') {
        collect(originalMessage.match(/unique constraint "([^"]+)"/)?.[1]);
      }
    }
  }
  return [...new Set(names.map((name) => name.replace(/^"(.*)"$/, '$1')))];
}

export function hasSqlState(error: unknown, sqlState: string, seen = new Set<unknown>()): boolean {
  if (typeof error === 'string') return error.includes(sqlState);
  if (!error || typeof error !== 'object' || seen.has(error)) return false;
  seen.add(error);
  const record = error as Record<string, unknown>;
  if (
    record.code === sqlState ||
    record.sqlState === sqlState ||
    record.originalCode === sqlState
  ) {
    return true;
  }
  return [
    'cause',
    'originalError',
    'driverError',
    'driverAdapterError',
    'meta',
    'database_error',
  ].some((key) => hasSqlState(record[key], sqlState, seen));
}
