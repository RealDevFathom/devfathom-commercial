import 'server-only';

import {
  annotateAudit,
  diffChanges,
  toAuditJson,
  type AuditContext,
  type AuditOperationT,
} from '@/server/audit';

/**
 * OPS-01 — the hotel vertical's audit attribution helper.
 *
 * 04's invariant is "every mutation emits an audit event". The platform already
 * emits one: the tRPC middleware writes exactly one `AuditLog` row per procedure
 * call (`recordTrpcAudit`), carrying the actor, the outcome and the path. What it
 * cannot know is WHICH hotel entity the call acted on and WHAT changed.
 *
 * So this helper ENRICHES that row rather than writing a second one. Calling
 * `recordAudit` here instead would leave two rows per mutation — one from the
 * middleware and one from us — and "exactly one audit event per mutation" is the
 * property OPS-01 is asserting. `annotateAudit` is the platform's documented
 * escape hatch for precisely this (`@/server/audit`, "Individual mutations may
 * *enrich* the auto-captured tRPC entry"), and the restaurant vertical's
 * `recordTerminalOperatorAudit` is the sibling precedent for a per-vertical
 * wrapper over the audit core.
 *
 * Consequences other lanes should know:
 *
 *  - the actor is NOT passed in. It is taken from the session by the middleware,
 *    so a caller cannot attribute a mutation to somebody else;
 *  - this is annotation, not I/O. It never awaits, never throws and never
 *    participates in the caller's transaction, so it cannot turn a failed
 *    mutation into a commit or a successful one into a rollback;
 *  - outside a tRPC request (`ctx.audit` absent) it is a no-op, exactly as
 *    `annotateAudit` is.
 *
 * Redaction is the platform's: every before/after value goes through
 * `toAuditJson`, which replaces sensitive-looking keys with `[REDACTED]` and caps
 * oversized strings and arrays. There is no hotel-specific redaction table.
 */

/**
 * The closed set of entity types a hotel audit row may name, and the same set the
 * timeline read API will serve. Default-deny: a type that is not listed here
 * cannot be written under a hotel action and cannot be read back.
 *
 * It lists every hotel entity the merged schema defines: the property itself
 * (`HotelProperty`, keyed by `branchId`), its access and catalog rows, and the
 * H1-03 inventory. A lane that lands a new hotel entity extends this tuple in
 * the same commit as its model — that one line is what admits it to the
 * timeline, and a timeline read derives its input enum from here, so the
 * allowlist and the API can never drift apart.
 */
export const HOTEL_AUDIT_ENTITY_TYPES = [
  'HotelProperty',
  'HotelPropertyAssignment',
  'HotelExtra',
  'HotelRoomType',
  'HotelRoom',
  'HotelBed',
  'HotelRoomStatusEvent',
  'HotelRoomBlock',
  'HotelMealPlan',
  'HotelFunctionSpace',
  'HotelSpaceBooking',
  'HotelJourneyTemplate',
  'HotelGuest',
  'HotelReservation',
  'HotelReservationStayUnit',
  'HotelRoomAssignment',
  'HotelReservationEvent',
  'HotelFolio',
] as const;

export type HotelAuditEntityType = (typeof HOTEL_AUDIT_ENTITY_TYPES)[number];

/** Narrowing guard for a caller holding an unvalidated string. */
export function isHotelAuditEntityType(value: string): value is HotelAuditEntityType {
  return (HOTEL_AUDIT_ENTITY_TYPES as readonly string[]).includes(value);
}

/** The audit `category` hotel rows are filed under. */
export const HOTEL_AUDIT_CATEGORY = 'HOTEL';

/** The entity a hotel mutation acted on. */
export interface HotelAuditEntity {
  type: HotelAuditEntityType;
  /** The entity's own primary key — for a property, its `branchId`. */
  id: string;
  /** Human-readable snapshot (a property name), for reading the trail later. */
  label?: string | null;
}

export interface HotelAuditEntry {
  entity: HotelAuditEntity;
  /** Dotted action name, e.g. `hotel.property.update`. */
  action: string;
  operation?: AuditOperationT;
  /** State before the mutation. Absent/null for a create. */
  before?: Record<string, unknown> | null;
  /** State after the mutation. Absent/null for a delete. */
  after?: Record<string, unknown> | null;
  /**
   * Restrict the diff to these fields. Defaults to every key present on either
   * side, so a caller that passes whole rows still gets a complete diff.
   */
  fields?: string[];
  /** Extra structured context merged into the row's metadata (no secrets). */
  metadata?: Record<string, unknown>;
}

/**
 * Field-level before -> after for the three shapes a mutation can have.
 *
 * `diffChanges` is the platform differ and handles the update case (both sides
 * present), returning null when nothing actually changed. It returns null for a
 * create or a delete too — by design, since there is nothing to compare — but an
 * audit trail still has to show WHAT was created or destroyed, so those two cases
 * are projected against an absent side here.
 *
 * The assembled map is then passed through `toAuditJson` WHOLE, which is the one
 * thing that makes redaction work: the redactor decides by KEY, so handing it a
 * bare field value (`'sek_live_…'`) tells it nothing, while handing it the map
 * puts the field name (`bookingEngineSecret`) in front of it. `recordTrpcAudit`
 * redacts `detail.changes` this same way before the row is written; doing it here
 * too keeps a secret out of the in-memory detail bag as well, and costs one pass
 * over a small object.
 */
function changesFor(
  entry: HotelAuditEntry
): Record<string, { before: unknown; after: unknown }> | null {
  const { before, after } = entry;
  const fields = entry.fields ?? [
    ...new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]),
  ];
  if (!fields.length) return null;

  const changes: Record<string, { before: unknown; after: unknown }> | null =
    before && after ? diffChanges(before, after, fields) : projectOneSided(before, after, fields);
  if (!changes) return null;

  return toAuditJson(changes) as Record<string, { before: unknown; after: unknown }>;
}

/** A create (no `before`) or a delete (no `after`), projected against the absent side. */
function projectOneSided(
  before: Record<string, unknown> | null | undefined,
  after: Record<string, unknown> | null | undefined,
  fields: string[]
): Record<string, { before: unknown; after: unknown }> | null {
  const one = before ?? after;
  if (!one) return null;
  const isBefore = Boolean(before);

  const changes: Record<string, { before: unknown; after: unknown }> = {};
  for (const field of fields) {
    if (!(field in one)) continue;
    const value = one[field];
    changes[field] = isBefore ? { before: value, after: null } : { before: null, after: value };
  }
  return Object.keys(changes).length ? changes : null;
}

/**
 * Attribute the current hotel mutation to an entity and record what changed.
 *
 * Call it inside the mutation, after the write, with the rows either side:
 *
 *   recordHotelAudit(ctx, {
 *     entity: { type: 'HotelProperty', id: property.branchId, label: property.name },
 *     action: 'hotel.property.update',
 *     operation: 'UPDATE',
 *     before: property,
 *     after: updated,
 *   });
 */
export function recordHotelAudit(ctx: AuditContext, entry: HotelAuditEntry): void {
  annotateAudit(ctx, {
    category: HOTEL_AUDIT_CATEGORY,
    action: entry.action,
    operation: entry.operation ?? 'UPDATE',
    targetType: entry.entity.type,
    targetId: entry.entity.id,
    ...(entry.entity.label != null ? { targetLabel: entry.entity.label } : {}),
    changes: changesFor(entry),
    ...(entry.metadata ? { metadata: toAuditJson(entry.metadata) as Record<string, unknown> } : {}),
  });
}
