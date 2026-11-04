import { describe, expect, it } from 'vitest';

import { CARDHOLDER_PAYLOAD_KEYS } from '@/lib/restaurant/payment-adapter';

import {
  assertNoCardholderData,
  CARDHOLDER_DATA_KEY_LIST,
  CardholderDataError,
  containsPanLikeValue,
  redactForLog,
} from './cardholder-data';

// Public test card numbers (Luhn-valid, never issued to a cardholder).
const TEST_PAN = '4111111111111111';
const TEST_PAN_SPACED = '4111 1111 1111 1111';

describe('card-terminal cardholder-data guard (DEV-743)', () => {
  it('extends the restaurant C6 key list instead of keeping a second one', () => {
    for (const key of CARDHOLDER_PAYLOAD_KEYS) expect(CARDHOLDER_DATA_KEY_LIST).toContain(key);
    expect(CARDHOLDER_DATA_KEY_LIST).toContain('expiry');
    expect(Object.isFrozen(CARDHOLDER_DATA_KEY_LIST)).toBe(true);
    expect(Object.isFrozen(CARDHOLDER_PAYLOAD_KEYS)).toBe(true);
  });

  it('detects Luhn-valid 13–19 digit runs, spaced or dashed', () => {
    expect(containsPanLikeValue(TEST_PAN)).toBe(true);
    expect(containsPanLikeValue(`ref ${TEST_PAN_SPACED} end`)).toBe(true);
    expect(containsPanLikeValue('4111-1111-1111-1111')).toBe(true);
    expect(containsPanLikeValue('4111111111111112')).toBe(false); // fails Luhn
    expect(containsPanLikeValue('123456789012')).toBe(false); // 12 digits (an RRN)
    expect(containsPanLikeValue('2026-11-04T10:00:00.000Z')).toBe(false);
    expect(containsPanLikeValue('pti_sale_abcdefabcdef')).toBe(false);
  });

  it('refuses card fields, secret fields and PAN-shaped values anywhere', () => {
    const reason = (value: unknown) => {
      try {
        assertNoCardholderData(value);
        return null;
      } catch (error) {
        return (error as CardholderDataError).reason;
      }
    };
    expect(reason({ nested: [{ card_number: 'x' }] })).toBe('CARDHOLDER_DATA_FIELD');
    expect(reason({ CVV: '123' })).toBe('CARDHOLDER_DATA_FIELD');
    expect(reason({ expiryDate: '12/30' })).toBe('CARDHOLDER_DATA_FIELD');
    expect(reason({ apiKey: 'k' })).toBe('SECRET_FIELD');
    expect(reason({ note: `customer card ${TEST_PAN_SPACED}` })).toBe('CARDHOLDER_DATA_VALUE');
    expect(reason({ last4: '1111', cardBrand: 'VISA', approvalCode: 'A1B2C3' })).toBeNull();
  });

  it('redacts logs without throwing', () => {
    const redacted = redactForLog({
      intentRef: 'pti_sale_x',
      pan: TEST_PAN,
      authorization: 'Bearer secret',
      message: `declined ${TEST_PAN}`,
      error: new Error(`boom ${TEST_PAN}`),
    });
    const text = JSON.stringify(redacted);
    expect(text).not.toContain('4111111111111111');
    expect(text).not.toContain('Bearer secret');
    expect(redacted).toMatchObject({
      intentRef: 'pti_sale_x',
      pan: '[REDACTED]',
      authorization: '[REDACTED]',
      message: 'declined [REDACTED_PAN]',
    });
  });
});
