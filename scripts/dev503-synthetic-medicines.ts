/**
 * DEV-503 measurement fixture: about 19,000 synthetic medicines in the seeded
 * pharmacy E2E workspace (run scripts/seed-pharmacy-e2e.ts first).
 *
 *   1. 19,000 catalogue `medicine` rows ("Synthmed 00001 …").
 *   2. One 19,000-row staged migration batch, profiled and persisted through the
 *      same recordSource → profileTable → persistProfile path an upload takes.
 *
 * Every name, code and price is generated: no real customer or product data.
 * Refuses any database the pharmacy E2E guard would refuse (disposable name,
 * isolated port, never staging or production). Idempotent: a re-run adds nothing.
 *
 *   PHARMACY_E2E=1 PHARMACY_E2E_DATABASE_URL=… DATABASE_URL=<same> \
 *   PHARMACY_E2E_ADMIN_EMAIL=… PHARMACY_E2E_ADMIN_PASSWORD=… \
 *   bunx tsx --conditions=react-server scripts/dev503-synthetic-medicines.ts
 */
import 'dotenv/config';

import { excelCsvProfiler } from '../src/lib/pharmacy/migration/excel-csv-profiler';
import { profileTable } from '../src/lib/pharmacy/migration/profiler';
import { persistProfile, recordSource } from '../src/lib/pharmacy/migration/workbench';
import { withTenantDb } from '../src/lib/tenancy/scoped-db';
import { PHARMACY_E2E } from '../tests/e2e/pharmacy-counter-fixture';
import { pharmacyE2eEnvironment } from './pharmacy-e2e-environment';

// Throws unless DATABASE_URL is the guarded, disposable pharmacy E2E database.
pharmacyE2eEnvironment();

const ORG = PHARMACY_E2E.organizationId;
const COUNT = 19_000;
const FILE_NAME = 'synthetic-dev503-19000.csv';
const forms = ['Tablet', 'Capsule', 'Syrup', 'Injection', 'Cream', 'Drops'];
const strengths = ['5 mg', '10 mg', '250 mg', '500 mg', '1 g', '120 mg/5 ml'];
const code = (i: number) => String(i).padStart(5, '0');
const productName = (i: number) => `Synthmed ${code(i)} ${strengths[i % 6]} ${forms[i % 6]}`;

async function seedCatalogue() {
  for (let start = 0; start < COUNT; start += 1000) {
    await withTenantDb(ORG, (tx) =>
      tx.medicine.createMany({
        skipDuplicates: true,
        data: Array.from({ length: Math.min(1000, COUNT - start) }, (_, k) => {
          const i = start + k + 1;
          return {
            id: `medicine_dev503_synth_${code(i)}`,
            organizationId: ORG,
            productName: productName(i),
            brandName: `Synthmed ${code(i)}`,
            manufacturer: `Synthetic Labs ${i % 40}`,
            productFamily: 'PHARMACEUTICAL' as const,
            rx: i % 3 === 0,
            otc: i % 3 !== 0,
            saleable: true,
          };
        }),
      })
    );
  }
}

/** Headers every profiler version since the staged review shipped recognises. */
const HEADERS = ['code', 'product', 'pack', 'batch', 'expiry', 'mrp', 'cost', 'qty', 'aliasname'];

function stagedTable() {
  const rows = Array.from({ length: COUNT }, (_, k) => {
    const i = k + 1;
    return [
      `SM${code(i)}`,
      productName(i),
      `${(i % 5) + 1}x10`,
      i % 17 === 0 ? '' : `B${code(i)}`, // ~6% missing batch
      i % 23 === 0 ? '' : `2028-${String((i % 12) + 1).padStart(2, '0')}-28`, // ~4% missing expiry
      i % 29 === 0 ? '' : String(50 + (i % 900)), // ~3% missing MRP
      String(40 + (i % 800)),
      String(i % 250),
      `AL${i % 9000}`,
    ];
  });
  return { headers: HEADERS, rows, csv: [HEADERS, ...rows].map((r) => r.join(',')).join('\n') };
}

async function seedStagedBatch() {
  const { headers, rows, csv } = stagedTable();
  const result = profileTable(excelCsvProfiler, { headers, rows }, { quantityUnit: 'PACKS' });
  for (const row of result.rows) row.sourceKey = `synthetic:row:${row.rowNumber}`;
  return withTenantDb(
    ORG,
    async (tx) => {
      const source = await recordSource(tx, { kind: 'EXCEL_CSV', fileName: FILE_NAME, bytes: csv });
      const existing = await tx.pharmacyMigrationBatch.count({
        where: { organizationId: ORG, sourceId: source.id },
      });
      if (existing > 0) return { sourceId: source.id, replayed: true };
      const saved = await persistProfile(tx, {
        sourceId: source.id,
        label: FILE_NAME,
        profiler: excelCsvProfiler,
        result,
      });
      return { sourceId: source.id, batchId: saved.batchId, rowCount: saved.rowCount };
    },
    { timeout: 600_000, maxWait: 10_000, skipDrain: true }
  );
}

async function main() {
  await seedCatalogue();
  const staged = await seedStagedBatch();
  console.log('DEV-503 synthetic medicines ready:', JSON.stringify(staged));
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    console.error(error);
    process.exit(1);
  }
);
