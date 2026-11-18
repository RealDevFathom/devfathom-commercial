import { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import {
  LEGACY_CONTROLLED_CLASS,
  LEGACY_WHITESPACE_RUN,
  isLegacyControlledRow,
  legacyProductNameKey,
} from './legacy-class';

type LegacyRow = { productName: string | null; rawPayload: unknown };
type Db = Pick<ScopedDb, '$queryRaw'>;

/** SQL twin of `normalizeLegacyText`: the same whitespace rule as the code (DEV-925). */
const normalizedText = (column: Prisma.Sql) =>
  Prisma.sql`btrim(regexp_replace(${column}, ${LEGACY_WHITESPACE_RUN}, ' ', 'g'), ' ')`;

/**
 * Database twin of `legacyProductNameKey`: trimmed, inner whitespace collapsed, case-folded.
 * Both sides of every match use it, so `Synthetic  Opioid` and `synthetic opioid` are one name.
 */
const nameKey = (column: Prisma.Sql) => Prisma.sql`lower(${normalizedText(column)})`;

/**
 * DEV-925: true when a person's latest approved catalogue edit of this medicine's controlled
 * flag set it to "not controlled". Approved catalogue edits are retained and immutable, so the
 * correction is remembered and the legacy NARCOTICS class never sets the flag back. Only an
 * approval made under the catalogue review grant counts: its append-only audit record says
 * `controlledReviewed`. Any other approval is ignored, so the import flags the medicine again.
 */
const correctedNotControlled = (organizationId: string, medicineId: Prisma.Sql) => Prisma.sql`
  COALESCE((
    SELECT e."changes" -> 'controlled' = 'false'::jsonb
      FROM "pharmacy_catalogue_edits" e
     WHERE e."organizationId" = ${organizationId}
       AND e."medicineId" = ${medicineId}
       AND e."status" = 'APPROVED'
       AND e."operation" = 'UPDATE_MEDICINE'
       AND jsonb_typeof(e."changes" -> 'controlled') = 'boolean'
       AND EXISTS (
         SELECT 1
           FROM "audit_logs" a
          WHERE a."organizationId" = ${organizationId}
            AND a."targetType" = 'PharmacyCatalogueEdit'
            AND a."targetId" = e."id"
            AND a."action" IN ('pharmacy.catalogueApproval', 'pharmacy.catalogueSoloOwnerApproval')
            AND a."metadata" ->> 'controlledReviewed' = 'true'
       )
     ORDER BY e."reviewedAt" DESC NULLS LAST, e."createdAt" DESC, e."id" DESC
     LIMIT 1
  ), false)`;

/**
 * DEV-854: applies the legacy NARCOTICS class to catalogue medicines that already exist when a
 * file is staged. Every medicine whose product name matches a NARCOTICS-class row becomes
 * controlled at once, with no review hold. The flag only ever tightens: rows outside the class
 * never set or clear anything, and a wrong flag is corrected through the catalogue edit path.
 * A medicine a person has corrected to "not controlled" is left alone (DEV-925); the rows that
 * name it are counted in `skippedCorrectedRows`.
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
  if (!keys.length)
    return {
      controlledRows: controlledRows.length,
      medicineIds: [] as string[],
      skippedCorrectedRows: 0,
    };
  // One statement: flag every matching medicine nobody has corrected, and report the name of
  // each matching medicine a person has corrected (left unflagged).
  const result = await db.$queryRaw<{ id: string; correctedKey?: string | null }[]>`
    WITH matched AS (
      SELECT m."id",
             ${nameKey(Prisma.sql`m."productName"`)} AS "key",
             ${correctedNotControlled(organizationId, Prisma.sql`m."id"`)} AS "corrected"
        FROM "pharmacy_medicines" m
       WHERE m."organizationId" = ${organizationId}
         AND m."controlled" = false
         AND ${nameKey(Prisma.sql`m."productName"`)} = ANY(${keys}::text[])
    ), flagged AS (
      UPDATE "pharmacy_medicines" p
         SET "controlled" = true, "updatedAt" = CURRENT_TIMESTAMP
        FROM matched
       WHERE p."organizationId" = ${organizationId}
         AND p."id" = matched."id"
         AND p."controlled" = false
         AND NOT matched."corrected"
      RETURNING p."id"
    )
    SELECT flagged."id", NULL::text AS "correctedKey" FROM flagged
    UNION ALL
    SELECT matched."id", matched."key" AS "correctedKey" FROM matched WHERE matched."corrected"`;
  const correctedKeys = new Set(
    result.flatMap((row) => (row.correctedKey ? [row.correctedKey] : []))
  );
  return {
    controlledRows: controlledRows.length,
    medicineIds: result
      .filter((row) => !row.correctedKey)
      .map((row) => row.id)
      .sort(),
    skippedCorrectedRows: controlledRows.filter(
      (row) => row.productName && correctedKeys.has(legacyProductNameKey(row.productName))
    ).length,
  };
}

/**
 * DEV-925: true when a person's latest approved catalogue edit set this medicine to "not
 * controlled". An import (the manual file connector) checks it before writing a class-derived
 * controlled flag onto an existing medicine.
 */
export async function hasControlledCorrection(
  db: Db,
  organizationId: string,
  medicineId: string
): Promise<boolean> {
  const rows = await db.$queryRaw<{ corrected: boolean }[]>`
    SELECT ${correctedNotControlled(organizationId, Prisma.sql`${medicineId}`)} AS "corrected"`;
  return Boolean(rows[0]?.corrected);
}

/**
 * True when this organization has staged a NARCOTICS-class legacy row with this product name.
 * With `medicineId`, also false when a person has corrected that medicine to "not controlled".
 */
export async function hasStagedLegacyControlledRow(
  db: Db,
  organizationId: string,
  productName: string,
  medicineId?: string
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
         AND upper(${normalizedText(Prisma.sql`cell.value`)}) = ${LEGACY_CONTROLLED_CLASS}
    ) ${
      medicineId
        ? Prisma.sql`AND NOT ${correctedNotControlled(organizationId, Prisma.sql`${medicineId}`)}`
        : Prisma.empty
    } AS "found"`;
  return Boolean(found[0]?.found);
}

/**
 * DEV-854: the shared rule for a medicine created or matched by any import AFTER its legacy file
 * was staged (the manual reference import today, a "create products from staged rows" step later).
 * Call it in the same transaction, right after the medicine is created or updated. When a
 * NARCOTICS-class legacy row with the same product name has been staged, the medicine becomes
 * controlled at once, with no review hold. It never clears the flag, and it leaves alone a
 * medicine a person has corrected to "not controlled" (DEV-925). Returns whether it set it.
 */
export async function applyLegacyControlledToMedicine(
  db: Db & Pick<ScopedDb, 'medicine'>,
  organizationId: string,
  medicine: { id: string; productName?: string | null; controlled?: boolean | null }
): Promise<boolean> {
  if (medicine.controlled || !medicine.productName) return false;
  if (!(await hasStagedLegacyControlledRow(db, organizationId, medicine.productName, medicine.id)))
    return false;
  await db.medicine.update({ where: { id: medicine.id }, data: { controlled: true } });
  return true;
}
