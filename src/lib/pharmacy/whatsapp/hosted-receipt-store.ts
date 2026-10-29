import 'server-only';

import { createHash } from 'node:crypto';
import { withTenantDb, type ScopedDb } from '@/lib/tenancy/scoped-db';
import { readHostedReceipt, type HostedReceipt } from './hosted-receipt';

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

/** Authenticates the claim, then requires a matching live row under tenant RLS. */
export async function authorizeHostedReceipt(
  token: string,
  secret: string,
  now = new Date()
): Promise<HostedReceipt> {
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
      },
      select: { id: true },
    });
    if (!live) throw new Error('Receipt link is unavailable.');
    await db.pharmacyHostedReceipt.update({
      where: { id: live.id },
      data: { lastAccessedAt: now, accessCount: { increment: 1 } },
    });
    return receipt;
  });
}

export async function revokeHostedReceipts(
  db: ScopedDb,
  organizationId: string,
  saleId: string,
  actorId: string,
  now = new Date()
) {
  return db.pharmacyHostedReceipt.updateMany({
    where: { organizationId, saleId, revokedAt: null },
    data: { revokedAt: now, revokedByActorId: actorId },
  });
}
