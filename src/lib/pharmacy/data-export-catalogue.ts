import 'server-only';

import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { decodeSpreadsheetText, PHARMACY_EXPORT_FILES } from './data-export-format';
import { normalizeMedicineText } from './medicine';
import { isDevfathomCatalogueTable } from './migration/devfathom-catalogue-profiler';
import { parseDelimitedText } from './migration/source-values';
import { MANUAL_FILE_RIGHTS } from './reference-connectors';

const text = z.string().max(1_000);
const flag = z.enum(['true', 'false']).transform((value) => value === 'true');
const barcodeSchema = z
  .object({
    code: text.min(1),
    type: z.enum(['GTIN', 'MANUFACTURER', 'INTERNAL']),
    normalized_code: text.min(1),
  })
  .strict();
const strengthSchema = z
  .object({
    ingredient: text.min(1),
    value: z.string().regex(/^-?\d{1,12}(?:\.\d{1,6})?$/),
    unit: text.min(1),
  })
  .strict();
function jsonArray<T extends z.ZodType>(item: T) {
  return z.preprocess((value) => {
    if (value === '') return [];
    if (typeof value !== 'string') return undefined;
    try {
      return JSON.parse(value) as unknown;
    } catch {
      return undefined;
    }
  }, z.array(item));
}
const rowSchema = z
  .object({
    code: text.min(1),
    medicine_code: text.min(1),
    presentation_code: text,
    product: text.min(1),
    brand_name: text,
    manufacturer: text,
    drap_registration_no: text,
    product_family: z.enum(['PHARMACEUTICAL', 'BIOLOGICAL', 'DEVICE', 'ALTERNATIVE', 'FRONT_SHOP']),
    rx: flag,
    otc: flag,
    restricted: flag,
    controlled: flag,
    high_alert: flag,
    lasa: flag,
    cold_chain: flag,
    saleable: flag,
    presentation: text,
    dosage_form: text,
    route: text,
    pack: z.union([
      z.literal('').transform(() => null),
      z
        .string()
        .regex(/^[1-9]\d*$/)
        .transform(Number)
        .pipe(z.number().int().max(2_147_483_647)),
    ]),
    pack_level: text,
    barcode: text,
    strength_components: jsonArray(strengthSchema),
    pack_barcodes: jsonArray(barcodeSchema),
    presentation_barcodes: jsonArray(barcodeSchema),
    catalogue_encoding: z.enum(['', 'apostrophe-v1']),
  })
  .strict();

type CatalogueImportOptions = {
  /** Only the local database-operator command uses this; never supplied by HTTP input. */
  source?: 'local-file';
};

export class PharmacyCatalogueImportError extends Error {
  constructor() {
    super('Supply an unmodified medicines.csv export with valid, consistent catalogue rows.');
  }
}

/** Catalogue identity is independent of received stock: no batch, expiry or MRP is invented. */
export function parsePharmacyExportCatalogue(csv: string, options: CatalogueImportOptions = {}) {
  const localFile = options.source === 'local-file';
  if (!localFile && Buffer.byteLength(csv, 'utf8') > 5_000_000)
    throw new PharmacyCatalogueImportError();
  const table = parseDelimitedText(csv, { trimCells: false });
  const headers = PHARMACY_EXPORT_FILES.medicines.columns.map((column) => column.header);
  if (!isDevfathomCatalogueTable(table) || (!localFile && table.rows.length > 10_000)) {
    throw new PharmacyCatalogueImportError();
  }
  const result = z.array(rowSchema).safeParse(
    table.rows.map((cells) => {
      const encoded = cells[table.headers.indexOf('catalogue_encoding')] === 'apostrophe-v1';
      return Object.fromEntries(
        headers.map((header) => {
          const index = table.headers.indexOf(header);
          const value = index < 0 ? '' : (cells[index] ?? '');
          return [header, encoded ? decodeSpreadsheetText(value) : value];
        })
      );
    })
  );
  if (!result.success) throw new PharmacyCatalogueImportError();
  const seen = new Set<string>();
  const identities = new Map<string, string>();
  for (const row of result.data) {
    if (
      seen.has(row.code) ||
      (!row.presentation_code &&
        (row.presentation ||
          row.pack !== null ||
          row.barcode ||
          row.presentation_barcodes.length)) ||
      (row.presentation_code && !row.presentation) ||
      (row.pack !== null && !row.pack_level) ||
      ((row.barcode || row.pack_barcodes.length) && row.pack === null) ||
      (row.pack_barcodes.length && row.pack_barcodes[0]!.code !== row.barcode)
    ) {
      throw new PharmacyCatalogueImportError();
    }
    seen.add(row.code);
    for (const [key, value] of [
      [
        `medicine:${row.medicine_code}`,
        JSON.stringify([medicineData(row), row.strength_components]),
      ],
      [
        `presentation:${row.presentation_code}`,
        JSON.stringify([
          row.medicine_code,
          row.presentation,
          row.dosage_form,
          row.route,
          row.presentation_barcodes,
        ]),
      ],
    ] as const) {
      if (key === 'presentation:') continue;
      if (identities.has(key) && identities.get(key) !== value)
        throw new PharmacyCatalogueImportError();
      identities.set(key, value);
    }
  }
  return result.data;
}

