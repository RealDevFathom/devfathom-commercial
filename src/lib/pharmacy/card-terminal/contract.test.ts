import { afterEach, describe, expect, it, vi } from 'vitest';

import { CARDHOLDER_PAYLOAD_KEYS } from '@/lib/restaurant/payment-adapter';
import {
  assertNoCardholderData,
  CARDHOLDER_DATA_KEY_LIST,
  CardholderDataError,
  redactForLog,
} from './cardholder-data';
import {
  PRODUCTION_TERMINAL_ADMISSION,
  RESERVED_PROVIDER_NAMES,
  terminalAdmissionRefusal,
} from './contract';
import { createFakeTerminal } from './testing/fake-terminal';

const admitted = { admittedProviders: ['FAKE_TERMINAL', 'CERTIFIED_TERMINAL'] };

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('DEV-743 terminal admission', () => {
  it('ships an empty, frozen production admission list', () => {
    expect(PRODUCTION_TERMINAL_ADMISSION.admittedProviders).toEqual([]);
    expect(Object.isFrozen(PRODUCTION_TERMINAL_ADMISSION)).toBe(true);
    expect(Object.isFrozen(PRODUCTION_TERMINAL_ADMISSION.admittedProviders)).toBe(true);
    expect(terminalAdmissionRefusal({ name: 'CERTIFIED_TERMINAL' })).toBe('NOT_ADMITTED');
  });

  it('admits a listed provider outside production only', () => {
    expect(terminalAdmissionRefusal({ name: 'CERTIFIED_TERMINAL' }, admitted, 'test')).toBeNull();
    expect(terminalAdmissionRefusal({ name: 'CERTIFIED_TERMINAL' }, admitted, 'production')).toBe(
      'NOT_ADMITTED'
    );
    vi.stubEnv('NODE_ENV', 'production');
    // A production process ignores whatever list or environment a caller injects.
    expect(terminalAdmissionRefusal({ name: 'CERTIFIED_TERMINAL' }, admitted, 'test')).toBe(
      'NOT_ADMITTED'
    );
  });

  it('refuses reserved, malformed and simulated providers', () => {
    for (const name of RESERVED_PROVIDER_NAMES)
      expect(terminalAdmissionRefusal({ name }, { admittedProviders: [name] }, 'test')).toBe(
        'RESERVED_PROVIDER_NAME'
      );
    expect(terminalAdmissionRefusal({ name: 'mock' }, admitted, 'test')).toBe(
      'INVALID_PROVIDER_NAME'
    );
    expect(
      terminalAdmissionRefusal({ name: 'FAKE_TERMINAL', simulated: true }, admitted, 'production')
    ).toBe('SIMULATED_PROVIDER_IN_PRODUCTION');
  });

  it('never builds the fake terminal in a production process', () => {
    vi.stubEnv('NODE_ENV', 'production');
    expect(() => createFakeTerminal()).toThrow(/never available in production/);
  });
});

describe('DEV-743 cardholder-data guard', () => {
  it('extends the restaurant C6 key list rather than keeping a second one', () => {
    for (const key of CARDHOLDER_PAYLOAD_KEYS) expect(CARDHOLDER_DATA_KEY_LIST).toContain(key);
    expect(CARDHOLDER_DATA_KEY_LIST).toContain('expiry');
    expect(Object.isFrozen(CARDHOLDER_PAYLOAD_KEYS)).toBe(true);
  });

  it.each([
    [{ card_number: '1234' }, 'CARDHOLDER_DATA_FIELD'],
    [{ nested: [{ CVV: '123' }] }, 'CARDHOLDER_DATA_FIELD'],
    [{ expiryDate: '12/30' }, 'CARDHOLDER_DATA_FIELD'],
    [{ apiKey: 'x' }, 'SECRET_FIELD'],
    [{ providerRef: '4111 1111 1111 1111' }, 'CARDHOLDER_DATA_VALUE'],
    [{ note: 'card 5500-0000-0000-0004 ok' }, 'CARDHOLDER_DATA_VALUE'],
  ])('refuses %j', (value, reason) => {
    expect(() => assertNoCardholderData(value)).toThrowError(
      expect.objectContaining({ reason }) as CardholderDataError
    );
  });

  it('allows brand, last four and a 12-digit retrieval reference', () => {
    expect(() =>
      assertNoCardholderData({ cardBrand: 'VISA', cardLast4: '4242', providerRef: '123456789012' })
    ).not.toThrow();
  });

  it('redacts card fields, secrets and card numbers from logs without throwing', () => {
    expect(
      redactForLog({
        pan: '4111111111111111',
        token: 'abc',
        message: 'declined 4111111111111111 at counter-1',
        error: new Error('ref 4111-1111-1111-1111'),
      })
    ).toEqual({
      pan: '[REDACTED]',
      token: '[REDACTED]',
      message: 'declined [REDACTED_PAN] at counter-1',
      error: { name: 'Error', message: 'ref [REDACTED_PAN]' },
    });
  });
});
