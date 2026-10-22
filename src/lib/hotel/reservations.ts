import { createHash } from 'node:crypto';
import { z } from 'zod';
import { computeRoomNightTax, type HotelTaxProfileInput } from './tax';

export const HOTEL_RESERVATION_TRANSITIONS = {
  HOLD: ['CONFIRMED', 'CANCELLED'],
  CONFIRMED: ['CHECKED_IN', 'CANCELLED', 'NO_SHOW'],
  CHECKED_IN: ['CHECKED_OUT'],
  CHECKED_OUT: [], CANCELLED: [], NO_SHOW: [],
} as const;
export type ReservationStatus = keyof typeof HOTEL_RESERVATION_TRANSITIONS;

const hotelDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD.');
const forbiddenMoneyKeys = new Set([
  'nightlyRateMinor','netMinor','taxMinor','totalMinor','balanceMinor','amountMinor','currency',
]);

/** Strict by design: a browser identifies configuration; it never authors money. */
export const reservationCreateInput = z.object({
  branchId: z.string().trim().min(1),
  idempotencyKey: z.string().trim().min(8).max(128),
  source: z.enum(['WALK_IN', 'PHONE', 'EMAIL', 'DIRECT']),
  arrivalDate: hotelDate,
  departureDate: hotelDate,
  roomTypeId: z.string().trim().min(1),
  ratePlanId: z.string().trim().min(1),
  mealPlanId: z.string().trim().min(1).optional(),
  adults: z.number().int().positive(), children: z.number().int().min(0).default(0),
  guest: z.object({ firstName: z.string().trim().min(1), lastName: z.string().trim().min(1), email: z.string().email().optional(), phone: z.string().trim().min(3).optional() }).strict(),
  specialRequests: z.string().trim().max(2000).optional(),
}).strict().superRefine((value, context) => {
  if (value.departureDate <= value.arrivalDate) context.addIssue({ code: 'custom', path: ['departureDate'], message: 'Departure must follow arrival.' });
});

export function rejectClientMoney(input: Record<string, unknown>) {
  for (const key of Object.keys(input)) if (forbiddenMoneyKeys.has(key)) throw new Error(`Client-authored money field is forbidden: ${key}`);
}

export function stayDates(arrival: string, departure: string): string[] {
  hotelDate.parse(arrival); hotelDate.parse(departure);
  if (departure <= arrival) throw new RangeError('Departure must follow arrival.');
  const dates: string[] = [];
  for (let day = new Date(`${arrival}T00:00:00Z`); day < new Date(`${departure}T00:00:00Z`); day.setUTCDate(day.getUTCDate() + 1)) dates.push(day.toISOString().slice(0, 10));
  return dates;
}

export function assertTransition(from: ReservationStatus, to: ReservationStatus) {
  if (!(HOTEL_RESERVATION_TRANSITIONS[from] as readonly string[]).includes(to)) throw new Error(`Reservation cannot transition from ${from} to ${to}.`);
}

export type AvailabilityFacts = { rooms: { id: string; roomTypeId: string; active: boolean }[]; consuming: { roomTypeId: string; arrivalDate: string; departureDate: string; quantity: number }[]; blocks: { roomId: string; startDate: string; endDate: string }[] };
export function calculateAvailability(facts: AvailabilityFacts, arrivalDate: string, departureDate: string) {
  const dates = stayDates(arrivalDate, departureDate);
  const overlaps = (start: string, end: string, date: string) => start <= date && date < end;
  const types = new Set(facts.rooms.map((room) => room.roomTypeId));
  return dates.flatMap((date) => [...types].sort().map((roomTypeId) => {
    const supply = facts.rooms.filter((r) => r.active && r.roomTypeId === roomTypeId && !facts.blocks.some((b) => b.roomId === r.id && overlaps(b.startDate, b.endDate, date))).length;
    const demand = facts.consuming.filter((s) => s.roomTypeId === roomTypeId && overlaps(s.arrivalDate, s.departureDate, date)).reduce((n, s) => n + s.quantity, 0);
    return { date, roomTypeId, supply, demand, available: Math.max(0, supply - demand) };
  }));
}

export type RatePlan = { id: string; organizationId: string; branchId: string; roomTypeId: string; nightlyRateMinor: number; currency: string; taxConfig: HotelTaxProfileInput; active: boolean; validFrom: string; validTo: string | null };
export function quoteStayFromConfiguration(plan: RatePlan, scope: { organizationId: string; branchId: string; roomTypeId: string; arrivalDate: string; departureDate: string }) {
  if (!plan.active || plan.organizationId !== scope.organizationId || plan.branchId !== scope.branchId || plan.roomTypeId !== scope.roomTypeId || plan.validFrom > scope.arrivalDate || (plan.validTo && plan.validTo < scope.departureDate)) throw new Error('Rate plan is unavailable for this property, room type, or stay.');
  const tax = computeRoomNightTax(plan.taxConfig, plan.nightlyRateMinor);
  return { nightlyRateMinor: plan.nightlyRateMinor, netMinorPerNight: tax.netMinor, taxMinorPerNight: tax.taxMinor, totalMinorPerNight: tax.grossMinor, taxSnapshot: plan.taxConfig, currency: plan.currency, nights: stayDates(scope.arrivalDate, scope.departureDate).length };
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a],[b]) => a.localeCompare(b)).map(([key, child]) => [key, canonical(child)]));
  return value;
}
export function canonicalRequestHash(value: unknown) { return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex'); }
