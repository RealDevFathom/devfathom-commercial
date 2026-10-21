/** Pure Hotel MVP contracts shared by persistence, commands, and clients. */
export const HOTEL_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
export const HOTEL_CURRENCY_PATTERN = /^[A-Z]{3}$/;

export const HOTEL_RESERVATION_STATUSES = [
  'HOLD', 'CONFIRMED', 'CHECKED_IN', 'CHECKED_OUT', 'CANCELLED', 'NO_SHOW',
] as const;
export type HotelReservationStatus = (typeof HOTEL_RESERVATION_STATUSES)[number];

export const HOTEL_RESERVATION_SOURCES = ['WALK_IN', 'PHONE', 'EMAIL', 'DIRECT'] as const;
export const HOTEL_ROOM_ASSIGNMENT_STATUSES = ['HELD', 'ACTIVE', 'RELEASED'] as const;
export const HOTEL_NIGHT_AUDIT_STEPS = [
  'PRECHECK', 'NO_SHOWS', 'ROOM_POSTINGS', 'BALANCES', 'ADVANCE_DATE',
] as const;

/** Phase-0 authority labels; capability strings remain owned by vertical-catalog. */
export const HOTEL_MVP_CAPABILITY_AUTHORITY = {
  'hotel:reservations': 'reservations',
  'hotel:front-desk': 'front-desk',
  'hotel:folio': 'folio-read-and-catalog-posting',
  'hotel:folio-adjust': 'folio-adjustment-and-reversal',
  'hotel:payments': 'collection-and-receipts',
  'hotel:refunds': 'settled-payment-refunds',
  'hotel:housekeeping': 'housekeeping-status',
  'hotel:night-audit': 'night-audit',
  'hotel:reports-financial': 'financial-reports',
  'hotel:property-admin': 'property-configuration',
} as const;

/** Terminal states intentionally have no outgoing edge. */
export const HOTEL_RESERVATION_TRANSITIONS: Readonly<Record<HotelReservationStatus, readonly HotelReservationStatus[]>> = {
  HOLD: ['CONFIRMED', 'CANCELLED', 'NO_SHOW'],
  CONFIRMED: ['CHECKED_IN', 'CANCELLED', 'NO_SHOW'],
  CHECKED_IN: ['CHECKED_OUT'],
  CHECKED_OUT: [],
  CANCELLED: [],
  NO_SHOW: [],
};

export function canTransitionHotelReservation(from: HotelReservationStatus, to: HotelReservationStatus): boolean {
  return HOTEL_RESERVATION_TRANSITIONS[from].includes(to);
}

export function assertHotelDateRange(arrivalDate: string, departureDate: string): void {
  if (!HOTEL_DATE_PATTERN.test(arrivalDate) || !HOTEL_DATE_PATTERN.test(departureDate) || arrivalDate >= departureDate) {
    throw new RangeError('Hotel stay must use valid local YYYY-MM-DD dates with departure after arrival');
  }
}

export function assertMinorAmount(value: number, options: { allowNegative?: boolean } = {}): number {
  if (!Number.isSafeInteger(value) || (!options.allowNegative && value < 0)) {
    throw new RangeError('Hotel money must be a safe integer number of minor currency units');
  }
  return value;
}

export interface HotelLedgerPosting { totalMinor: number }
export interface HotelLedgerPayment { direction: 'COLLECTION' | 'REFUND'; amountMinor: number }

/** Positive is owed by the guest; no stored balance is authoritative. */
export function reconcileHotelFolio(
  postings: readonly HotelLedgerPosting[],
  payments: readonly HotelLedgerPayment[],
): number {
  const balance = postings.reduce((sum, row) => sum + assertMinorAmount(row.totalMinor, { allowNegative: true }), 0)
    + payments.reduce((sum, row) => sum + (row.direction === 'REFUND' ? row.amountMinor : -row.amountMinor), 0);
  return assertMinorAmount(balance, { allowNegative: true });
}

export type HotelIdempotencyDecision = 'NEW' | 'REPLAY' | 'CONFLICT';
export function classifyHotelIdempotency(existingHash: string | undefined, requestHash: string): HotelIdempotencyDecision {
  if (!existingHash) return 'NEW';
  return existingHash === requestHash ? 'REPLAY' : 'CONFLICT';
}

export function formatHotelSequence(prefix: 'RSV' | 'HRC', businessDate: string, number: number): string {
  if (!HOTEL_DATE_PATTERN.test(businessDate) || !Number.isSafeInteger(number) || number < 1 || number > 999999) {
    throw new RangeError('Invalid hotel sequence input');
  }
  return `${prefix}-${businessDate.slice(0, 4)}-${String(number).padStart(6, '0')}`;
}

/** Provider metadata is evidence, never a place for cardholder secrets. */
const FORBIDDEN_PAYMENT_KEYS = /^(pan|cardNumber|cvv|cvc|pin|track[12]?|magstripe)$/i;
export function sanitizeHotelPaymentMetadata(value: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([key]) => !FORBIDDEN_PAYMENT_KEYS.test(key)));
}
