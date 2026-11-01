import 'server-only';
import { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import type { LedgerScope } from './stock-ledger';
import { refundPharmacyTender } from './settlement';

/** Internal to the void transaction. Reverse the original tender and its points
 * together, so a later refund cannot restore the same points a second time. */
export async function restoreVoidedSalePoints(db: ScopedDb, scope: LedgerScope, saleId: string) {
  await db.$queryRaw(Prisma.sql`SELECT id FROM pharmacy_sales WHERE id=${saleId}
    AND "organizationId"=${scope.organizationId} AND "branchId"=${scope.branchId} FOR UPDATE`);
  const sale = await db.pharmacySale.findFirst({
    where: {
      id: saleId,
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      status: 'VOID',
    },
  });
  if (!sale?.customerId) return null;
  const tenders = await db.pharmacyTender.findMany({
    where: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      saleId,
      type: 'LOYALTY',
    },
    include: { refunds: true },
  });
  for (const tender of tenders) {
    const amountMinor =
      tender.amountMinor - tender.refunds.reduce((sum, refund) => sum + refund.amountMinor, 0);
    if (amountMinor <= 0) continue;
    await refundPharmacyTender(db, scope, {
      originalTenderId: tender.id,
      amountMinor,
      deviceId: tender.deviceId,
      businessDate: tender.businessDate,
      reason: 'Automatic restoration of unused points on voided bill',
      idempotencyKey: `loyalty:void:${saleId}:${tender.id}`,
    });
  }
}
