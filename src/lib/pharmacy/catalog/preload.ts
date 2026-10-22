import 'server-only';

import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { normalizeMedicineText } from '@/lib/pharmacy/medicine';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

export const PHARMACY_CATALOG_VERSION = 'pharmacy-catalog-v1';
export const PHARMACY_CATALOG_JOB = 'PHARMACY_CATALOG_SEED_V1' as const;
const BATCH_SIZE = 500;

const itemSchema = z
  .object({
    name: z.string().trim().min(1).max(500),
    alias: z.string().trim().min(1).max(300),
    active: z.boolean(),
    packUnits: z.string().trim().min(1).max(100),
    packQty: z.number().int().positive().max(1_000_000),
    class: z.string().trim().min(1).max(100),
    category: z.string().trim().min(1).max(200),
    defaultSalePriceMinor: z.number().int().nonnegative().max(2_147_483_647).nullable(),
    defaultPurchasePriceMinor: z.number().int().nonnegative().max(2_147_483_647).nullable(),
  })
  .strict();
export const pharmacyCatalogSchema = z
  .object({
    version: z.literal(PHARMACY_CATALOG_VERSION),
    count: z.number().int().nonnegative(),
    items: z.array(itemSchema),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.count !== value.items.length)
      ctx.addIssue({ code: 'custom', message: 'Catalog count does not match item count.' });
  });
export type PharmacyCatalog = z.infer<typeof pharmacyCatalogSchema>;

export function parsePharmacyCatalog(json: unknown): PharmacyCatalog {
  return pharmacyCatalogSchema.parse(json);
}

export async function loadBundledPharmacyCatalog(): Promise<PharmacyCatalog> {
  const bytes = await readFile(
    path.join(process.cwd(), 'prisma/seed-assets/pharmacy-catalog-v1.json.gz')
  );
  return parsePharmacyCatalog(JSON.parse(gunzipSync(bytes).toString('utf8')));
}

function id(kind: string, organizationId: string, index: number): string {
  return `cat_${kind}_${createHash('sha256').update(`${PHARMACY_CATALOG_VERSION}:${organizationId}:${index}`).digest('hex').slice(0, 24)}`;
}
function chunks<T>(rows: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += BATCH_SIZE) out.push(rows.slice(i, i + BATCH_SIZE));
  return out;
}
type Delegate = {
  findUnique(a: unknown): Promise<{ status?: unknown } | null>;
  upsert(a: unknown): Promise<unknown>;
  createMany(a: unknown): Promise<{ count: number }>;
  update(a: unknown): Promise<unknown>;
  count(a: unknown): Promise<number>;
};
function delegate(db: ScopedDb, name: string): Delegate {
  return (db as unknown as Record<string, Delegate>)[name];
}

export async function catalogSeedPreview(
  db: ScopedDb,
  organizationId: string,
  catalog: PharmacyCatalog
) {
  const ids = catalog.items.map((_, index) => id('med', organizationId, index));
  const existing = await delegate(db, 'medicine').count({
    where: { organizationId, id: { in: ids } },
  });
  return { wouldCreate: catalog.count - existing, existing, total: catalog.count };
}

/**
 * Must receive the RLS-scoped transaction handle; it never opens or imports a global client.
 *
 * Every medicine is created unsaleable and marked with its catalogue origin, whatever the
 * source row's `active` flag says (that flag is kept only as unreviewed provenance). The
 * database refuses a saleable catalogue insert, and only an explicit change with a valid
 * price can make one saleable later (see `./commercial`).
 *
 * CAT-SEC-02/03: this is the platform path (onboarding job and backfill), so it writes
 * catalogue reference rows only. It never writes a branch price, a branch setting or a
 * saleable medicine: those exist only behind the authorized tenant writers in
 * `./commercial`, and the branch tables' forced RLS refuses a session without a user
 * assigned to the branch. A branch applies the reference defaults afterwards with
 * setCatalogDefaultPrices (idempotent: it fills only what that branch has not priced).
 */
