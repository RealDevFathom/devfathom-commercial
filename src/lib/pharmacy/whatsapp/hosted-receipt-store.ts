import 'server-only';

import { createHash } from 'node:crypto';
import { withTenantDb, type ScopedDb } from '@/lib/tenancy/scoped-db';
import { readHostedReceipt, type HostedReceipt } from './hosted-receipt';
import { normalizeWhatsAppNumber } from './messages';

export function hostedReceiptTokenDigest(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export async function persistHostedReceipt(
  db: ScopedDb,
  token: string,
  receipt: HostedReceipt
): Promise<string> {
  const row = await db.pharmacyHostedReceipt.create({
    data: {
      organizationId: receipt.organizationId,
      branchId: receipt.branchId,
      saleId: receipt.saleId,
      actorId: receipt.actorId,
      tokenDigest: hostedReceiptTokenDigest(token),
      version: receipt.version,
      consent: receipt.consent,
      consentedAt: new Date(receipt.consentedAt),
      issuedAt: new Date(receipt.issuedAt),
      expiresAt: new Date(receipt.expiresAt),
    },
    select: { id: true },
  });
  return row.id;
}

/** Tenants that may no longer serve customer-facing pharmacy documents. */
const UNSERVABLE_ORGANIZATION_STATUSES = ['SUSPENDED', 'TERMINATED', 'PURGING', 'PURGED'] as const;

/** Shared by issuance and public authorization: totals must still be current. */
export const HOSTED_RECEIPT_SALE_ELIGIBILITY = {
  status: 'COMPLETED',
  returns: { none: {} },
  refunds: { none: {} },
} as const;

/**
 * Authenticates the claim, then requires a matching live row under tenant RLS.
 * The link also dies when the tenant is suspended or the sale has since been
 * voided, returned, or refunded, so a stale total is never shown.
 */
export async function authorizeHostedReceiptRecord(
  token: string,
  secret: string,
  now = new Date()
): Promise<{ id: string; receipt: HostedReceipt }> {
  const receipt = readHostedReceipt(token, secret, now);
  const digest = hostedReceiptTokenDigest(token);
  return withTenantDb(receipt.organizationId, async (db) => {
    const live = await db.pharmacyHostedReceipt.findFirst({
      where: {
        organizationId: receipt.organizationId,
        branchId: receipt.branchId,
        saleId: receipt.saleId,
        actorId: receipt.actorId,
        tokenDigest: digest,
        version: receipt.version,
        revokedAt: null,
        expiresAt: { gt: now },
        organization: { status: { notIn: [...UNSERVABLE_ORGANIZATION_STATUSES] } },
        sale: HOSTED_RECEIPT_SALE_ELIGIBILITY,
      },
      select: { id: true },
    });
    if (!live) throw new Error('Receipt link is unavailable.');
    await db.pharmacyHostedReceipt.update({
      where: { id: live.id },
      data: { lastAccessedAt: now, accessCount: { increment: 1 } },
    });
    return { id: live.id, receipt };
  });
}

export async function authorizeHostedReceipt(
  token: string,
  secret: string,
  now = new Date()
): Promise<HostedReceipt> {
  return (await authorizeHostedReceiptRecord(token, secret, now)).receipt;
}

export async function revokeHostedReceipts(
  db: ScopedDb,
  organizationId: string,
  saleId: string,
  actorId: string,
  now = new Date(),
  branchId?: string
) {
  return db.pharmacyHostedReceipt.updateMany({
    where: { organizationId, saleId, ...(branchId ? { branchId } : {}), revokedAt: null },
    data: { revokedAt: now, revokedByActorId: actorId },
  });
}

/**
 * A customer who sent STOP (or whose opt-in was withdrawn) is never messaged,
 * whatever consent staff record at the counter. `phone` is a normalized
 * WhatsApp id; `customerId` is the sale's linked customer, when there is one.
 */
export async function hostedReceiptRecipientOptedOut(
  db: ScopedDb,
  organizationId: string,
  phone: string,
  customerId?: string | null
): Promise<boolean> {
  if (
    customerId &&
    (await db.pharmacyCustomer.findFirst({
      where: { organizationId, id: customerId, whatsappOptIn: false },
      select: { id: true },
    }))
  )
    return true;

  // Scan every opted-out identity. A raw suffix filter is unsafe for formatted
  // numbers, Urdu digits, or trailing whitespace; normalize before comparing.
  let afterId: string | undefined;
  const pageSize = 200;
  for (;;) {
    const candidates = await db.pharmacyCustomer.findMany({
      where: {
        organizationId,
        whatsappOptIn: false,
        ...(afterId ? { id: { gt: afterId } } : {}),
      },
      select: { id: true, patient: { select: { phone: true } } },
      orderBy: { id: 'asc' },
      take: pageSize,
    });
    if (candidates.some((candidate) => normalizeWhatsAppNumber(candidate.patient.phone) === phone))
      return true;
    if (candidates.length < pageSize) return false;
    afterId = candidates[candidates.length - 1].id;
  }
}

export function tenantHostedReceiptRecipientOptedOut(
  organizationId: string,
  phone: string,
  saleId: string
) {
  return withTenantDb(organizationId, async (db) => {
    const sale = await db.pharmacySale.findFirst({
      where: { organizationId, id: saleId },
      select: { customerId: true },
    });
    return hostedReceiptRecipientOptedOut(db, organizationId, phone, sale?.customerId);
  });
}
