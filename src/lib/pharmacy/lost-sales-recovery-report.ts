import 'server-only';

import type { ScopedDb } from '@/lib/tenancy/scoped-db';

import {
  LOST_SALES_RECOVERY_DEFINITIONS,
  readBackInStockPolicy,
  summarizeLostSalesRecovery,
  type LostSalesRecoveryRow,
} from './back-in-stock';
import { validateMarketingReportFilters } from './marketing-report';

/** Upper bound on demand events read for one report; a larger scope is reported as truncated. */
export const LOST_SALES_RECOVERY_EVENT_LIMIT = 20_000;

export async function readLostSalesRecovery(
  db: ScopedDb,
  organizationId: string,
  filters: { branchIds: string[]; from: string; to: string }
) {
  const createdAt = validateMarketingReportFilters(filters);
  const [branches, events] = await Promise.all([
    db.pharmacyBranch.findMany({
      where: { organizationId, id: { in: filters.branchIds } },
      select: { id: true, name: true },
    }),
    db.unfulfilledDemandEvent.findMany({
      where: { organizationId, branchId: { in: filters.branchIds }, createdAt },
      select: {
        id: true,
        branchId: true,
        requestedMedicineId: true,
        estimatedValueMinor: true,
        recoveredSaleLineId: true,
        medicine: {
          select: { strengths: { select: { ingredient: { select: { name: true } } } } },
        },
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: LOST_SALES_RECOVERY_EVENT_LIMIT + 1,
    }),
  ]);
  const truncated = events.length > LOST_SALES_RECOVERY_EVENT_LIMIT;
  const scoped = events.slice(0, LOST_SALES_RECOVERY_EVENT_LIMIT);
  const lineIds = [
    ...new Set(
      scoped.flatMap((event) => (event.recoveredSaleLineId ? [event.recoveredSaleLineId] : []))
    ),
  ];
  const medicineIds = [
    ...new Set(
      scoped.flatMap((event) => (event.requestedMedicineId ? [event.requestedMedicineId] : []))
    ),
  ];
  const [lines, receipts] = await Promise.all([
    lineIds.length
      ? db.pharmacySaleLine.findMany({
          where: { organizationId, id: { in: lineIds }, sale: { status: 'COMPLETED' } },
          select: { id: true, grossMinor: true, discountMinor: true },
        })
      : [],
    medicineIds.length
      ? db.pharmacyGoodsReceiptLine.findMany({
          where: {
            organizationId,
            branchId: { in: filters.branchIds },
            medicineId: { in: medicineIds },
            goodsReceipt: { status: 'POSTED' },
          },
          select: {
            branchId: true,
            medicineId: true,
            goodsReceipt: { select: { postedAt: true, supplier: { select: { name: true } } } },
          },
        })
      : [],
  ]);
  const lineValue = new Map(lines.map((line) => [line.id, line.grossMinor - line.discountMinor]));
  const distributor = new Map<string, { at: number; name: string }>();
  for (const receipt of receipts) {
    const key = `${receipt.branchId}:${receipt.medicineId}`;
    const at = receipt.goodsReceipt.postedAt?.getTime() ?? 0;
    const current = distributor.get(key);
    if (
      !current ||
      at > current.at ||
      (at === current.at && receipt.goodsReceipt.supplier.name < current.name)
    )
      distributor.set(key, { at, name: receipt.goodsReceipt.supplier.name });
  }
  const branchName = new Map(branches.map((branch) => [branch.id, branch.name]));
  const rows: LostSalesRecoveryRow[] = scoped.map((event) => ({
    branchId: event.branchId,
    branchName: branchName.get(event.branchId) ?? 'Unknown branch',
    salts: event.medicine?.strengths.map((strength) => strength.ingredient.name) ?? [],
    distributor: event.requestedMedicineId
      ? (distributor.get(`${event.branchId}:${event.requestedMedicineId}`)?.name ?? null)
      : null,
    estimatedLostMinor: event.estimatedValueMinor,
    recoveredMinor: event.recoveredSaleLineId ? (lineValue.get(event.recoveredSaleLineId) ?? 0) : 0,
  }));
  const policy = readBackInStockPolicy();
  return {
    estimated: true as const,
    period: { from: filters.from, to: filters.to },
    policy,
    truncated,
    definitions: LOST_SALES_RECOVERY_DEFINITIONS,
    ...summarizeLostSalesRecovery(rows),
  };
}
