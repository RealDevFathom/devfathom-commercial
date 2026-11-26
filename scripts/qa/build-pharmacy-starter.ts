// Inputs are approved catalogue-only JSON projections. Run from the repository root.
// bun scripts/qa/build-pharmacy-starter.ts approved-abuzar.json approved-v4.json
// Raw V4 Legacy Code must match a nonblank Abuzar CustomICode plus normalized name;
// the approved overlays are already resolved to internal ICode/sourceId, not blindly source_id.
// This reviewed V4 release verifies only generic_name. Explicitly approved pack/manufacturer
// overlays remain supported, with provenance recorded for each supplied nonnull field.
import { randomUUID } from 'node:crypto';
import { open, readFile, rename, rm } from 'node:fs/promises';
import {
  buildStarterCatalogue,
  parseStarterCsv,
  serializeStarterCsv,
  validateStarterRelease,
} from '../../src/lib/pharmacy/migration/starter-reference';

const inputFailure = 'Supply the two approved catalogue-only JSON projections.';
const countFailure = 'Catalogue counts differ from the approved Abuzar inspection.';
const reconciliationFailure =
  'V4 reconciliation differs from the reviewed groups. Resolve the source discrepancy before publishing.';

async function build() {
  const [abuzar, v4] = process.argv.slice(2);
  if (!abuzar || !v4 || process.argv.length !== 4) throw new Error(inputFailure);
  const source: unknown = JSON.parse(await readFile(abuzar, 'utf8'));
  const verified: unknown = JSON.parse(await readFile(v4, 'utf8'));
  const { rows, reconciliation } = buildStarterCatalogue(source, verified);
  const counts = validateStarterRelease(rows);
  if (
    reconciliation.matched !== 18068 ||
    reconciliation.differentName !== 42 ||
    reconciliation.absentCode !== 821
  )
    throw new Error(reconciliationFailure);

  const target = 'src/lib/pharmacy/migration/starter-products.csv';
  const temporary = target + '.' + randomUUID() + '.tmp';
  let owned = false;
  try {
    // Exclusive creation ensures cleanup can only remove this invocation's temporary file.
    const file = await open(temporary, 'wx', 0o600);
    owned = true;
    try {
      await file.writeFile(serializeStarterCsv(rows));
    } finally {
      await file.close();
    }
    // Reopen and validate the exact serialized asset before the atomic release replacement.
    const bytes = await readFile(temporary);
    validateStarterRelease(
      parseStarterCsv(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    );
    await rename(temporary, target);
    owned = false;
    console.log(JSON.stringify({ counts, reconciliation }));
  } finally {
    if (owned) await rm(temporary, { force: true });
  }
}

try {
  await build();
} catch (error) {
  // Parser/schema/filesystem errors can contain source values or paths; never print them.
  const safe = [inputFailure, countFailure, reconciliationFailure];
  console.error(
    error instanceof Error && safe.includes(error.message)
      ? error.message
      : 'Starter catalogue generation failed. Check the approved projections and output location.'
  );
  process.exitCode = 1;
}
