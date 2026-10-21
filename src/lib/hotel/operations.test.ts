import { describe, expect, it } from 'vitest';
import {
  HOTEL_MVP_CAPABILITY_AUTHORITY,
  HOTEL_RESERVATION_STATUSES,
  assertHotelDateRange,
  assertMinorAmount,
  canTransitionHotelReservation,
  classifyHotelIdempotency,
  formatHotelSequence,
  reconcileHotelFolio,
  sanitizeHotelPaymentMetadata,
} from './operations';
import { HOSPITALITY_CAPABILITIES, HOSPITALITY_ROLE_TEMPLATES } from '../vertical-catalog';

describe('hotel operation contracts', () => {
  it('allows only lifecycle edges and never reopens terminal reservations', () => {
    expect(canTransitionHotelReservation('HOLD', 'CONFIRMED')).toBe(true);
    expect(canTransitionHotelReservation('CONFIRMED', 'CHECKED_IN')).toBe(true);
    expect(canTransitionHotelReservation('CHECKED_IN', 'CHECKED_OUT')).toBe(true);
    for (const terminal of ['CHECKED_OUT', 'CANCELLED', 'NO_SHOW'] as const) {
      for (const target of HOTEL_RESERVATION_STATUSES) expect(canTransitionHotelReservation(terminal, target)).toBe(false);
    }
    expect(canTransitionHotelReservation('HOLD', 'CHECKED_IN')).toBe(false);
  });

  it('treats dates as ordered hotel-local calendar strings', () => {
    expect(() => assertHotelDateRange('2026-10-21', '2026-10-22')).not.toThrow();
    expect(() => assertHotelDateRange('2026-10-21T00:00:00Z', '2026-10-22')).toThrow(RangeError);
    expect(() => assertHotelDateRange('2026-10-21', '2026-10-21')).toThrow(RangeError);
  });

  it('requires safe integer minor units and reconciles the append-only ledger', () => {
    expect(() => assertMinorAmount(10.5)).toThrow(RangeError);
    expect(reconcileHotelFolio(
      [{ totalMinor: 18_000 }, { totalMinor: 2_000 }, { totalMinor: -1_000 }],
      [{ direction: 'COLLECTION', amountMinor: 10_000 }, { direction: 'REFUND', amountMinor: 500 }],
    )).toBe(9_500);
  });

  it('distinguishes a new key, exact replay, and conflicting payload', () => {
    expect(classifyHotelIdempotency(undefined, 'hash-a')).toBe('NEW');
    expect(classifyHotelIdempotency('hash-a', 'hash-a')).toBe('REPLAY');
    expect(classifyHotelIdempotency('hash-a', 'hash-b')).toBe('CONFLICT');
  });

  it('formats business-year sequences and strips card secrets', () => {
    expect(formatHotelSequence('RSV', '2026-10-21', 42)).toBe('RSV-2026-000042');
    expect(formatHotelSequence('HRC', '2026-10-21', 7)).toBe('HRC-2026-000007');
    expect(sanitizeHotelPaymentMetadata({ providerReference: 'ok', pan: '4111', CVV: '123' }))
      .toEqual({ providerReference: 'ok' });
  });

  it('uses only canonical capabilities and preserves the MVP role grants', () => {
    expect(Object.keys(HOTEL_MVP_CAPABILITY_AUTHORITY).every((capability) =>
      HOSPITALITY_CAPABILITIES.includes(capability))).toBe(true);
    const roles = Object.fromEntries(HOSPITALITY_ROLE_TEMPLATES.map((role) => [role.key, role.capabilities]));
    expect(roles['front-desk-agent']).toEqual([
      'hotel:reservations', 'hotel:front-desk', 'hotel:folio', 'hotel:payments', 'hotel:guest-identity',
    ]);
    expect(roles['reservations-agent']).toEqual(['hotel:reservations']);
    expect(roles['night-auditor']).toEqual([
      'hotel:front-desk', 'hotel:folio', 'hotel:folio-adjust', 'hotel:payments',
      'hotel:night-audit', 'hotel:reports-financial',
    ]);
    expect(roles['housekeeping-supervisor']).toEqual(['hotel:folio', 'hotel:housekeeping']);
    expect(roles.housekeeper).toEqual(['hotel:housekeeping']);
    expect(roles['accounts-ar']).toEqual([
      'hotel:folio', 'hotel:payments', 'hotel:refunds', 'hotel:reports-financial',
    ]);
    expect(roles['read-only-auditor']).toEqual([]);
  });
});