function medicineData(row: z.infer<typeof rowSchema>) {
  return {
    productName: row.product,
    productFamily: row.product_family,
    brandName: row.brand_name || null,
    manufacturer: row.manufacturer || null,
    drapRegistrationNumber: row.drap_registration_no || null,
    rx: row.rx,
    otc: row.otc,
    restricted: row.restricted,
    controlled: row.controlled,
    highAlert: row.high_alert,
    lasa: row.lasa,
    coldChain: row.cold_chain,
    // Exported saleability cannot substitute for the receiving tenant's review.
    saleable: false,
  };
}

/**
 * Import medicines.csv into new, non-saleable catalogue drafts atomically.
 * Source identifiers only group rows; they never reference another tenant's IDs.
 * Packs retain their exported canonical conversion as independent levels.
 */
export async function importPharmacyExportCatalogue(
  db: ScopedDb,
  organizationId: string,
  csv: string,
  now: Date = new Date(),
  options: CatalogueImportOptions = {}
) {
  const rows = parsePharmacyExportCatalogue(csv, options);
  const digest = createHash('sha256').update(csv).digest('hex');
  return db.$transaction(async (tx) => {
    const medicines = new Map<string, string>();
    const presentations = new Map<string, string>();
    let packs = 0;
    for (const row of rows) {
      let medicineId = medicines.get(row.medicine_code);
      if (!medicineId) {
        const medicine = await tx.medicine.create({
          data: {
            organizationId,
            ...medicineData(row),
            provenance: {
              create: {
                organizationId,
                field: 'productName',
                source: `medicines.csv sha256:${digest}`,
                sourceType: 'IMPORT',
                status: 'UNREVIEWED',
                retrievedAt: now,
                assertedValue: {
                  value: row.product,
                  connectorId: 'owner-data-export',
                  sourceLabel: 'Owner catalogue import',
                  batchId: digest,
                  rowSourceKey: row.medicine_code,
                  rights: { ...MANUAL_FILE_RIGHTS },
                  blockingIssues: [],
                },
              },
            },
          },
        });
        medicineId = medicine.id;
        medicines.set(row.medicine_code, medicineId);
        for (const component of row.strength_components) {
          const ingredient = await tx.ingredient.upsert({
            where: { organizationId_name: { organizationId, name: component.ingredient } },
            update: {},
            create: { organizationId, name: component.ingredient },
          });
          await tx.medicineStrengthComponent.create({
            data: {
              organizationId,
              medicineId,
              ingredientId: ingredient.id,
              value: component.value,
              unit: component.unit,
            },
          });
        }
      }
      if (!row.presentation_code) continue;
      let presentationId = presentations.get(row.presentation_code);
      if (!presentationId) {
        const presentation = await tx.presentation.create({
          data: {
            organizationId,
            medicineId,
            presentation: row.presentation,
            dosageForm: row.dosage_form || null,
            route: row.route || null,
          },
        });
        presentationId = presentation.id;
        presentations.set(row.presentation_code, presentationId);
        for (const barcode of row.presentation_barcodes) {
          await tx.medicineBarcode.create({
            data: {
              organizationId,
              presentationId,
              packLevelId: null,
              type: barcode.type,
              code: barcode.code,
              normalizedCode: barcode.normalized_code,
            },
          });
        }
      }
      if (row.pack === null) continue;
      const pack = await tx.packLevel.create({
        data: {
          organizationId,
          presentationId,
          versionGroupId: randomUUID(),
          version: 1,
          level: row.pack_level,
          unitsPerParent: row.pack,
          effectiveFrom: now,
        },
      });
      packs += 1;
      const barcodes = row.pack_barcodes.length
        ? row.pack_barcodes
        : row.barcode
          ? [
              {
                type: 'INTERNAL' as const,
                code: row.barcode,
                normalized_code: normalizeMedicineText(row.barcode),
              },
            ]
          : [];
      for (const barcode of barcodes) {
        await tx.medicineBarcode.create({
          data: {
            organizationId,
            presentationId,
            packLevelId: pack.id,
            type: barcode.type,
            code: barcode.code,
            normalizedCode: barcode.normalized_code,
          },
        });
      }
    }
    return {
      rows: rows.length,
      medicines: medicines.size,
      presentations: presentations.size,
      packs,
    };
  });
}
