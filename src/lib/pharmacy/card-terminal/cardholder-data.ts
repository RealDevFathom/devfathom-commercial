import 'server-only';

import { CARDHOLDER_PAYLOAD_KEYS } from '@/lib/restaurant/payment-adapter';

/**
 * DEV-743 — cardholder-data and secret guard for the pharmacy card-terminal seam.
 *
 * Extends the restaurant C6 key list (one list, not two). Two checks run on everything
 * the seam persists or logs:
 *   1. KEY check: a field whose name means PAN/CVV/track/PIN/expiry is refused.
 *   2. VALUE check: any string carrying a 13–19 digit run that passes the Luhn check is
 *      refused, whatever the field is called. A terminal reference, approval code or
 *      operator note can never smuggle a full card number into storage or logs.
 * Truncated card data (brand and last four) is allowed: it is not cardholder data
 * under PCI DSS and the counter needs it for receipts and disputes.
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

/** Frozen lists. The lookup Sets below are private so no module can change them. */
export const CARDHOLDER_DATA_KEY_LIST: readonly string[] = Object.freeze([
  ...CARDHOLDER_PAYLOAD_KEYS,
  ...TERMINAL_EXTRA_CARD_KEYS,
]);

/** Field names that hold provider or device secrets. Redacted from logs, refused in
 * persisted terminal records. */
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

const CARDHOLDER_DATA_KEYS = new Set(CARDHOLDER_DATA_KEY_LIST);
const SECRET_KEYS = new Set(SECRET_KEY_LIST);

export class CardholderDataError extends Error {
  constructor(
    message: string,
    readonly reason: 'CARDHOLDER_DATA_FIELD' | 'CARDHOLDER_DATA_VALUE' | 'SECRET_FIELD'
  ) {
    super(message);
    this.name = 'CardholderDataError';
  }
}

function normalizeKey(rawKey: string) {
  return rawKey.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function luhnValid(digits: string) {
  let sum = 0;
  let double = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let digit = digits.charCodeAt(index) - 48;
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}

/** Digit runs of 13–19 digits, allowing single spaces or dashes between groups. */
const DIGIT_RUN = /\d(?:[ -]?\d){12,18}/g;

/** True when the string contains something shaped like a full card number. */
export function containsPanLikeValue(value: string): boolean {
  for (const match of value.matchAll(DIGIT_RUN)) {
    const digits = match[0].replace(/[ -]/g, '');
    if (digits.length >= 13 && digits.length <= 19 && luhnValid(digits)) return true;
  }
  return false;
}

function maskPanLikeValues(value: string) {
  return value.replace(DIGIT_RUN, (run) => {
    const digits = run.replace(/[ -]/g, '');
    return digits.length >= 13 && digits.length <= 19 && luhnValid(digits) ? '[REDACTED_PAN]' : run;
  });
}

/**
 * Throw if the value (recursively) carries cardholder data or a secret-named field.
 * Use before persisting any terminal record or provider payload.
 */
export function assertNoCardholderData(value: unknown, path = '$'): void {
  if (typeof value === 'string') {
    if (containsPanLikeValue(value))
      throw new CardholderDataError(
        `A card-terminal value at ${path} looks like a full card number.`,
        'CARDHOLDER_DATA_VALUE'
      );
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoCardholderData(item, `${path}[${index}]`));
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [rawKey, child] of Object.entries(value)) {
      const key = normalizeKey(rawKey);
      if (CARDHOLDER_DATA_KEYS.has(key))
        throw new CardholderDataError(
          `A card-terminal record may never carry the field "${rawKey}".`,
          'CARDHOLDER_DATA_FIELD'
        );
      if (SECRET_KEYS.has(key))
        throw new CardholderDataError(
          `A card-terminal record may never carry the secret field "${rawKey}".`,
          'SECRET_FIELD'
        );
      assertNoCardholderData(child, `${path}.${rawKey}`);
    }
  }
}

/**
 * Deep-copy a value for logging: cardholder and secret fields become "[REDACTED]" and
 * PAN-shaped strings are masked. Never throws, so a log call cannot break a payment.
 */
export function redactForLog(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[TRUNCATED]';
  if (typeof value === 'string') return maskPanLikeValues(value);
  if (Array.isArray(value)) return value.map((item) => redactForLog(item, depth + 1));
  if (value instanceof Error)
    return { name: value.name, message: maskPanLikeValues(value.message) };
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [rawKey, child] of Object.entries(value)) {
      const key = normalizeKey(rawKey);
      out[rawKey] =
        CARDHOLDER_DATA_KEYS.has(key) || SECRET_KEYS.has(key)
          ? '[REDACTED]'
          : redactForLog(child, depth + 1);
    }
    return out;
  }
  return value;
}
