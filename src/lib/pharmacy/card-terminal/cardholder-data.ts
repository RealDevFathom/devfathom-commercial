import { CARDHOLDER_PAYLOAD_KEYS } from '@/lib/restaurant/payment-adapter';
import { looksLikeCardNumber } from '../manual-payments';

/**
 * DEV-743: cardholder-data and secret guard for the card-terminal seam.
 *
 * Extends the restaurant C6 key list (one list, not two) and reuses the manual-card number
 * check (DEV-713). Two checks run on everything a terminal returns before it is stored:
 *   1. KEY: a field whose name means PAN, CVV, track, PIN, expiry or a secret is refused.
 *   2. VALUE: any string holding a run of 13 or more digits (a possible card number) is
 *      refused, whatever the field is called.
 * Truncated card data (brand and last four) is allowed.
 */

const TERMINAL_EXTRA_CARD_KEYS = [
  'track3',
  'expiry',
  'expirydate',
  'cardexpiry',
  'expdate',
  'securitycode',
  'cardsecuritycode',
  'cardholdername',
  'emvtlv',
  'iccdata',
] as const;

export const CARDHOLDER_DATA_KEY_LIST: readonly string[] = Object.freeze([
  ...CARDHOLDER_PAYLOAD_KEYS,
  ...TERMINAL_EXTRA_CARD_KEYS,
]);

export const SECRET_KEY_LIST: readonly string[] = Object.freeze([
  'apikey',
  'secret',
  'clientsecret',
  'secretkey',
  'privatekey',
  'password',
  'passphrase',
  'token',
  'accesstoken',
  'refreshtoken',
  'authorization',
  'merchantkey',
  'terminalkey',
  'sessionkey',
  'signingkey',
]);

const CARD_KEYS = new Set(CARDHOLDER_DATA_KEY_LIST);
const SECRET_KEYS = new Set(SECRET_KEY_LIST);

export class CardholderDataError extends Error {
  constructor(readonly reason: 'CARDHOLDER_DATA_FIELD' | 'CARDHOLDER_DATA_VALUE' | 'SECRET_FIELD') {
    super(reason);
    this.name = 'CardholderDataError';
  }
}

const normalizeKey = (key: string) => key.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Throw if the value, at any depth, carries a card-data or secret field or a card number. */
export function assertNoCardholderData(value: unknown): void {
  if (typeof value === 'string') {
    if (looksLikeCardNumber(value)) throw new CardholderDataError('CARDHOLDER_DATA_VALUE');
    return;
  }
  if (Array.isArray(value)) {
    value.forEach(assertNoCardholderData);
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      const normalized = normalizeKey(key);
      if (CARD_KEYS.has(normalized)) throw new CardholderDataError('CARDHOLDER_DATA_FIELD');
      if (SECRET_KEYS.has(normalized)) throw new CardholderDataError('SECRET_FIELD');
      assertNoCardholderData(child);
    }
  }
}

/**
 * A log-safe copy: card-data and secret fields become "[REDACTED]" and digit runs that could be
 * a card number are masked. Never throws, so logging can never break a payment.
 */
export function redactForLog(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[TRUNCATED]';
  if (typeof value === 'string') return value.replace(/\d[\d -]{11,}\d/g, maskRun);
  if (Array.isArray(value)) return value.map((item) => redactForLog(item, depth + 1));
  if (value instanceof Error) return { name: value.name, message: redactForLog(value.message) };
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      const normalized = normalizeKey(key);
      out[key] =
        CARD_KEYS.has(normalized) || SECRET_KEYS.has(normalized)
          ? '[REDACTED]'
          : redactForLog(child, depth + 1);
    }
    return out;
  }
  return value;
}

function maskRun(run: string) {
  return looksLikeCardNumber(run) ? '[REDACTED_PAN]' : run;
}
