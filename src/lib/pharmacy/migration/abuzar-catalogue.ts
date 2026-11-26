import 'server-only';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import {
  columns,
  packUnits,
  amountMinor,
  type Row,
  type Prepared,
} from '../../../../tools/abuzar-import/prepared';
import { profileTable, type SourceProfiler } from './profiler';
import { recordSource, persistProfile } from './workbench';
const profiler: SourceProfiler = {
  kind: 'ABUZAR',
  version: 'abuzar/2',
  resolveColumns: () => ({ sourceKey: 0, product: 2, pack: 3, mrp: 6, cost: 7 }),
  duplicateDiscriminator: (row) => row.sourceKey,
};
export function profileAbuzarProducts(products: Row<'products'>[]) {
  const counts = new Map<string, number>();
  for (const p of products) counts.set(p.CustomICode, (counts.get(p.CustomICode) ?? 0) + 1);
  const result = profileTable(profiler, {
    headers: [...columns.products],
    rows: products.map((p) => columns.products.map((k) => p[k])),
  });
  for (const [i, row] of result.rows.entries()) {
    const p = products[i]!;
    row.sourceKey = 'abuzar-item:' + p.ICode;
    row.targetNaturalKey = row.sourceKey;
    row.rawPayload.LegacyCode = p.CustomICode;
    row.rawPayload.__abuzar_unique_legacy = String(counts.get(p.CustomICode) === 1);
  }
  return result;
}

/** A commit stages the source for the existing independent pharmacist review. */
export async function catalogueDecision(db: ScopedDb, org: string, data: Prepared) {
  const bytes = Buffer.from(JSON.stringify(data.tables.products));
  const { createHash } = await import('node:crypto');
  const contentHash = createHash('sha256').update(bytes).digest('hex');
  const previous = await db.pharmacyMigrationBatch.findFirst({
    where: {
      organizationId: org,
      profilerVersion: profiler.version,
      source: { kind: 'ABUZAR', contentHash },
      status: 'PROFILED',
    },
    select: { id: true },
  });
  const rows = data.tables.products.map((p, index) => {
    let reason: string | null = null;
    if (previous) reason = 'already staged for catalogue review';
    else if (!p.Name || !packUnits(p.PackUnits) || !['0', '1'].includes(p.Active))
      reason = 'invalid catalogue name, pack size or active flag';
    else if (
      [p.PurPrice, p.SalePrice].some(
        (value) =>
          value &&
          (amountMinor(value) === null ||
            amountMinor(value)! < BigInt(0) ||
            amountMinor(value)! > BigInt(2147483647))
      )
    )
      reason = 'invalid catalogue price';
    return { row: p, index: index + 2, reason };
  });
  return {
    rows,
    apply: async () => {
      const source = await recordSource(db, { kind: 'ABUZAR', fileName: 'products.csv', bytes });
      const result = profileAbuzarProducts(data.tables.products);
      // Exceptions use original source row positions. Keep invalid rows as evidence, ineligible for creation.
      for (const [i, decision] of rows.entries())
        if (decision.reason) result.rows[i]!.productName = null;
      return persistProfile(db, {
        sourceId: source.id,
        label: 'Imported from Abuzar',
        profiler,
        result,
      });
    },
  };
}

type Identity = { sourceId: string; legacyCode: string | null; uniqueLegacy: boolean };
export async function abuzarMedicines(db: ScopedDb, organizationId: string, items: Identity[]) {
  type Match = {
    sourceId: string;
    key: string;
    medicineId: string;
    productName: string;
    controlled: boolean;
    packLevelId: string | null;
  };
  if (!items.length) return new Map<string, Match | null>();
  const found = await db.$queryRaw<Match[]>`
    WITH wanted AS (SELECT * FROM jsonb_to_recordset(${JSON.stringify(items)}::jsonb) AS w("sourceId" text,"legacyCode" text,"uniqueLegacy" boolean)),
    bindings AS (
      SELECT "sourceId","medicineId" FROM pharmacy_starter_identities WHERE "organizationId"=${organizationId}
      UNION ALL
      SELECT regexp_replace(l."sourceKey",'^abuzar-item:',''),l."medicineId" FROM pharmacy_staged_medicine_links l
        JOIN pharmacy_migration_batches b ON b."organizationId"=l."organizationId" AND b.id=l."batchId"
        JOIN pharmacy_migration_sources s ON s."organizationId"=l."organizationId" AND s.id=b."sourceId"
        WHERE l."organizationId"=${organizationId} AND l."medicineId" IS NOT NULL AND s.kind='ABUZAR'
    ), matched AS (
      SELECT w."sourceId",b."medicineId" FROM wanted w JOIN bindings b USING ("sourceId")
      UNION
      SELECT w."sourceId",a."medicineId" FROM wanted w JOIN pharmacy_medicine_aliases a
        ON a."organizationId"=${organizationId} AND a.type='LEGACY_CODE' AND a.value=w."legacyCode"
        WHERE w."uniqueLegacy" AND NOT EXISTS(SELECT FROM bindings b WHERE b."sourceId"=w."sourceId" OR b."medicineId"=a."medicineId")
    ) SELECT matched.*,matched."sourceId" AS key,m."productName",m.controlled,NULL::text AS "packLevelId" FROM matched
      JOIN pharmacy_medicines m ON m."organizationId"=${organizationId} AND m.id=matched."medicineId"`;
  const map = new Map<string, (typeof found)[number] | null>();
  for (const medicine of found) {
    const prior = map.get(medicine.sourceId);
    map.set(
      medicine.sourceId,
      prior === undefined || prior?.medicineId === medicine.medicineId ? medicine : null
    );
  }
  return map;
}
