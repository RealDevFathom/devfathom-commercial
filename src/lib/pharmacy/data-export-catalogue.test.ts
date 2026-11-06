// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import {
  importPharmacyExportCatalogue,
  parsePharmacyExportCatalogue,
} from './data-export-catalogue';
import { exportRowsToCsv, PHARMACY_EXPORT_FILES, type ExportRow } from './data-export-format';

function row(overrides: ExportRow = {}): ExportRow {
  return {
    code: 'pack-1',
    medicine_code: 'medicine-1',
    presentation_code: 'presentation-1',
    product: '+Example',
    brand_name: "'+Example",
    manufacturer: "'Manufacturer",
    drap_registration_no: '',
    product_family: 'PHARMACEUTICAL',
    rx: true,
    otc: false,
    restricted: false,
    controlled: false,
    high_alert: false,
    lasa: false,
    cold_chain: false,
    saleable: true,
    presentation: 'Tablet',
    dosage_form: '',
    route: '',
    pack: 10,
    pack_level: 'STRIP',
    barcode: '+barcode',
    ...overrides,
  };
}

const csv = (rows: readonly ExportRow[]) => exportRowsToCsv(PHARMACY_EXPORT_FILES.medicines, rows);

describe('owner catalogue identity round trip', () => {
  it.each([
    '+Example',
    '=SUM(A1)',
    '-Example',
    '@Example',
    '\tExample',
    '\rExample',
    "'+Example",
    "''+Example",
    "'Example",
    '  +Example  ',
    ' plain text ',
    '-125.50',
    'Urdu اردو, "quoted"\nline',
  ])('restores formula-protected and literal text exactly: %j', (value) => {
    const [restored] = parsePharmacyExportCatalogue(
      csv([
        row({
          product: value,
          brand_name: value,
          barcode: value,
        }),
      ])
    );
    expect(restored).toMatchObject({ product: value, brand_name: value, barcode: value });
  });

  it('still accepts the original catalogue headers', () => {
    const legacy = {
      ...PHARMACY_EXPORT_FILES.medicines,
      columns: PHARMACY_EXPORT_FILES.medicines.columns.slice(0, -4),
    };
    expect(
      parsePharmacyExportCatalogue(
        exportRowsToCsv(legacy, [row({ product: 'Plain', barcode: '123' })])
      )
    ).toEqual([
      expect.objectContaining({ product: 'Plain', barcode: '123', strength_components: [] }),
    ]);
  });

  it('imports all strengths and pack/presentation barcodes once into fresh draft identities', async () => {
    const packBarcodes = [
      { code: '+barcode', type: 'GTIN', normalized_code: 'barcode' },
      { code: "'+second", type: 'MANUFACTURER', normalized_code: 'second' },
    ];
    const presentationBarcodes = [
      { code: '@presentation', type: 'INTERNAL', normalized_code: 'presentation' },
    ];
    const strengths = [
      { ingredient: "'Ingredient", value: '500.000001', unit: 'mg' },
      { ingredient: 'Other ingredient', value: '0.5', unit: 'mg' },
    ];
    const shared = {
      strength_components: JSON.stringify(strengths),
      presentation_barcodes: JSON.stringify(presentationBarcodes),
    };
    const source = csv([
      row({ ...shared, pack_barcodes: JSON.stringify(packBarcodes) }),
      row({ ...shared, code: 'pack-2', pack: 100, pack_level: 'BOX', barcode: '' }),
    ]);
    let nextPack = 0;
    const tx = {
      medicine: { create: vi.fn(async () => ({ id: 'target-medicine' })) },
      presentation: { create: vi.fn(async () => ({ id: 'target-presentation' })) },
      packLevel: { create: vi.fn(async () => ({ id: `target-pack-${++nextPack}` })) },
      ingredient: { upsert: vi.fn(async () => ({ id: 'target-ingredient' })) },
      medicineStrengthComponent: { create: vi.fn(async () => ({})) },
      medicineBarcode: { create: vi.fn(async () => ({})) },
    };
    const db = { $transaction: async (run: (inner: typeof tx) => Promise<unknown>) => run(tx) };
    await expect(
      importPharmacyExportCatalogue(db as unknown as ScopedDb, 'target-org', source)
    ).resolves.toEqual({ rows: 2, medicines: 1, presentations: 1, packs: 2 });
    expect(tx.medicine.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        organizationId: 'target-org',
        productName: '+Example',
        brandName: "'+Example",
        saleable: false,
      }),
    });
    expect(tx.ingredient.upsert).toHaveBeenCalledTimes(2);
    expect(tx.medicineStrengthComponent.create).toHaveBeenCalledWith({
      data: {
        organizationId: 'target-org',
        medicineId: 'target-medicine',
        ingredientId: 'target-ingredient',
        value: '500.000001',
        unit: 'mg',
      },
    });
    expect(tx.medicineBarcode.create).toHaveBeenCalledTimes(3);
    for (const barcode of packBarcodes) {
      expect(tx.medicineBarcode.create).toHaveBeenCalledWith({
        data: {
          organizationId: 'target-org',
          presentationId: 'target-presentation',
          packLevelId: 'target-pack-1',
          code: barcode.code,
          type: barcode.type,
          normalizedCode: barcode.normalized_code,
        },
      });
    }
    expect(tx.medicineBarcode.create).toHaveBeenCalledWith({
      data: {
        organizationId: 'target-org',
        presentationId: 'target-presentation',
        packLevelId: null,
        code: '@presentation',
        type: 'INTERNAL',
        normalizedCode: 'presentation',
      },
    });
  });

  it('rejects inconsistent strengths or presentation barcode lists before writing', () => {
    for (const field of ['strength_components', 'presentation_barcodes']) {
      const value =
        field === 'strength_components'
          ? [{ ingredient: 'Ingredient', value: '1', unit: 'mg' }]
          : [{ code: '123', type: 'GTIN', normalized_code: '123' }];
      expect(() =>
        parsePharmacyExportCatalogue(
          csv([row(), row({ code: 'pack-2', [field]: JSON.stringify(value) })])
        )
      ).toThrow('valid, consistent catalogue rows');
    }
  });
});

