/**
 * Rebuild the committed platform default medicine catalogue seed from the two
 * source exports. Offline only: reads two CSV files, writes one gzipped CSV,
 * touches no database.
 *
 *   tsx --tsconfig scripts/tsconfig.json scripts/pharmacy/build-default-catalogue-seed.ts \
 *     --reference <reference-import.csv> --pos <pos-export.csv> \
 *     [--out prisma/seed-data/pharmacy-default-catalogue/v1.csv.gz]
 *
 * The output is deterministic: identical inputs give a byte-identical CSV (and
 * so the same digest the loader keys a catalogue version on). Prices, QTY and
 * StockValue in the POS export are never read into the output.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';

import {
  buildSeedRows,
  parseCsv,
  serializeSeedCsv,
} from '../../src/lib/pharmacy/default-catalogue-seed';

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

const referencePath = argument('--reference');
const posPath = argument('--pos');
const outPath = argument('--out') ?? 'prisma/seed-data/pharmacy-default-catalogue/v1.csv.gz';
if (!referencePath || !posPath) {
  console.error('Usage: --reference <reference-import.csv> --pos <pos-export.csv> [--out <file>]');
  process.exit(2);
}

const rows = buildSeedRows(
  parseCsv(readFileSync(referencePath, 'utf8')),
  parseCsv(readFileSync(posPath, 'utf8'))
);
const csv = serializeSeedCsv(rows);
const body = Buffer.from(csv, 'utf8');
writeFileSync(outPath, outPath.endsWith('.gz') ? gzipSync(body, { level: 9 }) : body);

const families: Record<string, number> = {};
for (const row of rows) families[row.productFamily] = (families[row.productFamily] ?? 0) + 1;
console.log(
  JSON.stringify(
    {
      out: outPath,
      rows: rows.length,
      sha256: createHash('sha256').update(body).digest('hex'),
      controlledCandidates: rows.filter((row) => row.controlledCandidate).length,
      families,
    },
    null,
    2
  )
);
