import 'server-only';

import { createHash } from 'node:crypto';

import { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

import { money, ZERO } from './money';

/**
 * M5-L4 / C6 — the payment adapter contract + the MOCK provider.
 *
 * A provider declares the CAPABILITIES it implements, exposes a single `execute`
 * operation interface, and maps every provider-native outcome onto the NORMALIZED
 * status set (`RestaurantPaymentStatus`). M5 ships exactly ONE provider — MOCK — in
 * a frozen registry (`RestaurantPaymentProvider` has only the MOCK member; no real
 * PSP network I/O, D23 not built). Card data never enters this layer: an operation
 * carries an amount, a tip, and opaque references only, and `appendPaymentEvent`
 * hard-rejects any payload field that looks like a PAN/CVV/track/PIN (C6 — defence
 * in depth on top of the schema audit).
 *
 * `execute` is PURE (no I/O, no clock, no randomness): it returns the normalized
 * outcome plus an append-only event DRAFT, and the caller (tenders.ts / refunds.ts)
 * persists the `RestaurantPayment` row and appends the event INSIDE its own money
 * transaction. Keeping the operation pure is what lets tenders.ts abort a declined
 * SALE with nothing persisted (the atomicity named check) and lets the conformance
 * suite drive all six capabilities without a database. Provider references are
 * DETERMINISTIC — a SHA-256 of the capability + a caller-supplied operation seed —
 * so identical inputs reproduce identical refs, and OUTCOMES are scriptable through
 * designated decline amounts (a SALE/AUTH whose amount ends in a designated cent
 * code declines deterministically) rather than a clock or RNG.
 */

// ── Normalized contract types (mirror the Prisma enums as string unions) ──────

export type PaymentCapability = 'SALE' | 'AUTH' | 'CAPTURE' | 'ADJUST' | 'VOID' | 'REFUND';

export type PaymentStatus =
  | 'PENDING'
  | 'AUTHORIZED'
  | 'CAPTURED'
  | 'VOIDED'
  | 'REFUNDED'
  | 'PARTIALLY_REFUNDED'
  | 'DECLINED'
  | 'FAILED';

export type PaymentProviderName = 'MOCK';

/** The complete capability set (the MOCK provider implements every one, C6). */
export const PAYMENT_CAPABILITIES: readonly PaymentCapability[] = [
  'SALE',
  'AUTH',
  'CAPTURE',
  'ADJUST',
  'VOID',
  'REFUND',
] as const;

export type PaymentAdapterErrorReason =
  | 'UNKNOWN_PROVIDER'
  | 'UNSUPPORTED_CAPABILITY'
  | 'MISSING_PRIOR_REFERENCE'
  | 'FORBIDDEN_PAYLOAD_FIELD';

export class PaymentAdapterError extends Error {
  constructor(
    message: string,
    readonly reason: PaymentAdapterErrorReason
  ) {
    super(message);
    this.name = 'PaymentAdapterError';
  }
}

/** A single provider operation. `operationRef` is a caller-supplied stable seed for
 * the deterministic provider reference (e.g. the bill id + idempotency key); post-
 * authorization operations (CAPTURE/ADJUST/VOID/REFUND) carry the `priorRef` of the
 * authorization they act on. */
export type PaymentOperation = {
  capability: PaymentCapability;
  amount: Prisma.Decimal | string | number;
  tipAmount?: Prisma.Decimal | string | number;
  operationRef: string;
  priorRef?: string | null;
};

/** The append-only event a provider operation produces. The caller writes it via
 * `appendPaymentEvent`. `payload` is sanitized structured data only — NEVER card
 * data (enforced at append time). */
export type PaymentEventDraft = {
  capability: PaymentCapability;
  eventType: string;
  amount: Prisma.Decimal | null;
  providerRef: string | null;
  payload: Record<string, unknown>;
};

/** The normalized outcome of an operation. `status` is the status the affected
 * payment transitions to for the simple happy path; a caller that tracks aggregate
 * state (e.g. a partial card refund) may narrow it further (PARTIALLY_REFUNDED). */
export type PaymentOutcome = {
  approved: boolean;
  status: PaymentStatus;
  capability: PaymentCapability;
  amount: Prisma.Decimal;
  tipAmount: Prisma.Decimal;
  providerRef: string;
  declineCode: string | null;
  event: PaymentEventDraft;
};

export interface PaymentProvider {
  readonly name: PaymentProviderName;
  readonly capabilities: readonly PaymentCapability[];
  supports(capability: PaymentCapability): boolean;
  execute(operation: PaymentOperation): PaymentOutcome;
}

// ── MOCK provider ─────────────────────────────────────────────────────────────

/** The normalized status an APPROVED operation of each capability lands on. A SALE
 * is a one-shot auth+capture (→ CAPTURED); an ADJUST leaves the authorization in
 * place (→ AUTHORIZED); a REFUND lands REFUNDED (the caller narrows to
 * PARTIALLY_REFUNDED when Σ refunds < the captured amount). */
const APPROVED_STATUS: Record<PaymentCapability, PaymentStatus> = {
  SALE: 'CAPTURED',
  AUTH: 'AUTHORIZED',
  CAPTURE: 'CAPTURED',
  ADJUST: 'AUTHORIZED',
  VOID: 'VOIDED',
  REFUND: 'REFUNDED',
};

/** Only the funds-authorizing operations can decline; a CAPTURE/ADJUST/VOID/REFUND
 * of a valid prior authorization always succeeds in the MOCK. */
const AUTHORIZING = new Set<PaymentCapability>(['SALE', 'AUTH']);

/** Operations that act on a prior authorization and therefore require its ref. */
const REQUIRES_PRIOR = new Set<PaymentCapability>(['CAPTURE', 'ADJUST', 'VOID', 'REFUND']);

/**
 * Designated decline codes keyed by the CENTS of the operation amount (C6 scripting
 * hook). A SALE/AUTH whose amount ends in one of these cent values declines
 * deterministically — the way a test (or a checkout demo) scripts a non-approval,
 * with no clock or RNG. Everything else approves.
 */
const DECLINE_CODES: Readonly<Record<number, string>> = Object.freeze({
  13: 'GENERIC_DECLINE',
  51: 'INSUFFICIENT_FUNDS',
  54: 'EXPIRED_CARD',
});

/** The two-digit cents component of a money amount (0..99), exact via Decimal. */
function centsComponent(amount: Prisma.Decimal): number {
  return amount.times(100).mod(100).abs().toNumber();
}

function declineCodeFor(capability: PaymentCapability, amount: Prisma.Decimal): string | null {
  if (!AUTHORIZING.has(capability)) return null;
  return DECLINE_CODES[centsComponent(amount)] ?? null;
}

/** A deterministic provider reference: SHA-256 over the capability + the caller's
 * operation seed. Same inputs → same ref (the "deterministic refs" named check). */
function mockReference(capability: PaymentCapability, operationRef: string): string {
  const digest = createHash('sha256')
    .update(`MOCK:${capability}:${operationRef}`)
    .digest('hex')
    .slice(0, 20);
  return `mock_${capability.toLowerCase()}_${digest}`;
}

function mockSupports(capability: PaymentCapability): boolean {
  return PAYMENT_CAPABILITIES.includes(capability);
}

function mockExecute(operation: PaymentOperation): PaymentOutcome {
  if (!mockSupports(operation.capability)) {
    throw new PaymentAdapterError(
      `The MOCK provider does not support the ${operation.capability} capability.`,
      'UNSUPPORTED_CAPABILITY'
    );
  }
  if (REQUIRES_PRIOR.has(operation.capability) && !operation.priorRef) {
    throw new PaymentAdapterError(
      `A ${operation.capability} operation requires the prior authorization reference.`,
      'MISSING_PRIOR_REFERENCE'
    );
  }

  const amount = money(operation.amount);
  const tipAmount = operation.tipAmount === undefined ? ZERO : money(operation.tipAmount);
  const declineCode = declineCodeFor(operation.capability, amount);
  const approved = declineCode === null;
  const providerRef = mockReference(operation.capability, operation.operationRef);
  const status = approved ? APPROVED_STATUS[operation.capability] : 'DECLINED';
  const eventType = `${operation.capability}_${approved ? 'APPROVED' : 'DECLINED'}`;

  const payload: Record<string, unknown> = {
    provider: 'MOCK',
    capability: operation.capability,
    approved,
    amount: amount.toString(),
    tipAmount: tipAmount.toString(),
  };
  if (declineCode) payload.declineCode = declineCode;
  if (operation.priorRef) payload.priorRef = operation.priorRef;

  return {
    approved,
    status,
    capability: operation.capability,
    amount,
    tipAmount,
    providerRef,
    declineCode,
    event: { capability: operation.capability, eventType, amount, providerRef, payload },
  };
}

/** The MOCK provider — the only provider in M5 (C6). */
export const MOCK_PROVIDER: PaymentProvider = Object.freeze({
  name: 'MOCK',
  capabilities: PAYMENT_CAPABILITIES,
  supports: mockSupports,
  execute: mockExecute,
});

// ── Provider registry (exactly MOCK) ──────────────────────────────────────────

const PROVIDER_REGISTRY: Record<string, PaymentProvider> = { MOCK: MOCK_PROVIDER };

/** The registered provider names — exactly `['MOCK']` in M5. */
export const REGISTERED_PROVIDERS: readonly PaymentProviderName[] = Object.freeze(
  Object.keys(PROVIDER_REGISTRY) as PaymentProviderName[]
);

/** Resolve a provider by name; throws on an unknown provider (fail-closed). */
export function getPaymentProvider(name: PaymentProviderName): PaymentProvider {
  const provider = PROVIDER_REGISTRY[name];
  if (!provider) {
    throw new PaymentAdapterError(`Unknown payment provider: ${name}.`, 'UNKNOWN_PROVIDER');
  }
  return provider;
}

// ── Append-only event trail (the single writer) ───────────────────────────────

/** Payload keys that would carry cardholder data — forbidden anywhere in a payment
 * event (C6). Compared after stripping non-alphanumerics and lower-casing, so
 * `card_number`, `cardNumber` and `CardNo` all match. Exported so the pharmacy
 * card-terminal seam (DEV-743) extends this list instead of keeping a second one. */
export const FORBIDDEN_PAYLOAD_KEYS: ReadonlySet<string> = new Set([
  'pan',
  'primaryaccountnumber',
  'cardnumber',
  'cardno',
  'cvv',
  'cvv2',
  'cvc',
  'cvc2',
  'cid',
  'track',
  'track1',
  'track2',
  'magstripe',
  'pin',
  'pinblock',
]);

/** Recursively assert no cardholder-data field is present in a payload (C6). */
function assertNoCardData(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) assertNoCardData(item);
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [rawKey, child] of Object.entries(value)) {
      const key = rawKey.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (FORBIDDEN_PAYLOAD_KEYS.has(key)) {
        throw new PaymentAdapterError(
          `A payment event payload may never carry the field "${rawKey}" — PAN/CVV/track/PIN data is forbidden (C6).`,
          'FORBIDDEN_PAYLOAD_FIELD'
        );
      }
      assertNoCardData(child);
    }
  }
}

export type AppendPaymentEventInput = {
  paymentId: string;
  capability: PaymentCapability;
  eventType: string;
  amount?: Prisma.Decimal | string | number | null;
  providerRef?: string | null;
  payload: Record<string, unknown>;
};

/**
 * Append one row to a payment's APPEND-ONLY event trail and return its id. The
 * SINGLE writer of `restaurant_payment_events` (DB-enforced SELECT+INSERT-only, C3):
 * tenders.ts and refunds.ts call it INSIDE their money transaction after `execute`.
 * The payload is hard-checked for cardholder-data fields before it is written.
 */
export async function appendPaymentEvent(
  tx: ScopedDb,
  input: AppendPaymentEventInput
): Promise<{ eventId: string }> {
  assertNoCardData(input.payload);
  const created = await tx.restaurantPaymentEvent.create({
    data: {
      paymentId: input.paymentId,
      capability: input.capability,
      eventType: input.eventType,
      amount: input.amount === undefined || input.amount === null ? null : money(input.amount),
      providerRef: input.providerRef ?? null,
      payload: input.payload as Prisma.InputJsonValue,
    },
    select: { id: true },
  });
  return { eventId: created.id };
}
