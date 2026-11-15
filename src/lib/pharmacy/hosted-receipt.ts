import 'server-only';

import { createHash, randomBytes } from 'node:crypto';

import { COUNTER_RECEIPT_STRINGS, formatMinor } from './counter-receipt';
import { containsMedicineName, normalizeNameText } from './medicine-names';

/**
 * DEV-16 — neutral WhatsApp receipt with a tokenized hosted receipt link.
 *
 * The WhatsApp utility template carries only the branch, receipt number, total,
 * payment method and a secure link — never an item. The link token is 160 random
 * bits, only its SHA-256 is stored and it expires after a configured 30-90 days.
 * Owner decision (15 Nov 2026): whoever holds the link sees the whole receipt,
 * every line like paper, with no further check; the token is the only key and
 * it opens that one receipt alone.
 */

export class HostedReceiptError extends Error {
  constructor(
    readonly reason:
      | 'NOT_CONFIGURED'
      | 'LINK_HOST_NOT_CONFIGURED'
      | 'NOT_SETTLED'
      | 'NO_CUSTOMER'
      | 'NO_CONSENT'
      | 'NO_PHONE'
      | 'NOT_NEUTRAL'
  ) {
    super(reason);
    this.name = 'HostedReceiptError';
  }
}

const CROCKFORD = '0123456789abcdefghjkmnpqrstvwxyz';
/** 20 random bytes = 160 bits = 32 Crockford characters, one unbroken word. */
const TOKEN_BYTES = 20;
export const HOSTED_RECEIPT_TOKEN_PATTERN = /^[0-9a-hjkmnp-tv-z]{32}$/;

function crockford(bytes: Buffer): string {
  const bits = Array.from(bytes, (byte) => byte.toString(2).padStart(8, '0')).join('');
  let encoded = '';
  for (let index = 0; index < bits.length; index += 5) {
    encoded += CROCKFORD[Number.parseInt(bits.slice(index, index + 5).padEnd(5, '0'), 2)];
  }
  return encoded;
}

export function hashHostedReceiptToken(token: string): string {
  return createHash('sha256').update(`pharmacy-hosted-receipt:v1:${token}`).digest('hex');
}

/** The token is returned once, for the link; only the hash is ever persisted. */
export function mintHostedReceiptToken(): { token: string; tokenHash: string } {
  const token = crockford(randomBytes(TOKEN_BYTES));
  return { token, tokenHash: hashHostedReceiptToken(token) };
}

export const HOSTED_RECEIPT_MIN_TTL_DAYS = 30;
export const HOSTED_RECEIPT_MAX_TTL_DAYS = 90;
const DEFAULT_TTL_DAYS = HOSTED_RECEIPT_MIN_TTL_DAYS;
const DAY_MS = 86_400_000;

/**
 * Link lifetime in days from `PHARMACY_RECEIPT_LINK_TTL_DAYS`, kept within the
 * 30-90 day policy. A missing or malformed value uses the 30-day minimum.
 */
export function hostedReceiptTtlDays(
  env: Record<string, string | undefined> = process.env
): number {
  const raw = env.PHARMACY_RECEIPT_LINK_TTL_DAYS?.trim();
  const days = raw ? Number(raw) : DEFAULT_TTL_DAYS;
  if (!Number.isSafeInteger(days)) return DEFAULT_TTL_DAYS;
  return Math.min(HOSTED_RECEIPT_MAX_TTL_DAYS, Math.max(HOSTED_RECEIPT_MIN_TTL_DAYS, days));
}

export function hostedReceiptExpiresAt(now: Date, ttlDays: number): Date {
  return new Date(now.getTime() + ttlDays * DAY_MS);
}

/** A line is Rx-protected when it was dispensed against a prescription or is not OTC-safe. */
export function isRxSaleLine(line: {
  prescriptionLineId: string | null;
  medicine: { rx: boolean; controlled: boolean; restricted: boolean };
}): boolean {
  return (
    line.prescriptionLineId !== null ||
    line.medicine.rx ||
    line.medicine.controlled ||
    line.medicine.restricted
  );
}

/** English tender labels in first-seen order, e.g. "Cash + Card". */
export function receiptMethodLabel(tenders: readonly { type: string }[]): string {
  const names = COUNTER_RECEIPT_STRINGS.en.tenderName;
  const labels = [...new Set(tenders.map((tender) => names[tender.type] ?? 'Other'))];
  return labels.length ? labels.join(' + ') : 'Other';
}

/**
 * The receipt-link template body, in the approved placeholder order:
 * {{1}} branch, {{2}} receipt number, {{3}} total, {{4}} method, {{5}} link.
 * There is deliberately no item, quantity, strength or prescription field.
 */
export function receiptLinkParameters(input: {
  branchName: string;
  receiptNumber: number;
  currency: string;
  netMinor: number;
  method: string;
  url: string;
}): string[] {
  const branch = input.branchName.replace(/\s+/g, ' ').trim().slice(0, 60) || 'Branch';
  return [
    branch,
    String(input.receiptNumber),
    `${input.currency} ${formatMinor(input.netMinor)}`,
    input.method,
    input.url,
  ];
}

/**
 * Words that name a medicine category, dose form or prescription status. Meta's
 * commerce policy and DRAP s.24 keep these out of WhatsApp text altogether.
 */
const CLINICAL_WORDS = new Set([
  'medicine',
  'medicines',
  'medication',
  'medications',
  'drug',
  'drugs',
  'prescription',
  'prescriptions',
  'rx',
  'otc',
  'tablet',
  'tablets',
  'tab',
  'tabs',
  'capsule',
  'capsules',
  'syrup',
  'suspension',
  'injection',
  'injections',
  'inhaler',
  'ointment',
  'antibiotic',
  'antibiotics',
  'antidepressant',
  'antidepressants',
  'painkiller',
  'painkillers',
  'analgesic',
  'analgesics',
  'sedative',
  'sedatives',
  'opioid',
  'opioids',
  'narcotic',
  'narcotics',
  'psychotropic',
  'steroid',
  'steroids',
  'insulin',
  'vaccine',
  'vaccines',
  'contraceptive',
  'contraceptives',
  'controlled',
  'dawa',
  'dawai',
  'dawaai',
  'goli',
  'goliyan',
  'دوا',
  'دوائی',
  'ادویات',
  'نسخہ',
  'گولی',
  'گولیاں',
  'شربت',
  'کیپسول',
  'انجکشن',
]);

/** True when `text` names a medicine, salt or medicine category. */
export function namesMedicineContent(text: string, medicineNames: ReadonlySet<string>): boolean {
  const words = normalizeNameText(text).split(' ');
  if (words.some((word) => CLINICAL_WORDS.has(word))) return true;
  return containsMedicineName(text, medicineNames);
}

/**
 * The WhatsApp text linter: every template parameter is checked against the
 * tenant's medicine, brand, alias and ingredient (salt) names and the category
 * words above. Any hit refuses the send — the message is never rewritten.
 */
export function assertNeutralWhatsAppParameters(
  parameters: readonly string[],
  medicineNames: ReadonlySet<string>
): void {
  if (parameters.some((value) => namesMedicineContent(value, medicineNames)))
    throw new HostedReceiptError('NOT_NEUTRAL');
}