describe('complete local-file catalogue import', () => {
  it('supports 5,001 medicines with two packs each, retaining HTTP row limits', async () => {
    const rows = Array.from({ length: 5_001 }, (_, index) => [
      row({
        medicine_code: `med-${index}`,
        presentation_code: `pr-${index}`,
        code: `pack-${index}-a`,
        barcode: '',
      }),
      row({
        medicine_code: `med-${index}`,
        presentation_code: `pr-${index}`,
        code: `pack-${index}-b`,
        pack: 100,
        barcode: '',
      }),
    ]).flat();
    const source = csv(rows);
    expect(() => parsePharmacyExportCatalogue(source)).toThrow('valid, consistent catalogue rows');
    const restored = parsePharmacyExportCatalogue(source, { source: 'local-file' });
    expect(restored).toHaveLength(10_002);
    expect(new Set(restored.map((item) => item.medicine_code)).size).toBe(5_001);
    expect(restored.at(-1)).toMatchObject({ code: 'pack-5000-b', pack: 100 });
    let medicineId = 0;
    let presentationId = 0;
    let packId = 0;
    const tx = {
      medicine: { create: vi.fn(async () => ({ id: `target-med-${++medicineId}` })) },
      presentation: { create: vi.fn(async () => ({ id: `target-pr-${++presentationId}` })) },
      packLevel: { create: vi.fn(async () => ({ id: `target-pack-${++packId}` })) },
    };
    const db = { $transaction: async (run: (inner: typeof tx) => Promise<unknown>) => run(tx) };
    await expect(
      importPharmacyExportCatalogue(db as unknown as ScopedDb, 'target-org', source, new Date(), {
        source: 'local-file',
      })
    ).resolves.toEqual({ rows: 10_002, medicines: 5_001, presentations: 5_001, packs: 10_002 });
  }, 30_000);

  it('supports complete files larger than 5 MB, retaining HTTP byte limits', () => {
    const source = csv(
      Array.from({ length: 5_000 }, (_, index) =>
        row({
          medicine_code: `med-${index}`,
          presentation_code: `pr-${index}`,
          code: `pack-${index}`,
          product: 'ا'.repeat(600),
          barcode: '',
        })
      )
    );
    expect(Buffer.byteLength(source, 'utf8')).toBeGreaterThan(5_000_000);
    expect(() => parsePharmacyExportCatalogue(source)).toThrow('valid, consistent catalogue rows');
    expect(parsePharmacyExportCatalogue(source, { source: 'local-file' })).toHaveLength(5_000);
  }, 30_000);
});
