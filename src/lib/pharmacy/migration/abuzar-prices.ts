import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { packConversions } from '../pack-conversion';
import { deriveLooseUnitPrice } from '../medicine';
import { amountMinor, packUnits, type Prepared } from '../../../../tools/abuzar-import/prepared';
export async function priceDecision(db: ScopedDb, org: string, data: Prepared) {
  const links = await db.$queryRaw<
    {
      sourceKey: string;
      medicineId: string;
      reviewerId: string;
      editorId: string;
      raw: Record<string, string>;
    }[]
  >`
    SELECT l."sourceKey",l."medicineId",e."reviewerId",e."editorId",r."rawPayload" AS raw
    FROM pharmacy_staged_medicine_links l JOIN pharmacy_catalogue_edits e ON e."organizationId"=l."organizationId" AND e.id=l."editId"
    JOIN pharmacy_migration_rows r ON r."organizationId"=l."organizationId" AND r.id=l."rowId"
    JOIN pharmacy_migration_batches b ON b."organizationId"=r."organizationId" AND b.id=r."batchId"
    WHERE l."organizationId"=${org} AND b."profilerVersion"='abuzar/2' AND e.status='APPROVED' AND e."reviewerId" IS NOT NULL AND l."medicineId" IS NOT NULL`;
  const source = new Map(links.map((l) => [l.sourceKey, l]));
  const meds = await db.medicine.findMany({
    where: { organizationId: org, id: { in: links.map((l) => l.medicineId) } },
    select: { id: true, presentations: { select: { id: true, packLevels: true } } },
  });
  const byId = new Map(meds.map((m) => [m.id, m]));
  const prices = await db.pharmacyPackPrice.findMany({
    where: { organizationId: org, branchId: null },
    select: { packLevelId: true },
  });
  const existingPrices = new Set(prices.map((p) => p.packLevelId));
  const details = await db.$queryRaw<
    { sourceId: string }[]
  >`SELECT "sourceId" FROM pharmacy_abuzar_product_fields WHERE "organizationId"=${org}`;
  const stored = new Set(details.map((d) => d.sourceId));
  const rows = data.tables.products.map((row, i) => {
    const link = source.get('abuzar-item:' + row.ICode),
      med = link && byId.get(link.medicineId),
      pack = packUnits(row.PackUnits);
    const packs =
      med?.presentations.flatMap((p) =>
        packConversions(p.packLevels)
          .filter(
            (c) =>
              c.canonicalUnitsPerPack === pack &&
              p.packLevels.some((l) => l.id === c.packLevelId && l.parentPackLevelId === null)
          )
          .map((c) => ({ id: c.packLevelId, presentationId: p.id }))
      ) ?? [];
    const mrp = amountMinor(row.SalePrice),
      cost = amountMinor(row.PurPrice);
    let reason: string | null = null;
    if (stored.has(row.ICode)) reason = 'already imported';
    else if (!link || !med) reason = 'catalogue approval required';
    else if (
      link.raw.SalePrice !== row.SalePrice ||
      link.raw.PurPrice !== row.PurPrice ||
      link.raw.Shelf !== row.Shelf ||
      link.raw.PackUnits !== row.PackUnits
    )
      reason = 'source differs from approved catalogue';
    else if (!pack || packs.length !== 1) reason = 'review the local pack size';
    return { row, index: i + 2, reason, link, pack, level: packs[0], mrp, cost };
  });
  return {
    rows,
    apply: async () => {
      const fields = [],
        newPrices = [];
      for (const d of rows) {
        if (d.reason || !d.link || !d.level || !d.pack) continue;
        const mrp = d.mrp && d.mrp > BigInt(0) ? Number(d.mrp) : null;
        if (mrp !== null && !existingPrices.has(d.level.id))
          newPrices.push({
            organizationId: org,
            packLevelId: d.level.id,
            presentationId: d.level.presentationId,
            mrpMinor: mrp,
            effectiveFrom: new Date(),
            source: 'import',
            createdById: d.link.reviewerId,
            proposedById: d.link.editorId,
          });
        fields.push({
          sourceId: d.row.ICode,
          medicineId: d.link.medicineId,
          shelf: d.row.Shelf || null,
          legacyCode: d.row.CustomICode || null,
          packCostMinor: d.cost === null ? null : Number(d.cost),
          packMrpMinor: mrp,
          unitMrpMinor:
            mrp === null
              ? null
              : deriveLooseUnitPrice({
                  printedMrpMinor: mrp,
                  canonicalUnitsInPack: d.pack,
                  roundingIncrementMinor: 1,
                }).unitPriceMinor,
        });
      }
      await db.pharmacyPackPrice.createMany({ data: newPrices });
      await db.$executeRaw`INSERT INTO pharmacy_abuzar_product_fields SELECT ${org},r.* FROM jsonb_to_recordset(${JSON.stringify(fields)}::jsonb) AS r("sourceId" text,"medicineId" text,shelf text,"legacyCode" text,"packCostMinor" int,"packMrpMinor" int,"unitMrpMinor" int)`;
    },
  };
}
