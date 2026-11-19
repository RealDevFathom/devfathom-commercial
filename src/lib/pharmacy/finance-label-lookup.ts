import 'server-only';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { batchLabel, type LedgerLabels } from './finance-labels';

type Ids = Partial<Record<keyof LedgerLabels, readonly (string | null | undefined)[]>>;

function unique(values: readonly (string | null | undefined)[] | undefined) {
  return [...new Set((values ?? []).filter((value): value is string => !!value))];
}

/**
 * Resolves ledger dimension ids to names, organization-scoped in the query as
 * well as by row level security. Ids that do not resolve are simply absent, so
 * the screen can say the name is not recorded instead of guessing.
 */
export async function loadLedgerLabels(
  db: ScopedDb,
  organizationId: string,
  ids: Ids
): Promise<LedgerLabels> {
  const branchIds = unique(ids.branches);
  const lotIds = unique(ids.lots);
  const batchIds = unique(ids.batches);
  const medicineIds = unique(ids.medicines);
  const locationIds = unique(ids.locations);
  const batchSelect = {
    id: true,
    batchNumber: true,
    medicine: { select: { productName: true } },
  } as const;
  const [branches, lots, batches, medicines, locations] = await Promise.all([
    branchIds.length
      ? db.pharmacyBranch.findMany({
          where: { organizationId, id: { in: branchIds } },
          select: { id: true, name: true },
        })
      : [],
    lotIds.length
      ? db.pharmacyInventoryLot.findMany({
          where: { organizationId, id: { in: lotIds } },
          select: { id: true, batch: { select: batchSelect } },
        })
      : [],
    batchIds.length
      ? db.pharmacyManufacturingBatch.findMany({
          where: { organizationId, id: { in: batchIds } },
          select: batchSelect,
        })
      : [],
    medicineIds.length
      ? db.medicine.findMany({
          where: { organizationId, id: { in: medicineIds } },
          select: { id: true, productName: true },
        })
      : [],
    locationIds.length
      ? db.pharmacyStockLocation.findMany({
          where: { organizationId, id: { in: locationIds } },
          select: { id: true, name: true },
        })
      : [],
  ]);
  const batchName = (batch: {
    batchNumber: string | null;
    medicine: { productName: string } | null;
  }) => batchLabel({ batchNumber: batch.batchNumber, medicineName: batch.medicine?.productName });
  return {
    branches: Object.fromEntries(branches.map((row) => [row.id, row.name])),
    lots: Object.fromEntries(lots.map((row) => [row.id, batchName(row.batch)])),
    batches: Object.fromEntries(batches.map((row) => [row.id, batchName(row)])),
    medicines: Object.fromEntries(medicines.map((row) => [row.id, row.productName])),
    locations: Object.fromEntries(locations.map((row) => [row.id, row.name])),
  };
}
