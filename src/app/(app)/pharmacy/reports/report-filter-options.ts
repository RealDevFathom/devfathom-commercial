import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { formatReportDate, type ReportFilterOption } from './report-helpers';

export const REPORT_FILTER_OPTION_LIMIT = 500;

export type ReportFilterOptions = {
  suppliers: ReportFilterOption[];
  ingredients: ReportFilterOption[];
  batches: ReportFilterOption[];
  /** False when the option lists could not be read; pickers then keep only the current value. */
  available: boolean;
};

const EMPTY: ReportFilterOptions = { suppliers: [], ingredients: [], batches: [], available: false };

type FilterOptionDb = Pick<ScopedDb, 'pharmacySupplier' | 'ingredient' | 'pharmacyManufacturingBatch'>;

/**
 * Names for the supplier, ingredient and batch report filters. Reads through the
 * page's tenant-scoped database client and repeats the organization predicate;
 * the pickers submit the same IDs the filters accepted before.
 */
export async function loadReportFilterOptions(
  db: FilterOptionDb | null | undefined,
  organizationId: string | null | undefined
): Promise<ReportFilterOptions> {
  if (!db || !organizationId) return EMPTY;
  try {
    const [suppliers, ingredients, batches] = await Promise.all([
      db.pharmacySupplier.findMany({
        where: { organizationId },
        orderBy: { name: 'asc' },
        take: REPORT_FILTER_OPTION_LIMIT,
        select: { id: true, name: true, active: true },
      }),
      db.ingredient.findMany({
        where: { organizationId },
        orderBy: { name: 'asc' },
        take: REPORT_FILTER_OPTION_LIMIT,
        select: { id: true, name: true },
      }),
      db.pharmacyManufacturingBatch.findMany({
        where: { organizationId },
        orderBy: [{ medicine: { productName: 'asc' } }, { batchNumber: 'asc' }],
        take: REPORT_FILTER_OPTION_LIMIT,
        select: {
          id: true,
          batchNumber: true,
          expiresAt: true,
          medicine: { select: { productName: true } },
        },
      }),
    ]);
    return {
      suppliers: suppliers.map((supplier) => ({
        id: supplier.id,
        label: supplier.active ? supplier.name : `${supplier.name} (inactive)`,
      })),
      ingredients: ingredients.map((ingredient) => ({ id: ingredient.id, label: ingredient.name })),
      batches: batches.map((batch) => ({
        id: batch.id,
        label: `${batch.medicine?.productName ?? 'Medicine'} · batch ${batch.batchNumber} · expires ${formatReportDate(
          batch.expiresAt.toISOString().slice(0, 10)
        )}`,
      })),
      available: true,
    };
  } catch {
    // Pickers degrade to "All"; report reads are unaffected.
    return EMPTY;
  }
}
