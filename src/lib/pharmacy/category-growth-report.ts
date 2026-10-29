import 'server-only';

import { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

export const PHARMACY_GROWTH_CATEGORIES = ['OTC', 'COSMETICS'] as const;
export type PharmacyGrowthCategory = (typeof PHARMACY_GROWTH_CATEGORIES)[number];

export type CategoryGrowthConfig = {
  category: PharmacyGrowthCategory;
  /** Tenant-maintained display space. Null means space productivity is unknown. */
  displaySpaceSquareMetres: number | null;
  /** Optional tenant target, not a DevFathom benchmark or asserted market fact. */
  targetSalesSharePercent: number | null;
};

export type CategoryGrowthReportInput = {
  branchIds: string[];
  from: string;
  to: string;
  configuration: CategoryGrowthConfig[];
};

export function validateCategoryGrowthConfiguration(configuration: CategoryGrowthConfig[]) {
  const categories = configuration.map((item) => item.category);
  if (new Set(categories).size !== categories.length)
    throw new Error('Configure each growth category at most once.');
  for (const item of configuration) {
    if (item.displaySpaceSquareMetres != null && item.displaySpaceSquareMetres <= 0)
      throw new Error('Display space must be greater than zero.');
    if (
      item.targetSalesSharePercent != null &&
      (item.targetSalesSharePercent < 0 || item.targetSalesSharePercent > 100)
    )
      throw new Error('Target sales share must be between zero and one hundred.');
  }
}

type CategoryTotalRow = {
  branchId: string;
  category: PharmacyGrowthCategory;
  salesMinor: bigint | number | string;
  units: bigint | number | string;
  branchSalesMinor: bigint | number | string;
};

/**
 * Branch/category growth evidence from completed receipts only. FRONT_SHOP is the catalog's
 * non-drug/cosmetics family; it takes precedence over the OTC flag so a line is never counted twice.
 * Targets and display space are caller configuration, never embedded research estimates.
 */
export async function readPharmacyCategoryGrowthReport(
  db: ScopedDb,
  organizationId: string,
  input: CategoryGrowthReportInput
) {
  validateCategoryGrowthConfiguration(input.configuration);
  const from = new Date(`${input.from}T00:00:00.000Z`);
  const cutoff = new Date(`${input.to}T00:00:00.000Z`);
  if (
    !input.branchIds.length ||
    !Number.isFinite(from.getTime()) ||
    !Number.isFinite(cutoff.getTime())
  )
    throw new Error('Choose branches and valid report dates.');
  if (from >= cutoff) throw new Error('The exclusive report cutoff must follow the start date.');

  const rows = await db.$queryRaw<CategoryTotalRow[]>(Prisma.sql`
    WITH scoped AS (
      SELECT l.*, m."productFamily", m.otc,
        SUM(l.quantity::bigint * l."unitPriceMinor" - l."discountMinor") OVER (PARTITION BY l."branchId") AS "branchSalesMinor"
      FROM pharmacy_sale_lines l
      JOIN pharmacy_sales s ON s."organizationId"=l."organizationId" AND s."branchId"=l."branchId" AND s.id=l."saleId"
      JOIN pharmacy_medicines m ON m."organizationId"=l."organizationId" AND m.id=l."medicineId"
      WHERE l."organizationId"=${organizationId} AND l."branchId" IN (${Prisma.join(input.branchIds)})
        AND s.status='COMPLETED' AND s."receiptNumber" IS NOT NULL
        AND s."completedAt">=${from} AND s."completedAt"<${cutoff}
    )
    SELECT l."branchId", CASE WHEN l."productFamily"='FRONT_SHOP' THEN 'COSMETICS' ELSE 'OTC' END AS category,
      COALESCE(SUM(l."canonicalUnits"),0) AS units,
      COALESCE(SUM(l.quantity::bigint * l."unitPriceMinor" - l."discountMinor"),0) AS "salesMinor",
      l."branchSalesMinor"
    FROM scoped l
    WHERE l."productFamily"='FRONT_SHOP' OR l.otc=true
    GROUP BY l."branchId",category,l."branchSalesMinor" ORDER BY l."branchId",category
  `);
  const config = new Map(input.configuration.map((item) => [item.category, item]));
  const byBranch = new Map<string, CategoryTotalRow[]>();
  for (const row of rows) byBranch.set(row.branchId, [...(byBranch.get(row.branchId) ?? []), row]);

  return input.branchIds.map((branchId) => {
    const branchRows = byBranch.get(branchId) ?? [];
    const totalSalesMinor = Number(branchRows[0]?.branchSalesMinor ?? 0);
    return {
      branchId,
      totalSalesMinor,
      categories: PHARMACY_GROWTH_CATEGORIES.map((category) => {
        const row = branchRows.find((item) => item.category === category);
        const salesMinor = Number(row?.salesMinor ?? 0);
        const configured = config.get(category);
        const salesSharePercent = totalSalesMinor ? (salesMinor / totalSalesMinor) * 100 : 0;
        const target = configured?.targetSalesSharePercent ?? null;
        const space = configured?.displaySpaceSquareMetres ?? null;
        return {
          category,
          salesMinor,
          units: Number(row?.units ?? 0),
          salesSharePercent,
          displaySpaceSquareMetres: space,
          salesMinorPerSquareMetre: space == null ? null : salesMinor / space,
          targetSalesSharePercent: target,
          shareGapPercentagePoints: target == null ? null : target - salesSharePercent,
        };
      }),
    };
  });
}
