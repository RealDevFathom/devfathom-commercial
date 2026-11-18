import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { PIN_MAX_LENGTH, PIN_MIN_LENGTH } from '@/lib/restaurant/operator-credentials';
import {
  isNoPinSetMessage,
  isPhoneNumberTail,
  isTriviallyWeakPin,
  NO_PIN_SET_MESSAGE,
  OWN_PIN_MAX_LENGTH,
  OWN_PIN_MIN_LENGTH,
  ownPinProblem,
} from './own-pin-policy';

// DEV-931: the rules a person's own PIN must meet before the server hashes it.
describe('own PIN policy', () => {
  it('explains the same length the operator credential enforces', () => {
    expect(OWN_PIN_MIN_LENGTH).toBe(PIN_MIN_LENGTH);
    expect(OWN_PIN_MAX_LENGTH).toBe(PIN_MAX_LENGTH);
  });

  it.each([
    '0000',
    '1111',
    '99999999',
    '1234',
    '0123',
    '456789',
    '9876',
    '43210',
    '1212',
    '676767',
    '1900',
    '1990',
    '2000',
    '2024',
    '2099',
  ])('refuses the easy PIN %s', (pin) => {
    expect(isTriviallyWeakPin(pin)).toBe(true);
    expect(ownPinProblem(pin, pin)).toBe('That PIN is too easy to guess. Choose a different one.');
  });

  it.each(['2580', '583917', '1357', '90210', '7316', '12340'])('accepts %s', (pin) => {
    expect(isTriviallyWeakPin(pin)).toBe(false);
    expect(ownPinProblem(pin, pin)).toBeNull();
  });

  it.each(['', '123', '123456789', '12a4', ' 5839', '5839 '])(
    'refuses the malformed PIN "%s"',
    (pin) => {
      expect(ownPinProblem(pin, pin)).toBe('Your PIN must be 4 to 8 digits.');
    }
  );

  it.each(['1899', '2100', '1357'])('does not take %s for a year', (pin) => {
    expect(isTriviallyWeakPin(pin)).toBe(false);
  });

  it("refuses the end of the person's own phone number, in any format", () => {
    expect(isPhoneNumberTail('4821', '+92 300 1234821')).toBe(true);
    expect(isPhoneNumberTail('234821', '0300-1234821')).toBe(true);
    expect(isPhoneNumberTail('4821', '+92 300 1234820')).toBe(false);
    expect(isPhoneNumberTail('4821', null)).toBe(false);
    expect(isPhoneNumberTail('4821', '821')).toBe(false);
    expect(ownPinProblem('4821', '4821', { phone: '+92 300 1234821' })).toBe(
      'That PIN is the end of your phone number. Choose a different one.'
    );
    expect(ownPinProblem('4821', '4821', { phone: '+92 300 7654321' })).toBeNull();
  });

  it('refuses two PINs that do not match', () => {
    expect(ownPinProblem('583917', '583918')).toBe('The two PINs do not match.');
  });

  it('recognises only the shared "no PIN set" refusal', () => {
    expect(isNoPinSetMessage(NO_PIN_SET_MESSAGE)).toBe(true);
    expect(isNoPinSetMessage('That PIN is not correct.')).toBe(false);
    expect(isNoPinSetMessage(undefined)).toBe(false);
  });
});
