// Inputs are approved catalogue-only JSON projections. Run from the repository root.
// bun scripts/qa/build-pharmacy-starter.ts approved-abuzar.json approved-v4.json
import { randomUUID } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import {
  buildStarterCatalogue,
  validateStarterCatalogue,
} from '../../src/lib/pharmacy/migration/starter-reference';
import { isLegacyControlledClass } from '../../src/lib/pharmacy/migration/legacy-class';

const [abuzar, v4] = process.argv.slice(2);
if (!abuzar || !v4 || process.argv.length !== 4)
  throw new Error('Supply the two approved catalogue-only JSON projections.');
const source: unknown = JSON.parse(await readFile(abuzar, 'utf8'));
const verified: unknown = JSON.parse(await readFile(v4, 'utf8'));
const { rows, reconciliation } = buildStarterCatalogue(source, verified);
const counts = {
  products: rows.length,
  active: rows.filter((r) => r.active).length,
  inactive: rows.filter((r) => !r.active).length,
  narcotics: rows.filter((r) => isLegacyControlledClass(r.class)).length,
  controlled: rows.filter((r) => r.controlled).length,
};
console.log(JSON.stringify({ counts, reconciliation }));
if (
  counts.products !== 26054 ||
  counts.active !== 18170 ||
  counts.inactive !== 7884 ||
  counts.narcotics !== 1476
)
  throw new Error('Catalogue counts differ from the approved Abuzar inspection.');
if (
  reconciliation.matched !== 18068 ||
  reconciliation.differentName !== 42 ||
  reconciliation.absentCode !== 821
)
  throw new Error(
    'V4 reconciliation differs from the reviewed groups. Resolve the source discrepancy before publishing.'
  );

const target = 'src/lib/pharmacy/migration/starter-products.json';
const temporary = target + '.' + randomUUID() + '.tmp';
try {
  await writeFile(temporary, JSON.stringify(rows, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  // Check the exact serialized asset before replacing the packaged reference.
  validateStarterCatalogue(JSON.parse(await readFile(temporary, 'utf8')));
  await rename(temporary, target);
} finally {
  await rm(temporary, { force: true });
}
