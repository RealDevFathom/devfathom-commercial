import 'server-only';

import { createHash, randomUUID } from 'node:crypto';
import type { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { packConversions } from '../pack-conversion';
import { isLegacyControlledClass } from './legacy-class';
import { catalogueNormalizer } from './staged-creation';
import shipped from './starter-package';
import type { StarterProduct } from './starter-reference';

export const STARTER_BATCH_SIZE = 250;

// The validated release artifact is read-only; metadata participates in the resume hash.
function referenceSnapshot(rows: typeof shipped) {
  const hash = createHash('sha256').update(JSON.stringify(rows)).digest('hex');
  const legacyCounts = new Map<string, number>();
  for (const { legacyCode } of rows) {
    if (legacyCode) legacyCounts.set(legacyCode, (legacyCounts.get(legacyCode) ?? 0) + 1);
  }
  return { rows, hash, legacyCounts };
}
const snapshot = referenceSnapshot(shipped);
export const starterProductCount = snapshot?.rows.length ?? 0;

async function existingProducts(
  db: ScopedDb,
  organizationId: string,
  rows: StarterProduct[],
  normalized: (value: string) => string
) {
  // Native Abuzar imports qualify each literal ICode; older links can store it bare.
  const sources = await db.$queryRaw<{ sourceId: string; medicineId: string }[]>`
    SELECT ids."sourceId", l."medicineId"
    FROM unnest(${rows.map((row) => row.sourceId)}::text[]) AS ids("sourceId")
    JOIN pharmacy_staged_medicine_links l ON l."organizationId"=${organizationId}
      AND l."sourceKey" IN (ids."sourceId", 'abuzar-item:' || ids."sourceId")
    JOIN pharmacy_migration_batches b ON b."organizationId"=l."organizationId" AND b.id=l."batchId"
    JOIN pharmacy_migration_sources s ON s."organizationId"=b."organizationId" AND s.id=b."sourceId"
    WHERE s.kind='ABUZAR' AND l."medicineId" IS NOT NULL`;
  const sourceIds = new Map<string, string>();
  for (const { sourceId, medicineId } of sources) {
    const existing = sourceIds.get(sourceId);
    if (existing !== undefined && existing !== medicineId)
      throw new Error('Ambiguous Abuzar starter identity.');
    sourceIds.set(sourceId, medicineId);
  }
  const codes = rows.flatMap((r) =>
    r.legacyCode && !sourceIds.has(r.sourceId) ? [r.legacyCode] : []
  );
  // An old code is only a fallback on an unbound local record. A medicine created in
  // an earlier batch can share CustomICode with another ICode and is never a candidate.
  const aliases = codes.length
    ? await db.$queryRaw<{ value: string; medicineId: string }[]>`
    SELECT a.value,a."medicineId" FROM pharmacy_medicine_aliases a
    WHERE a."organizationId"=${organizationId} AND a.type='LEGACY_CODE'
      AND a."normalizedValue" = ANY(${codes.map(normalized)}::text[]) AND a.value = ANY(${codes}::text[])
      AND NOT EXISTS (SELECT 1 FROM pharmacy_starter_identities i
        WHERE i."organizationId"=a."organizationId" AND i."medicineId"=a."medicineId")
      AND NOT EXISTS (
        SELECT 1 FROM pharmacy_staged_medicine_links l
        JOIN pharmacy_migration_batches b ON b."organizationId"=l."organizationId" AND b.id=l."batchId"
        JOIN pharmacy_migration_sources s ON s."organizationId"=b."organizationId" AND s.id=b."sourceId"
        WHERE l."organizationId"=a."organizationId" AND l."medicineId"=a."medicineId" AND s.kind='ABUZAR'
      )`
    : [];
  const byCode = new Map<string, string[]>();
  for (const alias of aliases) {
    const list = byCode.get(alias.value) ?? [];
    list.push(alias.medicineId);
    byCode.set(alias.value, list);
  }
  const ids = new Map<string, string>();
  for (const row of rows) {
    const aliases = row.legacyCode ? byCode.get(row.legacyCode) : undefined;
    const source = sourceIds.get(row.sourceId);
    if (source) ids.set(row.sourceId, source);
    else if (aliases?.length) {
      if (aliases.length !== 1 || snapshot?.legacyCounts.get(row.legacyCode!) !== 1)
        throw new Error('Ambiguous legacy code in starter import. Source identity required.');
      ids.set(row.sourceId, aliases[0]!);
    }
  }
  // Serialize the read/compare with approved catalogue edits while touching only matched medicines.
  if (ids.size)
    await db.$queryRaw`SELECT id FROM pharmacy_medicines WHERE "organizationId"=${organizationId}
    AND id = ANY(${[...ids.values()]}::text[]) ORDER BY id FOR UPDATE`;
  const existing = await db.medicine.findMany({
    where: { organizationId, id: { in: [...ids.values()] } },
    include: {
      presentations: { include: { packLevels: true } },
      aliases: { where: { type: 'GENERIC' } },
    },
  });
  return { ids, medicines: new Map(existing.map((m) => [m.id, m])) };
}

/** Called only by the worker, inside a single tenant transaction. The cursor commits with its rows. */
export async function loadStarterBatch(db: ScopedDb, organizationId: string) {
  if (!snapshot) return 0;
  const [run] = await db.$queryRaw<{ processed: number; catalogueHash: string | null }[]>`
    SELECT processed,"catalogueHash" FROM pharmacy_starter_imports
    WHERE "organizationId"=${organizationId} AND "completedAt" IS NULL FOR UPDATE SKIP LOCKED`;
  if (!run) return 0;
  if (run.catalogueHash && snapshot.hash !== run.catalogueHash)
    throw new Error('Starter catalogue changed during an unfinished import.');
  const rows = snapshot.rows.slice(run.processed, run.processed + STARTER_BATCH_SIZE);
  const normalized = await catalogueNormalizer(
    db,
    rows.flatMap((r) => [r.legacyCode, r.verifiedGeneric].filter((s): s is string => !!s))
  );
  const existing = await existingProducts(db, organizationId, rows, normalized);
  const medicines: Prisma.MedicineCreateManyInput[] = [];
  const presentations: Prisma.PresentationCreateManyInput[] = [];
  const packs: Prisma.PackLevelCreateManyInput[] = [];
  const aliases: Prisma.MedicineAliasCreateManyInput[] = [];
  const identities: Prisma.PharmacyStarterIdentityCreateManyInput[] = [];
  const conflicts: Prisma.PharmacyStarterConflictCreateManyInput[] = [];
  const controlled: string[] = [];
  let editsKept = 0;
  const now = new Date();
  for (const row of rows) {
    const medicineId = existing.ids.get(row.sourceId) ?? randomUUID();
    identities.push({
      organizationId,
      sourceId: row.sourceId,
      medicineId,
      narcoticsReview: isLegacyControlledClass(row.class),
    });
    const local = existing.medicines.get(medicineId);
    if (local) {
      const differences = conflicts.length;
      const compare = (field: string, oldValue: string, newValue: string) => {
        if (oldValue !== newValue)
          conflicts.push({
            organizationId,
            sourceId: row.sourceId,
            field,
            existingValue: oldValue,
            starterValue: newValue,
          });
      };
      compare('active', String(local.saleable), String(row.active));
      compare('controlled', String(local.controlled), String(row.controlled));
      if (row.controlled && !local.controlled) controlled.push(local.id);
      const sizes = new Set(
        local.presentations.flatMap((p) => {
          const roots = new Set(p.packLevels.filter((l) => !l.parentPackLevelId).map((l) => l.id));
          return packConversions(p.packLevels, now)
            .filter((c) => roots.has(c.packLevelId))
            .map((c) => c.canonicalUnitsPerPack);
        })
      );
      if (row.packSize !== null && sizes.size && !sizes.has(row.packSize))
        compare('packSize', [...sizes].sort((a, b) => a - b).join(', '), String(row.packSize));
      if (
        conflicts.length > differences ||
        local.productName !== row.name ||
        (local.manufacturer && local.manufacturer !== row.manufacturerLabel) ||
        local.aliases.some((a) => a.value !== row.verifiedGeneric)
      )
        editsKept++;
      continue;
    }
    const presentationId = randomUUID();
    medicines.push({
      id: medicineId,
      organizationId,
      productName: row.name,
      manufacturer: row.manufacturerLabel,
      productFamily: 'PHARMACEUTICAL',
      saleable: row.active,
      controlled: row.controlled,
    });
    presentations.push({
      id: presentationId,
      organizationId,
      medicineId,
      presentation:
        row.packSize === null
          ? 'Pack size not recorded'
          : `${row.packSize} unit${row.packSize === 1 ? '' : 's'} per pack`,
    });
    if (row.packSize !== null)
      packs.push({
        organizationId,
        presentationId,
        versionGroupId: randomUUID(),
        version: 1,
        level: row.packSize === 1 ? 'UNIT' : 'BOX',
        unitsPerParent: row.packSize,
        effectiveFrom: now,
      });
    for (const [type, value] of [
      ['LEGACY_CODE', row.legacyCode],
      ['GENERIC', row.verifiedGeneric],
    ] as const) {
      if (value && normalized(value))
        aliases.push({
          organizationId,
          medicineId,
          type,
          value,
          normalizedValue: normalized(value),
        });
    }
  }
  await db.medicine.createMany({ data: medicines });
  await db.presentation.createMany({ data: presentations });
  await db.packLevel.createMany({ data: packs });
  await db.medicineAlias.createMany({ data: aliases });
  if (controlled.length)
    await db.medicine.updateMany({
      where: { organizationId, id: { in: controlled }, controlled: false },
      data: { controlled: true },
    });
  await db.pharmacyStarterIdentity.createMany({ data: identities });
  await db.pharmacyStarterConflict.createMany({ data: conflicts });
  const processed = run.processed + rows.length;
  const complete = processed === snapshot.rows.length;
  const result = await db.pharmacyStarterImport.update({
    where: { organizationId },
    data: {
      catalogueHash: snapshot.hash,
      total: snapshot.rows.length,
      processed,
      added: { increment: medicines.length },
      matched: { increment: rows.length - medicines.length },
      editsKept: { increment: editsKept },
      progressedAt: now,
      completedAt: complete ? now : null,
    },
  });
  if (complete)
    await db.auditLog.create({
      data: {
        organizationId,
        actorType: 'SYSTEM',
        source: 'SYSTEM',
        category: 'PHARMACY',
        operation: 'CREATE',
        action: 'pharmacy.starterCatalogue.loaded',
        description: 'Loaded the starter medicine catalogue during pharmacy setup.',
        result: {
          processed,
          added: result.added,
          matched: result.matched,
          editsKept: result.editsKept,
          catalogueHash: snapshot.hash,
        },
      },
    });
  return rows.length;
}
