import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { PIN_MAX_LENGTH, PIN_MIN_LENGTH } from '@/lib/restaurant/operator-credentials';
import {
  isNoPinSetMessage,
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

  it('refuses two PINs that do not match', () => {
    expect(ownPinProblem('583917', '583918')).toBe('The two PINs do not match.');
  });

  it('recognises only the shared "no PIN set" refusal', () => {
    expect(isNoPinSetMessage(NO_PIN_SET_MESSAGE)).toBe(true);
    expect(isNoPinSetMessage('That PIN is not correct.')).toBe(false);
    expect(isNoPinSetMessage(undefined)).toBe(false);
  });
});
