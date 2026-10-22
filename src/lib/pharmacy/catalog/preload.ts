import 'server-only';

import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

export const PHARMACY_CATALOG_VERSION = 'pharmacy-catalog-v1';
export const PHARMACY_CATALOG_JOB = 'PHARMACY_CATALOG_SEED_V1' as const;
const BATCH_SIZE = 500;

const itemSchema = z.object({
  name: z.string().trim().min(1).max(500),
  alias: z.string().trim().min(1).max(300),
  active: z.boolean(),
  packUnits: z.string().trim().min(1).max(100),
  packQty: z.number().int().positive().max(1_000_000),
  class: z.string().trim().min(1).max(100),
  category: z.string().trim().min(1).max(200),
  defaultSalePriceMinor: z.number().int().nonnegative().max(2_147_483_647).nullable(),
  defaultPurchasePriceMinor: z.number().int().nonnegative().max(2_147_483_647).nullable(),
}).strict();
export const pharmacyCatalogSchema = z.object({
  version: z.literal(PHARMACY_CATALOG_VERSION),
  count: z.number().int().nonnegative(),
  items: z.array(itemSchema),
}).strict().superRefine((value, ctx) => {
  if (value.count !== value.items.length) ctx.addIssue({ code: 'custom', message: 'Catalog count does not match item count.' });
});
export type PharmacyCatalog = z.infer<typeof pharmacyCatalogSchema>;

export function parsePharmacyCatalog(json: unknown): PharmacyCatalog {
  return pharmacyCatalogSchema.parse(json);
}

export async function loadBundledPharmacyCatalog(): Promise<PharmacyCatalog> {
  const bytes = await readFile(path.join(process.cwd(), 'prisma/seed-assets/pharmacy-catalog-v1.json.gz'));
  return parsePharmacyCatalog(JSON.parse(gunzipSync(bytes).toString('utf8')));
}

function id(kind: string, organizationId: string, index: number): string {
  return `cat_${kind}_${createHash('sha256').update(`${PHARMACY_CATALOG_VERSION}:${organizationId}:${index}`).digest('hex').slice(0, 24)}`;
}
function normalized(value: string): string { return value.normalize('NFKC').trim().toLocaleLowerCase('en-US'); }
function chunks<T>(rows: T[]): T[][] { const out: T[][] = []; for (let i = 0; i < rows.length; i += BATCH_SIZE) out.push(rows.slice(i, i + BATCH_SIZE)); return out; }
type Delegate = { findUnique(a: unknown): Promise<any>; upsert(a: unknown): Promise<any>; createMany(a: unknown): Promise<{count:number}>; update(a: unknown): Promise<any>; count(a: unknown): Promise<number>; findMany(a: unknown): Promise<any[]>; updateMany(a: unknown): Promise<{count:number}>; create(a: unknown): Promise<any> };
function delegate(db: ScopedDb, name: string): Delegate { return (db as unknown as Record<string, Delegate>)[name]; }

export async function catalogSeedPreview(db: ScopedDb, organizationId: string, catalog: PharmacyCatalog) {
  const ids = catalog.items.map((_, index) => id('med', organizationId, index));
  const existing = await delegate(db, 'medicine').count({ where: { organizationId, id: { in: ids } } });
  return { wouldCreate: catalog.count - existing, existing, total: catalog.count };
}

