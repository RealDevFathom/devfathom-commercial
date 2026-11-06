/**
 * Load the platform default medicine catalogue seed into the shared platform
 * tables as one immutable version.
 *
 *   tsx --tsconfig scripts/tsconfig.json scripts/pharmacy/load-default-catalogue.ts \
 *     [--file prisma/seed-data/pharmacy-default-catalogue/v1.csv.gz] [--version 1] \
 *     [--key pharmacy-default]
 *
 * Streams nothing to tenants: it only writes `platform_medicine_catalogue_*`,
 * in batches of 1,000 rows, each batch its own transaction and idempotent on
 * (key, version, sourceKey). Re-running with the same file is a no-op; an
 * interrupted run resumes. Reusing a version number for different content is
 * refused. Applying the catalogue to pharmacies is a separate step (the
 * provisioning job, or scripts/pharmacy/backfill-default-catalogue.ts).
 */
import 'dotenv/config';

import { readFileSync } from 'node:fs';

import {
  DEFAULT_CATALOGUE_KEY,
  decodeSeedFile,
  loadDefaultCatalogue,
} from '@/lib/pharmacy/default-catalogue';

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function main() {
  const file = argument('--file') ?? 'prisma/seed-data/pharmacy-default-catalogue/v1.csv.gz';
  const version = Number.parseInt(argument('--version') ?? '1', 10);
  const key = argument('--key') ?? DEFAULT_CATALOGUE_KEY;
  const { text, digest } = decodeSeedFile(readFileSync(file));
  console.log(JSON.stringify({ file, key, version, digest }));
  const result = await loadDefaultCatalogue({ text, version, key });
  console.log(JSON.stringify(result, null, 2));
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
