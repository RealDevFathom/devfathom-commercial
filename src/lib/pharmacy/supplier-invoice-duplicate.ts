import type { ScopedDb } from '@/lib/tenancy/scoped-db';

/**
 * DEV-679 duplicate-bill guard. A supplier invoice is filed once per supplier:
 * the database already refuses the exact same reference, and this also catches
 * the same bill typed (or read off a photo) in another letter case, before a
 * second receipt is drafted for it. Every receipt counts, drafted, posted or
 * reversed, because each one already used the bill.
 */
export type DuplicateSupplierInvoice = { id: string; reference: string; status: string };

export async function findDuplicateSupplierInvoice(
  db: Pick<ScopedDb, 'pharmacyGoodsReceipt'>,
  input: { organizationId: string; supplierId: string; supplierInvoiceRef: string }
): Promise<DuplicateSupplierInvoice | null> {
  const ref = input.supplierInvoiceRef.trim();
  if (!ref) return null;
  const found = await db.pharmacyGoodsReceipt.findFirst({
    where: {
      organizationId: input.organizationId,
      supplierId: input.supplierId,
      supplierInvoiceRef: { equals: ref, mode: 'insensitive' },
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { id: true, reference: true, status: true },
  });
  return found ?? null;
}