/** Must receive the RLS-scoped transaction handle; it never opens or imports a global client. */
export async function seedPharmacyCatalog(db: ScopedDb, organizationId: string, catalog: PharmacyCatalog, requestedById?: string) {
  const runDb = delegate(db, 'catalogSeedRun');
  const key = { organizationId_catalogVersion: { organizationId, catalogVersion: catalog.version } };
  const completed = await runDb.findUnique({ where: key });
  if (completed?.status === 'COMPLETED') return { status: 'noop' as const, created: 0, existing: catalog.count };
  await runDb.upsert({ where: key, create: { organizationId, catalogVersion: catalog.version, expectedCount: catalog.count, requestedById }, update: {} });
  await delegate(db, 'pharmacyCatalogSetting').upsert({ where: { organizationId }, create: { organizationId, useCatalogDefaultPrices: false }, update: {} });

  const medicines = catalog.items.map((item, i) => ({ id: id('med', organizationId, i), organizationId, productName: item.name, productFamily: 'PHARMACEUTICAL', saleable: item.active }));
  const presentations = catalog.items.map((item, i) => ({ id: id('pres', organizationId, i), organizationId, medicineId: id('med', organizationId, i), presentation: `${item.packQty} ${item.packUnits}` }));
  const packs = catalog.items.map((item, i) => ({ id: id('pack', organizationId, i), organizationId, presentationId: id('pres', organizationId, i), versionGroupId: id('packgroup', organizationId, i), version: 1, level: item.packUnits, unitsPerParent: item.packQty, effectiveFrom: new Date(0), catalogDefaultSalePriceMinor: item.defaultSalePriceMinor, catalogDefaultPurchasePriceMinor: item.defaultPurchasePriceMinor, sellingPriceMinor: null, purchasePriceMinor: null }));
  const aliases = catalog.items.map((item, i) => ({ id: id('alias', organizationId, i), organizationId, medicineId: id('med', organizationId, i), type: 'LEGACY_CODE', value: item.alias, normalizedValue: normalized(item.alias) }));
  const provenance = catalog.items.flatMap((item, i) => [
    { id: id('prov', organizationId, i), organizationId, medicineId: id('med', organizationId, i), field: 'catalog', source: catalog.version, sourceType: 'IMPORT', retrievedAt: new Date(), status: 'ACCEPTED', assertedValue: { category: item.category } },
    ...(['NARCOTICS', 'FRIDGE'].includes(item.class.toUpperCase()) ? [{ id: id('hint', organizationId, i), organizationId, medicineId: id('med', organizationId, i), field: 'classHint', source: catalog.version, sourceType: 'IMPORT', retrievedAt: new Date(), status: 'UNREVIEWED', assertedValue: item.class }] : []),
  ]);
  let created = 0;
  for (const [name, rows] of [['medicine', medicines], ['presentation', presentations], ['packLevel', packs], ['medicineAlias', aliases], ['medicineProvenance', provenance]] as const) {
    for (const batch of chunks(rows)) created += (await delegate(db, name).createMany({ data: batch, skipDuplicates: true })).count;
  }
  const medicineCount = await delegate(db, 'medicine').count({ where: { organizationId, id: { in: medicines.map(row => row.id) } } });
  if (medicineCount !== catalog.count) throw new Error('Catalog seed incomplete; the resumable run remains pending.');
  await runDb.update({ where: key, data: { status: 'COMPLETED', createdCount: medicineCount, completedAt: new Date() } });
  return { status: 'completed' as const, created: medicineCount, existing: catalog.count - medicineCount };
}

export async function setCatalogDefaultPrices(db: ScopedDb, organizationId: string, actorId: string, enabled: boolean) {
  const setting = delegate(db, 'pharmacyCatalogSetting');
  await setting.upsert({ where: { organizationId }, create: { organizationId, useCatalogDefaultPrices: enabled, enabledById: enabled ? actorId : null, enabledAt: enabled ? new Date() : null }, update: { useCatalogDefaultPrices: enabled, enabledById: enabled ? actorId : null, enabledAt: enabled ? new Date() : null } });
  let saleApplied = 0, purchaseApplied = 0;
  if (enabled) {
    const packs = await delegate(db, 'packLevel').findMany({ where: { organizationId, OR: [{ sellingPriceMinor: null, catalogDefaultSalePriceMinor: { not: null } }, { purchasePriceMinor: null, catalogDefaultPurchasePriceMinor: { not: null } }] }, select: { id: true, sellingPriceMinor: true, purchasePriceMinor: true, catalogDefaultSalePriceMinor: true, catalogDefaultPurchasePriceMinor: true } });
    for (const pack of packs) {
      const data: Record<string, number> = {};
      if (pack.sellingPriceMinor == null && pack.catalogDefaultSalePriceMinor != null) { data.sellingPriceMinor = pack.catalogDefaultSalePriceMinor; saleApplied++; }
      if (pack.purchasePriceMinor == null && pack.catalogDefaultPurchasePriceMinor != null) { data.purchasePriceMinor = pack.catalogDefaultPurchasePriceMinor; purchaseApplied++; }
      await delegate(db, 'packLevel').updateMany({ where: { organizationId, id: pack.id }, data });
    }
  }
  await delegate(db, 'auditLog').create({ data: { organizationId, actorId, source: 'TRPC', category: 'PHARMACY', operation: 'UPDATE', action: 'pharmacyCatalog.setDefaultPrices', targetType: 'PharmacyCatalogSetting', targetId: organizationId, result: { enabled, saleApplied, purchaseApplied } } });
  return { enabled, saleApplied, purchaseApplied };
}
