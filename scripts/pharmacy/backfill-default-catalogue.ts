/**
 * Apply the platform default medicine catalogue to pharmacies that already
 * exist (new pharmacies get it from their provisioning job).
 *
 *   tsx --tsconfig scripts/tsconfig.json scripts/pharmacy/backfill-default-catalogue.ts \
 *     [--dry-run | --apply --actor <operator email>] [--org <organizationId>] [--version <n>]
 *     [--key pharmacy-default]
 *
 * DRY RUN BY DEFAULT. Without --apply it only reads, and prints what each
 * pharmacy holds and is missing. With --apply each pharmacy is materialised in
 * batches of 1,000 inside its own RLS scope: medicines with zero stock, never
 * a batch or price, never overwriting a medicine the pharmacy already holds.
 * A catalogue item that is a likely duplicate of a medicine the pharmacy
 * entered by hand (manual entry, the importer wizard, a reference connector) —
 * same normalised brand/product name, strength and dosage form, and
 * manufacturer when both have one — is never copied: the dry run lists each
 * pair (`likelyDuplicates`: sourceKey, medicine id and name, reason,
 * NARCOTICS flag, sale hold), and --apply links the existing medicine through
 * a provenance row without writing any of its fields — except that a link to
 * a NARCOTICS item holds a saleable, not-yet-reviewed medicine from sale until
 * a pharmacist publishes a reviewed controlled decision. Every applied batch writes a tenant audit row
 * naming --actor. Idempotent — running it twice creates and links nothing the
 * second time. Exits
 * non-zero if any organization failed; the others still complete.
 */
import 'dotenv/config';

import { backfillDefaultCatalogue, DEFAULT_CATALOGUE_KEY } from '@/lib/pharmacy/default-catalogue';

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function main() {
  const apply = process.argv.includes('--apply');
  if (apply && process.argv.includes('--dry-run')) {
    throw new Error('Choose one of --dry-run or --apply.');
  }
  const actor = argument('--actor')?.trim();
  if (apply && (!actor || actor.startsWith('--'))) {
    throw new Error('--apply requires --actor <operator email> for the tenant audit trail.');
  }
  const versionArgument = argument('--version');
  const version = versionArgument === undefined ? undefined : Number(versionArgument);
  if (version !== undefined && (!Number.isInteger(version) || version < 1)) {
    throw new Error('--version must be a positive integer.');
  }
  const report = await backfillDefaultCatalogue({
    apply,
    organizationId: argument('--org'),
    catalogueKey: argument('--key') ?? DEFAULT_CATALOGUE_KEY,
    version,
    actor,
  });
  console.log(JSON.stringify(report, null, 2));
  if (!apply) console.log('Dry run: nothing was written. Re-run with --apply to materialise.');
  if (report.organizations.some((organization) => organization.error)) process.exitCode = 1;
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
