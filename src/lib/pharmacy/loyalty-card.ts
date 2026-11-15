import 'server-only';

import { createHash, randomBytes } from 'node:crypto';

import type { ScopedDb } from '@/lib/tenancy/scoped-db';

import { linkCustomerToSale, PharmacyLoyaltyError } from './customer-loyalty';
import {
  LOYALTY_CARD_PREFIX,
  LOYALTY_CARD_RANDOM_CHARS,
  normalizeLoyaltyCardCode,
} from './loyalty-card-code';
import { hasLoyaltyEarningConsent } from './loyalty-program';
import type { LedgerScope } from './stock-ledger';

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** A new card code: 128 bits from the platform CSPRNG, base32-encoded after the prefix. */
export function generateLoyaltyCardCode(random: (size: number) => Buffer = randomBytes): string {
  const bytes = random(16);
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  if (out.length !== LOYALTY_CARD_RANDOM_CHARS) throw new Error('Card code generation failed.');
  return `${LOYALTY_CARD_PREFIX}${out}`;
}

/** What is stored and looked up: the SHA-256 of the canonical code, never the code itself. */
export function hashLoyaltyCardCode(code: string): string {
  return createHash('sha256').update(code, 'utf8').digest('hex');
}

/** A revocation or replacement reason, as the database check requires it. */
function revocationReason(reason: string | undefined) {
  const text = reason?.trim() ?? '';
  if (text.length < 3 || text.length > 200)
    throw new PharmacyLoyaltyError('LOYALTY_CARD_REASON_REQUIRED');
  return text;
}

type CardScope = { organizationId: string; actorId: string };

/**
 * The customer, active and with standing LOYALTY consent, locked for this transaction so two
 * issues or an issue and a revoke for the same customer run one after the other.
 */
async function lockCardCustomer(db: ScopedDb, organizationId: string, customerId: string) {
  const customer = await db.pharmacyCustomer.findFirst({
    where: { id: customerId, organizationId, active: true },
    select: { id: true },
  });
  if (!customer) throw new PharmacyLoyaltyError('CUSTOMER_NOT_FOUND');
  return hasLoyaltyEarningConsent(db, organizationId, customer.id);
}

/** The customer's working card, if any. Never returns the code or its hash. */
export async function readActiveLoyaltyCard(
  db: ScopedDb,
  organizationId: string,
  customerId: string
) {
  return db.pharmacyLoyaltyCard.findFirst({
    where: { organizationId, customerId, revokedAt: null },
    select: { id: true, issuedAt: true },
  });
}

/**
 * Issues a new card to a customer and returns its code, once: only the hash is kept, so a card
 * that is lost is replaced, never re-printed. Issuing while a card is active replaces it: the old
 * card is revoked with the given reason in the same transaction and stops working at once. The
 * points balance belongs to the customer, not the card, so a replacement keeps it.
 */
export async function issueLoyaltyCard(
  db: ScopedDb,
  scope: CardScope,
  input: { customerId: string; reason?: string }
) {
  if (!(await lockCardCustomer(db, scope.organizationId, input.customerId)))
    throw new PharmacyLoyaltyError('LOYALTY_CONSENT_REQUIRED');
  const active = await readActiveLoyaltyCard(db, scope.organizationId, input.customerId);
  let replacedReason: string | null = null;
  if (active) {
    replacedReason = revocationReason(input.reason);
    const revoked = await db.pharmacyLoyaltyCard.updateMany({
      where: { organizationId: scope.organizationId, id: active.id, revokedAt: null },
      data: { revokedAt: new Date(), revokedById: scope.actorId, revokedReason: replacedReason },
    });
    if (revoked.count !== 1) throw new PharmacyLoyaltyError('IDEMPOTENCY_CONFLICT');
  }
  const code = generateLoyaltyCardCode();
  const card = await db.pharmacyLoyaltyCard.create({
    data: {
      organizationId: scope.organizationId,
      customerId: input.customerId,
      codeHash: hashLoyaltyCardCode(code),
      issuedById: scope.actorId,
    },
    select: { id: true, issuedAt: true },
  });
  return { card, code, replacedCardId: active?.id ?? null, replacedReason };
}

/** Revokes the customer's working card (lost, stolen, withdrawn) without issuing another. */
export async function revokeLoyaltyCard(
  db: ScopedDb,
  scope: CardScope,
  input: { customerId: string; reason: string }
) {
  const reason = revocationReason(input.reason);
  const customer = await db.pharmacyCustomer.findFirst({
    where: { id: input.customerId, organizationId: scope.organizationId },
    select: { id: true },
  });
  if (!customer) throw new PharmacyLoyaltyError('CUSTOMER_NOT_FOUND');
  const active = await readActiveLoyaltyCard(db, scope.organizationId, customer.id);
  if (!active) throw new PharmacyLoyaltyError('LOYALTY_CARD_NOT_ACTIVE');
  const revoked = await db.pharmacyLoyaltyCard.updateMany({
    where: { organizationId: scope.organizationId, id: active.id, revokedAt: null },
    data: { revokedAt: new Date(), revokedById: scope.actorId, revokedReason: reason },
  });
  if (revoked.count !== 1) throw new PharmacyLoyaltyError('LOYALTY_CARD_NOT_ACTIVE');
  return { cardId: active.id, reason };
}

/**
 * The counter scan: resolves a card code to its customer within this organization and links that
 * customer to the open bill through the same consent and prescription checks as a manual link, so
 * points are earned when the bill is paid and can be redeemed on it. An unknown, malformed or
 * revoked code, a card of an inactive customer and a card of another organization all fail the
 * same way, so a scan reveals nothing about which it was.
 */
export async function linkLoyaltyCardToSale(
  db: ScopedDb,
  scope: LedgerScope,
  input: { saleId: string; code: string }
) {
  const code = normalizeLoyaltyCardCode(input.code);
  if (!code) throw new PharmacyLoyaltyError('LOYALTY_CARD_NOT_RECOGNISED');
  const card = await db.pharmacyLoyaltyCard.findFirst({
    where: {
      organizationId: scope.organizationId,
      codeHash: hashLoyaltyCardCode(code),
      revokedAt: null,
    },
    select: {
      id: true,
      customer: {
        select: {
          id: true,
          organizationId: true,
          patientId: true,
          displayName: true,
          phoneLast4: true,
          active: true,
        },
      },
    },
  });
  const customer = card?.customer;
  if (!card || !customer?.active || customer.organizationId !== scope.organizationId)
    throw new PharmacyLoyaltyError('LOYALTY_CARD_NOT_RECOGNISED');
  const linked = await linkCustomerToSale(db, scope, {
    saleId: input.saleId,
    patientId: customer.patientId,
    displayName: customer.displayName,
    ...(customer.phoneLast4 ? { phoneLast4: customer.phoneLast4 } : {}),
  });
  if (linked.id !== customer.id) throw new PharmacyLoyaltyError('LOYALTY_CARD_NOT_RECOGNISED');
  return { cardId: card.id, customerId: linked.id, displayName: linked.displayName };
}
