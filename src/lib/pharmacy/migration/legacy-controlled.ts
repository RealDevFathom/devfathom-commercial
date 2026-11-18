import { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import {
  LEGACY_CONTROLLED_CLASS,
  isLegacyControlledRow,
  legacyProductNameKey,
} from './legacy-class';

type LegacyRow = { productName: string | null; rawPayload: unknown };
type Db = Pick<ScopedDb, '$queryRaw'>;

/**
 * Database twin of `legacyProductNameKey`: trimmed, inner whitespace collapsed, case-folded.
 * Both sides of every match use it, so `Synthetic  Opioid` and `synthetic opioid` are one name.
 */
const nameKey = (column: Prisma.Sql) =>
  Prisma.sql`regexp_replace(lower(btrim(${column})), '\\s+', ' ', 'g')`;

/**
 * DEV-854: applies the legacy NARCOTICS class to catalogue medicines that already exist when a
 * file is staged. Every medicine whose product name matches a NARCOTICS-class row becomes
 * controlled at once, with no review hold. The flag only ever tightens: rows outside the class
 * never set or clear anything, and a wrong flag is corrected through the catalogue edit path.
 *
 * Medicines created after staging get the same rule from `applyLegacyControlledToMedicine`.
 */
export async function applyLegacyControlledClass(
  db: Db,
  organizationId: string,
  rows: readonly LegacyRow[]
) {
  const controlledRows = rows.filter((row) => isLegacyControlledRow(row.rawPayload));
  const keys = [
    ...new Set(
      controlledRows
        .map((row) => (row.productName ? legacyProductNameKey(row.productName) : ''))
        .filter(Boolean)
    ),
  ];
  if (!keys.length) return { controlledRows: controlledRows.length, medicineIds: [] as string[] };
  const flagged = await db.$queryRaw<{ id: string }[]>`
    UPDATE "pharmacy_medicines"
       SET "controlled" = true, "updatedAt" = CURRENT_TIMESTAMP
     WHERE "organizationId" = ${organizationId}
       AND "controlled" = false
       AND ${nameKey(Prisma.sql`"productName"`)} = ANY(${keys}::text[])
     RETURNING "id"`;
  return {
    controlledRows: controlledRows.length,
    medicineIds: flagged.map((row) => row.id).sort(),
  };
}

/** True when this organization has staged a NARCOTICS-class legacy row with this product name. */
export async function hasStagedLegacyControlledRow(
  db: Db,
  organizationId: string,
  productName: string
): Promise<boolean> {
  const key = legacyProductNameKey(productName);
  if (!key) return false;
  const found = await db.$queryRaw<{ found: boolean }[]>`
    SELECT EXISTS (
      SELECT 1
        FROM "pharmacy_migration_rows" r
        CROSS JOIN LATERAL jsonb_each_text(
          CASE WHEN jsonb_typeof(r."rawPayload") = 'object' THEN r."rawPayload" ELSE '{}'::jsonb END
        ) AS cell(header, value)
       WHERE r."organizationId" = ${organizationId}
         AND ${nameKey(Prisma.sql`r."productName"`)} = ${key}
         AND regexp_replace(lower(cell.header), '[^a-z0-9]', '', 'g') IN ('classname', 'class')
         AND upper(btrim(cell.value)) = ${LEGACY_CONTROLLED_CLASS}
    ) AS "found"`;
  return Boolean(found[0]?.found);
}

/**
 * DEV-854: the shared rule for a medicine created or matched by any import AFTER its legacy file
 * was staged (the manual reference import today, a "create products from staged rows" step later).
 * Call it in the same transaction, right after the medicine is created or updated. When a
 * NARCOTICS-class legacy row with the same product name has been staged, the medicine becomes
 * controlled at once, with no review hold. It never clears the flag. Returns whether it set it.
 */
export async function applyLegacyControlledToMedicine(
  db: Db & Pick<ScopedDb, 'medicine'>,
  organizationId: string,
  medicine: { id: string; productName?: string | null; controlled?: boolean | null }
): Promise<boolean> {
  if (medicine.controlled || !medicine.productName) return false;
  if (!(await hasStagedLegacyControlledRow(db, organizationId, medicine.productName))) return false;
  await db.medicine.update({ where: { id: medicine.id }, data: { controlled: true } });
  return true;
}
