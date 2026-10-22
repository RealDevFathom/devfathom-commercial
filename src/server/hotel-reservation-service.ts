import { TRPCError } from '@trpc/server';
import { canonicalRequestHash, quoteStayFromConfiguration, type RatePlan } from '@/lib/hotel/reservations';

export type HotelWriteScope = { organizationId: string; branchId: string };
export type ScopedWhere = HotelWriteScope & { id: string; version?: number };
export interface HotelReservationStore {
  lockProperty(scope: HotelWriteScope): Promise<void>;
  findRatePlan(scope: HotelWriteScope, ratePlanId: string): Promise<RatePlan | null>;
  findReplay(scope: HotelWriteScope, operation: string, key: string): Promise<{ requestHash: string; response: unknown } | null>;
  createReservation(scope: HotelWriteScope, data: Record<string, unknown>, request: { operation: string; key: string; requestHash: string }): Promise<unknown>;
  updateReservation(where: ScopedWhere, data: Record<string, unknown>): Promise<number>;
  appendReservationEvent(scope: HotelWriteScope, data: Record<string, unknown>): Promise<void>;
  appendReversal(scope: HotelWriteScope, data: { originalId: string; reason: string; amountMinor: number }): Promise<void>;
}

export async function createReservation(store: HotelReservationStore, scope: HotelWriteScope, actorId: string, input: { idempotencyKey: string; roomTypeId: string; ratePlanId: string; arrivalDate: string; departureDate: string; [key: string]: unknown }) {
  await store.lockProperty(scope);
  const requestHash = canonicalRequestHash(input);
  const replay = await store.findReplay(scope, 'reservation.create', input.idempotencyKey);
  if (replay) {
    if (replay.requestHash !== requestHash) throw new TRPCError({ code: 'CONFLICT', message: 'That idempotency key was used for a different request.' });
    return replay.response;
  }
  const plan = await store.findRatePlan(scope, input.ratePlanId);
  if (!plan) throw new TRPCError({ code: 'NOT_FOUND', message: 'Rate plan is unavailable.' });
  const quote = quoteStayFromConfiguration(plan, { ...scope, roomTypeId: input.roomTypeId, arrivalDate: input.arrivalDate, departureDate: input.departureDate });
  return store.createReservation(scope, { ...input, ...quote, actorId }, { operation: 'reservation.create', key: input.idempotencyKey, requestHash });
}

/** No generic update/delete exists for snapshots, postings, or settlements. */
export async function reverseRecordedMoney(store: HotelReservationStore, scope: HotelWriteScope, input: { originalId: string; reason: string; amountMinor: number }) {
  if (!input.reason.trim() || input.amountMinor <= 0) throw new TRPCError({ code: 'BAD_REQUEST', message: 'A positive reversal and reason are required.' });
  await store.lockProperty(scope);
  await store.appendReversal(scope, input);
}

export async function assignRoom(store: HotelReservationStore & { findAssignableRoom(scope: HotelWriteScope, roomId: string, stayUnitId: string): Promise<boolean>; appendAssignment(scope: HotelWriteScope, data: Record<string, unknown>): Promise<unknown> }, scope: HotelWriteScope, input: { roomId: string; stayUnitId: string; startDate: string; endDate: string; actorId: string }) {
  await store.lockProperty(scope);
  if (!(await store.findAssignableRoom(scope, input.roomId, input.stayUnitId))) throw new TRPCError({ code: 'CONFLICT', message: 'That room is unavailable or does not match the booked inventory.' });
  return store.appendAssignment(scope, input);
}

export async function releaseAssignment(store: HotelReservationStore & { releaseAssignment(where: ScopedWhere, data: { releasedAt: Date; releaseReason: string }): Promise<number> }, scope: HotelWriteScope, input: { id: string; version?: number; reason: string }) {
  await store.lockProperty(scope);
  const count = await store.releaseAssignment({ ...scope, id: input.id, version: input.version }, { releasedAt: new Date(), releaseReason: input.reason });
  if (count !== 1) throw new TRPCError({ code: 'CONFLICT', message: 'That assignment changed or is outside this property.' });
}
