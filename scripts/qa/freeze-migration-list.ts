// Run ONCE, at the moment the DEV-813 migration-rules pull request lands, on the merged
// tree:  bun scripts/qa/freeze-migration-list.ts
// It regenerates the frozen legacy list from prisma/migrations and empties the ledger.
// It refuses to run once the ledger holds entries, so it cannot be used later to hide a
// back-dated migration. Never run it again after that.
import { readdirSync, writeFileSync } from 'node:fs';

import { LEDGER_FILE, LEGACY_FILE, readList } from './migration-rules';

if (readList(LEDGER_FILE).length > 0) {
  console.error(`${LEDGER_FILE} already has entries: the list was frozen already. Refusing.`);
  process.exit(1);
}

const names = readdirSync('prisma/migrations', { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .sort();
writeFileSync(LEGACY_FILE, names.join('\n') + '\n');
writeFileSync(
  LEDGER_FILE,
  [
    '# Append-only ledger of migrations added after the legacy cutoff, oldest first.',
    "# Append each new migration's directory name at the END of this list. Never insert,",
    '# reorder, rename or remove an entry. One name per line; lines starting with # are comments.',
    '',
  ].join('\n')
);
console.log(`Froze ${names.length} migrations and emptied the ledger.`);
