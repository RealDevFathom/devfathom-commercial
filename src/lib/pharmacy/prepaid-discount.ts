import 'server-only';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { lockPrepaidCustomer, readPrepaidAccount } from './prepaid-tiers';

type Line = {
  id: string;
  createdAt: Date;
  grossMinor: number;
  discountMinor: number;
  tierAllocationDiscounts?: unknown;
  tierDiscountMinor?: number;
  tierName?: string | null;
  discountKind?: string | null;
  approvalPolicy?: string | null;
  approvedByUserId?: string | null;
  medicine: { rx: boolean; restricted: boolean; controlled: boolean };
  allocations: {
    id: string;
    canonicalUnits: number;
    grossMinor?: number | null;
    discountMinor?: number | null;
    lot: { unitCostMinor: number };
  }[];
};
type Sale = {
  id: string;
  organizationId: string;
  customerId?: string | null;
  status: string;
  tenders: { createdAt: Date }[];
  lines: Line[];
};
/** The floor applies to every allocated lot, including mixed-cost packs. Regulated lines keep their no-discount rule. */
export function prepaidLineDiscount(line: Line, basisPoints: number, billShareMinor?: number) {
  if (
    line.medicine.rx ||
    line.medicine.restricted ||
    line.medicine.controlled ||
    basisPoints <= 0 ||
    line.allocations.some((a) => a.grossMinor == null || a.discountMinor == null)
  )
    return { amountMinor: 0, allocations: line.allocations.map(() => 0) };
  const desired =
    billShareMinor ?? Math.floor(((line.grossMinor - line.discountMinor) * basisPoints) / 10000);
  const capacities = line.allocations.map((a) =>
    Math.max(
      0,
      (a.grossMinor ?? 0) - (a.discountMinor ?? 0) - a.canonicalUnits * a.lot.unitCostMinor
    )
  );
  const capacity = capacities.reduce((sum, n) => sum + n, 0);
  const amountMinor = Math.min(desired, capacity);
  let cumulative = 0;
  const allocations = capacities.map((n) => {
    const before = cumulative;
    cumulative += n;
    return capacity
      ? Number((BigInt(amountMinor) * BigInt(cumulative)) / BigInt(capacity)) -
          Number((BigInt(amountMinor) * BigInt(before)) / BigInt(capacity))
      : 0;
  });
  return { amountMinor, allocations };
}
/**
 * Quotes do not write. A tender freezes the same prices under the customer lock. A line already
 * on the bill when a payment was taken is never repriced, so earlier payments can never exceed
 * the bill; a line added after the newest payment is priced at the next quote and tender.
 */
export async function pricePrepaidSale<T extends Sale>(
  db: ScopedDb,
  sale: T,
  persist = false
): Promise<T> {
  if (sale.status !== 'OPEN' || !sale.customerId) return sale;
  const lastTenderAt = sale.tenders.reduce<number | null>(
    (latest, tender) => Math.max(latest ?? 0, tender.createdAt.getTime()),
    null
  );
  const pending = (line: Line) =>
    !line.tierName && (lastTenderAt === null || line.createdAt.getTime() > lastTenderAt);
  if (!sale.lines.some(pending)) return sale;
  if (persist) await lockPrepaidCustomer(db, sale.organizationId, sale.customerId);
  const account = await readPrepaidAccount(db, sale.organizationId, sale.customerId);
  if (!account || account.balanceMinor <= 0 || !account.tierName || !account.tierVersionId)
    return sale;
  const version = await db.pharmacyPrepaidTierVersion.findFirst({
    where: { id: account.tierVersionId, organizationId: sale.organizationId },
    select: { actorId: true },
  });
  if (!version) throw new Error('Prepaid tier author unavailable.');
  // The whole-bill share is apportioned in line order, so rounding never loses a paisa.
  const basisPoints = BigInt(account.discountBasisPoints);
  const shares = new Map<string, number>();
  let through = BigInt(0);
  for (const line of [...sale.lines].sort(
    (a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id)
  )) {
    const before = through;
    through += BigInt(line.grossMinor - line.discountMinor + (line.tierDiscountMinor ?? 0));
    shares.set(
      line.id,
      Number((through * basisPoints) / BigInt(10000) - (before * basisPoints) / BigInt(10000))
    );
  }
  const lines = [];
  for (const line of sale.lines) {
    const discount = pending(line)
      ? prepaidLineDiscount(line, account.discountBasisPoints, shares.get(line.id))
      : { amountMinor: 0, allocations: [] };
    if (!discount.amountMinor) {
      lines.push(line);
      continue;
    }
    const priced = {
      ...line,
      discountMinor: line.discountMinor + discount.amountMinor,
      tierDiscountMinor: discount.amountMinor,
      tierName: account.tierName,
      tierAllocationDiscounts: Object.fromEntries(
        line.allocations.map((a, i) => [a.id, discount.allocations[i]!])
      ),
    };
    if (persist) {
      await db.pharmacySaleLine.update({
        where: { organizationId_id: { organizationId: sale.organizationId, id: line.id } },
        data: {
          discountMinor: priced.discountMinor,
          tierDiscountMinor: priced.tierDiscountMinor,
          tierName: priced.tierName,
          discountKind: (line.discountKind as 'DISCOUNT' | undefined) ?? 'DISCOUNT',
          approvalPolicy: line.approvalPolicy ?? `prepaid-tier:${account.tierVersionId}`,
          approvedByUserId: line.approvedByUserId ?? version.actorId,
          tierAllocationDiscounts: priced.tierAllocationDiscounts,
        },
      });
    }
    lines.push(priced);
  }
  return { ...sale, lines } as T;
}
