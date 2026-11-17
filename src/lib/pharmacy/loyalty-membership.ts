import 'server-only';

import type { ScopedDb } from '@/lib/tenancy/scoped-db';

import { lockCustomerConsent } from './consent-writer';
import { customerPointsBalance, PharmacyLoyaltyError } from './customer-loyalty';

export const LOYALTY_MEMBERSHIP_REASON_MIN = 3;
export const LOYALTY_MEMBERSHIP_REASON_MAX = 500;

/**
 * DEV-764: enrols or deactivates a customer's loyalty membership, with a written reason.
 *
 * A customer is first enrolled at the counter, when a consenting patient is linked to a bill.
 * Deactivating keeps every point in the ledger (nothing is forfeited) but the member neither
 * earns nor spends points, and no manual adjustment is made, until they are re-enrolled.
 * Refund restorations, void releases, earn reversals and expiry still post, so the ledger stays
 * whole. Re-enrolling needs the patient's current LOYALTY consent, as the first enrolment did.
 *
 * Runs in the caller's tenant transaction under the same per-customer lock as redemption and
 * adjustment, so a status change cannot interleave with a spend. The caller has authorized
 * the actor and records the audit. Repeating a change already in force changes nothing.
 */
export async function setLoyaltyMembership(
  db: ScopedDb,
  scope: { organizationId: string },
  input: { customerId: string; active: boolean; reason: string; at?: Date }
) {
  const reason = input.reason.trim();
  if (
    reason.length < LOYALTY_MEMBERSHIP_REASON_MIN ||
    reason.length > LOYALTY_MEMBERSHIP_REASON_MAX
  )
    throw new PharmacyLoyaltyError('INVALID_MEMBERSHIP_CHANGE');
  await lockCustomerConsent(db, scope.organizationId, input.customerId);
  const customer = await db.pharmacyCustomer.findFirst({
    where: { id: input.customerId, organizationId: scope.organizationId, active: true },
    select: { id: true, patientId: true, loyaltyActive: true, displayName: true },
  });
  if (!customer) throw new PharmacyLoyaltyError('CUSTOMER_NOT_FOUND');
  const before = customer.loyaltyActive !== false;
  const pointsBalance = await customerPointsBalance(db, scope.organizationId, customer.id);
  if (before === input.active)
    return { customer, before, after: before, pointsBalance, changed: false as const };
  if (input.active) {
    const consent = await db.patientConsent.findFirst({
      where: {
        organizationId: scope.organizationId,
        patientId: customer.patientId,
        purpose: 'LOYALTY',
      },
      orderBy: [{ version: 'desc' }, { recordedAt: 'desc' }],
      select: { granted: true, revokedAt: true },
    });
    if (!consent?.granted || consent.revokedAt)
      throw new PharmacyLoyaltyError('LOYALTY_CONSENT_REQUIRED');
  }
  const updated = await db.pharmacyCustomer.updateMany({
    where: {
      id: customer.id,
      organizationId: scope.organizationId,
      active: true,
      loyaltyActive: before,
    },
    data: {
      loyaltyActive: input.active,
      loyaltyStatusChangedAt: input.at ?? new Date(),
      loyaltyStatusReason: reason,
    },
  });
  if (updated.count !== 1) throw new PharmacyLoyaltyError('CUSTOMER_NOT_FOUND');
  return { customer, before, after: input.active, pointsBalance, changed: true as const };
}