export async function seedPharmacyCatalog(
  db: ScopedDb,
  organizationId: string,
  catalog: PharmacyCatalog,
  requestedById?: string
) {
  const runDb = delegate(db, 'catalogSeedRun');
  const key = {
    organizationId_catalogVersion: { organizationId, catalogVersion: catalog.version },
  };
  const completed = await runDb.findUnique({ where: key });
  if (completed?.status === 'COMPLETED')
    return { status: 'noop' as const, created: 0, existing: catalog.count };
  await runDb.upsert({
    where: key,
    create: {
      organizationId,
      catalogVersion: catalog.version,
      expectedCount: catalog.count,
      requestedById,
    },
    update: {},
  });

  const medicines = catalog.items.map((item, i) => ({
    id: id('med', organizationId, i),
    organizationId,
    productName: item.name,
    productFamily: 'PHARMACEUTICAL',
    saleable: false,
    catalogVersion: catalog.version,
  }));
  const presentations = catalog.items.map((item, i) => ({
    id: id('pres', organizationId, i),
    organizationId,
    medicineId: id('med', organizationId, i),
    presentation: `${item.packQty} ${item.packUnits}`,
  }));
  // `level` is constrained to CARTON/BOX/STRIP/UNIT; the source unit name stays in the
  // presentation text. One provisional BOX level per item, reviewed before any sale.
  const packs = catalog.items.map((item, i) => ({
    id: id('pack', organizationId, i),
    organizationId,
    presentationId: id('pres', organizationId, i),
    versionGroupId: id('packgroup', organizationId, i),
    version: 1,
    level: 'BOX',
    unitsPerParent: item.packQty,
    effectiveFrom: new Date(0),
    // Reference values from the bundled asset. A branch applies them only through the
    // authorized setCatalogDefaultPrices writer.
    catalogDefaultSalePriceMinor: item.defaultSalePriceMinor,
    catalogDefaultPurchasePriceMinor: item.defaultPurchasePriceMinor,
  }));
  // Aliases carry the canonical normalization; the alias trigger recomputes and compares it.
  const aliases = catalog.items.map((item, i) => ({
    id: id('alias', organizationId, i),
    organizationId,
    medicineId: id('med', organizationId, i),
    type: 'LEGACY_CODE',
    value: item.alias,
    normalizedValue: normalizeMedicineText(item.alias),
  }));
  const provenance = catalog.items.flatMap((item, i) => [
    {
      id: id('prov', organizationId, i),
      organizationId,
      medicineId: id('med', organizationId, i),
      field: 'catalog',
      source: catalog.version,
      sourceType: 'IMPORT',
      retrievedAt: new Date(),
      status: 'UNREVIEWED',
      assertedValue: { category: item.category, active: item.active },
    },
    ...(['NARCOTICS', 'FRIDGE'].includes(item.class.toUpperCase())
      ? [
          {
            id: id('hint', organizationId, i),
            organizationId,
            medicineId: id('med', organizationId, i),
            field: 'classHint',
            source: catalog.version,
            sourceType: 'IMPORT',
            retrievedAt: new Date(),
            status: 'UNREVIEWED',
            assertedValue: item.class,
          },
        ]
      : []),
  ]);
  const tables: ReadonlyArray<readonly [string, readonly object[]]> = [
    ['medicine', medicines],
    ['presentation', presentations],
    ['packLevel', packs],
    ['medicineAlias', aliases],
    ['medicineProvenance', provenance],
  ];
  for (const [name, rows] of tables) {
    for (const batch of chunks(rows))
      await delegate(db, name).createMany({ data: batch, skipDuplicates: true });
  }
  const medicineCount = await delegate(db, 'medicine').count({
    where: { organizationId, id: { in: medicines.map((row) => row.id) } },
  });
  if (medicineCount !== catalog.count)
    throw new Error('Catalog seed incomplete; the resumable run remains pending.');
  await runDb.update({
    where: key,
    data: { status: 'COMPLETED', createdCount: medicineCount, completedAt: new Date() },
  });
  return {
    status: 'completed' as const,
    created: medicineCount,
    existing: catalog.count - medicineCount,
  };
}
