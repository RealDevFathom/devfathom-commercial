import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { db } from '@/lib/db';
import { importPharmacyExportCatalogue, PharmacyCatalogueImportError } from '@/lib/pharmacy/data-export-catalogue';
import { withTenantDb } from '@/lib/tenancy/scoped-db';
import { recordAudit } from '@/server/audit';

/** Database-operator path for complete owner exports that exceed HTTP import limits. */
async function main() {
  const { values } = parseArgs({ options: {
    organization: { type: 'string' }, file: { type: 'string' },
  } });
  const organizationId = values.organization;
  if (!organizationId || !values.file) {
    throw new Error('Usage: import-pharmacy-catalogue.ts --organization <target-id> --file <medicines.csv>');
  }
  const csv = await readFile(values.file, 'utf8');
  const result = await withTenantDb(organizationId, async (tx) => {
    const organization = await tx.organization.findUnique({
      where: { id: organizationId }, select: { vertical: true },
    });
    if (organization?.vertical !== 'PHARMACY') throw new Error('Target must be a pharmacy workspace.');
    const imported = await importPharmacyExportCatalogue(tx, organizationId, csv, new Date(), {
      source: 'local-file',
    });
    await recordAudit({
      organizationId, actorType: 'SYSTEM', source: 'SYSTEM', category: 'pharmacy',
      operation: 'CREATE', action: 'pharmacy.dataExport.catalogueImported',
      description: 'Database operator imported catalogue drafts from a local medicines.csv.',
      targetType: 'Medicine', metadata: imported,
    }, tx);
    return imported;
  }, { timeout: 30 * 60_000 });
  console.log(JSON.stringify(result));
}

void main().catch((error: unknown) => {
  // Database errors can contain catalogue values; keep CLI output free of row data.
  console.error(error instanceof PharmacyCatalogueImportError
    ? error.message
    : 'Catalogue import failed. Check --organization, --file and DATABASE_URL.');
  process.exitCode = 1;
}).finally(() => db.$disconnect());
