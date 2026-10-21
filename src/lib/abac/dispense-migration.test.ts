import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(
  join(
    process.cwd(),
    'prisma/migrations/20261021200000_canonical_legacy_pharmacy_dispense/migration.sql'
  ),
  'utf8'
);

describe('legacy pharmacy dispense migration', () => {
  it('maps only the exact dotted capability and is replay-safe', () => {
    expect(sql).toContain("WHERE p.capability = 'pharmacy.dispense'");
    expect(sql).not.toMatch(/p\.capability\s+IN\s*\([^)]*['"](?:\*|pharmacy:\*)['"]/);
    expect(sql.match(/ON CONFLICT/g)).toHaveLength(2);
  });
});
